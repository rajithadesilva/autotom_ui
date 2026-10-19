import importlib
import json
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(installed, tmp_path, monkeypatch):
    data = tmp_path / "data"
    monkeypatch.setenv("MODEL_DIR", str(installed))
    monkeypatch.setenv("DATA_DIR", str(data))
    import autotom.main
    main = importlib.reload(autotom.main)
    with TestClient(main.app) as client:
        yield client, main, data


def test_configuration_validation_conflicts_and_origin_protection(client):
    c, main, data = client
    p = c.get("/api/config").json()
    body = {"config": p["config"], "revision": p["revision"]}
    body["config"]["objects"][0]["power_w"] = -1
    assert c.put("/api/config", json=body).status_code == 422
    body["config"]["objects"][0]["power_w"] = 22
    saved = c.put("/api/config", json=body)
    assert saved.status_code == 200
    assert c.put("/api/config", json=body).status_code == 409
    assert c.put("/api/config", json=body, headers={"Origin": "http://attacker.example"}).status_code == 403
    assert c.get("/api/config", headers={"Host": "attacker.example"}).status_code == 400


def test_missing_gpu_prevents_submission_but_not_editing(client):
    c, main, data = client
    p = c.get("/api/config").json()
    assert c.post("/api/runs", json={"revision": p["revision"], "name": "No GPU"}).status_code == 503
    assert c.get("/api/config").status_code == 200


def test_api_run_snapshot_cancel_and_artifact_paths(client):
    c, main, data = client
    (data / "worker.json").write_text(json.dumps({"ready": True}))
    p = c.get("/api/config").json()
    response = c.post("/api/runs", json={"revision": p["revision"], "name": "API run"})
    assert response.status_code == 201
    identifier = response.json()["id"]
    assert c.get(f"/api/runs/{identifier}").json()["available_days"] == []
    assert c.get(f"/api/runs/{identifier}/metrics").json() == []
    assert c.get(f"/api/runs/{identifier}/artifacts/config.json").status_code == 200
    assert c.get(f"/api/runs/{identifier}/artifacts/model/project.gs").status_code == 404
    assert c.get(f"/api/runs/{identifier}/artifacts/days/%2e%2e/%2e%2e/autotom.sqlite").status_code == 404
    assert c.post(f"/api/runs/{identifier}/cancel").json()["status"] == "cancelled"
    assert c.get("/api/runs/not-a-run").status_code == 404
