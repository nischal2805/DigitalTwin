"""Physics-based digital twin of a hot-strip mill line (1 tick = 1 plant-minute).

Line: F1 reheating furnace -> R1 roughing stand -> R2 finishing-stand gearbox
      -> CB laminar cooling bank -> CL down coiler.
Each asset has a hidden health state h in [0, 1] (0 = healthy, 1 = failed). A fault
raises h over time; sensor readings drift by signature * s(h) with s(h) = h**1.5.
`expected` values are the twin's noise-free healthy prediction for the current
operating point, so residual = reading - expected isolates degradation.
"""
from __future__ import annotations

import copy
import math

import numpy as np

ASSETS: dict[str, dict] = {
    "F1": {"name": "Reheating Furnace", "tags": ["FurnaceTemp", "FuelFlow", "SlabExitTemp"]},
    "R1": {"name": "Roughing Stand", "tags": ["Vibration", "BearingTemp", "RollForce", "MotorCurrent"]},
    "R2": {"name": "Finishing Gearbox", "tags": ["Vibration", "OilTemp", "Torque"]},
    "CB": {"name": "Laminar Cooling Bank", "tags": ["WaterFlow", "PumpPressure", "StripExitTemp"]},
    "CL": {"name": "Down Coiler", "tags": ["Misalignment", "Tension", "MotorCurrent"]},
}
ASSET_IDS = list(ASSETS)
GRADES = ["Mild steel (IS 2062)", "HSLA (API X65)", "High-carbon (C70)"]

# tag -> unit, noise sigma, static alarm limit (direction, value), label
TAGS: dict[str, dict] = {
    "F1.FurnaceTemp": {"unit": "°C", "sigma": 3.0, "limit": ("lo", 1205), "label": "Furnace zone temp"},
    "F1.FuelFlow": {"unit": "Nm³/h", "sigma": 25.0, "limit": ("hi", 2100), "label": "Fuel gas flow"},
    "F1.SlabExitTemp": {"unit": "°C", "sigma": 4.0, "limit": ("lo", 1125), "label": "Slab exit temp"},
    "R1.Vibration": {"unit": "mm/s", "sigma": 0.25, "limit": ("hi", 7.1), "label": "Stand vibration"},
    "R1.BearingTemp": {"unit": "°C", "sigma": 1.0, "limit": ("hi", 88), "label": "Work-roll bearing temp"},
    "R1.RollForce": {"unit": "MN", "sigma": 0.25, "limit": ("hi", 24.5), "label": "Roll separating force"},
    "R1.MotorCurrent": {"unit": "A", "sigma": 20.0, "limit": ("hi", 1450), "label": "Main drive current"},
    "R2.Vibration": {"unit": "mm/s", "sigma": 0.2, "limit": ("hi", 5.6), "label": "Gearbox vibration"},
    "R2.OilTemp": {"unit": "°C", "sigma": 1.0, "limit": ("hi", 78), "label": "Gear oil temp"},
    "R2.Torque": {"unit": "kNm", "sigma": 6.0, "limit": ("hi", 560), "label": "Spindle torque"},
    "CB.WaterFlow": {"unit": "m³/h", "sigma": 15.0, "limit": ("lo", 690), "label": "Header water flow"},
    "CB.PumpPressure": {"unit": "bar", "sigma": 0.08, "limit": ("lo", 4.5), "label": "Pump discharge pressure"},
    "CB.StripExitTemp": {"unit": "°C", "sigma": 4.0, "limit": ("hi", 680), "label": "Coiling temp"},
    "CL.Misalignment": {"unit": "mm", "sigma": 0.04, "limit": ("hi", 1.2), "label": "Mandrel misalignment"},
    "CL.Tension": {"unit": "kN", "sigma": 0.4, "limit": ("lo", 33), "label": "Strip tension"},
    "CL.MotorCurrent": {"unit": "A", "sigma": 8.0, "limit": ("hi", 545), "label": "Coiler drive current"},
}
ALL_TAGS = list(TAGS)
TENSION_OSC_AMP = 6.0  # kN at h=1, period ~7 ticks
TENSION_PERIOD = 7.3

FAULTS: dict[str, dict] = {
    "F1": {"id": "burner_fouling", "name": "Burner fouling / refractory loss",
           "sig": {"FurnaceTemp": -60, "FuelFlow": 450, "SlabExitTemp": -80},
           "action": "planned_maintenance",
           "story": "Fouled burners lose heat transfer: fuel rises to compensate while zone and slab temps sag."},
    "R1": {"id": "bearing_wear", "name": "Work-roll bearing wear",
           "sig": {"Vibration": 6.0, "BearingTemp": 28, "RollForce": 2.0, "MotorCurrent": 150},
           "action": "planned_maintenance",
           "story": "Spalling bearing raises vibration and friction heat; drive current and roll force creep up."},
    "R2": {"id": "lube_loss", "name": "Gearbox lubrication loss",
           "sig": {"Vibration": 5.0, "OilTemp": 30, "Torque": 70},
           "action": "increase_lube",
           "story": "Degraded oil film heats the gearbox and adds mesh vibration and torque ripple."},
    "CB": {"id": "pump_cavitation", "name": "Cooling pump cavitation",
           "sig": {"WaterFlow": -320, "PumpPressure": -2.2, "StripExitTemp": 90},
           "action": "switch_standby_pump",
           "story": "Cavitating impeller drops flow and pressure; strip leaves the table too hot."},
    "CL": {"id": "mandrel_misalignment", "name": "Coiler mandrel misalignment",
           "sig": {"Misalignment": 1.6, "Tension": 0.0, "MotorCurrent": 80},
           "action": "planned_maintenance",
           "story": "Misaligned mandrel makes strip tension oscillate and loads the drive."},
}

ACTIONS: dict[str, dict] = {
    "derate": {"label": "Derate line", "param": "pct", "desc": "Reduce line speed; slows mechanical wear."},
    "planned_maintenance": {"label": "Planned maintenance", "param": None,
                            "desc": "Controlled 30-min stop; asset restored to health."},
    "switch_standby_pump": {"label": "Switch to standby pump", "param": None,
                            "desc": "3-min changeover to the standby cooling pump (CB only)."},
    "increase_lube": {"label": "Boost lubrication", "param": None,
                      "desc": "Raise oil circulation; slows gearbox degradation 75 % (R2 only)."},
    "recalibrate_sensor": {"label": "Recalibrate sensor", "param": None,
                           "desc": "Clear a faulty instrument channel; no downtime."},
    "emergency_stop": {"label": "Emergency stop", "param": None, "desc": "Trip the whole line now."},
    "restart": {"label": "Restart line", "param": None, "desc": "Resume rolling after a stop."},
}
ALLOWED_ACTIONS = {
    "F1": ["derate", "planned_maintenance", "recalibrate_sensor", "emergency_stop"],
    "R1": ["derate", "planned_maintenance", "recalibrate_sensor", "emergency_stop"],
    "R2": ["derate", "increase_lube", "planned_maintenance", "recalibrate_sensor", "emergency_stop"],
    "CB": ["derate", "switch_standby_pump", "planned_maintenance", "recalibrate_sensor", "emergency_stop"],
    "CL": ["derate", "planned_maintenance", "recalibrate_sensor", "emergency_stop"],
}
MAINT_TICKS = 30
PUMP_SWITCH_TICKS = 3
UNPLANNED_REPAIR_MIN = 240


def severity(h: float) -> float:
    return min(max(h, 0.0), 1.0) ** 1.5


def nominal(u: float, g: int, d_slab: float = 0.0) -> dict[str, float]:
    """Noise-free healthy readings at throughput fraction u, grade g.
    d_slab = deviation of actual slab exit temp from nominal (cascades downstream)."""
    return {
        "F1.FurnaceTemp": 1250 - 20 * (u - 0.9),
        "F1.FuelFlow": 1800 * (0.4 + 0.6 * u),
        "F1.SlabExitTemp": 1180 - 30 * (u - 0.9),
        "R1.Vibration": 2.2 + 0.8 * u,
        "R1.BearingTemp": 60 + 8 * u,
        "R1.RollForce": 18 * (0.7 + 0.3 * u) * (1 + 0.15 * g) * (1 - 0.0015 * d_slab),
        "R1.MotorCurrent": 1200 * (0.5 + 0.5 * u) * (1 + 0.1 * g) * (1 - 0.001 * d_slab),
        "R2.Vibration": 1.8 + 0.6 * u,
        "R2.OilTemp": 50 + 6 * u,
        "R2.Torque": 420 * (0.6 + 0.4 * u) * (1 + 0.12 * g),
        "CB.WaterFlow": 900 * (0.7 + 0.3 * u),
        "CB.PumpPressure": 6.0 + 0.3 * (u - 1),
        "CB.StripExitTemp": 620 + 20 * (u - 1) + 0.3 * d_slab,
        "CL.Misalignment": 0.15,
        "CL.Tension": 40 * (0.8 + 0.2 * u),
        "CL.MotorCurrent": 480 * (0.6 + 0.4 * u) * (1 + 0.08 * g),
    }


def readings(u: float, g: int, h: dict[str, float], phase: float = 0.0) -> dict[str, float]:
    """Noise-free readings given asset health states (includes F1 -> R1/CB cascade)."""
    base = nominal(u, g)
    s_f1 = severity(h["F1"])
    d_slab = FAULTS["F1"]["sig"]["SlabExitTemp"] * s_f1
    out = nominal(u, g, d_slab)
    out["F1.SlabExitTemp"] = base["F1.SlabExitTemp"] + d_slab
    for a in ASSET_IDS:
        s = severity(h[a])
        for tag, delta in FAULTS[a]["sig"].items():
            if a == "F1" and tag == "SlabExitTemp":
                continue
            out[f"{a}.{tag}"] += delta * s
    out["CL.Tension"] += TENSION_OSC_AMP * severity(h["CL"]) * math.sin(phase)
    return out


def tension_std(h: float) -> float:
    """Expected rolling std of coiler tension at health h (noise + oscillation)."""
    return math.sqrt(TAGS["CL.Tension"]["sigma"] ** 2 + (TENSION_OSC_AMP * severity(h)) ** 2 / 2)


class Twin:
    def __init__(self, seed: int = 0, grade: int = 0, throughput: float = 1.0):
        self.rng = np.random.default_rng(seed)
        self.t = 0
        self.grade = int(grade)
        self.u_set = float(throughput)
        self.derate = 0.0
        self.h = {a: 0.0 for a in ASSET_IDS}
        self.rate = {a: 0.0 for a in ASSET_IDS}  # base degradation rate per tick (0 = no fault)
        self.rate_mult = {a: 1.0 for a in ASSET_IDS}
        self.failed = {a: False for a in ASSET_IDS}
        self.glitch: dict[str, float] = {}  # tag -> amplitude (sensor fault, not a real fault)
        self.dropout: set[str] = set()  # tags returning NaN
        self.estop = False
        self.stop_until = -1  # planned stop end tick
        self.stop_reason = ""
        self.pending_clear: str | None = None
        self.phase = float(self.rng.uniform(0, 2 * math.pi))
        self.last: dict[str, float] = {}
        self.last_exp: dict[str, float] = {}
        self.produced_t = 0.0

    # ---- state -------------------------------------------------------------
    @property
    def tripped(self) -> bool:
        return any(self.failed.values())

    @property
    def state(self) -> str:
        if self.tripped:
            return "TRIPPED"
        if self.estop:
            return "E-STOP"
        if self.t < self.stop_until:
            return "MAINTENANCE"
        return "RUNNING"

    @property
    def u_eff(self) -> float:
        return self.u_set * (1 - self.derate) if self.state == "RUNNING" else 0.0

    def fork(self, seed: int) -> "Twin":
        tw = copy.deepcopy(self)
        tw.rng = np.random.default_rng(seed)
        return tw

    # ---- controls ------------------------------------------------------------
    def inject_fault(self, asset: str, rate: float) -> None:
        self.rate[asset] = rate

    def inject_glitch(self, tag: str, amp: float) -> None:
        self.glitch[tag] = amp

    def set_control(self, throughput=None, grade=None, derate=None) -> None:
        if throughput is not None:
            self.u_set = float(np.clip(throughput, 0.5, 1.15))
        if grade is not None:
            self.grade = int(np.clip(grade, 0, 2))
        if derate is not None:
            self.derate = float(np.clip(derate, 0.0, 0.6))

    def apply_action(self, action: str, asset: str | None = None, params: dict | None = None) -> str:
        params = params or {}
        if action == "derate":
            pct = float(params.get("pct", 30))
            self.derate = float(np.clip(pct / 100, 0, 0.6))
            return f"Line derated to {100 - pct:.0f} % speed"
        if action == "planned_maintenance" and asset:
            self.stop_until = self.t + MAINT_TICKS
            self.stop_reason = f"Planned maintenance on {asset}"
            self.pending_clear = asset
            return f"{MAINT_TICKS}-min planned maintenance started on {asset}"
        if action == "switch_standby_pump":
            self.stop_until = self.t + PUMP_SWITCH_TICKS
            self.stop_reason = "Standby pump changeover"
            self.pending_clear = "CB"
            return "Switching to standby cooling pump"
        if action == "increase_lube":
            self.rate_mult["R2"] = 0.25
            return "Gearbox lube circulation boosted"
        if action == "recalibrate_sensor" and asset:
            for tag in [t for t in list(self.glitch) + list(self.dropout) if t.startswith(asset + ".")]:
                self.glitch.pop(tag, None)
                self.dropout.discard(tag)
            return f"{asset} instrument channels recalibrated"
        if action == "emergency_stop":
            self.estop = True
            return "EMERGENCY STOP — line tripped"
        if action == "restart":
            if self.tripped:
                return "Cannot restart: failed asset needs repair (reset)"
            self.estop = False
            self.stop_until = -1
            return "Line restarted"
        return f"Unknown action {action}"

    # ---- simulation ----------------------------------------------------------
    def step(self) -> dict[str, float]:
        """Advance one tick; returns tag readings (also stored in .last / .last_exp)."""
        self.t += 1
        if self.pending_clear and self.t >= self.stop_until:
            a = self.pending_clear
            self.h[a], self.rate[a], self.rate_mult[a] = 0.0, 0.0, 1.0
            self.pending_clear = None
            self.stop_reason = ""
        u = self.u_eff
        running = u > 0
        for a in ASSET_IDS:
            if self.rate[a] > 0 and not self.failed[a]:
                load = (0.3 + 0.7 * u) if running else (0.5 if a == "F1" else 0.05)
                self.h[a] = min(1.0, self.h[a] + self.rate[a] * (1 + 1.5 * self.h[a]) * load * self.rate_mult[a])
                if self.h[a] >= 1.0:
                    self.failed[a] = True
        self.phase += 2 * math.pi / TENSION_PERIOD
        exp = nominal(u, self.grade)
        true = readings(u, self.grade, self.h, self.phase)
        out = {}
        for tag, meta in TAGS.items():
            v = true[tag] + self.rng.normal(0, meta["sigma"])
            amp = self.glitch.get(tag)
            if amp:
                v += self.rng.uniform(-1, 1) * amp if self.rng.random() < 0.4 else self.rng.normal(0, amp * 0.25)
            if tag in self.dropout:
                v = float("nan")
            out[tag] = float(v)
        self.last, self.last_exp = out, exp
        if running:
            self.produced_t += 600 * u / 60  # 600 t/h nominal
        return out

    def frame(self) -> dict:
        assets = {}
        for a, meta in ASSETS.items():
            assets[a] = {
                "name": meta["name"],
                "health": round(1 - self.h[a], 4),
                "failed": self.failed[a],
                "tags": {
                    t: {"v": _r(self.last.get(f"{a}.{t}")), "exp": _r(self.last_exp.get(f"{a}.{t}")),
                        "unit": TAGS[f"{a}.{t}"]["unit"], "label": TAGS[f"{a}.{t}"]["label"],
                        "glitch": f"{a}.{t}" in self.glitch, "dropout": f"{a}.{t}" in self.dropout}
                    for t in meta["tags"]
                },
            }
        return {"t": self.t, "state": self.state, "stop_reason": self.stop_reason,
                "u": round(self.u_eff, 4), "u_set": self.u_set, "derate": self.derate,
                "grade": self.grade, "grade_name": GRADES[self.grade],
                "produced_t": round(self.produced_t, 1), "assets": assets}


def _r(v):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else round(v, 3)
