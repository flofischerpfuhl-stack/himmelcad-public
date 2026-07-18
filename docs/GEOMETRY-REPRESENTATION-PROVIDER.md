# Geometry representation provider boundary

Status: kernel contract and transactional WASM/viewer wiring implemented.

`GeometryRepresentationRegistry` is the project/import admission boundary
between canonical entities and renderable or sectionable geometry. A publish is
accepted only when all of these values agree:

- the complete `CanonicalEntity` and its checked `versionHash`;
- one selected `Representation` that is actually present in the entity;
- the resolved `GeometryObject` whose computed hash equals `geometryRef`;
- an explicit stable `representationSlot` supplied by the project/provider;
- optionally, one evaluated mesh manifest bound to that same entity ID,
  entity version and source `geometryRef`.

The slot ID is necessary because ADR 0016 currently gives representations a
role but no stable per-representation ID. The registry does not guess identity
from role or array position.

## Evaluated meshes and sections

`EvaluatedMeshRepresentation::new` computes its topology content address from
the source geometry address, evaluator ID/version/parameters, complete sorted
partition descriptors, material keys, closed/open assertion and exact topology
snapshot key. There is no separately supplied `evaluatedMeshHash` that can
drift away from those inputs.

The registry retains descriptors, not large triangle arrays. During an exact
section, `GeometryRepresentationProvider::load_evaluated_mesh_part` resolves
one content-addressed partition at a time. The existing
`AuthoritativeSectionTopologyStore` checks every loaded partition hash and
constructs the cross-partition result. Renderer-resident tiles never become
section authority.

Exact clipping-volume caps consume this same section authority, not a second
mesh-extraction path. The host keys each asynchronous cap evaluation by current
binding generation, entity/topology revision, clip plane and tolerance, aborts
superseded work and atomically replaces one stable derived section only after
the complete product is validated. Render-tile LOD changes therefore neither
invalidate nor recompute a cap.

Open resource-backed TINs use the same contract. Their immutable partition
manifest declares f32/f64 local positions and an f64 origin in the
representation source frame,
u16/u32 triangle indices, exact counts and SHA-256-bound resources. The
incremental evaluator retains only intersection segments; closed snapshots
then construct cap regions, while open snapshots finish as exact profile traces
with empty regions. `CanonicalEntity.placement` is applied partitions-at-a-time
in f64 before project-space bounds rejection and plane intersection; source
topology bytes remain immutable. The DGM tiler lists only non-overlapping finest tiles as
section authority and keeps the coarse render root out of that list.

The same admission is no longer TIN-specific. Resource-backed `surface3d`,
open elevation TIN and closed-mesh solid representations share one prepared
triangle-mesh path. Every dataset carries three distinct immutable resources:
the render hierarchy, bounded section-topology index and a versioned
preparation recipe describing source identity, adapter/partition/LOD versions,
budgets, precision and manifold validation. `parametersRef` addresses that
recipe; topology transport paths are not misrepresented as algorithm inputs.

Publishing/replacing is generation-checked per stable entity/representation
slot, independently of the immutable revision key. `prepare_atomic` validates a
complete touched-entity overlay without mutation; `commit_atomic` rechecks the
observed slot state before publishing any entity. A new revision therefore
cannot expose a mixture of old and new representation slots. Omitted slots are
retired in the same commit.

`expectedGeneration: null` is accepted only for a slot that has never existed.
`remove` and `clear` publish a new generation-bearing tombstone, and a later
reinsert must compare against that tombstone before receiving the next
generation. This prevents ABA generation reuse. Older non-identical entity
revisions, mismatched topology revisions, stale prepared overlays and failed
multi-entity candidates are rejected before current state changes. Exact older
bindings remain addressable by immutable key after replacement or removal.

Slot state is indexed by entity, so prepare/commit inspect only touched slots,
not the whole project registry. Canonical `GeometryObject` values are retained
once per content hash and shared by bindings through `Arc`; immutable binding
history and the geometry catalog have an explicit future garbage-collection
boundary rather than being coupled to renderer residency.

## WASM integration

The WASM kernel owns one registry beside its mesh-resource and section state.
The live integration is:

1. immutable mesh bytes are staged under their verified canonical content
   hash; staging alone creates no entity, representation or render authority;
2. `publish_canonical_representations_json` prepares the complete touched
   entity envelope and every selected slot through the registry, then compiles
   GPU consumers against a private render-world overlay;
3. evaluated meshes are accepted only when the inline mesh or streamed dataset
   resource, source `geometryRef`, recipe, topology manifest, material keys and
   canonical entity revision agree;
4. registry commit and render-world commit are generation-checked and atomic;
   failed preparation exposes neither bindings nor proxies;
5. section requests use immutable evaluated topology products/registries, not
   whatever GPU tiles happen to be resident;
6. replacement and retirement carry exact registry keys and generations, so
   stale browser messages cannot detach or overwrite a newer revision.

For prepared streamed meshes,
`register_prepared_dataset_and_publish_canonical_json` parses the hierarchy and
dataset contract, validates the evaluated topology/material snapshot and
publishes dataset plus canonical binding as one transaction. Any validation,
generation or commit failure removes the staged dataset contract, so an orphan
registration cannot survive a failed publication.

## Provider-neutral prepared triangle meshes

`prepared_triangle_mesh` separates fast display from exact Civil operations.
It builds spatial f32 render nodes from a bounded disk spool, while every source
triangle is written once to a finest authoritative partition using absolute f64
positions in the representation source frame and a shared zero origin. Partition boundaries therefore cannot
quantize one shared source vertex differently. Internal display nodes use an
adaptive vertex-cluster proxy: all unique clustered triangles are retained at
one resolution, and the spool is rescanned more coarsely instead of sampling
holes when the budget is exceeded. Collapsed isolated detail retains one source
triangle per occupied cell. Tile bounds conservatively cover the complete
source node plus the decoded f32 proxy, and geometric error records the chosen
cell scale (or the full node span when source triangles collapsed). A shared
tile vertex payload is indexed by deterministic per-material glTF primitives
whose `hcadMaterialSlot` matches the authoritative section slot; render styling
and section hatching therefore do not invent separate material identities. A
disk-backed external edge sort validates every undirected edge twice with
opposite orientation before a source may assert `closedManifold`.

Small prepared hierarchies remain one manifest. Above 512 tiles the producer
keeps only the root descriptor inline and writes bounded descendant pages. Each
page contains at most eight binary descendant levels (510 descriptors), carries
the exact parent owner and roots required by the provider transaction, and is
bound by SHA-256 plus an exact byte range. Nested page identities are written
bottom-up, so the root manifest transitively commits to the complete hierarchy
without requiring it all in browser or WASM memory.

The bounded PLY adapter supports ASCII and binary-little-endian payloads,
property reordering and unknown scalar/list properties. Vertices are spooled as
f64, faces remain streamed and random vertex access uses a fixed block cache.
Invalid indices, non-triangle lists, non-finite coordinates, truncation, excess
lists and trailing payload fail before publication. Both COLMAP mesh products
use this path. The textured-directory adapter validates the official
`mesh.ply`/`texture.png` contract, accepts default binary-little-endian or ASCII
face-corner `texcoord` lists, and retains all six UV floats per triangle in the
disk spool; untextured records omit that optional six-float body. Every render
tile emits a hash-bound f32 UV buffer and references
the immutable PNG atlas through its ordinary glTF asset graph. The original PLY
or textured directory remains the export source while the prepared hierarchy
becomes the viewer dataset. See the upstream
[COLMAP output format](https://colmap.github.io/format.html).
Prepared vertex buffers stay in CAD-local Z-up coordinates. Their glTF mesh
node carries the inverse Y-up basis, which cancels the common standards-defined
glTF Y-up-to-project-Z-up decode transform without changing legacy buffers,
bounds or authoritative f64 topology.
Project dataset listing now exposes the complete ADR-0016 admission alongside
that prepared product: a content-addressed dataset ID, provider ID/version,
canonical `Surface3D` (or `Object3D` for a proven closed manifold), resource-
backed geometry, selected representation and the hashed component, attribute
and relation objects. A consumer can therefore call the shared atomic mesh
admission directly instead of reconstructing an entity shape from legacy
`EntityKind` metadata.

The atlas is immutable source content, not authority for topology. Runtime
texture transcode, mip residency and a later virtual/tiled atlas implementation
stay behind the glTF/resource boundary; they do not require another entity,
dataset or section representation.

For streamed Civil TINs, `begin_authoritative_section_evaluation` binds an
operation to the exact current registry generation. Partition manifests and
their binary resources are hash/length checked before f64 reconstruction. The
version-2 Civil topology index carries conservative representation-source
bounds built from the exact quantized coordinates that the decoder reconstructs.
The kernel applies the current canonical entity placement to all eight AABB
corners before it can prove a partition disjoint and advance without fetching its
manifest or triangle buffers; intersecting or unbounded partitions still take
the exact path. `finish` is rejected until every sorted partition was either
proven disjoint or evaluated, and cancellation releases the accumulated
segments. This permits exact cuts over non-resident tile boundaries without
ever assembling the complete DGM in WASM memory.

`register_mesh_resource` remains a content-addressed staging operation because
the complete representation admission needs to inspect the evaluated payload
before atomic publication. It is not a loose publication path: only a matching
registry admission can turn the staged bytes into visible geometry. GPU caches
remain disposable consumers, while canonical entities and the provider
registry remain authoritative.

## Prepared point-cloud imports

The production LAS/LAZ importer now crosses this boundary without inventing a
second entity shape. PotreeConverter writes into an unpublished temporary
directory. The importer then hashes `metadata.json`, `hierarchy.bin` and
`octree.bin` with bounded memory, serializes one deterministic
`hcad.dataset.json` root and publishes the directory under that manifest's
SHA-256. Semantic `entityId` and immutable `datasetId` are deliberately
separate, so two imports may be independent entities while sharing identical
prepared bytes.

`LasImportSummary` carries the complete validated
`CanonicalRepresentationAdmission`, plus the small immutable component,
attribute and relation JSON objects referenced by the entity. Its point-cloud
geometry addresses the exact raw `metadata.json` bytes. This is the same hash
computed by `register_potree_dataset`, so a modified cache response fails
before registry publication.

The browser `admitCanonicalPotreeDataset` path fetches metadata and the bounded
first hierarchy range through the streaming driver's live request semaphore,
verifies metadata byte length and SHA-256, registers the provider and publishes
the imported entity through the ordinary canonical registry transaction. It
does not deserialize points or serialize visible tile keys on the host.

Conversion, dataset hashing and duplicate verification share one cooperative
operation token. Cancellation kills the converter, stops between bounded hash
blocks and drops the unpublished directory. The sidecar exposes
`import.las.cancel`; operation IDs are removed on every success, error or
cancelled exit, so a later import cannot inherit a stale cancellation flag.
