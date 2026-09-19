# R-02g Builder testability and ribbon reachability sweep — 2026-09-19

## Scope and result

This pass finished only R-02f items (1), (2), and (4), as narrowed by the
2026-09-19 owner rule. It did not change domain rules or add product features.
The three reverted DGM files were not touched.

- Builder now has a FIFO native-dialog responder for private-display tests.
  `HIMMELCAD_TEST_DIALOG_QUEUE` is ignored inside the responder whenever
  `app.isPackaged` is true. With no queue configured, every dialog still uses
  Electron's native implementation. Queue writes and reads share the same
  atomic lock protocol and each consumed response logs `dialog.responded`.
- Import now presents the shipped state: title **Import**, muted line **Choose
  files to import…**, and the shared secondary medium **Choose files…** button
  (the shared medium button is 28 px). Cancelling the picker closes Import and
  restores the preceding function tab.
- New/Open/Close retire the project interaction state before replacement:
  construction input, draw and measurement tools, placement/fence state, HUD
  overlays, selection, and all function tabs. The actual New, Open, and Close
  UI flows each produced the all-false state recorded below.
- Box and Lasso are the only genuinely unshipped ribbon entries. Both are
  disabled and explain why. Other disabled states in the matrix are dynamic
  prerequisites, not release-status claims.

The first live start exposed a renderer-wide testability crash: re-exporting
the responder initially pulled a top-level `node:fs` import into Vite's browser
bundle, leaving a blank app. The responder now loads Node modules only inside
its Electron-only file operations. During the road sweep, restored 2D camera
state also failed to update ribbon availability and preset promises were not
awaited. The smallest repair publishes restored navigation mode to the existing
store and awaits preset commands; the viewport's 2D rule itself is unchanged.

## Literal UI setup and artifacts

The run used `scripts/ui-test-display.sh`; the owned fresh profile ran on
private `DISPLAY=:90` with CDP `127.0.0.1:9323`, never `DISPLAY=:0`.
`BACKEND_ATTEMPT=vulkan-webgl2`; `gpu-proof.json` and
`process-displays.txt` are under
`.build/ui-test-display/20260919T183151Z-391994/`. The dialog queue was
`.build/r02g/dialogs.json`.

The road source was used in place:
`libs/polyshapev01/dist/PW_GHT_251215_Orscholz_Deponie-1-1.las`. Import showed
the source CRS `EPSG:31466`, metre units, and zero offset; **No transformation**
was chosen explicitly. The imported cloud became resident before the road
pass. No coordinates, height, scale, or CRS transform were invented.

Key captures:

- `.build/r02g/01-import-panel.png` — shipped Import panel while the queued
  picker is held.
- `.build/r02g/02-close-cleared.png` — empty-project Close after an armed tool.
- `.build/r02g/03-road-registration.png` through `06-road-resident.png` — real
  LAS registration, explicit placement choice, commit, and resident cloud.
- `.build/r02g/07-scan-close.png` — road-project Close after an armed tool.
- `.build/r02g/08-regression-proof.png` — restored 2D mode after reload, with
  invalid presets disabled.
- `.build/r02g/09-import-cancel-restores.png` — after queued cancellation,
  Point Size is again the sole selected function tab (`aria-selected=true`).

`empty-sweep.json` and `scan-sweep.json` retain the raw observations. The
road JSON intentionally retains the three pre-fix page errors; the targeted
post-fix rerun reported `errors: []`, Front disabled both before and after a
full reload, and tooltip `Available in 3D or 2.5D navigation.`
The generated 3.0 GB scratch `scan-sweep.hcad` was removed after the run; the
read-only source LAS remains in its original location and was never copied as a
separate fixture.

## Complete ribbon matrix

“Shipped” means the entry reaches an already implemented function. “Disabled”
without a qualifier means intentionally unshipped. “Prerequisite-disabled” is
a shipped command that cannot run in that test state. Cancelled native dialogs
are honest silent no-ops. No command crashed the process in either pass.

| Ribbon command | Release disposition | Empty project | Road LAS project | Console / finding |
| --- | --- | --- | --- | --- |
| `project.new` | Shipped | Opens; transition clears all interaction state | Silent no-op (queued cancel) | None |
| `project.open` | Shipped | Opens; transition clears all interaction state | Silent no-op (queued cancel) | None |
| `project.recent` | Shipped | Opens | Opens | None |
| `project.save` | Shipped | Opens | Opens | None |
| `project.snapshots` | Shipped | Opens | Opens | None |
| `project.save_as` | Shipped | Silent no-op (queued cancel) | Silent no-op (queued cancel) | None |
| `project.close` | Shipped | Opens; all cleanup probes false | Opens; all cleanup probes false | None |
| `file.import` | Shipped | Silent no-op (queued cancel) | Silent no-op (queued cancel) | Prior Point Size tab restored in post-fix proof |
| `entity.export` | Shipped | Opens | Opens | None |
| `automation.agent` | Shipped | Opens | Opens | Floating island has no visible close affordance; see findings |
| `project.undo` | Shipped | Opens with handled refusal | Opens | Empty console: `Undo unavailable: ... owner EntityId("project-root") ... EntityId("snapshot-1-1789842918276") does not exist` |
| `project.redo` | Shipped | Opens with handled refusal | Opens | Empty console: `Redo unavailable: ... there is no document change to redo` |
| `view.frame` | Shipped | Silent no-op (already framed) | Silent no-op (already framed) | None |
| `view.preset.top` | Shipped | Opens | Silent no-op (already top) | None |
| `view.preset.front` | Shipped | Opens | Final: prerequisite-disabled in restored 2D | Pre-fix unhandled `This preset requires 3D or 2.5D navigation.`; fixed and targeted rerun clean |
| `view.preset.right` | Shipped | Opens | Final: prerequisite-disabled in restored 2D | Same pre-fix error and fix as Front |
| `view.preset.perspective` | Shipped | Opens | Final: prerequisite-disabled in restored 2D | Same pre-fix error and fix as Front |
| `view.3d` | Shipped | Silent no-op (already 3D) | Opens | None |
| `view.2.5d` | Shipped | Opens | Opens | None |
| `view.2d` | Shipped | Silent no-op (already 2D at invocation) | Silent no-op (already 2D at invocation) | None |
| `view.camera.undo` | Shipped | Silent no-op (no earlier camera state) | Silent no-op (history edge) | None |
| `view.camera.redo` | Shipped | Silent no-op (history edge) | Silent no-op (history edge) | None |
| `view.display.undo` | Shipped | Silent no-op (no display edit) | Silent no-op (no display edit) | None |
| `view.display.redo` | Shipped | Silent no-op (no display edit) | Silent no-op (no display edit) | None |
| `view.viewing-box` | Shipped | Opens | Opens | None |
| `view.bookmark.create` | Shipped | Opens | Opens | None |
| `view.bookmark.restore` | Shipped | Opens | Opens | None |
| `view.point-size` | Shipped | Opens | Opens | None |
| `view.hud.toggle` | Shipped | Opens | Opens | None |
| `view.renderer.try-hardware` | Shipped, prerequisite-disabled | Disabled: hardware already enabled | Disabled: hardware already enabled | Tooltip: `Hardware rendering is already enabled.` |
| `select.box` | **Disabled / unshipped** | Disabled | Disabled | Tooltip: `Box selection is not available in this release.` |
| `select.lasso` | **Disabled / unshipped** | Disabled | Disabled | Tooltip: `Lasso selection is not available in this release.` |
| `pointcloud.ground.extract` | Shipped, prerequisite-disabled empty | Disabled | Opens | Empty tooltip: `Select one resident point cloud.` |
| `pointcloud.rasterize` | Shipped, prerequisite-disabled empty | Disabled | Opens | Empty tooltip: `Select one resident point cloud.` |
| `pointcloud.fence.begin` | Shipped, prerequisite-disabled empty | Disabled | Opens | Empty tooltip: `Select one resident point cloud.` |
| `pointcloud.sample` | Shipped, prerequisite-disabled empty | Disabled | Opens | Empty tooltip: `Select one resident point cloud.` |
| `draw.line` | Shipped | Opens | Opens | None |
| `draw.polyline` | Shipped | Opens | Opens | None |
| `draw.boundary` | Shipped | Opens | Opens | None |
| `mesh.surface.create` | Shipped | Opens | Opens | Empty draft reports `0 errors · 0 fixable`; no DGM code changed |
| `mesh.edit.smooth` | Shipped | Opens with handled prerequisite message | Opens with handled prerequisite message | `Edit surface requires one selected DGM.` |
| `measure.point` | Shipped | Opens | Opens | None |
| `measure.distance` | Shipped | Opens | Opens | None |
| `measure.dz` | Shipped | Opens | Opens | None |
| `measurement.list` | Shipped | Opens | Opens | None |
| `output.specs` | Shipped | Opens | Opens | None |
| `output.plan` | Shipped | Opens | Opens | None |

The raw road sweep invoked every command that the pre-fix ribbon advertised as
enabled. The post-fix proof established that the three illegal 2D presets are
now disabled after state restoration, so they are not dead enabled entries.

## Project-transition cleanup result

The Close probes in both projects, plus actual New and Open replacements from
an armed Line/Point state, produced:

| State after transition | New | Open | Close (empty) | Close (road) |
| --- | --- | --- | --- | --- |
| Construction bar | Clear | Clear | Clear | Clear |
| Function tabs | Clear | Clear | Clear | Clear |
| Selection | Clear | Clear | Clear | Clear |
| HUD overlays | Clear | Clear | Clear | Clear |
| Armed placement / active ribbon action | Clear | Clear | Clear | Clear |

The helper retires these owners in Escape-ladder order: construction draft,
armed draw, armed measurement, placement state, HUD/preview state, selection,
then function tabs. Failed project replacement retains the existing recovery
path; the lifecycle retirement itself does not mutate domain data.

## Findings deliberately not changed

1. On one fresh empty project, Undo reported a handled canonical-owner refusal
   for a snapshot whose owner `project-root` did not exist; Redo then correctly
   reported that there was no change. This did not crash or reject outside the
   handler. It may be affected by the concurrent canonical-project changes in
   the landed tree, so this pass records it instead of changing domain logic.
2. The Agent island has no visible close affordance and Export/Agent islands can
   overlap ribbon hit targets. The sweep used Escape and, where necessary, one
   reload. This is a workflow issue outside the testability-only correction.
3. PhotoLab still calls native dialogs directly in
   `apps/photolab/electron/main.ts` at line clusters 596–637, 701–732, 802–892,
   980–1037, 1135–1185, 1264–1520, and 1726–1727. Builder owns this delivery;
   PhotoLab should adopt the shared responder in its own lane rather than this
   pass editing PhotoLab-owned files.

## Gates

| Gate | Result |
| --- | --- |
| `pnpm --filter @himmelcad/app test` | **PASS**, 83/83; includes FIFO, packaged-build no-read/no-consume, and mismatch/no-consume responder tests |
| `pnpm --filter @himmelcad/builder test` | **PASS**, 53/53; includes Import panel, project retirement, and unshipped ribbon availability tests |
| `pnpm --filter @himmelcad/ui test` | **PASS**, 49/49 |
| `pnpm --filter @himmelcad/builder typecheck` | **PASS** |
| `pnpm --filter @himmelcad/photolab typecheck` | **PASS**, including English UI check |
| `pnpm --filter @himmelcad/theme lint:tokens` | **PASS** |
| `pnpm registry:lint` | **PASS**, all seven checks |
| `CARGO_TARGET_DIR=target/builder /home/oem/.cargo/bin/cargo check -p himmelcad-sidecar --tests --bins -j 4` | **PASS** in 46.62 s; one existing `adaptive_job_concurrency` dead-code warning |

The unqualified `cargo` binary was not on this non-login shell's `PATH`; the
required check was therefore run once through the installed rustup cargo path
with the exact requested target directory, package, target set, and job limit.
No commit was made.
