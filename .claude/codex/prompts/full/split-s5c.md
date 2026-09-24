SPLIT STEP 5c — photogrammetry domain. Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English.

Read ONLY: `docs/adr/0032-module-architecture-and-crs-declaration.md`; `docs/ARCHITECTURE.md` § Module map; `docs/builder-program/evidence/SPLIT-PLAN-2026-09-23.md` (placement tables, step 5); `docs/builder-program/evidence/SPLIT-S5B-2026-09-23.md` incl. "Architect review" — it explains which constructs are rejected; then the code you move.

GOAL (zero behaviour change): create `crates/himmelcad-domain-photogrammetry` (layer domain) and move into it:
- from core: `photolab`, `photolab_batch`, `photolab_capture`, the PhotoLab-specific half of `photolab_crs`, `photolab_gcp`, `photolab_gcp_local_estimate`, `photolab_gcp_optimization`, `photolab_images`, the domain half of `photolab_jobs` (stage vocabularies, memory models, product kinds), `photolab_masks`, `photolab_matching`, `photolab_models` (hardware DTO/planning part may stay in core for step 7 — record it), `photolab_products`, `photolab_project`, `photolab_recipe`. Resolve the `photolab_capture` ↔ `photolab_images` cycle with one shared capture contract module.
- from sidecar: `alignment_merge_runtime`, `brush_runtime`, `camera_export`, `capture_runtime`, `colmap_feature_db`, `colmap_runtime`, `dedode_colmap_bridge`, `dedode_runtime`, `gcp_local_estimate_runtime`, `gcp_optimization_runtime`, `gcp_runtime`, `image_commit`, `image_mask_runtime`, `image_quality_runtime`, `mvs_runtime`, `mvs_scene`, `product_export`, the PhotoLab part of `job_runtime`, and `project_runtime` (20k lines; it is PhotoLab domain storage, binary-only `mod` today). If `project_runtime` needs sidecar-only state, give it narrow traits (as 5b did with `himmelcad-document::domain_commands`) implemented by the sidecar.
- `project_archive`: move the PhotoLab manifest validation into the domain crate behind an injected validator so the generic archive can move to `himmelcad-document`; if that is not possible without behaviour change, leave the archive whole and record why.
- The portable MVS binary (`src/bin/himmelcad-portable-mvs*` and its fusion code) stays where it is in this step (packaging is step 6); it may depend on the domain crate.
Photogrammetry may depend on foundation crates, `himmelcad-process`, `himmelcad-command` only if the layer map allows domain→command (it does not: domain sits below command) — so use `himmelcad-process` / `himmelcad-document` contracts instead. It must NOT depend on any other domain crate: consume raster/prepared/point-cloud results through contracts in `himmelcad-prepared` / `himmelcad-model`, or through a trait implemented by the sidecar.

REJECTED CONSTRUCTS (the checker enforces most; do not attempt): `include!` of files outside the crate; `#[macro_export]` in domain crates; macros or source files that expand into another crate; duplicate type definitions in two crates; widening the allowlist to hide an edge.

HARD RULES
- No schema, serde, default, algorithm, file-format or wire change. COLMAP/DeDoDe/MVS/Brush worker invocation, cancellation, memory envelope, journal/manifest write-ahead order, orphan quarantine and publication order move verbatim.
- Tests move verbatim — never change scratch paths, temp directories or timing bounds. Rust `#[test]`/`#[tokio::test]` count across `crates/` stays 1,237 (report before/after).
- NEVER `git stash`, `git reset`, `git checkout -- <path>`; HEAD comparisons only via `git worktree add .build/split-s5c/head HEAD` (remove afterwards) with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split-head`.
- Rust only with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split` and `-j 4` (16 GB cgroup). Never copy the repo or datasets; no COLMAP/MVS/real-data runs; scratch only under `.build/split-s5c/` (≤ 1 GB, delete at the end). Do not commit or push. Do not run `bindings:generate`. Fix `use` lists by hand.

GATES (verbatim)
- `cargo check --workspace --all-targets -j 4`; `cargo fmt --all --check`
- `cargo test -p himmelcad-domain-photogrammetry -p himmelcad-core -p himmelcad-document -p himmelcad-process -j 4`
- `cargo test -p himmelcad-sidecar --test frozen_protocol_routes -j 4`; `cargo test -p himmelcad-sidecar --bins -j 4`; `cargo test -p himmelcad-sidecar --lib -j 4 -- --test-threads=2` (known timing failure: group-commit p95 only)
- all sidecar integration tests under `crates/himmelcad-sidecar/tests/` that run without datasets
- `pnpm check:modules`; `node --test scripts/check-module-dependencies.test.mjs`; `pnpm photolab:test:e2e-contracts`; `pnpm photolab:test:project-files`; `pnpm photolab:test:dialog-policy`; `pnpm photolab:test:alignment-merge` if it runs without datasets; `pnpm --filter @himmelcad/photolab test`
- `grep -rn 'include!(' crates --include=*.rs` and `grep -rn macro_export crates/himmelcad-domain-*` quoted.

EVIDENCE `docs/builder-program/evidence/SPLIT-S5C-2026-09-24.md`: moved items (from → to, lines), traits introduced and where implemented, what stayed and why, compatibility consumers, allowlist diff, test counts, gates verbatim, what was NOT verified, measured wall-clock time. All of this is PhotoLab-owned code: list every moved file for the later port of fixes from `release/photolab-r1`.
