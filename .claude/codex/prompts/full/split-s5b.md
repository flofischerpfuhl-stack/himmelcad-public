SPLIT STEP 5b — point-cloud, surface and registration domains; decompose canonical_app_runtime. Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English.

Read ONLY: `docs/adr/0032-module-architecture-and-crs-declaration.md`; `docs/ARCHITECTURE.md` § Module map; `docs/builder-program/evidence/SPLIT-PLAN-2026-09-23.md` (placement tables, step 5); `docs/builder-program/evidence/SPLIT-S5A-2026-09-23.md`; then the code you move.

GOAL (zero behaviour change)
1. `crates/himmelcad-domain-pointcloud`: `pointcloud_ground`, `pointcloud_sampling`, `pointcloud_segment`, `pointcloud_export`, and the point-cloud command helpers inside `canonical_app_runtime`.
2. `crates/himmelcad-domain-surface`: core `mesh_surface` and sidecar `mesh_surface_runtime`. Surface must NOT depend on the point-cloud domain crate: move the types it consumes from point cloud (`GroundScope`, sampling result/dataset DTOs, …) down into `himmelcad-prepared` or `himmelcad-model` as neutral contracts. Its dependency on `CanonicalAppRuntime` is replaced by a narrow injected document-command interface (trait) defined in `himmelcad-document` or `himmelcad-command`.
3. `crates/himmelcad-domain-registration`: core `registration` and sidecar `import_registration_runtime`, plus registration helpers from `canonical_app_runtime`.
4. Shared algorithms used by more than one domain go to a foundation crate, never domain→domain: put `ground_classification` (SMRF) into `himmelcad-spatial` (or a new small foundation crate if spatial is the wrong home — explain), then move `dense_raster_prep` into `himmelcad-domain-raster` or `himmelcad-prepared` (the PhotoLab memory-sink coupling must go through an injected interface or stay behind a re-export — explain).
5. `canonical_app_runtime` (7k lines): split by command family into the owning crates. What remains in the sidecar is at most a thin orchestrator holding shared state and delegating to domain services. Route dispatch stays in the legacy registry module (route moves are step 6).
6. Compatibility re-exports at all old paths; list consumers. `scripts/module-layers.json`: new crates as `domain`. The checker must show zero domain→domain edges; the allowlist only shrinks.

HARD RULES
- No schema, serde, default, algorithm, file-format or wire change; journal/publish order, cancellation checks, progress coalescing and memory decisions move verbatim.
- Tests move verbatim — never change scratch paths, temp directories or timing bounds; test edits only for `use` paths. The total `#[test]`/`#[tokio::test]` count across `crates/` must stay 1,237 (report before/after).
- NEVER `git stash`, `git reset`, `git checkout -- <path>`. HEAD comparisons only via `git worktree add .build/split-s5b/head HEAD` (remove afterwards) with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split-head`.
- Rust only with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split` and `-j 4` (16 GB cgroup). Never copy the repo or datasets; scratch only under `.build/split-s5b/` (≤ 1 GB, delete at the end). Do not commit or push. Do not reformat unrelated code. Do not run `bindings:generate`. Fix multi-line `use` lists by hand.

GATES (run and quote verbatim)
- `cargo check --workspace --all-targets -j 4`; `cargo fmt --all --check`
- `cargo test -p himmelcad-domain-pointcloud -p himmelcad-domain-surface -p himmelcad-domain-registration -p himmelcad-domain-raster -p himmelcad-spatial -p himmelcad-prepared -p himmelcad-document -j 4`
- `cargo test -p himmelcad-sidecar --test frozen_protocol_routes -j 4`; `cargo test -p himmelcad-sidecar --bins -j 4`; `cargo test -p himmelcad-sidecar --lib -j 4 -- --test-threads=2` (known HEAD failure: `canonical_project_store::…group_commit_machine_gate…` timing; everything else must pass)
- `pnpm check:modules`; `pnpm test:pointcloud-registration-import` with the road scan `libs/polyshapev01/dist/PW_GHT_251215_Orscholz_Deponie-1-1.las` if the script accepts a source (read it; never copy the file); `pnpm test:dxf-registration-import`; `pnpm photolab:test:e2e-contracts`; `pnpm --filter @himmelcad/app test`; `pnpm --filter @himmelcad/builder test`
Report pre-existing failures with proof from the HEAD worktree.

EVIDENCE `docs/builder-program/evidence/SPLIT-S5B-2026-09-23.md`: moved items (from → to, lines), how canonical_app_runtime was decomposed, contracts moved down to avoid domain→domain, what stayed and why, compatibility consumers, allowlist diff, test counts, gates verbatim, what was NOT verified, measured wall-clock time.
