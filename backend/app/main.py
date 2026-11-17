"""FastAPI app: WS /ws/stream + REST /api. Serves the web UI from ../web.

uvicorn app.main:app --port 8000   (from backend/)
"""
from __future__ import annotations

import asyncio
import json
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app import config
from app.live import LEVELS, Live
from app.twin import physics
from app.twin.scenarios import SCENARIOS

live: Live | None = None


def _train_in_background():
    def progress(stage, pct):
        live.progress.update(stage=stage, pct=round(pct, 3), ready=False)

    try:
        from app.ml.evaluate import evaluate
        from app.ml.train import train_all
        train_all(progress)
        progress("Evaluating on held-out runs + global SHAP", 0.9)
        evaluate()
        live.ml.try_load()
        live.progress.update(stage="Models ready", pct=1.0, ready=live.ml.ready)
        live._log("AI", "Models trained and loaded", payload={"stage": "ready"}, level="1", toast="recover")
    except Exception as e:  # noqa: BLE001 — dashboard keeps running on the Health Engine
        live.progress.update(stage=f"Training failed: {e} — running on Health Engine", pct=1.0, ready=True, error=True)


@asynccontextmanager
async def lifespan(_app):
    global live
    live = Live()
    if not live.ml.ready:
        threading.Thread(target=_train_in_background, daemon=True).start()
    task = asyncio.create_task(live.run())
    yield
    task.cancel()


app = FastAPI(title="Sahayak — Steel Mill Digital Twin", lifespan=lifespan)


@app.middleware("http")
async def revalidate_ui(request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/app"):
        resp.headers["Cache-Control"] = "no-cache"  # ETag revalidation: UI edits show up on reload
    return resp


def _bad(e: Exception):
    raise HTTPException(400, str(e))


# ---------------------------------------------------------------- stream
@app.websocket("/ws/stream")
async def ws_stream(ws: WebSocket):
    await ws.accept()
    await ws.send_text(json.dumps(live.hello()))
    if live.last:
        await ws.send_text(json.dumps(live.last, default=str))
    live.clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # client pings; nothing else expected
    except WebSocketDisconnect:
        pass
    finally:
        live.clients.discard(ws)


# ---------------------------------------------------------------- twin control
@app.post("/api/inject")
async def inject(body: dict):
    try:
        return {"ok": True, "injected": live.inject(body)}
    except (KeyError, ValueError) as e:
        _bad(e)


@app.post("/api/control")
async def control(body: dict):
    live.twin.set_control(body.get("throughput"), body.get("grade"),
                          (body["derate"] / 100) if body.get("derate") is not None else None)
    live._log("HUMAN", "Operating point changed", payload=body)
    return {"ok": True}


@app.post("/api/action")
async def action(body: dict):
    try:
        return {"ok": True, "result": live.do_action(body["action"], body.get("asset"), body.get("params"))}
    except (KeyError, ValueError) as e:
        _bad(e)


@app.post("/api/reset")
async def reset():
    live.reset()
    return {"ok": True}


@app.post("/api/speed")
async def speed(body: dict):
    live.speed = int(min(max(int(body.get("speed", 1)), 1), 10))
    return {"ok": True, "speed": live.speed}


@app.post("/api/whatif")
async def whatif(body: dict):
    try:
        return live.whatif(body)
    except Exception as e:  # noqa: BLE001
        _bad(e)


@app.post("/api/council")
async def council(body: dict):
    try:
        return await live.council(body)
    except (KeyError, ValueError) as e:
        _bad(e)


@app.post("/api/decision")
async def decision(body: dict):
    try:
        return live.decide(body)
    except (KeyError, ValueError) as e:
        _bad(e)


@app.post("/api/admin/fallback")
async def admin_fallback(body: dict):
    level = body.get("level", "auto")
    level = {"1": "auto", "2": "engine", "3": "llm", 1: "auto", 2: "engine", 3: "llm"}.get(level, level)
    if level == "outage":
        live.outage(int(body.get("ticks", 30)))
        return {"ok": True, "outage": True}
    if level not in ("auto", "engine", "llm"):
        _bad(ValueError("level must be auto | engine | llm | outage"))
    live.set_mode(level)
    return {"ok": True, "mode": level}


# ---------------------------------------------------------------- reports & spec
def _json_file(p):
    if not p.exists():
        return JSONResponse({"available": False}, status_code=404)
    return JSONResponse({"available": True, **json.loads(p.read_text())})


@app.get("/api/explain/global")
async def explain_global():
    p = config.REPORTS_DIR / "explain_global.json"
    if not p.exists():
        return JSONResponse({"available": False}, status_code=404)
    return {"available": True, "assets": json.loads(p.read_text())}


@app.get("/api/report")
async def report():
    p = config.REPORTS_DIR / "results.json"
    if not p.exists():
        return JSONResponse({"available": False}, status_code=404)
    figs = [f.name for f in sorted(config.REPORTS_DIR.glob("*.png"))]
    return {"available": True, "results": json.loads(p.read_text()), "figures": [f"/reports/{f}" for f in figs]}


@app.get("/api/audit")
async def audit(actor: str | None = None, asset: str | None = None, q: str | None = None, limit: int = 500):
    return live.audit.query(actor, asset, q, limit)


@app.get("/api/audit/export.csv")
async def audit_csv():
    return PlainTextResponse(live.audit.csv(), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=sahayak_audit.csv"})


@app.get("/api/spec")
async def spec():
    from app.engine.health import RANGES, WEIGHTS
    return {
        "assets": physics.ASSETS, "tags": physics.TAGS, "faults": physics.FAULTS, "actions": physics.ACTIONS,
        "allowed": physics.ALLOWED_ACTIONS, "grades": physics.GRADES, "scenarios": SCENARIOS, "levels": LEVELS,
        "engine": {"weights": WEIGHTS, "ranges": RANGES},
        "equations": [
            "Severity  s(h) = h^1.5,  h ∈ [0,1] hidden asset health (1 = failed)",
            "Degradation  dh/dt = r · (1 + 1.5h) · (0.3 + 0.7·u) · m   (u = throughput fraction, m = lube factor)",
            "Reading  y = f_nominal(u, grade, ΔT_slab) + Δ_fault · s(h) + ε,  ε ~ N(0, σ²)",
            "Twin residual  r = y − f_nominal(u, grade)   (expected healthy value at the same operating point)",
            "Cascade  RollForce_R1 ∝ (1 − 0.0015·ΔT_slab),  CoilingTemp_CB += 0.3·ΔT_slab",
            "Engine  z_i = clip(EMA_0.3(r_i)/R_i, 0, 1.2),  D = Σ w_i z_i,  p = σ(10·(D − 0.4))",
            "ML label  y = 1 if the asset fails within the next 60 min;  RUL = min(ticks to failure, 120)",
            "Trust = 0.5·agreement + 0.5·in-distribution;  < 0.5 → human review required",
        ],
        "disclaimer": "No physical asset is connected; telemetry comes from a physics-based simulation.",
        "time": "1 tick = 1 plant-minute, streamed at 1 Hz (speed-up available in the demo).",
    }


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/readyz")
async def readyz():
    return JSONResponse(live.progress, status_code=200 if live.ml.ready else 503)


app.mount("/reports", StaticFiles(directory=str(config.REPORTS_DIR)), name="reports")
if config.WEB_DIR.exists():
    app.mount("/app", StaticFiles(directory=str(config.WEB_DIR), html=True), name="web")


@app.get("/")
async def root():
    return RedirectResponse("/app/")
