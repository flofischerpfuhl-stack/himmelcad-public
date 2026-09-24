SPLIT STEP 6a — per-domain route registration; remove the central dispatch. Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English.

Read ONLY: `docs/adr/0032-module-architecture-and-crs-declaration.md`; `docs/ARCHITECTURE.md` § Module map; `docs/builder-program/evidence/SPLIT-PLAN-2026-09-23.md` ("Dispatch, products and wire compatibility", step 6); `docs/builder-program/evidence/SPLIT-S2-2026-09-23.md` (registry seam, corpus); the "Architect review" sections of `SPLIT-S5B-2026-09-23.md` and `SPLIT-S5C-2026-09-24.md` (rejected constructs); then the code you change.

TODAY: `crates/himmelcad-sidecar/src/main.rs` (~13.7k lines) still routes all 163 methods through prefix routing + 13 `match` blocks; `legacy_routes.rs` registers every method string with one `LegacyRpcModule` that delegates to `handle()`.

GOAL (wire bytes unchanged)
1. Replace the legacy module with one `RpcModule` per handler family (the 18 families of `crates/himmelcad-sidecar/tests/golden/route-inventory.json`), each registering its exact method strings and calling its handler function directly — no central `match` and no prefix routing left. Handler code that only adapts wire requests to domain services lives in the sidecar under `src/routes/<family>.rs` (it needs the sidecar's shared state); domain logic stays in the domain crates. Group the modules by product: a `builder` set, a `photolab` set and a `shared` set (the golden already classifies each route).
2. Split `LegacyContext` into what each module needs (narrow context structs or accessor traits) so that a Builder route module does not receive PhotoLab runtimes and vice versa.
3. `main.rs` keeps only process start-up, transport (read/parse/write, progress, shutdown drain) and a `build_command_registry(selection)` that registers the shared set plus the product sets selected at start-up (for now: all sets, so behaviour is unchanged; step 6b adds the two binaries). Unknown methods keep today's `-32601` bytes; duplicate registration still fails at start-up.
4. Delete the text-scan inventory source from `frozen_protocol_routes.rs`; the registry inventory (`--list-routes`) must equal the golden exactly, and the product classification of every registered route must match the golden's `product` field.
5. Differential corpus: all 37 fixtures must replay byte-exact. Add fixtures for any family whose handler signature you changed and that has no success fixture yet, if it can be driven deterministically.

REJECTED CONSTRUCTS (checker enforces most): `include!` of files outside the crate; `#[macro_export]` in domain crates; macros expanding into another crate; `package =` renames; `extern crate self as …`; blanket foundation re-exports from domain crates; duplicate type definitions; a new catch-all/prefix fallback that re-creates central dispatch.

HARD RULES
- No schema, serde, default, error code/message, algorithm or wire change. Progress lines, cancellation routes, job ids and shutdown drain behave exactly as before.
- Tests move verbatim; Rust `#[test]`/`#[tokio::test]` count stays 1,237 except tests you add (report before/after and list additions).
- NEVER `git stash`, `git reset`, `git checkout -- <path>`; HEAD comparisons only via `git worktree add .build/split-s6a/head HEAD` with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split-head`; remove both afterwards.
- Rust only with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split` (never the repo's `target/`) and `-j 4`. The internal disk is nearly full: write nothing large under the repo; scratch only under `.build/split-s6a/` (≤ 500 MB), delete at the end. Do not commit or push. Do not run `bindings:generate`.

GATES (verbatim)
- `cargo check --workspace --all-targets -j 4`; `cargo fmt --all --check`
- `cargo test -p himmelcad-sidecar --test frozen_protocol_routes -j 4`; `cargo test -p himmelcad-sidecar --bins -j 4`; `cargo test -p himmelcad-sidecar --lib -j 4 -- --test-threads=2`; `cargo test -p himmelcad-command -j 4`
- `pnpm check:modules`; `node --test scripts/check-module-dependencies.test.mjs`; `node scripts/generate-command-table.mjs --check`; `pnpm --filter @himmelcad/app test`; `pnpm --filter @himmelcad/builder test`; `pnpm photolab:test:e2e-contracts`; `pnpm photolab:test:project-files`; the DXF registration smoke with its canonical fixture
- quote: `grep -c 'match method\|match req.method\|starts_with(\"' crates/himmelcad-sidecar/src/main.rs`, `wc -l crates/himmelcad-sidecar/src/main.rs crates/himmelcad-sidecar/src/routes/*.rs`, and the four rejected-construct greps.

EVIDENCE `docs/builder-program/evidence/SPLIT-S6A-2026-09-24.md`: module list per family with route counts and product set, context split, what `main.rs` still contains, corpus results, test counts, gates verbatim, what was NOT verified, measured wall-clock time.
