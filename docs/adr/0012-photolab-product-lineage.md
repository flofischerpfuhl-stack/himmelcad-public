# ADR 0012: Explicit PhotoLab product lineage

## Status

Accepted.

## Context

A PhotoLab project may contain multiple alignments with different immutable
camera sets. Selecting the lexicographically latest intermediate globally can
silently mix depth maps, point clouds, rasters, or meshes from different
flights.

## Decision

- A selected optional `ProcessingSet` is read from the object store before a
  product starts, verified by its membership hash, and checked against existing
  camera entities.
- The source alignment is only the newest published sparse alignment whose
  sorted camera set exactly matches the frozen set.
- Product-only batches use their exact batch camera set. An empty batch
  selection explicitly means all currently imported cameras, not an arbitrary
  latest alignment.
- New MVS, Gaussian-splat, raster, and mesh records store
  `sourceAlignmentEntityId` plus optional `processingSetId` and validate both
  before atomic publication.
- Dense point clouds, DEMs, orthomosaics, and textures are accepted as
  dependencies only when both lineage fields match the current run. Older
  records without lineage remain viewable and exportable but are never silent
  inputs to new computation.
- Lineage participates in job-input hashes and therefore batch and recovery
  identity.
- Separate flights are not merged through a global scope or latest-run rule.
  Under ADR 0014, a shared product references an atomically published
  `MergedAlignmentRun` that records input alignments, GCP optimizations, and
  connection evidence. A planned merge is not a product source.

## Consequences

A newer run from another processing set cannot affect an existing product
graph. Missing compatible intermediates fail preparation with a concrete
recompute action. This is intentionally stricter than a global automatic
fallback.
