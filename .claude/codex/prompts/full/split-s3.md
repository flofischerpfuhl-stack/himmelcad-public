SPLIT STEP 3 — model and prepared crates (lower contracts). Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English.

Read ONLY: `docs/adr/0032-module-architecture-and-crs-declaration.md`; `docs/ARCHITECTURE.md` § Module map; `docs/builder-program/evidence/SPLIT-PLAN-2026-09-23.md` (dependency cuts table, "Complete module placement", step 3); `docs/builder-program/evidence/SPLIT-S1-2026-09-23.md` and `SPLIT-S2-2026-09-23.md` (gates and corpus); then the code you move.

GOAL: create `crates/himmelcad-model` (object schema) and `crates/himmelcad-prepared` (renderer-neutral prepared artifact/hierarchy contracts) and move code into them so that `himmelcad-io` no longer depends on `himmelcad-render`, with zero behaviour change.

SCOPE
1. `himmelcad-model` receives from `himmelcad-core`: `hash`, `entity`, `entity_model`, `entity_validation`, `canonical_resource_catalog`, `canonical_resources`, `property_schema`, `geometry_representation_registry`, the renderer-neutral model part of `typed_artifact`, and the schema/DTO half of `release_05_admissions` (its admission algorithms stay in core for step 5). Move the TS binding generator (`src/bin/generate_entity_bindings.rs`, feature `ts-bindings`) with the types it exports, and update `packages/@himmelcad/data/package.json` `bindings:generate`/`bindings:check` to the new crate — generated TypeScript must be byte-identical. Resolve the SCC named in the split plan (document → model/validation; `EntityVersionRef` and object DTOs live in model; the `typed_artifact` ↔ registry test-only edge moves to an integration test). `canonical_document`, `entity_commands` and all `photolab_*` stay in core (later steps).
2. `himmelcad-prepared` receives the renderer-neutral types that `himmelcad-io` imports from `himmelcad-render` today (`DatasetId`, `HierarchySource`, `PreparedHierarchySource`, `TileId`, `ContentReference`, `DecodedTriangleFeatureId` and whatever they need), plus the renderer-neutral part of `typed_artifact` if that is where the plan puts it. Do NOT move sidecar modules in this step (dense_raster_prep, mesh_tiler, etc. come later). `himmelcad-render` depends on `himmelcad-prepared` and re-exports the moved types at their old paths.
3. Compatibility: `himmelcad-core` re-exports every moved module at its old path (`pub use himmelcad_model::entity_model;` …) and render re-exports prepared types, so existing consumers compile unchanged. Update direct consumers only where needed to break `himmelcad-io → himmelcad-render`; leave other consumer migrations for later steps and list them.
4. Module check: add the two crates to `scripts/module-layers.json` (model, prepared = foundation); remove the `himmelcad-io → himmelcad-render` allowlist entry (it must become stale and be deleted); do not add new allowlist entries except where a layer rule truly requires one — justify each. Where render/io/wasm can now depend on model/prepared instead of core, prefer that but do not force it if it widens the diff.

HARD RULES
- No schema, serde attribute, field order, default, algorithm or wire change. Serialized JSON and generated TS must be byte-identical (prove with `bindings:check`, the automation schema golden test, and the frozen sidecar corpus).
- Use `git mv` semantics (move files, keep history readable); do not rewrite moved code beyond `use` paths and visibility.
- Rust builds only with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split` and `-j 4` (16 GB cgroup). Never copy the repo; no /tmp; scratch only under `.build/split-s3/` (≤ 500 MB, delete at the end). Do not commit or push. Do not reformat unrelated code. Fix multi-line `use` lists by hand, never by regex.

GATES (run and quote verbatim)
- `cargo check --workspace --all-targets -j 4`
- `cargo test -p himmelcad-model -p himmelcad-prepared -p himmelcad-core -p himmelcad-io -j 4`
- `cargo test -p himmelcad-render --lib -j 4`
- `cargo check -p himmelcad-wasm --target wasm32-unknown-unknown -j 4` (if the target is installed; else say so)
- `cargo test -p himmelcad-core --test automation_schema_golden -j 4`
- `cargo test -p himmelcad-sidecar --test frozen_protocol_routes -j 4` and `cargo test -p himmelcad-sidecar --bins -j 4`
- `pnpm --filter @himmelcad/data bindings:check`; `pnpm check:modules`; `node scripts/generate-command-table.mjs --check`; `pnpm --filter @himmelcad/app test`; `pnpm photolab:test:e2e-contracts`; `pnpm --filter @himmelcad/viewer typecheck`; `cargo fmt --all --check`.
Report pre-existing failures separately with proof they fail on HEAD too.

EVIDENCE `docs/builder-program/evidence/SPLIT-S3-2026-09-23.md`: moved modules (from → to, lines), cuts made for each cycle, remaining consumers still using compatibility re-exports (list), allowlist diff, gates verbatim, what was NOT verified, PhotoLab-owned files touched (for the later port from `release/photolab-r1`), measured wall-clock time.
