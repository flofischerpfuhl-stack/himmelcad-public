# Viewer verification snapshot

Status: archived evidence from July 2026. Counts and results are not current
unless reproduced on the present revision. Current verification policy lives in
`docs/TEST-TIERS.md`.

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
  curves receive stable analytic-subprimitive pick IDs; unresolved Z never
  becomes zero. Authored/evaluated point,
  vertex and midpoint snaps occupy a semantic ID range above the 32-bit render
  segment range and remain identical when chord tolerance changes. Circle,
  clothoid and spline tessellation vertices can therefore never leak into the
  Tab stack as authored vertices or midpoints. Area-boundary semantic snaps
  survive exact associative resolution. Mixed-Z source revisions remain locked-
  plan geometry; only a later fully materialized XYZ revision enters spatial
  display and exact spatial picking. Standalone point proxies replace GPU-depth reconstruction with the
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
  streaming driver; raster rendering and exact picking consume the same
  connectivity mask, so neither path can recreate a masked triangle;
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
- a live mixed XYZ/XY parcel is accepted only with the explicitly locked plan
  presentation plane and is rejected from ordinary 3D compilation as one whole
  entity; the browser gate then replaces the same stable slot with a new canonical
  revision containing actual XYZ positions and requires exact vertex picks from
  WebGPU and WebGL2. The source Mixed-Z revision remains unchanged;
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

Panorama station authority is now singular. The serialized panorama contains
only its camera-mapped raster; the rigid camera-to-entity-local pose supplies
both orientation and scan-station position, while depth remains attached only
to that raster. Canonical validation rejects non-rigid or reflected poses,
optical-axis depth on an equirectangular image, legacy duplicate depth and a
second serialized `station`. The E57 provider preserves its exact imported
pose and station-cloud association without copying the translation. The
focused Core, canonical-provider and E57 tests, generated-binding drift gate,
WASM check, all 70 viewer tests and the 26-entity/34-proxy browser scene passed.
Forced WebGL2 on the physical Intel HD Graphics 630 reported 3.5 ms maximum
CPU submit; the WebGPU CPU correctness adapter reported 1.3 ms.

Prepared elevation raster decoding now receives one versioned semantic
contract instead of independent worker and host copies of width, mapping,
topology and encodings. The contract embeds the canonical raster authority;
both bounded decode worker and render host validate it, derive the current
orthographic elevation-grid decoder input from it, and verify exact color,
depth, validity and connectivity payload hashes before publication. Contract
schema drift, a non-canonical raster, mismatched bytes and a mapping/depth
combination outside the selected evaluator fail before residency. The complete
316-test render suite, both WASM target checks and all 70 viewer tests passed.
The 26-entity/34-proxy browser scene passed on both backends; forced WebGL2 on
the physical Intel HD Graphics 630 reported 2.9 ms maximum CPU submit and the
WebGPU CPU correctness adapter reported 1.5 ms.

Prepared raster confidence now crosses the same hash-bound worker transfer as
color, depth, validity and connectivity. `unorm8` and little-endian f32
confidence are length- and content-verified; f32 values outside `[0,1]` fail
before decode residency, and confidence never changes validity or triangle
admission. The four side bands have explicit non-overlapping transfer lengths
in both decode WASM and render-host WASM. The focused contract tests, complete
317-test render suite, both WASM band-boundary tests and all 70 viewer tests
passed. Both explicit browser backends retained the 26-entity/34-proxy mixed
scene and exact provider picks.

The main-view panorama presentation no longer builds an implicit textured
depth sphere. It compiles one exact pickable marker at the camera pose; browser
gates reject any panorama main-view candidate reported as a surface. The shared
kernel now also measures an exact integer depth pixel independently of the GPU
depth buffer and presentation exaggeration. A provider-neutral projector maps
OrthoGrid, Planar homography, undistorted Pinhole and Equirectangular pixels to
entity-local f64 source coordinates, then applies the canonical entity
placement. It distinguishes `ElevationZ`, `OpticalAxisDepth` and `RayDistance`
and rejects missing depth, behind-camera values, equirectangular optical depth,
unknown distortion evaluators and namespaced camera models without a resolver.
The browser fixture measures panorama pixel `(3,1)` with ray distance `3`,
checks confidence `26/255` and matches the analytical posed spherical ray to
`1e-7` on WebGL2 and WebGPU. The complete render suite reached 322/322 and all
70 viewer tests remained green; the latest forced WebGL2 run on the physical
Intel HD Graphics 630 reported 3.4 ms maximum CPU submit and the WebGPU CPU
correctness run reported 2.0 ms.

Inline RGBA, f32 depth and binary raster side bands are now accepted only when
their actual bytes match the declared canonical SHA-256. The browser gate first
submits one tampered payload of each class and requires all three to fail, then
loads the checksum-pinned panorama/orthoraster fixtures and repeats the source
measurement. Canonical validation also rejects depth/mapping combinations that
have no geometric meaning before a renderer or measurement path can see them.

Inline oriented images no longer stop at canonical validation. A Planar raster
is tessellated over its complete pixel footprint, evaluates the authored
column-major homography at every cell boundary and embeds the result in the
exact local plane frame. An undistorted Pinhole raster produces a textured
presentation plane from the canonical intrinsics and rigid camera pose; its
configured plane distance is presentation-only. Attached camera depth is not
used to deform that main-view plane and remains the separate source
measurement authority. Distorted, equirectangular and namespaced camera models
still fail closed unless their proper station/evaluator path is selected. The
browser scene now contains 29 entities and 37 proxies and checks a Pinhole
`OpticalAxisDepth` sample analytically to `1e-7` after pose application. Both
explicit backends passed; the final forced WebGL2 run on the physical Intel HD
Graphics 630 reported 4.6 ms maximum CPU submit, and the WebGPU correctness run
reported 2.0 ms. This closes inline Planar/Pinhole presentation, not the still
open provider-prepared Planar/Camera streaming path.

The real provider boundary is separately verified: 9 focused E57 tests pass
posed f64 point transcoding, immutable embedded images, exact camera semantics,
scan association, cancellation and tamper/invalid-intrinsic failures; 5 focused
GeoTIFF tests pass georeferenced DGM NoData/mapping, range-readable COG import,
exact roundtrip, cancellation and immutable-resource tamper rejection.

The native elevation-raster pipelines now publish `viewer/manifest.json` before
their product-directory rename. Sidecar preparation hashes every existing
512x512 preview PNG and exact Float32 height tile without decoding the complete
raster. Canonical elevation GeoTIFF import independently reads bounded source
windows and creates exact little-endian Float64 height tiles, dyadic parent
levels and grayscale previews. Both paths retain NoData, pixel-centre mapping,
GSD and topology and emit a coarse-to-fine REPLACE hierarchy accepted by the
render core's real `PreparedHierarchySource`. Producers serialize through the
same public `PreparedHierarchyManifest` type and consumer validation used by
the render core; importer and sidecar writers therefore cannot maintain a
parallel manifest schema. A prepared directory becomes visible only after all
hash-bound references and its manifest are complete. Focused tests cover
render-core parsing, exact mapping, band references, cancellation, invalid
band length, atomic publication, deterministic immutable reuse and the fake
offline GDAL pipeline.

The schema-v2 prepared raster-surface contract closes the remaining paired
orthomosaic/elevation gap without coupling their resolutions. Colour pages stay
at 512x512 pixels while each independently derived DEM support grid is bounded
to 513x513 vertices. The deterministic 2 cm colour / 10 cm DEM fixture therefore
publishes a 103x103 support grid. Every product pins the exact source-surface
revision and content-addressed drape derivation; adjacent tile edges evaluate
the same world coordinates and are byte-identical. Alpha affects colour
presentation only and never elevation validity. Cancellation leaves no visible
manifest.

The browser gate stages a 4x4 colour tile over an independent 3x3 elevation
grid, analytically verifies the source-coordinate pick, accounts 64 GPU texture
bytes and eight triangles, and proves atomic colour/support unload. Both
explicit backends pass the 29-entity/37-proxy fixture (38 entities with the real
data extension), with ten worker ingests, zero main-thread provider decodes and
no decode rebuild. The focused regression evidence is 324 render-core, 7 wasm,
4 decode-wasm, 71 viewer-package, 9 E57 and 5 GeoTIFF tests. V1 closed on
2026-07-18 at 11:33 CEST after 4 h 12 min elapsed work.

## V2 plan-only height checkpoint

The canonical and viewer contracts no longer contain `HeightResolution`,
`MissingHeightPolicy`, `DrapeMissing`, `InterpolateMissing` or their former
area-interpolation registries. An area with any missing source Z remains valid
canonical CAD geometry, but compilation without an explicitly locked plan
plane rejects the complete representation atomically. The locked-plan fixture
publishes boundary and fill without changing the canonical source revision;
the browser then publishes a separate, fully authored XYZ revision into the
same stable entity slot and verifies its exact source vertices in 3D. The
original Mixed-Z admission still serializes its absent Z values.

The focused Core validation and render tests pass, generated TypeScript
bindings are current, and the complete render suite is 315/315 after removal
of the obsolete resolver-only tests. The native provider/WASM regression is
61 IO tests plus 7 viewer-WASM and 4 decode-WASM tests; all 71 viewer-package
tests pass. Both explicit browser backends pass the 29-entity/37-proxy scene
with ten worker ingests and zero main-thread provider decodes. Forced WebGL2 on
the physical Intel HD Graphics 630 reports 3.9 ms maximum CPU submit; the
WebGPU CPU adapter correctness run reports 1.8 ms. The full Core run reaches
144 passing viewer/shared tests but is not recorded as a green gate because
two concurrently modified PhotoLab matching tests fail outside this lane.

### V2 canonical conic checkpoint

`CurveGeometry::ConicArc` is one exact rational quadratic with unit endpoint
weights and a positive authored middle-control weight. It therefore retains
elliptic, parabolic and hyperbolic arc identity without converting the source
to an app-owned polyline or approximate spline. Canonical validation rejects
non-positive and non-finite weights; the shared Render-Core adaptively
tessellates the homogeneous evaluator while keeping exact endpoints and the
analytic parameter midpoint as semantic Source snaps.

Generated TypeScript bindings and the WASM target check pass. The complete
Render-Core suite is 316/316 and all 71 viewer-package tests pass. Both explicit
browser backends verify the exact f64 conic midpoint in the 30-entity/38-proxy
scene. Forced WebGL2 on the physical Intel HD Graphics 630 reports 2.9 ms
maximum CPU submit; the WebGPU CPU adapter correctness run reports 1.3 ms.

### V2 authored UV-set checkpoint

Canonical inline meshes now retain up to eight ordered authored UV sets, which
matches the existing per-channel material index range `0..=7`. Validation
requires every present set to be finite and vertex-complete and rejects an
empty set list, cardinality drift and a ninth set. The generated TypeScript
binding carries the same nested set structure. Material resolution rejects a
channel only when its selected set is not actually declared by that mesh.

The shared vertex layout packs UV0 through UV7 into four `vec4` attributes.
Each of the five PBR channels selects its authored set and applies its affine
transform in the common vertex shader, so source material changes still do not
rebuild geometry. Instanced meshes reconstruct the exact inverse-transposed
normal direction from their affine rows in the shader; this reduces the
instance layout from 112 to 56 bytes and keeps all vertex locations within the
WebGL2 minimum while retaining the full canonical UV range on both backends.

The complete Render-Core suite passes 317/317, viewer-WASM passes 7/7 and all
71 viewer-package tests pass. Generated-binding drift, the browser TypeScript
contract and the WASM target check are green. Both explicit browser backends
select authored UV7 for the emissive channel in the 30-entity/38-proxy scene.
Forced WebGL2 on the physical Intel HD Graphics 630 reports 3.3 ms maximum CPU
submit. The repeated WebGPU CPU-adapter correctness run passes under concurrent
PhotoLab/COLMAP CPU saturation and reports 4.0 ms; this contended measurement is
evidence of correctness only and does not replace the established performance
gate.

### V2 typed block-inheritance checkpoint

The canonical block contract is now `hcad.block@2` with immutable
`hcad.resource.block-definition@2` definitions. Definition members, complete
instances and stable member-specific overrides carry explicit `inherit`,
`clear` or exact style/attribute replacement states. Inline geometry no longer
owns an app-shaped style field, and the former opaque instance override hash is
gone. Exact entity and style revisions, content-addressed attribute-table bytes,
duplicate or unknown member IDs, nesting cycles and placement composition are
validated before expansion. Source attributes/styles resolve through
definition, instance-wide and member-specific levels; a live view style remains
the final presentation-only state.

The browser fixture hash-verifies two attribute tables, exercises definition-
and instance-level inheritance plus a stable member override, and rejects a
tampered attribute payload and an unknown member override without publishing a
partial proxy. Both explicit backends pass the 30-entity/38-proxy scene. The
WebGPU CPU-adapter correctness run reports 1.9 ms maximum CPU submit. Forced
WebGL2 also passes on the physical Intel HD Graphics 630, but its 6.4 ms run was
recorded while an unrelated compute process saturated the host and is therefore
correctness evidence only, not a replacement performance gate.

Generated TypeScript bindings, the browser contract and the WASM target check
are green. The complete Render-Core suite passes 317/317, viewer-WASM passes
7/7, IO passes 61 tests with its one explicit rare scale gate ignored, and all
71 viewer-package tests pass. The full shared Core run has 148 passing tests;
the same two concurrently modified PhotoLab matching tests remain outside this
lane and prevent recording that combined command as a green gate.

### V2 canonical entity-zoo checkpoint

The shared browser zoo now includes standalone `LineSegment`, `CircularArc`,
`Ellipse`, `EllipticArc`, rational weighted `Spline` and `Composite` curves in
addition to its existing polyline, circle, clothoid and conic coverage. It also
admits an explicit construction-plane entity and expands a nested immutable
block definition through the same typed definition contract. No new browser-
or app-owned geometry shape was introduced.

For each of those eight newly covered cases, the browser requires a non-empty
presentation, an exact Source pick, an unpickable hidden state and a restored
Source pick after visibility returns. A second temporary set of the same eight
canonical variants is admitted together and detached through one exact-binding
transaction; entity/proxy counts return exactly and later picks contain no
retired address. Both explicit backends pass the complete 38-entity/47-proxy
fixture with ten worker ingests and zero main-thread provider decodes. The final
forced-WebGL2 run on the physical Intel HD Graphics 630 reports 2.8 ms maximum
CPU submit; the WebGPU CPU-adapter correctness run reports 1.4 ms. The browser
TypeScript contract is green.

### V2 provider-to-viewer and completion checkpoint

The deterministic real DXF canonical zoo, checksum-pinned buildingSMART
Tessellated Item IFC and Civil LandXML zoo now share a test-only provider-to-
viewer bridge that consumes each complete `CanonicalImportPackage` with the
production Render-Core proxy-slot, exact f64 entity-placement and Source-stroke
tessellation contracts. Associative curve uses resolve only an exact resident
entity revision; stream/block/extension or evaluated BRep cases remain
explicitly delegated instead of being reinterpreted in the importer or an app.
The complete IO suite passes 61 tests with the one declared rare synthetic scale
gate ignored.

At the milestone boundary, both explicit real-data browser backends verify all
nine checksum-pinned Khronos/Cesium fixtures plus the prepared textured-mesh
and section-topology producer. The scene contains 47 entities/56 proxies, 19
worker ingests and zero main-thread provider decodes. Forced WebGL2 on the
physical Intel HD Graphics 630 reports 2.8 ms maximum CPU submit. The WebGPU
CPU-adapter correctness run reports 4.3 ms and is not a hardware-performance
claim. Render-Core remains 317/317, viewer-WASM 7/7 and the viewer package
71/71; generated bindings and the browser contract are current. V2 closed on
2026-07-18 at 15:33 CEST after 4 h 00 min elapsed work.

## V3 raster-analysis view checkpoint

The shared kernel now derives separate panorama and oriented-image cameras
directly from canonical camera axes, pose, entity placement and image extent.
An equirectangular panorama replaces the normal-view station marker only while
its isolated analysis mode is active, using one bounded inward-facing textured
sphere compiled by the same Rust/wgpu path and the already registered immutable
image resource. The normal mixed-scene visibility and residency maps remain
untouched. An undistorted pinhole image uses the same canonical presentation
plane in a plane-local orthographic view. No React, Electron or product layer
owns either projection rule. The bounded additional GPU buffer reduces the
global shared-resource budget while the view is active and contributes its
actual visible/resident work to frame telemetry; the shared image texture is
not double-counted.

Panorama navigation keeps the exact f64 station fixed, accepts the arbitrary
canonical camera-up direction, pans through 360 degrees and changes field of
view instead of moving the source station. Image navigation reuses the common
local-frame pan/zoom controller. Both modes retain an exact return camera and
drop their bounded analysis batch on exit. Style changes rebuild only the
active bounded analysis batch; the frame path does no scene-wide work.

Analysis picks never return the sphere or camera plane as measurement truth.
The existing GPU ID/depth pass identifies the raster entity, after which Rust
maps the cursor ray back through inverse placement and camera pose, selects the
canonical pixel, validates its depth/validity/confidence resources and returns
an exact `rasterSample` Source coordinate. The same measurement helper resolves
an ordered chain of at least two image picks and computes every segment plus
the total distance from f64 Source points without consulting GPU depth.

The complete Render-Core suite passes 319/319, viewer-WASM passes 7/7, the WASM
target check is green and the viewer package passes 73/73. The browser contract
passes, and both explicit backends verify the isolated panorama texture,
oriented image, exact Source primitive IDs, cross-image distance and unchanged
normal-view restoration in the 38-entity/47-proxy fixture. Forced WebGL2 on the
physical Intel HD Graphics 630 reports 4.2 ms maximum CPU submit; the WebGPU
CPU-adapter correctness run reports 2.0 ms.

### V3 plan-only Source-pick checkpoint

Kernel pick serialization now publishes two explicit coordinates. The exact
`worldPosition` is the canonical Source result and permits `z: null`, while the
numeric `presentationPosition` is limited to navigation and screen-space
ranking. The Rust refinement path still uses its numeric plan plane internally,
but a canonical request containing unresolved heights cannot serialize that
plane as Source Z. Metadata refinement rejects an unresolved Source coordinate
instead of silently consuming its presentation height. Vertical exaggeration
uses the same separation for fully spatial entities.

The browser fixture picks an authored missing-Z hole vertex before replacing
the entity with its materialized XYZ revision. Both forced WebGL2 on the
physical Intel HD Graphics 630 and explicit WebGPU return exact f64 Source XY,
`worldPosition.z === null` and the separate numeric locked-plan presentation
height. The later revision still returns its committed XYZ value, and the
original admission still serializes its missing Z unchanged. The WASM target
check, 7 viewer-WASM tests, browser TypeScript contract and all 73 viewer-package
tests are green; the unchanged 38-entity/47-proxy scene retains ten worker
ingests and zero main-thread provider decodes on both backends.

### V3 selection and hover checkpoint

The Render-Core now owns one view-local `EntityInteractionState` and resolves
hovered and selected colors from the retained `RenderStyle`; selection has
deterministic priority when both flags are true. Resolution preserves authored
alpha, opacity, fill/stroke resources, exaggeration and the immutable base
style. Clearing the state therefore restores the exact prior presentation even
after a live base-style change. The WASM façade stores only the transient flags,
updates existing material uniforms atomically and carries the effective style
through every current slot, resident stream and staged stream request. A later
canonical revision inherits the still-active view state but records its own new
base style; complete detach clears the transient state.

The browser first uses the exact refined survey-point pick for hover and
selection, then repeats selection on a resident Potree point. On forced WebGL2
and explicit WebGPU, both cases retain the same proxy/batch identity and exact
entity/proxy/tile/primitive pick address through hover, selection and clear.
The base color restores exactly, while worker-ingest and main-thread decode
counters remain unchanged. This proves that the overlay shares the existing
ID/depth/refinement path and never becomes a geometry, residency or decode
operation. The complete Render-Core suite passes 320/320, viewer-WASM passes
7/7, the WASM target and browser TypeScript checks are green, and all 73 viewer
package tests pass. Both explicit backends pass the unchanged
38-entity/47-proxy, ten-worker-ingest fixture with zero provider decodes on the
main thread.

The adjacent command audit found no missing mutation gate: transform, move-
preview commit, undo and redo already compare entity identity, canonical
revision and version hash, then publish all expected representation bindings
through slot-generation compare-and-swap. Stale geometry targets cannot reach a
partial render-world mutation.

### V3 completion checkpoint

V3 closed on July 18, 2026 at 17:04 CEST after 1 hour 31 minutes of elapsed
work. The final boundary gate compares the checksum-pinned 47-entity/56-proxy
WebGPU and WebGL2 real-data screenshots. It reports frame RMSE `0.011007`,
identical clear and opaque-region means, and exact matching blue and pink solid
material pixels. The blue probe now occupies an unoccluded solid pixel and is
the exact sRGB transfer `[129, 191, 243]` of its linear authored base style
`[0.22, 0.52, 0.9]`; the one-channel-value tolerance was not relaxed.

Together with the current 320/320 Render-Core, 7/7 viewer-WASM, wasm32 target,
73/73 viewer-package and both explicit 38-entity/47-proxy browser gates, this
closes the deterministic navigation, analysis-view, Source-pick, snap/Tab,
selection/hover, transformjournal, clip/section and transparency requirements.
The browser fixture retains ten worker ingests and zero main-thread provider
decodes. Multi-partition section publication, reload/cancel/stale generations
and bounded per-frame work remain covered by the ordinary Rust and host suites.
V4 starts from this unchanged regression baseline.

### V4 mobile/WebView policy checkpoint

The hardware resolver now accepts an explicit `desktop` or `mobileWebView`
deployment profile. Desktop is still the default and retains the complete
adapter-derived memory, detail, render-scale, MSAA, worker and request ceilings.
A deterministic Rust gate resolves a 24-GiB calibrated discrete adapter as
mobile, then resolves desktop again and requires the latter policy to be
identical to the original desktop result. Mobile-only memory and concurrency
ceilings therefore cannot leak into capable desktop hardware. Transparency
continues to follow actual adapter features rather than a host-class label.

The short mobile portability profile ran on the physical Intel HD Graphics 630
through forced WebGL2. Its logical sources contain 1,185,930,249 points,
4,194,304 DGM triangles and 2,000,000 splats. One physical population retained
1,013,376 points, 131,072 textured DGM triangles, 50,000 splats, 16 distinct
textures (4,194,304 texture bytes) and 53 draw calls with 48,093,504 peak GPU
bytes. The interaction trace reports p50/p95/p99/maximum
10.8/29.4/36.9/42.8 ms, below the unchanged short-profile 33/50-ms p95/p99
limits. Fast zoom/orbit and abrupt direction changes ran with live worker and
range traffic; eviction plus re-entry occurred, two workers and four content
requests stayed within the Rust policy, and no provider operation failed.

This is a physical integrated-GPU browser portability gate, not a sustained
mobile-runtime claim. Thermally stable Android/iOS hardware remains an explicit
V4 completion risk. The complete Render-Core suite passes 321/321,
viewer-WASM passes 7/7, the wasm32 target and browser TypeScript checks are
green, and all 73 viewer-package tests pass.

### V4 surface recovery checkpoint

Surface loss no longer leaves the host in an endless `recreateSurface` frame
loop. `GpuSurfaceHost` drops the lost platform surface, while retaining its
adapter, logical device, renderer, frame targets and all provider GPU
allocations. The WASM host can then create a new surface for the same canvas and
re-query format, present and alpha capabilities. Only a changed presentation
format rebuilds the final transfer pipeline; scene buffers and textures are not
re-uploaded. `KernelViewport` consumes the lifecycle outcome and performs this
bounded rebind before requesting the next frame. Direct package consumers have
the same explicit `recoverSurface()` operation.

The browser fixture deliberately executes that surface replacement after an
exact exaggerated survey-point pick. Forced WebGL2 on the physical Intel HD
Graphics 630 and explicit WebGPU both present the next frame and retain the
same world generation, proxy/batch identity and exact pick address. The
38-entity/47-proxy scene remains resident, with ten worker artifact ingests and
zero main-thread provider decodes before and after recovery. WebGL2 reports
6.8 ms maximum CPU submit in this correctness run; the WebGPU CPU-adapter run
reports 2.4 ms. Four focused surface tests, the wasm32 target, browser
TypeScript contract and all 73 viewer-package tests are green.

This checkpoint proves surface re-creation with an intact device. A complete
device loss or out-of-memory reset necessarily invalidates device-owned
buffers; deterministic canonical/streaming replay onto a new kernel remains a
separate active V4 requirement rather than being mislabeled as covered here.

### V4 device-fault contract checkpoint

Device-owned failure is now distinct from platform-surface loss throughout the
Rust, WASM and TypeScript boundary. Every device is polled even when timestamp
queries are unavailable. The wgpu device-lost callback latches an unexpected
loss, while the uncaptured-error handler maps only out-of-memory to recovery;
validation and internal errors remain fatal diagnostics. A pick allocation OOM
captured by its explicit error scope latches the same recovery state. Subsequent
frames report `recreateDevice` with `deviceLost` or `outOfMemory`, rather than
entering a surface-rebind loop or continuing to use invalid GPU resources.

Five focused Render-Core surface/device tests pass, the wasm32 viewer target
and browser TypeScript check are green, and the package boundary accepts both
machine-readable recovery reasons. This checkpoint establishes detection and
transport only. Creation of a replacement kernel plus deterministic canonical
definition and streaming replay remains the active V4 slice.

Physical Windows, macOS and Apple-Silicon measurements cannot be produced on
the currently available host. Per project direction they are carried as an
explicit V6/release-conformance risk rather than blocking the transition to V5;
portable engine invariants and both browser backends remain mandatory.

### V4 device rebuild and replay checkpoint

`KernelViewport` now consumes `recreateDevice` as a terminal outcome for the
old GPU host rather than continuing frame planning or telemetry. It disposes
the old driver's requests and decode workers, creates a fresh adapter/device,
then restores state in an explicit dependency order: immutable content-
addressed definitions, live canonical scene admissions, and finally camera,
clear colour, clipping, entity presentation and raster-analysis state. The
stable scene swaps its internal viewer and streaming driver only after the
complete replay succeeds. Existing entity handles therefore follow the new
host, while retired entities remain absent. Failed bootstrap I/O releases the
candidate host and retries with bounded exponential backoff.

The replay archive retains canonical/dataset definitions and non-streaming
resources needed to recreate GPU objects. It does not retain resident tile
payloads or decoded worker artifacts; a replacement global scheduler refetches
and re-decodes those under its new hardware policy. Unit tests mutate original
pixel/depth inputs after registration and prove that replay uses immutable
snapshots. A separate scene test retires one of two entities before recovery,
keeps the other hidden, and proves the original handle operates on the new
viewer afterwards. All 75 viewer-package tests pass, as do the wasm32 and both
browser TypeScript contracts.

The browser fixture injects the same machine-readable device-loss state used by
the asynchronous wgpu callback, then creates a genuinely new kernel on a second
canvas surface. Forced WebGL2 on the physical Intel HD Graphics 630 and explicit
WebGPU both present the replacement and preserve stable entity-handle, render-
proxy and exact pick-address identity. The surrounding full fixture remains at
38 entities and 47 proxies with ten worker artifact ingests and zero provider
decodes on the main thread. Maximum CPU submit is 3.6 ms for WebGL2 and 1.4 ms
for the WebGPU CPU adapter in these correctness runs.

### V4 complete residency plateau checkpoint

The WASM streaming diagnostics now expose the Rust coordinator's complete
resource cost together with tracked entries and all eight residency stages.
The scale harness uses those values for canonical lifecycle cycles rather than
attempting to evict visible, deliberately pinned tiles by shrinking budgets. It
retires every active canonical binding, detaches each corresponding dataset
from the host driver, and requires zero tracked entries, zero entries in every
stage, and zero cost in all nine resource dimensions. It then registers the
same immutable provider manifests with the returned tombstone generations,
publishes fresh canonical bindings, and requires new network requests and
resident content. Repeated reload costs must stay under the unchanged hardware
budget and within the larger of one unit or 15 percent of that budget.

This lifecycle exposed a real retirement defect: streamed canonical slots were
being sent through the inline entity compiler while their proxies were also
retired through the dataset lifecycle. The WASM bridge now skips inline proxy
enumeration for dataset-backed slots; streamed proxy removal remains owned by
the atomic stream retirement path.

On the physical Intel HD Graphics 630 forced-WebGL2 low profile, the gate
materialized 3,040,128 points, 524,288 triangles, 100,000 splats and 170 draw
calls before latency sampling. Three full detach/reload cycles each drained all
nine costs to zero and issued 244, 242 and 242 new provider requests. Reload
costs remained on the same bounded plateau. Interaction p50/p95/p99/max was
12.5/29.9/42.2/43.0 ms, within the unchanged low-profile thresholds. The
correctness profile also passed with three zero-cost drains and 27 new requests
per reload on explicit WebGPU. The scale runner now selects `webgpu` explicitly;
its previous automatic selection could silently fall back to WebGL2 and is no
longer accepted as WebGPU evidence.

After this change the complete Render-Core suite passes 322/322, native viewer
WASM passes 7/7, the wasm32 target and browser contract typecheck pass, and the
viewer package passes 75/75 tests.

The final harness makes live interaction pressure deterministic without
discarding the profile-fill residency. It first plans a deep, non-resident view
with the ordinary idle frame budget and immediately starts the measured camera
burst before yielding to the event loop. The burst must therefore overlap a
real asynchronous fetch or decode, while the already populated mixed scene
continues to exert global budget pressure for subsequent eviction and re-entry.
This avoids both timing-dependent sampling on fast completion and the false
shortcut of clearing residency before the camera path.

On the discrete NVIDIA Quadro M2200 through PRIME-offloaded ANGLE/Vulkan and
forced WebGL2, the final low gate passed at 3,040,128 points, 524,288 triangles,
100,000 splats and 170 draw calls. Interaction p50/p95/p99/max was
8.8/23.4/30.8/54.5 ms, with the unchanged p95/p99 acceptance at 33/50 ms.
Eviction and re-entry occurred; three complete drains reached zero in every
stage and cost dimension, and all three reloads issued exactly 173 requests
with identical residency cost. The final integrated Intel HD Graphics 630 run
also passed at p50/p95/p99/max 11.8/30.8/36.1/37.1 ms, with 244/242/242 reload
requests. Final forced-WebGL2 and explicit-WebGPU correctness runs both pass the
same deterministic lifecycle; the WebGPU adapter reports CPU and remains a
correctness result rather than a hardware-performance claim.

### V4 completion boundary

V4 closed on July 18, 2026 at 18:48 CEST after 1 hour 44 minutes of measured
active work. The portable engine boundary is green: one Rust/wgpu core serves
explicit WebGPU and forced WebGL2; integrated and discrete low-profile hardware
passes retain unchanged latency limits; mobile/WebView policy cannot cap
desktop devices; surface loss and device/OOM loss have distinct recovery paths;
canonical definitions, stable handles and presentation replay onto a new device;
and repeated canonical unload/reload reaches complete zero residency before
bounded provider re-fetch.

The final physical mainstream attempt on the Quadro M2200 populated 12,160,512
points, 2,097,152 triangles, 500,000 splats and 690 draw calls without provider
failure. All three complete unloads reached zero in every stage and resource
dimension; each reload made 125 new requests and returned to the same residency
cost. The adapter is nevertheless not relabelled as mainstream: interaction
p95/p99 was 32.1/61.4 ms and fails the unchanged 16.7/33 ms criterion. No
suitable mainstream/high-end, Windows, macOS, Apple-Silicon or sustained mobile
hardware is locally available. Those physical class results remain mandatory
V6/release-conformance risks. They are not claimed as passes and, per project
direction, do not block the start of V5's package/app-ready work.

### V5 framework-free session checkpoint

The initial V5 audit found that the complete kernel behavior already existed
but ownership was split between `WgpuKernelViewer`, `KernelViewerScene`, the
streaming driver and the React canvas host. `KernelViewerSession` now provides a
framework-free owner for one complete lifetime: canvas/WASM creation, hardware
inventory and calibration, global streaming, the stable canonical scene,
frame planning, surface recovery, device rebuild and replay, camera and
presentation mutation, picking, clips, transform/move commands, typed events,
aggregated diagnostics and idempotent disposal.

Injected decoding is a factory rather than a reusable executor instance. This
is a lifecycle invariant: device recovery disposes the old driver and its
workers, then obtains a fresh executor for the replacement device. A package
test executes create, an ordinary frame, a machine-readable device-loss frame,
replacement viewer/driver creation under the same session and scene, and final
dispose. It verifies two decoder lifetimes are released and the stable session
now points at a genuinely new viewer.

The package manifest exposes `@himmelcad/viewer/kernel` explicitly. A recursive
boundary test walks the entry's complete relative import/export graph,
including the generated canonical contracts, and rejects React, Three,
Electron, shared data/UI or application imports. This keeps the stable kernel
entry product- and framework-neutral while the existing package root remains a
temporary compatibility surface for apps that have not yet received their thin
V5 lifecycle adapters. The viewer package passes 78/78 tests. Typed provider
operation progress, exact API-surface freezing, headless/browser consumer hosts
and final legacy-surface isolation remain active V5 work.

### V5 typed provider operation checkpoint

Potree, prepared triangle-mesh and prepared Civil-TIN admission now share one
monotonic operation contract. Progress moves through validation, immutable
fetch, verification and atomic publication; `complete` is emitted only after
the canonical mutation succeeds. Abort is checked before work, after
asynchronous fetch/hash boundaries and immediately before dataset registration
and publication. A Potree regression aborts after the hierarchy fetch has
returned and proves that neither dataset registration nor canonical publication
occurs.

`KernelViewerSession` assigns or preserves an operation ID, forwards progress
both to the direct caller and its typed event stream, and distinguishes
`aborted` from `loadFailed`. Progress callbacks and event listeners are
observational: their exceptions are isolated and cannot turn a committed load
into an apparent failure or mutate viewer state. The framework-free package
suite now passes 79/79 tests.

### V5 stable package surface checkpoint

The `@himmelcad/viewer/kernel` entry now uses an explicit, reviewed export list
instead of forwarding every implementation module. Its complete 202-symbol
TypeScript surface is frozen by name and value/type classification; the gate
also compiles that entry under the repository's strict, unchecked-index and
exact-optional rules. A separate runtime assertion permits exactly ten facade
values. The raw `WgpuKernelViewer`, streaming driver, decode pool, quality
governor and provider admission functions therefore cannot become accidental
product dependencies.

`KernelViewerSession` and `KernelViewerScene` no longer expose their mutable
viewer or streaming owners. Hosts use the stable scene/entity handles and
session operations, while diagnostics expose a monotonic `deviceGeneration`
to prove that recovery created a replacement device without leaking the
implementation. A compile-level product consumer verifies the public Potree
load, operation options, entity handle, event stream, diagnostics and generated
canonical entity contract, and rejects the two old escape-hatch names. The
recursive framework/product dependency boundary remains green and the complete
viewer package now passes 81/81 tests.

### V5 shared resource and analysis facade checkpoint

Framework-free consumers no longer need the hidden raw viewer to prepare an
inline or prepared canonical scene. `KernelViewerSession` now exposes immutable
glyph/annotation, block/attribute, image, depth, raster-sideband, evaluated
mesh, canonical hatch/texture/material/line-type and exact-section-product
registration. Inline canonical admissions and generic prepared raster/splat
hierarchies use the same stable scene handles as Potree, prepared mesh and TIN.
Raster analysis, exact Source-coordinate raster/depth measurement and explicit
section upsert/removal are session operations as well.

The device-rebuild lifecycle test registers image, depth, binary sideband and
mesh resources, publishes an inline canonical point, performs a Source raster
measurement and creates an exact section before injecting device loss. On the
replacement device it observes the strict replay sequence of immutable
definitions, canonical entity and section. This exposed and closed a real gap:
manual exact sections are now retained as presentation replay state and removed
from that state atomically with `removeSection`. The package remains green at
81/81 tests.

### V5 stable navigation checkpoint

`KernelViewerSession.attachNavigation()` now owns the DOM input adapter through
a narrow camera, pick, raster-analysis and scoped-clip target. That target has
no render, resource or residency operations and therefore does not reopen the
raw-viewer escape hatch. Pointer, wheel and camera-transition activity feeds
the session's interaction-aware global streaming policy, while callbacks remain
observational product hooks.

The controller instance is stable across GPU replacement. Device recovery
suspends new DOM input and pending transitions, replays onto the replacement
viewer, then uploads the controller's authoritative f64 camera when it is
reactivated. The lifecycle test enters locked top-down before injected device
loss, uses the same handle to return to 3D afterwards, and proves session
disposal invalidates it. The exact package gate now covers 202 symbols and ten
runtime facade values; all 81 viewer tests pass.

### V5 thin React adapter checkpoint

`KernelViewport` no longer creates a raw viewer, streaming driver, decode pool,
hardware governor or device-recovery loop. It is now limited to React effect
ownership, the canvas, animation-frame scheduling, resize observation and
translation of session events to optional host callbacks. Its ready handle
contains the stable session, camera, navigation and scene facades but no raw
viewer or streaming owner.

The framework-free session now also requests the next frame after surface
recovery and non-fetch residency actions, so the React adapter does not need to
inspect a streaming plan. An architecture regression reads the adapter source
and rejects raw viewer creation, streaming/decode construction and legacy
handle fields. Viewer package typecheck, the browser-kernel TypeScript contract
and all 82 package tests pass.

### V5 shared public consumer contract checkpoint

One product-neutral mixed-scene loader is now re-exported unchanged by the
headless, browser-renderer and Electron-renderer host adapters. It registers
image, depth, validity and evaluated-mesh resources, then loads a full XYZ
point, a canonical plan-only line with absent Z, a registered extension and a
prepared splat hierarchy. Every path returns the same four stable entity-handle
identities and disposes its sole session/device owner.

The functional contract executes all three adapter exports with a deterministic
headless WASM boundary. A separate source gate permits the shared loader only
one import, the public kernel entry, and requires both environment adapters to
be pure re-exports of that loader. The viewer package now passes 84/84 tests.
This proves public API consumption and shared host wiring. Render-Core and real
WASM correctness remain covered by the separate full browser fixture rather
than being inferred from this deterministic host-boundary test.

### V5 browser and Electron process checkpoint

The shared public consumer was bundled once (241.1 kB) and launched unchanged
in headless Google Chrome and an actual Electron 43 `BrowserWindow`. Both
renderer processes selected their one-line environment adapter, loaded the
same four-entity mixed scene, reported the exact same stable handle identities,
and proved that disposing the session invalidated diagnostics. Neither process
had Node integration; the Electron window used context isolation and sandboxing.

This process gate deliberately supplies a deterministic in-memory WASM boundary
because it tests package resolution, renderer compatibility and lifecycle
ownership. It is not relabelled as GPU or Rust correctness evidence; the real
WASM WebGPU/WebGL2 browser fixture remains the authority for those properties.
The strict browser contract typechecks the process host and the executable gate
reports `{ browser: "pass", electron: "pass", entities: 4,
publicFacadeOnly: true }`.

### V5 legacy compatibility isolation checkpoint

The complete historical React/Three export surface now lives in
`src/legacy.ts` and is addressable explicitly as `@himmelcad/viewer/legacy`.
The original package root is only a deprecated one-line re-export so the three
product lanes can migrate in their own lifecycle/UI work without being edited
by this viewer milestone. New hosts use the separately frozen
`@himmelcad/viewer/kernel` entry.

An architecture gate verifies the manifest mapping, exact root shim, legacy
Viewport ownership and absence of any legacy re-export through the stable
kernel entry. The package typecheck and all 85 viewer tests pass. This is
compatibility isolation, not a claim that Builder, PhotoLab or WeltView have
already replaced their UI wiring.

### V5 consumer documentation checkpoint

The viewer package now documents its complete stable integration contract next
to the exported code. The guide covers session creation/frame/disposal,
navigation, immutable resource-before-entity ordering, inline and every
prepared/provider load path, typed abort/progress/atomic publication, f64 Source
authority, the mandatory plan-only behavior for any missing Z, measurement and
section operations, events, diagnostics, device replay and the React/legacy
migration boundary.

The package guide, ADRs, milestone plan and verification history now describe
the same ownership and geometry semantics. No live height resolver, secondary
renderer or product-specific dependency is presented as part of the stable
facade.

### V5 app-ready candidate gate

The implementation reached its app-ready candidate on July 18, 2026 at 20:02
CEST after 1 hour 14 minutes of active work. The candidate evidence contained:

- 145/145 `himmelcad-core` on an isolated `aa0d884`, 322/322
  `himmelcad-render`, 61/61 `himmelcad-io` from the shared worktree with one
  explicitly ignored rare synthetic preparation gate, 7/7 `himmelcad-wasm`,
  4/4 `himmelcad-decode-wasm`, and 85/85 viewer package tests;
- current generated TypeScript bindings, browser-kernel TypeScript contract,
  package typecheck, and both wasm32 targets;
- one 241.1 kB public-consumer bundle in headless Chrome and an Electron 43
  `BrowserWindow`, each loading four identical public-facade entities and
  releasing its sole session owner;
- explicit real-data WebGPU and forced-WebGL2 browser runs at 47 entities and
  56 proxies, with exact Source picks, 19 worker artifact ingests, zero
  main-thread provider decodes, device rebuild, and maximum CPU submit of
  1.3 ms on the WebGPU correctness adapter and 4.3 ms on Intel HD Graphics 630
  WebGL2; and
- current cross-backend color RMSE 0.011956, below the existing acceptance
  threshold.

The full Core command in the shared dirty worktree reported 148/150 because two
tests observe concurrently edited, uncommitted PhotoLab matcher policy. An
isolated detached worktree at the viewer candidate passed its complete 145/145
Core suite. The later audit below establishes that this isolated state does not
also compile IO, so the two green counts cannot be combined into one completion
claim.

The decode-WASM release content was independently built, bound, optimized and
measured at 4,941,333 raw bytes, 3,549,040 bindgen bytes, 3,141,896 optimized
bytes, 1,360,797 raw-gzip bytes and 1,091,938 optimized-gzip bytes. All five are
below the existing ceilings. The locally available Ubuntu Binaryen 108 requires
`--enable-sign-ext` for current Rust output; the still-untracked external check
script only enables bulk-memory and nontrapping conversion. The measured
artifact passes when the actual emitted feature is enabled; this harness/tool
version mismatch is retained as tooling conformance rather than hidden or
patched across lane ownership.

At the V5 boundary, explicit WebGPU correctness scale completed with interaction
p95/p99 9.0/16.0 ms, three complete zero-cost drains, and 27/27/27 provider
requests on reload. The physical Intel HD Graphics 630 forced-WebGL2 low profile
materialized 3,040,128 points, 524,288 triangles, 100,000 splats, 16,777,216
texture bytes, and 170 draw calls. Interaction p50/p95/p99/max was
10.2/26.8/34.6/34.7 ms. Its three lifecycle drains reached zero tracked entries,
zero entries in every stage, and zero in all nine cost dimensions; reloads used
174/176/174 new requests and remained within the unchanged plateau.

The common viewer implementation is therefore an app-ready candidate. Remaining
Builder, PhotoLab, and WeltView work is limited to lifecycle, document-command,
resource URL, and UI-state adapters. The clean-checkout completion claim was
reopened by the reproducibility audit below. Physical Windows, macOS,
Apple-Silicon, suitable mainstream/high-end, and mobile sustained measurements
remain explicit V6 release-conformance work; their absence does not block V5.

### V5 clean-HEAD reproducibility audit

A detached worktree at the current pushed `75539af` reconfirmed 145/145 Core,
322/322 Render-Core, 7/7 viewer-WASM, 4/4 decode-WASM, current generated
bindings, and both wasm32 targets. It then found that the same clean HEAD cannot
compile `himmelcad-io`: `crates/himmelcad-io/src/lib.rs` has re-exported
`import_photo_files_with_progress` since `bb431a6`, but the tracked
`photolab_image_import.rs` has no such function.

The shared worktree contains that function only inside the concurrently edited,
uncommitted PhotoLab import lane and therefore passes 61/61 IO tests with one
intentional ignored synthetic scale gate. That same worktree currently fails
two unrelated PhotoLab matcher tests in the complete Core suite. Consequently,
the earlier completion evidence combined green results from two different
source states; it does not prove one reproducible full-suite state.

No PhotoLab or Sidecar hunk was staged, reverted, copied, or weakened during
this audit. V5 is reopened until the owning lane provides an integrated state
where the full Core/Render/IO/WASM/viewer gate is green. This is a repository
integration/reproducibility issue, not an Apple-Silicon, Windows, WebGPU,
WebGL2, or viewer-geometry gap.

### V5 clean-HEAD closure

Commit `507d81a` removes only the dangling root re-export introduced by
`bb431a6`; it does not copy or alter the uncommitted PhotoLab progress import.
The shared dirty worktree retains the re-export as an unstaged compatibility
overlay, so its concurrently edited Sidecar continues to see its own
implementation. A second clean-checkout typecheck exposed the matching
`bb431a6` camera-snap contract without `camera` in the shared dataset-kind
union. Commit `d224000` publishes exactly that required one-value Shared Data
contract and no other concurrent Data/UI change.

A detached worktree at the pushed closure state verifies one coherent source
state with 145/145 Core, 322/322 Render-Core, 58/58 IO plus one intentionally
ignored synthetic scale gate, 7/7 viewer-WASM, and 4/4 decode-WASM tests.
Generated bindings are current, both wasm32 targets compile, package typecheck
and browser-kernel typecheck pass, and the viewer package passes 86/86. The
241.1 kB public bundle also passes in real Chrome and Electron, loading four
identical stable handles solely through the public facade and releasing the one
session owner.

An intentionally broader workspace test proceeds past IO but separately finds
the concurrently developed application lane incomplete: tracked Sidecar module
declarations point at six still-untracked runtime files, and tracked MVS code is
not yet synchronized with two mask fields. Sidecar is not part of the explicit
V5 Core/Render/IO/WASM/viewer gate; it is remaining application integration and
was neither staged nor weakened here.

V5 is therefore closed at 20:50 CEST after 1 hour 40 minutes of active work
(2 hours 2 minutes calendar duration). The common viewer is app-ready; only
Builder, PhotoLab, and WeltView lifecycle, document-command, resource URL, and
UI-state adapters remain. Physical Windows, macOS, and Apple-Silicon evidence
continues as V6 release conformance and does not retroactively block V5.

### V6 portable platform-runner checkpoint

The browser, real-data, scale, WebGPU probe, and public Chrome/Electron process
runners no longer embed one Linux home directory or one `/usr/bin` Chrome path.
A shared test-only resolver selects installed Chrome and Electron executables on
Linux, Windows, and macOS, with explicit `HCAD_CHROME_PATH` and
`HCAD_ELECTRON_PATH` overrides for release machines. Cargo and wasm-bindgen are
resolved from PATH or their existing environment overrides; esbuild uses its
native executable rather than a Unix `.bin` shim. `HCAD_HEADLESS=0`
can now request a headed physical run on Windows or macOS instead of treating a
missing Linux `DISPLAY` variable as a cross-platform headless requirement.

The architecture gate reads all four runners and rejects reintroduced
machine-specific Linux paths while requiring Windows and Darwin resolution.
The viewer package passes 86/86 tests, its browser contract passes, and the same
portable consumer bundle passes in real local Chrome and Electron processes.
An explicit WebGPU browser run remains green at 38 entities, 47 proxies, ten
worker ingests, zero main-thread provider decodes, and 1.0 ms maximum CPU
submit.

The standalone map-range diagnostic also accounts for Chromium versions whose
CPU fallback now maps successfully after a presented WebGPU surface. A failure
on a hardware adapter remains fatal; only the already-known fallback-specific
map failure is diagnostic. The current fallback completed implicit and explicit
768- and 13,056-byte maps plus the post-surface map successfully. This is
portable runner readiness, not a substitute for the outstanding physical
Apple-Silicon or Windows V6 measurements.

## Candidate external data

- USGS 3DEP public-domain EPT for billion-point streaming.
- Métropole Européenne de Lille 2016 3D Tiles under Licence Ouverte 2.0.
- CesiumJS 3D Tiles specification fixtures under Apache-2.0.
- Geobasis NRW DOP plus DOM from the same bounding box under DL-DE-Zero 2.0.
- explicitly licensed NVIDIA Gaussian datasets plus deterministic generated
  1M/10M/100M splat stress fixtures.
- buildingSMART sample IFC files under CC BY 4.0.
- MIT-licensed ezdxf fixtures plus a deterministic Himmel:CAD CAD zoo.

External data is downloaded only through a checksum-pinned manifest. Large
assets live outside the source repository and are mirrored only after license
and attribution review.
