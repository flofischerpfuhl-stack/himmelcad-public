# ADR 0002 — Cursor Coordinate System (Two-Stage Hybrid)

## Status

Accepted. Initial implementation landed 2026-05-08. Pipeline pivoted to
the Potree 2.0 streaming stack 2026-05-09 (see ADR 0003); this document
describes the post-pivot architecture, which is what ships.

## Date

2026-05-08, revised 2026-05-09.

## Context

Himmel:CAD Builder needs a cursor that always carries a precise 3D
coordinate, scales to billions of points and hundreds of millions of
triangles, and underpins every measurement, drawing, orbit-pivot and
selection downstream. Sampling-based heuristics (the previous MVP path)
cannot deliver any of that:

- A 20 k-point sample of an 8 M cloud finds a "near" point only by luck.
- The same sample over a billion-point dataset is statistically noise.
- Mesh and DGM picks have no equivalent of "sample 20 k points" — they
  need a real index.
- Click-precise picking demands sub-pixel accuracy, which sampling can
  never give.

Constraints from `AGENTS.md` §2.0 ("Import teuer, Runtime billig") and §2.3
("Cursor-Budget"): no per-event O(N) scan over the global dataset,
refinement ≤ 2 ms, GPU pick < 1 ms.

The first iteration of this ADR (2026-05-08) shipped a custom
full-window pick pass + custom point octree. That pipeline was
correct in principle but bottlenecked at the global-render step: at a
multi-million-point budget it consumed almost the entire frame budget. After the
streaming pivot to Potree 2.0 (ADR 0003), Stage 1 is now a scissored
on-demand pick from the vendored three-loader, and Stage 2 walks
only the streaming subset that is currently in GPU memory. The
_contract_ (`SnapProvider`, `SnapResult`, `SnappingService`) is
unchanged; only the providers are rewired.

## Decision

A **two-stage hybrid** cursor pipeline:

```
Pointer event ─┬─► Stage 1: scissored GPU pick (on demand)
               │     three-loader Potree.pick → PickPoint{position, pointIndex}
               │     Cost: ~0.5–1 ms, ≤ 17×17 px render + 4-byte readback.
               │
               └─► Stage 2: per-entity provider refinement
                     ├─ point cloud: PotreeSnapProvider
                     │     · Stage 1 hit       → kind: 'Point' (conf 0.97)
                     │     · k-NN over visible nodes (AABB-prefiltered)
                     │     · weighted PCA plane fit → kind: 'EstimatedSurface'
                     ├─ mesh:        per-tile BVH → vertex / edge / face   (todo)
                     ├─ DGM:         grid → bilinear surface                (todo)
                     ├─ splat:       splat tree → covariance ray hit       (todo)
                     └─ CAD:         direct vertex / edge / face index     (todo)
                       │
                       ▼
                CursorCoordinateService ranking + hierarchy
                (Space cycles, getLatestStable() drives orbit pivot,
                 getLatestExact() drives click)
```

Stage 1 is O(pixels read), Stage 2 is O(points-in-AABB-around-cursor).
**The total dataset size enters neither asymptotic.** With a configurable
multi-million-point budget, k-NN scans typically touch < 50 k points,
comfortably under the 2 ms refinement budget.

### Stage 1: scissored GPU pick (three-loader)

- Provider: `vendor/three-loader/src/point-cloud-octree-picker.ts`,
  exposed via `Potree.pick(clouds, renderer, camera, ray, params)`.
- The picker renders the visible nodes into a small RGBA8 + depth
  render target, gl-scissored to `pickWindowSize` (default 17 px →
  ±8 px hit radius around the cursor). One pixel readback decodes
  `(point_index, draw_id)`; the picker then resolves world position
  from the per-node `position` attribute.
- Cost on reference hardware: 0.5–1 ms total (render + readback).
  Picks fire only on snap query, never per render frame — the main
  render loop carries no extra pass.
- Per-cloud closure (`pickRay` in `Viewport.tsx`) wires renderer +
  camera into the snap layer without leaking WebGL into the snap
  module.
- When the user lands between samples, Stage 1 returns null and
  Stage 2 takes over.

### Stage 2: per-entity providers

- `SnapProvider` interface (`packages/@himmelcad/viewer/src/snapping/`)
  consumes the cursor ray (and may invoke the Stage 1 pick) and emits
  ranked `SnapResult[]` candidates. The `SnappingService` merges
  providers, applies hysteresis, and exposes Space-key cycling.
- **Point cloud (active):** `PotreeSnapProvider`
  - Stage 1: invokes the closure-bound `pickRay`. On hit, emits a
    `Point` candidate with confidence ≈ 0.97.
  - Stage 2 always: walks `cloud.visibleNodes` (the streaming
    working set), AABB-prefilters them against a search sphere
    around the Stage 1 anchor (or a depth-derived ray anchor if the
    pick missed), runs a top-k = 24 k-NN against the prefiltered
    nodes' `position` buffers, fits a weighted PCA plane to the
    neighbours, intersects the ray with the plane → emits an
    `EstimatedSurface` candidate with confidence shaped by
    planarity and pixel-distance.
  - Search radius scales with `worldPerPixel * interpolationPixelRadius`
    so the experience is consistent across zoom levels.
  - All inner-loop scratch state (`Box3`, `Sphere`, `Vector3`,
    Float64 heap) is module-static and reused across queries.
    Zero per-query allocations.
- **Fallback:** `FallbackSnapProvider` (always registered) intersects
  the ray with a horizontal Z-plane (Z=0 by default, last stable Z
  if available) so the cursor still has a coordinate over empty
  space and orbit/zoom still have a sensible pivot.
- **Mesh, DGM, splat, CAD:** stub providers exist
  (`MeshSnapProvider`, `DgmSnapProvider`, `SplatSnapProvider`,
  `CadSnapProvider`) documenting the contract; their bodies activate
  as their layer types and tile formats land.

### Streaming working set as the spatial index

- The spatial index is _implicit_ in `cloud.visibleNodes`. Each visible
  node carries:
  - bounding box (already in cloud-local coordinates),
  - `geometry.attributes.position` (Float32Array of node-local points,
    offset by `sceneNode.position` → cloud-local).
- `pointBudget` caps the worst-case Stage 2 scan
  _before_ AABB pre-filter; after pre-filter, scans typically touch
  < 50 k points.
- This replaces the earlier custom `PointOctree` + `.octree` sidecar
  files. Rationale: building a second index for snap when three-loader
  already streams a frustum-correct LOD subset is wasted IO; the
  AABB pre-filter is cheap enough to make the working set behave
  like an ad-hoc k-NN index.
- For datasets where the working set is too sparse to give a stable
  k-NN (e.g. extreme zoom-out), Stage 2 confidence drops naturally
  (planarity term + pixel-distance term) and the fallback grid takes
  over for orbit/zoom.

### Renderer integration

- `packages/@himmelcad/viewer/src/snapping/PotreeSnapProvider.ts`:
  the active two-stage provider.
- `packages/@himmelcad/viewer/src/Viewport.tsx`:
  - registers a `PotreeSnapProvider` per loaded cloud in
    `loadPotreePointCloud`, capturing renderer + camera refs in the
    `pickRay` closure.
  - calls `snapping.query(...)` once per `requestAnimationFrame`
    (rAF-throttled).
  - Space key cycles `snapping.cycleCandidate(±1)` for snap hierarchy.
- The legacy `PickingPass` + `PointCloudPickMaterial` + `PointOctree`
  files (`packages/@himmelcad/viewer/src/picking/`,
  `packages/@himmelcad/viewer/src/spatial/octree.ts`) are no longer
  active; they are kept until Phase 2.7 deletes them.
- The Rust-side `crates/himmelcad-spatial` crate stays — it will host
  the BVH/grid indices for mesh/DGM and the WASM-targeted shared
  query API once those land. It is not on the point-cloud cursor path
  any more.

### Cursor service contract

`SnapResult` (in `@himmelcad/data`) carries:

- `position` (world, `f64` transport),
- `localPosition` (renderer-local `f32`, mostly diagnostic),
- `kind` ∈ {Vertex, Point, Edge, Face, EstimatedSurface, Grid, Free},
- `entity`, `confidence`, `source`, `distancePx`, `stable`, `candidateId`.

`SnappingService`:

- `query(input)` → ranked `SnapQueryResult` with current winner +
  candidate stack + hierarchy key.
- `cycleCandidate(±1)` for Space cycling.
- `getLatestStable()` for orbit/zoom pivot (doesn't move when the user
  hovers a momentarily-empty pixel).
- `getLatest()` for the cursor display.
- `candidateCount()` so callers know whether cycling is meaningful.

`SnapQueryInput`:

- `pick`: legacy field, currently unused (the pre-pivot per-frame pick
  pass populated this; the on-demand pick is invoked inside the
  provider via the `pickRay` closure). Will be repurposed for shared
  cross-provider pick caching once a second pickable layer type lands.
- `pickNeighborhood`: optional 33×33 enumeration, populated only on
  explicit hierarchy requests. Currently null in production (no
  per-frame pick pass to read from); will return when MRT shared pick
  caching ships.
- `intent` ∈ {hover, pivot, pick, draw}: lets future providers tune
  exact-vs-stable trade-offs.

## Consequences

### Positive

- Cursor is exact wherever a sample exists (Stage 1), smooth in gaps
  (Stage 2), never scans typed arrays beyond the streaming working
  set.
- Architecture scales to billion-point datasets: with `pointBudget`
  fixed, snap cost is independent of dataset size.
- Drawing / measurement / orbit / pick all consume the same
  `SnapResult`. No shadow APIs.
- Stub providers for mesh / DGM / splat / CAD reserve the design today;
  switching them on later is a body change, not an interface change.
- No per-frame pick pass — the render loop is uncontested.

### Negative / accepted trade-offs

- Stage 2 scans Float32 position buffers in JS. Acceptable with the current
  configurable point-budget range and AABB pre-filter (typically < 50 k points
  per query, < 1 ms). If profiling shows dense scans dominating pointer
  latency, we port the inner loop to a Web Worker or WASM.
- We rely on three-loader's `visibleNodes` invariant. If the streamer
  ever swaps the in-flight set mid-query the worst case is one
  stale-by-one-frame snap; the snap query is rAF-throttled so this
  is bounded to ~16 ms.
- The legacy `PickingPass` / `PointOctree` code is dead but still
  present until Phase 2.7. Will be removed once snap + render is
  considered stable.

## Follow-ups

- Triangle BVH + `MeshSnapProvider` body once a mesh layer lands.
- Grid index + `DgmSnapProvider` body once a DGM layer lands.
- Shared pick caching: when more than one pickable layer type exists,
  factor the GPU pick out of `PotreeSnapProvider` into a viewport-
  level service and re-fill `SnapQueryInput.pick` so all providers
  share one readback.
- `SnapResult.worldPositionF64` becomes a typed `Vec3F64` once CAD
  drawing tools start writing geometry (snap currently transports
  `f64` via `position` but typed `f64` vectors prevent accidental
  `f32` truncation in tool code).
- Optional WASM port of the k-NN inner loop if profiling shows it
  dominates frame time on dense scans.
