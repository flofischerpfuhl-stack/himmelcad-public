# Browser baseline after ADR 0032

Date: 2026-09-24 (Europe/Berlin)
Baseline revision: `02683e0b`
Main measurement revision: `7f7d4a86`
Later main revision observed during reporting: `c0330c07` (documentation-only change to
`docs/ARCHITECTURE.md`; no measured viewer or renderer source changed)

## Verdict

Both reported behaviors are **pre-existing**; neither was introduced by the
ADR 0032 restructure.

- WebGPU reproduced the exact Dawn/headless failure twice at `02683e0b` and
  twice at `7f7d4a86`:
  `[canonical-entity-zoo] GPU pick readback mapping failed: Error occurred when trying to async map a buffer`.
- WebGL2 exceeded its 30 s readiness wait twice at `02683e0b`. At main it
  passed once only narrowly and timed out once. The readiness variability is
  therefore also present before the restructure.
- No bisect was run because the requested condition for bisecting (failure
  only on main) was false. The gate command and non-real browser fixture are
  materially unchanged across the comparison; the only change to
  `kernel-browser-e2e.mjs` switches the sidecar package used by optional
  `--real` mode.

## Method

All browser processes were headless. `DISPLAY` and `WAYLAND_DISPLAY` were
removed from every gate environment and `HCAD_HEADLESS=1` was set. Baseline
used `CARGO_TARGET_DIR=/media/oem/ZusatzSSD1/himmelcad-target/baseline`; main
used `/media/oem/ZusatzSSD1/himmelcad-target/split`.

An external, temporary Node preload timestamped the gate's own
`page.waitForFunction` completion and read the already-published harness state;
it did not alter repository files. “Observation” is elapsed time from the Node
runner start to `ready`, error, or timeout observation. The WebGL2 wait itself
is exactly 30,000 ms after navigation; process-relative timeout observations
are later because they include the build/bundle and browser-start work. Total
is `/usr/bin/time` wall time for the complete pnpm command.

The frozen offline baseline install first failed because
`@excalidraw/excalidraw@0.18.0` was absent from the local pnpm store. The frozen
online fallback installed the locked packages but twice hit transient GitHub
timeouts in the model postinstall. The two remaining pinned model artifacts
were copied from the main checkout; the final frozen install verified the
SHA-256 of all four models and completed without changing dependency versions.

## Runs

| Revision   | Gate   | Run | Result |                     Ready/error observation |    Total | Exact error / terminal state                                                                                | Adapter/backend reported by harness                                                                                                                                                                     |
| ---------- | ------ | --: | ------ | ------------------------------------------: | -------: | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `02683e0b` | WebGL2 |   1 | Fail   |             no ready; 30.000 s wait timeout | 394.96 s | `page.waitForFunction: Timeout 30000ms exceeded.`; phase `frames` (cold Rust release build: 5 min 59 s)     | `adapterName="ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"`, `deviceKind="cpu"`, `backend="webGl2"`, `driverInfo="WebGL 2.0 (OpenGL ES 3.0 Chromium)"` |
| `02683e0b` | WebGL2 |   2 | Fail   | 33.7094 s; no ready (30.000 s wait timeout) |  34.53 s | `page.waitForFunction: Timeout 30000ms exceeded.`; phase `frames`                                           | same WebGL2 adapter/backend line as run 1                                                                                                                                                               |
| `02683e0b` | WebGPU |   1 | Fail   |                             8.1009 s; error |   8.76 s | `[canonical-entity-zoo] GPU pick readback mapping failed: Error occurred when trying to async map a buffer` | `adapterName=""`, `deviceKind="cpu"`, `backend="webGpu"`, `driverInfo=""`                                                                                                                               |
| `02683e0b` | WebGPU |   2 | Fail   |                             7.1974 s; error |   7.92 s | same canonical-entity-zoo map error                                                                         | same WebGPU adapter/backend line as run 1                                                                                                                                                               |
| `7f7d4a86` | WebGL2 |   1 | Pass   |                            30.9167 s; ready |  36.06 s | phase `ready`; no error                                                                                     | same WebGL2 adapter/backend line as baseline                                                                                                                                                            |
| `7f7d4a86` | WebGL2 |   2 | Fail   | 39.0023 s; no ready (30.000 s wait timeout) |  40.05 s | `page.waitForFunction: Timeout 30000ms exceeded.`; phase `calibration`                                      | same WebGL2 adapter/backend line as baseline                                                                                                                                                            |
| `7f7d4a86` | WebGPU |   1 | Fail   |                             7.4675 s; error |   8.33 s | `[canonical-entity-zoo] GPU pick readback mapping failed: Error occurred when trying to async map a buffer` | same WebGPU adapter/backend line as baseline                                                                                                                                                            |
| `7f7d4a86` | WebGPU |   2 | Fail   |                             7.8372 s; error |   8.63 s | same canonical-entity-zoo map error                                                                         | same WebGPU adapter/backend line as baseline                                                                                                                                                            |

The eight measured gate commands consumed 539.24 s (8 min 59.24 s) of summed
wall time. This includes the baseline cold build; install and cleanup time are
not included.

## Bisect

Not applicable. Both failures reproduced at the last pre-restructure commit,
so no intermediate ADR 0032 worktree or bisect target directory was created.

## Cleanup

- Removed worktree `/media/oem/ZusatzSSD1/hc-baseline`.
- Removed `/media/oem/ZusatzSSD1/himmelcad-target/baseline` (690 MiB).
- Removed temporary timing instrumentation and run logs from the SSD.
- Created no bisect worktree or target directory.
- Final `git worktree list` contained only
  `/home/oem/Dokumente/003_Projekte/10_himmelcad` at `c0330c07 [main]`.
- Final free space was 41 GiB on `/` and 12 GiB on
  `/media/oem/ZusatzSSD1` as reported by `df -h`.
