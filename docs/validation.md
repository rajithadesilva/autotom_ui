# Validation record — 19 October 2026

The application was built and run entirely in Docker on an NVIDIA GeForce RTX 4070 Laptop GPU (driver 595.91.07, Docker 29.7.2). The worker uses GroIMP 2.2, Java 21, and the bundled GPUFlux 2.1.6 engine, with the documented diagnostic-parser compatibility patch.

## Automated checks

- **22 backend tests:** configuration validation; source backups and idempotent setup; unsupported-source refusal; external-edit conflicts; immutable snapshots; queue claim/cancellation/restart; typed HTTP APIs; origin/host and artifact-path checks; finite metrics; complete-day publication; coordinate/material conversion; actual subprocess cancellation and failure handling.
- **6 browser checks:** setup, pane navigation, immediate numeric updates, object creation/duplication/deletion, host-save requests, conflict/reload behavior, queue/cancel interactions, day slider and chart reporting, playback, downloads/logs, mobile layout, and a read-only test of real day-80 geometry/materials/charts with reload persistence.
- Production TypeScript/Vite build and Docker Compose image builds passed. API/worker/frontend recreation preserved the completed runs and their daily artifacts.

The normal browser suite isolates editor behavior with mocked HTTP responses. The additional `LIVE=1` test reads a real saved run and loads its actual GroIMP geometry and metrics.

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
