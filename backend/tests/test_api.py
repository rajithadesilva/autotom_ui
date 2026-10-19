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


def test_named_configurations_persist_complete_drafts_without_changing_model(client):
    from autotom.configurations import Configurations
    c, main, data = client
    initial = c.get('/api/config').json()
    config = initial['config']
    config['parameter_overrides'] = {'base_temperature': 8.0}
    config['temperature_overrides'] = {'0': 24.0}
    config['objects'][0]['power_w'] = 20
    body = {'name': ' Warm room / low light ', 'config': config}
    response = c.post('/api/configurations', json=body)
    assert response.status_code == 201
    saved = response.json()
    identifier = saved['id']
    assert saved['name'] == 'Warm room / low light'
    assert saved['config'] == config
    assert json.loads((data / 'configurations' / f'{identifier}.json').read_text()) == saved
    assert Configurations(data).get(identifier).model_dump(mode='json') == saved
    assert c.get('/api/configurations').json() == [saved]
    assert c.get(f'/api/configurations/{identifier}').json() == saved
    assert c.get('/api/config').json()['revision'] == initial['revision']
    assert c.get('/api/runs').json() == []
    # Each save creates a separate file, even when names are reused.
    second = c.post('/api/configurations', json=body).json()
    assert second['id'] != identifier
    assert len(c.get('/api/configurations').json()) == 2
    assert c.delete(f'/api/configurations/{identifier}').status_code == 204
    assert not (data / 'configurations' / f'{identifier}.json').exists()
    assert c.get(f'/api/configurations/{identifier}').status_code == 404
    assert c.delete(f'/api/configurations/{identifier}').status_code == 404
    assert c.get('/api/configurations/not-a-valid-id').status_code == 404
    assert c.get(f'/api/configurations/{second["id"]}').status_code == 200
    assert c.post('/api/configurations', json={**body, 'name': '   '}).status_code == 422
    config['objects'][0]['power_w'] = -1
    assert c.post('/api/configurations', json=body).status_code == 422


@pytest.mark.parametrize('status', ['queued', 'running', 'completed', 'cancelled', 'failed'])
def test_run_deletion_removes_snapshot_and_record_only_after_execution_stops(client, status):
    c, main, data = client
    (data / 'worker.json').write_text(json.dumps({'ready': True}))
    project = c.get('/api/config').json()
    run = c.post('/api/runs', json={'revision': project['revision'], 'name': 'Disposable'}).json()
    identifier = run['id']
    root = data / 'runs' / identifier
    main.store.update(identifier, status=status)
    response = c.delete(f'/api/runs/{identifier}')
    if status in ('queued', 'running'):
        assert response.status_code == 409
        assert root.is_dir()
        assert main.store.get(identifier)['status'] == status
        # Worker records a terminal state only after finishing artifact publication.
        main.store.update(identifier, status='cancelled')
        response = c.delete(f'/api/runs/{identifier}')
    assert response.status_code == 204
    assert not root.exists()
    assert main.store.get(identifier) is None
    assert c.get('/api/runs').json() == []
    assert c.get(f'/api/runs/{identifier}').status_code == 404
    assert c.get(f'/api/runs/{identifier}/artifacts/config.json').status_code == 404
    assert c.delete(f'/api/runs/{identifier}').status_code == 404
    assert c.get('/api/config').json()['revision'] == project['revision']


@pytest.mark.parametrize('status', ['queued', 'running', 'completed'])
def test_run_rename_persists_only_name_and_validates_input(client, status):
    from autotom.store import Store
    c, main, data = client
    (data / 'worker.json').write_text(json.dumps({'ready': True}))
    project = c.get('/api/config').json()
    run = c.post('/api/runs', json={'revision': project['revision'], 'name': 'Original'}).json()
    identifier = run['id']
    main.store.update(identifier, status=status)
    before = main.store.get(identifier)
    snapshot = (data / 'runs' / identifier / 'config.json').read_bytes()
    response = c.patch(f'/api/runs/{identifier}', json={'name': ' Renamed experiment '})
    assert response.status_code == 200
    expected = {**before, 'name': 'Renamed experiment'}
    assert response.json() == expected
    assert Store(data).get(identifier) == expected
    assert c.get('/api/runs').json()[0]['name'] == expected['name']
    assert c.get(f'/api/runs/{identifier}').json()['name'] == expected['name']
    assert (data / 'runs' / identifier / 'config.json').read_bytes() == snapshot
    for name in ['', '   ', 'x' * 101]:
        assert c.patch(f'/api/runs/{identifier}', json={'name': name}).status_code == 422
    assert c.patch(f'/api/runs/{identifier}', json={'name': 'Blocked'}, headers={'Origin': 'http://attacker.example'}).status_code == 403
    assert c.patch('/api/runs/missing', json={'name': 'Unknown'}).status_code == 404
    assert main.store.get(identifier) == expected
