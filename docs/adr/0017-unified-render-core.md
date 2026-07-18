# ADR 0017 - Unified Render Core

## Status

Accepted for the new shared foundation.

## Date

2026-07-15

## Context

HimmelCAD must display and interact with large point clouds, very large textured
meshes, rasters with elevation, Gaussian splats and authored CAD geometry in the
same scene. Builder, PhotoLab and WeltView must share this behavior. Native iOS
and Android applications must remain possible without replacing the renderer.

The current viewer uses Three.js/WebGL. Potree and the product tile service have
independent selection, cache and budget paths. Combining complete Potree and
CesiumJS viewers would add a second camera, scene, render loop, cache, picking
system and GPU context rather than create one shared renderer.

## Decision

### One Rust render core based on wgpu

The permanent renderer is a platform-neutral Rust crate built on `wgpu`.

```text
React / Electron / browser / native host
  RenderFacade
    Rust Render Core
      f64 camera and world frames
      RenderWorld and render proxies
      global tile planner
      residency and device policy
      picking candidates
      wgpu frame graph
```

The intended backend matrix is:

- WebGPU in capable browsers and Electron;
- WebGL2 as a permanent downlevel WASM backend;
- Vulkan on Linux and Android;
- Direct3D 12 or Vulkan on Windows;
- Metal on macOS and iOS.

WebGL2 is not a prototype that will later be deleted. It is a lower-capability
backend of the same engine. Backend features and budgets may differ; entity,
view, picking and correctness contracts do not.

### Formats are providers, not render engines

- Potree 2.0 remains the prepared point-cloud format.
- 3D Tiles 1.1 with glTF content becomes the primary large textured-mesh and
  instancing format.
- Raster/elevation pyramids and Gaussian splats have dedicated providers.
- Authored CAD entities compile to render proxies directly.

Potree and 3D Tiles keep their different hierarchy semantics. They implement
small shared capabilities instead of being merged into one format-specific
class:

- `HierarchySource` supplies bounds, geometric error, child availability,
  content references and ADD/REPLACE refinement.
- `ContentDecoder` prepares points, glTF, raster, splat or CAD content.
- `SelectionPolicy` performs bounded visibility and SSE selection.
- `ResidencyCoordinator` owns download, decode, upload and eviction globally.
- `RenderResourceBuilder` creates backend resources.

All providers compete in one global resource and time budget and render through
one camera, one depth buffer, one pick namespace and one clip-volume set.

CesiumJS and the vendored Three/Potree loader remain behavioral and format
references during migration; neither is embedded as a second final render
engine. `3DTilesRendererJS` may be used for conformance comparison.

### Coordinates

Canonical and camera state use `f64`. GPU vertices are tile-local `f32` with an
explicit `f64` tile-to-world transform and camera-relative rendering. Source
coordinates are immutable. Test and product placement use explicit transforms
rather than rewriting source vertices around zero.

### Clipping and sections

Clipping has three explicit levels:

1. hierarchy culling rejects tiles wholly outside clip volumes;
2. shader clipping handles points, lines, triangles, rasters and splats;
3. section generation creates contours, caps and material-aware hatching.

Small resident closed meshes may derive exact preview caps at a state-mutation
boundary. Resource-backed CAD/BIM and mesh caps are asynchronous immutable
section products computed from authoritative topology, never from the current
render LOD. Frame submission performs no topology evaluation, resource fetch or
new derived-geometry upload. Point clouds, splats and open Civil TINs do not
invent solid caps.

The viewer owns one authoritative clip-cap coordinator for its lifetime.
Prepared-mesh admission registers the resolved immutable topology locations
only after the combined dataset/canonical mutation succeeds and binds them to
the exact returned representation generation. Base and tool-scoped clips are
composed and published to GPU synchronously; the same final list then drives
asynchronous exact-cap work without recursively republishing clips. Canonical
replacement swaps topology sources without an empty intermediate state,
retirement removes them only after the kernel mutation succeeds, and live
style changes reuse the committed geometry product. The intersection tolerance
is explicit project/view policy supplied by the host, not entity geometry
semantics. Stale jobs are aborted while the previous complete cap remains
visible until an atomic replacement compiles successfully.

### Picking and snapping

A shared ID/depth pass addresses entity, render proxy, tile and primitive.
Small cursor neighborhoods are read asynchronously. Providers refine these
visible candidates against point indices, mesh BVHs, elevation grids or
analytic CAD geometry. Tab and Shift+Tab cycle the single ranked candidate
stack while the viewport owns keyboard focus.

Renderer hits are hints. Commands that change geometry revalidate the target
and entity version in the authoritative core.

### Device adaptation

The device policy reads backend features and limits, runs bounded startup
calibration and adapts during runtime. It budgets:

- compressed and decoded CPU bytes;
- GPU buffer and texture bytes;
- staging and upload bytes per frame;
- downloads and decoder concurrency;
- traversal, decode, upload, CPU frame and GPU frame time;
- draw calls and pipeline switches;
- resolution, MSAA and transparency mode.

Adaptation may change LOD, render scale, effects, splat quality and transparency
strategy. It must not change canonical geometry, measurement correctness or
exact snapping semantics. High-end devices are not capped by low-end budgets.
The bounded telemetry and quality state are host-serializable. A recalibrated
lower ceiling applies immediately, while a higher ceiling is approached only
through sustained-headroom hysteresis and never as an abrupt quality jump.
The Rust kernel owns the runtime governor and a fixed 240-frame telemetry
window; TypeScript submits CPU/interaction/upload observations but does not
reproduce quality policy or supply GPU timings. When `TIMESTAMP_QUERY` is
available, the surface host timestamps the beginning of the first geometry pass
and the end of the final presentation pass. A fixed three-slot asynchronous
readback ring is polled without waiting; only completed, generation-matched,
positive timestamp intervals enter telemetry. Pending, failed, device-lost and
unsupported paths report no GPU value. This interval covers geometry, OIT,
picking copies and the explicit presentation transfer without measuring CPU
submission time.
Its snapshots report CPU and optional GPU p50/p95/p99, uploaded bytes, visible
points/triangles/splats/draw calls and complete GPU residency. Hidden canonical
proxies, shared kernel resources, clip caps and private move-preview forks are
accounted without charging shared allocations twice. Invalid timing samples are
rejected without entering either telemetry or hysteresis state.
The same resolved hardware policy owns distinct idle and active-interaction
streaming ceilings. Active orbit, pan, zoom and edit drags retain resident
quality while reducing only traversal nodes/time, decode admission, upload
bytes and new request starts. The shared viewport selects the kernel-authored
pair; it contains no device-tier constants. Both pairs scale with measured
device detail, so low-end latency protection cannot become a ceiling on
high-end hardware.
Streamed move previews are separate auxiliary consumers of that same scheduler,
not cloned provider pipelines. Their f64 target placement participates in the
normal provider-neutral hierarchy traversal, while source and target demand are
coalesced by tile identity and maximum screen-space error. Auxiliary target
tiles share admission, requests, decode, upload and eviction with the canonical
view, but never enter its returned render set. Resident target fallback remains
pinned while finer target detail loads. A rigid drag changes only the preview
batch origin and presentation binding; it does not decode or upload geometry on
every pointer event. This preserves ECEF-scale translation precision and keeps
the original entity hidden when only its moved position intersects the camera.
Committing a rigid move uses the canonical entity command and its exact
revision/version compare-and-swap. Translation-only placement changes retain
resident Potree, 3D Tiles, raster and Gaussian allocations together with stable
proxy IDs and pick slots. A bounds overlay atomically publishes the new slot
bindings, pick transforms and batch-origin uniforms without rewriting vertices,
decoding content or uploading it again. Pending work from the replaced entity
version is stale by construction. General affine changes take the ordinary
correct recompilation/reload path until equivalent residency retention is
proven for them.

Exact section products are version-bound. Canonical replacement removes an old
exact-section proxy atomically and the host coordinator schedules the new
version; sections over inline geometry rebuild locally.
Visible render-tile keys remain inside the kernel after visibility is applied.
The ordinary host plan returns only the visible count and actual asynchronous
host actions; exact key lists are an explicit diagnostic option. Production
navigation therefore does not serialize and parse O(visible tiles) strings on
every frame.
The streaming coordinator can also replace its decoder-worker and shared
content-request ceilings at runtime without rebuilding residency, tickets or
fairness state. Lower ceilings let already generation-authorized work finish
but prevent new claims; higher ceilings expose slots immediately. Tile fetches
and lazy hierarchy-page fetches consume the same bounded I/O pool, and stale
callbacks cannot release a newer task's slot. The WASM hardware-policy boundary
applies every resolved `decoderWorkers`/`contentRequests` pair without replacing
the coordinator. A dynamically replaceable host semaphore independently bounds
the actual HTTP/range operations for multi-content tiles, raster elevation
bands, recursive external assets and hierarchy pages; lowering it drains live
requests without admitting queued work, raising it wakes queued work, and abort
or disposal releases every permit. Provider decode executes in a bounded pool
of transferable `himmelcad-decode-wasm` workers. The host validates the
HCDECODE input manifest and returned artifact before a small synchronous ingest
step; cancellation terminates a non-cooperative worker and replacement does not
stall the next queued job. Worker count and reserved linear memory follow the
Rust policy rather than an independent JavaScript tier table.

## Rejected alternatives

### Combined Potree and CesiumJS fork

Rejected because both are complete render engines. Merging them would require
maintaining two tightly coupled upstreams while still replacing their cameras,
schedulers, picking, clipping and GPU state.

### Permanent Three.js-only core

Rejected as the final cross-platform boundary because the native mobile target
would require a second renderer and current point, mesh and splat paths remain
separate schedulers. Three.js remains useful for behavior comparison during the
transition.

## First implementation slice

1. Backend-neutral render contracts and deterministic scheduler tests.
2. wgpu surface and device capability reporting for native and WASM.
3. f64 camera with tile-local f32 render transforms.
4. Potree hierarchy/content provider and 3D Tiles explicit hierarchy/GLB
   provider behind one scheduler.
5. Opaque, point, ID/depth and clip passes.
6. One scene containing point cloud, textured 3D Tiles mesh and CAD curves.
7. Clip box over all three and preview cap on a closed mesh.
8. WebGPU and forced WebGL2 runs from the same codebase.

## Implementation status

The shared Rust crate now contains the backend/capability contract, f64 camera
and camera-relative precision model, surface lifecycle, global fair admission
scheduler, bounded frustum/SSE plus clip-volume selection, generation-safe
residency/LRU coordination and hardware-derived startup/runtime quality policy.
Potree 2.0, explicit and implicit 3D Tiles 1.1, paged prepared hierarchies,
elevation rasters and Gaussian splats feed the same planner and resource budget.
PotreeConverter `DEFAULT`, `UNCOMPRESSED` and attribute-major Morton `BROTLI`
nodes share one bounded worker decoder. Civil point attributes remain aligned
with the original primitive index through HCDECODE v3, compact GPU styling and
resident exact-pick metadata.
`ADD` and atomic `REPLACE` fallback semantics are resolved before drawing.
Legacy 3D Tiles containers are decoded at the provider boundary: `b3dm`,
`pnts`, nested `cmpt` and embedded-model `i3dm` share the same resident leaf,
resource accounting and exact-picking paths. Instance transforms retain f64
tile/RTC/position/orientation/scale ordering and per-instance feature IDs.
Inspection and decode share one strict container-layout validator: declared
lengths, eight-byte table/tile/child boundaries, GLB chunk alignment, payload
padding and external URI padding cannot diverge between the two paths. GLB1
`CESIUM_RTC` is applied in the same transform chain, and malformed legacy
material/technique references are errors rather than panic paths.
`i3dm` owns one decoded GLB plus source-ordered f64 transforms. Deterministic
4,096-metre cells bound chunk-relative f32 translations and portable u32 pick
ranges; each chunk submits one shared indexed geometry buffer plus a compact
instance buffer. Exact picking retains one shared model geometry/BVH plus
compact affine records and a top-level instance-AABB BVH per spatial chunk. It
therefore maps chunk-local GPU IDs back to stable `instance × model-triangle`
source IDs without expanding the model triangles for every instance. JSON or
binary legacy Batch Table rows resolve from the same picked source instance.
`b3dm` binds `_BATCHID` to the exact picked source triangle in both GLB1 and
GLB2; ambiguous vertex IDs use the same deterministic nearest-barycentric-
vertex rule as modern mesh features. `3DTILES_batch_table_hierarchy` retains a
bounded class/parent graph instead of expanding inherited properties per
instance. Direct properties override inherited values, nearest ancestors win,
equal values at the same depth collapse and conflicting equal-depth values are
rejected. JSON and binary topology/property encodings, multiple parents,
self-root records, cycles, alignment, ranges and decode budgets are validated
before publication for `b3dm`, `i3dm` and `pnts`.
The WASM boundary exposes one provider-discriminated exact-pick metadata
envelope instead of separate selection logic in TypeScript. Modern glTF
structural metadata and legacy metadata may coexist. `b3dm` uses the picked
source triangle plus authoritative barycentrics, `i3dm` maps chunked GPU
addresses back to the original instance, and `pnts` maps the exact source point
through `BATCH_ID` or the specification's implicit per-point fallback. Direct
and inherited rows include exact hierarchy instance and ancestor/parent
provenance. Catalog storage is geometry-independent, shared across instance
chunks by `Arc` and residency-accounted once. The compatibility
`gltfFeatureMetadata` API delegates to this envelope; the old duplicate WASM
Batch Table decoder no longer exists.

External glTF is an explicit bounded asset graph rather than an implicit loader
side effect. Dependency inspection covers JSON glTF, GLB, `b3dm`, `i3dm`,
recursive `cmpt`, buffers, images and external structural-metadata schemas.
The host resolves each exact `(owner URI, authored source URI)` pair, deduplicates
transport by resolved URI and supplies one validated packed bundle. The kernel
then materializes a self-contained GLB while preserving source transforms,
meshopt buffer references, image MIME semantics and metadata ownership. Data
URIs remain local and do not become host fetches.
Immutable external resources are then shared kernel-wide by SHA-256 and byte
length, with a full in-process byte comparison before reuse. URI aliases remain
bundle-local. Preparation is side-effect free; transaction commit and eviction
replace stable stream-owner refcounts, and only the global shared-residency
cost retains uploaded bundle bytes. Instanced glTF models also have a separate
decoded GPU identity: exact indexed vertex/index upload bytes plus decoder and
layout revisions identify one immutable geometry allocation. Distinct stream
owners can therefore share its vertex buffer, index buffer and expanded exact-
pick vertex buffer, while each spatial chunk retains only its compact instance
buffer, transform, proxy and source-instance mapping. Staging references are
side-effect free until atomic publication, replacement and last-owner eviction
update resident references, and the geometry bytes are charged once to global
shared residency rather than once per tile. The render core now also defines
the corresponding immutable texture/sampler cache primitive. Its identity
hashes exact decoded/uploaded mip bytes, chosen backend transcode format,
dimensions, mip layout, color space, complete sampler state and decoder
revision; URI, entity and presentation style are excluded. Detached stages,
atomic owner replacement, rollback, last-owner eviction and global cost-once
accounting match the geometry lifetime contract. A resolve-or-create lookup
runs before the GPU allocation factory, so a second owner does not redundantly
upload and discard an identical texture. Mutable material uniforms and
presentation styles stay tile-local. The live WASM stream-owner transaction
now resolves or creates immutable textures before batch construction, stages
owner references transactionally and commits them with heterogeneous tile
publication. A second owner with identical uploaded identity performs neither
another decode nor another allocation; replacement, rollback and last-owner
eviction update global residency exactly once.

Project-authored presentation resources have a separate immutable authority
above those decoded GPU allocations. Textures, materials, ordered mesh
material tables, hatch patterns, line types and annotation styles resolve by the complete
`(schemaId, resourceId, contentHash)` reference; a stable ID alone is never a
"latest style" lookup. Multiple revisions of one stable resource may therefore
remain live for older entities and block definitions. Publication uses a
two-phase stage, dependency validation and commit transaction. Texture
references in materials, material references in mesh material tables and
line-type references in annotation styles may resolve either against an already
published revision or another item in the same transaction. A missing or
duplicate exact revision commits nothing. The
transaction validates only the staged batch and compact exact-reference
indices; it does not clone the complete resident project catalog per update.

Inline mesh vertices retain up to eight ordered authored UV sets, matching the
canonical material-channel index range `0..=7`. The shared WebGPU/WebGL2 layout
packs them into four `vec4` attributes. Each PBR channel selects and transforms
its own set in the vertex shader, so a material or UV-transform change remains
presentation-only and never rebuilds geometry. Instanced normal directions are
reconstructed from the affine instance rows in the shader; the complete mesh
plus instance layout therefore remains below the portable 16-attribute limit
without reducing canonical UV breadth on more capable hardware.

The real `wgpu` path renders points, Gaussian splats, indexed textured GLB,
continuous and pixel-step elevation rasters, analytic CAD, areas with hatches,
text, dimensions, blocks, evaluated solids and exact section products through
one reverse-Z frame graph. Stable batch origins are separated from the active
frame origin, so a camera-origin change updates uniforms without rebuilding or
re-decoding resident content.

Presentation fill is resolved centrally per draw batch after provider geometry
and immutable resources are known. `none` disables both color and pick
fragments only for fill-capable batches, so an area's stroke remains visible;
`color` restores the provider's immutable source texture where one exists;
`texture` binds a registered immutable image only when the provider explicitly
declared texture coordinates; and `hatch` resolves a registered vector hatch in
project-world coordinates relative to the stable batch origin. Missing
resources and implicit texture mapping fail before any live batch is mutated.
These live changes replace only presentation uniforms and material bind groups:
render-proxy identity, geometry buffers, provider decode state, exact picking
metadata and source textures remain unchanged. The same resolver is used for
inline entities, streamed glTF/3D Tiles and elevation rasters, move previews and
section-region presentation rather than keeping a second host-side style path.

Block expansion resolves immutable `block-definition@2` contracts in the same
kernel. Member source style/attributes are followed by definition assignment,
instance-wide assignment and stable member-specific assignment; a live view
style remains a final presentation-only override. `inherit`, `clear` and exact
resource/content replacements are explicit states. Attribute-table bytes are
hash-verified before their identities are admitted. Unknown member IDs, missing
or stale style/attribute revisions and cycles fail before any member proxy is
published, while nested placements preserve `instanceThenMember` composition.

Stroke presentation is a separate required contract on the same `RenderStyle`,
with a serde default that normalizes older stored styles to the previous visible
source-width behavior. `none`, `color` and registered `lineType` modes apply
only to `CadStroke` batches, so an area's boundary and fill can be changed
independently. Stroke color can inherit the common color mapping or use an
independent linear color; width can retain the immutable source/annotation
width or override it in physical screen pixels. Butt, square and round caps and
miter, bevel and round joins are selected in the material uniform. Changing any
of these values rewrites presentation state only.

Tessellated curves retain explicit ordered subpaths rather than inferring
connectivity from approximately equal floating-point endpoints. Area rings,
alignment centerlines and width-band edges therefore keep independent path
topology. One immutable line instance carries its predecessor, successor,
endpoint flags and local path distance. Alternating draw/gap resources are
evaluated continuously in authored world units in both color and ID shaders.
For long Civil paths the distance is encoded as an integer 4,096-unit chunk plus
a local `f32` remainder; modular repeated doubling reconstructs the live
resource phase without converting the full chainage to one imprecise float.
Round-cap and round-join coverage emits only the non-overlapping analytic
sector, avoiding repeated alpha contribution in transparent passes. Missing or
invalid line-type resources fail before resident materials are mutated.

Alignment slope rules are never treated as decorative metadata or silently
ignored. The current schema does not yet identify a unique authored daylight
edge, so the renderer does not guess one from `outerOffset`. A civil geometry
provider must instead supply one immutable f64 triangle mesh per rule, bound to
the exact source band, target surface revision and a verified content hash.
Each resolved slope becomes its own triangle/pick proxy. Missing, duplicate,
stale, resource-backed or otherwise incompatible results fail compilation. The
incremental preview evaluator feeds this same contract; rigid ghost translation
alone is not presented as dependency-aware slope editing.

The CPU render/core layer now has that incremental preview evaluator. It
prepares the horizontal f64 path once, divides the station domain into bounded
partitions and emits width-band road strips whose elevation includes the
crossfall/ramp bands, plus one `ResolvedAlignmentSlopeGeometry` per authored
rule and partition. Crossfall is not emitted again as a coincident surface, so
the preview does not create avoidable Z-fighting. The civil provider supplies
independently loadable, rule-bound daylight partitions against an exact
target-surface revision; the render core still never guesses the source edge.
Published preview revisions use a persistent path-copied partition tree with
deterministic content identity and compare-and-swap generations; lookup and
replacement remain logarithmic independently of edit count, and revisions keep
only the preceding identity rather than an unbounded parent object chain. A
station-local width/crossfall edit commit accepts only bounded, already
gradient/width/crossfall-resolved road cross sections for the covered
partitions plus the matching provider daylight overlays. The commit owns no
full `AlignmentGeometry`, performs no global alignment comparison or station
sample sort and resolves target/rule partitions by ordered lookup; canonical
admission and edit invalidation prepare those exact inputs before the render
hot path. Missing affected partitions, stale
generations, changed target revisions and horizontal-path changes fail before
commit. Horizontal-path edits and target-surface revision changes currently
require a fresh evaluator build rather than pretending that old partitions are
current.

The browser kernel exposes that evaluator as one transient preview session,
not as intermediate canonical entities. Build and update compile road/slope
meshes plus their pick refiners against a prepared `RenderWorld` overlay. The
overlay and a cloned evaluator candidate commit as one success boundary;
validation, stale-generation, mesh compilation or GPU preparation failure
leaves the active session and visible proxies unchanged. Stable proxy IDs are
derived from preview, station partition, role and authored band/rule. Update
therefore replaces exactly the reported changed partitions, while retire
removes all session proxies atomically.

Transparency is capability-resolved rather than backend-name-resolved.
Adapters exposing blendable `Rgba16Float`/`R8Unorm` MRT attachments and
independent blending use bounded reverse-Z weighted OIT. Other WebGL2/OpenGL
adapters use stable CPU radix sorting in 32,768-splat blocks plus far-to-near
batch ordering in the common surface host. A rotating cursor admits at most
4 MiB of changed block uploads per frame, so continuously moving cameras cannot
starve later tiles or create unbounded main-thread traffic. The OIT path retains
no CPU sorting copy and is never constrained by the downlevel block size or
upload budget.

The same downlevel contract applies inside transparent instanced meshes. Each
block uses fully transformed primitive centers, stable reverse-Z ordering and
`primitiveOffset` as its deterministic tie-break, so exact pick addresses do not
change with draw order. Interaction translation, vertical exaggeration, datum
and floating-origin changes participate in the sort. Blocks are capped at the
largest whole number of 56-byte instance records below 4 MiB. Weighted OIT
keeps one immutable GPU instance buffer and no CPU sorting copy, so downlevel
correctness imposes no persistent cost on capable adapters.

The portable pick pass writes 32-bit proxy and primitive slots into two
`RGBA8Uint` attachments and reads bounded neighborhoods asynchronously.
Provider refinement restores quantized Potree f64 points, topology-aware raster
samples, Gaussian means/coverage and triangle-mesh faces, edges and vertices.
Owned per-proxy BVHs cover inline and registered meshes, evaluated/generated
solids and each 3D Tiles mesh leaf without scanning resident datasets. Analytic
CAD refinement keeps authored/evaluated point, vertex and midpoint candidates
in a semantic primitive-ID range disjoint from 32-bit render tessellation.
Changing chord tolerance cannot change these candidates, and render vertices
of circles, clothoids or splines are never exposed as authored snaps. Exact
single-point refinement shares point placement and locked-plan unknown-height
semantics with compilation instead of accepting a depth-unprojected approximation.
Area boundary snaps resolve only authored inline or exact associative curves. A
fully materialized XYZ revision uses the same path without any viewer-side height
resolver. Open TIN sections emit exact traces without invented caps, while
evaluated closed products retain material-slot hatch regions.

Vertical exaggeration is presentation-only and explicitly invertible. Its
finite factor must be greater than zero and acts around an explicit f64
project-world datum. Provider-local geometry and BVHs stay in provider source
space, while public pick coordinates are returned in canonical project world.
Exact queries apply the inverse chain `presentation -> entity placement`;
provider candidates apply `entity placement -> presentation` for screen
ranking. GPU depth uses the displayed coordinate, while clipping, height ramps
and hatch evaluation use canonical project coordinates before presentation.
Gaussian means and covariance axes receive the same placement and Z transform.
This prevents display exaggeration from changing survey coordinates, Civil
height classification or clipping semantics on either backend. A flattened
factor of zero is rejected rather than returning an invented source height.

Every streamed canonical entity uses one provider-neutral f64 affine placement
from provider source into project world. Hierarchy traversal applies that
placement and then presentation before frustum and screen-space-error
selection; project clip volumes are classified after placement but before
presentation. GPU batches retain provider-local f32 vertices and receive the
same affine linear/normal transform as a small uniform, so placement does not
rewrite millions of points or triangles. AABBs become placed OBBs, OBBs
transform their half axes, geodetic regions transform their eight corners and
a true sphere uses the placement's conservative maximum linear scale. This preserves a
conservative displayed bound without multiplying the already large horizontal
radius of a flat Civil tile. Geometric error is conservatively scaled for SSE;
clip classification continues to use the authoritative project bound. Potree,
raster, Gaussian, explicit/implicit 3D Tiles and prepared-mesh sources all pass
through this one selector/GPU/picking contract. Finite invertible placement is
mandatory. A metadata-only hierarchy without a canonical entity intentionally
uses identity until it is bound to one entity.

Active `previewCap` clip volumes derive transient f64 sections for closed
inline, generated-solid and block-member meshes. Every cap is triangle-clipped
to the remaining convex box planes, offset to the retained side for stable
rasterization and rendered with the clip volume's default or per-material-slot
vector hatch resource. Layered wall cuts can therefore retain different hatch
semantics per material. Inline meshes carry one validated material-table slot
per triangle; resource-backed formats retain the equivalent association inside
their immutable payload. Open surfaces, point clouds and splats remain
uncapped.

Resource-backed closed meshes use the same placement-aware authoritative
section-topology accumulator as exact sections. A host
`KernelClipCapCoordinator` publishes the shader clip immediately, evaluates
only canonical topology partitions and commits a non-pickable cap under a
stable section identity. Jobs are keyed by clip geometry, plane,
representation generation, entity version, topology and tolerance. Superseded
jobs are aborted and checked again immediately before registration/upsert; the
previous complete cap stays visible until its atomic replacement. Tile
publication, eviction and LOD swaps never invalidate or recompute a cap. The
f64 result is cropped by all remaining convex-volume planes and receives the
volume's material hatch policy.

Playwright now runs the same mixed ECEF-scale entity zoo through explicitly
selected WebGPU and WebGL2 kernels. Both gates cover calibration, presented
frames, clipping, exact ID/depth picking, backend-specific screenshots and an
origin rebase that must preserve render-world generation and the center hit.
The camera controller matches perspective target-plane span to locked
orthographic span in both directions; orthographic zoom therefore updates the
perspective return distance instead of restoring a stale pre-2D scale. It also
accepts arbitrary finite orthonormal local view frames with an explicit origin,
normal, up axis and vertical span. Local pan, zoom and cursor-plane projection
share that basis, orbit is locked, and leaving the frame restores the complete
captured 3D camera. A 45-degree vertical profile frame is rendered through the
same Rust transition matrices in both browser backend gates. Profiles and
section frames remain transient view state and do not introduce canonical
geometry entities.

Hosts may also author a perspective standpoint directly as f64 project-world
eye/target coordinates plus an optional vertical field of view. The shared
Z-up controller derives its orbit state only after rejecting coincident,
non-finite or near-singular viewpoints, then uses the same backend-independent
camera morph. Entering that standpoint from a local section view removes only
the scoped depth slab and leaves ordinary user clips intact.

Local section depth is represented by a scoped two-plane `KeepInside` clip
volume around that frame: front depth follows the frame normal toward the
camera and back depth follows the viewing direction. Scoped clips compose
atomically with ordinary user clip boxes instead of replacing them, and are
removed when navigation leaves the local view. A depth slab does not request
preview caps: the current general volume-cap path correctly caps every boundary,
whereas an exact single section plane and its material hatch are provided by
the existing authoritative section-product path.

Streaming publication is transactional across heterogeneous multiple contents,
not merely atomic per payload. Staging records are moved—not cloned—out of the
provider maps, every replacement and dependent raster-derived entity is
compiled against a private `RenderWorld`, and newly allocated GPU batches remain
local until every payload succeeds. A failure restores all staging records and
leaves the resident world, proxy maps and pick indices untouched. The browser
driver issues exactly one synchronous transaction for each tile. A stable
stream identity may also change provider type transactionally; the browser gate
round-trips Potree to glTF and back without leaking either provider's request,
proxy or refinement index.

Mixed-height areas remain visible only in locked top-down plan views. The
render kernel never resolves missing Z through a plane, TIN/raster drape or an
interpolation resource. A CAD height-assignment command may use those inputs,
but it must write actual finite Z values and commit a new canonical entity
revision before the common 3D compiler, GPU display or exact spatial picking
accepts the result. Known survey Z remains unchanged unless a separate explicit
edit requests otherwise.

Unknown namespaced geometry extensions remain preserved canonical payloads.
When their domain evaluator publishes a separate content-addressed triangle
representation, the common renderer displays and BVH-picks that representation
without interpreting, replacing or flattening the extension payload.

Explicit 3D Tiles hierarchies retain embedded or resolved external schemas,
tileset metadata, statistics, tile metadata and content/group metadata. The
catalog crosses the WASM facade for UI inspection, while resident render
proxies keep queryable tile/content metadata until their atomic eviction.
Within glTF content, `EXT_mesh_features` attribute and implicit IDs retain
their source-triangle vertex mapping and resolve by exact BVH barycentrics;
texture-backed IDs retain transformed triangle UVs and sample ordered channels
from only the referenced resident image.
Linked `EXT_structural_metadata` property tables retain only referenced binary
views, decode rows lazily (including arrays, strings, booleans, enums and
numeric transforms), and share the render proxy's residency accounting and
atomic eviction. Primitive property attributes retain the three authoritative
source-vertex values and expose any nearest-vertex choice explicitly rather
than inventing unspecified interpolation. Property textures share the exact
hit UV/image cache, nearest-sample RGBA8 channels in declared order and apply
metadata semantics after raw decoding. Re-encoded compressed GLBs preserve the
required eight-byte metadata alignment.

Compressed glTF content is normalized before the common scene decoder.
`EXT_meshopt_compression` supports attribute, triangle and index modes plus all
standard post-filters; `KHR_draco_mesh_compression` uses the same pure-Rust
decode path on native and WASM. `KHR_texture_basisu` accepts ETC1S and UASTC
KTX2, including Zstandard and complete mip chains, and transcodes to BC, ETC2,
ASTC or an uncompressed fallback according to the features of the actual
adapter. The ordinary and compressed paths therefore retain identical node,
material, f64 transform and exact-picking semantics.

Decode work is bounded before allocation and before entering native codec
loops. Central ceilings cover encoded and materialized bytes, instantiated glTF
geometry and scene depth, decoded image dimensions/RGBA bytes, meshopt/Draco/
KTX2 output, raster topology, PLY row width, metadata arrays, point/instance
counts and composite children. These are hard safety ceilings above the lower
runtime device/residency budgets, not a low-end quality cap imposed on capable
hardware.

Cross-tile exact sections are immutable products of an authoritative topology
provider, never a stitch of whatever render tiles happen to be resident. The
versioned product envelope binds the complete result to entity, dataset,
canonical entity version, topology snapshot, exact plane and evaluator
tolerance. It lists deterministic topology partitions for provenance without
making them render-residency dependencies. Every triangulated region has a
stable region ID and canonical material key, so hatches do not depend on
tile-local material-slot numbering. The kernel validates the complete envelope
before registration and rejects entity-version changes that would leave an
active evaluated section stale. A synthetic two-part gate requires one region
to cross the partition seam and rejects incomplete material identity.

The render core also provides the provider-side evaluator for partitioned
closed and open topology snapshots. It intersects each authoritative partition
in f64. Closed sources construct contours once from the combined segment set;
open Civil TINs emit the combined exact trace and never invent a cap. Partition
input order is normalized, seams do not become product boundaries, and closed
region identities are derived deterministically from the complete topology
hash, canonical material key and resulting triangles. This evaluator is
independent of render-tile residency. Visible tiles are never treated as the
topology store. The
render core now includes the concrete immutable snapshot registry and its
content-addressed partition-loader boundary. Publishing replaces only one exact
entity/dataset revision after manifest validation. Evaluation loads and drops
one intersecting partition at a time, retains only plane-intersection segments,
verifies each loaded topology hash and emits the complete product after the
final partition. Optional representation-source bounds are validated and
transformed through the canonical entity placement by the kernel;
project-plane-disjoint partitions advance without invoking the loader, while
missing or numerically ambiguous bounds conservatively retain the exact path.
The production DGM tiler now emits content-addressed finest-LOD topology
partitions through the bounded `hcad.section-topology-index@2` contract and a
separate provider-neutral glTF render hierarchy. Bounds are accumulated from
the same quantized f32 coordinates reconstructed by WASM, preventing unsafe
edge culling. Browser/WASM admission verifies both manifests and evaluates one
intersecting partition at a time.
The same contract is now produced by a provider-neutral disk-bounded triangle
mesh preprocessor. Render nodes use local f32 display data; authoritative
partitions retain every source triangle once as absolute f64. Closed-manifold
claims are proven by an external edge sort before publication. A bounded ASCII
and binary-little-endian PLY adapter feeds COLMAP mesh results into this path,
so DGM and photogrammetric meshes do not require different viewer authority.
COLMAP's official textured output uses the same spool and hierarchy: its
per-face six-float UV list remains attached to each triangle, tiles write
immutable f32 UV buffers, and the PNG atlas is another verified external glTF
asset. Texturing therefore changes presentation resources without creating a
second topology or section authority.
Prepared vertex buffers remain CAD-local Z-up and the generated glTF node owns
the inverse basis transform. The shared glTF decoder's normal Y-up-to-Z-up
conversion therefore composes to identity for prepared Civil meshes, while
ordinary upstream glTF continues to receive the standards conversion.
Parent display nodes are adaptive vertex-cluster proxies rather than sampled
triangle subsets: the producer retains all clustered faces at one resolution
and performs another bounded spool scan at a coarser resolution if necessary.
Collapsed detail keeps a spatial source representative, hierarchy bounds cover
the complete source node as well as decoded f32 vertices, and the selected cell
scale supplies geometric error for refinement.
The producer groups shared indices into deterministic glTF primitives per
source material slot and records that slot in material extras. The same slot is
written to exact section topology, preserving one material identity for normal
rendering, styling, caps and hatching.
Prepared mesh trees above 512 tiles now exercise the existing lazy hierarchy
contract in production: the root stays inline and descendant pages contain at
most 510 descriptors, with exact byte range and SHA-256. Pages are serialized
bottom-up so every nested page identity is transitively committed by the root;
the provider still validates and merges one page atomically.
Authoritative section partitions are generated from every finest-grid source
sample independently of the render face budget; render decimation therefore
cannot silently become measurement or profile decimation.
Each finest grid part owns its east/south boundary cells through a one-sample
neighbor halo. This closes tile seams while keeping every triangle in exactly
one authoritative partition.
Each prepared render tile also declares a complete immutable external-asset
set. The host verifies exact byte length and SHA-256 for position, index, UV
and orthophoto resources before a glTF asset graph can become resident; an
undeclared, missing, additional or modified dependency rejects the whole tile.
Dependencies from one inspected document are fetched as one parallel wave
through the kernel-resolved request semaphore; recursive documents open later
waves. Failure or aggregate-budget exhaustion aborts outstanding siblings.
The same optional content identity exists on lazy hierarchy pages, so very large
prepared trees can page descriptors without making unverified JSON authoritative.

The render core now also has a single content-addressed geometry-representation
admission boundary. It validates the complete canonical entity and selected
representation against the resolved `GeometryObject`, then binds an optional
evaluated mesh manifest to the same entity revision and `geometryRef`.
Evaluator ID/version/parameters, complete topology partitions, material keys
and open/closed semantics produce the manifest hash; callers do not supply a
loose `evaluatedMeshHash`. Current-slot publication is generation-checked while
exact older bindings remain immutable after replacement or retire. Large
partition bytes stay behind the provider loader. The contract and implemented
WASM wiring are specified in
`docs/GEOMETRY-REPRESENTATION-PROVIDER.md`. Complete canonical entity
envelopes, stable representation slots and generation-bearing registry
bindings now cross the viewer facade atomically. Content-addressed mesh
registration is staging only and cannot create visible authority without a
matching registry admission. Prepared dataset registration and representation
publication use a single WASM transaction with rollback on validation or
generation failure. A separate hashed preparation recipe is the evaluator
`parametersRef`; render and section manifests remain independently addressed
outputs.

The package-level `KernelViewerScene` is the stable lifecycle facade over this
boundary. Inline entities, Potree, prepared mesh/TIN and generic prepared
raster/splat hierarchies all return entity handles with common visibility and
unload semantics. Visibility is view state: hiding masks current and later
stream selections without releasing residency or rebuilding buffers, and
showing restores only the latest selected tiles. Unload is an exact canonical
retirement followed by complete dataset detachment: hierarchy sources,
contracts, residency tickets, lazy-page requests, host fetch/decode work and
pick metadata are released together. Dataset IDs therefore do not remain
accidentally registered after their entity leaves the viewer.

This remains foundation work rather than a parity declaration. Outstanding
gates include a checksum-pinned multi-encoder compressed-asset conformance
corpus, topology population for remaining non-triangle importers and a
remaining feature-level 3D Tiles metadata corpus, real-data streaming stress
and sustained native/mobile device benchmarks. The cross-tile section gate now
uses two checksum-pinned official Brandenburg DGM1 source tiles and the
production full-resolution topology writer. LAS/LAZ now populates the canonical representation registry and a
content-addressed Potree manifest; prepared DGMs now populate exact section
topology as well. Explicit and implicit 3D Tiles multiple contents are represented by
the common scheduler and share the kernel transaction boundary. Implicit
subtree tile/content property tables retain their referenced buffers and
address tightly packed rows by availability rank,
including sparse Morton layouts.

## Risks

- Codec implementations still need broad conformance assets from independent
  meshopt, Draco and KTX2 encoders, including every post-filter combination.
- 3D Tiles metadata conformance still needs a checksum-pinned corpus spanning
  additional independent exporters and externally referenced schemas. Official
  Cesium hierarchy-b3dm and per-point-pnts fixtures now cover exact legacy
  picks on both browser backends; hierarchy and subtree metadata,
  attribute/texture feature IDs, binary property-table rows, property
  attributes, property textures and multiple contents are retained, picked and
  residency-accounted.
- WebGL2 remains a tested downlevel feature floor; optional OIT is enabled only
  from queried format/blend capabilities.
- Global exact alpha ordering across independently streamed tiles is not
  representable by ordinary draw calls. Downlevel rendering therefore uses
  deterministic block/tile sorting; capable adapters use order-independent
  weighted blending.
- Exact caps across independently streamed tile boundaries require an
  authoritative cross-tile topology product. The renderer contract and
  version/material validation plus a sequential content-addressed snapshot
  registry exist; production importers still need to publish their immutable
  partitions into it.
- Cross-device golden thresholds for wide CAD lines, line types, screen/world
  text and vector hatching still need their own checksum-pinned real-data corpus; the
  DGM seam/section corpus is now independently pinned and passing.
