# ADR 0009: GCP measurement and robust georeferencing

## Status

Accepted.

The GCP, snapshot, role, residual, lineage, and publication architecture below
is binding. Camera-intrinsics defaults and releasable parameters are governed
by `docs/photolab-intrinsics-policy.md`; the old blanket fixed-intrinsics rule
is not a product requirement.

## Context

PhotoLab must process GCPs with XYZ, XY, and Z masks, independently evaluated
checkpoints, and reproducible residuals. The path must run offline on Windows
and Linux without a copyleft solver or a platform-specific solver dependency.

Sparse reconstruction already performs bundle adjustment. GCP processing must
place the free reconstruction in project world space and refine selected camera
poses with image observations without using checkpoints as survey priors.

## Decision

- Image observations are triangulated from calibrated camera rays with linear
  multi-ray least squares.
- Controls initialize a robust seven-parameter similarity transform. A weighted
  robust bundle adjustment then refines selected camera extrinsics, GCP
  intersections, and a deterministic subset of at most 50,000 COLMAP tie
  points. Huber and Cauchy estimators are available for image and survey
  residuals.
- Blockwise small normal equations keep memory linear in the bounded number of
  observations; no global dense normal matrix is formed.
- The first selected camera pose and the second selected camera center fix pose
  and scale gauge. Unselected cameras remain unchanged. Each calibration group
  freezes which intrinsics are fixed, prior-constrained, or free.
- Only components enabled by a point's role enter the equations with their
  uncertainty. With fewer than three spatial controls, Auto optimizes only
  observable translation components. An explicitly requested seven-parameter
  solve is rejected.
- Checkpoint image observations participate in reprojection geometry, but their
  survey coordinates never create a prior.
- Camera references are opt-in and all are unselected by default. Only selected
  cameras create position priors from coordinates already projected into
  project world space and from uncertainties frozen during import. Missing
  uncertainty uses documented conservative defaults.
- Residuals are stored per point as East, North, Height, Horizontal, 3D, and
  image RMS and aggregated separately for controls and checkpoints. Every view
  remains bound to the immutable GCP snapshot.
- A manual GCP observation may snap to a verified feature track. Other track
  observations become automatic proposals and never overwrite manual input.
- The sidecar writes atomic checkpoints by phase and iteration. Cancellation is
  checked in point, iteration, and projection loops. Content-addressed result
  objects publish only after complete calculation.
- Every result records source-alignment and optional processing-set IDs. MVS,
  depth maps, orthorectification, and downstream products may consume only
  matching lineage and use optimized camera extrinsics directly; the initial
  similarity is not a substitute for bundle-adjusted poses.

## UX contract

- Blue: predicted projection only; excluded from optimization.
- Green: manually confirmed image observation.
- Orange: automatic observation propagated through a verified tie point.
- Muted: deliberately locked observation.

## Consequences

The GCP path needs no additional runtime library and behaves consistently
across CPU, GPU, and operating system. Results publish refined cameras and
sparse tie points alongside similarity, residuals, and projections. Solver
provenance includes the frozen intrinsics policy. The former
`himmelcad-weighted-robust-bundle-adjustment-v2-fixed-intrinsics` label denotes
only its legacy mode. Incompatible lineage is never reused silently. A future
Schur or GPU solver may preserve the same snapshot, gauge, role, residual,
lineage, and publication contract.
