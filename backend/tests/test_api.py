import time

import pytest

from conftest import NEED_MODELS

pytestmark = NEED_MODELS


def wait_tick(client):
    from app import main
    for _ in range(100):
        if main.live.last:
            return
        time.sleep(0.1)
    pytest.fail("no tick")


def test_get_endpoints(api_client):
    c = api_client
    assert c.get("/healthz").json() == {"ok": True}
    assert c.get("/readyz").status_code == 200
    assert "scenarios" in c.get("/api/spec").json()
    assert c.get("/api/report").status_code in (200, 404)
    assert c.get("/api/explain/global").status_code in (200, 404)
    assert isinstance(c.get("/api/audit").json(), list)
    r = c.get("/api/audit/export.csv")
    assert r.status_code == 200 and r.text.startswith("id,time")


def test_post_endpoints(api_client):
    c = api_client
    assert c.post("/api/speed", json={"speed": 10}).json()["speed"] == 10
    wait_tick(c)
    assert c.post("/api/inject", json={"scenario": "S1"}).json()["ok"]
    assert c.post("/api/inject", json={"scenario": "S99"}).status_code == 400
    w = c.post("/api/whatif", json={"asset": "R1", "action": "planned_maintenance"})
    assert w.status_code == 200 and "baseline" in w.json()
    co = c.post("/api/council", json={"asset": "R1"}).json()
    assert "template" in co["generated_by"]
    assert c.post("/api/admin/fallback", json={"level": "engine"}).json()["mode"] == "engine"
    assert c.post("/api/admin/fallback", json={"level": "outage"}).json()["outage"]
    assert c.post("/api/admin/fallback", json={"level": "bogus"}).status_code == 400
    c.post("/api/admin/fallback", json={"level": "auto"})
    assert c.post("/api/decision", json={"alert_id": "nope", "decision": "approve"}).status_code == 400
    assert c.post("/api/decision", json={"alert_id": "nope", "decision": "bad"}).status_code == 400
    assert c.post("/api/reset").json()["ok"]
    assert c.post("/api/speed", json={"speed": 1}).json()["speed"] == 1
