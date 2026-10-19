"""Real GPU physics checks, always using an isolated copy of the reference model."""
import json
import statistics
import shutil
from pathlib import Path
from .adapter import install, read_config, revision, write_config
from .project import Project
from .layout import generate_layout
from .schema import Planting
from .schema import SceneObject
from .smoke import pristine_copy
from .store import Store
from .worker import DATA, execute, gpu_check


def main():
    state = gpu_check()
    if not state["ready"]:
        raise SystemExit(state["error"])
    store = Store(DATA)
    model = DATA / "physics-model"
    if model.exists():
        shutil.rmtree(model)
    pristine_copy(Path("/reference"), model)
    install(model)
    config = read_config(model)
    config.simulation.days = 1
    config.simulation.rows = config.simulation.plants_per_row = 1
    config.simulation.border_rows = config.simulation.border_plants = 0
    config.simulation.rays = 2000000
    config.planting = Planting.model_validate(generate_layout(config.simulation.model_dump(), config.room.model_dump(), legacy=True))
    project = Project(model, store)
    results = []
    for case in ("repeat-1", "repeat-2", "repeat-3", "native-grid", "moved-lamps", "opaque-panel"):
        variant = config.model_copy(deep=True)
        if case == "moved-lamps":
            for obj in variant.objects:
                obj.position = (obj.position[0]+3, obj.position[1], obj.position[2])
        if case == "opaque-panel":
            variant.objects.append(SceneObject(id="blocker", name="Opaque panel", kind="panel", position=(0.6, 0.6, 0.5), size=(2, 2, 0.02), reflectance=0))
        write_config(model, variant)
        # The reference GridLamp geometry is retained unchanged by the adapter.
        init = model / "initiation.rgg"
        light = model / "light.rgg"
        original, original_light = init.read_bytes(), light.read_bytes()
        # Independent Monte Carlo seeds, with plant morphology seed held at zero.
        flux_seed = int(case[-1]) if case.startswith("repeat-") else 1
        light.write_bytes(original_light.replace(b"lmGPU.setSeed(Math.max(1, SET_SEED));", f"lmGPU.setSeed({flux_seed});".encode()))
        if case == "native-grid":
            init.write_bytes(original.replace(b"[AutoTomEnvironment]", b"[if(ROOM)(Walls RoomFloor Ceiling)] [if(LAMPS)(GridLamp)]"))
        try:
            run = project.create_run(revision(model), case)
        finally:
            init.write_bytes(original)
            light.write_bytes(original_light)
        run = store.claim()
        execute(store, run, state)
        result = store.get(run["id"])
        if result["status"] != "completed":
            print((store.runs / run["id"] / "console.log").read_text(errors="replace")[-6000:])
            raise SystemExit(f"{case} failed: {result['error']}")
        metrics = json.loads((store.runs / run["id"] / "days/0001/metrics.json").read_text())
        value = metrics["plants"][0]["par_umol_s"]
        print(case, run["id"], value, flush=True)
        results.append({"case": case, "flux_seed": flux_seed, "run_id": run["id"], "par_umol_s": value})
    baseline = statistics.mean(r["par_umol_s"] for r in results[:3])
    noise = statistics.stdev(r["par_umol_s"] for r in results[:3])
    assert abs(results[3]["par_umol_s"]-baseline) < max(0.05*baseline, 5*noise), "Explicit LEDs do not match the original GridLamp within 5% / measured sampling variation"
    for result in results[4:]:
        assert baseline-result["par_umol_s"] > max(0.1*baseline, 5*noise), f"{result['case']} did not reduce PAR beyond measured noise"
    report = {"baseline_mean": baseline, "baseline_stddev": noise, "results": results, "passed": True}
    (DATA / "physics-report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
