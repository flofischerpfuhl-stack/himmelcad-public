BROWSER BASELINE — did the ADR 0032 restructure change the headless viewer browser gates? Repo: /home/oem/Dokumente/003_Projekte/10_himmelcad. English. Measurement only: change NO tracked file.

Question: on current `main` (7f7d4a8 or later) `pnpm --filter @himmelcad/viewer test:browser-kernel-webgpu` fails with `[canonical-entity-zoo] GPU pick readback mapping failed: Error occurred when trying to async map a buffer` (Dawn, headless), and the WebGL2 gate needed more than its 30 s readiness timeout in one run. Is either new since the restructure, or already present on the last pre-restructure commit `02683e0`?

Steps
1. `git worktree add /media/oem/ZusatzSSD1/hc-baseline 02683e0` (external SSD — the internal disk is nearly full; never put the worktree or its build output under the repo or /tmp). In it: `pnpm install --frozen-lockfile --offline` (fall back to online only if offline fails; never upgrade), `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/baseline`.
2. In the baseline worktree run `pnpm --filter @himmelcad/viewer test:browser-kernel-webgl2` and `…-webgpu`, twice each. In the main repo (with `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/split`) run the same two gates twice each. Headless only; never `DISPLAY=:0`. Record per run: pass/fail, the exact error, time until the harness reports ready, total time, and the adapter/backend line the harness prints.
3. If the WebGPU failure also occurs on the baseline: say so — it is pre-existing. If it occurs only on main: bisect over the ADR 0032 commits (`git log --oneline 02683e0..HEAD`) using additional worktrees on the SSD (one at a time, removed after use) and name the first failing commit and the code difference that plausibly causes it (do not fix it).
4. Clean up: `git worktree remove` every worktree you created, delete `/media/oem/ZusatzSSD1/himmelcad-target/baseline` and any bisect target dirs, and check `git worktree list` shows only the main tree.

Rules: NEVER `git stash`, `git reset`, `git checkout -- <path>` in the main repo; no edits to tracked files; no commit/push. Before each build check `df -h / /media/oem/ZusatzSSD1`; stop if the SSD would drop below 10 GB free or `/` below 15 GB.

Report `docs/builder-program/evidence/BROWSER-BASELINE-2026-09-24.md` (the only file you create in the repo): table of all runs, verdict (pre-existing / introduced by <commit>), bisect log if any, cleanup confirmation, measured time.
