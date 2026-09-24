SPLIT WASM-FIX — make the viewer's WASM build and the Windows build green again. Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English. PRIORITY: `pnpm --filter @himmelcad/builder dev` is broken on `main` because the viewer WASM no longer compiles.

FACTS (verify)
- `cargo check -p himmelcad-wasm --target wasm32-unknown-unknown` fails: `himmelcad-wasm` → `himmelcad-core` → `himmelcad-document` → {`fs2`, `himmelcad-process` (tokio with net → mio)}; and `himmelcad-render` → `himmelcad-prepared` → `himmelcad-document`. `durable_fs.rs` has only `cfg(unix)`/`cfg(windows)` branches (`file` undefined on wasm). Before ADR 0032 the WASM closure contained no project store, no tokio, no file locking.
- Windows: `himmelcad-document` used `tracing::debug!` under `cfg(windows)` without the dependency (WIN-23, `.claude/codex/out/remote-win-23.last.md`). The working tree already contains the architect's partial fix: `tracing.workspace = true` and `fs2` as a non-wasm target dependency in `crates/himmelcad-document/Cargo.toml`, and `#[cfg(not(target_arch = "wasm32"))]` on `canonical_project_store` in its `lib.rs`. Keep or replace these as the design requires.

GOAL — a clean dependency closure, not cfg sprinkling:
1. The display layer (`himmelcad-render`, `himmelcad-wasm`, `himmelcad-decode-wasm`) must reach only wasm-safe crates: `himmelcad-model`, the renderer-neutral DTO part of prepared, `himmelcad-spatial`, `himmelcad-transform` only if wasm-safe. Never `himmelcad-document`, `himmelcad-process`, `himmelcad-command`, `himmelcad-core`, any domain crate, tokio, fs2 or zip.
2. Split `himmelcad-prepared` if needed: keep renderer-neutral DTOs/manifests in `himmelcad-prepared` (wasm-safe, no document/process dependency) and move the native producers (tilers, publishers, anything that writes files or needs document/process) into a new foundation crate such as `himmelcad-prepared-build`. Re-export at old paths only from the producer crate to native consumers.
3. `himmelcad-wasm` depends on `himmelcad-model`/`himmelcad-prepared` instead of `himmelcad-core` (update imports); remove the `wasm → core` and `render → core` style edges if they still exist (allowlist only shrinks).
4. Extend `scripts/check-module-dependencies.mjs` (+ fixtures): display-layer crates must not reach `himmelcad-document`, `himmelcad-process`, `himmelcad-command`, `himmelcad-core` or any domain crate through their NORMAL dependency closure (transitively, via `cargo metadata` resolve graph).
5. Windows: `himmelcad-document` builds for Windows; fix any other `cfg(windows)` code in the ADR 0032 crates that lost a dependency or import in the move (the gnullvm check below shows them). Remove the unused-import warnings in `himmelcad-process/src/worker.rs` that only appear on Windows only if the fix is a pure `cfg` on the import.

HARD RULES
- Zero behaviour, schema, serde, wire or file-format change; tests move verbatim; Rust `#[test]`/`#[tokio::test]` count stays 1,237 (report).
- Rejected constructs as in earlier steps (cross-crate `include!`, domain `macro_export`, `package =` renames, `extern crate self as`, blanket foundation re-exports from domain crates, duplicate types).
- NEVER `git stash`, `git reset`, `git checkout -- <path>`. Rust only with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split` and `-j 4`. Scratch only under `.build/split-wasm-fix/`, delete at the end. Do not commit or push. Do not run `bindings:generate`.

GATES (verbatim)
- `cargo check -p himmelcad-wasm -p himmelcad-render -p himmelcad-decode-wasm --target wasm32-unknown-unknown -j 4`
- `pnpm --filter @himmelcad/builder prepare:viewer:dev` and `pnpm --filter @himmelcad/photolab` viewer staging equivalent (read the package.json) — the WASM must build and stage
- `pnpm --filter @himmelcad/viewer test:browser-kernel-webgl2` and `test:browser-kernel-webgpu` headless (no `DISPLAY=:0`; use the repo's headless path) — report results
- Windows cross-check: `PATH="$PWD/.build/llvm-mingw/llvm-mingw-20260407-ucrt-ubuntu-22.04-x86_64/bin:$PATH" cargo check --target x86_64-pc-windows-gnullvm -p himmelcad-builder-sidecar -p himmelcad-photolab-sidecar --all-targets -j 4` — zero errors
- `cargo check --workspace --all-targets -j 4`; `cargo fmt --all --check`; `cargo test -p himmelcad-prepared -p himmelcad-document -p himmelcad-render -j 4 -- --test-threads=2` (plus the producer crate if created); `cargo test -p himmelcad-sidecar -p himmelcad-builder-sidecar -p himmelcad-photolab-sidecar -j 4 -- --test-threads=2`
- `pnpm check:modules`; `node --test scripts/check-module-dependencies.test.mjs`; `pnpm --filter @himmelcad/builder test`; `pnpm --filter @himmelcad/viewer test`
- quote `cargo tree -p himmelcad-wasm --target wasm32-unknown-unknown -e normal | grep -o 'himmelcad-[a-z-]*' | sort -u`

EVIDENCE `docs/builder-program/evidence/SPLIT-WASM-FIX-2026-09-24.md`: root cause (which step introduced each edge), crate changes, new checker rule, WASM and Windows results, test counts, gates verbatim, what was NOT verified, measured time.
