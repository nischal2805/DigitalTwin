import pytest
from pytest import MonkeyPatch

from app import config

NEED_MODELS = pytest.mark.skipif(not (config.MODELS_DIR / "manifest.json").exists(), reason="models not trained")


@pytest.fixture
def mk_live(tmp_path, monkeypatch):
    """Factory for a headless Live with isolated audit DB and no LLM."""
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "LLM_PROVIDER", "none")
    from app.live import Live

    def make(ml=None):
        lv = Live()
        if ml is not None:
            lv.ml = ml
            lv.reset(log=False)
        return lv
    return make


@pytest.fixture(scope="module")
def api_client(tmp_path_factory):
    mp = MonkeyPatch()
    mp.setattr(config, "DATA_DIR", tmp_path_factory.mktemp("data"))
    mp.setattr(config, "LLM_PROVIDER", "none")
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        yield c
    mp.undo()
