"""Train per-asset LightGBM risk classifier, RUL regressor and two IsolationForests.

python -m app.ml.train   (from backend/)
"""
from __future__ import annotations

import hashlib
import json
import time

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.metrics import average_precision_score, log_loss

from app import config
from app.ml.datagen import H, RUL_CAP, data_hash, generate, split_runs
from app.ml.features import FEATURES, make_features
from app.twin.physics import ASSET_IDS

LGB_PARAMS = dict(n_estimators=400, learning_rate=0.05, num_leaves=31, subsample=0.8, subsample_freq=1,
                  colsample_bytree=0.8, min_child_samples=40, verbose=-1)


def _ap_tiebreak(y, p):
    """Validation average precision (0.002 steps); ties broken by log-loss so AP plateaus don't stop at tree 5."""
    ap = average_precision_score(y, p)
    return "ap_tiebreak", np.floor(ap * 500) / 500 - 1e-3 * log_loss(y, np.clip(p, 1e-6, 1 - 1e-6)), True


def _sha(path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_dataset(n_runs: int, seed: int, progress=lambda stage, pct: None) -> pd.DataFrame:
    progress("Simulating 400 twin runs", 0.0)
    raw = generate(n_runs, seed, lambda p: progress(f"Simulating {n_runs} twin runs", 0.4 * p))
    progress("Engineering streaming features", 0.42)
    feats = pd.concat([make_features(g) for _, g in raw.groupby("run_id", sort=False)])
    return pd.concat([raw, feats.drop(columns=["grade"])], axis=1)


def train_all(progress=lambda stage, pct: None, n_runs: int | None = None, seed: int | None = None) -> dict:
    n_runs = n_runs or config.N_RUNS
    seed = config.SEED if seed is None else seed
    t0 = time.time()
    df = build_dataset(n_runs, seed, progress)
    split = split_runs(n_runs, seed)
    tr, va = df[df.run_id.isin(split["train"])], df[df.run_id.isin(split["val"])]
    healthy_tr = tr[(tr[[f"h:{a}" for a in ASSET_IDS]] == 0).all(axis=1)]
    md = config.MODELS_DIR
    manifest = {"created": time.strftime("%Y-%m-%d %H:%M:%S"), "seed": seed, "n_runs": n_runs,
                "rows": int(len(df)), "data_hash": data_hash(df), "horizon": H, "rul_cap": RUL_CAP,
                "split": {k: len(v) for k, v in split.items()}, "assets": {}}
    for i, a in enumerate(ASSET_IDS):
        progress(f"Training LightGBM models for {a}", 0.45 + 0.4 * i / len(ASSET_IDS))
        cols = FEATURES[a]
        trv, vav = tr[tr[f"valid:{a}"]], va[va[f"valid:{a}"]]
        pos = max(int(trv[f"y:{a}"].sum()), 1)
        clf = lgb.LGBMClassifier(**LGB_PARAMS, metric="None",
                                 scale_pos_weight=(len(trv) - pos) / pos, random_state=seed)
        clf.fit(trv[cols], trv[f"y:{a}"], eval_set=[(vav[cols], vav[f"y:{a}"])], eval_metric=_ap_tiebreak,
                callbacks=[lgb.early_stopping(80, first_metric_only=True, verbose=False)])
        reg = lgb.LGBMRegressor(**LGB_PARAMS, metric="l2", random_state=seed)
        reg.fit(trv[cols], trv[f"rul:{a}"], eval_set=[(vav[cols], vav[f"rul:{a}"])],
                callbacks=[lgb.early_stopping(60, verbose=False)])
        rul_sigma = float(np.std(vav[f"rul:{a}"] - reg.predict(vav[cols])))
        # anomaly meter: healthy-only; in-distribution check for trust: full training distribution
        iso_h = IsolationForest(n_estimators=200, max_samples=512, random_state=seed).fit(healthy_tr[cols])
        iso_f = IsolationForest(n_estimators=200, max_samples=512, random_state=seed).fit(
            trv[cols].sample(min(len(trv), 40000), random_state=seed))
        sh = -iso_h.score_samples(healthy_tr[cols].sample(min(len(healthy_tr), 20000), random_state=seed))
        sf = -iso_f.score_samples(trv[cols].sample(min(len(trv), 20000), random_state=seed))
        files = {}
        for name, obj in {"clf": clf, "rul": reg, "iso_healthy": iso_h, "iso_full": iso_f}.items():
            p = md / f"{a}_{name}.joblib"
            joblib.dump(obj, p)
            files[name] = {"file": p.name, "sha256": _sha(p)}
        manifest["assets"][a] = {
            "features": cols, "files": files, "best_iteration": int(clf.best_iteration_ or LGB_PARAMS["n_estimators"]),
            "rul_sigma": rul_sigma, "pos_rate": float(trv[f"y:{a}"].mean()),
            "anomaly_q": [float(np.quantile(sh, 0.5)), float(np.quantile(sh, 0.995))],
            "ood_q": [float(np.quantile(sf, 0.99)), float(sf.max())],
            "ranges": [trv[cols].quantile(0.001).round(6).tolist(), trv[cols].quantile(0.999).round(6).tolist()],
        }
    progress("Saving held-out test set", 0.86)
    df[df.run_id.isin(split["test"])].to_pickle(md / "test_set.pkl")
    manifest["train_seconds"] = round(time.time() - t0, 1)
    (md / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


if __name__ == "__main__":
    m = train_all(lambda s, p: print(f"[{p * 100:5.1f}%] {s}", flush=True))
    print(f"trained in {m['train_seconds']} s")
    from app.ml.evaluate import evaluate
    r = evaluate()
    for a, v in r["assets"].items():
        print(a, {k: v["ml"][k] for k in ("roc_auc", "pr_auc", "detection_rate", "median_lead")})
