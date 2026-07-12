# ADR 0007 - PhotoLab Product Viewers

## Status

Accepted.

## Date

2026-07-11

## Context

DEM, orthomosaics, textured meshes and Gaussian splats must coexist with large
point clouds without introducing product-specific memory schedulers. Projected
coordinates also cannot be uploaded to `f32` GPU buffers without a stable local
origin.

## Decision

All PhotoLab product viewers implement the shared `TiledDataset` contract and
are selected by the common screen-space-error, frustum, GPU-budget and LRU
scheduler.

- GDAL raster pyramid manifest v1 is the browser raster contract. PNG view
  layers are presentation data; Float32 height tiles remain the metric DEM.
- Locked top-down mode uses a flat two-triangle tile. Orbit mode samples the
  Float32 DEM into a bounded terrain grid and drapes its view texture. NoData
  cells produce no triangles.
- Prepared mesh tiles contain local `f32` positions around a per-tile `f64`
  world origin, an index buffer, optional UV/normal/texture buffers and a
  persisted BVH reference. Exact writing tools revalidate that BVH in the core.
- Prepared splat tiles use `hcsplatInterleavedV1`: local center XYZ, linear
  scale XYZ, normalized quaternion XYZW and RGBA8. Rendering projects the full
  anisotropic covariance; transparent ordering is done per streamed hierarchy
  block, never by globally sorting every splat per frame.
- Ordinary Brush/3DGS PLY is accepted through a cancellable Web Worker and is
  capped at one million splats. Larger PLY input must be prepared into the tiled
  format.
- Gaussian splats are appearance-only. Measuring and snapping use the source
  depth, point, DEM or mesh products, not the optimized splat appearance.

## Consequences

- Parent tiles remain visible until all relevant children are resident, so
  zooming never exposes a blank raster or terrain.
- Navigation-mode changes discard resident raster geometry and rebuild it from
  the browser cache. This avoids retaining both flat and terrain GPU copies.
- Mesh and splat preprocessors must publish local positions plus exact tile
  origins; world-coordinate Float32 position buffers are invalid input.
- A secure Electron product-data protocol must expose only files belonging to
  the active project's immutable product directory.

## Guardrails

- Product decoders do not perform global per-primitive work in animation frames.
- Tile loaders use typed arrays, abortable fetches and deterministic resource
  disposal, including ImageBitmap cleanup after eviction or context recovery.
- Renderer picks remain hints. Exact mesh or DEM writes require core-side
  revalidation against entity, tile, primitive and product version.
