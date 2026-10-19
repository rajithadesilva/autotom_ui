"""Real-GPU acceptance run, isolated from the user's editable model."""
import argparse
import json
import shutil
from pathlib import Path
from .adapter import PATCHED_FILES, install, read_config, revision, write_config
from .project import Project
from .layout import generate_layout
from .schema import Planting
from .store import Store
from .worker import DATA, execute, gpu_check


def pristine_copy(reference: Path, target: Path):
    shutil.copytree(reference, target, ignore=shutil.ignore_patterns("output", ".git", ".autotom*", "autotom*"))
    state = reference / ".autotom-adapter.json"
    if state.exists():
        backup = reference / json.loads(state.read_text())["backup"]
        for name in PATCHED_FILES:
            shutil.copy2(backup / name, target / name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=3)
    parser.add_argument("--reference", default="/reference")
    args = parser.parse_args()
    state = gpu_check()
    if not state["ready"]:
        raise SystemExit(state["error"])
    store = Store(DATA)
    model = DATA / "smoke-model"
    if model.exists():
        shutil.rmtree(model)
    pristine_copy(Path(args.reference), model)
    install(model)
    config = read_config(model)
    config.simulation.days = args.days
    config.simulation.rows = config.simulation.plants_per_row = 1
    config.simulation.border_rows = config.simulation.border_plants = 0
    config.simulation.rays = 200000
    config.planting = Planting.model_validate(generate_layout(config.simulation.model_dump(), config.room.model_dump(), legacy=True))
    write_config(model, config)
    run = Project(model, store).create_run(revision(model), "GPU acceptance smoke")
    run = store.claim()
    execute(store, run, state)
    final = store.get(run["id"])
    print(json.dumps({k: final[k] for k in ("id", "status", "error", "current_day")}, indent=2))
    if final["status"] != "completed":
        print((store.runs / run["id"] / "console.log").read_text(errors="replace")[-14000:])
        raise SystemExit(1)
    for path in sorted((store.runs / run["id"] / "days").glob("*/metrics.json")):
        metrics = json.loads(path.read_text())
        assert len(metrics["plants"]) == 1
        assert metrics["plants"][0]["biomass_g"] > 0
        assert metrics["plants"][0]["par_umol_s"] > 0
        print(path.parent.name, metrics)


if __name__ == "__main__":
    main()
