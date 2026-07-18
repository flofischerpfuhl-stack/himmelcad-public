# HimmelCAD Project Format

## Formats

HimmelCAD uses two equivalent formats:

- `.hcad/` - folder-based working project.
- `.hcadx` - zipped portable bundle of the same structure.

The folder format is canonical during editing because it supports streaming,
incremental writes, crash recovery, and future Git-like workflows. The bundle
format is for sharing, archiving, upload, and WeltView publishing.

## Folder Layout

```text
project-name.hcad/
  manifest.json
  project.lock
  objects/
    ab/
      cdef...
  journal/
    0000000000000001.json
    0000000000000002.json
  canonical/
    store.lock
    journal/
      0000000000000001.json
    datasets/
      <sha256-of-dataset-id>.json
    imports/
      <sha256-of-command-id>.json
  .photolab/
    jobs/
      records/
        <job-id-sha256>.json
  index/
    pointcloud/
    spatial/
  previews/
  tmp/
```

## `manifest.json`

The manifest is the active project snapshot.

It contains:

- format version,
- project ID,
- project name,
- created/modified metadata,
- active root entity,
- entity tree refs,
- object refs,
- render offset,
- view states,
- panel layout state,
- optional import metadata.

It does not contain large geometry directly.

Writes must be atomic:

1. write `manifest.json.tmp`,
2. fsync,
3. rename over `manifest.json`.

## Object Store

Objects are content-addressed by SHA-256.

```text
objects/<first-two-hex>/<remaining-hex>
```

Object examples:

- entity snapshots,
- attribute blobs,
- style blobs,
- point-cloud tile blobs,
- selection masks,
- mesh tiles,
- texture tiles,
- orthophoto/raster tiles,
- panorama/depth panorama tiles,
- splat tiles,
- command result payloads.

Rules:

- object content is immutable,
- identical content produces the same hash,
- new writes never mutate existing objects,
- garbage collection removes unreferenced objects only when requested.

## Journal

The journal is append-only and stores command entries.

```text
journal/
  0000000000000001.json
  0000000000000002.json
  ...
```

Each entry records:

- command ID,
- command kind,
- actor,
- timestamp,
- payload,
- affected entities,
- before/after object refs,
- success/failure state,
- optional progress summary.

The journal enables:

- undo/redo,
- crash recovery,
- command replay,
- future ChronoGit semantic diffs.

### Canonical kernel journal and import inventories

During the ADR 0016/0019 authority transition, canonical entity commands use
the isolated `canonical/journal/` sequence rather than the legacy project
journal. `canonical/datasets/` stores hash-framed prepared-dataset inventories;
`canonical/imports/` stores one hash-framed provider inventory per import
command. An import inventory retains provider/version identity, representation
admissions, every immutable stored object descriptor, dataset descriptors and
the additively optional `resourceSets` list.

A resource set is a provider-neutral, atomically stageable inventory for
non-streamed binary `GeometryResource` payloads. Each entry records a safe path
relative to its host-supplied source root and the exact SHA-256, positive byte
length and media type. Typical payloads are raster or panorama pixels, depth,
validity, confidence and connectivity bands, material/texture resources and
fonts. Point-cloud, Gaussian-splat and tiled-dataset root metadata remains in
`datasets`; a resource set is not a second streaming manifest.

Publication uses `tmp/canonical-transactions/<command-hash>/`. Immutable
objects and inventories are staged and synchronized before `ready.json`. Once
that marker exists, reopen must finish publishing every object and inventory
before linking the canonical journal record last. A pre-ready failure is
discardable; a ready transaction is completed or rejected as corruption, never
silently exposed in part.

Resource-set rules:

- relative paths cannot be absolute, contain parent traversal, or resolve
  outside the canonical source root;
- a descriptor matches only when hash, byte length and media type all match;
- identical descriptors may deduplicate to one object even across resource
  sets;
- every resource-set payload must be referenced by admitted canonical geometry;
- every required non-streamed binary geometry resource must be declared by a
  resource set or an exact dataset artifact;
- omitting `resourceSets` remains readable as an empty list for older packages.

## PhotoLab Processing History

`.photolab/jobs/records/<job-id-sha256>.json` files form the project-scoped
processing ledger used by the Jobs panel and HTML/PDF processing reports. Each
record contains job kind, immutable configuration/input hashes, timestamps,
final state, progress, and the latest committed checkpoint sequence. Lifecycle
snapshots are replaced atomically per job, so progress persistence stays O(1)
with respect to historical job count and never restores or rewrites
`manifest.json`.

Queued or running records left by a stopped sidecar are marked as interrupted
when the project is reopened. A committed checkpoint is retained and reported
as recoverable; an interrupted record is never reported as completed. The
ledger is part of `.hcadx` archives and is never shared between projects.

PhotoLab image-quality measurements are derived records, not mutable image tags. The optional
`manifest.imageQualityCatalogHash` references one immutable content-store catalog. Each catalog
entry is keyed by image entity and optional processing set and records the source pixel object,
source metadata object, algorithm version, frozen configuration hash, sample dimensions, job,
timestamp, scope membership hash and either measured metrics or an explicit decode failure. A
completed quality job replaces only its own scope entries and publishes the new catalog through a
committed journal entry plus atomic manifest replacement. Cancellation therefore leaves the
previous catalog untouched and cannot expose a partial set of measurements.

PhotoLab exclusion masks follow the same immutable publication rule. The optional
`manifest.imageMaskCatalogHash` selects one current mask revision per camera image. A revision
pins the source-pixel and source-metadata hashes, original dimensions, parent revision, vector
edit, packed binary raster object and exact excluded-pixel count. Empty revisions do not retain a
raster object and remove the image's `masked` tag. Brush, clear and restore operations write
objects first, then one committed journal command and an atomic manifest replacement. Removing a
camera prunes its catalog entry in that same removal transaction.

Alignment and MVS requests freeze a sorted camera/processing-set mask scope and its canonical
hash. Only non-empty masks are materialized into scratch workspaces. Published alignment and MVS
records retain that scope hash, cache/checkpoint reuse requires an exact match, and a mask change
therefore makes downstream depth processing require a new alignment. Cancellation may leave
unreferenced content-addressed objects, but can never expose a mask revision or product partially.

The processing-report exporter combines this ledger only with published project records:
processing/capture/calibration scopes, alignment and merge lineage, GCP optimization artifacts,
and product entity versions. It reports control and checkpoint residuals separately and preserves
configuration, input, artifact, snapshot and entity hashes where the corresponding record exposes
them. Missing historical information is shown as unavailable rather than inferred. In particular,
the hardware block is explicitly the workstation probe at export time because schema version 1 job
records do not claim a historical machine profile.

HTML reports are self-contained and network-inert. PDF uses Electron's isolated Chromium
`printToPDF` path with JavaScript disabled. Both formats are written through a same-directory
temporary file and renamed only after complete generation, so a failed export does not publish a
partial report.

## Index Directory

`index/` contains rebuildable caches.

Examples:

- tile lookup tables,
- spatial indexes,
- search indexes,
- preview caches,
- renderer-friendly metadata.

Indexes are never canonical. If deleted, they must be rebuildable from manifest,
journal, and objects.

## Temporary Directory

`tmp/` is used during imports and exports.

Rules:

- temp files never become canonical until a command commits,
- interrupted imports can be cleaned up,
- manifest must never point to a temp path.

## Point-Cloud Storage

MVP point-cloud object structure:

```text
PointCloudSourceObject
  original_file_name
  original_file_hash
  bounds
  point_count
  imported_attributes
  tile_index_ref

PointCloudTileIndexObject
  tile_schema
  root_bounds
  tile_refs[]

PointCloudTileObject
  tile_bounds
  point_count
  position_encoding
  attributes
```

Positions:

- source and bounds in `f64`,
- render tile positions in `f32` relative to tile origin,
- tile origin stored in `f64`.

## Heavy Geometry Storage Direction

All large renderable data follows the same storage philosophy:

- source/canonical metadata is immutable and content-addressed,
- runtime tiles are precomputed at import/preprocess time,
- indexes are rebuildable caches unless explicitly referenced as objects,
- render buffers use local offsets and GPU-friendly formats,
- source coordinates and semantic metadata preserve `f64` precision.

Planned tile families:

- point-cloud octrees,
- mesh/surface tiles with triangle BVH sidecars,
- tiled texture pyramids,
- orthophoto/raster pyramids,
- panorama/depth panorama tiles,
- Gaussian splat trees.

The exact mesh/texture/splat formats are chosen by ADR before implementation.

## Segment Storage

Segmentations store filters/masks, not duplicated points.

```text
SelectionMaskObject
  source_entity
  tile_masks[]
  selected_point_count
  created_by_command
```

Derived segment entities reference the mask:

- extracted: include mask,
- remaining: inverse mask.

## `.hcadx` Bundle

`.hcadx` is a zip archive with the same logical layout.

Recommended bundle contents:

- `manifest.json`,
- `objects/`,
- `journal/`,
- `previews/`.

Optional:

- `index/` may be omitted because it is rebuildable.

Desktop archive operations use one caller-visible `archiveOperationId` from the
renderer through Electron to the sidecar. Packing and extraction report their
current phase, uncompressed byte counts, file counts and current relative path.
The displayed overall fraction is monotonic across phase boundaries; the raw
phase counters remain available so the UI never invents work estimates.

Cancellation is cooperative during source scanning and streaming I/O. A pack
writes only to a sibling candidate and publishes by atomic replacement after a
final cancellation check. An open extracts to a staging workspace and renames
it only after complete validation. Cancelling or failing either operation
removes its candidate/staging data and preserves the existing archive and
recoverable local working copy.

For WeltView, a `.hcadx` can be:

- downloaded entirely,
- streamed by range request if server supports it,
- unpacked server-side into a static object layout.

## Compatibility and Migration

Every project has:

- `format_version`,
- per-entity `schema_version`,
- per-object type tags.

Migration rules:

- old projects should open read-only before destructive migration,
- migration writes a new command entry,
- original objects remain until garbage collection,
- migration must be tested with fixture projects.

## Git/ChronoGit Readiness

The folder format is intentionally Git-friendly for semantic metadata:

- manifest and journal are small text files,
- objects are immutable by hash,
- large blobs can be moved to LFS or external object store,
- semantic diffs can be computed from journal and entity refs.

Raw point-cloud tiles are not expected to line-diff well. The diff layer should
compare metadata, masks, derivations, and statistics instead.

## Safety Rules

- never write directly into `objects/` without verifying content hash,
- never mutate existing object files,
- never trust `index/`,
- never make manifest point to missing objects,
- never silently transform coordinates during import,
- never store user-visible state only in renderer memory if it should survive
  project reopen.
