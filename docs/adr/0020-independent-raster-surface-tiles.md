# ADR 0020: Independent colour and elevation grids in prepared raster surfaces

- Status: Accepted and implemented
- Date: 2026-07-18
- Depends on: ADR 0016, ADR 0017 and ADR 0018

## Context

Civil orthomosaics and their supporting elevation models usually have different
ground sample distances. A two-centimetre orthomosaic may be draped over a
ten-centimetre DGM. The first prepared-raster contract required colour and
elevation to have identical dimensions and one pixel-centre mapping. That
either reduces the orthomosaic to the DGM resolution or duplicates interpolated
height values for every colour pixel. Both outcomes are unacceptable for large
datasets.

Independent 512-pixel raster tiles also cannot form a continuous surface when
each tile contains only its private sample centres. A cell crossing a tile
boundary needs the same two boundary support samples on both sides. Rendering
private 512-by-512 meshes at 512-sample offsets leaves the cross-partition cell
undefined.

## Decision

The prepared raster contract distinguishes two representations:

1. A co-registered image-depth tile retains canonical `RasterImageGeometry`
   semantics. Colour, depth, validity, confidence and connectivity address the
   same pixel grid. Camera depth images and an orthomosaic whose authored depth
   really is co-registered use this form.
2. A surface-drape tile is a prepared presentation derived from two independent
   canonical authorities: an orthographic image and a 2.5D elevation surface.
   It carries an immutable colour page with its own dimensions and pixel-centre
   mapping, plus an immutable support grid with independent dimensions,
   vertex-position mapping, elevation validity and connectivity.

The support grid is not mislabeled as an image depth field. Integer support
coordinates address mesh vertices. Its outer vertices coincide with the colour
page footprint boundary. Adjacent same-level surface tiles repeat their shared
boundary support row or column byte-exactly. Therefore every cell is owned by
one tile while both incident tiles agree on boundary geometry. No renderer
connects unrelated private sample centres or invents a tile-edge height.

Preparation may evaluate the source DGM at support vertices only through the
source surface's declared interpolation and connectivity. Its derivation binds
the exact image revision, elevation-surface revision, evaluator version,
parameters and output hashes. NoData and disconnected source regions remain
disconnected. The prepared grid is rebuildable presentation data; it does not
replace either canonical entity.

The colour and support pyramids choose levels independently. A display tile may
therefore retain a 512-by-512 colour page while using a materially smaller
support grid at the DGM's useful density. Refinement must never lower colour
resolution merely because the DGM has reached its finest geometric level, and
must never manufacture additional geometric detail merely because finer colour
pages exist.

Both payload families remain ordinary globally budgeted tile contents. Fetch,
decode, GPU upload, publication, eviction and cancellation are transactional
for the combined tile. The texture byte cost uses colour dimensions; vertex,
index and exact pick costs use support dimensions.

## Picking and measurement

Surface-drape picking resolves the exact prepared support triangle and reports
source/project XYZ before presentation exaggeration. The result also retains
the bound elevation-surface revision and derivation identity so a writing CAD
command can revalidate against the canonical DGM. Colour pixel coordinates are
presentation metadata and never become height authority.

Co-registered image-depth measurement remains pixel-addressed by the canonical
image. The two paths are explicit and cannot silently substitute for each
other.

## Validation

- Colour and support dimensions are positive and independently bounded.
- Both affine grids are finite and non-degenerate.
- A surface-drape image is orthographic and has no attached canonical depth.
- Its support topology is an elevation-Z surface; alpha is not elevation
  validity.
- The support footprint covers the colour footprint, and shared prepared tile
  edges are hash- or sample-verified by the producer.
- Every immutable payload hash and exact byte length is checked before worker
  decode and again before transactional publication.
- Schema-v1 co-registered tiles remain readable during migration. Producers
  publish the new surface-drape form only with schema version 2; unknown fields
  or versions fail closed.

## Consequences

The render mesh and texture no longer need equal dimensions. GPU upload and
residency accounting must carry both. Existing co-registered panorama/depth and
raster tests remain valid, while new tests cover mismatched GSD, shared edges,
NoData at partitions, source-coordinate picking and complete combined eviction.

Provider preparation performs the bounded resampling work before publication.
The animation frame and browser main thread never resample a whole raster or
walk a complete DGM.
