import asyncio
import json
import os
import time
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from .adapter import Conflict, ModelError
from .project import Project
from .schema import (CreateRun, SaveConfiguration, ConfigurationResponse, DailyResult,
                     RunRecord, RunDetail, HealthResponse, LogResponse, InputPreviewRequest, InputPreviewResponse, LayoutRequest, Planting)
from .store import Store
from .parameters import preview
from .layout import generate_layout
from .adapter import revision

DATA = Path(os.getenv("DATA_DIR", "/data"))
store = Store(DATA)
project = Project(Path(os.getenv("MODEL_DIR", "/model")), store)
app = FastAPI(title="AutoTom", version="1.0.0", docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "api", "web", "testserver", *os.getenv("ALLOWED_HOSTS", "").split(",")])


@app.middleware("http")
async def same_origin(request: Request, call_next):
    # Block cross-origin writes to a local runner (including browser DNS-rebinding).
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        from urllib.parse import urlparse
        origin = request.headers.get("origin")
        if origin and urlparse(origin).netloc != request.headers.get("host"):
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "Cross-origin writes are disabled"}, status_code=403)
    return await call_next(request)


@app.exception_handler(ModelError)
async def model_error(request, error):
    from fastapi.responses import JSONResponse
    return JSONResponse({"detail": str(error)}, status_code=409 if isinstance(error, Conflict) else 422)


def worker_status():
    try:
        path = DATA / "worker.json"
        state = json.loads(path.read_text())
        if time.time() - path.stat().st_mtime > 20:
            return {"ready": False, "error": "Simulation worker is offline"}
        return state
    except (OSError, ValueError):
        return {"ready": False, "error": "Waiting for the NVIDIA simulation worker"}


@app.get("/api/health", response_model=HealthResponse)
def health():
    return {"status": "ok", "worker": worker_status()}


@app.get("/api/config", response_model=ConfigurationResponse)
def configuration():
    return project.read()


@app.post("/api/setup", response_model=ConfigurationResponse)
def setup():
    return project.setup()


@app.post("/api/inputs/preview", response_model=InputPreviewResponse)
def input_preview(body: InputPreviewRequest):
    with project.locked():
        try:
            return {**preview(project.model, body.plant_input, body.temperature_input), 'revision': revision(project.model)}
        except (ValueError, OSError) as error:
            raise ModelError(str(error)) from error


@app.post("/api/layout/preview", response_model=Planting)
def layout_preview(body: LayoutRequest):
    try:
        result = Planting.model_validate(generate_layout(body.simulation.model_dump(), body.room.model_dump(), body.model_dump()))
    except ValueError as error:
        raise ModelError(str(error)) from error
    if len([p for p in result.plants if p.role == 'border']) > 1000:
        raise ModelError('At most 1000 enabled border clones')
    return result


@app.put("/api/config", response_model=ConfigurationResponse)
def save_config(body: SaveConfiguration):
    return project.save(body.revision, body.config)


@app.get("/api/runs", response_model=list[RunRecord])
def runs():
    return store.list()


@app.post("/api/runs", status_code=201, response_model=RunRecord)
def create_run(body: CreateRun):
    worker = worker_status()
    if not worker.get("ready"):
        raise HTTPException(503, worker.get("error", "GPU worker is unavailable"))
    return project.create_run(body.revision, body.name)


def require_run(identifier):
    run = store.get(identifier)
    if run is None:
        raise HTTPException(404, "Run not found")
    return run


def run_detail(identifier):
    run = require_run(identifier)
    directory = store.runs / identifier / "days"
    run["available_days"] = sorted(int(p.name) for p in directory.glob("[0-9][0-9][0-9][0-9]")
                                   if (p / "metrics.json").is_file())
    run["raw_available"] = (store.runs / identifier / "raw.zip").is_file()
    # SSE bypasses FastAPI response-model serialization. Normalize here so both
    # transports migrate historical configs identically without changing stored data.
    return RunDetail.model_validate(run).model_dump(mode="json")


@app.get("/api/runs/{identifier}", response_model=RunDetail)
def get_run(identifier: str):
    return run_detail(identifier)


@app.post("/api/runs/{identifier}/cancel", response_model=RunDetail)
def cancel_run(identifier: str):
    require_run(identifier)
    store.cancel(identifier)
    return run_detail(identifier)


@app.get("/api/runs/{identifier}/metrics", response_model=list[DailyResult])
def metrics(identifier: str):
    run = run_detail(identifier)
    return [json.loads((store.runs / identifier / "days" / f"{day:04d}" / "metrics.json").read_text())
            for day in run["available_days"]]


@app.get("/api/runs/{identifier}/logs", response_model=LogResponse)
def logs(identifier: str):
    require_run(identifier)
    path = store.runs / identifier / "console.log"
    if not path.exists():
        return {"text": "Waiting for worker…"}
    with path.open("rb") as stream:
        stream.seek(max(0, path.stat().st_size - 64000))
        return {"text": stream.read().decode("utf-8", errors="replace")}


@app.get("/api/runs/{identifier}/events")
async def events(identifier: str, request: Request):
    require_run(identifier)
    async def generate():
        while not await request.is_disconnected():
            run = run_detail(identifier)
            yield "data: " + json.dumps(run) + "\n\n"
            if run["status"] in ("completed", "failed", "cancelled"):
                break
            await asyncio.sleep(1)
    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/runs/{identifier}/artifacts/{artifact:path}")
def artifact(identifier: str, artifact: str):
    require_run(identifier)
    root = (store.runs / identifier).resolve()
    candidate = (root / artifact).resolve()
    allowed = artifact in ("config.json", "provenance.json", "raw.zip") or (
        artifact.startswith("days/") and candidate.is_relative_to(root / "days") and
        ".." not in Path(artifact).parts and candidate.suffix in (".obj", ".mtl", ".csv", ".json", ".zip"))
    if not allowed or not candidate.is_relative_to(root) or not candidate.is_file():
        raise HTTPException(404, "Artifact not available")
    return FileResponse(candidate, headers={"Cache-Control": "private, max-age=31536000, immutable"})
