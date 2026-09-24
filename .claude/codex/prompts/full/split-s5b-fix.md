SPLIT STEP 5b-FIX — replace two fake splits with real ones. Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English.

Context: step 5b is in the working tree, uncommitted (`docs/builder-program/evidence/SPLIT-S5B-2026-09-23.md`). The architect rejected two constructs that only move source text while the code still compiles in the wrong crate, which the dependency checker cannot see:

A. `crates/himmelcad-core/src/{mesh_surface,registration}.rs` `include!` the source files of `himmelcad-domain-surface` / `himmelcad-domain-registration`, duplicating the types inside core (foundation). Cause: `himmelcad-io::canonical_provider` (foundation) and a sidecar bench use those types.
B. `himmelcad-domain-pointcloud` and `himmelcad-domain-registration` export `#[macro_export]` macros (`canonical_*_command_methods!`, files `canonical_command_runtime.inc.rs` included via `include!`) whose bodies are `impl CanonicalAppRuntime` methods referencing `crate::canonical_project_store`; they expand inside the sidecar. The code therefore still compiles in the sidecar.

FIX
1. A: move the registration/surface types that foundation crates (io, core) need down into `himmelcad-model` (or `himmelcad-prepared` for prepared artifacts) as neutral contracts; the domain crates use and re-export them; remove both `include!` files from core (keep old core paths only as `pub use` re-exports of the moved foundation types, never of domain crates). Point the bench and any other consumer at the right crate.
2. B: turn the macro-injected methods into real code in the domain crates: domain services (plain structs/functions) that operate on a narrow trait for the project-store/document operations they need (e.g. materialize verified path, read entity versions, append commands). Define that trait in `himmelcad-document` (or `himmelcad-command` if it is about jobs/progress); implement it in the sidecar for its existing store. `CanonicalAppRuntime` keeps thin delegating methods with the same names and signatures so callers and wire behaviour are unchanged. Delete the `.inc.rs` files and the exported macros.
3. Extend `scripts/check-module-dependencies.mjs` (with fixtures in `scripts/check-module-dependencies.test.mjs`) so it FAILS on: any `include!`/`include_str!`/`include_bytes!` whose path leaves the including crate's directory (except an explicit allowlist entry with reason; shaders/assets inside the crate are fine), and any `#[macro_export]` in a `domain` crate. Run it on the tree: it must be green after your fix.
4. Everything else from 5b stays as it is.

HARD RULES (unchanged from 5b)
- Zero behaviour, schema, serde, default, algorithm, file-format or wire change; tests move verbatim; total `#[test]`/`#[tokio::test]` count stays 1,237 unless you add checker fixtures (JS) — Rust count must not change.
- NEVER `git stash`, `git reset`, `git checkout -- <path>`; HEAD comparisons only via `git worktree add .build/split-s5b-fix/head HEAD` (remove afterwards).
- Rust only with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split` and `-j 4`. No repo/dataset copies; scratch only under `.build/split-s5b-fix/`, delete at the end. Do not commit or push. Do not run `bindings:generate`. Fix `use` lists by hand.

GATES (verbatim)
- `cargo check --workspace --all-targets -j 4`; `cargo fmt --all --check`
- `cargo test -p himmelcad-model -p himmelcad-io -p himmelcad-core -p himmelcad-document -p himmelcad-domain-pointcloud -p himmelcad-domain-surface -p himmelcad-domain-registration -j 4`
- `cargo test -p himmelcad-sidecar --test frozen_protocol_routes -j 4`; `cargo test -p himmelcad-sidecar --bins -j 4`; `cargo test -p himmelcad-sidecar --lib -j 4 -- --test-threads=2` (known timing failure: group-commit p95 only)
- `pnpm check:modules`; `node --test scripts/check-module-dependencies.test.mjs`; `pnpm test:dxf-registration-import`; `pnpm --filter @himmelcad/builder test`; `pnpm photolab:test:e2e-contracts`
- `grep -rn 'include!(' crates --include=*.rs` and `grep -rn macro_export crates/himmelcad-domain-*` outputs quoted.

EVIDENCE: append a section "5b-fix" to `docs/builder-program/evidence/SPLIT-S5B-2026-09-23.md`: what moved to model/prepared, the trait(s) and where implemented, checker rule change, gates verbatim, measured time.
