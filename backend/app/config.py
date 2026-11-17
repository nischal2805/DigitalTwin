"""Runtime configuration. Reads ../.env (KEY=VALUE lines) without overriding real env vars."""
import os
from pathlib import Path

os.environ.setdefault("LOKY_MAX_CPU_COUNT", str(os.cpu_count() or 4))  # skip loky wmic probe on Windows
ROOT = Path(__file__).resolve().parents[2]


def _load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env(ROOT / ".env")

SEED = int(os.getenv("SEED", "42"))
N_RUNS = int(os.getenv("N_RUNS", "400"))
MODELS_DIR = Path(os.getenv("MODELS_DIR", ROOT / "models"))
REPORTS_DIR = Path(os.getenv("REPORTS_DIR", ROOT / "reports"))
DATA_DIR = Path(os.getenv("DATA_DIR", ROOT / "data"))
WEB_DIR = ROOT / "web"

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "groq").lower()  # groq | xai | none
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
XAI_API_KEY = os.getenv("XAI_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "")
LLM_TIMEOUT_S = float(os.getenv("LLM_TIMEOUT_S", "6"))

for d in (MODELS_DIR, REPORTS_DIR, DATA_DIR):
    d.mkdir(parents=True, exist_ok=True)
