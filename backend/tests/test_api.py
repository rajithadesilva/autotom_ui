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


def test_input_and_layout_preview_are_read_only_and_validate_inputs(client):
    c, main, data = client
    initial=c.get('/api/config').json()
    assert initial['adapter']=={'version':2,'required_version':2,'compatible':True,'upgrade_available':False}
    sim=initial['config']['simulation']
    response=c.post('/api/inputs/preview',json={'plant_input':sim['plant_input'],'temperature_input':sim['temperature_input']})
    assert response.status_code==200
    assert response.json()['revision']==initial['revision']
    assert len(response.json()['parameters'])==98
    assert c.post('/api/inputs/preview',json={'plant_input':'../bad.csv','temperature_input':sim['temperature_input']}).status_code==422
    response=c.post('/api/layout/preview',json={'simulation':sim,'room':initial['config']['room'],'center':[.6,.6,0],'pattern':'staggered'})
    assert response.status_code==200
    assert len([p for p in response.json()['plants'] if p['role']=='central'])==9
    assert c.get('/api/config').json()['revision']==initial['revision']
    assert not any(name.startswith('autotom_effective_') for names in initial['inputs'].values() for name in names)


def test_invalid_override_shapes_and_out_of_bounds_layout_return_422(client):
    c, main, data = client
    original=c.get('/api/config').json()
    for field,value in [('parameter_overrides',None),('parameter_overrides',[]),('temperature_overrides',None),('temperature_overrides',[20])]:
        config={**original['config'],field:value}
        assert c.put('/api/config',json={'config':config,'revision':original['revision']}).status_code==422
    layout={'simulation':original['config']['simulation'],'room':original['config']['room'],'center':[100,100,0],'plant_spacing':100}
    assert c.post('/api/layout/preview',json=layout).status_code==422


def test_historical_run_events_match_migrated_http_response_without_rewriting_snapshot(client):
    from types import SimpleNamespace
    c, main, data = client
    legacy = c.get('/api/config').json()['config']
    legacy['version'] = 1
    for key in ('planting', 'groups', 'parameter_overrides', 'temperature_overrides'):
        legacy.pop(key)
    original = json.dumps(legacy).encode()

    class LegacyConfiguration:
        simulation = SimpleNamespace(days=legacy['simulation']['days'])

        def model_dump_json(self):
            return original.decode()

    main.store.create('legacy-run', 'Historical experiment', 'old-revision', LegacyConfiguration())
    main.store.update('legacy-run', status='completed')
    snapshot = main.store.runs / 'legacy-run' / 'config.json'
    snapshot.parent.mkdir()
    snapshot.write_bytes(original)

    detail = c.get('/api/runs/legacy-run').json()
    response = c.get('/api/runs/legacy-run/events')
    assert response.status_code == 200
    event = json.loads(response.text.split('data: ', 1)[1].strip())
    assert event == detail
    assert event['config']['version'] == 2
    assert len(event['config']['planting']['plants']) > 0
    assert main.store.get('legacy-run')['config'] == legacy
    assert snapshot.read_bytes() == original
