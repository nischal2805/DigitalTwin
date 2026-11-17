# Sahayak

A physics-based digital twin of a hot-strip steel mill with real LightGBM + SHAP predictive maintenance.

Sahayak streams plant telemetry, scores asset health with a three-level fallback chain (ML, then Health Engine, then LLM API), labels every recommendation with a provenance badge, requires humans to decide on actions, and records everything in an append-only audit log.

## Quick start

| Platform | Command | Open |
|---|---|---|
| Windows (PowerShell) | `./dev.ps1` | http://localhost:8000 |
| macOS / Linux | `make install && make dev` | http://localhost:8000 |
| Docker | `docker compose up --build` | http://localhost:8080 |

Docker serves the UI through nginx on port 8080 and exposes the API directly on port 8000.

### API keys

Copy `.env.example` to `.env` and paste a key:

- `GROQ_API_KEY` from console.groq.com
- `XAI_API_KEY` from console.x.ai

Leave both empty to run on Levels 1-2. The council then uses deterministic templates instead of an LLM.

### First start

If `models/manifest.json` is missing, the models train automatically on first start. This takes about one minute and the UI shows a progress screen until training finishes.

## Tabs

| Tab | What it shows |
|---|---|
| Live Twin | Streaming plant state, fault injection, operating-point controls, what-if runs |
| Explain | Global SHAP importances and per-asset explanations |
| Model Report | Held-out evaluation metrics and figures |
| Audit Log | Append-only record of readings, decisions and fallback changes, with CSV export |
| Twin Spec | Asset list, equations, thresholds and engine weights |

## Demo scenarios

| ID | Scenario | What to watch for |
|---|---|---|
| S1 | Roughing-stand bearing wear | Residual drift on the roughing stand, early ML warning |
| S2 | Cooling pump cavitation | Pump pressure and flow deviate from the twin |
| S3 | Vibration sensor glitch | Trust drops below 0.5 and the reading goes to human review |
| S4 | Finishing gearbox lube loss | Gearbox temperature rise and health decline |
| S5 | Furnace burner fouling cascade | Fouling propagates to roll force and coiling temperature |
| S6 | Model outage | Fallback flips from ML to the Health Engine, with a provenance badge change |

The **▶ Demo** button runs all six scenarios in sequence in about 4 minutes.

## Architecture

Backend modules, all under `backend/app/`:

| Module | Role |
|---|---|
| `twin` | Physics simulation of the mill: degradation, readings, faults, cascades |
| `ml` | Dataset generation, LightGBM training, evaluation, SHAP |
| `engine` | Health Engine: weighted residual score, used as the level-2 fallback |
| `llm` | LLM client and council service (level 3, template fallback when no key) |
| `hitl` | Human-in-the-loop decisions and the append-only audit log |
| `live.py` | Live loop and WebSocket broadcast, orchestrates the modules above |

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| WS | `/ws/stream` | Live state stream |
| POST | `/api/inject` | Inject a fault |
| POST | `/api/control` | Change operating point |
| POST | `/api/action` | Propose or execute an asset action |
| POST | `/api/reset` | Reset the twin |
| POST | `/api/speed` | Set simulation speed (1-10) |
| POST | `/api/whatif` | Run a what-if scenario |
| POST | `/api/council` | Ask the council for a recommendation |
| POST | `/api/decision` | Record a human decision |
| POST | `/api/admin/fallback` | Force a level: `auto`, `engine`, `llm`, or `outage` |
| GET | `/api/explain/global` | Global SHAP explanations |
| GET | `/api/report` | Model report results and figures |
| GET | `/api/audit` | Query the audit log |
| GET | `/api/audit/export.csv` | Download the audit log as CSV |
| GET | `/api/spec` | Twin specification |
| GET | `/healthz` | Liveness |
| GET | `/readyz` | Readiness (503 until models are loaded) |

## Testing

```
make test          # macOS / Linux
./dev.ps1 test     # Windows
```

Other tasks: `train`, `report` (regenerates the Model Report), `clean-models` (deletes `models/` and `reports/`).

## Honesty note

No physical asset is connected; telemetry comes from a physics-based simulation. All metrics in the Model Report are computed on held-out simulated runs.
