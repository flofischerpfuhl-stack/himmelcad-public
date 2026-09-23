SPLIT STEP 4a — document and transform crates. Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English.

Read ONLY: `docs/adr/0032-module-architecture-and-crs-declaration.md`; `docs/ARCHITECTURE.md` § Module map; `docs/TRANSFORMATIONS.md`; `docs/builder-program/evidence/SPLIT-PLAN-2026-09-23.md` (cuts table, placement tables, step 4); `docs/builder-program/evidence/SPLIT-S3-2026-09-23.md` (how step 3 moved code and kept compatibility paths); then the code you move.

GOAL: create `crates/himmelcad-document` and `crates/himmelcad-transform` and move the generic document and transform code into them with zero behaviour change. Job supervision, process groups and workers are NOT part of this step (that is 4b).

SCOPE
1. `himmelcad-document`: from core `canonical_document`, `entity_commands`, `canonical_json`, `project`; from sidecar `canonical_project_store`, `durable_fs`, `publish_fs`, and the generic (product-neutral) archive half of `project_archive` if it separates cleanly — if the split of `project_archive` would need behavioural surgery, leave it whole in the sidecar and record why. Resolve the `pointcloud_export` ↔ `product_export` cycle only if atomic replace moves to `publish_fs` here; otherwise record it for step 5.
2. `himmelcad-transform`: from core `transform`, `transform_geometry`, and the generic CRS declaration part of `photolab_crs` (PhotoLab-specific policy stays); from sidecar `crs_runtime`, `crs_service`, `grid_codecs` (+ `ggf`), `site_calibration_reader`, `transform_runtime`, `transform_geometry_runtime`. Move `GeometryTransformPolicy` beside the transform request DTOs to break the `transform` ↔ `transform_geometry` cycle. If a runtime module pulls sidecar-only state that cannot move without redesign, leave it and record why.
3. Compatibility: core and sidecar re-export moved modules at their old paths so the rest compiles unchanged; list remaining consumers of compatibility paths.
4. `scripts/module-layers.json`: both crates = foundation. Allowlist only shrinks; justify any new entry.

HARD RULES
- Crash safety is the risk here: durable write order, fsync calls, rename-publish sequences, journal/manifest write-ahead order and Windows-safe sync (PL-B1b) must be moved verbatim. No schema, serde, default, algorithm, file-format or wire change; persisted bytes must stay identical.
- `git mv` for moved files; change only `use` paths and visibility. Fix multi-line `use` lists by hand, never by regex.
- Rust only with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split` and `-j 4` (16 GB cgroup). Never copy the repo; no /tmp; scratch only under `.build/split-s4a/` (≤ 1 GB, delete at the end). Do not commit or push. Do not reformat unrelated code. Do not touch the 588 tracked compiled files under `packages/@himmelcad/data/src/generated/` (do not run `bindings:generate`).

GATES (run and quote verbatim)
- `cargo check --workspace --all-targets -j 4`; `cargo fmt --all --check`
- `cargo test -p himmelcad-document -p himmelcad-transform -p himmelcad-model -p himmelcad-core -j 4`
- `cargo test -p himmelcad-sidecar --test frozen_protocol_routes -j 4`; `cargo test -p himmelcad-sidecar --lib --bins -j 4` and every sidecar integration test under `crates/himmelcad-sidecar/tests/` that runs without datasets
- `cargo test -p himmelcad-core --test automation_schema_golden -j 4`
- `pnpm check:modules`; `pnpm photolab:test:e2e-contracts`; `pnpm photolab:test:project-files`; `pnpm photolab:test:dialog-policy`; `pnpm --filter @himmelcad/app test`; `pnpm --filter @himmelcad/builder test`
- `cargo check -p himmelcad-sidecar --target x86_64-pc-windows-msvc` only if that target is installed (else say so; Windows is verified later on the PC).
Report pre-existing failures separately with proof they fail on HEAD too.

EVIDENCE `docs/builder-program/evidence/SPLIT-S4A-2026-09-23.md`: moved modules (from → to, lines), what stayed and why, cycle cuts, compatibility consumers, allowlist diff, gates verbatim, what was NOT verified, PhotoLab-owned files touched (for the later port from `release/photolab-r1`), measured wall-clock time.
