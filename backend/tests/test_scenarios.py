import asyncio
import shutil

import pytest

from app import config
from app.ml.runtime import MLRuntime
from app.twin.physics import Twin
from conftest import NEED_MODELS

pytestmark = NEED_MODELS


def tick(lv, n):
    return [lv.tick() for _ in range(n)]


def warm(lv, n=40):
    return tick(lv, n)


def lead_run(mk_live, seed, scenario, asset, grade):
    lv = mk_live()
    lv.twin = Twin(seed=seed, grade=grade, throughput=0.95)
    warm(lv)
    lv.inject({"scenario": scenario})
    alert_t = fail_t = None
    for _ in range(170):
        lv.tick()
        if alert_t is None and any(al["asset"] == asset for al in lv.alerts.values()):
            alert_t = lv.twin.t
        if lv.twin.failed[asset]:
            fail_t = lv.twin.t
            break
    return alert_t, fail_t


@pytest.mark.parametrize("scenario,asset", [("S1", "R1"), ("S2", "CB")])
def test_lead_time(mk_live, scenario, asset):
    good = 0
    for s in range(10):
        a, f = lead_run(mk_live, 100 + s, scenario, asset, s % 3)
        if a is not None and f is not None and f - a > 0:
            good += 1
    assert good >= 8, f"{scenario}: only {good}/10 runs alerted with lead time"


def test_s3_sensor_glitch(mk_live):
    lv = mk_live()
    warm(lv)
    base = lv.last["risks"]["R1"]["anomaly"]
    lv.inject({"scenario": "S3"})
    msgs = tick(lv, 40)[15:]
    review = sum(m["risks"]["R1"]["trust"]["review"] for m in msgs)
    assert review > len(msgs) / 2
    assert max(m["risks"]["R1"]["anomaly"] for m in msgs) > base
    out = asyncio.run(lv.council({"asset": "R1"}))
    assert out["withheld"] is True and "template" in out["generated_by"]


def levels(msg):
    return {r["level"] for r in msg["risks"].values()}


def test_engine_and_llm_modes(mk_live):
    lv = mk_live()
    warm(lv, 15)
    lv.set_mode("engine")
    m = lv.tick()
    assert levels(m) == {2}
    assert all(r["contrib_title"] == "Factor contribution" for r in m["risks"].values())
    lv.set_mode("llm")
    m = lv.tick()  # no provider: no estimates -> engine values, no exception
    assert levels(m) == {2}
    lv.set_mode("auto")
    m = tick(lv, 12)[-1]
    assert levels(m) == {1}


def test_outage_recovery(mk_live):
    lv = mk_live()
    warm(lv, 15)
    lv.outage(30)
    during = tick(lv, 25)
    assert all(levels(m) == {2} for m in during[2:])
    after = tick(lv, 5 + 12)
    assert levels(after[-1]) == {1}


def test_corrupt_file_fails_hash(tmp_path):
    d = tmp_path / "m"
    shutil.copytree(config.MODELS_DIR, d)
    rt = MLRuntime(d)
    assert rt.ready
    (d / "R1_clf.joblib").write_bytes(b"garbage")
    assert rt.try_load() is False and "corrupt" in rt.last_error and not rt.ready


def test_model_file_missing_and_restore(mk_live, tmp_path):
    d = tmp_path / "m"
    shutil.copytree(config.MODELS_DIR, d)
    lv = mk_live(MLRuntime(d))
    warm(lv, 15)
    assert levels(lv.last) == {1}
    f = d / "R1_clf.joblib"
    keep = f.read_bytes()
    f.unlink()
    during = tick(lv, 5)
    assert all(levels(m) == {2} for m in during)
    f.write_bytes(keep)
    after = tick(lv, 14)
    assert levels(after[-1]) == {1}


def test_nan_features_fall_back(mk_live):
    lv = mk_live()
    warm(lv, 15)
    lv.twin.dropout.add("R1.Vibration")
    msgs = tick(lv, 5)
    assert all(levels(m) == {2} for m in msgs)


def test_contributions(mk_live):
    lv = mk_live()
    m = warm(lv, 20)[-1]
    for r in m["risks"].values():
        assert r["level"] == 1 and r["contrib_title"] == "SHAP contribution"
        assert all("shap" in c for c in r["contributions"])
    lv.set_mode("engine")
    m = lv.tick()
    for r in m["risks"].values():
        assert abs(sum(c["share_pct"] for c in r["contributions"]) - 100) < 1.0


def open_alert(lv, asset="CL", rate=1 / 40):
    lv.inject({"kind": "fault", "asset": asset, "rate": rate})
    for _ in range(150):
        lv.tick()
        for aid, al in lv.alerts.items():
            if al["status"] == "open" and al["asset"] == asset:
                return aid
    pytest.fail("no alert")


def test_hitl(mk_live):
    lv = mk_live()
    warm(lv)
    aid = open_alert(lv)
    with pytest.raises(ValueError):
        lv.decide({"alert_id": aid, "decision": "override"})
    t0 = lv.thresholds["CL"]
    lv.decide({"alert_id": aid, "decision": "override", "reason_code": "FALSE_ALARM"})
    assert lv.thresholds["CL"] == pytest.approx(t0 + 0.03)

    lv.reset()
    warm(lv)
    aid = open_alert(lv)
    lv.last["risks"]["CL"]["trust"]["review"] = False
    t0 = lv.thresholds["CL"]
    out = lv.decide({"alert_id": aid, "decision": "approve"})
    assert "executed" in out and lv.twin.state == "MAINTENANCE"
    assert lv.thresholds["CL"] == pytest.approx(t0 - 0.01)
    rows = lv.audit.query(actor="HUMAN", q="Approve")
    assert rows and rows[0]["asset"] == "CL" and rows[0]["level"] in ("1", "2")

    lv.reset()
    warm(lv)
    aid = open_alert(lv)
    lv.last["risks"]["CL"]["trust"]["review"] = True
    with pytest.raises(ValueError):
        lv.decide({"alert_id": aid, "decision": "approve"})


def test_whatif_pushes_failure(mk_live):
    lv = mk_live()
    warm(lv)
    lv.inject({"scenario": "S1"})
    tick(lv, 60)
    w = lv.whatif({"asset": "R1", "action": "planned_maintenance"})
    b, s = w["baseline"]["fail_min"], w["scenario"]["fail_min"]
    assert s is None or (b is not None and s > b)
