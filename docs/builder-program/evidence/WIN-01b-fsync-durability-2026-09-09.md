# WIN-01b — Windows-safe durability and Builder smoke (DESKTOP-BNB2PBA), 2026-09-09

Run 17:25–17:44 CEST on the Windows host in `C:\Users\flori\source\HimmelCAD` via the remote Codex channel (`.claude/codex/prompts/remote/win-01b-fsync-wasm.md`). Report and screenshot on the host under `.build\win-01b\` (`WIN-01b-report.md`, `builder-window.png`).

| Item | Result |
| --- | --- |
| `wasm-bindgen-cli` 0.2.120 installed (pinned version) | PASS — wasm staging passes on Windows |
| fsync on a read-only handle (`projectLifecycle.ts:93`) | FIXED — writable handle / after-write only |
| directory fsync on win32 | FIXED — best-effort, skipped on win32, EPERM/EISDIR/ENOTSUP tolerated; POSIX unchanged; unit test for both platforms |
| builder tests | PASS 25 passed, 2 skipped (was 23/1/2) |
| app tests / root typecheck | PASS 77/77 / exit 0 |
| Electron smoke | PASS — Builder window opens on Windows, screenshot captured |
| Commit | `1933da2` on branch `win/fsync-durability` (push from the host failed: no GitLab credential in the SSH logon session; transferred as a git bundle and pushed from the Linux host) |

Merge into main after R-02 lands (both touch Builder electron/project files).
