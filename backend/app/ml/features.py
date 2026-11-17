"""Streaming-safe features (past data only). Same function serves training and live inference."""
from __future__ import annotations

import numpy as np
import pandas as pd

from app.twin.physics import ALL_TAGS, ASSETS, ASSET_IDS, TAGS

KINDS = {"raw": "value", "resid": "twin residual", "mean10": "residual · 10-min mean",
         "std10": "residual · 10-min std", "slope20": "residual · 20-min slope"}
CONTEXT = {"grade": "Steel grade", "throughput": "Line throughput", "slab_resid": "Upstream slab-temp residual"}


def asset_features(asset: str) -> list[str]:
    cols = [f"{asset}.{t}|{k}" for t in ASSETS[asset]["tags"] for k in KINDS]
    return cols + list(CONTEXT)


FEATURES = {a: asset_features(a) for a in ASSET_IDS}


def feature_label(col: str) -> str:
    if col in CONTEXT:
        return CONTEXT[col]
    tag, kind = col.split("|")
    return f"{TAGS[tag]['label']} — {KINDS[kind]}"


def feature_tag(col: str) -> str | None:
    return col.split("|")[0] if "|" in col else None


def make_features(df: pd.DataFrame) -> pd.DataFrame:
    """df: one contiguous run, columns = tags, 'exp:'+tag, 'grade', 'u'. Returns all features."""
    out: dict[str, pd.Series] = {}
    n = len(df)
    t = pd.Series(np.arange(n, dtype=float), index=df.index)
    mt = t.rolling(20, min_periods=2).mean()
    vt = (t * t).rolling(20, min_periods=2).mean() - mt * mt
    for tag in ALL_TAGS:
        x = df[tag]
        r = x - df["exp:" + tag]
        out[f"{tag}|raw"] = x
        out[f"{tag}|resid"] = r
        out[f"{tag}|mean10"] = r.rolling(10, min_periods=1).mean()
        out[f"{tag}|std10"] = r.rolling(10, min_periods=2).std().fillna(0.0)
        mr = r.rolling(20, min_periods=2).mean()
        cov = (t * r).rolling(20, min_periods=2).mean() - mt * mr
        out[f"{tag}|slope20"] = (cov / vt).replace([np.inf, -np.inf], np.nan).fillna(0.0)
    out["grade"] = df["grade"].astype(float)
    out["throughput"] = df["u"].astype(float)
    out["slab_resid"] = df["F1.SlabExitTemp"] - df["exp:F1.SlabExitTemp"]
    return pd.DataFrame(out, index=df.index)
