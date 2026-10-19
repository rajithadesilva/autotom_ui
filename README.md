# AutoTom

A Docker-based browser workspace for the [Micro-Tom functional–structural plant model](https://github.com/Micbut/FSP-model-dwarf-tomato). Edit spectral LEDs, room properties, boxes, and reflector panels; run GroIMP without its desktop GUI; explore daily 3D plants and growth/light/photosynthesis charts.

## Start locally

Requirements: Linux x86-64 (or WSL2 with GPU support), Docker Engine with Compose v2, a working NVIDIA driver, and [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). Java, Python, Node, GroIMP, OpenCL user libraries, and application dependencies are supplied by Docker. The host driver and container runtime must be installed on the host.

The upstream repository is a Git submodule at `model/` in this checkout. Docker mounts its nested `model/` directory, so the default `MODEL_DIR` is `./model/model`. This directory contains `project.gs`, the RGG sources, and the complete `input/` directory. Initialize the pinned submodule from this checkout:

```bash
git submodule update --init --recursive
```

For a new checkout, use `git clone --recurse-submodules <this-repository-url>`. To run the initialization through Docker instead, use `docker run --rm --user "$(id -u):$(id -g)" -v "$(pwd):/work" -w /work alpine/git:2.49.1 submodule update --init --recursive`.

Then start the application:

```bash
cp .env.example .env
mkdir -p data
# If necessary, set MODEL_DIR, DATA_DIR, LOCAL_UID and LOCAL_GID in .env.
docker compose build
docker compose run --rm --no-deps api python -m autotom.setup
docker compose up -d
```

Open **http://localhost:8080**. The setup command backs up original model files under the host model's `.autotom-backups/` directory, then installs the adapter. Repeating setup does not overwrite an installed adapter. The browser also has an **Install model adapter** button if setup has not run.

Setup and configuration saves change files inside the submodule's working tree; Git will show `model` as modified. The parent repository still pins the original upstream commit. Preserve these local changes before switching the submodule to another revision.

```bash
docker compose ps
docker compose logs --tail 100 worker
docker compose exec worker clinfo -l
docker compose down
```

`down` stops the application; configurations and run results stay on the host. Source edits require rebuilding the corresponding image. No container has access to the Docker socket.

## Use the workspace

- **Lights:** add individual spectral LEDs; select them from the scene/object list; drag the move/rotate gizmos or edit their coordinates. Emission arrows point along each LED's local +Z axis. A downward LED has rotation `(180, 0, 0)`. Edit power in watts, photoperiod, and the shared 400–700 nm spectrum.
- **Surroundings:** resize the room, override surface reflectance, and add/move/rotate boxes or reflector panels. Panels are thin, opaque physical slabs. Leaving a room-surface override off retains its original spectral reflectance and transmission curves.
- **Simulation:** set days, planting layout, density, border plants, seed, and rays; select existing model input files. Add new input files in the host model's `input/` subfolders and reload the page. Growth/temperature model behavior stays in the original RGG and CSV files.
- **Save changes** writes into your host model folder. **Run simulation** saves any current draft and queues an immutable source/input/configuration snapshot. Later edits apply to new runs. The editor is a schematic preview; displayed simulation plants come from real GroIMP exports.
- Select a saved run, then use the day slider, chart click, or playback. Days become available only after their geometry and metrics are complete. Charts default to mean per simulated central plant; border clones affect light but are excluded from reporting.
- **OBJ + MTL** downloads the selected day's full scene, central plant mesh, materials, and metrics as a ZIP. **CSV** downloads original model CSVs, canonical daily metrics CSVs, the configuration, provenance, and console log after a run finishes or is cancelled.

Configuration is authoritative in `autotom.json`; saving generates `autotom.properties` and `autotom_scene.rgg`. Numeric RGG settings read those properties, while explicit scene geometry comes from the generated RGG. To edit configuration by hand, edit `autotom.json`, reload it in the browser, and save to regenerate its companion files. Changes to any non-hidden model/input file invalidate the editor revision, preventing an old browser tab from overwriting newer host edits. Edits to managed RGG parameter expressions can affect their fallback behavior; use the configuration for the exposed settings.

The default experiment is 80 days, a 3×3 central layout with the original border plants, density 50 plants/m², 16 h photoperiod, original optical/input data, and 21,474,000 rays/day. Lower ray counts are useful for quick checks but increase Monte Carlo noise. Plant seed 0 maps to Flux seed 1, because Flux requires a positive seed.

## Storage and architecture

| Host location | Purpose |
| --- | --- |
| `$MODEL_DIR/autotom.*` and `autotom_scene.rgg` | Editable configuration and generated model inputs |
| `$MODEL_DIR/.autotom-backups/<timestamp>/` | Exact original bytes of every adapter-modified source |
| `$DATA_DIR/autotom.sqlite` | Persistent run queue and state |
| `$DATA_DIR/runs/<id>/model/` | Run source/input snapshot and original GroIMP output |
| `$DATA_DIR/runs/<id>/days/0001/` | Atomically published Z-up OBJ/MTL, daily metrics, downloadable ZIP |

Nginx serves React/TypeScript/Three.js/Recharts and proxies `/api/` to FastAPI. A separate worker claims one SQLite job at a time and launches a fresh Java process. GroIMP 2.2 and Java 21 are pinned; the official GroIMP Linux archive is SHA-256 checked. A small, checksum-pinned GPUFlux diagnostic-parser patch avoids empty-line-number exceptions in modern NVIDIA compiler logs; it does not change ray-tracing kernels or model equations. The patch and its exact upstream source remain inside the worker image under `/opt/groimp/patches/`.

The adapter fixes the upstream duplicate headless initialization and adds explicit scene objects and per-day exports. GroIMP's OBJ exporter writes X,Z,Y coordinates and vertex colors; the worker converts these to Z-up OBJ/MTL before publication. Native exports remain in the run's `model/output` directory.

Canonical metrics are `biomass_g` (total plant dry biomass including roots), `fruit_g` (fruit dry biomass), `leaf_area_m2`, `par_umol_s`, `par_mmol_day`, and `carbon_mmol_day`. Daily PAR is instantaneous absorbed PAR × photoperiod × 3600 / 1000. Carbon assimilation is the model's daily CO₂ assimilation / 1000. Original model CSV headers/values are retained for research compatibility; some legacy PAR headers describe instantaneous rates as daily quantities. Use the canonical daily metrics for charts and unit-correct analysis.

FastAPI's typed OpenAPI reference is at **http://localhost:8080/api/docs**, with its schema at **http://localhost:8080/api/openapi.json**. The application is intended for a single trusted user. Model files are executable XL code.

### API endpoints

`GET /api/health`, `GET /api/config`, `POST /api/setup`, `PUT /api/config` (`{revision, config}`), `GET/POST /api/runs` (create: `{revision, name}`), `GET /api/runs/{id}`, `POST /api/runs/{id}/cancel`, `GET /api/runs/{id}/events` (SSE), `/metrics`, `/logs`, and `/artifacts/{path}`. A save or run with a stale revision returns 409. Invalid configuration returns 422; unavailable GPU execution returns 503. Interrupted jobs become failed on worker restart; completed daily outputs stay available.

## Deploy on a server

Use an NVIDIA-equipped server with the same Docker prerequisites and mounted host model/data directories. Point a domain's DNS at it, open ports 80/443, and set `AUTOTOM_DOMAIN`, `AUTH_USER`, and `AUTH_PASSWORD_HASH` in `.env`. Generate a bcrypt hash interactively:

```bash
docker run --rm -it caddy:2.10-alpine caddy hash-password
```

Put the hash in single quotes in `.env` to preserve `$` characters, then:

```bash
docker compose --profile server up -d
```

The optional Caddy gateway provides HTTPS and single-user Basic authentication. Nginx remains bound to localhost; API and worker ports remain private. The entire stack and its model/data live on that server. This profile prepares hosting; it does not provision a server or register DNS.

## Validate in Docker

```bash
docker compose --profile test run --rm test
docker compose --profile test run --build --rm browser-tests
```

The normal browser tests mock API responses to isolate UI behavior and never change your model. An additional `LIVE=1` check can read the saved 80-day validation run. Reports/screenshots are written under `data/browser-report` and `data/browser-results`. See [the validation record](docs/validation.md) for the real GPU checks and their settings.

Run a real, isolated three-day NVIDIA smoke simulation:

```bash
mkdir -p data/gpu-check
docker compose run --rm --no-deps \
  -e DATA_DIR=/checks \
  -v "$(pwd)/data/gpu-check:/checks" \
  -v "$(cd model/model && pwd):/reference:ro" \
  worker python -m autotom.smoke
```

For native-grid comparison, repeated-seed sampling checks, moved-lamp and opaque-panel tests, run the same command with `python -m autotom.acceptance` and a separate check directory. These checks copy and restore pristine sources from the adapter backup when necessary; they never modify the host model.

If a run fails, open **Log** in its progress strip. Missing NVIDIA devices usually indicate host driver/toolkit configuration. A two-minute model-start watchdog catches compilation/initialization failures; a six-hour run limit prevents a hung Java process from occupying the worker indefinitely. Cancellation stops the Java process group and retains finished days.

Upstream model: Micbut/FSP-model-dwarf-tomato, adapter baseline commit `2d727a3364f87392b3f8b74d8ff7127cc5090c3a`. GroIMP and GPUFlux retain their upstream licenses; the application license is in [LICENSE](LICENSE).
