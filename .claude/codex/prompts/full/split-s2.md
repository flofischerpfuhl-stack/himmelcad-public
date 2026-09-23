SPLIT STEP 2 — command registry seam (no route moves). Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English.

Read ONLY: `docs/adr/0032-module-architecture-and-crs-declaration.md`; `docs/ARCHITECTURE.md` § Module map; `docs/builder-program/evidence/SPLIT-PLAN-2026-09-23.md` ("Dispatch, products and wire compatibility", step 2); `docs/builder-program/evidence/SPLIT-S1-2026-09-23.md`; then the code you change.

GOAL: introduce the registration mechanism that later steps use to move route families out of `main.rs`, without moving any route yet and without changing a single byte on the wire.

HARD RULES
- No runtime behaviour, schema, algorithm, default or serialization change. No new external dependency.
- Rust builds only with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split` and `-j 4`. Never target/builder or target/photolab. Never copy the repository or datasets; no /tmp; scratch only under `.build/split-s2/` (≤ 500 MB, delete at the end).
- Do not commit or push. Do not reformat unrelated code. Other work may be committed on `main` while you run; touch only files your step needs.

DELIVERABLES
1. New crate `crates/himmelcad-command` (workspace member, layer `command` in `scripts/module-layers.json`): `CommandRegistry` with exact method strings, `RpcModule::register(&self, &mut CommandRegistry)`, handlers returning `Pin<Box<dyn Future<Output = RpcResponse> + Send>>` (or the sidecar's existing response type — reuse, do not redefine the wire types), duplicate registration fails at startup, unknown method keeps today's `-32601` bytes. A narrow context type exposes only what handlers need; do not move the sidecar's state types into the new crate yet unless required — prefer a generic/opaque context parameter.
2. `himmelcad-sidecar`: today's prefix routing + `match` blocks are wrapped as ONE legacy module registered through the registry (one handler per exact method string, all delegating to the existing functions, or a documented prefix-fallback if exact registration is impossible for some routes — list them). The request read/parse/write path and error mapping stay the single existing path.
3. Route inventory: the step-1 test `crates/himmelcad-sidecar/tests/frozen_protocol_routes.rs` currently scans `main.rs` text. Add a second inventory source that asks the registry (a test-only or `--list-routes` style entry point that does not change normal startup output) and assert BOTH equal the golden `route-inventory.json`. Later steps delete the text scan.
4. Differential corpus: extend `crates/himmelcad-sidecar/tests/golden/responses/` with SUCCESS-path fixtures, not only invalid-params errors: at least `ping`, every side-effect-free query you can drive deterministically (capabilities/version/list/status style routes), and one project lifecycle sequence (create/open → query → close) in a scratch directory under `.build/split-s2/`. Volatile fields (timestamps, generated ids, absolute paths) may be normalized only through an explicit, documented per-fixture rule; everything else is byte-exact. Record the corpus BEFORE your dispatcher change (on the current tree) and replay it after. Target ≥ 1 success fixture per handler family; list families without one and why.
5. `pnpm check:modules` stays green; the allowlist must not grow except for an edge `himmelcad-sidecar → himmelcad-command` if the layer map requires it (command→command is fine — justify any entry).
6. Evidence `docs/builder-program/evidence/SPLIT-S2-2026-09-23.md`: design (types, registration order, how prefix fallback works if any), files changed, fixture list with normalization rules, gates with verbatim results, what was NOT verified, measured wall-clock time.

GATES (run and quote)
- `cargo check -p himmelcad-command -p himmelcad-sidecar --tests --bins -j 4`; `cargo test -p himmelcad-command -j 4`; `cargo test -p himmelcad-sidecar --test frozen_protocol_routes -j 4`; the sidecar's existing unit tests `cargo test -p himmelcad-sidecar --bins -j 4` (report pre-existing failures separately with evidence they fail on HEAD too).
- `pnpm check:modules`; `node scripts/generate-command-table.mjs --check`; `python3.12 scripts/generate-automation-sdk.py --check` (or the repo's documented SDK drift check); `pnpm --filter @himmelcad/app test`; `pnpm photolab:test:e2e-contracts`.
- `pnpm test:pointcloud-registration-import` and `pnpm test:dxf-registration-import` if they run without a display; otherwise state why not.
