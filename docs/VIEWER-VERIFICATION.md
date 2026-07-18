# Viewer Verification

The shared viewer is verified through three independent gates. A screenshot is
never accepted as proof of geometric correctness or performance.

## Foundation stage A report — reached 2026-07-17

Foundation stage A is reached. The accepted boundary is the ADR 0016/0017
viewer kernel and package facade, not the complete long-term entity catalog.

- The browser entity zoo renders authored CAD, a translated Potree cloud,
  prepared/textured mesh content, a topology-aware elevation raster and
  Gaussian splats in one render world. Both explicit WebGPU and forced WebGL2
  execute the same Rust/wgpu engine, worker artifacts, picking and clip paths.
- Orbit, pan, zoom, top-down/local views and user viewpoints use the shared
  camera controller. Rust calibration publishes separate idle and interaction
  streaming ceilings without replacing residency or imposing low-device caps
  on stronger adapters.
- Vertical exaggeration remains presentation-only; source-space picks and clips,
  provider-neutral f64 placement, canonical CAD snaps, clip boxes and exact
  partitioned section topology are covered by ordinary automated gates.
- `TransformEntity` commit, undo, redo and final undo retain resident streamed
  content, exact source picks and proxy identities while advancing the shared
  append-only journal.
- `KernelViewerScene` is the stable package facade for canonical inline content,
  Potree, prepared mesh/TIN and generic prepared raster/splat hierarchies. Entity
  hide/show preserves residency and current stream selection. Unload atomically
  retires exact canonical bindings, removes dataset hierarchy/contract state,
  cancels coordinator tickets and host fetch/decode work, and releases host pick
  metadata so the dataset identity can be registered again deliberately.
- Pixel coordinates are now consistent across canonical and streamed raster
  paths: integer column/row addresses denote pixel centres and cell boundaries
  lie at plus/minus one half pixel. Pixel-step geometry, NoData and exact raster
  picks use that same convention on both browser backends.

The completion run passed 306/306 render-core tests, 6/6 native WASM tests,
69/69 viewer host tests, the wasm32 compile check, both TypeScript contract
checks, forced WebGL2 on the physical Intel HD Graphics 630 and the explicit
WebGPU correctness gate. The WebGPU adapter on this host reported CPU, so this
is not a WebGPU hardware-performance claim.

The rare billion-point/mixed scale gate was intentionally not repeated for the
facade/lifecycle changes. Its latest accepted low-profile result remains
3,040,128 resident points plus 524,288 textured DGM triangles and 100,000
splats at p95/p99 31.7/45.8 ms. The physically populated 10M mainstream run
remains a residency success but a latency non-pass on the old Quadro M2200;
its 20.0–23.6 ms p95 is not relabelled or weakened.

## Test scene classes

- `entity-zoo`: every canonical entity and curve variant, mixed XY/XYZ areas,
  holes, text, dimensions, blocks and instances.
- `clip-zoo`: curves, areas, elevation surfaces, open and closed meshes,
  rasters, point clouds and splats intersect all six clip-box planes.
- `precision-torture`: identical millimetre geometry near zero, at projected
  million-scale coordinates and at ECEF scale.
- `mixed-real`: point cloud, 3D Tiles mesh, orthophoto/height raster, splats,
  IFC and DXF placed through explicit transforms.
- `intentional-overlap`: overlapping representations for depth, transparency
  and Tab/Shift+Tab candidate ranking.
- `streaming-stress`: independent and mixed point, triangle, texture and splat
  pressure.
- `edit-preview`: deterministic pointer trace updates alignment/slope-derived
  geometry without committing intermediate entities.
- `section-caps`: closed solids and layered walls with analytically known
  contours and hatch regions.
- `2d-3d-transition`: deterministic perspective-to-orthographic camera path.
- `local-view-frames`: arbitrary orthonormal profile/section frame, local
  cursor coordinates and deterministic return to the captured 3D camera.

## Coordinate handling

Downloaded source coordinates and CRS metadata remain immutable.

```text
source coordinates
  explicit CRS/vertical transformation
  project world frame
  optional test placement
  camera-relative GPU coordinates
```

Real georeferenced scenes retain their location. Mixed-layout scenes place each
dataset through a recorded transform. Intentional-overlap scenes use another
recorded placement. No fixture rewrites source vertices to `0,0,0`.

Every external asset lock records source URL, resolved revision or acquisition
date, license and attribution, SHA-256, byte size, format, source CRS WKT2,
horizontal and vertical datum, epoch, units, bounds and deterministic derivation
recipe.

## Visual regression

Playwright uses fixed camera, viewport, DPR, fonts, backend, Electron/browser
version and device profile. Randomness, time and adaptive quality are frozen.
The viewer exposes `settled` only when downloads, decodes and GPU uploads needed
for the target frame have finished.

Golden images are backend/profile-specific. Pixel comparison is used only on an
identical runner; approved cross-GPU comparisons use a perceptual metric.

## Geometric correctness

Synthetic scenes provide analytic CPU oracles. A debug pass exposes entity ID,
render-proxy ID, tile ID, primitive ID, linear depth and reconstructed world
position.

Initial tolerances:

- local CAD coordinates: 0.1 mm;
- projected projects up to 20 km: 1 mm;
- globe-scale views: 1 cm;
- vector screen projection: 0.5 px;
- picking: source quantization or the corresponding world tolerance, whichever
  is larger.

Samples strictly inside a clipped half-space may not write color, ID or depth.
Closed solid sections are compared by contour and area. Point clouds and splats
have no generated solid cap.

## Performance

Performance comes from renderer telemetry, not Playwright duration. Each run
records CPU and GPU frame p50/p95/p99, long frames, input-to-visible-frame time,
first useful frame, target-LOD time, download/decode/upload time, resident CPU
and GPU bytes, visible primitives, achieved SSE, evictions, allocation failures
and device loss.

Cold and warm caches are separate. Reference camera paths run thirty times;
the first five are warm-up. A repeated regression above 10 percent in p95 frame
time or 15 percent in memory blocks integration.

Initial navigation targets:

- low profile at 1080p: p95 at or below 33 ms, p99 at or below 50 ms;
- mainstream at 1440p: p95 at or below 16.7 ms, p99 at or below 33 ms;
- high profile at 4K: p95 at or below 16.7 ms at materially higher LOD;
- mobile: p95 at or below 33 ms over a thermally stable five-minute path.

Software-rendered CI is a correctness runner only.

The real LAS/Potree admission boundary has an independent import gate. It
requires deterministic SHA-256 roots over `metadata.json`, `hierarchy.bin` and
`octree.bin`, content-addressed dataset deduplication, a distinct stable entity
identity, exact canonical geometry/entity hashes and rejection of modified
support objects. Hashing and duplicate verification are streaming operations;
the test never reads `octree.bin` as one allocation. Browser host tests then
require metadata SHA-256 verification before registration, a bounded first
hierarchy range and shared kernel-resolved HTTP concurrency for bootstrap and
ordinary tile traffic. Cancellation during hashing must remove the unpublished
dataset, and a sidecar operation token must not survive completion. The current
unit gates are 18 passing `himmelcad-io` tests, 306 passing render-core tests and
69 passing viewer host tests.

The headless native Linux gate also executes the actual wgpu device path, not
only contract tests. Mixed color/depth/clip/pick passes, weighted OIT,
mixed-height CAD curve compilation and incremental GPU calibration all pass on
the available Vulkan-capable device. Android and Windows cross-compilation
both reach the target-specific wgpu backend but currently stop in the native
BasisU build because this machine has neither an Android NDK clang++ nor a
Windows clang++ cross-toolchain. That is an environment/toolchain gate, not a
claimed mobile runtime pass; sustained physical Android/iOS tests remain open.

The July 17, 2026 low-profile hardware gate passed on the real NVIDIA Quadro
M2200 WebGL2 path (ANGLE/Vulkan) with 3,040,128 resident points, 96 draw calls
and 109,444,608 resident GPU bytes. During fast zoom/orbit and rapid direction
changes the measured planning p95/p99 was 20.7/30.5 ms, streaming-host p95 was
3.6 ms and render/present p95 was 1.7 ms. The same run traversed a logical
1,185,930,249-point, 37,449-node hierarchy and proved lazy pages, eviction,
re-entry, selective range re-fetch and generation-safe cancellation.

The mixed civil-scale extension of that gate also passed on the same physical
adapter and backend. One frame population simultaneously retained 3,040,128
points, 524,288 triangles from tiled textured DGMs, 100,000 Gaussian splats,
64 distinct 256x256 RGBA textures (16,777,216 texture bytes) and 170 draw calls.
Peak resident GPU bytes were 150,692,480. The logical sources remained much
larger at 1,185,930,249 points, 4,194,304 triangles and 2,000,000 splats, so the
gate proves bounded physical residency rather than allocating the declared
totals. Every DGM leaf is a real indexed GLB with its own PNG and every splat
leaf is a real 10,000-record PLY decoded through the transferable worker path.

After the placement-aware streaming and asynchronous authoritative clip-cap
milestone, the low mixed gate was repeated on July 17, 2026 on a physical Intel
HD Graphics 630 through forced WebGL2. It again retained 3,040,128 points,
524,288 textured DGM triangles, 100,000 splats, 64 textures and 170 draw calls
with 150,692,480 peak resident GPU bytes and no provider failures. Across the
bounded 240-frame population the effective CPU p95/p99 was 31.7/45.8 ms, within
the low-profile 33/50 ms gate. During fast zoom/orbit and rapid direction
changes with live streaming, render/present p95/p99 was 13.7/15.8 ms and plan
p95/p99 was 6.3/7.2 ms; eviction and re-entry both occurred. The logical source
remained 1,185,930,249 points, 4,194,304 triangles and 2,000,000 splats.

The Rust hardware policy now publishes separate idle and active-interaction
streaming ceilings, and the production `KernelViewport` selects between them
from orbit/pan/zoom/edit-drag state. It keeps already resident quality visible
and reduces only disposable traversal, decode, upload and request work. On the
measured adapter the active-input ceiling was 2,000 traversed nodes, 0.668 ms
traversal, 1.503 ms decode, one request and 1,048,576 upload bytes; idle frames
immediately return to the full calibrated budget. With fetch and decode still
active, planning p95/p99 was 4.5/7.0 ms, streaming-host p95/p99 was 0.1/0.1 ms
and render/present p95/p99 was 8.4/9.8 ms. The zoom/orbit and abrupt-direction
bursts had maximum CPU times of 15.8 and 21.1 ms respectively, with no frame
above 50 ms. Both ceilings scale from measured device capability, so a
low-profile constant does not cap mainstream or high hardware.

The 10M mainstream population was also physically reached on that Quadro:
12,160,512 points, 2,097,152 textured DGM triangles, 500,000 splats, 256 unique
textures and 690 draw calls occupied 607,969,920 peak GPU bytes without provider
failures. The strict 1440p-class interaction gate remains open because this
older mobile workstation GPU measured p95 between 20.0 and 23.6 ms across the
production-quality runs rather than the required 16.7 ms; p99 reached 25.2 ms
in the best run. Runtime quality had already reached its configured floor, so
the gate is not weakened and the 10M pass must be repeated on suitable
mainstream hardware. This distinguishes successful large-data residency from
an unproven device-class latency claim.

The same mixed gate exposed and now permanently covers two cross-provider
failures: strict glTF dependency inspection receives only its declared
metadata fields, and admission eviction ranks entries by how many currently
over-budget resource dimensions they actually relieve. A full point budget
therefore replaces an evictable point tile instead of discarding a textured
DGM that cannot free point capacity. The host retains a bounded recent-failure
diagnostic so future provider/decode/upload faults are actionable without
turning expected cancellations into errors.

Admission retains a per-dataset frontier equal to 64 frames of the current
request allowance. Decoded upload candidates are never truncated. This keeps
quality progression and cross-dataset fairness intact while preventing huge
visible hierarchies from serializing thousands of per-tile rejection records
through the WASM/JSON boundary every interaction frame.
The ordinary frame response also retains visible tile keys inside Rust after
applying visibility and returns only `renderCount` plus actionable host work.
Exact key lists are opt-in diagnostics, avoiding O(visible tiles) JSON and
JavaScript string allocation in the production interaction path.

Streamed move previews now traverse every registered provider hierarchy at the
f64 moved placement and feed their target selections into the same scheduler as
an auxiliary consumer. Automated scheduler gates prove that source and target
demand coalesce once at maximum SSE, hierarchy requests share the same ceiling,
target residency is pinned, and auxiliary tiles cannot leak into the canonical
render list. The browser fixture moves a Potree entity by
`(750.125, -420.25, 15.5)` at ECEF-scale coordinates, aims the camera only at
the target, and asserts both the exact world delta and that the source plan does
not contain the dataset. On July 17, 2026 this passed through forced WebGL2 on
the physical Intel HD Graphics 630 and through the explicit WebGPU browser
path. The WebGPU adapter in that run identified as CPU, so this is a backend
correctness result rather than a WebGPU hardware-performance claim. Native WASM
tests remain 6/6, the render suite 306/306 and the viewer host suite 69/69.

The same browser gate now commits that preview through the canonical command
path. It first proves that a stale command is rejected atomically, then checks
the exact translated Potree pick, stable resident decode counters and proxy
count, monotonically replaced slot generations, and revisions 2 through 5 over
commit, undo, redo and final undo. The four operations are present in the
shared append-only journal and the fixture restores the source placement before
the remaining viewer assertions run. This extended gate passed on the physical
Intel HD Graphics 630/WebGL2 path; the explicit WebGPU path is part of the same
required correctness gate.

The synthetic billion-point scale gate has separate physical `low`,
`mainstream` and `high` profiles. They materialize at least 3M, 10M and 30M
resident points respectively instead of counting the logical hierarchy as GPU
work. The bounded startup calibration is recorded but cannot veto an explicit
physical profile: its small workload guides normal adaptive policy, while the
profile's actual resident workload and p95/p99 navigation measurements decide
acceptance. Before a profile starts, the harness independently probes the browser's
WebGL renderer and rejects SwiftShader, llvmpipe and other software paths. On a
Linux PRIME system an explicit hardware run can use
`HCAD_CHROME_ANGLE=vulkan` together with the driver's PRIME-offload variables;
the selected adapter and browser renderer remain part of the result.

## Current automated foundation gates

- the Rust-owned runtime governor consumes one bounded 240-frame telemetry
  stream; invalid samples do not mutate it, hidden proxies plus clip/move
  previews contribute to complete residency/workload, and a real WebGPU test
  charges shared external i3dm geometry to its first owner's upload exactly once
  while an identical second owner retains only its tile-local upload cost;
- capability-gated whole-frame GPU timestamps use a preallocated three-slot
  asynchronous readback ring. Unit gates reject reversed/stale intervals and
  slot reuse; the browser gate requires a positive completed sample when WebGPU
  advertises timestamp queries, while forced WebGL2 must remain cleanly
  unsupported with `latestGpuMs: null`;
- runtime streaming-limit tests apply low and high decoder/content-request
  ceilings to identical selections, share the I/O limit between tile and lazy
  hierarchy fetches, reconfigure without losing residency/live generations and
  allow stale callbacks to release no newer slot; WASM policy updates apply the
  same ceilings without rebuilding the coordinator, while host tests measure
  different real HTTP concurrency peaks for identical multi-content plus
  hierarchy workloads and cover wakeup, abort and disposal without permit
  leaks. A real browser gate transfers a 3.4 MB, 50,000-splat PLY into a module
  worker, requires a main-thread event-loop tick before decode completion,
  verifies the returned `HCDECODE` artifact and stages it without a provider
  re-decode. Repeated entity, style, origin, clip and section mutations must
  leave both provider-decode and worker-artifact-ingest counters unchanged.
  Worker concurrency is capped by a 512 MiB RAM budget and a reservation of at
  least 256 MiB per worker, with measured baseline and peak WASM linear memory
  included in diagnostics. The release artifact gate requires raw WASM at most
  6 MiB, optimized WASM at most 4 MiB and optimized gzip at most 1.5 MiB;
- mixed XY/XYZ area JSON round-trip preserves unknown Z as `null`;
- millimetre deltas survive camera-relative conversion at ECEF-scale world
  coordinates;
- Potree 2.0 binary hierarchy records and explicit 3D Tiles 1.1 transforms,
  bounds, refinement and content addresses are checked against deterministic
  fixtures;
- embedded GLB node/content transforms, normals, UVs, vertex colors and base
  color textures are decoded and uploaded without pre-transforming source data;
- legacy `b3dm`/`i3dm`/`pnts`/`cmpt` inspection and decode share one structural
  validator for declared lengths, eight-byte tile/table/child boundaries,
  four-byte GLB chunks, payload padding and space-only external i3dm URIs;
  GLB1 `CESIUM_RTC` participates in the exact transform order, while malformed
  centers and material/technique references return errors rather than panics;
- legacy Batch Table JSON/binary rows address exact b3dm source triangles,
  i3dm instances and pnts features; `_BATCHID` GLB1/GLB2 attributes reject
  normalized, fractional, non-finite and out-of-range values, while bounded
  `3DTILES_batch_table_hierarchy` tests cover binary topology/properties,
  multiple-parent precedence, cycles and ambiguous inheritance;
- one unified pick-metadata envelope returns parallel modern glTF and legacy
  providers; real checksum-pinned Cesium hierarchy-b3dm uses an actual GPU
  triangle pick, real per-point-pnts resolves its provider catalog, and a
  synthetic pnts gate proves GPU pick → exact source point/BATCH_ID → direct and
  inherited row. The same assertions pass on real WebGPU and forced WebGL2;
- real generated `EXT_meshopt_compression` and `KHR_draco_mesh_compression`
  streams decode into the same exact indexed scene representation as ordinary
  GLB data;
- all attacker-controlled decode dimensions are checked before allocation or
  native codec entry: encoded/materialized bytes, aggregate instantiated glTF
  vertices/indices/primitives/depth, image axes/RGBA output, meshopt/Draco/KTX2
  output, raster topology, Gaussian row width, metadata arrays, point/instance
  counts and composite child counts each have bomb-regression tests;
- real ETC1S and UASTC-with-Zstandard KTX2 files transcode with complete mip
  chains to uncompressed and BC7 targets; the 32-pixel Khronos UASTC fixture is
  pinned at SHA-256
  `7bbd1d7776a087b48d3f7d50395d24840fd00dc5ab2622f8dce5685995df94d3`;
- perspective and orthographic hierarchy selection verifies frustum rejection,
  SSE refinement, Potree `ADD` and atomic 3D Tiles `REPLACE` fallback;
- asynchronous residency tests verify stale-task invalidation, exact cost
  snapshots, pinned fallback behavior and multi-dimensional LRU eviction;
- every multi-content tile crosses the WASM boundary as one publication
  transaction: all CPU/GPU resources are prepared against a private world
  snapshot, any failure restores every staging record, and only a complete
  preparation replaces the resident proxies; a forced second-allocation
  failure verifies that no first payload becomes visible; the real browser
  kernel additionally performs Potree → glTF → Potree under one stable stream
  ID and verifies the restored exact point pick;
- recursive external asset graphs fail closed: a missing descendant stages and
  publishes nothing, a newer residency generation aborts stale traversal,
  concurrent graphs coalesce transport without letting one consumer's abort
  cancel another, conflicting declarations are rejected, and the 4,096-edge
  ceiling is enforced before unbounded aggregation;
- immutable external buffers/images/schemas are shared within one render kernel by SHA-256 plus
  byte length, never by URI alone; different bundles may share one resource
  allocation, owner replacement/last-owner eviction updates refcounts
  atomically, fetch/decode retain conservative task costs, and uploaded tiles
  move bundle bytes into one global shared-residency cost instead of counting
  them once per tile;
- independently streamed `i3dm` owners with identical decoded indexed geometry
  share one immutable GPU vertex/index allocation and its expanded exact-pick
  vertices; their instance buffers, transforms, proxies and source-instance
  mappings remain tile-local, the browser diagnostic requires one allocation
  with at least two resident owners and non-zero shared GPU bytes, and exact
  transformed instance/face picks must remain unchanged;
- the render-core immutable texture/sampler cache unit gate and live browser
  transaction require two owners, one exact uploaded-byte/transcode/layout/
  color-space/sampler/decoder identity, one allocation and one global byte
  cost, while owner styles remain distinct; the second live owner performs no
  additional texture decode or GPU allocation, and rollback, replacement and
  last-owner eviction are atomic;
- resource-aware presentation bindings are exercised as rendered GPU frames on
  forced WebGL2 and explicit WebGPU: a live mixed-height area switches to a
  registered world-space hatch without affecting its boundary, `fill: none`
  suppresses only its fill color and pick fragments, an unmapped texture is
  rejected atomically, and a streamed elevation raster with declared UVs
  switches to a registered image and back to its immutable source texture.
  Proxy and batch identities remain stable across every transition and both
  provider-decode and worker-artifact-ingest counters remain unchanged. The
  July 17, 2026 forced-WebGL2 gate ran on the physical Intel HD Graphics 630;
  this host's explicit WebGPU adapter reported CPU and is therefore a backend
  correctness result, not a WebGPU hardware-performance claim;
- resource-aware stroke presentation uses the same live batch resolver and was
  exercised on the physical Intel HD Graphics 630 WebGL2 path and the explicit
  WebGPU correctness path. A mixed-height area's boundary switches independently
  to a registered four-component world-distance line type, an independent
  linear color, a seven-physical-pixel width and live cap/join policy; `stroke:
none` hides only the boundary while the hatch fill remains. A missing resource
  is rejected atomically, proxy/batch identities and provider decode counters
  remain unchanged, and the final rendered frame contains the live dashed
  boundary. A native real-device readback independently samples drawn and gap
  locations and requires identical discard decisions from color and ID-pick
  targets. Long-path phase uses explicit subpaths plus integer 4,096-unit chunks
  rather than one cumulative `f32` chainage;
- prepared authoritative topology is now wired into the production viewer
  lifecycle rather than returned as an unowned admission side value. Host tests
  require the exact kernel-returned binding to follow the final composition of
  base and scoped clips, preserve the committed geometry product across live
  style changes without another topology evaluation, and remove its stable cap
  only after successful canonical retirement. The browser gate no longer
  fabricates and directly upserts its clip-cap product: it loads immutable f64
  positions, u32 indices and material slots through `KernelClipCapCoordinator`,
  executes the real WASM authoritative section evaluator for a closed mesh and
  confirms the stable cap section on forced WebGL2 and explicit WebGPU. The
  physical WebGL2 run used the Intel HD Graphics 630; this host's WebGPU path
  remains a CPU-adapter correctness result. Open Civil TINs continue to emit
  exact traces but never invented solid caps;
- line, polyline, circle, arc, ellipse, clothoid, NURBS and composite authored
  curves receive stable analytic-subprimitive pick IDs; unresolved Z requires an
  explicit display resolver and never becomes zero. Authored/evaluated point,
  vertex and midpoint snaps occupy a semantic ID range above the 32-bit render
  segment range and remain identical when chord tolerance changes. Circle,
  clothoid and spline tessellation vertices can therefore never leak into the
  Tab stack as authored vertices or midpoints. Area-boundary semantic snaps
  survive associative resolution, named interpolation and TIN draping; surveyed
  XYZ remains exact while unresolved cadastral XY is projected by the declared
  resolver. Standalone point proxies replace GPU-depth reconstruction with the
  canonical f64 position after entity placement, inverse presentation and
  screen ranking. The browser gate verifies this under 4x exaggeration on both
  backends;
- a compiled authored CAD curve, compact point tile and indexed textured mesh
  execute together on a real `wgpu` adapter;
- canonical streamed placement is provider-neutral and follows one tested chain:
  provider source -> f64 entity placement -> project world -> view presentation.
  Rust gates place hierarchy bounds before frustum, SSE and project clipping,
  conservatively scale geometric error, and verify affine position plus
  inverse-transpose normal rows. The browser Potree fixture is deliberately
  translated away from its provider coordinates; physical Intel WebGL2 and
  explicit WebGPU must render and exactly pick the translated project point
  while provider metadata retains the original quantized source coordinate.
  The transform is a batch uniform, so the gate performs no vertex-buffer
  rewrite or provider re-decode;
- a world-space clip plane suppresses color/ID writes on the clipped side;
- vertical exaggeration is an invertible presentation transform with a finite,
  strictly positive factor and explicit f64 datum. CAD curves, Potree points,
  topology-aware rasters, Gaussian splats and triangle/instanced-mesh BVHs
  inverse-transform the cursor ray, rank forward-transformed candidates on
  screen and always return authoritative project-world coordinates. Height
  ramps, hatch coordinates and clip half-spaces remain pre-presentation project
  semantics;
  splat means and covariance axes use the same presentation transform. A
  factor-zero flattening is rejected because it cannot recover one exact
  source Z. The real browser gate displays one open Civil TIN at factor 4,
  requires the screen-center hit to remain `Z = datum + 3` while rendered at
  `datum + 12`, then applies a source `Z <= datum + 3.5` clip and proves that
  hit remains visible. Forced WebGL2 and explicit WebGPU both record the full
  and source-clipped exaggerated frames. Streamed Potree, raster, Gaussian and
  3D-Tiles/prepared-mesh hierarchies use conservative presented bounds and
  presentation-scaled geometric error for frustum/SSE selection while retaining
  placed project bounds for clips. The browser gate aims a camera exclusively at an
  exaggerated Potree point, proves that identity presentation culls it, advances
  the exaggerated tile through fetch/decode/upload residency, renders it and
  returns its exact unexaggerated source coordinate on both backends. A flat
  `1000 x 1000 x 2` Civil tile at 10x exaggeration also has a unit gate against
  the pathological radius blow-up caused by isotropically scaling its horizontal
  extent;
- the two `RGBA8Uint` pick attachments round-trip a 32-bit proxy ID and 32-bit
  primitive ID through asynchronous GPU readback;
- the same Playwright entity zoo runs through explicitly selected WebGPU and
  WebGL2 kernels, including adapter calibration, 30 presented frames, clip
  volumes, ID/depth readback and backend-specific screenshots;
- a large f64 floating-origin change preserves the exact center pick and does
  not change the render-world generation or rebuild resident batches;
- locked top-down entry matches the perspective target-plane span, and a zoom
  performed in orthographic mode derives the returning perspective distance
  from that new span so the 2D→3D endpoint cannot jump back to a stale scale;
- arbitrary local orthographic view frames require finite orthonormal
  normal/up axes and a bounded positive span. Pan, zoom and cursor fallback use
  the authored plane basis, orbit is disabled, repeated local-frame changes
  retain the first complete 3D snapshot and exit restores that camera exactly.
  The Playwright zoo renders a vertical frame rotated 45 degrees from the world
  axes through the real Rust camera-transition path on forced WebGL2 and
  explicit WebGPU, checks that off-centre cursor coordinates remain in the
  authored plane and records profile/return screenshots. This is view state;
  the gate creates no profile or cross-section entity;
- an optional local profile depth is converted to one asymmetric two-plane
  `keepInside` slab using the exact f64 frame origin/normal. Its scoped clip is
  atomically composed with, and removed independently from, user clip boxes;
  duplicate identities and the portable four-volume/24-plane ceiling fail
  before publication. Pure depth clipping disables `previewCap`, because a
  two-plane volume would otherwise cap both the camera-side and rear boundary;
  the exact single plane and its hatch stay in the section-product path. The
  browser gate visibly crops the 45-degree profile frame with 2 m toward-camera
  and 8 m away-from-camera depth on forced WebGL2 and explicit WebGPU;
- a user-authored Z-up perspective viewpoint validates finite distinct
  world-space eye/target coordinates, a non-singular pitch and bounded vertical
  FOV before mutating camera or scoped clip state. Navigation removes an active
  local-depth slab, morphs through the common Rust camera path and preserves the
  authored ECEF-scale target plus eye to sub-nanometre reconstruction error.
  Forced WebGL2 and explicit WebGPU both record the resulting perspective view;
- exact open-TIN section traces, evaluated material-slot section regions and
  hatch resources render together without inventing a cap for an open surface;
- streamed closed-mesh clip caps are coordinated independently of render-tile
  residency. Unit gates delay a topology partition, replace the entity revision
  while it is in flight, require the old job to abort and prove that only the
  newest product can replace the stable section identity. Disabled volumes and
  open Civil TINs schedule no cap work. Both browser backends compile an
  authoritative product in `clipCap` mode, crop it against the remaining
  volume planes and accept the current volume/plane binding;
- an authoritative two-part topology snapshot produces one exact section
  region spanning the tile seam; registration binds it to the canonical entity
  and dataset revision, exact plane/tolerance and a stable material key without
  requiring either source tile to be renderer-resident;
- the provider-side evaluator intersects partitioned closed topology in f64 and
  constructs contours only after combining all partition segments; reversing
  the source-part order produces the identical envelope and deterministic
  region identity, while an open two-part DGM emits an exact cross-seam trace
  with no invented region and missing canonical cap material keys are rejected;
- the authoritative topology registry sorts and atomically publishes one exact
  entity/dataset revision, resolves content-addressed source partitions one at
  a time independently of render residency, rejects a loaded hash mismatch and
  still produces one material-bound cap across the partition seam. Canonical
  finite ordered source-frame AABBs are transformed through entity placement
  before the kernel skips project-plane-disjoint partitions; a three-part test
  loads only the intersecting partition. Translation, rotation and non-uniform
  scale gates require exact project-space endpoints while source topology hashes
  and bytes remain unchanged;
- closed-section contour assembly uses a tolerance-cell endpoint index instead
  of scanning every remaining segment. A deterministic 20,000-segment
  scrambled contour gate completes as one closed contour, avoiding the former
  quadratic Civil-section bottleneck;
- the browser host fetches open-DGM topology manifests through the same bounded
  request semaphore as render streaming, verifies manifest/resource hashes,
  pushes partitions in canonical order and cancels before fetching triangle
  buffers when a manifest is tampered. A host test proves a kernel-disjoint
  partition causes zero immutable-resource requests. The real WebGL2/WASM zoo additionally
  evaluates two independently transferred one-triangle TIN partitions in local
  coordinates across their seam, applies the open-surface entity placement and
  requires two exact project-space trace segments with zero cap regions. The
  host obtains partition-manifest content IDs from the canonical Rust serializer,
  so `0` versus `0.0` JSON spelling cannot split immutable identity;
- the production DGM tiler emits a provider-neutral kernel hierarchy with valid
  external-buffer glTF, plus a separately hashed version-2 finest-LOD section
  topology with conservative bounds derived from its decoded f32 vertices;
  a deliberately two-triangle render LOD from one 512x512 source tile retains
  all 262,144 source samples and 522,242 authoritative section triangles, so
  adaptive display quality cannot reduce exact profile/cut geometry;
  adjacent authoritative grid partitions own deterministic east/south halo
  cells. A real two-tile artifact gate intersects both full-resolution parts
  and measures the complete 1,023-unit trace, proving that no one-pixel seam
  gap or duplicate boundary strip survives partitioning;
  the explicit `pnpm viewer:test:real-dgm-section` corpus gate repeats this on
  two checksum-pinned 2026 Brandenburg DGM1 GeoTIFFs (GeoBasis-DE/LGB,
  `DL-DE-BY-2.0`). It derives two adjacent 512x512 windows, runs the production
  tiler over 1,045,506 authoritative triangles and proves 2,046 raw intersection
  segments form exactly 1,023 metres of gap-free, non-overlapping projected
  trace with the expected 33.0-metre seam height. The normal browser gate skips
  these explicitly scheduled downloads;
  every render tile binds its glTF, position, index, UV and orthophoto bytes by
  canonical SHA-256 and exact byte length before residency. Its compatibility
  gate also proves that older mesh records without these new optional artifacts
  remain readable, and a multi-tile fixture keeps the coarse overview texture
  separate from detailed leaf textures;
- the provider-neutral triangle-mesh preprocessor consumes a fallible stream
  into a fixed-width disk spool, recursively partitions it without retaining
  the source mesh in memory, writes bounded f32 render nodes and keeps every
  source triangle exactly once in separate f64 authoritative topology. Its
  internal render LODs retain every unique vertex-cluster triangle at the
  selected resolution and rescan the disk spool at a coarser resolution when
  the proxy budget would be exceeded; collapsed, spatially isolated details
  retain one real representative per occupied cell. Hierarchy bounds always
  include both the complete source bounds and the actually decoded f32 proxy.
  A 216-region test forces adaptive reduction to exactly 64 occupied regions.
  Hierarchies above 512 tiles publish only the root inline and split descendants
  into independently hash/length-bound pages of at most 510 descriptors. A
  599-tile producer/provider round trip lazily applies every page and accounts
  for every descriptor exactly once. Render tiles group one shared vertex/index
  payload into deterministic glTF primitives per source material slot; a
  reversed `[7,3]` source proves that render primitives and authoritative
  section material keys both retain canonical slots `3` and `7`. Its global
  external edge-sort rejects boundary, non-manifold or equally oriented
  edges before `closedManifold` can be published. ASCII and binary-little-endian
  PLY adapters reject non-triangles and out-of-range indices. COLMAP's
  untextured PLY and official `mesh.ply`/`texture.png` output both use this
  producer; ASCII and default-binary textured fixtures prove exact face-corner
  UV order, valid generated glTF, texture binding and immutable UV/PNG hashes.
  The generated glTF node carries the inverse CAD-Z-up/glTF-Y-up basis, so the
  common decoder's standards conversion leaves the Civil mesh in its original
  project orientation. A real forced-WebGL2 producer-to-browser gate creates a
  georeferenced two-material textured mesh through the Rust sidecar, registers
  its prepared hierarchy, verifies the glTF and all four immutable asset hashes
  and byte lengths, renders both atlas colors, and returns the exact off-diagonal
  source-face pick at `(6378084.625, 5400038.25, 520.75)`.
  Its project listing also supplies a validated canonical spatial-surface
  admission, content-addressed
  dataset/provider identity and hash-checked component/attribute/relation
  objects for both mesh variants instead of requiring a UI-owned legacy-entity
  conversion. Render
  hierarchy, preparation recipe and section topology are independently
  hash-bound;
- prepared-mesh dataset registration and canonical representation publication
  are one WASM transaction. Stale-generation failure rolls back the dataset
  contract, closed meshes without material identity fail before mutation and
  preparation-recipe tampering fails hash/length verification. The recipe hash
  is the evaluated mesh `parametersRef`;
- `pnpm viewer:test:large-prepared-mesh` is a deliberately unscheduled local/CI
  gate (two million streamed triangles by default, configurable with
  `--triangles=`). It verifies fixed-size partitions, complete authoritative
  triangle accounting and cleanup of the disk-backed partition workspace. It
  is kept out of ordinary edit/test loops just like the downloaded DGM gate.
  After adding optional UV records and adaptive LOD, the 2026-07-17 Linux
  baseline completed 2,000,000 untextured triangles in 10.10 seconds wall time
  with 107,120 KiB maximum resident memory. Absent UV payloads consume no six-
  float record body, keeping the result within 3% of the prior 9.84-second
  baseline instead of charging untextured Civil meshes for texture data;
- external glTF dependencies are fetched as parallel document waves under the
  live kernel request semaphore. A four-resource DGM wave reaches a configured
  concurrency of three but never exceeds it; dependency-count and aggregate
  byte ceilings reject and cancel the complete graph before publication;
- associative area boundaries resolve a versioned resident curve in the same
  local placement frame; source edits invalidate dependants transitively and
  incompatible placements are rejected rather than silently misregistered;
- an alignment containing slope rules fails compilation unless every rule has
  one f64 inline mesh bound to its source band, target surface/version and
  verified content hash; valid slopes compile as separate triangle/pick
  proxies, while stale hashes, duplicate rules and mismatched targets fail;
- the pure-Rust civil preview evaluator deterministically partitions the
  horizontal alignment station domain and generates width/gradient road strips
  shaped by crossfall/ramp bands plus one existing
  `ResolvedAlignmentSlopeGeometry` per rule from provider-resolved, partitioned
  daylight profiles; focused tests prove identical input identity,
  target-version stale rejection and valid inline slope hashes without a second
  coincident crossfall surface;
- an incremental alignment preview commit uses an expected generation and an
  explicit affected station interval, requires exactly its prepared road and
  daylight partition overlays, preserves the previous immutable revision on
  every failed update and replaces only bounded station partitions; no full
  alignment clone, vertical-segment scan, band diff or global target-profile
  scan occurs in this commit path;
- a persistent path-copy partition tree survives 10,000 sequential preview
  commits over 1,000 partitions with fixed lookup depth (at most 11 tree nodes),
  one retained current root and one regenerated partition per commit; provider
  input on that path is also an affected-partition overlay, not a global
  daylight-profile re-evaluation;
- the WASM viewer owns matching `build/update/remove` preview sessions. It
  compiles every candidate partition and exact mesh-pick index against a
  prepared `RenderWorld` overlay, commits GPU visibility atomically, and only
  then advances the cloned evaluator session. A live browser gate builds three
  ten-metre road partitions, widens only the middle partition from five to
  seven metres, proves one changed partition and a visibly localized update,
  rejects a repeated stale generation without changing the world, and removes
  every transient batch. The same screenshot/state assertions pass on forced
  WebGL2 and explicit WebGPU; the WebGL2 run uses the physical Intel adapter,
  while this host's explicit WebGPU adapter reports a CPU fallback;
- provider-local Potree refinement reconstructs the original quantized f64
  coordinate by point index, while continuous and pixel-step raster refinement
  retain distinct surface/sample semantics across NoData gaps. Separate raster
  elevation, validity and two-bits-per-cell connectivity bands carry their own
  exact SHA-256 and are rejected before fetched residency when their bytes
  differ from the declared immutable resource. Their exact byte boundaries and
  zero padding are validated in the native decoder, WASM facade and browser
  streaming driver; rendering, exact picking and area draping consume the same
  connectivity mask, so none of those paths can recreate a masked triangle;
- reusable blocks now cross the package/WASM boundary as the canonical
  `hcad.resource.block-definition@1` contract rather than a viewer-private
  duplicate. Inline members resolve exact immutable style resources; entity
  members capture the referenced entity revision at definition registration.
  The browser gate publishes both forms, then advances the live source entity
  and requires the existing block to remain renderable from its captured old
  revision. Core validation also admits two block definitions that intentionally
  capture two different immutable revisions of the same stable entity ID;
- lazy prepared-hierarchy pages optionally carry the SHA-256 of their exact
  whole object or byte range; a modified page is rejected before it can mutate
  the resident hierarchy, and the owner remains retryable;
- PotreeConverter 2 `BROTLI` nodes are bounded and decoded in the CPU-only
  native/WASM worker from attribute-major Morton streams into the same point
  contract as `DEFAULT`/`UNCOMPRESSED`. A real converter-produced compressed
  root was compared against its uncompressed counterpart, and the browser zoo
  requires a compressed worker node to retain exact intensity, classification,
  return-number, number-of-returns, point-source-id, source color and point
  picking. The 36-byte GPU point stride is the single source for hardware and
  residency budgets;
- owned mesh BVHs refine inline, registered, generated-solid and 3D Tiles leaf
  hits to authoritative f64 source faces/edges/vertices; Gaussian refinement
  independently verifies the exact mean and projected covariance coverage;
- instanced meshes retain one shared model geometry/BVH and a compact top-level
  instance-AABB BVH per spatial chunk instead of expanding model triangles per
  instance; exact face/edge/vertex addresses survive non-uniform transforms,
  and a 128-instance by 64-triangle regression requires less than one quarter
  of the expanded pick-index memory;
- a live mixed XYZ/XY parcel keeps its tachymetrically surveyed road-edge Z
  while draping only missing cadastral heights against a versioned TIN; the
  same result and exact vertex picks are required from WebGPU and WebGL2;
- a content-addressed named/versioned interpolation materializes associative
  and inline area loops without changing XY, topology or known survey Z; both
  browser backends must return its interpolated vertex through exact picking;
- a preserved namespaced extension renders through a separately evaluated
  immutable mesh and returns an exact source-triangle BVH hit without requiring
  the renderer to interpret its payload;
- explicit 3D Tiles schema URIs resolve against the source tileset, while
  tileset/tile/content/group metadata survives planning, is queryable for a
  resident proxy and is removed with that proxy on eviction;
- sparse implicit-subtree tile metadata decodes from an eight-byte-aligned
  binary property table and maps Morton availability index 3 to packed metadata
  row 1 by popcount rank; subtree JSON metadata appears only on its subtree
  root;
- a real GLB resolves both attribute- and texture-backed `EXT_mesh_features`
  IDs by exact source-triangle barycentrics to their linked binary
  `EXT_structural_metadata` property row on WebGPU and WebGL2; the same hit
  returns source-vertex property attributes with explicit nearest provenance
  and nearest-sampled numeric/bit-packed property textures; referenced JSON,
  buffer views, UV mappings and image texels are residency-accounted and the
  query disappears atomically with proxy eviction;
- reverse-Z weighted OIT is invariant under reversed draw submission while
  weighting a nearer color above a farther color and bounding half-float
  accumulation; forced WebGL2 rotates three overlapping splats through opposite
  view axes and verifies deterministic `[0,1,2]`/`[2,1,0]` primitive order,
  unchanged exact pick IDs and residency-accounted sorting state;
- forced WebGL2 also sorts transparent mesh instances stably back-to-front from
  fully transformed primitive centers, including interaction translation,
  vertical exaggeration and floating origin; `primitiveOffset` breaks depth
  ties, 4-MiB blocks prevent oversized-upload starvation, and weighted OIT
  retains neither the CPU sort copy nor a mutable instance buffer;
- a six-plane convex clip box cuts a generated solid and a two-shell inline
  solid whose exact per-triangle material slots are `3` and `7`; both browser
  backends must preserve the resulting `[0,3,7]` cap regions, use distinct
  registered vector hatches for the material shells, clip every cap to the
  remaining box planes and keep all cap batches non-pickable; open TINs, points
  and splats create none; the same gate repeats the operation as `removeInside`
  and requires a visible opening, exact material-region caps and an image that
  differs from both the unclipped and `keepInside` frames;
- `submit_frame` contains no section evaluator, immutable-resource fetch or cap
  builder. Small inline caps rebuild at clip/entity/style mutation boundaries;
  ordinary streamed tile publication and eviction do not mark them dirty.
  Resource-backed caps arrive only through completed authoritative products;
- the optional real-data gate fetches Khronos `TextureCoordinateTest.glb` from
  repository revision `2bac6f8c57bf471df0d2a1e8a8ec023c7801dddf`, rejects
  any byte length or SHA-256 mismatch, uploads its five source materials and
  embedded texture through ordinary 3D-Tiles/glTF residency, requires an exact
  source-face pick on WebGPU and forced WebGL2, and records a focused screenshot;
- that real-data gate also fetches CesiumJS `TilesetWithTransforms` from pinned
  revision `0d0c35fad1cc05ed0560f0d1ec6a9197baaef84e`, keeps the official root
  and child ECEF transforms, and jointly publishes its 120-triangle `b3dm` plus
  25-instance embedded-glTF-1 `i3dm`; spatially separated exact source-face
  picks must resolve both transformed buildings and an individual instance on
  WebGPU and forced WebGL2 without relocating either dataset to a local origin;
  the `i3dm` gate additionally requires one shared model upload, one draw call,
  fewer than 10 KiB of GPU buffers, 300 logical triangles, one chunk proxy and
  exact resolution of source instance/feature ID `12` from its picked face;
- an additional pinned Cesium external-i3dm fixture resolves the format-0 model
  URI through an exact owner/source asset graph, packs the external GLB once,
  publishes 25 instances through one shared draw and verifies the same exact
  surface pick on WebGPU and forced WebGL2; external JSON glTF buffers, images,
  data URIs and structural-metadata schemas pass the same materialization path;
  the browser gate separately fetches `.gltf`, `.bin`, `.png` and schema,
  verifies all exact owner/source edges, then requires yellow and blue texture
  pixels plus an exact source-face pick on both backends;
- surface lifecycle covers resize/suspend, occlusion, timeout, outdated,
  suboptimal and lost states without a window-framework dependency;
- adapter diagnostics and device creation agree on BC, ETC2, ASTC LDR and ASTC
  HDR texture-compression availability; both browser backends exercise the
  initialized embedded BasisU transcoder;
- native Clippy and WASM WebGPU/WebGL2 compilation are required to pass.

These gates establish the synthetic mixed-scene baseline. The larger clip,
precision, streaming-stress and checksum-pinned real-data benchmarks described
above remain separate acceptance gates.

## Post-A consolidation checkpoint — 2026-07-18

The first post-A checkpoint re-ran the foundation floor after canonical
line-type, presentation-resource catalog, Gaussian-splat and IFC provider work.
The checked source state passed:

- all 313 native render-core tests, including real-device line-type color/pick
  gap parity and weighted OIT;
- all 70 viewer package tests and the generated Rust-to-TypeScript binding
  check;
- 60 ordinary IO/provider tests with zero failures. The one ignored test is the
  deliberately rare 16,385-splat bounded-preparation scale gate, which passed
  when invoked explicitly;
- 14 focused canonical presentation-resource tests, including atomic rollback,
  multiple exact revisions and typed ordered material tables;
- the explicit WebGPU browser gate and forced WebGL2 gate. WebGL2 used the
  physical Intel HD Graphics 630 and calibrated independently to 16.7 ms; this
  host's WebGPU adapter identified as CPU and remains a correctness result, not
  a hardware-performance claim.

The IFC subset compiles and passes seven focused tests plus the full IO suite.
It includes the checksum-pinned official buildingSMART tessellation fixture,
strict f64-safe numeric admission and a representation-map test proving that
mapping-origin inversion and target placement are composed exactly once.

The complete core suite reports 142 passes and two failures confined to the
parallel PhotoLab matching policy (`backend_plan_respects_profile_scopes` and
`rescue_uses_remaining_backends_and_expands_bridge`). Those tests neither
exercise nor block the canonical entity, provider, render, WASM or viewer
checkpoint and were not changed from the kernel lane. Workspace-wide Clippy is
likewise presently blocked by findings in the parallel transform and PhotoLab
sources; the checkpoint introduced no Clippy finding in the exact-revision
resource catalog after its validation path was split into bounded dependency
graphs.

### Exact hatch and mesh-presentation checkpoint

The following post-checkpoint slice removes the former mutable hatch-ID and
opaque mesh-material JSON boundaries:

- hatch fills now retain an exact canonical resource revision plus an explicit
  view-local orthonormal pattern frame, authored line width and linear color;
- one immutable `Rgba32Float` lookup allocation represents all canonical hatch
  line families, offsets and signed dash/gap/dot sequences. Entity restyling,
  section fills and material-specific clip caps only rebind that allocation and
  rewrite presentation uniforms; geometry buffers remain unchanged;
- WebGPU and forced WebGL2 both passed the 26-entity/34-proxy browser gate with
  a two-family dashed/dotted cross hatch, ordinary area fill, streamed exact
  section and material-specific clip-cap use;
- all 315 render-core tests pass, including the new multi-family and f64-to-f32
  fail-closed hatch compilation tests. All 70 viewer tests and 60 ordinary IO
  tests pass; the same two unrelated PhotoLab matching-policy tests remain the
  only failures in the complete core suite;
- `TriangleMeshGeometry.materials` is an exact typed material-table reference.
  Import packages publish checksum-verified texture revisions first; materials
  and ordered material tables are then published atomically only after every
  referenced texture is GPU-resident. Referenced pixel/font bytes remain
  checksum-addressed binary artifacts.

The subsequent runtime gate resolves those tables instead of merely validating
their envelopes. Inline meshes are compacted by canonical material slot into
multiple draw batches under one render proxy; each pick vertex retains the
original source-triangle ID even when the material partition changes draw
order. Source color, alpha mode and decoded base-color texture remain separate
from live view styling, so a temporary presentation texture can be removed
without rebuilding geometry or losing the authored texture revision.

Both explicit browser backends passed the stricter material fixture. It
requires slots `3` and `7`, two exact material revisions, separate linear base
colors, authored UVs and one checksum-addressed 2x2 source texture. The source
texture uses mirrored-repeat/clamp addressing, nearest/linear filtering and an
affine scale/rotation/offset UV transform; one material is single-sided and the
other double-sided. These states are resolved in shared WebGPU/WebGL2 material
and pipeline contracts without rebuilding mesh buffers, and pick rendering
uses the same culling decision as color rendering. The forced WebGL2 run used
the physical Intel HD Graphics 630 and reported 3.0 ms maximum CPU submit; the
WebGPU CPU adapter is again a correctness-only result and reported 3.2 ms.

The next material checkpoint resolves every channel in the current canonical
PBR contract: base color/opacity, tangent-space normal,
roughness-green/metallic-blue, emissive and red-channel occlusion. Every
channel retains its own immutable texture/sampler revision and affine UV
transform. Tangent frames are reconstructed from position/UV derivatives, so
normal maps do not require a tangent-buffer rewrite; vertical exaggeration
changes only the presentation normal. Source mode uses camera-direction-aware
GGX direct lighting, while explicit color and height overrides remain
presentation states rather than mutating the source material. Missing channels
bind semantic 1x1 defaults, and view texture overrides still replace only the
active base-color binding.

The five-channel fixture passed the complete 315-test render suite and both
explicit browser backends with all 26 entities and 34 proxies. Forced WebGL2 on
the physical Intel HD Graphics 630 reported 3.5 ms maximum CPU submit; the
WebGPU CPU adapter correctness run reported 1.3 ms. Both gates retained exact
material slots, all per-channel UV rows, all four auxiliary texture-presence
flags, mixed-scene picking and source-texture restoration. Additional authored
UV sets remain outside this checkpoint because canonical inline meshes expose
only their first UV set today.

Canonical material textures now enter the same kernel-wide immutable GPU
texture cache as streamed provider textures. Registration derives identity
from exact decoded bytes, upload format, color space and sampler, resolves an
existing allocation before invoking the upload factory, commits one stable
document-resource owner and immediately republishes the shared GPU-texture cost
to the streaming coordinator. Consequently pinned document materials reduce
the remaining stream budget instead of occupying unreported GPU memory, while
tile-local costs still exclude globally shared allocations. The browser gate
requires the five distinct 2x2 material textures to produce exactly five
committed owners, five allocations, 80 resident bytes, five factory calls and
zero staged owners. Forced WebGL2 reported 3.7 ms maximum CPU submit and the
WebGPU correctness adapter reported 2.2 ms with that accounting active.

## Candidate external data

- USGS 3DEP public-domain EPT for billion-point streaming.
- Métropole Européenne de Lille 2016 3D Tiles under Licence Ouverte 2.0.
- CesiumJS 3D Tiles specification fixtures under Apache-2.0.
- Geobasis NRW DOP plus DOM from the same bounding box under DL-DE-Zero 2.0.
- explicitly licensed NVIDIA Gaussian datasets plus deterministic generated
  1M/10M/100M splat stress fixtures.
- buildingSMART sample IFC files under CC BY 4.0.
- MIT-licensed ezdxf fixtures plus a deterministic HimmelCAD CAD zoo.

External data is downloaded only through a checksum-pinned manifest. Large
assets live outside the source repository and are mirrored only after license
and attribution review.
