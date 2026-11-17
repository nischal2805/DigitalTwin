"""Level-2 fallback: deterministic Health Engine (always available, no learned weights)."""
from __future__ import annotations

import math
from collections import deque

import numpy as np

from app.twin.physics import ASSETS, ASSET_IDS, TAGS, nominal, readings, tension_std

WEIGHTS = {
    "F1": {"FurnaceTemp": .40, "FuelFlow": .35, "SlabExitTemp": .25},
    "R1": {"Vibration": .40, "BearingTemp": .30, "RollForce": .15, "MotorCurrent": .15},
    "R2": {"Vibration": .35, "OilTemp": .35, "Torque": .30},
    "CB": {"WaterFlow": .35, "PumpPressure": .30, "StripExitTemp": .35},
    "CL": {"Misalignment": .50, "TensionStd": .25, "MotorCurrent": .25},
}
ALPHA = 0.3
CAP = 120


def _signed_ranges() -> dict[str, float]:
    """R_i = value(h=1) - value(h=0) at nominal conditions (sign kept so drops count)."""
    h0 = {a: 0.0 for a in ASSET_IDS}
    base = readings(1.0, 0, h0)
    out = {}
    for a in ASSET_IDS:
        h1 = dict(h0, **{a: 1.0})
        failed = readings(1.0, 0, h1)
        for tag in WEIGHTS[a]:
            key = f"{a}.{tag}"
            out[key] = (tension_std(1.0) - tension_std(0.0)) if tag == "TensionStd" else failed[key] - base[key]
    return out


RANGES = _signed_ranges()


def sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))


class HealthEngine:
    def __init__(self):
        self.ema = {k: 0.0 for k in RANGES}
        self.tension = deque(maxlen=10)
        self.d_hist = {a: deque(maxlen=15) for a in ASSET_IDS}

    def update(self, vals: dict[str, float], exp: dict[str, float]) -> dict[str, dict]:
        r_t = vals["CL.Tension"] - exp["CL.Tension"]
        if not math.isnan(r_t):
            self.tension.append(r_t)
        for key in RANGES:
            if key == "CL.TensionStd":
                resid = (float(np.std(self.tension, ddof=1)) if len(self.tension) > 2 else TAGS["CL.Tension"]["sigma"]) \
                        - TAGS["CL.Tension"]["sigma"]
            else:
                resid = vals[key] - exp[key]
            if not math.isnan(resid):  # dropout: hold last EMA
                self.ema[key] = ALPHA * resid + (1 - ALPHA) * self.ema[key]
        return {a: self._asset(a) for a in ASSET_IDS}

    def _asset(self, a: str) -> dict:
        z = {t: min(max(self.ema[f"{a}.{t}"] / RANGES[f"{a}.{t}"], 0.0), 1.2) for t in WEIGHTS[a]}
        wz = {t: WEIGHTS[a][t] * z[t] for t in z}
        d = sum(wz.values())
        tot = d or 1.0
        hist = self.d_hist[a]
        hist.append(d)
        ttf = float(CAP)
        if len(hist) >= 5:
            slope = float(np.polyfit(np.arange(len(hist)), np.array(hist), 1)[0])
            if slope > 1e-4:
                ttf = float(min(CAP, max(0.0, (1 - d) / slope)))
        if d >= 1:
            ttf = 0.0
        contribs = [{"tag": f"{a}.{t}" if t != "TensionStd" else "CL.Tension",
                     "label": "Tension oscillation (10-min std)" if t == "TensionStd" else TAGS[f"{a}.{t}"]["label"],
                     "share_pct": round(100 * wz[t] / tot, 1) if d > 0 else round(100 * WEIGHTS[a][t], 1),
                     "z": round(z[t], 3), "weight": WEIGHTS[a][t]} for t in z]
        contribs.sort(key=lambda c: -c["share_pct"])
        return {"p": sigmoid(10 * (d - 0.4)), "anomaly": min(max(z.values()), 1.0), "D": d,
                "ttf": ttf, "ttf_lo": ttf * 0.75, "ttf_hi": min(CAP, ttf * 1.25), "contributions": contribs}


def steady_state(asset: str, h: float, u: float = 1.0, g: int = 0) -> dict:
    """Engine output for a noise-free asset held at health h (used by unit tests and docs)."""
    eng = HealthEngine()
    hs = {a: 0.0 for a in ASSET_IDS}
    hs[asset] = h
    exp = nominal(u, g)
    out = None
    for k in range(60):
        vals = readings(u, g, hs, phase=k * 2 * math.pi / 7.3)
        out = eng.update(vals, exp)
    return out[asset]
