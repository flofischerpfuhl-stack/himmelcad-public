# Polyshape MVP Implementation Plan

## MVP Definition

The MVP is successful when a user can:

1. open Himmelcad Polyshape,
2. create a `.hcad/` project,
3. import multiple LAS/LAZ files at once,
4. view them interactively as 3D point clouds,
5. move through the scene using the target mouse model,
6. see a correct 3D cursor coordinate in the viewport,
7. segment a point cloud,
8. see `extracted` and `remaining` cleanly in the entity tree,
9. undo/redo the major operations,
10. open the same project in a minimal read-only Weltview shell.

The MVP is explicitly not a throwaway prototype. It must contain the real
architecture: Rust core, command journal, `.hcad/` storage, shared web viewer.

## Tooling Baseline

Pinned at the start so we never debug "works on my machine":

- Node.js 22 LTS.
- pnpm 9.x.
- TypeScript 5.6+, strict.
- Vite 5.x.
- React 19.
- Electron 32 LTS line.
- Rust stable, current at project start, pinned via `rust-toolchain.toml`.
- napi-rs 2.x.
- wasm-bindgen current.
- Tailwind v4 (token-based, no utility soup in components).
- ESLint flat config, Prettier, Stylelint.
- Playwright for visual/integration tests.
- Criterion for Rust benches, Vitest+benchmark for TS.

## Workstream 1 — Repository and Build System

Create the monorepo skeleton:

```text
apps/
  polyshape/
    electron/
    renderer/
  weltview/
packages/
  @himmelcad/ui/
  @himmelcad/viewer/
  @himmelcad/data/
  @himmelcad/theme/
crates/
  himmelcad-core/
  himmelcad-io/
  himmelcad-spatial/
  himmelcad-sidecar/   # binary, JSON-RPC over stdio
  himmelcad-wasm/
```

Decisions:

- package manager: `pnpm`,
- bundler: Vite,
- TS config: strict from day one,
- Rust workspace: stable Rust, Tokio async, `serde`, `thiserror`,
  `wasm-bindgen`,
- sidecar IPC: JSON-RPC 2.0 over stdio,
- point-cloud tile format: Potree 2.0 wrapped in our content-addressable store,
- CI: lint, unit tests, license checks, build smoke.

Deliverables:

- `pnpm dev:polyshape`,
- `pnpm dev:weltview`,
- `cargo test --workspace`,
- generated TS types from Rust contracts.

## Workstream 2 — Electron Shell

Build the secure desktop shell:

- `BrowserWindow` with:
  - `contextIsolation: true`,
  - `nodeIntegration: false`,
  - `sandbox: true`,
  - strict CSP.
- Preload bridge exposes only:
  - file picker,
  - project open/save paths,
  - core command API,
  - progress event subscription,
  - console/log stream.
- Native menus:
  - File: New, Open, Import, Save, Export `.hcadx`,
  - Edit: Undo, Redo,
  - View: panels, reset layout,
  - Help: diagnostics.

Acceptance:

- no renderer code imports Electron,
- renderer still runs in `apps/weltview`.

## Workstream 3 — Visual System and Layout

Implement the permanent UI shape:

- top ribbon:
  - tabs/groups: Project, Import, View, Select, Segment, Inspect, Settings,
  - collapsible ribbon keeps headers visible,
  - collapsed headers become dropdown menus with all functions still available.
- left entity panel:
  - tree root: project,
  - imported point-cloud groups,
  - child entities for derived segmentations,
  - visibility, lock, color mode badges.
- right function panel:
  - empty state,
  - active function settings,
  - automatically opens when a ribbon function is selected,
  - stays pinned/collapsible.
- bottom console:
  - logs from renderer and Rust core,
  - filters,
  - search,
  - copy.
- center viewport:
  - 3D canvas,
  - bottom-right coordinate overlay,
  - view compass later, not mandatory in first MVP.

Design source:

- port Dark Islands tokens from `libs/vscode-dark-islands-main`,
- reuse allowed fonts/icons from `libs/polyshapev01` after license check,
- no hardcoded one-off colors in components.

Acceptance:

- layout survives resize,
- every side/bottom panel can collapse,
- right panel expands on function activation,
- collapsed ribbon still exposes functions.

## Workstream 4 — Project Storage MVP

Implement enough of `.hcad/` to avoid future rewrite:

```text
project.hcad/
  manifest.json
  objects/
  journal/
  index/
  tmp/
```

MVP objects:

- source point-cloud import manifest,
- octree/tile metadata,
- derived segment spec,
- attributes blob,
- command journal entries.

Rules:

- source LAS/LAZ may be copied into `objects/` or converted to internal tiles,
- imported source entity is immutable,
- segmentation creates derived entities referencing the source,
- indexes are rebuildable cache, not canonical truth.

Acceptance:

- new/open/save project works,
- crash during import does not corrupt existing manifest,
- project can be zipped to `.hcadx`,
- basic garbage-collection command can list unreferenced blobs.

## Workstream 5 — LAS/LAZ Import

Native Rust import pipeline.

Import philosophy: import is allowed to be slow. Runtime is not. Importer
pre-computes everything that runtime would otherwise have to compute.

Entry points:

- ribbon Import action,
- File menu Import,
- drag-and-drop of one or more files onto the application window,
- drag-and-drop onto the entity tree (drops into the dropped-on group).

Wizard:

- file picker allows multi-select,
- import wizard lists files, sizes, estimated point counts when cheaply known,
- background task per file with bounded parallelism,
- progress events:
  - parsing,
  - bounds scan,
  - tiling/indexing/octree build,
  - statistics (classification histogram, intensity range, return distribution),
  - write objects,
  - manifest commit.

Implementation detail:

- Use permissively licensed LAS/LAZ crates only.
- Store positions as `f64` in internal tiles or source metadata.
- Build render tiles with local `f32` coordinates relative to tile origin.
- Preserve LAS metadata as optional import metadata, not engine CRS behavior.
- If bounds of multiple files are extremely far apart, show a warning and
  offer to continue as-is. Transformation tooling is later, not implicit.

Acceptance:

- user can import 1, 10, or 100 LAS/LAZ files in one operation,
- partial failure leaves successful files intact and failed files clearly marked,
- tree groups imported files under an import batch,
- import is cancelable.

## Workstream 6 — Viewer and Rendering

Renderer responsibilities:

- scene graph from entity tree,
- point-cloud tile streaming,
- point budget,
- color modes:
  - RGB,
  - elevation,
  - intensity,
  - classification,
  - single color fallback,
- visibility/selection highlighting,
- render-offset application.

Technology:

- three.js core scene/camera/input infrastructure,
- modular point-cloud loader inspired by Potree/pnext,
- own abstraction over point-cloud layers so splats/meshes can be added later.

Acceptance:

- large point clouds are interactive before all tiles are loaded,
- zoom/orbit/pan stay responsive during streaming,
- point budget is configurable,
- renderer package runs unchanged in Weltview.

## Workstream 7 — Mouse and Tool Model

Create a real tool controller, not event handlers scattered in components.

Core concepts:

- `NavigationMode`,
- `SelectionTool`,
- `SegmentationTool`,
- `CommandTool`,
- `ToolContext`,
- `PointerGesture`.

Mouse mapping:

- LMB click: select,
- LMB hold + drag: orbit,
- LMB double-click: finish current function,
- RMB click on selection: entity context menu,
- RMB click on empty viewport: quick function bar,
- RMB hold + drag: pan,
- wheel: zoom toward cursor coordinate,
- Esc: cancel active function.

Heuristics:

- click vs hold threshold: configurable, default 160 ms or 4 px movement,
- double-click must not accidentally select twice when a drawing function is
  active,
- context menu opens on mouse-up if drag threshold was not crossed.

Acceptance:

- all mappings work consistently,
- tool transitions are logged in the console for debugging,
- no tool directly mutates entities; tools issue commands.

## Workstream 7b — Snapping Subsystem

Snapping is its own service from day one because the cursor coordinate is
effectively a snap result.

Components:

- `SnappingService` (in `packages/@himmelcad/viewer`),
- per-layer snap providers (point-cloud snap provider in MVP),
- snap kinds: `Point`, `Vertex`, `Edge`, `Face`, `Grid`, `EstimatedSurface`,
  `Free`,
- screen-space tolerance, configurable in user settings,
- priority order, configurable but with a sensible default
  (`Point > Vertex > Edge > Face > EstimatedSurface > Free`),
- visual snap marker in the viewport (small glyph indicating snap kind).

The cursor coordinate display reads its value from the `SnappingService`. Active
drawing tools (later) read from the same service. There is no parallel snap
logic in tools.

Acceptance:

- snapping picks the visually closest valid candidate,
- moving over gaps falls through to `EstimatedSurface` and shows the estimated
  marker,
- when nothing reasonable can be snapped to, the marker becomes `Free` and the
  coordinate display is clearly marked as estimated/free.

## Workstream 8 — Cursor Coordinate System

This is a core MVP feature, not polish.

Algorithm priority:

1. Hardware/depth pick against visible rendered geometry.
2. If depth pick is invalid or missing, raycast into currently loaded point-cloud
   tiles and select nearest point within screen-space tolerance.
3. If still missing, interpolate a 3D point from nearest surrounding visible
   points in the ray neighborhood.
4. If no stable result exists, show last stable coordinate with a visual
   \"estimated\" state, not a fake precise result.

Important constraints:

- coordinate display is in the project kartesischer Welt-Raum,
- render-offset is applied exactly once,
- Z-up horizon lock is independent of three.js internal conventions,
- picking must be asynchronous or bounded; never iterate whole clouds.

Data needed:

- visible tile list,
- depth buffer or ID buffer,
- camera matrices,
- tile-local to world transform,
- small spatial index per loaded tile.

Acceptance:

- cursor coordinate updates at interactive rate,
- point under cursor is stable when camera is still,
- coordinate is correct after orbit/pan/zoom,
- gaps are marked as interpolated/estimated,
- no frame spikes over the configured budget on normal hardware.

## Workstream 9 — Segmentation MVP

Implement segmentation as non-destructive derivation.

Tools:

- box select in screen space,
- lasso select in screen space,
- optional clip-box/frustum select if it falls naturally out of renderer code.

Flow:

1. user activates Segment ribbon function,
2. right panel opens with method options,
3. user draws selection in viewport,
4. selected points preview with highlight,
5. user clicks Extract,
6. core writes a derived selection mask/spec,
7. tree shows:

```text
PointCloud_A
  Extracted_001
  Remaining_001
```

Data behavior:

- original point cloud remains immutable,
- extracted and remaining are derived views over the same source,
- extraction can be materialized later if export needs it,
- undo removes the derived entities and command journal entry.

Acceptance:

- segmentation handles large clouds without copying all points,
- tree visibility toggles work for source/extracted/remaining,
- extracted and remaining can have different colors/styles,
- undo/redo roundtrip is reliable.

## Workstream 10 — Command System and Undo/Redo

MVP commands:

- `CreateProject`,
- `ImportPointCloudBatch`,
- `SetEntityVisibility`,
- `SetEntityName`,
- `SetEntityStyle`,
- `ActivateTool`,
- `CreatePointSelection`,
- `ExtractPointCloudSegment`,
- `SetPanelState`.

Command properties:

- deterministic,
- serializable,
- reversible or paired with inverse data,
- journaled before manifest commit for crash recovery,
- produces semantic event for UI tree updates.

Acceptance:

- Ctrl+Z / Ctrl+Shift+Z work for supported commands,
- journal can replay project state,
- commands are the only write path.

## Workstream 10b — App State and Persistence

App state is its own concern, separate from project content.

Persisted across sessions in user-level config (not inside the project):

- recent projects,
- last opened project,
- window size/position/monitor,
- panel collapsed/expanded state per panel,
- panel sizes,
- ribbon collapsed state,
- console filter level and visibility,
- snapping tolerance and priority,
- color theme variant,
- units preference,
- import default directory.

Persisted inside the project manifest:

- view states,
- per-project entity tree expansion,
- per-project panel layout overrides,
- last active tool.

Recovery:

- after crash, open last project in safe mode,
- replay journal if manifest is older than journal head,
- offer to discard or apply pending command journal entries.

## Workstream 10c — Status Bar

Independent UI region above the bottom console:

- selection count,
- visible point count and configured budget,
- live FPS and GPU/CPU frame time,
- streaming status (loading tiles, queue depth),
- active tool name,
- snap mode,
- units preference.

The status bar reads from a dedicated `StatusService`; widgets register
themselves and their refresh strategy. No status widget polls the renderer
directly.

## Workstream 11 — Weltview Smoke Compatibility

Do not wait until later.

MVP Weltview:

- opens a `.hcadx` or dev `.hcad/` served by local dev server,
- shows same viewer package,
- no editing commands exposed,
- can toggle visibility and measure later.

Acceptance:

- at least one Polyshape-created project opens read-only in browser dev mode.

## Milestone Order

1. Repo/build skeleton.
2. Secure Electron + browser viewer shell.
3. Theme tokens and UI layout with mocked data.
4. Rust core project model + command journal.
5. `.hcad/` create/open/save.
6. App-state persistence and recent projects.
7. LAS/LAZ import to internal tiled objects (incl. drag-and-drop).
8. Point-cloud renderer and streaming with `TiledDataset` abstraction.
9. Mouse/tool controller.
10. Snapping subsystem with point-cloud snap provider.
11. Cursor coordinate system reading from snapping.
12. Status bar service.
13. Segmentation with extracted/remaining derived entities.
14. Undo/redo hardening.
15. Weltview read-only smoke.
16. Performance pass and bug-fix sprint.

## MVP Non-Goals

- full DXF/DWG compatibility,
- IFC import,
- Gaussian splat generation,
- Photolab,
- background maps,
- CRS reprojection,
- Python scripting,
- multi-user collaboration,
- Chronogit UI,
- Testflight simulations.

These are intentionally excluded from the MVP but protected by the architecture.
