# V-08 — viewer fallback after GPU-process failure — 2026-09-10

Status: **implemented; shared viewer, app, PhotoLab, UI, theme, and registry gates pass. The
Builder aggregate test and typecheck gates are not green on the final worktree for the
concurrent-lane reasons recorded below, and the PhotoLab visual run stops at its existing export
confirmation timeout before completing the zero-error assertion.**

## Scope and decisions

This package implements the Vega 8 finding from WIN-02/WIN-03 without changing canonical scene
truth. The opt-in Builder policy is:

1. create/recreate the current backend once more;
2. fall back from WebGPU to WebGL2;
3. after WebGL2 and its one retry fail, surface a typed `softwareRenderingRequired` result to the
   Electron host;
4. atomically persist a per-machine software decision and use the existing canonical-project
   close handshake to relaunch once;
5. launch software WebGL2 through ANGLE SwiftShader and never re-enter the hardware ladder until
   the user explicitly chooses **View ▸ Renderer ▸ Try hardware rendering again**.

On Windows hardware launches, Builder sets `--use-angle=d3d11`; an explicit WebGL2 kernel
selection therefore uses the required ANGLE D3D11 path. The installed Electron is **43.1.0**
(`apps/builder/node_modules/.bin/electron --version` and the app manifest both report 43.1.0).
The software launch consequently uses all three switches:

```text
--use-gl=angle
--use-angle=swiftshader
--enable-unsafe-swiftshader
```

Electron 43's installed official declarations expose `app.on('child-process-gone', ...)` with
`details.type === 'GPU'`, `reason`, and `exitCode`; they no longer declare the deprecated
`gpu-process-crashed` event. Builder therefore handles the supported event and ignores only
`clean-exit`. `scripts/run-electron.mjs` needs no change because the switches are installed through
Electron's command-line API before `whenReady` and are therefore also present on relaunch.

The renderer settings file is `builder-settings.v1.json` under Electron `userData`. Writes use a
temporary file, file sync, and atomic rename. The session-scoped controller guards relaunches, and
a process started from a persisted software decision ignores further GPU-loss notifications. A
hardware retry clears the decision before requesting the one guarded relaunch.

The shared kernel behavior is deliberately opt-in through `backendFallback: { enabled: true }`.
Builder opts in; PhotoLab currently does not, so the shared-kernel change does not change PhotoLab
behavior before its launcher lane adopts the integration below.

## Implementation surfaces

- Fallback ladder, surface/device recovery, backend identity, and typed software handoff:
  `packages/@himmelcad/viewer/src/kernel/KernelViewerSession.ts` and `KernelViewport.tsx`.
- V-01 event: `KernelFrameDiagnostics.ts` stores the bounded exact event
  `backend.fallback { from, to, reason }` with its timestamp. Session diagnostics expose the
  current backend, while the V-01 snapshot exposes the fallback ring.
- Electron policy, persistent decision, Electron-43 flags, and one-relaunch guard:
  `apps/builder/electron/rendererFallback.ts`.
- Builder host wiring: `apps/builder/electron/main.ts` listens for GPU child loss, probes the GPU
  name/driver, forwards the retry choice, and relaunches only after `window:close-ready`.
  `preload.ts` exposes a data-only bridge and synchronously supplies the launch decision so the UI
  never briefly claims hardware rendering on a software launch.
- Builder viewport: `BuilderKernelViewport.tsx` queues an early process-loss notification until
  the kernel is ready, requests kernel recovery, forwards typed software-required failures to the
  host, and publishes backend fallback messages.
- Visible degraded state: `InteractionBars.tsx/.module.css` adds the bottom-bar renderer chip;
  the degraded label is exactly **Software rendering**, its foreground is
  `var(--hc-warning-fg)`, and its focusable tooltip is
  `<GPU> · driver <driver> · <reason>`. `ViewportHud.tsx` reports the live kernel backend.
- Recovery UI: `apps/builder/renderer/src/ribbon.ts` adds the Renderer group and the exact action
  **Try hardware rendering again**. It is disabled with an honest explanation during a hardware
  launch.
- Registry/catalog: `view.renderer.fallback` and `view.renderer.try-hardware` are present in both
  `REGISTRY.md` and the viewer command catalog with `owner: view-domain`.

No state-changing canonical command was introduced: renderer recovery is machine/session
configuration and does not mutate project data, history, coordinates, or residency authority.

## Tests added

- `packages/@himmelcad/viewer/test/kernel-backend-fallback.test.ts` mocks creation failures and
  verifies WebGPU retry, WebGPU → WebGL2, WebGL2 retry, typed software handoff, and that a software
  launch stays on WebGL2 without looping back to hardware.
- `packages/@himmelcad/viewer/test/kernel-frame-diagnostics.test.ts` verifies the exact bounded
  `backend.fallback` event.
- `apps/builder/test/rendererFallback.test.ts` verifies persisted Vega 8/driver/reason data, the
  three-stage GPU-loss policy, at most one relaunch request per session, no relaunch loop after a
  persisted software start, clearing through hardware retry, and the Electron 43 SwiftShader
  switches.

## PhotoLab-owned adoption handoff — exact current locations

No file under `apps/photolab` was edited by this lane. PhotoLab's owner should make the following
launcher/adapter changes against the current file positions; these are the exact integration lines
corresponding to Builder's implementation:

1. In `apps/photolab/electron/main.ts`, immediately after current line 70
   (`app.setName('HimmelCAD PhotoLab');`) and before current line 331, instantiate the PhotoLab-owned
   equivalent of the fallback store/controller and append launch switches before `whenReady`:

   ```ts
   const rendererFallbackStore = new PhotolabRendererFallbackStore(
     resolve(app.getPath('userData'), 'photolab-renderer-settings.v1.json'),
   );
   const launchRendererStatus = rendererFallbackStore.load();
   const rendererFallbackController = new PhotolabRendererFallbackController(rendererFallbackStore);
   if (process.platform === 'win32' && launchRendererStatus.mode === 'hardware') {
     app.commandLine.appendSwitch('use-angle', 'd3d11');
   }
   appendSoftwareRenderingSwitches(
     app.commandLine,
     launchRendererStatus,
     process.versions.electron,
   );
   ```

   Add `pendingRendererRelaunch` and `gpuIdentity` beside current lines 71–79, and add the
   `app.on('child-process-gone', ...)`, `handleGpuProcessGone`, `readGpuIdentity`, and
   session-controller calls equivalent to Builder `main.ts` lines 112–186. Do not add the removed
   `gpu-process-crashed` event on Electron 43.

2. At the start of `registerIpc()` (current line 557), add the exact channels used by the shared
   Builder UI contract:

   ```ts
   ipcMain.on('renderer:status-sync', (event) => {
     event.returnValue = rendererFallbackStore.status();
   });
   ipcMain.handle('renderer:status', () => rendererFallbackStore.status());
   ipcMain.handle('renderer:software-required', async (_event, reason: unknown) => {
     if (typeof reason !== 'string' || !reason.trim()) {
       throw new Error('renderer fallback reason is required');
     }
     gpuIdentity = await readGpuIdentity(gpuIdentity);
     const action = rendererFallbackController.requestSoftware(
       reason,
       gpuIdentity.gpu,
       gpuIdentity.driver,
     );
     if (action.kind === 'relaunchSoftware') requestRendererRelaunch();
     return action.kind === 'relaunchSoftware';
   });
   ipcMain.handle('renderer:try-hardware-again', () => {
     if (!rendererFallbackController.tryHardwareAgain()) return false;
     requestRendererRelaunch();
     return true;
   });
   ```

3. Preserve PhotoLab's durability boundary. Set `pendingRendererRelaunch = true` and enter its
   existing `app.quit()`/`beginShutdownDrain()` path; in the successful drain branch, immediately
   before the current `app.quit()` at the end of `beginShutdownDrain()` (currently lines
   2568–2569), insert exactly:

   ```ts
   if (pendingRendererRelaunch) app.relaunch();
   ```

   Do not relaunch from `forceQuit()` and do not bypass `photolab.project.close`.

4. In `apps/photolab/electron/preload.ts`, add a `renderer` member to
   `PhotolabDesktopApi` immediately after the current `window` member (lines 64–77), obtain
   `launchRendererStatus` immediately before current line 234 with
   `ipcRenderer.sendSync('renderer:status-sync')`, and add the renderer bridge immediately after
   the current `window` object (lines 237–255). The exact method/channel names are
   `launchStatus`, `status()` → `renderer:status`, `requestSoftwareFallback(reason)` →
   `renderer:software-required`, `tryHardwareAgain()` → `renderer:try-hardware-again`, and
   `onGpuProcessGone(listener)` → `renderer:gpu-process-gone`.

5. In `apps/photolab/renderer/src/PhotolabKernelViewport.tsx`, add the opt-in
   `backendFallback` prop at the current `KernelViewport` block (lines 640–650), subscribe to the
   preload GPU-loss event, call `session.recoverFromGpuProcessLoss(reason, action)`, and route a
   `KernelViewerSessionError` whose code is `softwareRenderingRequired` to
   `requestSoftwareFallback(error.message)`. Until these exact adapter lines are added, leaving
   the prop absent intentionally preserves PhotoLab behavior.

## Required verification

| Gate                                                             | Result                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @himmelcad/viewer test`                           | **Pass on final allowed attempt**, 164/164. Attempt 1 found implementation type errors; attempt 2 passed; attempt 3 passed after preserving the typed software handoff through recovery. No fourth run.                                                                                                                                                                                                                                              |
| `pnpm --filter @himmelcad/app test`                              | **Pass**, 79/79.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm --filter @himmelcad/builder test`                          | **Aggregate fail on attempt 3**, 44/45 pass. All three V-08 Electron tests passed before the final atomic-write rollback hardening. The only failure is a concurrently added `pointcloudSourcePredicates` test whose emitted `ribbon.js` cannot resolve `lucide-react` from `.build/tests/builder`; attempts 1–2 exposed that concurrent test's missing JSX/CSS test configuration. Three-run cap reached, so no post-hardening fourth run was made. |
| `pnpm --filter @himmelcad/builder typecheck`                     | **Not reverified after final integration correction.** Three attempts were used: the first two exposed test-project/preload configuration plus concurrent context-menu typing; the third had one remaining concurrent `onContextAction` command-id annotation, corrected to `CommandInvocation['id']` afterward. The cap prohibits a fourth run.                                                                                                     |
| `pnpm --filter @himmelcad/photolab typecheck`                    | **Pass**, including English-UI check.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm --filter @himmelcad/photolab test`                         | **Pass**: renderer 86/86, Electron 10/10, and both contract checks.                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm --filter @himmelcad/theme lint:tokens`                     | **Pass**; warning foreground usage accepted.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm registry:lint`                                             | **Pass** on attempt 2, all seven checks zero findings; attempt 1 identified the missing viewer catalog rows, which were added.                                                                                                                                                                                                                                                                                                                       |
| `pnpm --filter @himmelcad/ui test`                               | **Pass**, 48/48, including shared control accessibility fixtures.                                                                                                                                                                                                                                                                                                                                                                                    |
| PhotoLab dark visual harness, `--no-a11y --no-compare-baselines` | **Incomplete/fail** on attempts 1 and 2: both deterministically timed out waiting for the existing `Replace “Sparse Point Cloud”?` export confirmation at harness line 569. No GPU-device or page error was emitted before that unrelated timeout, but the harness did not reach its final zero-error assertion or capture report. No third run was spent.                                                                                           |
| `git diff --check`                                               | **Pass**.                                                                                                                                                                                                                                                                                                                                                                                                                                            |

No Builder window was started on `DISPLAY=:0`; the only visual attempts used the PhotoLab
headless-Chrome harness. The Windows remote lane was not used because its required git-only sync
cannot consume this intentionally uncommitted worktree. No repository or dataset copy was made,
and no commit was created.

## Worktree ownership note

This worktree also contains concurrent, unrelated PhotoLab-plan/Rust and Builder
point-cloud/context-menu changes. V-08 did not overwrite or revert them. The only V-08
accommodation outside its feature files is the Builder test TypeScript configuration needed for
the concurrently added ribbon-importing test; the aggregate failure above remains owned by that
test harness/module-resolution path.
