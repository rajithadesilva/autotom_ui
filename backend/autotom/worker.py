"""One GPU worker; Java subprocesses never own the queue or the HTTP server."""
import csv
import fcntl
import json
import os
import shutil
import signal
import subprocess
import time
import zipfile
from pathlib import Path
from .adapter import atomic_write
from .schema import DailyResult, Metric
from .geometry import normalize_obj
from .store import Store, now

DATA = Path(os.getenv("DATA_DIR", "/data"))
GROIMP = Path(os.getenv("GROIMP_HOME", "/opt/groimp"))


def gpu_check():
    try:
        info = subprocess.run(["clinfo", "-l"], capture_output=True, text=True, timeout=20)
        if info.returncode or "NVIDIA" not in info.stdout or "Device #" not in info.stdout:
            raise RuntimeError("NVIDIA OpenCL device not found. Check the host driver and NVIDIA Container Toolkit. " + info.stderr[-1000:])
        return {"ready": True, "gpu": info.stdout.strip(), "groimp": "2.2"}
    except (OSError, subprocess.TimeoutExpired, RuntimeError) as e:
        return {"ready": False, "error": str(e)}


def heartbeat(state):
    atomic_write(DATA / "worker.json", json.dumps({**state, "updated_at": now()}))


def package_model(root: Path) -> Path:
    archive = root / ".autotom-run.gsz"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(root.rglob("*")):
            rel = p.relative_to(root)
            if p.is_file() and not any(part.startswith(".") for part in rel.parts) and rel.parts[0] not in ("output", "input"):
                z.write(p, str(rel))
    return archive


def publish_days(store: Store, run):
    root = store.runs / run["id"]
    source = root / "model/output/days"
    target = root / "days"
    target.mkdir(exist_ok=True)
    for day in sorted(source.glob("[0-9][0-9][0-9][0-9]")):
        if not (day / "ready").is_file() or (target / day.name).exists():
            continue
        with (day / "metrics.csv").open() as f:
            plants = [Metric.model_validate(row) for row in csv.DictReader(f)]
        if len(plants) != run["config"]["simulation"]["rows"] * run["config"]["simulation"]["plants_per_row"]:
            raise RuntimeError("Daily export contains an unexpected plant count")
        if len({p.plant for p in plants}) != len(plants):
            raise RuntimeError("Daily export has duplicate plant identifiers")
        for geometry in ("scene.obj", "plants.obj"):
            if not (day / geometry).is_file() or (day / geometry).stat().st_size == 0:
                raise RuntimeError(f"Missing daily 3D export: {geometry}")
        result = DailyResult(day=int(day.name), plants=plants)
        stage = target / ("." + day.name)
        shutil.rmtree(stage, ignore_errors=True)
        shutil.copytree(day, stage)
        for filename in ("scene.obj", "plants.obj"):
            normalize_obj(day / filename, stage / filename)
        atomic_write(stage / "metrics.json", result.model_dump_json())
        with zipfile.ZipFile(stage / "scene.zip", "w", zipfile.ZIP_DEFLATED) as archive:
            for path in stage.iterdir():
                if path.suffix in (".obj", ".mtl", ".json", ".csv"):
                    archive.write(path, path.name)
        stage.rename(target / day.name)
        store.update(run["id"], current_day=int(day.name))


def archive_raw(root):
    temp = root / ".raw.zip"
    with zipfile.ZipFile(temp, "w", zipfile.ZIP_DEFLATED) as archive:
        for p in (root / "model/output").rglob("*.csv"):
            archive.write(p, str(p.relative_to(root / "model/output")))
        for name in ("config.json", "provenance.json", "console.log"):
            if (root / name).exists():
                archive.write(root / name, name)
    temp.replace(root / "raw.zip")


def stop_process(proc):
    if proc.poll() is not None:
        return
    os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()


def execute(store: Store, run, state):
    root = store.runs / run["id"]
    model = root / "model"
    proc = None
    status, error = "failed", None
    started = time.monotonic()
    try:
        for folder in ("rendering_output", "sensor_output", "dynamic_output/crop", "dynamic_output/plant", "dynamic_output/organ"):
            (model / "output" / folder).mkdir(parents=True, exist_ok=True)
        archive = package_model(model)
        with (root / "console.log").open("w") as log:
            # Upstream XL bytecode requires GroIMP's documented verifier override on Java 21.
            command = ["java", "-Xverify:none", "-Djava.awt.headless=true", f"-Xmx{os.getenv('JAVA_HEAP', '6g')}",
                       "-Xss20m", f"-Dautotom.modelDir={model}/", "-jar", str(GROIMP / "core.jar"), "--headless", str(archive)]
            log.write("AutoTom: GroIMP 2.2 / Java 21 / NVIDIA spectral Flux\n")
            log.flush()
            proc = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, cwd=GROIMP,
                                    start_new_session=True)
            while proc.poll() is None:
                heartbeat({**state, "run_id": run["id"]})
                publish_days(store, run)
                if time.monotonic() - started > 120:
                    with (root / "console.log").open(errors="replace") as startup_log:
                        if "AUTOTOM_STARTED" not in startup_log.read(256000):
                            raise RuntimeError("GroIMP did not start the model within two minutes; check the log for compilation or initialization errors")
                if store.get(run["id"])["cancel_requested"]:
                    status = "cancelled"
                    stop_process(proc)
                    break
                if time.monotonic() - started > int(os.getenv("RUN_TIMEOUT_SECONDS", "21600")):
                    raise RuntimeError("Simulation exceeded its six-hour time limit")
                time.sleep(1)
            publish_days(store, run)
        current = store.get(run["id"])
        if current["cancel_requested"]:
            status = "cancelled"
        elif proc.returncode == 0 and current["current_day"] == run["days"] and "AUTOTOM_COMPLETE" in (root / "console.log").read_text(errors="replace"):
            status = "completed"
        else:
            error = f"GroIMP exited with code {proc.returncode}; exported {current['current_day']}/{run['days']} days. See the simulation log."
    except SystemExit:
        error = "Worker stopped during simulation; completed days are preserved"
        raise
    except Exception as e:
        error = str(e)
    finally:
        if proc:
            stop_process(proc)
        try:
            archive_raw(root)
        except Exception as e:
            error = (error or "") + f" Raw archive failed: {e}"
            if status == "completed":
                status = "failed"
        store.update(run["id"], status=status, error=error, finished_at=now())
        heartbeat(state)


def main():
    def shutdown(signum, frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    store = Store(DATA)
    Path(os.getenv("HOME", "/tmp/autotom")).mkdir(parents=True, exist_ok=True)
    with (DATA / ".worker.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Another worker already owns this data folder")
        store.interrupt_old_runs()
        checked, state = 0, {"ready": False}
        while True:
            if time.monotonic() - checked > 30:
                state, checked = gpu_check(), time.monotonic()
            heartbeat(state)
            if state["ready"]:
                run = store.claim()
                if run:
                    execute(store, run, state)
                    continue
            time.sleep(2)


if __name__ == "__main__":
    main()
