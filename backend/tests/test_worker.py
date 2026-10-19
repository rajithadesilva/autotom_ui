import json
from pathlib import Path
from unittest.mock import patch
import shutil
import subprocess
import sys
import pytest
from pydantic import ValidationError
from autotom.layout import generate_layout
from autotom.schema import Planting
from autotom.adapter import atomic_write, default_config
from autotom.store import Store
from autotom.worker import gpu_check, package_model, publish_days, execute


def test_missing_gpu_has_actionable_failure():
    with patch("autotom.worker.subprocess.run", side_effect=FileNotFoundError("clinfo missing")):
        result = gpu_check()
    assert result["ready"] is False
    assert "clinfo" in result["error"]


def test_day_publication_waits_for_complete_marker_and_validates_metrics(model, tmp_path):
    store = Store(tmp_path / "data")
    config = default_config(model)
    config.simulation.rows = config.simulation.plants_per_row = 1
    config.planting = Planting.model_validate(generate_layout(config.simulation.model_dump(), config.room.model_dump(), legacy=True))
    run = store.create("run", "run", "revision", config)
    source = store.runs / "run/model/output/days/0001"
    source.mkdir(parents=True)
    (source / "metrics.csv").write_text("plant,model_age_days,biomass_g,fruit_g,leaf_area_m2,par_umol_s,par_mmol_day,carbon_mmol_day\n1,1,1.2,0,0.004,10,576,0.3\n")
    for name in ("plants.obj", "scene.obj"):
        (source / name).write_text("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")
    publish_days(store, run)
    target = store.runs / "run/days/0001"
    assert not target.exists()
    (source / "ready").touch()
    publish_days(store, run)
    assert json.loads((target / "metrics.json").read_text())["day"] == 1
    assert store.get("run")["current_day"] == 1
    assert "mtllib scene.mtl" in (target / "scene.obj").read_text()
    assert (target / "scene.mtl").is_file()
    assert (target / "scene.zip").is_file()
    publish_days(store, run)
    assert len(list(target.parent.glob("[0-9]*"))) == 1


def test_nonfinite_simulation_output_is_never_published(model, tmp_path):
    store = Store(tmp_path / "data")
    config = default_config(model)
    config.planting = Planting.model_validate(generate_layout(config.simulation.model_dump(), config.room.model_dump(), legacy=True))
    run = store.create("run", "run", "r", config)
    source = store.runs / "run/model/output/days/0001"
    source.mkdir(parents=True)
    (source / "metrics.csv").write_text("plant,model_age_days,biomass_g,fruit_g,leaf_area_m2,par_umol_s,par_mmol_day,carbon_mmol_day\n1,1,nan,0,0.004,10,576,0.3\n")
    (source / "ready").touch()
    with pytest.raises(ValidationError):
        publish_days(store, run)
    assert not (store.runs / "run/days/0001").exists()


@pytest.mark.parametrize("cancel", [True, False])
def test_worker_cancellation_and_failed_process_preserve_artifacts(model, tmp_path, monkeypatch, cancel):
    import autotom.worker as worker
    data = tmp_path / "data"
    store = Store(data)
    config = default_config(model)
    store.create("process", "process", "r", config)
    root = store.runs / "process"
    shutil.copytree(model, root / "model")
    run = store.claim()
    if cancel:
        store.cancel(run["id"])
    monkeypatch.setattr(worker, "DATA", data)
    monkeypatch.setattr(worker, "GROIMP", tmp_path)
    real_popen = subprocess.Popen
    children = []
    def controlled_process(command, **kwargs):
        code = "import time; time.sleep(60)" if cancel else "raise SystemExit(1)"
        proc = real_popen([sys.executable, "-c", code], **kwargs)
        children.append(proc)
        return proc
    monkeypatch.setattr(worker.subprocess, "Popen", controlled_process)
    execute(store, run, {"ready": True})
    final = store.get(run["id"])
    assert final["status"] == ("cancelled" if cancel else "failed")
    assert all(child.poll() is not None for child in children)
    assert (root / "raw.zip").exists()
    if not cancel:
        assert "code 1" in final["error"]
