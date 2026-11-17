import math

import numpy as np
import pytest

from app.engine.health import steady_state
from app.ml.datagen import gen_run, split_runs
from app.twin.physics import ASSET_IDS, TAGS, Twin, nominal


def test_twin_sanity_values():
    tw = Twin(seed=1, grade=0, throughput=1.0)
    vals = [tw.step() for _ in range(50)]
    mean = {k: np.mean([v[k] for v in vals]) for k in TAGS}
    assert 1230 < mean["F1.FurnaceTemp"] < 1260
    assert 1150 < mean["F1.SlabExitTemp"] < 1185
    assert 2.5 < mean["R1.Vibration"] < 3.5
    assert 60 < mean["R1.BearingTemp"] < 75
    assert 820 < mean["CB.WaterFlow"] < 980
    assert 5.5 < mean["CB.PumpPressure"] < 6.5
    assert 0.0 < mean["CL.Misalignment"] < 0.3
    for k, (d, lim) in ((k, TAGS[k]["limit"]) for k in TAGS):  # healthy line never trips static limits
        assert (mean[k] < lim) if d == "hi" else (mean[k] > lim), k


def test_twin_fault_drives_failure_and_trip():
    tw = Twin(seed=2)
    tw.inject_fault("R1", 1 / 60)
    for _ in range(200):
        tw.step()
    assert tw.failed["R1"] and tw.state == "TRIPPED" and tw.u_eff == 0


def test_cascade_slab_temp_raises_roll_force():
    healthy = nominal(1.0, 0)
    cold = nominal(1.0, 0, d_slab=-80)
    assert cold["R1.RollForce"] > healthy["R1.RollForce"]


def test_split_by_run_no_leakage():
    s = split_runs(400, 42)
    tr, va, te = set(s["train"]), set(s["val"]), set(s["test"])
    assert not (tr & va or tr & te or va & te)
    assert len(tr | va | te) == 400
    df = gen_run(3, 123)
    assert df.run_id.nunique() == 1  # rows of a run stay together


@pytest.mark.parametrize("asset", ASSET_IDS)
def test_engine_risk_bands(asset):
    assert steady_state(asset, 0.0)["p"] < 0.08
    assert 0.15 <= steady_state(asset, 0.5)["p"] <= 0.60
    assert steady_state(asset, 0.9)["p"] > 0.85


@pytest.mark.parametrize("asset", ASSET_IDS)
@pytest.mark.parametrize("h", [0.0, 0.4, 0.9])
def test_engine_contributions_sum_100(asset, h):
    c = steady_state(asset, h)["contributions"]
    assert math.isclose(sum(x["share_pct"] for x in c), 100, abs_tol=0.5)


def test_engine_healthy_noisy_risk_low():
    from app.engine.health import HealthEngine
    tw, eng = Twin(seed=5), HealthEngine()
    for _ in range(200):
        out = eng.update(tw.step(), tw.last_exp)
    assert max(o["p"] for o in out.values()) < 0.08


def test_fast_iso_matches_sklearn():
    from sklearn.ensemble import IsolationForest
    from app.ml.runtime import iso_anomaly_score
    rng = np.random.default_rng(0)
    X = rng.normal(size=(500, 6))
    iso = IsolationForest(n_estimators=50, random_state=0).fit(X)
    assert np.allclose(iso_anomaly_score(iso, X[:20]), -iso.score_samples(X[:20]))
