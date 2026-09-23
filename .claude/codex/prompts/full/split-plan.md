MODULE SPLIT PLAN — Rust sidecar/core split and hardware profile (read-only analysis). Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English report.

HARD RULES: do NOT edit, move or delete any existing file; do not commit; never copy the repository; no /tmp. Builds only if needed for `cargo metadata`/`cargo tree` with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/analysis` (no full builds). The only file you create is `docs/builder-program/evidence/SPLIT-PLAN-2026-09-23.md` (scratch under `.build/split-plan/`, ≤ 50 MB, delete at the end).

## Read first
`docs/adr/0032-module-architecture-and-crs-declaration.md`, `docs/ARCHITECTURE.md` § Module map (the table is the target), `docs/CURRENT-DIRECTION.md` 2026-09-23 section.

## Goal
Produce an executable, stepwise plan to move from today's crates (`himmelcad-core`, `himmelcad-sidecar` ~117k lines / `main.rs` ~13.6k lines dispatching 152 protocol methods, `himmelcad-io`, `himmelcad-render`, `himmelcad-spatial`, `himmelcad-wasm`) to the ADR 0032 modules, so that a product binary links only the domain crates it selects.

## Analyse (with evidence: file paths, line counts, `use`/`mod` edges)
1. Module dependency graph inside `himmelcad-sidecar` and `himmelcad-core` (who uses whom via `use crate::…`/`use himmelcad_core::…`). Identify cycles that block a split and the smallest cut for each.
2. Assign every sidecar and core module to a target crate: kernel (protocol, command registry, jobs, process groups, workers), document (project store, archive, durable/publish fs), model, transform, and domain crates (photogrammetry, point cloud, surface/DGM, raster, registration, drafting — refine names/cut if the code suggests a better split). Say where the table in ARCHITECTURE.md is wrong for the code.
3. `main.rs` dispatch: how the 152 methods are routed today; design the registration mechanism (trait + static registry or builder in each product binary) that removes the central `match`, keeps the protocol wire format byte-identical, and keeps the generated command table (`scripts/generate-command-table.mjs`, `packages/@himmelcad/app/src/generated/commandTable.ts`) and the Python SDK generation consistent. Name the gates that prove wire compatibility (existing protocol/SDK tests, e2e scripts).
4. Product binaries: how Builder and PhotoLab each get a binary (or one binary with feature flags) — recommend one, with build-time/size/packaging consequences (release inventories under `scripts/`, electron-builder configs, portable MVS bin).
5. Hardware profile: inventory every hardware decision (`render::hardware_policy`, `render::gpu_calibration`, `sidecar::hardware_runtime`, the job memory plan in `core::photolab_jobs`/`job_runtime`/`dense_raster_prep`, Electron `apps/builder/electron/rendererFallback.ts` and GPU switches in both `electron/main.ts`, viewer backend selection). Propose the module (Rust crate + TS host part), the quirk-rule format, and how the untruthful "Hardware rendering" status chip gets its truth from it.
6. Legacy Three.js path: list the 19 viewer files and their consumers (apps, PhotoLab) and what blocks removal.
7. Dependency-direction check: propose the concrete check (cargo metadata + a TS import scan) and the initial allowlist of today's violations.

## Output: ordered steps
Each step: scope (files moved), expected diff size, risk, gates (exact commands: `cargo check -p … --tests --bins`, `cargo test -p …`, `pnpm … typecheck`, PhotoLab e2e contract tests, SDK drift check), and whether it can run in parallel with another step. Steps must each leave `main` green and must not change runtime behaviour. Estimate each step in Codex lane-hours (high effort), stating the basis. Mark which steps touch PhotoLab-owned modules (they will need a later port of fixes from branch `release/photolab-r1`).
Keep the report compact (target ≤ 2,500 words plus tables).
