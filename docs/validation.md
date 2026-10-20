# Validation record

## Object inspection — 20 October 2026

- Follow-up plant-click fix: legacy combined meshes open an explicit plant chooser ordered by proximity, without asserting an inferred identity. Nine inspector regression tests and a read-only browser check against the running **High LED 1** saved simulation passed. The web image was rebuilt and the web container updated; saved results were unchanged.
- 68 backend tests passed, including verified v1/v2 adapter upgrades, snapshot-only inspection inputs, complete plant-state coverage, clone identity, and refusal to publish corrupt or incomplete inspection days.
- 43 browser tests passed, including simulation surface picking, independent/synchronized sparse timelines, playback, stale-request cancellation, legacy fallback, isolated camera interaction, mobile stacking, and real v3 GroIMP artifacts.
- TypeScript checking and the production Vite build passed. Build artifacts were written under `/tmp` for validation.
- The isolated two-day GPU acceptance run completed with overlapping central plants, reporting IDs 3 and 9, rotation/elevation, and a border clone. All 74 primitive PlantBase fields matched the exported contract; biomass state agreed with canonical daily metrics. Reconstructed clone vertices matched original GroIMP output within 0.00001213 m.
- Reproduce the GPU check with `python -m autotom.inspection_smoke --reference /reference --output /checks`. Use its printed run directory as `INSPECTION_RUN_DIR` for the real-artifact browser test. Existing host models and saved runs were left unchanged during validation.

## Original validation — 19 October 2026

The application was built and run entirely in Docker on an NVIDIA GeForce RTX 4070 Laptop GPU (driver 595.91.07, Docker 29.7.2). The worker uses GroIMP 2.2, Java 21, and the bundled GPUFlux 2.1.6 engine, with the documented diagnostic-parser compatibility patch.

## Automated checks

- **22 backend tests:** configuration validation; source backups and idempotent setup; unsupported-source refusal; external-edit conflicts; immutable snapshots; queue claim/cancellation/restart; typed HTTP APIs; origin/host and artifact-path checks; finite metrics; complete-day publication; coordinate/material conversion; actual subprocess cancellation and failure handling.
- **6 browser checks:** setup, pane navigation, immediate numeric updates, object creation/duplication/deletion, host-save requests, conflict/reload behavior, queue/cancel interactions, day slider and chart reporting, playback, downloads/logs, mobile layout, and a read-only test of real day-80 geometry/materials/charts with reload persistence.
- Production TypeScript/Vite build and Docker Compose image builds passed. API/worker/frontend recreation preserved the completed runs and their daily artifacts.

The normal browser suite isolates editor behavior with mocked HTTP responses. The additional `LIVE=1` test reads a real saved run and loads its actual GroIMP geometry and metrics.

## Expanded editor validation — 19 October 2026

- **50 backend checks:** includes version-1 migration with legacy border order and ID collisions, adapter upgrade/refusal/rollback, unchanged source CSVs, effective inputs and temperature coverage, typed preview APIs, invalid request handling, explicit scene validation, immutable snapshots, save rollback, and consistent migration of historical runs in HTTP and live-event responses.
- **16 frontend checks:** browser interactions and transform mathematics cover mixed groups, membership and reload persistence, numeric and actual gizmo movement, rotations and offsets, box selection of individual member origins, cancellation with Escape, undo/redo transactions, coefficient precision, parameter and temperature resets, layout generation, stable reporting IDs, result edit protection, and mobile layout. The optional saved day-80 live test remains opt-in.
- A read-only browser check against the running application verifies restoration of an older saved run, receipt of live updates, and reload without a blank screen or JavaScript exceptions. The regression also checks that historical stored configuration and snapshot bytes remain unchanged.
- Production API, worker, and frontend Docker images build successfully. The existing Three.js chunk-size advisory remains.
- Three isolated GPU experiments completed: a two-day one-plant smoke run; a two-day migrated 2×2 layout with border clones; and a two-day custom staggered layout with moved central/border items, elevated plants, nonsequential reporting IDs, raw architecture overrides, ray-depth/rockwool overrides, and daily-temperature overrides. All days exported geometry and finite positive plant growth metrics; border clones were excluded from reporting.
- Feature checks use disposable data directories and read-only reference mounts. Reproduce the two layout scenarios with `python -m autotom.features_smoke` using the isolated GPU-check mounts documented in the README and a fresh data directory.

## Real NVIDIA runs

| Check | Settings | Result |
| --- | --- | --- |
| Initial smoke | 3 days, 1 plant, 200,000 rays/day | Completed with geometry and finite, positive growth/light metrics on every day |
| Full timeline | 80 days, 1 plant, no border plants, 200,000 rays/day | All 80 daily exports and material/metric packages completed; fruit growth present |
| Live API-to-worker workflow | 3 days, 9 central plants, original border layout, 1,000,000 rays/day | Completed through the persistent queue; editor defaults restored immediately after snapshot submission |
| Native lamp-grid comparison | 1 day, fixed plant seed, 2,000,000 rays | Explicit LED scene and original GridLamp agreed within 0.19% using the same Flux seed |
| Independent Monte Carlo samples | Fixed plant morphology; Flux seeds 1, 2, 3 | Mean absorbed PAR 0.174456 µmol/s; sample standard deviation 0.005570 µmol/s |
| Lamps moved outside the closed room | Same plant and spectrum | Absorbed PAR 0; reduction exceeded five measured sample standard deviations |
| Opaque panel between lamps and canopy | Same plant and spectrum; 2 × 2 m panel, reflectance 0 | Absorbed PAR 0; reduction exceeded five measured sample standard deviations |

The day-80 validation plant had 53.0845 g total dry biomass, 42.0284 g fruit dry biomass, and 0.108815 m² leaf area. The corresponding saved run is available in the local dashboard as **Validation · 80 days · 200k rays**. A separate nine-plant three-day run is also available.

The full 80-day acceptance check used a reduced ray count. The default 80-day, nine-plant experiment at 21,474,000 rays/day has not been benchmarked here. Server hosting is configured through the optional authenticated Caddy profile; no public domain was provisioned or deployed.

## Reproduce

Follow the Docker test and GPU-check commands in [README.md](../README.md). The physics command is `python -m autotom.acceptance`; the full timeline command is `python -m autotom.smoke --days 80`. Use separate mounted check directories to keep acceptance runs outside the main application queue. For the real saved-output browser check in this workspace:

```bash
docker compose --profile test run --rm -e LIVE=1 browser-tests
```

Logs, screenshots, and browser reports are kept in ignored host directories under `data/`. The checked-in tests and commands reproduce the validation without committing generated simulation output.
