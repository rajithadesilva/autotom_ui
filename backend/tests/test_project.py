import json
from pathlib import Path
import pytest
from pydantic import ValidationError
from autotom.adapter import Conflict, ModelError, PATCHED_FILES, default_config, install, matrix, read_config, revision, scene_source, validate_inputs
from autotom.project import Project
from autotom.schema import Configuration, SceneObject
from autotom.store import Store


def test_installer_is_backed_up_idempotent_and_preserves_unrelated_edits(model):
    originals = {name: (model / name).read_bytes() for name in PATCHED_FILES}
    extra = model / "param/auxiliary_tools_and_charts.rgg"
    extra.write_bytes(extra.read_bytes() + b"\n// user research note\n")
    install(model)
    rev = revision(model)
    install(model)
    assert revision(model) == rev
    state = json.loads((model / ".autotom-adapter.json").read_text())
    for name, content in originals.items():
        assert (model / state["backup"] / name).read_bytes() == content
    assert extra.read_bytes().endswith(b"// user research note\n")
    assert 'name="autotom_scene.rgg"' in (model / "project.gs").read_text()


def test_unsupported_model_is_not_partially_patched(model):
    source = model / "initiation.rgg"
    source.write_bytes(source.read_bytes().replace(b"//Construction of the room", b"//different construction"))
    before = revision(model)
    with pytest.raises(ModelError, match="does not match"):
        install(model)
    assert revision(model) == before
    assert not (model / ".autotom-adapter.json").exists()


def test_configuration_save_and_external_edit_conflict(installed, tmp_path):
    project = Project(installed, Store(tmp_path / "data"))
    initial = project.read()
    config = read_config(installed)
    config.objects[0].power_w = 21
    saved = project.save(initial["revision"], config)
    assert read_config(installed).objects[0].power_w == 21
    assert 'AutoTomLED(21.0)' in (installed / "autotom_scene.rgg").read_text()
    file = installed / "photosynthesis.rgg"
    file.write_bytes(file.read_bytes() + b"\n// external edit\n")
    with pytest.raises(Conflict):
        project.save(saved["revision"], config)
    assert file.read_bytes().endswith(b"// external edit\n")


def test_run_snapshot_is_complete_and_immutable_to_later_edits(installed, tmp_path):
    store = Store(tmp_path / "data")
    project = Project(installed, store)
    run = project.create_run(revision(installed), "isolated")
    snapshot = store.runs / run["id"] / "model"
    assert revision(snapshot) == run["revision"]
    source = installed / "input/dynamic_input/base_plant_dynamic_50.csv"
    original = source.read_bytes()
    source.write_bytes(original + b"\n")
    assert (snapshot / "input/dynamic_input/base_plant_dynamic_50.csv").read_bytes() == original
    assert (store.runs / run["id"] / "provenance.json").exists()
    config = read_config(installed)
    config.simulation.days = 3
    project.save(revision(installed), config)
    assert json.loads((store.runs / run["id"] / "config.json").read_text())["simulation"]["days"] == 80


def test_inputs_duration_and_paths(model):
    config = default_config(model)
    (model / "input/temperature" / config.simulation.temperature_input).write_text("DAT,temperature\n0,20\n")
    with pytest.raises(ModelError, match="1 days"):
        validate_inputs(model, config)
    config.simulation.days = 1
    validate_inputs(model, config)
    data = config.model_dump()
    data["simulation"]["plant_input"] = "../secret.csv"
    with pytest.raises(ValidationError):
        Configuration.model_validate(data)


@pytest.mark.parametrize("change", [
    lambda c: c["room"].update(width=-1),
    lambda c: c["objects"][0].update(power_w=float("nan")),
    lambda c: c["objects"][0].update(position=[0, 0, float("inf")]),
    lambda c: c["objects"][0].update(reflectance=1.2),
    lambda c: c["spectrum"].reverse(),
    lambda c: c["objects"].append(c["objects"][0]),
])
def test_invalid_scene_is_rejected(model, change):
    data = default_config(model).model_dump()
    change(data)
    with pytest.raises(ValidationError):
        Configuration.model_validate(data)


def test_transform_matches_z_up_xyz_convention(model):
    # A downward LED maps its local +Z emission to world -Z.
    m = matrix((0.2, 0.6, 0.725), (180, 0, 0))
    assert [m[3], m[7], m[11]] == [0.2, 0.6, 0.725]
    assert [m[2], m[6], m[10]] == pytest.approx([0, 0, -1])
    # 90 degrees around Z takes local +X to world +Y.
    m = matrix((0, 0, 0), (0, 0, 90))
    assert [m[0], m[4], m[8]] == pytest.approx([0, 1, 0])
    config = default_config(model)
    config.objects.append(SceneObject(id="panel", name="Panel", kind="panel", position=(0, 0, 0.3), size=(0.5, 0.3, 0.01)))
    assert "Box(0.01,0.5,0.3)" in scene_source(config)


def test_queue_claim_cancel_and_interrupted_runs(tmp_path):
    store = Store(tmp_path)
    class Config:
        class simulation:
            days = 3
        def model_dump_json(self):
            return '{}'
    store.create("first", "First", "r", Config())
    store.create("second", "Second", "r", Config())
    first = store.claim()
    assert first["id"] == "first" and first["status"] == "running"
    store.cancel("second")
    assert store.get("second")["status"] == "cancelled"
    assert store.claim() is None
    store.interrupt_old_runs()
    assert store.get("first")["status"] == "failed"
    assert "restarted" in store.get("first")["error"]
