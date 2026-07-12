# HimmelCAD Architecture

## Summary

HimmelCAD is split into three layers:

1. **Core** - Rust data model, storage, import, spatial indexes, commands.
2. **Viewer** - browser-compatible TypeScript/three.js renderer.
3. **Shell/UI** - Builder Electron desktop app and WeltView browser app.

The central rule: Builder and WeltView must share the same viewer and data
contracts. Electron gives desktop file access and native packaging, but it must
not leak into the shared renderer.

Product-family scope and long-term entity plans are documented in
`docs/PRODUCT-VISION.md`. This file focuses on the technical architecture that
keeps those products compatible.

## Why Electron, Not Tauri or Native UI

Electron is chosen because HimmelCAD is a 3D web-renderer-heavy application. The
same renderer must later run in WeltView. Electron gives a predictable Chromium
runtime across platforms.

Rejected alternatives:

- **Tauri:** attractive because Rust-native and smaller binaries, but it depends
  on OS webviews. For WebGL/WebGPU-heavy work this creates unpredictable
  compatibility, especially on Linux WebKitGTK.
- **Slint/native UI:** good for native controls, weak for web-compatible 3D
  renderer reuse and the existing three.js ecosystem.
- **Vanilla JS v01 continuation:** fastest short-term, too fragile for a CAD
  with panels, command routing, state, undo, viewer sharing, and tests.

## Technology Stack

| Layer               | Choice                                           | Reason                                                         |
| ------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| Desktop shell       | Electron                                         | Stable Chromium, good packaging, predictable WebGL/WebGPU path |
| Browser app         | Vite static app                                  | Same viewer package as Builder                               |
| UI                  | TypeScript + React                               | Strong ecosystem, testability, refactoring safety              |
| State mirror        | Zustand                                          | Small, explicit, works well with command events                |
| Styling             | CSS variables / Tailwind-style tokens            | Dark-Islands-inspired design without hardcoded colors          |
| 3D renderer         | three.js                                         | Mature web 3D ecosystem                                        |
| Point-cloud loading | modular Potree/pnext-inspired loader             | Better embedding than monolithic Potree v1                     |
| Core                | Rust                                             | Performance, memory safety, native and WASM targets            |
| Desktop bridge      | Separate sidecar process via JSON-RPC over stdio | Crash isolation, same pattern as PhotoLab Python sidecar later |
| Browser bridge      | wasm-bindgen in a Web Worker                     | Same core model in WeltView                                    |

## Runtime Model

```text
Builder Electron
  main process
    file dialogs
    secure preload
    sidecar lifecycle (spawn, supervise, restart on crash)
    JSON-RPC client over stdio
  renderer process
    React UI
    shared viewer
    command mirror

himmelcad-sidecar (separate OS process)
  tokio runtime
  project storage
  entity model
  command journal
  import/index pipelines
  spatial queries
  JSON-RPC server over stdio

WeltView Browser
  React UI subset
  shared viewer
  Web Worker hosting himmelcad-wasm
  HTTP/blob project loader
```

## State Ownership

The Rust core owns authoritative project state. The React app receives snapshots
and events, then mirrors them for display.

Why:

- commands are serialized once,
- undo/redo is deterministic,
- future Python scripting can call the same command API,
- ChronoGit gets command history and semantic diffs,
- WeltView can load read-only snapshots without reimplementing rules.

The UI may keep transient state such as hover, current panel size, and open
dropdowns. It must not mutate entities directly.

## Renderer Architecture

The viewer package exposes:

- `SceneGraph`,
- `Layer`,
- `Viewport`,
- `CameraController`,
- `ToolController`,
- `PickingService`,
- `SnappingService`,
- `RenderOffset`,
- `TiledDataset`,
- `TileStreamingService`,
- `RenderBudget`.

Layer types planned:

- point cloud layer,
- CAD primitive layer,
- tiled mesh layer (high-resolution meshes with hierarchical LOD),
- tiled texture provider (mipmap/tile pyramid for textured meshes),
- Gaussian splat layer (hierarchical splat tree, depth-sorted),
- BIM/IFC layer (mapped onto tiled mesh layer where possible),
- simulation overlay layer.

Point clouds are only the first layer. The scene graph is intentionally not
Potree's application scene. Potree/pnext concepts are used for octree streaming,
point budgets, and shaders, but HimmelCAD owns the app state and UI.

### Generic `TiledDataset` Abstraction

All large data layers - point clouds, tiled meshes, tiled textures, Gaussian
splats - implement a single `TiledDataset` contract. This is mandatory, not
optional, because every per-layer streaming reinvention historically becomes a
maintenance disaster.

A `TiledDataset` provides:

- a hierarchical tile tree (octree, BVH, quadtree, splat tree, depending on data type),
- per-tile bounds in project world coordinates,
- per-tile screen-space-error metric for LOD selection,
- per-tile load/unload functions,
- per-tile picking acceleration data,
- per-tile statistics for the render budget,
- per-tile content cost (points, triangles, splats, texture/GPU bytes, draw calls),
- per-tile transparency mode and persisted spatial-index status.

The `TileStreamingService` then operates on `TiledDataset` instances without
knowing what kind of data they hold. The `RenderBudget` allocates fairly
across all visible datasets, regardless of type.

Consequence:

- Point cloud LOD, mesh LOD, splat LOD, and texture LOD all share the same
  budget logic and the same eviction logic.
- Adding a new tile-based layer type only requires implementing `TiledDataset`
  and a small render module; the streaming and budget infrastructure is reused.

See `docs/adr/0004-large-geometry-contracts.md` for the enforced shared
contracts across point clouds, tiled meshes, textures, splats and snap targets.

### Snapping as a First-Class Subsystem

Cursor-snapping (point/edge/face/grid/anchor) is not a side effect of the
cursor coordinate system. It is its own subsystem.

`SnappingService`:

- holds a registry of snap providers per layer type,
- queries providers within a screen-space tolerance,
- ranks candidate snaps by user priority (point > vertex > edge > face > grid),
- filters candidates through one central snap-target mask,
- returns a single canonical snap result with snap kind metadata,
- feeds both the cursor coordinate display and active drawing tools.

This means:

- the same snapping logic powers the bottom-right coordinate display, the
  drawing tools, the measurement tools, and any future scripting hook,
- new layer types add snap providers, not new snap pipelines,
- edit commands can revalidate the selected `GeometryTargetRef` in Rust before
  mutating project state.

## Coordinates

Internally, HimmelCAD uses kartesische coordinates only:

- canonical storage: `f64`,
- render buffers: `f32` relative to stable render/tile offsets,
- Z is world-up,
- optional CRS/import metadata is stored for later export, warning, and map
  integration only,
- no implicit reprojection, no implicit NTv2 grids, no implicit scale correction.

If imported files are far apart, the app may warn and later offer an explicit
transform workflow. It must not silently change coordinates.

## Cursor Coordinate Strategy

The cursor coordinate is a first-class system:

1. depth pick from rendered geometry,
2. nearest loaded point fallback,
3. local interpolation fallback,
4. estimated/last-stable state only if no reliable coordinate exists.

The user-facing coordinate is always in project world coordinates after exactly
one render-offset reversal. Picking services must be bounded to the current
visible/loaded tiles.

## Storage and History

The project format is a hybrid:

- `.hcad/` folder is the canonical working format,
- `.hcadx` zip is the portable export format,
- object blobs are content-addressed,
- commands are append-only journal entries,
- indexes are rebuildable cache,
- point-cloud tiles use the **Potree 2.0 tile layout** (open, well-documented,
  natively understood by `pnext/three-loader`) wrapped inside our content-
  addressable object store. Mesh, texture, and splat tile formats follow the
  same layout philosophy when they arrive.

This gives:

- fast loading,
- partial streaming,
- undo/redo,
- clean crash recovery,
- a credible path toward ChronoGit.

## Dependency Policy

CloudCompare and similar GPL projects may inform algorithm research but are not
build inputs and must not be ported. Any algorithm must be implemented from
papers, own derivation, or permissively licensed implementations.

All third-party code must be listed in `LICENSES/THIRD_PARTY.md` before product
use.

## Future Compatibility

### WeltView

WeltView works because:

- renderer has no Electron dependency,
- Rust core can compile to WASM,
- `.hcadx` is streamable in browser,
- editing commands can be disabled while read-only viewing remains.

### PhotoLab

PhotoLab can use a Python/CUDA sidecar later. Its outputs must be normal
HimmelCAD entities: point clouds, meshes, splats, transforms, and attributes.
Builder must not depend on Python.

### ChronoGit

ChronoGit depends on:

- immutable objects,
- command journal,
- semantic entity IDs,
- deterministic derived entities,
- attribute blobs separate from heavy geometry.

The MVP must preserve these constraints even before the ChronoGit UI exists.

### TestFlight

TestFlight depends on:

- terrain/mesh extraction,
- entity attributes that can later carry time-varying values,
- commands/scripts that can produce derived overlay entities,
- no renderer assumption that all geometry is static CAD geometry.

The MVP does not simulate anything, but it must not block this path.

### Composer

Composer is only a feasibility concept. The shared foundation should avoid
unnecessary survey/civil-only assumptions, but Builder must not wait for a
future precision-mechanics kernel. If Composer requires fundamentally different
constraints or solid modeling, that decision gets its own ADR.

### Python Scripting and AI Agents

Python scripting uses a shared out-of-process scripting sidecar plus SDK. It
must use the same command/entity contracts as the UI. Direct mutation of project
state from scripts would break undo/redo, ChronoGit and replay. Heavy Python
compute belongs in a sidecar/process boundary, not in the renderer.
