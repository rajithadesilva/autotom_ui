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
- **Plants:** generate grid or staggered layouts with independent spacing, centre, height, rotation, and border counts. **Generate layout** replaces plant placements; undo restores them. Add, duplicate, disable, move, or remove individual central plants and border clones. Plants remain upright and rotate around Z. Central plants have stable reporting IDs; border clones affect light and stay outside charts. Density sets model ground area (`enabled central plants / density`); custom spacing controls physical placement.
- **Model parameters:** search 98 supported growth, architecture, photosynthesis, respiration, fruit, and light settings. Values start from the selected plant input. Overrides and daily-temperature edits are saved with the experiment; reset a field, section, or all overrides to use source values again. Array proportions must have the displayed shape and total 1. Temperature day 1 maps to upstream day 0; edits beyond the current duration remain saved.
- **Selection and groups:** click an item, use Shift/Ctrl/Cmd-click or list checkboxes for multiple selection, or enable the box-selection tool and drag a rectangle. Box selection includes occluded item origins. Create named, flat groups mixing plants, lights, and surroundings; expand a group to select individual members. Move or rotate the selection with its shared gizmo or inspector controls. Groups containing plants rotate around Z only. Escape clears selection and returns to orbit controls.
- **Undo/redo:** use the viewport buttons, Ctrl/Cmd+Z, or Ctrl/Cmd+Shift+Z (Ctrl/Cmd+Y also works). Each drag or completed numeric edit is one step. Saving retains history; reloading host files clears it. Result viewing disables editor controls.
- **Simulation:** set days, seed, and rays; select existing model input files. Add new input files in the host model's `input/` subfolders and reload the page. One shared parameter set applies to all plants.
- **Save changes** writes into your host model folder. **Run simulation** saves any current draft and queues an immutable source/input/configuration snapshot. Later edits apply to new runs. The editor is a schematic preview; displayed simulation plants come from real GroIMP exports.
- **Saved configurations:** enter a configuration name and choose **Save configuration** to keep the displayed experiment as a named JSON file, including model and temperature overrides, input selections, plants, groups, lights, spectrum, and surroundings. Each save creates a separate copy under `$DATA_DIR/configurations/`, even when names match. The dropdown lists every saved configuration and loads one into the editor; undo restores the preceding draft. Saving a named configuration works without a GPU and does not change host model inputs. Selected input files are referenced by name, rather than copied into these configuration files. **Delete configuration** removes the selected file and keeps the current editor and run results.
- **New run** opens an editable draft using the displayed configuration and clears the selected result. Choose a run name, adjust settings, then choose **Run simulation**. Previous runs stay available. Open the **⋯** menu beside a saved run name to **Rename** it or **Delete** its record, snapshot, and results after confirmation. Runs can be renamed in any state; deletion is available for finished, failed, or cancelled runs. On smaller screens, the menu appears beside the selected run dropdown. Cancel queued or running simulations and wait for them to stop before deleting them.
- Selecting a saved run keeps the current tab open and loads its snapshot into the scene editor. Editor changes apply to future runs and leave saved simulations unchanged. Use the day slider, chart click, or playback to explore its results. Days become available only after their geometry and metrics are complete. Charts default to mean per simulated central plant; border clones affect light but are excluded from reporting.
- Open **Compare** beside **Scene editor** and **Simulation** to select two different saved runs. The five graphs overlay plant dry biomass, fruit dry biomass, leaf area, absorbed PAR, and carbon assimilation by simulation day. Choose mean per simulated plant or an individual plant independently for each run. Missing days remain gaps; values and B − A differences use the latest shared day. Published results update as simulations progress.
- **OBJ + MTL** downloads the selected day's full scene, central plant mesh, materials, and metrics as a ZIP. **CSV** downloads original model CSVs, canonical daily metrics CSVs, the configuration, provenance, and console log after a run finishes or is cancelled.

Configuration version 2 is authoritative in `autotom.json`; saving generates `autotom.properties`, `autotom_scene.rgg`, `input/dynamic_input/autotom_effective_plant.csv`, and `input/temperature/autotom_effective_temperature.csv`. Effective CSVs preserve original input files and apply overrides before the upstream model's calculations. All generated files are rolled back together if saving fails and are included in run snapshots. Numeric RGG settings read those properties, while explicit scene geometry comes from the generated RGG. To edit configuration by hand, edit `autotom.json`, reload it in the browser, and save to regenerate its companion files. Changes to any non-hidden model/input file invalidate the editor revision, preventing an old browser tab from overwriting newer host edits. Edits to managed RGG parameter expressions can affect their fallback behavior; use the configuration for the exposed settings.

The default experiment is 80 days, a 3×3 central layout with the original border plants, density 50 plants/m², 16 h photoperiod, original optical/input data, and 21,474,000 rays/day. Lower ray counts are useful for quick checks but increase Monte Carlo noise. Plant seed 0 maps to Flux seed 1, because Flux requires a positive seed.

## Storage and architecture

| Host location | Purpose |
| --- | --- |
| `$MODEL_DIR/autotom.*` and `autotom_scene.rgg` | Editable configuration and generated model inputs |
| `$MODEL_DIR/.autotom-backups/<timestamp>/` | Exact original bytes of every adapter-modified source |
| `$DATA_DIR/autotom.sqlite` | Persistent run queue and state |
| `$DATA_DIR/configurations/<id>.json` | Named, reusable experiment configurations |
| `$DATA_DIR/runs/<id>/model/` | Run source/input snapshot and original GroIMP output |
| `$DATA_DIR/runs/<id>/days/0001/` | Atomically published Z-up OBJ/MTL, daily metrics, downloadable ZIP |

Nginx serves React/TypeScript/Three.js/Recharts and proxies `/api/` to FastAPI. A separate worker claims one SQLite job at a time and launches a fresh Java process. GroIMP 2.2 and Java 21 are pinned; the official GroIMP Linux archive is SHA-256 checked. A small, checksum-pinned GPUFlux diagnostic-parser patch avoids empty-line-number exceptions in modern NVIDIA compiler logs; it does not change ray-tracing kernels or model equations. The patch and its exact upstream source remain inside the worker image under `/opt/groimp/patches/`.

The adapter fixes the upstream duplicate headless initialization and adds explicit scene objects and per-day exports. GroIMP's OBJ exporter writes X,Z,Y coordinates and vertex colors; the worker converts these to Z-up OBJ/MTL before publication. Native exports remain in the run's `model/output` directory.

Use **Inspect** in either viewport to select an individual plant, LED, reflector, or obstacle. The right panel has its own orbit/zoom viewer and searchable, read-only properties. In Simulation, plants have an independent daily timeline; **Sync with simulation** links its slider and playback to the main view. Border clones identify their source and label shared state. Editor inspection shows placement previews and draft inputs.

Adapter v3 records named central plant meshes, actual instance/clone transforms, and all 74 primitive PlantBase state fields. Upgrade through **Upgrade model adapter**, then start a new run for full daily inspection. In older runs, clicking a plant surface opens a chooser ordered by proximity to the click; choose the plant explicitly because those combined meshes do not encode individual identity. Existing runs keep their saved properties, available metrics, and snapshot inputs; they are not rewritten or rerun. Realtime and skeleton views are future additions.

Canonical metrics are `biomass_g` (total plant dry biomass including roots), `fruit_g` (fruit dry biomass), `leaf_area_m2`, `par_umol_s`, `par_mmol_day`, and `carbon_mmol_day`. Daily PAR is instantaneous absorbed PAR × photoperiod × 3600 / 1000. Carbon assimilation is the model's daily CO₂ assimilation / 1000. Original model CSV headers/values are retained for research compatibility; some legacy PAR headers describe instantaneous rates as daily quantities. Use the canonical daily metrics for charts and unit-correct analysis.

FastAPI's typed OpenAPI reference is at **http://localhost:8080/api/docs**, with its schema at **http://localhost:8080/api/openapi.json**. The application is intended for a single trusted user. Model files are executable XL code.

### Upgrading an existing workspace

Rebuild the API, worker, and frontend images with `docker compose build`, then start them with `docker compose up -d`. Existing installations show **Upgrade model adapter** in the browser. The upgrade preserves the saved experiment, migrates its exact legacy planting pattern, backs up the previous installation, and keeps the original upstream backup. Unsaved browser edits remain available after upgrade. Modified managed adapter sources are refused rather than overwritten; reconcile those edits before upgrading. Existing run snapshots and downloadable artifacts are not rewritten.

Version 2 adds `planting` (explicit placements, generator settings, stable reporting IDs), `groups` (flat member IDs), `parameter_overrides`, and `temperature_overrides` (zero-based day keys). Version 1 configurations remain readable. Limits are 100 enabled central plants, 1,000 enabled border clones, and 200 environment objects. Border clones use the first enabled central plant.

### API endpoints

Read-only `GET /api/runs/{id}/inspection` returns inspection version, available inspection days, plant-state field definitions, resolved model inputs, and temperatures from that run's snapshot. Each completed v3 day publishes `inspection.json` with stable instance IDs, clone-source references, row-major Z-up transforms, and state. `plants.obj` retains world coordinates and adds `plant_<reporting_id>` object groups. Consumers undo the source transform to reuse geometry for border instances. Non-finite derived state becomes JSON null; canonical metrics keep their finite-value validation.

`GET /api/health`, `GET /api/config`, `POST /api/setup`, `PUT /api/config` (`{revision, config}`), `GET/POST /api/runs` (create: `{revision, name}`), `GET /api/runs/{id}`, `POST /api/runs/{id}/cancel`, `GET /api/runs/{id}/events` (SSE), `/metrics`, `/logs`, and `/artifacts/{path}`. A save or run with a stale revision returns 409. `GET /api/config` also reports `adapter.version`, `required_version`, `compatible`, and `upgrade_available`. `POST /api/setup` installs or upgrades the adapter. Read-only `POST /api/inputs/preview` accepts `{plant_input, temperature_input}` and returns parameter definitions/source values, daily temperatures, and the source revision. Read-only `POST /api/layout/preview` accepts `{simulation, room, pattern, plant_spacing, row_spacing, center, rotation}` and returns resolved planting data; null spacing derives from density.

`GET/POST /api/configurations` lists or creates named configurations (create: `{name, config}`); `GET/DELETE /api/configurations/{id}` reads or removes a saved file. `PATCH /api/runs/{id}` (`{name}`) renames a run. `DELETE /api/runs/{id}` removes a stopped run and its artifacts, returning 409 for queued or running jobs. Successful deletes return 204; missing records return 404.

Invalid configuration returns 422; unavailable GPU execution returns 503. Interrupted jobs become failed on worker restart; completed daily outputs stay available.

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

For version-1 upgrade and explicit-layout GPU checks, use the same isolated mounts with `python -m autotom.features_smoke` and a **fresh** check directory. This runs two-day migrated and custom staggered experiments, including moved border clones, nonsequential reporting IDs, parameter overrides, and daily temperatures.

For inspection acceptance, run `python -m autotom.inspection_smoke --reference /reference --output /checks` with the same isolated mounts. It creates a fresh temporary model, runs two days with overlapping/elevated/rotated central plants and a border clone, checks all state fields against canonical metrics, and compares reconstructed clone vertices with GroIMP's original scene. It prints `INSPECTION_RUN_DIR`; pass the local path to that run directory to the browser suite to enable its real-artifact inspector test.

For native-grid comparison, repeated-seed sampling checks, moved-lamp and opaque-panel tests, run the same command with `python -m autotom.acceptance` and a separate check directory. These checks copy and restore pristine sources from the adapter backup when necessary; they never modify the host model.

If a run fails, open **Log** in its progress strip. Missing NVIDIA devices usually indicate host driver/toolkit configuration. A two-minute model-start watchdog catches compilation/initialization failures; a six-hour run limit prevents a hung Java process from occupying the worker indefinitely. Cancellation stops the Java process group and retains finished days.

Upstream model: Micbut/FSP-model-dwarf-tomato, adapter baseline commit `2d727a3364f87392b3f8b74d8ff7127cc5090c3a`. GroIMP and GPUFlux retain their upstream licenses; the application license is in [LICENSE](LICENSE).
