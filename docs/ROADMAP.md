# Himmelcad Roadmap

## Product Principle

Himmelcad is not a 2D CAD that later gets 3D support. The permanent center is a
large, precise, interactive 3D scene containing point clouds, derived geometry,
meshes, splats, BIM/GIS attributes, and later simulation overlays.

Every milestone must preserve:

- browser-viewability for Weltview,
- command-journal history for undo/redo and Chronogit,
- streaming datasets instead of full in-memory loading,
- kartesische Weltkoordinaten in `f64`, rendered through a stable `f32`
  render-offset.

## Phase 0 — Foundations

Goal: make wrong future decisions difficult.

- Lock license strategy: BSL 1.1 for own code, no GPL-family code in product.
- Create monorepo structure:
  - `apps/polyshape`
  - `apps/weltview`
  - `packages/@himmelcad/ui`
  - `packages/@himmelcad/viewer`
  - `packages/@himmelcad/data`
  - `packages/@himmelcad/theme`
  - `crates/himmelcad-core`
  - `crates/himmelcad-io`
  - `crates/himmelcad-spatial`
  - `crates/himmelcad-sidecar`
  - `crates/himmelcad-wasm`
- Add CI for linting, testing, license checks, and basic benchmark smoke tests.
- Port visual language from `libs/vscode-dark-islands-main` into design tokens.
- Port icon/font assets from `libs/polyshapev01` only after license check.

Exit criteria:

- `pnpm dev:polyshape` opens a secure Electron shell with a running sidecar.
- `pnpm dev:weltview` opens the same viewer stack in a browser.
- Rust core builds as native sidecar binary and as WASM module.
- License allowlist runs in CI.

## Phase 1 — Polyshape MVP

Goal: a real architectural MVP, not a disposable prototype.

Included:

- Application layout:
  - top ribbon, collapsible into dropdown headers,
  - left entity tree,
  - right function panel,
  - bottom console,
  - center 3D viewport,
  - collapsible side/bottom panels.
- Viewport controls:
  - LMB click select,
  - LMB drag orbit with stable horizon and Z-up world,
  - RMB drag pan,
  - RMB click context menu / quick function bar,
  - LMB double-click finish active tool,
  - wheel zoom toward cursor coordinate,
  - Esc cancel active tool.
- LAS/LAZ import:
  - multi-file selection,
  - background indexing,
  - progress per file,
  - cancel/retry,
  - imported entities grouped clearly in the tree.
- Point-cloud display:
  - octree/tile streaming,
  - point budget,
  - density-adaptive rendering,
  - classification/color/intensity display modes when present.
- Cursor coordinate system:
  - depth-assisted ray picking against visible geometry,
  - nearest point fallback,
  - local interpolation fallback for gaps,
  - world-coordinate display in the bottom-right viewport overlay.
- Segmentation MVP:
  - box/lasso/frustum-style selection tools,
  - preview selected points,
  - commit creates `extracted` and `remaining` derived entities,
  - tree shows source, extracted, remaining, and derivation relationship,
  - no point-data duplication.
- Undo/redo:
  - command journal for imports, visibility toggles, selections, segmentation,
    renaming, tree grouping, panel state.

Exit criteria:

- User can create/open a `.hcad/` project.
- User can import multiple LAS/LAZ files.
- User can inspect cursor coordinates interactively.
- User can segment a point cloud and see extracted/remaining entities in the tree.
- Same project can be opened read-only by the early Weltview dev shell.

## Phase 2 — CAD Primitives and Attributes

Goal: move from point-cloud viewer to actual CAD base.

- Entity types:
  - single points,
  - polylines / 3D lines,
  - lightweight meshes,
  - text annotations,
  - groups/layers/views.
- Nested attribute tables:
  - typed values,
  - free-form user attributes,
  - reserved geometry-affecting attributes,
  - import metadata.
- Drawing tools:
  - point,
  - 3D polyline snapped to cursor coordinate,
  - measurement line,
  - area/volume placeholder.
- Basic style system:
  - layers,
  - colors,
  - line styles,
  - point size,
  - classification mapping.
- DXF import feasibility spike using permissive libraries only.

Exit criteria:

- A point-cloud-derived 3D polyline workflow is usable.
- Attributes can be edited without rewriting geometry blobs.
- Style changes are undoable commands.

## Phase 3 — Interop and Heavy Geometry

Goal: bring in serious external formats without compromising performance.

- DXF import/export subset.
- IFC import spike:
  - hierarchy,
  - property sets,
  - geometry mapping,
  - streaming/lazy loading.
- High-resolution textured mesh pipeline:
  - tiled textures,
  - mesh tiles,
  - LOD,
  - material metadata.
- Gaussian splat rendering module:
  - separate viewer layer,
  - web-compatible shader path,
  - import/display first, generation later in Photolab.

Exit criteria:

- Renderer can host point clouds, CAD primitives, tiled meshes, and splats in the
  same scene graph.
- Entity model needs no migration-breaking rewrite.

## Phase 4 — Weltview

Goal: browser read-only sharing.

- Open `.hcadx` bundles and server-hosted `.hcad/` manifests.
- Stream point-cloud/object blobs over HTTP range requests.
- Measurements and annotations saved separately as viewer overlays.
- Optional IoT live-data layer:
  - typed time-series connection,
  - entity attachment,
  - timeline display.

Exit criteria:

- Polyshape project can be published as a browser-viewable package.
- No Electron-only assumption exists in viewer/data packages.

## Phase 5 — Photolab

Goal: photogrammetry, scan alignment, and splat generation.

- Python/CUDA sidecar for compute-heavy workloads.
- Import photo sets and scan sets.
- Tie points, bundle adjustment, georeference/transformation workflows.
- Dense point cloud / mesh / texture / Gaussian splat generation.
- Export results as normal Himmelcad entities.

Exit criteria:

- Photolab output opens in Polyshape and Weltview without custom one-off paths.

## Phase 6 — Chronogit Feasibility

Goal: prove semantic CAD diffs before committing to productization.

- Define meaningful diff categories:
  - geometry changed,
  - attribute changed,
  - style changed,
  - derived-selection changed,
  - source data replaced,
  - transformation changed.
- Render diff visualization:
  - added/removed/changed entities,
  - point-cloud segment diffs,
  - attribute table diffs.
- Evaluate Git compatibility:
  - small manifests and journals in Git,
  - large blobs in LFS or external object store,
  - project merge constraints.

Decision gate:

- Proceed only if diffs are useful to real CAD users and not just technically
  possible.

## Phase 7 — Testflight Feasibility

Goal: decide whether simulation belongs inside Himmelcad.

- DGM extraction from point clouds.
- Vehicle path / sweep path prototype.
- Rain-flow prototype on terrain mesh.
- Wind prototype only as external solver integration unless a permissive,
  maintainable local solver exists.
- Script API design using the same command/entity model.

Decision gate:

- Proceed only if simulations can be performant, explainable, and visually
  useful without turning Polyshape into a fragile solver host.
