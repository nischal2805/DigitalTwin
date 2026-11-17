"""Synthetic run generation from the twin (400 runs x <=400 ticks by default)."""
from __future__ import annotations

import hashlib

import numpy as np
import pandas as pd
from joblib import Parallel, delayed

from app.twin.physics import ALL_TAGS, ASSET_IDS, Twin

MAX_TICKS = 400
H = 60      # failure horizon for the classifier label
RUL_CAP = 120


def gen_run(run_id: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    tw = Twin(seed=seed + 7, grade=int(rng.integers(0, 3)), throughput=float(rng.uniform(0.7, 1.05)))
    fault_asset = rng.choice(ASSET_IDS + ["none"], p=[0.16] * 5 + [0.2])
    fault_start = int(rng.integers(10, 250))
    rate = float(rng.uniform(1 / 400, 1 / 120))
    derate_at = int(rng.integers(30, 380)) if rng.random() < 0.15 else -1
    rows = []
    for t in range(MAX_TICKS):
        if t == fault_start and fault_asset != "none":
            tw.inject_fault(str(fault_asset), rate)
        if rng.random() < 0.01:
            tw.set_control(throughput=float(rng.uniform(0.7, 1.08)))
        if rng.random() < 0.003:
            tw.set_control(grade=int(rng.integers(0, 3)))
        if t == derate_at:
            tw.set_control(derate=float(rng.uniform(0.1, 0.4)))
        vals = tw.step()
        row = {"run_id": run_id, "t": t, "grade": tw.grade, "u": tw.u_eff,
               "fault_asset": str(fault_asset), "fault_start": fault_start}
        row.update(vals)
        row.update({"exp:" + k: v for k, v in tw.last_exp.items()})
        row.update({"h:" + a: tw.h[a] for a in ASSET_IDS})
        rows.append(row)
        if tw.tripped:
            break
    df = pd.DataFrame(rows)
    n = len(df)
    failed = tw.tripped
    for a in ASSET_IDS:
        if failed and fault_asset == a:
            ttf = (n - 1) - df["t"].to_numpy()
            df[f"y:{a}"] = (ttf <= H).astype(int)
            df[f"rul:{a}"] = np.minimum(ttf, RUL_CAP)
            df[f"valid:{a}"] = True
        else:
            df[f"y:{a}"] = 0
            df[f"rul:{a}"] = RUL_CAP
            # censored active fault: labels unknown near the end of the run
            df[f"valid:{a}"] = ~((fault_asset == a) & (df["t"] > (n - 1 - RUL_CAP)))
    df["failed_asset"] = str(fault_asset) if failed else "none"
    return df


def generate(n_runs: int, seed: int, progress=None) -> pd.DataFrame:
    seeds = np.random.default_rng(seed).integers(0, 2**31 - 1, size=n_runs)
    chunks, out = 40, []
    for i in range(0, n_runs, chunks):
        out += Parallel(n_jobs=-1)(delayed(gen_run)(r, int(seeds[r])) for r in range(i, min(i + chunks, n_runs)))
        if progress:
            progress(min(i + chunks, n_runs) / n_runs)
    return pd.concat(out, ignore_index=True)


def split_runs(n_runs: int, seed: int) -> dict[str, np.ndarray]:
    perm = np.random.default_rng(seed + 1).permutation(n_runs)
    a, b = int(0.7 * n_runs), int(0.85 * n_runs)
    return {"train": np.sort(perm[:a]), "val": np.sort(perm[a:b]), "test": np.sort(perm[b:])}


def data_hash(df: pd.DataFrame) -> str:
    return hashlib.sha256(pd.util.hash_pandas_object(df[["run_id", "t"] + ALL_TAGS], index=False).values.tobytes()).hexdigest()[:16]
