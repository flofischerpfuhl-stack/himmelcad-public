# ADR 0008: Separate feature graphs and measurable hybrid selection

## Status

Accepted.

## Context

PhotoLab combines ALIKED/LightGlue, SIFT/LightGlue, and DeDoDe-v2-G. Keypoint
indices from these methods have no shared meaning. Merging their SQLite tables
without a tested identity model would exchange observations or count duplicates
as additional evidence.

For licensing, trust, and hardware isolation, DeDoDe runs in a separate signed
offline worker. COLMAP remains responsible for camera models, epipolar
verification, track formation, and sparse reconstruction.

## Decision

- Each matcher owns a separate COLMAP database.
- DeDoDe keypoints are stably aggregated by
  `(CameraEntityId, workerFeatureId)`. Conflicting coordinates for the same
  feature fail the run.
- The bridge uses only COLMAP's public text formats and the `feature_importer`,
  `matches_importer`, and `geometric_verifier` CLI commands.
- The 128 imported descriptor values are deterministic sentinels. They never
  enter a descriptor matcher; only explicit DeDoDe pairs are imported and then
  geometrically verified.
- Hybrid mode runs global and incremental reconstruction for all three
  separately verified feature graphs.
- “All candidate pairs” means the pair graph frozen before execution, not every
  quadratic image combination by default. For ordered captures, Quality Hybrid
  uses a bidirectional 24-neighbor sequence graph, and ALIKED/LightGlue and SIFT
  process every edge independently. Only Maximum Robustness requires the full
  quadratic graph. Calibration groups must not reorder the capture sequence.
- Every successful reconstruction is converted to COLMAP's public text format
  with `model_converter`. Selection is deterministic by registered images,
  valid observations, 3D points, and then lower mean reprojection error. Only a
  complete tie uses user preference, Global Mapper, and a fixed store order.
- The selected model is copied to `sparse-selected/0`. All dense downstream
  products and the published sparse artifact use only this canonical path.
- Failed candidates remain in the command record. A requested DeDoDe run never
  silently falls back to ALIKED/SIFT only.

## Consequences

Methods are fused as a reconstruction-level ensemble without mixing
incompatible feature identities. Hybrid mode costs more time and memory but
cannot select a statistically weaker model merely because of an internal tie
break. Future track-level fusion requires a tested multi-descriptor track
builder and a new ADR.
