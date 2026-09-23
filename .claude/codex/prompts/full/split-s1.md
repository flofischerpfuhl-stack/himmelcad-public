SPLIT STEP 1 — module dependency check + frozen protocol route evidence. Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English.

Read ONLY: `docs/adr/0032-module-architecture-and-crs-declaration.md`, `docs/ARCHITECTURE.md` § Module map, and `docs/builder-program/evidence/SPLIT-PLAN-2026-09-23.md` (sections "Dispatch, products and wire compatibility" and "Enforced direction and ordered execution", step 1). This step changes NO runtime behaviour, no schema, no algorithm, no serialization, no product code.

HARD RULES
- Rust builds only with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split` (external SSD; never target/builder or target/photolab). Never copy the repository or datasets; no /tmp; scratch only under `.build/split-s1/` (≤ 200 MB, delete at the end).
- Do not commit or push. Do not reformat unrelated code. Memory: this runs in a 16 GB cgroup; use `cargo … -j 4`.
- Another Codex lane is reading docs at the same time (read-only); do not touch `docs/` except your evidence file.

DELIVERABLES
1. `scripts/check-module-dependencies.mjs` (+ `scripts/module-layers.json` as the single layer map):
   - Rust: `cargo metadata --format-version 1 --no-deps`; classify every workspace crate into an ADR 0032 layer; fail on unknown crates, upward edges and domain→domain edges.
   - TypeScript: scan static and dynamic imports and `package.json` dependencies of every workspace package under `packages/@himmelcad/*` and `apps/*` (use the TypeScript compiler API already in the repo — no new dependency); classify by package/subpath; fail on UI→Electron, UI/foundation/display→domain or product, and imports of undeclared workspace packages.
   - Allowlist file `scripts/module-dependency-allowlist.json`: exact edges only (no wildcards, no transitive entries), each with a reason and the ADR 0032 step expected to remove it. Start from the split plan's list (Rust `io→render`, `sidecar→render`, temporary `render|io|sidecar|wasm→core`; TS `automation-host→agent`; `viewer` root→legacy barrel) and add whatever else the scan finds today, each justified. A stale allowlist entry (edge no longer present) must fail too, so the list only shrinks.
   - `pnpm check:modules` script in the root `package.json`; runtime < 15 s; add it to the commit verification tier in `scripts/verification/**` only if that tier's structure makes this a one-line, low-risk addition — otherwise report where it should go.
   - Self-test: `node --test` fixtures proving it fails on an upward edge, a domain→domain edge, an undeclared import and a stale allowlist entry.
2. Frozen route inventory for the step-2 registry seam:
   - A test (Rust, in `crates/himmelcad-sidecar/tests/` or a `#[cfg(test)]` module — whichever needs no production change) that extracts every protocol method string the sidecar dispatches today (prefix routing + all `match` blocks in `main.rs`) and compares it with a checked-in golden list `crates/himmelcad-sidecar/tests/golden/route-inventory.json` (method, handler family, product: builder/photolab/shared). Any added/removed route fails until the golden is updated deliberately.
   - Compare the golden with `schemas/automation/himmelcad-automation-v1.schema.json` / the generated command table and record the differences (transport-only routes, routes without schema rows) in the evidence file — do not fix them.
   - Differential fixture corpus: for deterministic, side-effect-free routes and for error paths (unknown method `-32601`, invalid params), record request → exact response bytes under `crates/himmelcad-sidecar/tests/golden/responses/` with a test that replays them against today's dispatcher. Cover at least one route per handler family; list uncovered families and why.
3. Evidence file `docs/builder-program/evidence/SPLIT-S1-2026-09-23.md`: files changed, the checker output on today's tree (all green with the allowlist), allowlist size per layer pair, route count per family/product, schema differences, gates run with verbatim results, what was NOT verified, and your measured wall-clock time.

GATES (run and quote results)
- `pnpm check:modules` and `node --test` for its fixtures.
- `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split cargo check -p himmelcad-sidecar --tests --bins -j 4` and the new sidecar tests (`cargo test -p himmelcad-sidecar --test <new> -j 4`).
- `node scripts/generate-command-table.mjs --check`; `pnpm --filter @himmelcad/app test`.
