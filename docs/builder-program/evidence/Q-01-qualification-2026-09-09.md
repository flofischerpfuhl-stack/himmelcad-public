# Q-01 qualification — 2026-09-09

Status: **partial qualification; measured failures are retained, remaining gates NOT RUN**.

## Idle protocol and lane identity

The first idle gate passed at 09:18:06 CEST after waiting from 09:02:54: uptime load `0.46 / 1.43 / 3.50`, `free -g` reported 21 GiB free / 28 GiB available, only the two processes belonging to this Codex invocation were present, no `himmelcad-sidecar` e2e was present, and the earlier unrelated Playwright run had exited. The numeric baseline started at 09:20:31 with load `0.56 / 1.13 / 3.09`, 21 GiB free / 28 GiB available and the Quadro at 0% utilization.

Hardware/presentation for every baseline number below: NVIDIA Quadro M2200 4096 MiB, driver `580.173.02`; hardware WebGL2 through ANGLE/Vulkan; Class I policy; 1440×900, DPR approximately 1; `raf-render-complete` present source (not OS displayed time); 103,713,735-point Orscholz fixture, source SHA-256 `40ab61b68759d936553c5050f9be3ad84793e349828dfd5504472c0caec859f7`.

## Result table

| Gate | Result | Number / reason | Machine state beside result |
| --- | --- | --- | --- |
| Viewer orbit | **FAIL** | p50 26.6 ms; p95 161.0 ms; p99 181.3 ms; target p95 <=33.4 ms | 09:20:31 load 0.56/1.13/3.09; Quadro/WebGL2; `raf-render-complete` |
| Viewer pan | **FAIL** | p50 28.4 ms; p95 156.5 ms; p99 175.7 ms; target p95 <=33.4 ms | same baseline state |
| Viewer zoom | **FAIL** | p50 27.7 ms; p95 154.2 ms; p99 181.4 ms; target p95 <=33.4 ms | same baseline state |
| Viewer fly-through | **FAIL** | p50 27.7 ms; p95 163.4 ms; p99 177.8 ms; target p95 <=33.4 ms | same baseline state |
| `G-VC-TRANSITION` / 3D→2D→3D | **FAIL** | p50 156.0 ms; p95 206.0 ms; p99 206.0 ms; target p95 <=33.4 ms | same baseline state |
| Viewer at rest | **NOT RUN** | baseline has no separate converged-rest sample; target p95 <=25.0 ms | same adapter/present source; no number |
| VB-D7 | **NOT RUN** | final launcher stayed in the real lock path >61 min and emitted no report | 10:25:27 load5 1.92; 28 GiB available; Quadro; intended `raf-render-complete` |
| VB-D8 | **NOT RUN** | no locked/native-small p95 or ratio emitted | same VB state |
| `G-RW-SEGMENT` | **NOT RUN** | no complete presented-frame + <=1.1x native comparison launcher run | Quadro; intended `raf-render-complete`; no number |
| Draw snap latency | **NOT RUN** | no reviewed curb oracle; `__hcadDrawSnapLatency()` not sampled | Quadro; intended `raf-render-complete`; no number |
| Curb trace | **NOT RUN** | road scan exists, reviewed curb fixture does not | no coordinate truth invented |
| LOD continuity | **NOT RUN** | no real-fixture image-difference measurement | Quadro; intended `raf-render-complete`; no number |
| EDL cost delta | **NOT RUN** | no controlled same-state EDL-off/on measurement | Quadro; intended `raf-render-complete`; no number |
| `G-MT-3` | **NOT RUN** | one invocation: optimized build 11m15s; timed body reached fixture-ready at 0.189 s, then launcher exit 124 before a terminal result | 11:37:03 load 0.10/0.88/2.53; 28 GiB available; CPU compute; present source n/a |
| `G-MT-5` / MT-D17 | **NOT RUN** | fixture preflight found no `HCAD_MESH_TERRAIN_SCALE_FIXTURE` | 11:32:03 load 0.17/2.17/3.45; 28.75 GiB free; Quadro; present source n/a |
| Brandenburg | **NOT RUN** | no Brandenburg fixture archives or extracted fixture root exists | no measurement started |

## Baseline detail and gate interpretation

All five captured-path p95 values exceed 33.4 ms, so each captured run is a measured FAIL rather than optimization work. The transition's 206.0 ms p95 also fails the idle recheck. The landed launcher records one repetition per path; it does not yet implement §1.1/§3's five recorded runs and median-run selection, so these failures cannot be presented as a protocol-complete qualification pass. Exact frontier accounting stayed bounded: 206,008 selected points maximum, zero over-budget frames, zero decode backlog. WebGL2 exposed no GPU timestamp samples. Raw artifacts are `.build/perf/viewer-baseline-2026-09-09-q01.{json,md}`.

## Harness work and deviations

- `scripts/benchmark-builder-viewing-box.mjs` now waits for the live viewer session, uses the proven same-origin prepared-data route, and passes the current object-shaped diagnostics request. Two launches failed before sampling while these defects were found. One later launch was terminated after an unrelated Playwright job began during the run. The final idle launch exceeded 61 minutes without a report and was terminated to honor the three-hour package stop.
- `scripts/perf/viewer-baseline.mjs` remains a protocol limitation: one invocation samples each path once rather than producing the specified five-run median. It was not changed or rerun after the one-pass capture.
- Added `crates/himmelcad-sidecar/benches/mesh_terrain.rs` plus its Cargo bench registration for the named `G-MT-3` 1,000,000-point / 500-breakline timing. The target compiled; its sole bounded invocation exited 124 before terminal JSON, so partial phase output is not a gate number. Raw log: `.build/perf/mesh-terrain-g-mt-3-q01-2026-09-09.log`.
- Added `scripts/verify-mesh-terrain-scale.mjs`; its one fixture preflight returned `NOT RUN`, preserved in `.build/perf/mesh-terrain-scale-q01-2026-09-09.json`.
- No product tuning, dataset/repository copy, commit, or push was performed.

## Tooling verification

- `CARGO_TARGET_DIR=target/builder cargo check -p himmelcad-sidecar --bench mesh_terrain`: **PASS**.
- `rustfmt --check crates/himmelcad-sidecar/benches/mesh_terrain.rs`: **PASS**.
- `node --check scripts/benchmark-builder-viewing-box.mjs`: **PASS**.
- `node --check scripts/verify-mesh-terrain-scale.mjs`: **PASS**.
- `git diff --check`: **PASS**.
- `cargo fmt --all -- --check`: **NOT GREEN outside Q-01**; it requests a pre-existing one-line reflow in `crates/himmelcad-sidecar/src/canonical_app_runtime.rs:6518`. Q-01 did not modify that owner file.
