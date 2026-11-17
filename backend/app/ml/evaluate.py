"""Held-out evaluation -> reports/results.json, reports/explain_global.json, reports/*.png

python -m app.ml.evaluate   (from backend/)
"""
from __future__ import annotations

import json

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import shap  # noqa: E402
from sklearn.metrics import (average_precision_score, brier_score_loss, confusion_matrix,  # noqa: E402
                             f1_score, precision_recall_curve, precision_score, recall_score, roc_auc_score)

from app import config  # noqa: E402
from app.ml.features import feature_label  # noqa: E402
from app.twin.physics import ASSETS, ASSET_IDS, TAGS  # noqa: E402

T_A = 0.5
COLORS = {"F1": "#c2410c", "R1": "#2563a8", "R2": "#6d4fc2", "CB": "#0f7f75", "CL": "#a8336b"}
plt.rcParams.update({"figure.facecolor": "#ffffff", "axes.facecolor": "#ffffff", "savefig.facecolor": "#ffffff",
                     "text.color": "#111827", "axes.labelcolor": "#4b5563", "xtick.color": "#6b7280",
                     "ytick.color": "#6b7280", "axes.edgecolor": "#d0d5dd", "axes.spines.top": False,
                     "axes.spines.right": False, "font.size": 10, "font.family": ["Segoe UI", "DejaVu Sans"]})


def alarm_onsets(flags: np.ndarray, k: int = 3) -> list[int]:
    """Indices where `flags` has just been true for k consecutive ticks (rising edges)."""
    out, cnt = [], 0
    for i, f in enumerate(flags):
        cnt = cnt + 1 if f else 0
        if cnt == k:
            out.append(i)
    return out


def static_flags(g: pd.DataFrame, asset: str) -> np.ndarray:
    flags = np.zeros(len(g), bool)
    for tag in ASSETS[asset]["tags"]:
        d, lim = TAGS[f"{asset}.{tag}"]["limit"]
        x = g[f"{asset}.{tag}"].to_numpy()
        flags |= (x > lim) if d == "hi" else (x < lim)
    return flags


def event_metrics(test: pd.DataFrame, asset: str, flag_col: str) -> dict:
    leads, detected, n_fail, false_alarms, healthy_ticks = [], 0, 0, 0, 0
    for _, g in test.groupby("run_id", sort=False):
        flags = g[flag_col].to_numpy()
        t = g["t"].to_numpy()
        healthy = g[f"h:{asset}"].to_numpy() == 0
        onsets = alarm_onsets(flags)
        healthy_ticks += int(healthy.sum())
        false_alarms += sum(1 for i in onsets if healthy[i])
        if g["failed_asset"].iloc[0] == asset:
            n_fail += 1
            fs, ft = int(g["fault_start"].iloc[0]), int(t[-1])
            hits = [t[i] for i in onsets if fs <= t[i] < ft]
            if hits:
                detected += 1
                leads.append(ft - hits[0])
    lq = np.percentile(leads, [25, 50, 75]).tolist() if leads else [None] * 3
    return {"failures": n_fail, "detected": detected, "detection_rate": detected / n_fail if n_fail else None,
            "median_lead": lq[1], "lead_iqr": [lq[0], lq[2]], "leads": [int(x) for x in leads],
            "false_alarms_per_1000": 1000 * false_alarms / max(healthy_ticks, 1), "false_alarms": false_alarms}


def _shap_pos(sv) -> np.ndarray:
    if isinstance(sv, list):
        sv = sv[1] if len(sv) == 2 else sv[0]
    sv = np.asarray(sv)
    return sv[..., 1] if sv.ndim == 3 else sv


def evaluate() -> dict:
    md, rd = config.MODELS_DIR, config.REPORTS_DIR
    manifest = json.loads((md / "manifest.json").read_text())
    test = pd.read_pickle(md / "test_set.pkl")
    results = {"model_card": {k: manifest[k] for k in ("created", "seed", "n_runs", "rows", "data_hash", "split",
                                                       "horizon", "rul_cap", "train_seconds")},
               "threshold": T_A, "test_runs": int(test.run_id.nunique()), "assets": {}}
    explain, pr_data, cms = {}, {}, {}
    rng = np.random.default_rng(config.SEED)
    for a in ASSET_IDS:
        m = manifest["assets"][a]
        clf = joblib.load(md / m["files"]["clf"]["file"])
        reg = joblib.load(md / m["files"]["rul"]["file"])
        cols = m["features"]
        test[f"p:{a}"] = clf.predict_proba(test[cols])[:, 1]
        test[f"ml_flag:{a}"] = test[f"p:{a}"] >= T_A
        test[f"st_flag:{a}"] = np.concatenate([static_flags(g, a) for _, g in test.groupby("run_id", sort=False)])
        v = test[test[f"valid:{a}"]]
        y, p = v[f"y:{a}"].to_numpy(), v[f"p:{a}"].to_numpy()
        yhat = (p >= T_A).astype(int)
        rul_pred = reg.predict(v[cols])
        near = v[f"rul:{a}"] < 120
        ml = {"roc_auc": float(roc_auc_score(y, p)), "pr_auc": float(average_precision_score(y, p)),
              "precision": float(precision_score(y, yhat, zero_division=0)),
              "recall": float(recall_score(y, yhat, zero_division=0)), "f1": float(f1_score(y, yhat, zero_division=0)),
              "brier": float(brier_score_loss(y, p)), "positives": int(y.sum()), "rows": int(len(y)),
              "rul_mae": float(np.mean(np.abs(rul_pred - v[f"rul:{a}"]))),
              "rul_mae_near": float(np.mean(np.abs(rul_pred[near] - v[f"rul:{a}"][near]))) if near.any() else None,
              "rul_band_80": 1.28 * m["rul_sigma"]}
        ml.update(event_metrics(test, a, f"ml_flag:{a}"))
        st_y = v[f"st_flag:{a}"].astype(int).to_numpy()
        static = {"precision": float(precision_score(y, st_y, zero_division=0)),
                  "recall": float(recall_score(y, st_y, zero_division=0)), "f1": float(f1_score(y, st_y, zero_division=0))}
        static.update(event_metrics(test, a, f"st_flag:{a}"))
        results["assets"][a] = {"name": ASSETS[a]["name"], "ml": ml, "static": static,
                                "limits": {t: TAGS[f"{a}.{t}"]["limit"] for t in ASSETS[a]["tags"]}}
        pr_data[a] = precision_recall_curve(y, p)
        cms[a] = confusion_matrix(y, yhat, labels=[0, 1])
        # ---- global SHAP on a balanced test sample
        fault = v[v[f"h:{a}"] > 0]
        clean = v[v[f"h:{a}"] == 0]
        n = min(1000, len(fault))
        samp = pd.concat([fault.sample(n, random_state=1), clean.sample(2000 - n, random_state=1)])
        sv = _shap_pos(shap.TreeExplainer(clf).shap_values(samp[cols]))
        mean_abs = np.abs(sv).mean(0)
        order = np.argsort(-mean_abs)
        top = order[:10]
        idx = rng.choice(len(samp), size=min(200, len(samp)), replace=False)
        bees = []
        for j in top:
            x = samp[cols[j]].to_numpy()
            rank = pd.Series(x).rank(pct=True).to_numpy()
            bees.append({"feature": cols[j], "label": feature_label(cols[j]),
                         "points": [[round(float(sv[i, j]), 4), round(float(rank[i]), 3)] for i in idx]})
        explain[a] = {"bars": [{"feature": cols[j], "label": feature_label(cols[j]), "mean_abs": float(mean_abs[j])}
                               for j in order[:15]],
                      "beeswarm": bees, "n_rows": int(len(samp)), "n_points": int(len(idx) * len(top))}
    (rd / "results.json").write_text(json.dumps(results, indent=2))
    (rd / "explain_global.json").write_text(json.dumps(explain))
    _figures(results, pr_data, cms, explain)
    return results


def _figures(results, pr_data, cms, explain):
    rd = config.REPORTS_DIR
    fig, axes = plt.subplots(1, 5, figsize=(16, 3.4))
    for ax, a in zip(axes, ASSET_IDS):
        cm = cms[a]
        ax.imshow(cm, cmap="Blues")
        for (i, j), val in np.ndenumerate(cm):
            ax.text(j, i, f"{val}", ha="center", va="center", color="#111827" if val < cm.max() / 2 else "#ffffff")
        ax.set_xticks([0, 1], ["pred OK", "pred fail"])
        ax.set_yticks([0, 1], ["OK", f"fail≤{60}"])
        ax.set_title(f"{a} · {ASSETS[a]['name']}", color=COLORS[a], fontsize=10)
    fig.suptitle(f"Confusion matrices (held-out runs, threshold {T_A})")
    fig.tight_layout()
    fig.savefig(rd / "confusion_matrix.png", dpi=110)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(7, 4.6))
    for a in ASSET_IDS:
        pr, rc, _ = pr_data[a]
        ax.plot(rc, pr, color=COLORS[a], lw=2, label=f"{a}  AP={results['assets'][a]['ml']['pr_auc']:.3f}")
    ax.set_xlabel("Recall")
    ax.set_ylabel("Precision")
    ax.set_title("Precision–recall (fails within 60 min)")
    ax.legend(frameon=False)
    ax.grid(alpha=0.15)
    fig.tight_layout()
    fig.savefig(rd / "pr_curve.png", dpi=110)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(7, 4.6))
    ml = sum((results["assets"][a]["ml"]["leads"] for a in ASSET_IDS), [])
    st = sum((results["assets"][a]["static"]["leads"] for a in ASSET_IDS), [])
    bins = np.arange(0, 130, 6)
    ax.hist(ml, bins=bins, color="#3f5bd8", alpha=0.85, label=f"LightGBM (n={len(ml)})")
    ax.hist(st, bins=bins, color="#9ca3af", alpha=0.7, label=f"Static limits (n={len(st)})")
    ax.set_xlabel("Lead time before failure (min)")
    ax.set_ylabel("Failures")
    ax.set_title("Warning lead time — held-out failures")
    ax.legend(frameon=False)
    ax.grid(alpha=0.15)
    fig.tight_layout()
    fig.savefig(rd / "lead_time_hist.png", dpi=110)
    plt.close(fig)

    fig, axes = plt.subplots(1, 5, figsize=(18, 4.2))
    for ax, a in zip(axes, ASSET_IDS):
        bars = explain[a]["bars"][:8][::-1]
        ax.barh([b["label"].replace(" — ", "\n") for b in bars], [b["mean_abs"] for b in bars], color=COLORS[a])
        ax.set_title(a, color=COLORS[a])
        ax.tick_params(axis="y", labelsize=7)
    fig.suptitle("Global SHAP importance (mean |SHAP|, log-odds)")
    fig.tight_layout()
    fig.savefig(rd / "global_shap.png", dpi=110)
    plt.close(fig)


if __name__ == "__main__":
    r = evaluate()
    for a, v in r["assets"].items():
        print(a, f"ROC-AUC={v['ml']['roc_auc']:.3f} PR-AUC={v['ml']['pr_auc']:.3f} det={v['ml']['detection_rate']} "
                 f"lead={v['ml']['median_lead']} | static det={v['static']['detection_rate']} lead={v['static']['median_lead']}")
