# Himmelcad Project Format

## Formats

Himmelcad uses two equivalent formats:

- `.hcad/` — folder-based working project.
- `.hcadx` — zipped portable bundle of the same structure.

The folder format is canonical during editing because it supports streaming,
incremental writes, crash recovery, and future Git-like workflows. The bundle
format is for sharing, archiving, upload, and Weltview publishing.

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
- future Chronogit semantic diffs.

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

For Weltview, a `.hcadx` can be:

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

## Git/Chronogit Readiness

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
