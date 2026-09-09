# WIN-01 — Windows build and smoke (DESKTOP-BNB2PBA), 2026-09-09

Run on the Windows host in its existing clone `C:\Users\flori\source\HimmelCAD` at 059af79, 16:13–17:10 CEST, via the remote Codex channel (`.claude/codex/prompts/remote/win-01-build.md`). Full report and logs on the host under `.build\win-01\`.

| Step | Result |
| --- | --- |
| Git fast-forward to main | PASS (owner's `website/` files untouched) |
| Toolchain (Node 22.23, pnpm 9.12, Python 3.12, Rust 1.88 MSVC, Build Tools 2022 17.14, cl 19.44) | PASS; `vswhere -latest` returns empty, `-products *` finds it |
| `pnpm install --frozen-lockfile` | PASS (748 packages, lockfile unchanged) |
| root `pnpm typecheck` | PASS |
| `cargo check -p himmelcad-sidecar --tests --bins` | PASS, warnings only, no Windows-specific compile error |
| `cargo build --release -p himmelcad-sidecar --bins` | PASS in 23.8 min; `himmelcad-sidecar.exe` 42.7 MB |
| wasm staging | FAIL — both wasm crates compile, `wasm-bindgen` CLI absent |
| app / viewer tests | PASS 77/77, 159/159 |
| builder tests | FAIL 23/26 — `EPERM fsync` on a read-only handle (`apps/builder/electron/projectLifecycle.ts:93`) |
| Electron smoke | FAIL — directory fsync rejected on Windows → unhandled rejection before window creation |

Windows defects (Builder lane, S-07 durability): fsync through a read-only handle and directory fsync are not Windows-safe. Follow-up WIN-01b: install `wasm-bindgen-cli` at the pinned version, make the durability helper platform-correct (writable handle; directory fsync best-effort, skipped on win32), rerun tests and the Electron smoke, push the fix on branch `win/fsync-durability`.
