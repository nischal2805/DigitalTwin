"""Level-1 live inference: LightGBM risk + RUL, IsolationForest anomaly, per-tick SHAP via pred_contrib."""
from __future__ import annotations

import hashlib
import json
import time

import joblib
import numpy as np
import pandas as pd

from app import config
from app.ml.features import FEATURES, feature_label, feature_tag
from app.twin.physics import ASSET_IDS


def iso_anomaly_score(iso, x: np.ndarray) -> np.ndarray:
    """Same value as -IsolationForest.score_samples(x), without per-tree Python validation overhead (~20x faster)."""
    from sklearn.ensemble._iforest import _average_path_length
    x = np.ascontiguousarray(x, dtype=np.float32)
    depths = np.zeros(len(x))
    for tree, feats, dpl, apl in zip(iso.estimators_, iso.estimators_features_,
                                     iso._decision_path_lengths, iso._average_path_length_per_tree):
        leaves = tree.tree_.apply(np.ascontiguousarray(x[:, feats]))
        depths += dpl[leaves] + apl[leaves] - 1.0
    return 2 ** (-depths / (len(iso.estimators_) * _average_path_length([iso.max_samples_])[0]))


class ModelUnavailable(RuntimeError):
    pass


class MLRuntime:
    def __init__(self, models_dir=None):
        self.dir = models_dir or config.MODELS_DIR
        self.models: dict | None = None
        self.manifest: dict | None = None
        self.outage_until = -1  # simulated outage (tick index)
        self.last_error = ""
        self.last_latency_ms = 0.0
        self.try_load()

    def files_present(self) -> bool:
        mf = self.dir / "manifest.json"
        if not mf.exists():
            return False
        if self.manifest is None:
            return True
        return all((self.dir / f["file"]).exists() for m in self.manifest["assets"].values() for f in m["files"].values())

    def try_load(self) -> bool:
        try:
            manifest = json.loads((self.dir / "manifest.json").read_text())
            models = {}
            for a in ASSET_IDS:
                m = manifest["assets"][a]
                models[a] = {}
                for name, f in m["files"].items():
                    p = self.dir / f["file"]
                    if hashlib.sha256(p.read_bytes()).hexdigest() != f["sha256"]:
                        raise ModelUnavailable(f"{p.name} is corrupt (hash mismatch)")
                    models[a][name] = joblib.load(p)
            self.manifest, self.models = manifest, models
            self.last_error = ""
            return True
        except Exception as e:  # noqa: BLE001 — any load problem means Level 1 is unavailable
            self.models = None
            self.last_error = f"load failed: {e}"
            return False

    @property
    def ready(self) -> bool:
        return self.models is not None

    def predict(self, feats: pd.DataFrame, t: int) -> dict[str, dict]:
        """feats: rows of features (all assets' columns); the last row is scored. Raises on any problem."""
        if t < self.outage_until:
            raise ModelUnavailable("simulated model outage")
        if not self.files_present():
            self.models = None
            raise ModelUnavailable("model files missing")
        if self.models is None and not self.try_load():
            raise ModelUnavailable(self.last_error)
        t0 = time.perf_counter()
        out = {}
        for a in ASSET_IDS:
            m, info = self.models[a], self.manifest["assets"][a]
            x = feats[FEATURES[a]].iloc[[-1]]
            xn = x.to_numpy(dtype=float)
            if not np.isfinite(xn).all():
                raise ModelUnavailable(f"NaN/missing features for {a} (sensor dropout)")
            p = float(m["clf"].booster_.predict(xn)[0])
            rul = float(np.clip(m["rul"].booster_.predict(xn)[0], 0, 120))
            band = 1.28 * info["rul_sigma"]
            q50, q995 = info["anomaly_q"]
            s_h = float(iso_anomaly_score(m["iso_healthy"], xn)[0])
            anomaly = float(np.clip((s_h - q50) / (q995 - q50), 0, 1))
            q99, qmax = info["ood_q"]
            s_f = float(iso_anomaly_score(m["iso_full"], xn)[0])
            ood_if = float(np.clip((s_f - q99) / (qmax - q99), 0, 1))
            # coverage: how far any feature sits outside the training 0.1-99.9 % range (catches lone-tag glitches)
            lo, hi = np.asarray(info["ranges"][0]), np.asarray(info["ranges"][1])
            span = np.maximum(hi - lo, 1e-6)
            excess = float(np.max(np.maximum(lo - xn[0], xn[0] - hi) / span))
            ood = max(ood_if, float(np.clip(excess / 0.5, 0, 1)))
            contrib = m["clf"].booster_.predict(xn, pred_contrib=True)[0]
            out[a] = {"p": p, "ttf": rul, "ttf_lo": max(0.0, rul - band), "ttf_hi": min(120.0, rul + band),
                      "anomaly": anomaly, "ood": ood, "base_value": float(contrib[-1]),
                      "contributions": self._top(contrib[:-1], x.iloc[0], feats, a)}
        self.last_latency_ms = (time.perf_counter() - t0) * 1000
        return out

    @staticmethod
    def _top(contrib, row, feats, a, k=6):
        cols = FEATURES[a]
        idx = np.argsort(-np.abs(contrib))[:k]
        tot = float(np.abs(contrib).sum()) or 1.0
        items = []
        for j in idx:
            col = cols[j]
            tag = feature_tag(col)
            exp = None
            if tag and (col.endswith("|raw") or col.endswith("|resid")):
                exp = float(feats["__exp:" + tag].iloc[-1]) if "__exp:" + tag in feats else None
            items.append({"feature": col, "label": feature_label(col), "tag": tag, "shap": round(float(contrib[j]), 4),
                          "share_pct": round(100 * abs(float(contrib[j])) / tot, 1),
                          "value": round(float(row[col]), 3), "expected": None if exp is None else round(exp, 3)})
        return items

    def predict_batch(self, feats: pd.DataFrame, asset: str) -> np.ndarray:
        """Risk for every row (what-if curves)."""
        if self.models is None:
            raise ModelUnavailable("models not loaded")
        x = feats[FEATURES[asset]].fillna(0.0)
        return self.models[asset]["clf"].predict_proba(x)[:, 1]
