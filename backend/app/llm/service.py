"""Level-3 estimates, LLM second opinion, council — each with schema validation, post-checks and templates."""
from __future__ import annotations

import json
import re

from pydantic import BaseModel, Field

from app.llm.client import chat_json
from app.twin.physics import ACTIONS, ALLOWED_ACTIONS, ASSETS, ASSET_IDS, FAULTS, MAINT_TICKS, TAGS


# ---------------------------------------------------------------- schemas
class Contribution(BaseModel):
    tag: str
    share_pct: float
    reason: str = ""


class AssetEstimate(BaseModel):
    risk: float = Field(ge=0, le=1)
    anomaly: float = Field(ge=0, le=1)
    time_to_failure_min: float = Field(ge=0)
    contributions: list[Contribution]
    diagnosis: str


class Estimates(BaseModel):
    assets: dict[str, AssetEstimate]


class Opinion(BaseModel):
    risk_level: str
    confidence: float = Field(ge=0, le=1)
    likely_cause: str


class Opinions(BaseModel):
    assets: dict[str, Opinion]


class Agent(BaseModel):
    role: str
    stance: str
    text: str


class Recommendation(BaseModel):
    action: str
    rationale: str


class WorkOrder(BaseModel):
    title: str
    steps: list[str]
    parts: list[str]
    est_downtime_min: float


class Council(BaseModel):
    summary: str
    agents: list[Agent]
    recommendation: Recommendation
    work_order: WorkOrder


SYSTEM = ("You are a reliability engineer for a hot-strip steel mill digital twin. Telemetry comes from a "
          "physics-based simulation. Reply with a single JSON object only, in English, using only the facts given.")


def risk_level(p: float) -> str:
    return "LOW" if p < .3 else "MEDIUM" if p < .6 else "HIGH" if p < .85 else "CRITICAL"


# ---------------------------------------------------------------- level 3 estimates
def estimate_facts(hist_rows: list[dict], exp: dict, frame: dict) -> dict:
    facts = {"op": {"throughput_pct": round(100 * frame["u"]), "grade": frame["grade_name"], "state": frame["state"]},
             "assets": {}}
    for a in ASSET_IDS:
        facts["assets"][a] = {"name": ASSETS[a]["name"], "tags": {}}
        for t in ASSETS[a]["tags"]:
            k = f"{a}.{t}"
            res = [None if r[k] != r[k] else round(r[k] - r["exp:" + k], 3) for r in hist_rows[-10:]]
            facts["assets"][a]["tags"][k] = {"unit": TAGS[k]["unit"], "expected": round(exp[k], 2),
                                             "residuals_last10": res}
    return facts


async def llm_estimates(facts: dict, engine: dict) -> tuple[dict, str]:
    user = ("Estimate failure risk for each asset from these twin residuals (reading minus healthy expectation).\n"
            f"FACTS: {json.dumps(facts)}\n"
            'Return {"assets": {"<asset id>": {"risk":0-1,"anomaly":0-1,"time_to_failure_min":0-120,'
            '"contributions":[{"tag":"<tag from facts>","share_pct":0-100,"reason":"short"}],"diagnosis":"one sentence"}}} '
            "for every asset id in FACTS. share_pct values per asset must sum to 100.")
    obj, model, _ = await chat_json(SYSTEM, user, Estimates, max_tokens=1600)
    out = {}
    for a in ASSET_IDS:
        e = obj.assets.get(a)
        tags = set(facts["assets"][a]["tags"])
        ok = e is not None and e.contributions and all(c.tag in tags for c in e.contributions) \
            and abs(sum(c.share_pct for c in e.contributions) - 100) <= 5
        if not ok:  # post-check failed: use Engine values for this asset
            out[a] = {"postcheck_failed": True}
            continue
        out[a] = {"p": e.risk, "anomaly": e.anomaly, "ttf": min(120.0, e.time_to_failure_min),
                  "ttf_lo": 0.75 * min(120.0, e.time_to_failure_min), "ttf_hi": min(120.0, 1.25 * e.time_to_failure_min),
                  "diagnosis": e.diagnosis,
                  "contributions": [{"tag": c.tag, "label": TAGS[c.tag]["label"], "share_pct": round(c.share_pct, 1),
                                     "reason": c.reason} for c in sorted(e.contributions, key=lambda c: -c.share_pct)]}
    return out, model


# ---------------------------------------------------------------- second opinion
async def llm_second_opinion(facts: dict, assets: list[str]) -> tuple[dict, str]:
    sub = {**facts, "assets": {a: facts["assets"][a] for a in assets}}
    user = (f"FACTS: {json.dumps(sub)}\nGive an independent second opinion for each asset in FACTS. Return "
            '{"assets": {"<id>": {"risk_level":"LOW|MEDIUM|HIGH|CRITICAL","confidence":0-1,"likely_cause":"short"}}}. '
            "An erratic single signal with all related signals normal suggests an instrument fault.")
    obj, model, _ = await chat_json(SYSTEM, user, Opinions, max_tokens=500)
    out = {a: o.model_dump() for a, o in obj.assets.items() if a in assets and o.risk_level.upper() in
           ("LOW", "MEDIUM", "HIGH", "CRITICAL")}
    for o in out.values():
        o["risk_level"] = o["risk_level"].upper()
    return out, model


# ---------------------------------------------------------------- diagnosis template (levels 1-2)
def diagnose(asset: str, r: dict, frame: dict) -> str:
    p, anomaly = r["p"], r["anomaly"]
    tags = [c.get("tag") for c in r["contributions"] if c.get("tag")]
    feats = [c.get("feature", "") for c in r["contributions"][:3]]
    glitchy = any(f.endswith("|std10") for f in feats[:1]) and p < 0.6
    if frame["assets"][asset]["failed"]:
        return f"{ASSETS[asset]['name']} has FAILED — line tripped. Unplanned repair needed."
    if p < 0.15 and anomaly < 0.5:
        return "Operating normally — readings track the twin's healthy expectation."
    if anomaly >= 0.6 and (p < 0.5 or glitchy):
        tag = tags[0] if tags else f"{asset}"
        lab = TAGS[tag]["label"] if tag in TAGS else tag
        return (f"Erratic {lab.lower()} that does not match any known failure signature; related signals look normal. "
                "Possible instrument fault — verify the sensor before acting.")
    f = FAULTS[asset]
    moves = []
    for t, d in f["sig"].items():
        key = f"{asset}.{t}"
        tv = frame["assets"][asset]["tags"][t]
        if d and tv["v"] is not None and tv["exp"] is not None:
            moves.append(f"{TAGS[key]['label'].lower()} {'↑' if tv['v'] > tv['exp'] else '↓'}")
    cascade = ""
    if asset == "R1" and any("slab_resid" in f or "SlabExitTemp" in (c.get("tag") or "") for f, c in
                             zip(feats, r["contributions"][:3])):
        cascade = " Upstream: colder slabs from F1 are adding roll force."
    return f"Signature matches {f['name'].lower()}: {', '.join(moves[:3])}. {f['story']}{cascade}"


# ---------------------------------------------------------------- council
def recommend(asset: str, r: dict, suspect_sensor: bool) -> str:
    if suspect_sensor:
        return "recalibrate_sensor"
    if r["p"] >= 0.9 and r["ttf"] < 10:
        return "emergency_stop"
    if asset == "R1" and r["ttf"] > 45:
        return "derate"
    return FAULTS[asset]["action"]


def council_template(f: dict) -> dict:
    a, act = f["asset"], f["recommended_action"]
    name = ASSETS[a]["name"]
    wi = f.get("whatif") or {}
    gain = ""
    if wi.get("baseline_fail_min") is not None:
        after = wi.get("action_fail_min")
        gain = (f" The twin projects failure in {wi['baseline_fail_min']} min if nothing is done"
                + (f", pushed to {after} min with this action." if after is not None else ", avoided within the 120-min horizon with this action."))
    fault = FAULTS[a]
    top = ", ".join(c["label"] for c in f["top_contributions"][:3])
    down = MAINT_TICKS if act == "planned_maintenance" else 3 if act == "switch_standby_pump" else 0
    steps = {
        "planned_maintenance": [f"Schedule a controlled stop of {name}", "Lock-out / tag-out the drive and isolate energy",
                                f"Inspect for {fault['name'].lower()}", "Replace or repair the affected component",
                                "Restart and verify readings return to twin expectation"],
        "switch_standby_pump": ["Start standby cooling pump B", "Ramp pump A down and isolate it",
                                "Confirm header flow and pressure recover", "Raise a work order to inspect pump A impeller"],
        "increase_lube": ["Raise gear-oil circulation to high flow", "Check oil filter differential pressure",
                          "Sample the oil for contamination", "Plan gearbox inspection at the next roll change"],
        "derate": ["Reduce line speed by 30 %", "Monitor bearing temperature and vibration each minute",
                   "Plan bearing change at the next roll change"],
        "recalibrate_sensor": ["Check the accelerometer cable and connector", "Swap to the redundant channel",
                               "Recalibrate and compare with portable vibration meter"],
        "emergency_stop": ["Trip the line now", "Make the area safe", f"Inspect {name} before restart"],
    }.get(act, ["Inspect the asset"])
    return {
        "summary": (f"{name}: risk {round(100 * f['risk'])} % (time to failure ~{round(f['ttf_min'])} min, "
                    f"band {round(f['ttf_band'][0])}–{round(f['ttf_band'][1])}). Main drivers: {top}.{gain}"),
        "agents": [
            {"role": "Reliability engineer", "stance": "act" if f["risk"] >= 0.5 else "monitor",
             "text": f"The pattern is consistent with {fault['name'].lower()}. {fault['story']}"},
            {"role": "Production planner", "stance": "minimise downtime",
             "text": (f"A planned {down}-min intervention is far cheaper than an unplanned repair (assumed 240 min)."
                      if down else "This action keeps the line rolling while buying time.")},
            {"role": "Safety officer", "stance": "caution" if f["trust"] >= 0.5 else "verify first",
             "text": ("Model trust is adequate; proceed under standard isolation procedures." if f["trust"] >= 0.5 else
                      "Model trust is low — confirm the readings in the field before acting.")},
        ],
        "recommendation": {"action": act, "rationale": f"{ACTIONS[act]['desc']}{gain}"},
        "work_order": {"title": f"{ACTIONS[act]['label']} — {name}", "steps": steps,
                       "parts": {"planned_maintenance": ["Spare bearing / component kit", "Seals and fasteners"],
                                 "switch_standby_pump": ["Impeller wear ring (for pump A)"],
                                 "increase_lube": ["Gear oil ISO VG 320 (top-up)", "Oil filter element"]}.get(act, []),
                       "est_downtime_min": down},
    }


def _numbers(obj) -> list[float]:
    s = json.dumps(obj)
    return [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", s)]


def numbers_ok(texts: list[str], facts: dict) -> bool:
    allowed = _numbers(facts)
    for txt in texts:
        for x in re.findall(r"-?\d+(?:\.\d+)?", txt):
            v = float(x)
            if abs(v) <= 10 and v == int(v):
                continue
            if not any(abs(v - a) <= max(1.0, 0.02 * abs(a)) or abs(v - 100 * a) <= 1 for a in allowed):
                return False
    return True


async def llm_council(facts: dict) -> tuple[dict, str]:
    allowed = facts["allowed_actions"]
    user = (f"FACTS: {json.dumps(facts)}\nConvene a 3-person maintenance council for this alert. Return "
            '{"summary":"2 sentences","agents":[{"role":"","stance":"","text":""} x3],'
            '"recommendation":{"action":"<one of allowed_actions>","rationale":""},'
            '"work_order":{"title":"","steps":[""],"parts":[""],"est_downtime_min":0}}. '
            "Quote only numbers that appear in FACTS.")
    obj, model, _ = await chat_json(SYSTEM, user, Council, max_tokens=1200, timeout=12)
    c = obj.model_dump()
    texts = [c["summary"], c["recommendation"]["rationale"]] + [a["text"] for a in c["agents"]]
    if c["recommendation"]["action"] not in allowed or len(c["agents"]) != 3 or not numbers_ok(texts, facts):
        raise ValueError("council post-check failed (action or numbers not grounded in facts)")
    return c, model


def allowed_actions(asset: str) -> list[str]:
    return ALLOWED_ACTIONS[asset]
