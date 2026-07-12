# ADR 0003 — Point-Cloud Streaming Architecture (Vendored Potree 2.0 Stack)

## Status

Accepted (Phase 1 hotfixes shipped; Phase 2 implementation in progress).

## Date

2026-05-08

## Context

ADR 0002 stood up a two-stage hybrid cursor pipeline (GPU pick + per-entity
provider refinement) on top of the MVP point-cloud renderer
(`PointCloudLayer`: a single monolithic `THREE.Points` per cloud,
`PickingPass`: full-window render-target every frame). With a 5 M-point LAS
file we measured the cursor latency at ≈ 100× over the budget defined in
`AGENTS.md` §2.3, and orbit/pan dropped well below 60 fps on commodity
hardware. The bottleneck is structural, not parameter-tunable:

- The whole cloud is uploaded into one GPU buffer and drawn in full every
  frame, regardless of viewport coverage or distance.
- The pick pass redraws that same monolithic geometry into a full-window
  render-target every frame, doubling the per-frame point throughput.
- There is no level-of-detail, no frustum culling, no point budget.
- Future targets (100 M-triangle textured meshes, Gaussian splats, hundreds
  of millions of CAD primitives) cannot be served by any extension of this
  pattern — they need real streaming with hierarchy + LOD + budget.

The roadmap targets billions of points (`AGENTS.md` §2.2). Reinventing the
streaming + LOD machinery from scratch would consume weeks before any
visible improvement, and would re-discover algorithms that the Potree
ecosystem already ships in production.

`AGENTS.md` §1.6 (added in this same change set) makes the right move
explicit: a license-compatible existing implementation **is** HimmelCAD
once we vendor it. We must not draw an artificial line between "library"
and "our code".

## Decision

Adopt the **Potree 2.0 stack**, vendored into the HimmelCAD source tree:

| Concern                      | Vendored asset                                                         | Upstream license       |
| ---------------------------- | ---------------------------------------------------------------------- | ---------------------- |
| **On-disk tile format**      | Potree 2.0 (`metadata.json` + `hierarchy.bin` + `octree.bin`)          | BSD 2-Clause           |
| **LAS / LAZ → tile builder** | **PotreeConverter 2.1** binary in `vendor/potreeconverter/<platform>/` | BSD 2-Clause           |
| **Renderer streaming + LOD** | **`@pnext/three-loader 1.0.x`** source in `vendor/three-loader/`       | MIT (+ BSD-2 portions) |
| **Cursor refinement**        | Existing `crates/himmelcad-spatial` (PointOctree, PCA plane fit)       | BSL 1.1 (ours)         |
| **Tile abstraction**         | Existing `streaming/TiledDataset` interface (HimmelCAD)                | BSL 1.1 (ours)         |

All three vendored assets are listed in `LICENSES/THIRD_PARTY.md` with the
upstream commit SHA and their original `LICENSE` files mirrored next to
the vendored sources.

### On-disk format (Potree 2.0, unchanged)

A point cloud entity stores under
`<projectCache>/clouds/<entityHash>/potree/`:

- `metadata.json` — global properties: bounds, scale, point format, root
  node id, attribute schema, encoding (`DEFAULT` or `BROTLI`), spacing
  series for SSE.
- `hierarchy.bin` — flat binary octree topology. Per node: type (proxy /
  leaf / inner), child mask, point count, byte offsets into `octree.bin`.
  Lazily expandable (proxy nodes inflate when traversed).
- `octree.bin` — concatenated per-node point payloads (XYZ, RGB,
  intensity, classification, …) interleaved per the metadata's attribute
  schema.

A small `himmelcad.json` sidecar in the same directory records our
project-level extensions: `entityId`, render-offset (for the f64 → f32
mapping), HimmelCAD attribute mappings (layer ids, classification labels
mapped to HimmelCAD codes, etc.). The Potree files themselves stay
untouched — that keeps the format compatible with any future Potree-native
tooling we want to invoke.

### Importer (vendored PotreeConverter binary)

`crates/himmelcad-io::las_import::import_las_file` becomes a process
launcher: it shells out to `vendor/potreeconverter/<platform>/PotreeConverter`,
streams stdout/stderr into our console (parsed for progress lines so the
Vite-side progress bar in `App.tsx` keeps working), and produces the
Potree 2.0 directory above. The current Rust LAS reader path is kept
behind a `--legacy-flat` feature flag for unit-test fixtures that don't
have PotreeConverter available.

The converter binary is downloaded by `pnpm postinstall`
(`scripts/fetch-vendor.mjs`) with SHA-256 verification, never committed.
For platforms without prebuilt binaries (currently macOS) the script
falls back to building from source via the upstream CMake project.

### Renderer (vendored `@pnext/three-loader`)

`vendor/three-loader/` holds a snapshot of the upstream library, pinned
to a known-good commit. We treat it as **our streaming engine** — free
to refactor, replace files, or strip features we don't need. We integrate
it via a TypeScript-only build, no separate package publish; the viewer
package imports it as `@himmelcad/three-loader`.

Architecture in the viewer:

```
PotreePointCloudDataset (implements TiledDataset)
        │
        ├─ wraps three-loader's `Potree` runtime + `PointCloudOctree`
        ├─ owns: metadata, point budget, LOD parameters
        │
        ▼
PointCloudLayer (existing, refactored)
        │  no longer holds a single THREE.Points; instead exposes
        │  the PointCloudOctree as its `object3d` so the SceneGraph
        │  add it like any other entity layer.
        ▼
TileStreamingService.update(camera) per tick
        │
        ▼
three-loader internally:
        - frustum cull
        - screen-space-error walk
        - LRU node cache (geometry dispose on evict)
        - point budget enforcement
        - GPU-driven HTTP range fetches via hcad-cache://
```

`hcad-cache://` (the Electron custom protocol) gains **HTTP `Range`
request support**. Without it, `octree.bin` (often hundreds of MB)
cannot be partially fetched, defeating the streaming.

### Cursor coordinates (ADR 0002 contract preserved)

The pipeline contract from ADR 0002 (`SnapResult`, `SnappingService`,
provider stack, Space-cycling) **does not change**. What changes is the
implementation of the picking-and-refinement stages:

```
Pointer event ─► pendingCursorEvent (rAF-throttled, see Phase 1)
                 │
                 ▼
                 once per frame:
                 │
                 ├─ Stage 1: three-loader scissored on-demand pick
                 │     (only for cycling / clicks; not every frame)
                 │     → (PointCloudOctree, node, point_index, f32 pos)
                 │
                 └─ Stage 2: per-node refinement (himmelcad-spatial)
                     ├─ resolve f64 absolute position via render-offset
                     ├─ k-NN within the hit *node* (~ 50 k pts) for plane
                     │   fit / interpolation in gaps
                     ├─ ranks against MeshSnapProvider, etc.
                     ▼
              CursorCoordinateService unchanged
```

The previous `PickingPass` (full-window every frame) and
`PointCloudPickMaterial` are **deleted** — three-loader's pick path
replaces them. `PointCloudSnapProvider` is rewritten to call
`pointCloudOctree.pick(renderer, camera, ray)` from three-loader on
demand (cycling / click intent), then refine through the per-node
buffer geometry using our Rust spatial code.

For "hover" intent (the dominant case), the cursor uses only Stage 2
against the **closest visible node's** local octree — the GPU pick is
skipped. Visible nodes are at most a few thousand points each, so
k-NN against the right node is microseconds; one octree lookup gives
us `f64` precision plus interpolation in gaps. This trades a per-frame
GPU readback for a per-frame CPU spatial query that actually fits
the budget.

### Hooks for the rest of the roadmap

`TiledDataset` stays the abstraction across geometry types:

- **Mesh tiles (PhotoLab outputs, BIM, hi-res textured meshes):**
  separate dataset (e.g. `MeshTileDataset`) backed by a different
  vendored loader (likely `3d-tiles-renderer`, Apache-2.0) once
  Workstream M lands.
- **Gaussian splats (PhotoLab):** `SplatDataset` over a vendored
  splat loader (`gsplat-three` or equivalent, MIT/BSD-class).
- **CAD entities, axes, IFC:** generated geometry, no streaming —
  consumed by the SceneGraph directly, snap providers refine via
  the same `himmelcad-spatial` queries on their authored geometry.

The `SnappingService` ranks across all of them. The cursor pipeline
absorbs every future entity type as a new provider, never as a new
contract.

## Consequences

### Positive

- Streaming + LOD + frustum cull + point-budget come from a production
  loader (used by Pix4D), not from us. Weeks of machinery saved.
- Disk format is the de-facto standard for large WebGL point clouds.
  Files we produce can be opened with stock Potree viewer for diagnostics
  or by WeltView without an extra format port.
- Cursor latency budget is achievable: per-frame work scales with the
  _visible_ node set, not total cloud size. Billion-point clouds become
  the same per-frame cost as million-point clouds.
- Same `TiledDataset` abstraction generalises to mesh / splat /
  CAD streaming — those land later as new dataset types, not as new
  cursor pipelines.
- Vendored code is _ours_ per `AGENTS.md` §1.6: when we hit a
  three-loader limitation (BROTLI encoding, MRT pick > 256 nodes,
  custom material modes), we patch the vendored copy in-place rather
  than fighting upstream.
- ADR 0002's external contract (`SnapResult`, `SnappingService`,
  Space-cycling, intent differentiation) is preserved; downstream
  consumers (drawing tools, measurement, orbit-pivot) are unaffected.

### Negative / accepted trade-offs

- We add ~ 14 MB per platform of PotreeConverter binary to the
  installer. Acceptable for a desktop CAD product.
- three-loader peers `three ~0.160`; our app is on `0.169`. We pin
  to a working pair and patch upstream if a regression appears. If
  the patch surface grows, the fallback is `potree-core 2.0.15` which
  peers `>0.125`.
- Three-loader's stock pick result is `f32` from a GPU buffer. We do
  the f64 refinement ourselves (Stage 2). This is the same correctness
  step ADR 0002 already required.
- `hcad-cache://` Electron protocol must implement HTTP `Range`. One
  module change in `apps/builder/electron/main.ts`; no
  cross-cutting impact.
- BROTLI-encoded Potree 2.0 is not yet in three-loader's released
  build (PR #283 open upstream). We disable BROTLI in PotreeConverter
  output (`-encoding DEFAULT`) until that lands; uncompressed
  octree.bin is acceptable for v1.
- The previous in-tree `PickingPass`, `PointCloudPickMaterial`, and
  the monolithic `PointCloudLayer` build path are deleted. Their
  responsibilities all move into vendored code or into the new
  `PotreePointCloudDataset` wrapper.

### Migration

- **Phase 1 (shipped):** GPU pick disabled, cursor query rAF-throttled,
  cursor overlay decoupled from React, importer cap lowered to 1 M
  points so existing 5 M-point users are usable while Phase 2 lands.
- **Phase 2:** vendor + integrate (this ADR). Importer rewrites to call
  PotreeConverter; renderer rewrites to use three-loader; snap providers
  rewrite to use the per-node refinement path.
- **Phase 3:** documentation (AGENTS.md §2.2 / §2.3, ADR 0002 update),
  performance smoke tests with synthetic 100 M / 1 B-point datasets.

### Why not …?

- **Custom hierarchical format from scratch.** Considered first; rejected
  per `AGENTS.md` §1.6. Re-deriving Poisson-disk LOD sampling, splitting
  rules, and serialization layout for ~ 0 architectural advantage over
  Potree 2.0 burns time without changing the runtime budget.
- **Cesium 3D Tiles + `3d-tiles-renderer` for points.** Apache-2.0,
  active. But the tooling pipeline (tilers, hosting, previewers) is
  meshier-and-mixed by design; for billion-point pure point clouds the
  Potree pipeline is the more direct fit. We will likely adopt
  `3d-tiles-renderer` for the mesh dataset later (different `TiledDataset`
  implementation). Two formats coexist cleanly under the abstraction.
- **`potree-core` instead of `@pnext/three-loader`.** Both are MIT and
  BSD-2 derived. `potree-core` ships BROTLI today and has a more
  permissive `three` peer range; `@pnext/three-loader` is the canonical
  Potree-blessed library and used by Pix4D. We start with three-loader;
  if BROTLI urgency or three-version drift forces it, switching to
  `potree-core` is a vendor-folder swap, not an architecture change.
