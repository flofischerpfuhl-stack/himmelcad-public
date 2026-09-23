SPLIT STEP 4b — kernel mechanics (jobs, cancellation, process groups, workers) and the remaining transform runtimes. Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English.

Read ONLY: `docs/adr/0032-module-architecture-and-crs-declaration.md`; `docs/ARCHITECTURE.md` § Module map; `docs/builder-program/evidence/SPLIT-PLAN-2026-09-23.md` (cuts, placement tables, step 4); `docs/builder-program/evidence/SPLIT-S4A-2026-09-23.md` (incl. "What stayed and why" and "Architect review"); then the code you move.

GOAL (zero behaviour change)
1. Into `crates/himmelcad-command` (already exists, holds the registry): `sidecar::process_group`, `sidecar::worker_toolchain`, the generic job supervision/admission part of `sidecar::job_runtime` (queue, concurrency slots, cancellation token, progress/checkpoint records, drain) and the generic cancellation/progress/checkpoint DTOs from `core::photolab_jobs`. PhotoLab job policy (stage vocabularies, memory models, product kinds) stays where it is for step 5. If a type is used by both generic and PhotoLab code, the generic definition moves and the old path re-exports it.
2. Then into `crates/himmelcad-transform`: `sidecar::{crs_runtime, crs_service, transform_runtime, transform_geometry_runtime}`, now that process groups and cancellation live below them. If one still needs sidecar-only state, leave it and record why.
3. Compatibility re-exports at every old path; list remaining consumers.
4. `scripts/module-layers.json` / allowlist: only shrink; justify anything else. `himmelcad-transform` (foundation) must not depend on `himmelcad-command` (command layer) — if the runtimes need cancellation/process types, put those minimal contracts in a lower crate (e.g. a small `himmelcad-process` foundation crate, or inside `himmelcad-transform`/`himmelcad-document` if they fit) and explain the choice in the evidence.

HARD RULES
- Cancellation, child-process reaping, SIGTERM/kill escalation, Windows job objects, drain deadlines and progress coalescing move verbatim. No schema, serde, default, algorithm or wire change.
- Tests move verbatim: do NOT change test scratch paths, temp directories or timing bounds (a previous step broke two tests that way). Test-only edits are limited to `use` paths.
- NEVER `git stash`, `git reset`, `git checkout -- <path>` or any command that rewrites the working tree or index beyond your own `git mv`. For a HEAD comparison use `git worktree add .build/split-s4b/head HEAD` (remove it afterwards) with its own `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split-head`.
- Rust only with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split` and `-j 4` (16 GB cgroup). Never copy the repo; no /tmp for your own scratch; scratch only under `.build/split-s4b/` (≤ 1 GB, delete at the end). Do not commit or push. Do not reformat unrelated code. Do not run `bindings:generate`. Fix multi-line `use` lists by hand.

GATES (run and quote verbatim)
- `cargo check --workspace --all-targets -j 4`; `cargo fmt --all --check`
- `cargo test -p himmelcad-command -p himmelcad-transform -p himmelcad-document -p himmelcad-core -j 4`
- `cargo test -p himmelcad-sidecar --test frozen_protocol_routes -j 4`
- `cargo test -p himmelcad-sidecar --lib --bins -j 4 -- --test-threads=2` (five timing tests are known to fail under full parallel load on HEAD: `canonical_project_store::…group_commit_machine_gate…`, three `colmap_runtime` cancellation tests, one `dedode_runtime` cancellation test — report them separately; every other test must pass)
- `pnpm check:modules`; `pnpm photolab:test:e2e-contracts`; `pnpm photolab:test:project-files`; `pnpm photolab:test:dialog-policy`; `pnpm --filter @himmelcad/app test`
Report pre-existing failures with proof from the HEAD worktree.

EVIDENCE `docs/builder-program/evidence/SPLIT-S4B-2026-09-23.md`: moved items (from → to, lines), what stayed and why, crate choice for process/cancellation contracts, compatibility consumers, allowlist diff, gates verbatim, what was NOT verified, PhotoLab-owned files touched, measured wall-clock time.
