# HimmelCAD Roadmap

This roadmap is the product-level sequence. Binding day-to-day rules live in
`AGENTS.md`; architecture rationale lives in `docs/ARCHITECTURE.md` and ADRs.

## Current Execution Priority

PhotoLab productization is pulled forward before further Builder feature
work. In parallel, the shared foundation is being cut over to ADR 0016
(canonical entities) and ADR 0017 (unified render core). Binding lane rules,
ChronoGit tax freezes, and reserved-product freezes live in
`docs/CURRENT-DIRECTION.md`.

**HimmelCAD Cap** (mobile capture → `.himmelcap` → PhotoLab) is a preparation
track documented in `docs/himmelcap/ROADMAP.md` (phases C0–C6). Cap does not
replace PhotoLab milestones; it is an upstream field product for non-surveyors
without professional equipment (ADR 0027).

The detailed PhotoLab sequence and decision gates live in
`photolab/PHOTOLAB-CONCEPT.md` and `photolab/implementation-plan.html`; the
older numeric phase order below is retained as historical product-family
structure until the roadmap is fully rebaselined.

**Frozen until decision gates:** ChronoGit productization (Phase 7), TestFlight
(Phase 8), Assembler (Phase 9). Kernel may keep journal/immutable-object
compatibility only — no feature work for those products.

## Product Principle

HimmelCAD is not a 2D CAD that later receives 3D support. The permanent center
is a large, precise, interactive 3D scene containing point clouds, derived
geometry, meshes, surfaces, photos, splats, BIM/GIS-style attributes and later
simulation overlays.

Every milestone must preserve:

- performance-first interaction,
- browser-viewability for WeltView,
- command-journal history for undo/redo and ChronoGit readiness,
- streaming/tiled datasets instead of full in-memory loading,
- kartesische world coordinates in `f64`, rendered through stable `f32`
  render/tile offsets,
- one product-family aesthetic based on VSCode Dark Islands.

## Phase 0 - Foundations

Goal: make wrong future decisions difficult.

Status: partially implemented.

- Monorepo:
  - `apps/builder`
  - `apps/photolab`
  - `apps/cap` (HimmelCAD Cap mobile capture; prep skeleton until stack gate)
  - `apps/weltview`
  - `packages/@himmelcad/ui`
  - `packages/@himmelcad/viewer`
  - `packages/@himmelcad/data`
  - `packages/@himmelcad/theme`
  - `packages/@himmelcad/console`
  - `crates/himmelcad-core`
  - `crates/himmelcad-io`
  - `crates/himmelcad-spatial`
  - `crates/himmelcad-sidecar`
  - `crates/himmelcad-wasm`
- License strategy:
  - own code under BSL/BUSL-compatible source-available terms,
  - no GPL-family product code,
  - third-party inventory in `LICENSES/THIRD_PARTY.md`.
- Shared visual system:
  - Dark Islands tokens,
  - custom title bar,
  - console baseline,
  - product-family typography/icons.
- Architecture records:
  - app stack,
  - cursor coordinates,
  - point-cloud streaming,
  - large-geometry contracts.

Exit criteria:

- `pnpm dev:builder` opens a secure Electron shell with a running sidecar.
- `pnpm dev:weltview` opens the same viewer stack in a browser.
- Rust core builds as sidecar and browser-compatible WASM surface.
- License allowlist runs in CI.
- Type contracts are generated from Rust where applicable.

## Phase 1 - Builder MVP

Goal: a real architectural MVP, not a disposable prototype.

Included:

- Permanent app shell:
  - ribbon,
  - entity tree,
  - function panel,
  - console,
  - viewport,
  - status bar,
  - collapsible side/bottom panels.
- Secure Electron shell:
  - file dialogs,
  - preload bridge,
  - sidecar supervision,
  - no Electron import in shared renderer.
- Project storage:
  - create/open `.hcad/`,
  - manifest,
  - objects,
  - journal,
  - rebuildable index/cache directories.
- LAS/LAZ import:
  - multi-file import,
  - Potree 2.0 tiling,
  - persisted runtime structures,
  - meaningful console progress,
  - partial failure reporting.
- Point-cloud display:
  - tiled streaming,
  - point budget,
  - point-size controls,
  - configurable performance controls,
  - RGB/elevation/intensity/classification display modes as data allows.
- Viewport controls:
  - orbit/pan/zoom target mouse model,
  - zoom toward cursor,
  - horizon-locked Z-up navigation.
- Cursor and snapping:
  - one `SnappingService`,
  - point-cloud provider,
  - fallback/grid provider,
  - candidate cycling with Space,
  - shared `SnapResult`/`GeometryTargetRef`.
- Segmentation MVP:
  - box/lasso/frustum-style selection,
  - preview selected points,
  - commit to `extracted` and `remaining`,
  - no point-data duplication.
- Undo/redo:
  - commands and journal for supported MVP operations.
- WeltView smoke:
  - read-only open of at least one Builder-created project.

Exit criteria:

- User can create/open a `.hcad/` project.
- User can import multiple LAS/LAZ files.
- User can navigate large point clouds interactively before all tiles are
  loaded.
- User sees correct cursor coordinates and snap state.
- User can segment a point cloud and see source/extracted/remaining entities in
  the tree.
- Undo/redo works for supported MVP commands.
- Early WeltView can open the same project read-only.

## Phase 2 - CAD Base and Attributes

Goal: move from point-cloud viewer to actual CAD base.

- Entity kinds:
  - points,
  - 2D/3D polylines,
  - circles,
  - arcs,
  - splines,
  - clothoids,
  - labels,
  - dimensions,
  - lightweight solids,
  - first semantic objects.
- Nested attribute tables:
  - free user attributes,
  - import metadata,
  - style-driving attributes,
  - geometry-driving attributes,
  - external mappings.
- Specifications/layers:
  - first specification model,
  - style inheritance,
  - layer assignment,
  - clear split between metadata and geometry-affecting properties.
- Drawing tools:
  - point,
  - 3D polyline,
  - measurement line,
  - dimensions,
  - basic trim/extend architecture.
- Scripting foundation:
  - command IDs are script-callable,
  - shared Python-sidecar/SDK architecture,
  - no direct script mutation of canonical state.

Exit criteria:

- A point-cloud-derived 3D polyline workflow is usable.
- Attributes can be edited without rewriting geometry blobs.
- Style/specification changes are undoable commands.
- Command API can be called from UI and prepared scripting surface.

## Phase 3 - Heavy Geometry and Photos

Goal: render and pick non-point-cloud large data without rewriting the viewer.

- Tiled mesh pipeline:
  - mesh tiles,
  - LOD/SSE,
  - triangle BVH per tile,
  - `MeshSnapProvider` for vertex/edge/face.
- Surface pipeline:
  - 2.5D terrain/surface entities,
  - grid or triangle representation,
  - interpolated height snapping.
- Tiled textures:
  - mipmap/tile pyramids,
  - texture budget,
  - opacity/transparency modes.
- Orthophotos:
  - georeferenced tiled raster import,
  - multiresolution zoom.
- Panoramas:
  - 2D panoramas,
  - 3D/depth panoramas for measurement workflows.
- Gaussian splat display:
  - import/display first,
  - generation remains PhotoLab.

Exit criteria:

- Renderer can host point clouds, CAD primitives, tiled meshes, surfaces,
  orthophotos and splats in one scene graph.
- Snapping/picking stays provider-based and bounded to visible/loaded tiles.
- Entity model needs no migration-breaking rewrite.

## Phase 4 - Interop and Civil/BIM Semantics

Goal: bring in professional formats and civil engineering semantics.

- DXF import/export subset, permissive dependency path only.
- IFC import spike:
  - hierarchy,
  - property sets,
  - geometry mapping,
  - lazy/streaming display.
- Civil entities:
  - alignments,
  - gradients,
  - ramp bands,
  - width bands,
  - slopes,
  - semantic objects such as pipes/manholes.
- Entity conversion as derivation:
  - line to wall,
  - point to manhole,
  - line/alignment to corridor/surface.

Exit criteria:

- Imported and authored entities retain semantic attributes.
- Conversion outputs remain linked to sources and parameters.
- BIM/civil data does not collapse into anonymous meshes unless explicitly
  exported/materialized.

## Phase 5 - WeltView Productization

Goal: browser read-only sharing.

- Open `.hcadx` bundles.
- Open server-hosted `.hcad/` manifests.
- Support HTTP range streaming where hosting allows it.
- Measurements and viewer overlays.
- Entity property inspection.
- Optional IoT/live-data layer.
- Mobile compatibility hardening after desktop browser path is stable.

Decision gate:

- Choose full-download, static range-streaming or backend service model for
  very large projects.

Exit criteria:

- Builder project can be published as browser-viewable package.
- No Electron-only assumption exists in viewer/data packages.

## Phase 6 - PhotoLab Productization (pulled forward)

Goal: finished, near-full Metashape alternative plus Gaussian splats.

Status: feature implementation is advanced; real-dataset, cancellation, packaging and
cross-platform release validation are still in progress. A milestone is not complete merely
because its UI or backend path exists.

- Image/folder import with preserved EXIF/XMP/DJI RTK and explicit horizontal
  plus vertical CRS transformation.
- Explicit, cancellable image-quality jobs with persisted per-image provenance and measured
  sharpness, directional blur, exposure/clipping and texture indicators for project-wide or
  processing-set scopes.
- Immutable original-pixel image masks with add/remove/clear/restore revisions, derived tags,
  processing-set-exact lineage and exclusion in classical/neural alignment plus portable MVS.
- Tie-point extraction/matching, SfM, bundle adjustment and sparse point cloud.
- GCP/checkpoint import, guided image projections, XY/Z/XYZ roles, optimization
  and scoped accuracy reports.
- Measurable tiled depth images and out-of-core dense point clouds.
- DSM/DTM raster pyramids, orthomosaics, textured terrain/mesh and COG export.
- License-clean Gaussian-splat generation and hierarchical viewing.
- Hardware-adaptive, resumable job DAG with isolated CPU/GPU/model workers.
- Self-contained HTML and Chromium PDF processing reports covering persisted run hashes and
  runtimes, cancellation/recovery, alignment scope and lineage, GCP control/checkpoint errors,
  published products and the explicitly labelled export-time hardware probe.
- Explicit multi-flight workflow with immutable capture/calibration groups, separately optimized
  alignments, overlap or shared-control merge runs, and selectable merged product lineage.
- All outputs viewable together and represented as normal HimmelCAD entities.

Current verification gates:

- Fresh and resumed Fast/Quality Hybrid runs on the 8-, 20–30- and 135-image Sulzberg scopes.
- Candidate metrics compared with the bundled Agisoft report, orthomosaic and 59,639,872-point LAS.
- Targeted cancellation/recovery at neural extraction, classical rescue, mapper, MVS, raster,
  mesh and splat boundaries.
- Installed Linux and Windows packages with audited offline runtimes and identical feature scope.
- Headless visual regression of every workspace, function panel and task island at supported
  window sizes.

Exit criteria:

- All five primary products are reproducible, viewable, exportable, cancellable
  and crash-resumable on a single workstation.
- Low-end hardware uses smaller work units without silently reducing quality;
  high-end hardware can use full CPU/GPU and multi-device parallelism.
- PhotoLab outputs open in Builder and WeltView as normal HimmelCAD entities.

## Phase 7 - ChronoGit Feasibility

Goal: prove semantic CAD diffs before committing to productization.

- Diff categories:
  - entity tree changed,
  - geometry reference changed,
  - attribute changed,
  - style/specification changed,
  - derivation changed,
  - source data replaced,
  - transform changed.
- Diff visualization:
  - added/removed/changed entities,
  - point-cloud segment diffs,
  - attribute table diffs,
  - style/specification diffs.
- Storage strategy:
  - manifest/journal in Git,
  - large blobs in LFS or external object store,
  - merge constraints.

Decision gate:

- Proceed only if diffs are useful to real CAD users and not just technically
  possible.

## Phase 8 - TestFlight Feasibility

Goal: decide whether simulation belongs inside HimmelCAD.

- Time-varying attribute model.
- Simulation overlay entity model.
- DGM extraction from point clouds/surfaces.
- Vehicle path / sweep path prototype.
- Rain-flow prototype on terrain mesh.
- External solver integration for wind or complex physics.
- Script API design using the same command/entity model.

Decision gate:

- Proceed only if simulations can be performant, explainable and visually
  useful without turning Builder into a fragile solver host.

## Phase 9 - Assembler Feasibility

Goal: decide whether a precision-mechanics / 3D-printing product should share
the same foundation.

- Analyze which entity/constraint/kernel capabilities diverge from Builder.
- Identify whether a separate CAD kernel is required.
- Keep shared UI/theme/project concepts where sensible.

Decision gate:

- Proceed only if the shared HimmelCAD foundation helps more than it constrains.
