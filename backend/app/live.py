"""Live orchestrator: twin tick -> features -> ML / Engine / LLM via the fallback router -> alerts, trust, HITL."""
from __future__ import annotations

import asyncio
import copy
import time
import uuid
from collections import deque

import numpy as np
import pandas as pd

from app import config
from app.engine.health import HealthEngine
from app.hitl.audit import Audit
from app.llm import client as llm_client
from app.llm import service as llm
from app.ml.features import make_features
from app.ml.runtime import MLRuntime
from app.twin.physics import (ACTIONS, ALL_TAGS, ASSETS, ASSET_IDS, MAINT_TICKS, PUMP_SWITCH_TICKS, TAGS,
                              UNPLANNED_REPAIR_MIN, Twin)
from app.twin.scenarios import SCENARIOS

LEVELS = {1: "ML · LightGBM + SHAP", 2: "FALLBACK 1 · Health Engine", 3: "FALLBACK 2 · LLM-estimated"}
CONTRIB_TITLE = {1: "SHAP contribution", 2: "Factor contribution", 3: "LLM-estimated contribution"}
CAPS = ("risk", "anomaly", "explanation")
REASON_CODES = {"FALSE_ALARM": "False alarm — asset is fine", "SENSOR_FAULT": "Instrument / sensor fault",
                "PLANNED_WINDOW": "Will handle in planned window", "PRODUCTION_PRIORITY": "Production priority",
                "OTHER": "Other (see note)"}
COST_PER_MIN_INR = 22000   # assumption: lost margin + knock-on costs per minute of unplanned stop
TONS_PER_MIN = 10          # 600 t/h nominal line rate
RECOVER_TICKS = 10
SLOW_MS = 150


def _lvl_dist(a: str, b: str) -> int:
    order = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
    return abs(order.index(a) - order.index(b))


class Cap:
    def __init__(self):
        self.level, self.ok_streak, self.reason = 1, 0, ""


class Live:
    def __init__(self):
        self.audit = Audit()
        self.ml = MLRuntime()
        self.clients: set = set()
        self.mode = "auto"  # auto | engine | llm
        self.speed = 1
        self.progress = {"ready": self.ml.ready, "stage": "Models loaded" if self.ml.ready else "Waiting", "pct": 1.0 if self.ml.ready else 0.0}
        self.llm_last_call = 0.0
        self.llm_busy = False
        self.reset(log=False)

    # ------------------------------------------------------------------ lifecycle
    def reset(self, log=True):
        self.twin = Twin(seed=config.SEED, grade=0, throughput=0.95)
        self.engine = HealthEngine()
        self.hist: deque = deque(maxlen=30)
        self.caps = {c: Cap() for c in CAPS}
        if not self.ml.ready:
            for c in self.caps.values():
                c.level, c.reason = 2, "models not trained yet"
        self.slow_streak = 0
        self.thresholds = {a: 0.5 for a in ASSET_IDS}
        self.thr_hist = {a: [0.5] for a in ASSET_IDS}
        self.p_hist = {a: deque(maxlen=5) for a in ASSET_IDS}
        self.spark = {a: deque(maxlen=90) for a in ASSET_IDS}
        self.above = {a: 0 for a in ASSET_IDS}
        self.below = {a: 0 for a in ASSET_IDS}
        self.armed = {a: True for a in ASSET_IDS}
        self.alerts: dict[str, dict] = {}
        self.open_alert: dict[str, str | None] = {a: None for a in ASSET_IDS}
        self.override_watch: dict[str, int] = {}
        self.councils: dict[str, dict] = {}
        self.prev_h = {a: 0.0 for a in ASSET_IDS}
        self.prev_failed = {a: False for a in ASSET_IDS}
        self.kpis = {"alerts": 0, "decisions": 0, "approvals": 0, "modifications": 0, "overrides": 0,
                     "agreement": None, "avg_ttd_s": None, "_ttd": []}
        self.impact = {"failures_prevented": 0, "unplanned_failures": 0, "avoided_downtime_min": 0,
                       "planned_downtime_min": 0, "cost_saved_inr": 0, "tons_protected": 0}
        self.learned: deque = deque(maxlen=25)
        self.events: list = []
        self.llm_est: dict = {}
        self.llm_est_t = 0.0
        self.llm_est_model = ""
        self.llm_est_error = ""
        self.opinions: dict = {}
        self.opinions_t = 0.0
        self.opinions_model = ""
        self.last: dict = {}
        self.ml_out = None
        self.eng_out = None
        if log:
            self._log("HUMAN", "Twin reset", payload={})

    def _log(self, actor, event, asset=None, payload=None, level=None, toast=None):
        e = self.audit.log(actor, event, asset, level, payload, tick=self.twin.t)
        if toast:
            self.events.append({"kind": toast, "text": event, "asset": asset, "payload": payload or {}})
        return e

    # ------------------------------------------------------------------ fallback router
    def _resolve(self, cap: str, ml_ok: bool, eng_ok: bool, why: str) -> int:
        st = self.caps[cap]
        want = {"auto": 1, "engine": 2, "llm": 3}[self.mode]
        before = st.level
        if want == 1:
            if st.level == 1 and not ml_ok:
                st.level, st.ok_streak, st.reason = (2 if eng_ok else 3), 0, why
            elif st.level > 1:
                st.ok_streak = st.ok_streak + 1 if ml_ok else 0
                if st.ok_streak >= RECOVER_TICKS:
                    st.level, st.reason = 1, ""
                else:
                    st.level = 2 if eng_ok else 3
                    if not ml_ok:
                        st.reason = why or st.reason
        else:
            st.level = want if (want == 3 or eng_ok) else 3
            st.reason = "forced from demo control" if want == st.level else "Health Engine unavailable"
            st.ok_streak = 0
        if st.level != before:
            if st.level > before:
                self._log("AI", f"{cap.capitalize()} fell back to {LEVELS[st.level]}", payload={"reason": st.reason},
                          level=str(st.level), toast="fallback")
            else:
                self._log("AI", f"{cap.capitalize()} recovered to {LEVELS[st.level]}",
                          payload={"healthy_ticks": RECOVER_TICKS}, level=str(st.level), toast="recover")
        return st.level

    # ------------------------------------------------------------------ main tick
    def tick(self) -> dict:
        tw = self.twin
        vals = tw.step()
        row = {**vals, **{"exp:" + k: v for k, v in tw.last_exp.items()}, "grade": tw.grade, "u": tw.u_eff}
        self.hist.append(row)
        frame = tw.frame()
        df = pd.DataFrame(list(self.hist))
        feats = make_features(df)
        for k in ALL_TAGS:
            feats["__exp:" + k] = df["exp:" + k]

        ml_out, why = None, ""
        try:
            ml_out = self.ml.predict(feats, tw.t)
            self.slow_streak = self.slow_streak + 1 if self.ml.last_latency_ms > SLOW_MS else 0
            if self.slow_streak >= 3:
                why = f"inference latency > {SLOW_MS} ms for 3 ticks"
        except Exception as e:  # noqa: BLE001 — any ML failure triggers fallback
            why = str(e)
        ml_ok = ml_out is not None and self.slow_streak < 3
        try:
            eng = self.engine.update(vals, tw.last_exp)
        except Exception:  # noqa: BLE001
            eng = None
        self.ml_out, self.eng_out = ml_out, eng
        lv = {c: self._resolve(c, ml_ok, eng is not None, why) for c in CAPS}

        risks = {}
        now = time.time()
        llm_stale = (now - self.llm_est_t) > 15 or bool(self.llm_est_error)
        for a in ASSET_IDS:
            eff = {}
            src = {}
            for c in CAPS:
                level = lv[c]
                if level == 3 and not (a in self.llm_est and not self.llm_est[a].get("postcheck_failed")):
                    level = 2 if eng is not None else 3  # no LLM estimate yet / post-check failed -> Engine values
                if level == 1 and ml_out is None:
                    level = 2
                eff[c] = level
                src[c] = {1: ml_out, 2: eng, 3: self.llm_est}.get(level)
                src[c] = src[c][a] if src[c] and a in src[c] else None
            rs, an, ex = src["risk"], src["anomaly"], src["explanation"]
            if rs is None:  # nothing at all (LLM-only with no data): hold last
                risks[a] = {**self.last.get("risks", {}).get(a, {}), "stale": True}
                continue
            p = float(rs["p"])
            self.p_hist[a].append(p)
            self.spark[a].append(round(p, 3))
            r = {"p": round(p, 4), "p_lo": round(min(self.p_hist[a]), 4), "p_hi": round(max(self.p_hist[a]), 4),
                 "anomaly": round(float(an["anomaly"]), 4) if an else 0.0,
                 "ttf": round(rs["ttf"], 1), "ttf_lo": round(rs["ttf_lo"], 1), "ttf_hi": round(rs["ttf_hi"], 1),
                 "ttf_method": {1: "LightGBM RUL ± 1.28σ", 2: "trend-extrapolated ± 25 %", 3: "LLM-estimated"}[eff["risk"]],
                 "threshold": self.thresholds[a], "level": eff["risk"], "levels": eff,
                 "contributions": ex["contributions"] if ex else [], "contrib_title": CONTRIB_TITLE[eff["explanation"]],
                 "base_value": ex.get("base_value") if ex and eff["explanation"] == 1 else None,
                 "stale": eff["risk"] == 3 and llm_stale, "spark": list(self.spark[a])}
            r["diagnosis"] = ex["diagnosis"] if eff["explanation"] == 3 and ex and ex.get("diagnosis") else llm.diagnose(a, r, frame)
            r["trust"] = self._trust(a, r, ml_out, eng)
            risks[a] = r
            self._alerts(a, r, frame)
        self._twin_events(frame)
        focus = max(risks, key=lambda a: max(risks[a].get("p", 0), risks[a].get("anomaly", 0) * 0.6))
        self.kpis["agreement"] = (self.kpis["approvals"] / self.kpis["decisions"]) if self.kpis["decisions"] else None
        self.kpis["avg_ttd_s"] = float(np.mean(self.kpis["_ttd"])) if self.kpis["_ttd"] else None
        worst = {c: max(r["levels"][c] for r in risks.values() if "levels" in r) if risks else 2 for c in CAPS}
        msg = {
            "type": "tick", "frame": frame, "risks": risks, "focus": focus,
            "trust": risks[focus].get("trust"),
            "kpis": {k: v for k, v in self.kpis.items() if not k.startswith("_")},
            "impact": self.impact,
            "ai": {"mode": self.mode, "levels": worst, "level": max(worst.values()),
                   "names": {c: LEVELS[worst[c]] for c in CAPS},
                   "reasons": {c: self.caps[c].reason for c in CAPS},
                   "recover": {c: self.caps[c].ok_streak for c in CAPS},
                   "ml_latency_ms": round(self.ml.last_latency_ms, 1), "ml_ready": self.ml.ready,
                   "outage": tw.t < self.ml.outage_until, "llm": llm_client.status(),
                   "llm_est_model": self.llm_est_model, "llm_error": self.llm_est_error},
            "alerts": [al for al in self.alerts.values() if al["status"] == "open"],
            "thresholds": {a: {"value": self.thresholds[a], "hist": self.thr_hist[a][-40:]} for a in ASSET_IDS},
            "learned": list(self.learned), "events": self.events, "speed": self.speed, "progress": self.progress,
        }
        self.events = []  # drained into this message (also carries events logged by API calls between ticks)
        self.last = msg
        return msg

    # ------------------------------------------------------------------ trust
    def _trust(self, a, r, ml_out, eng) -> dict:
        lvl = r["level"]
        mine = llm.risk_level(r["p"])
        fresh = time.time() - self.opinions_t < 20 and a in self.opinions
        if fresh:
            other, src = self.opinions[a]["risk_level"], f"LLM second opinion · {self.opinions_model}"
            d = _lvl_dist(mine, other)
            agreement = 1.0 if d == 0 else 0.5 if d == 1 else 0.0
            cause = self.opinions[a].get("likely_cause")
        elif lvl == 1 and eng and a in eng:
            # physics cross-check: ML warns ~60 min ahead of visible degradation, so instead of comparing risk
            # levels we ask whether the asset's fault-signature tags move together (a lone erratic tag = suspect)
            consistency = sum(c["weight"] for c in eng[a]["contributions"] if c["z"] >= 0.08)
            eng_lvl = llm.risk_level(eng[a]["p"])
            if mine == "LOW":  # physics sees a deviation the model does not explain -> partial disagreement
                agreement = 0.0 if eng_lvl == "CRITICAL" else 0.5 if (eng_lvl == "HIGH" or eng[a]["anomaly"] >= 0.3) else 1.0
            else:
                agreement = 1.0 if consistency >= 0.6 else 0.5 if consistency >= 0.3 else 0.0
            other = f"{eng_lvl} · signature {consistency:.0%} consistent"
            for tag, ratio in self._erratic(a):  # residual noise far above the sensor spec -> instrument suspect
                agreement = min(agreement, 0.5)
                other += f" · {TAGS[tag]['label']} noise {ratio:.0f}× spec"
            src, cause = "Health Engine physics cross-check", None
        else:
            cross = (ml_out or {}).get(a)
            src = "LightGBM cross-check" if cross else "no independent check"
            other = llm.risk_level(cross["p"]) if cross else None
            d = _lvl_dist(mine, other) if other else 1
            agreement = (1.0 if d <= 1 else 0.5 if d == 2 else 0.0) if cross else 0.5
            cause = None
        if lvl == 1 and ml_out and a in ml_out:
            in_dist, in_src = 1 - ml_out[a]["ood"], "IsolationForest (training coverage)"
        else:
            in_dist, in_src = 1 - r["anomaly"], "1 − anomaly"
        trust = 0.5 * agreement + 0.5 * in_dist
        return {"value": round(trust, 3), "agreement": agreement, "in_dist": round(in_dist, 3), "mine": mine,
                "other": other, "source": src, "in_dist_source": in_src, "likely_cause": cause,
                "review": trust < 0.5}

    def _erratic(self, a) -> list[tuple[str, float]]:
        rows = list(self.hist)[-10:]
        out = []
        for t in ASSETS[a]["tags"]:
            k = f"{a}.{t}"
            res = np.array([r[k] - r["exp:" + k] for r in rows], float)
            res = res[np.isfinite(res)]
            if len(res) >= 5:
                ratio = float(np.std(np.diff(res)) / np.sqrt(2) / TAGS[k]["sigma"])  # diff removes slow fault trends
                if ratio > 4:
                    out.append((k, ratio))
        return out

    # ------------------------------------------------------------------ alerts & twin events
    def _alerts(self, a, r, frame):
        thr = self.thresholds[a]
        p = r["p"]
        if p >= thr:
            self.above[a] += 1
            self.below[a] = 0
        else:
            self.above[a] = 0
            self.below[a] += 1
        aid = self.open_alert[a]
        if not self.armed[a] and self.below[a] >= 5:
            self.armed[a] = True
        if aid is None and self.armed[a] and self.above[a] >= 3 and not frame["assets"][a]["failed"]:
            aid = uuid.uuid4().hex[:8]
            self.alerts[aid] = {"id": aid, "asset": a, "name": ASSETS[a]["name"], "tick": self.twin.t,
                                "created": time.time(), "p": p, "ttf": r["ttf"], "level": r["level"],
                                "status": "open", "emergency_since": None, "escalated": False}
            self.open_alert[a] = aid
            self.kpis["alerts"] += 1
            self._log("AI", f"Alert raised on {a}: risk {p:.0%}, ~{r['ttf']:.0f} min to failure", a,
                      {"alert_id": aid, "p": p, "ttf": r["ttf"], "threshold": thr}, str(r["level"]), toast="alert")
        if aid:
            al = self.alerts[aid]
            al.update(p=p, ttf=r["ttf"], level=r["level"], trust=r["trust"]["value"])
            if p >= 0.9:
                if al["emergency_since"] is None:
                    al["emergency_since"] = self.twin.t
                    self._log("AI", f"Emergency stop recommended on {a} — awaiting human", a, {"alert_id": aid},
                              str(r["level"]), toast="emergency")
                elif not al["escalated"] and self.twin.t - al["emergency_since"] >= 60:
                    al["escalated"] = True
                    self._log("AI", f"ESCALATED: {a} emergency unanswered for 60 min", a, {"alert_id": aid},
                              str(r["level"]), toast="emergency")
            if self.below[a] >= 10:
                al["status"] = "cleared"
                self.open_alert[a] = None
                self._log("AI", f"Alert on {a} cleared (risk below threshold)", a, {"alert_id": aid}, str(r["level"]))

    def _twin_events(self, frame):
        tw = self.twin
        for a in ASSET_IDS:
            if tw.failed[a] and not self.prev_failed[a]:
                self.impact["unplanned_failures"] += 1
                self._log("TWIN", f"{ASSETS[a]['name']} FAILED — line tripped", a, {"h": 1.0}, toast="failure")
                if a in self.override_watch and tw.t - self.override_watch[a] <= 180:
                    self._learn(a, -0.08, "AI was right — failure followed an override; threshold lowered")
                    del self.override_watch[a]
                if self.open_alert[a]:
                    self.alerts[self.open_alert[a]]["status"] = "failed"
                    self.open_alert[a] = None
            if self.prev_h[a] > 0.05 and tw.h[a] == 0 and not tw.failed[a]:
                down = PUMP_SWITCH_TICKS if a == "CB" and tw.stop_until - tw.t < MAINT_TICKS else MAINT_TICKS
                self.impact["failures_prevented"] += 1
                self.impact["planned_downtime_min"] += down
                saved = UNPLANNED_REPAIR_MIN - down
                self.impact["avoided_downtime_min"] += saved
                self.impact["cost_saved_inr"] += saved * COST_PER_MIN_INR
                self.impact["tons_protected"] += saved * TONS_PER_MIN
                self._log("TWIN", f"{ASSETS[a]['name']} restored to health — failure prevented", a,
                          {"avoided_downtime_min": saved}, toast="prevented")
            self.prev_h[a], self.prev_failed[a] = tw.h[a], tw.failed[a]

    def _learn(self, a, delta, text):
        old = self.thresholds[a]
        new = float(np.clip(old + delta, 0.30, 0.90))
        self.thresholds[a] = round(new, 3)
        self.thr_hist[a].append(round(new, 3))
        item = {"asset": a, "text": text, "old": old, "new": round(new, 3), "tick": self.twin.t, "ts": time.time()}
        self.learned.appendleft(item)
        self._log("AI", f"AI learned on {a}: {text} ({old:.2f} → {new:.2f})", a, item, toast="learned")

    # ------------------------------------------------------------------ controls
    def inject(self, body: dict) -> str:
        sc = body.get("scenario")
        if sc:
            s = SCENARIOS[sc]
            if s["kind"] == "fault":
                self.twin.inject_fault(s["asset"], s["rate"])
            elif s["kind"] == "glitch":
                self.twin.inject_glitch(s["tag"], s["amp"])
            elif s["kind"] == "outage":
                self.ml.outage_until = self.twin.t + s["ticks"]
            self._log("HUMAN", f"Scenario {sc} injected: {s['title']}", s.get("asset"), s, toast="scenario")
            return s["title"]
        kind, asset = body.get("kind", "fault"), body.get("asset")
        if kind == "fault":
            self.twin.inject_fault(asset, float(body.get("rate", 1 / 150)))
        elif kind == "glitch":
            self.twin.inject_glitch(body["tag"], float(body.get("amp", 9)))
        elif kind == "dropout":
            self.twin.dropout.add(body["tag"])
        self._log("HUMAN", f"Injected {kind} on {asset or body.get('tag')}", asset, body, toast="scenario")
        return kind

    def outage(self, ticks=30):
        self.ml.outage_until = self.twin.t + ticks if ticks else -1
        self._log("HUMAN", "Simulated model outage" if ticks else "Model outage cleared", payload={"ticks": ticks},
                  toast="scenario")

    def set_mode(self, mode: str):
        self.mode = mode
        self._log("HUMAN", f"AI engine set to {mode}", payload={"mode": mode}, level=str({"auto": 1, "engine": 2, "llm": 3}[mode]))

    def do_action(self, action, asset=None, params=None, actor="HUMAN", alert_id=None) -> str:
        if action not in ACTIONS:
            raise ValueError(f"unknown action {action}")
        msg = self.twin.apply_action(action, asset, params)
        self._log("TWIN", f"Executed: {msg}", asset, {"action": action, "params": params or {}, "by": actor,
                                                      "alert_id": alert_id}, toast="action")
        return msg

    # ------------------------------------------------------------------ HITL decisions
    def decide(self, body: dict) -> dict:
        aid, decision = body.get("alert_id"), body.get("decision")
        al = self.alerts.get(aid)
        if not al or al["status"] != "open":
            raise ValueError("alert is not open")
        a = al["asset"]
        r = self.last["risks"][a]
        level = str(r["level"])
        if decision == "override" and body.get("reason_code") not in REASON_CODES:
            raise ValueError("override requires a reason code")
        council = self.councils.get(aid)
        rec = (council or {}).get("recommendation", {}).get("action") or llm.recommend(a, r, self._suspect_sensor(r))
        if decision == "approve":
            if r["trust"]["review"]:
                raise ValueError("trust too low — recommendation withheld; modify or override instead")
            action, params = rec, ({"pct": 30} if rec == "derate" else {})
        elif decision == "modify":
            action, params = body.get("action"), body.get("params") or {}
            if action not in ACTIONS:
                raise ValueError("modify requires a valid action")
        elif decision == "override":
            action, params = None, {}
        else:
            raise ValueError("decision must be approve | modify | override")
        ttd = time.time() - al["created"]
        self.kpis["decisions"] += 1
        self.kpis["_ttd"].append(ttd)
        self.kpis[{"approve": "approvals", "modify": "modifications", "override": "overrides"}[decision]] += 1
        al["status"] = {"approve": "approved", "modify": "modified", "override": "overridden"}[decision]
        self.open_alert[a] = None
        self.armed[a] = False
        self._log("HUMAN", f"{decision.capitalize()} on {a} alert", a,
                  {"alert_id": aid, "recommended": rec, "action": action, "reason_code": body.get("reason_code"),
                   "note": body.get("note", ""), "time_to_decision_s": round(ttd, 1), "trust": r["trust"]["value"]},
                  level, toast="decision")
        out = {"ok": True, "status": al["status"]}
        if action:
            out["executed"] = self.do_action(action, a, params, actor="HUMAN", alert_id=aid)
            self._learn(a, -0.01, "Alert confirmed by operator")
        else:
            if body.get("reason_code") in ("FALSE_ALARM", "SENSOR_FAULT"):
                self._learn(a, +0.03, f"Judged false alarm ({REASON_CODES[body['reason_code']]})")
            self.override_watch[a] = self.twin.t
        return out

    def _suspect_sensor(self, r) -> bool:
        a = next((k for k, v in self.last.get("risks", {}).items() if v is r), None)
        return r["trust"]["review"] and (r["anomaly"] >= 0.6 or bool(a and self._erratic(a)))

    # ------------------------------------------------------------------ what-if
    def whatif(self, body: dict, horizon: int = 120) -> dict:
        a = body.get("asset", "R1")
        level = self.last.get("risks", {}).get(a, {}).get("level", 2)
        if level == 1 and not self.ml.ready:
            level = 2
        seed = int(np.random.default_rng().integers(0, 2**31 - 1))

        def run(modify: bool):
            tw = self.twin.fork(seed)
            eng = copy.deepcopy(self.engine)
            if modify:
                tw.set_control(throughput=body.get("throughput"), derate=(body["derate"] / 100) if body.get("derate") is not None else None)
                if body.get("action"):
                    tw.apply_action(body["action"], a, body.get("params") or ({"pct": 30} if body["action"] == "derate" else {}))
            rows, eng_p, fail = [], [], None
            for k in range(horizon):
                vals = tw.step()
                rows.append({**vals, **{"exp:" + kk: v for kk, v in tw.last_exp.items()}, "grade": tw.grade, "u": tw.u_eff})
                eng_p.append(eng.update(vals, tw.last_exp)[a]["p"])
                if tw.failed[a]:
                    fail = k + 1
                    break
            if level == 1:
                hist = list(self.hist)
                df = pd.DataFrame(hist + rows)
                p = self.ml.predict_batch(make_features(df).iloc[len(hist):], a).tolist()
            else:
                p = eng_p
            if fail:
                p = p + [1.0] * (horizon - len(p))
            return {"risk": [round(x, 4) for x in p], "fail_min": fail}

        base, alt = run(False), run(True)
        return {"asset": a, "horizon": horizon, "level": level, "level_name": LEVELS[level],
                "baseline": base, "scenario": alt, "pushed": [base["fail_min"], alt["fail_min"]]}

    # ------------------------------------------------------------------ council
    async def council(self, body: dict) -> dict:
        aid = body.get("alert_id")
        a = self.alerts[aid]["asset"] if aid in self.alerts else body.get("asset")
        if a not in ASSETS:
            raise ValueError("unknown asset")
        r = self.last["risks"][a]
        rec = llm.recommend(a, r, self._suspect_sensor(r))
        wi = self.whatif({"asset": a, "action": rec}) if rec not in ("emergency_stop", "recalibrate_sensor") else None
        facts = {"asset": a, "asset_name": ASSETS[a]["name"], "risk": round(r["p"], 3), "ttf_min": r["ttf"],
                 "ttf_band": [r["ttf_lo"], r["ttf_hi"]], "provenance": LEVELS[r["level"]],
                 "top_contributions": [{"label": c.get("label"), "share_pct": c.get("share_pct")} for c in r["contributions"][:4]],
                 "diagnosis": r["diagnosis"], "trust": r["trust"]["value"], "allowed_actions": llm.allowed_actions(a),
                 "recommended_action": rec,
                 "whatif": {"baseline_fail_min": wi["baseline"]["fail_min"], "action_fail_min": wi["scenario"]["fail_min"]} if wi else None,
                 "assumptions": {"unplanned_repair_min": UNPLANNED_REPAIR_MIN, "planned_maintenance_min": MAINT_TICKS}}
        try:
            out, model = await llm.llm_council(facts)
            gen = model
        except Exception as e:  # noqa: BLE001 — any LLM problem -> deterministic template
            out, gen = llm.council_template(facts), f"deterministic template ({str(e)[:80]})" if llm_client.chain() else "deterministic template"
        out["generated_by"] = gen
        out["facts"] = facts
        out["withheld"] = r["trust"]["review"]
        if aid:
            self.councils[aid] = out
        self._log("AI", f"Council convened for {a}", a, {"alert_id": aid, "generated_by": gen,
                                                          "recommendation": out["recommendation"]["action"],
                                                          "withheld": out["withheld"]}, str(r["level"]))
        return out

    # ------------------------------------------------------------------ LLM background work
    async def llm_tick(self):
        if self.llm_busy or not llm_client.chain() or not self.last:
            return
        now = time.time()
        if now - self.llm_last_call < 5:
            return
        risks = self.last["risks"]
        need_est = any(c.level == 3 for c in self.caps.values())
        hot = [a for a, r in risks.items() if r.get("p", 0) > 0.25 or r.get("anomaly", 0) > 0.6]
        if not need_est and not hot:
            return
        self.llm_busy, self.llm_last_call = True, now
        facts = llm.estimate_facts(list(self.hist), self.twin.last_exp, self.last["frame"])
        try:
            if need_est:
                est, model = await llm.llm_estimates(facts, self.eng_out or {})
                self.llm_est, self.llm_est_t, self.llm_est_model, self.llm_est_error = est, time.time(), model, ""
            else:
                ops, model = await llm.llm_second_opinion(facts, hot)
                self.opinions, self.opinions_t, self.opinions_model = ops, time.time(), model
        except Exception as e:  # noqa: BLE001 — keep last good values, flag STALE
            if need_est:
                self.llm_est_error = str(e)[:160]
        finally:
            self.llm_busy = False

    # ------------------------------------------------------------------ static info
    def hello(self) -> dict:
        from app.twin.physics import ALLOWED_ACTIONS, FAULTS, GRADES, TAGS
        return {"type": "hello", "assets": ASSETS, "tags": TAGS, "actions": ACTIONS, "allowed": ALLOWED_ACTIONS,
                "faults": FAULTS, "scenarios": SCENARIOS, "levels": LEVELS, "reason_codes": REASON_CODES,
                "grades": GRADES, "mode": self.mode, "speed": self.speed, "progress": self.progress,
                "assumptions": {"cost_per_min_inr": COST_PER_MIN_INR, "tons_per_min": TONS_PER_MIN,
                                "unplanned_repair_min": UNPLANNED_REPAIR_MIN, "planned_maintenance_min": MAINT_TICKS}}

    async def run(self):
        while True:
            t0 = time.perf_counter()
            try:
                msg = self.tick()
                await self.broadcast(msg)
                asyncio.create_task(self.llm_tick())
            except Exception as e:  # noqa: BLE001 — the loop must never die mid-demo
                import traceback
                traceback.print_exc()
                self._log("AI", f"Tick error: {e}")
            await asyncio.sleep(max(0.0, 1 / self.speed - (time.perf_counter() - t0)))

    async def broadcast(self, msg):
        import json
        data = json.dumps(msg, default=_json_default)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


def _json_default(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (set, deque)):
        return list(o)
    return str(o)
