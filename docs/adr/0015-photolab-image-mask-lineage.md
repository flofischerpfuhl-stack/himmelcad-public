# ADR 0015: PhotoLab image-mask revisions and compute lineage

## Status

Accepted

## Context

Survey images can contain moving objects, propellers, aircraft parts, sky, reflections or other
pixels that must not contribute features or dense matching. A mutable bitmap beside the source
file would break project recovery, processing-set isolation and reproducible resume. A display-only
`masked` tag would also allow the UI to claim masking without any pixels being excluded.

## Decision

- A mask is defined in original source-image pixel coordinates. Set bits mean excluded pixels.
- Every brush add/remove, clear or restore produces an immutable revision with a parent hash. The
  revision pins source pixels, source metadata, dimensions, vector edit, packed raster hash and
  excluded-pixel count.
- `manifest.imageMaskCatalogHash` selects at most one current revision for each existing camera.
  Catalog, camera metadata/tag and journal publication are one atomic command. Camera removal
  prunes its entry in the same transaction.
- Empty masks have no raster object and no `masked` tag. The tag is never accepted during image
  import and is never authoritative by itself.
- Alignment and MVS freeze exact sorted camera membership, optional processing-set membership and
  all non-empty revision/raster hashes into one canonical mask-scope hash.
- COLMAP and DeDoDe consume original-resolution keep masks. DeDoDe results are filtered again in
  Rust before publication. Portable MVS transforms masks through the original Brown-Conrady camera
  into each undistorted scene image, then rejects any reference or source patch touching an
  excluded pixel.
- Feature caches, job input hashes, batch checkpoints, alignment artifacts, MVS scene manifests
  and depth-map reuse include the exact scope hash. Editing an in-scope mask requires realignment
  before a downstream depth product; editing a camera outside the processing set does not.
- Workers receive immutable scope snapshots and write only scratch data. Cancellation before the
  journal/manifest boundary publishes neither a revision nor a product. Unreferenced objects are
  safe content-store garbage for later collection.
- The representation and workers use project code plus permissively licensed image/runtime
  dependencies already present in the Linux and Windows release inventories.

## Consequences

Mask edits survive autosave, reopen and crash recovery and can be restored without overwriting old
objects. Alignment and dense products can be audited against the exact pixels excluded at compute
time. Conservative patch exclusion can reduce coverage along mask borders, but cannot silently
reintroduce excluded observations. Changing a meaningful mask intentionally invalidates affected
compute caches rather than relabeling old results as current.
