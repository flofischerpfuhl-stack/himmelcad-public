# ADR 0004 - Large Geometry Contracts

## Status

Accepted.

## Date

2026-05-14

## Context

Builder must eventually render and edit projects that contain:

- point clouds with billions of source points,
- tiled meshes with hundreds of millions of source triangles,
- textured meshes with large texture pyramids and adjustable opacity,
- Gaussian splats,
- authored CAD entities,
- snapping and picking across all of the above.

The existing Potree 2.0 pivot solves the first point-cloud runtime problem, but
the architecture must not become point-cloud-only. Meshes, textures, splats and
CAD geometry need the same streaming, budget and snap contracts so future
features are additive instead of rewrites.

## Decision

Large renderable data is represented as `TiledDataset`, regardless of concrete
geometry type. A dataset declares its `GeometryDatasetKind`, tile hierarchy,
tile content cost, tile load state and persisted picking/spatial-index status.

Each tile carries:

- bounds,
- screen-space error input (`geometricError`),
- content stats (`points`, `triangles`, `splats`, texture/GPU bytes, draw calls),
- transparency mode (`opaque`, `alpha-test`, `layer-opacity`, `sorted-alpha`,
  `weighted-oit`),
- pick/spatial index reference (`point-octree`, `triangle-bvh`, `grid`,
  `splat-tree`, `cad-direct`, etc.).

`RenderBudget` is shared across all dataset kinds. Point clouds, meshes, splats,
textures and draw calls compete through one budget object rather than separate
per-layer heuristics.

Snapping and picking use one addressable target contract:

```text
SnapResult
  position: f64 world coordinate for display/tool input
  kind: Point | Vertex | Edge | Face | Grid | EstimatedSurface | Free
  source: point-cloud | mesh | textured-mesh | dgm | splat | cad | grid | fallback
  target:
    entityId
    layerId
    tileId?
    primitive: point | vertex | edge | face | splat | grid | estimated-surface | free
    exact: boolean
```

The renderer may provide approximate targets for hover and orbit pivots. Any
write command that depends on geometry (for example trim line to mesh face)
must require an exact or core-revalidated target before mutating project state.

`SnappingService` owns snap-target toggles centrally. Providers may skip disabled
candidate classes early, but the service filters every candidate before ranking.
Space-key cycling always cycles through the single ranked candidate stack, not
through provider-specific state.

## Consequences

### Positive

- Mesh, DGM, splat and CAD snapping can be added by registering providers, not
  by creating a parallel cursor system.
- Future UI toggles for "snap to point / vertex / edge / face / surface" are
  service configuration, not duplicated provider logic.
- Trimming and other exact edit operations have a stable handoff from renderer
  pick to Rust-core revalidation.
- Render budgeting can stay global when point clouds and textured meshes are
  visible at the same time.
- Transparency is treated as an explicit tile/material capability. Perfect
  global triangle sorting is not assumed.

### Negative / accepted trade-offs

- The contracts are stricter than the current MVP implementation needs.
- Current point-cloud providers can only attach exact primitive ids where the
  underlying loader exposes them. Otherwise they still return display-accurate
  positions, but `target.exact` remains false or absent.
- Implementing tiled mesh rendering still requires a dedicated ADR for the
  on-disk mesh/tile format and candidate vendor stack.

## Guardrails

- No future large geometry layer may bypass `TiledDataset`.
- No future snap provider may return write-capable candidates without a
  `GeometryTargetRef`.
- Renderer-side picks are hints. Rust-core commands revalidate entity version,
  tile id and primitive id before writing.
- Meshes may use approximated transparency modes; perfect per-triangle sorting
  is not a baseline requirement for standard hardware.
