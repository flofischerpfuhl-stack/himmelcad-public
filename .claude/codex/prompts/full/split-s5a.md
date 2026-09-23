SPLIT STEP 5a — prepared-artifact producers and the raster domain (cut the eight-module cycle). Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English.

Read ONLY: `docs/adr/0032-module-architecture-and-crs-declaration.md`; `docs/ARCHITECTURE.md` § Module map; `docs/builder-program/evidence/SPLIT-PLAN-2026-09-23.md` (cuts table row "Eight-module sidecar SCC", placement tables, step 5); `docs/builder-program/evidence/SPLIT-S4B-2026-09-23.md`; then the code you move.

CURRENT EDGES (verify): `colmap_runtime` → {mesh_tiler, prepared_triangle_mesh(_ply), job_runtime, process_group, image_commit, …}; `raster_runtime` → {colmap_runtime, dense_raster_prep, viewer_raster_manifest, viewer_raster_surface_manifest}; `dense_raster_prep` → {colmap_runtime, ground_classification}; `mesh_tiler`/`viewer_raster_*_manifest` → raster_runtime summary DTOs; `prepared_triangle_mesh` → mesh_tiler.

GOAL (zero behaviour change)
1. Cut the cycle as the plan says: worker launching/limit mode that raster and dense prep borrow from `colmap_runtime` moves down to `himmelcad-command` workers (or `himmelcad-process` if it is a pure process contract); raster/mesh summary DTOs and prepared-hierarchy types move to `himmelcad-prepared`, so manifests and tilers no longer import `raster_runtime`.
2. Move into `himmelcad-prepared` (domain-neutral preparation): `mesh_tiler`, `prepared_triangle_mesh`, `prepared_triangle_mesh_ply`, `viewer_raster_manifest`, `viewer_raster_surface_manifest`, `splat_tiler`, and `dense_raster_prep` if its `ground_classification` use is a pure function call that can take an injected classifier or a lower contract; otherwise leave `dense_raster_prep` for step 5b and record why.
3. Create `crates/himmelcad-domain-raster` (layer domain) with `raster_runtime` and `orthophoto_prep` and their raster command handlers' helpers if they separate cleanly (routes stay registered through the legacy module in this step — do not move route dispatch yet).
4. `colmap_runtime` stays in the sidecar (photogrammetry is step 5c) but must now depend only downward on prepared/command/process, never the other way round. `himmelcad-prepared` must not depend on any domain crate or on `himmelcad-render`.
5. Compatibility re-exports at old sidecar paths; list consumers. `scripts/module-layers.json`: add the domain crate as `domain`. Allowlist only shrinks; the checker must reject domain→domain edges (none may appear).

HARD RULES
- Tile/manifest byte formats, hashes, atomic publish order, fsyncs, cancellation checks and memory envelope decisions move verbatim. No schema, serde, default, algorithm, file-format or wire change.
- Tests move verbatim — do not change scratch paths, temp directories or timing bounds; test edits only for `use` paths.
- NEVER `git stash`, `git reset`, `git checkout -- <path>`. HEAD comparisons only via `git worktree add .build/split-s5a/head HEAD` (remove afterwards) with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split-head`.
- Rust only with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split` and `-j 4` (16 GB cgroup). Never copy the repo or datasets; scratch only under `.build/split-s5a/` (≤ 1 GB, delete at the end). Do not commit or push. Do not reformat unrelated code. Do not run `bindings:generate`. Fix multi-line `use` lists by hand.

GATES (run and quote verbatim)
- `cargo check --workspace --all-targets -j 4`; `cargo fmt --all --check`
- `cargo test -p himmelcad-prepared -p himmelcad-domain-raster -p himmelcad-command -p himmelcad-process -j 4`
- `cargo test -p himmelcad-sidecar --test frozen_protocol_routes -j 4`; `cargo test -p himmelcad-sidecar --bins -j 4`; `cargo test -p himmelcad-sidecar --lib -j 4 -- --test-threads=2` (known HEAD failure: `canonical_project_store::…group_commit_machine_gate…` timing; every other test must pass)
- `pnpm check:modules`; `pnpm photolab:test:e2e-contracts`; `pnpm photolab:test:project-files`; `pnpm photolab:test:product-viewer` and `pnpm photolab:test:viewer-lifecycle` if they run headless (else say why); `pnpm --filter @himmelcad/app test`
Report pre-existing failures with proof from the HEAD worktree.

EVIDENCE `docs/builder-program/evidence/SPLIT-S5A-2026-09-23.md`: moved items (from → to, lines), how each cycle edge was cut, what stayed and why, compatibility consumers, allowlist diff, gates verbatim, what was NOT verified, PhotoLab-owned files touched, measured wall-clock time.
