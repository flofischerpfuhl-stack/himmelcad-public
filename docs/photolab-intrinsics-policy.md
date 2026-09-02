# PhotoLab intrinsics refinement policy

Status: current implementation policy, decided from research and Golden-dataset
evidence on 2026-07-19.

## Decision

PhotoLab refines camera intrinsics per explicit, immutable calibration group. It
does not trust DJI, smartphone, EXIF or XMP values merely because they exist,
and it does not estimate a separate high-dimensional model for every image.

`Auto` is the product default. It starts with the smallest model supported by
the source and only admits additional parameters when the calibration group's
normal equations show that those parameters are observable. The ordinary
Brown/Metashape-compatible target set is:

- focal length `f` (one shared scale for square pixels),
- principal point `cx`, `cy`,
- radial distortion `k1`, `k2`, `k3`,
- decentring/tangential distortion `p1`, `p2`.

This is the eight-parameter set described in the local bachelor thesis and
used by Metashape's default optimization. Affinity/skew `b1`, `b2` and radial
`k4` are advanced parameters. They remain fixed unless a sufficiently strong
group, residual pattern and held-out improvement justify them. Fisheye lenses
use a fisheye projection model rather than forcing more Brown coefficients.

The UI exposes four policies per calibration group:

1. `Auto` — staged model selection with observability and validation gates.
2. `Prior` — refine a selected parameter mask with explicit prior covariance.
3. `Fixed` — preserve a verified laboratory/embedded calibration.
4. `Custom` — expert parameter mask, still subject to singularity and bounds
   diagnostics.

An embedded calibration is only treated as `Fixed` when its provenance says it
is a real calibration for the same physical camera/lens/focus/resolution state.
An EXIF focal length or DJI nominal model is an initialization with a prior,
not fixed truth. Autofocus/zoom/focus-distance changes split calibration groups
unless a reviewed image-variant model is selected.

## Auto stages

Auto performs deterministic nested fits and retains a stage only when all
gates pass:

1. `f + k1` for unknown ordinary lenses; use the source's simpler fixed model
   when images are already geometrically corrected.
2. add `k2`, then `cx + cy` when image coverage and ray geometry support them.
3. add `p1 + p2` only for a spatially coherent asymmetric residual field.
4. add `k3` only when observations reach the outer image radius and held-out
   residuals improve.
5. `k4`, `b1`, `b2`, rolling-shutter timing or image-variant parameters require
   an explicit advanced model and stronger data.

Each proposed stage must satisfy:

- enough shared observations and cameras in the group;
- image-plane radial and quadrant coverage;
- non-critical camera motion and adequate depth/baseline diversity;
- a well-conditioned reduced normal matrix after gauge removal;
- finite parameters inside physical bounds;
- materially better robust held-out reprojection error, not merely lower
  training residual;
- stable estimates under deterministic observation resampling;
- no regression of GCP/checkpoint residuals beyond the configured tolerance.

If a stage fails, Auto returns the last stable stage with a named diagnostic;
it never silently accepts a degenerate calibration. The report stores the
candidate masks, condition diagnostics, priors, rejected reasons, before/after
residual maps and exact frozen group membership.

## Capture-specific behavior

- Fixed-focus calibrated survey cameras: use a strong prior or Fixed only when
  calibration provenance and capture state match; otherwise Auto.
- Consumer drones: nominal DJI metadata seeds `f` and grouping, while Auto
  refines observable parameters. Rolling-shutter cameras are flagged from the
  shutter/capture profile rather than absorbed into lens distortion.
- Smartphones/system cameras: partition by physical camera, resolution,
  crop/binning, focal/zoom state and focus evidence. Prefer shared intrinsics
  within each group. Use the simplest viable radial model for small or weak
  groups and enable a rolling-shutter model for moving captures when supported.
- Internet/unknown photos: begin with the simple radial family. Do not use a
  full per-image Brown model without strong shared evidence.

## Alignment and merge execution

COLMAP's mapper exposes bundle-adjustment refinement as run-wide flags, not as a per-camera mask,
so the per-group policy is mapped onto exactly three run strategies. A group counts as pinned when
it carries a complete embedded calibration, or when its explicit policy is `Fixed` and it has a
laboratory calibration to preserve. `Auto`, `Prior` and `Custom` refine: COLMAP cannot honour a
partial parameter mask, and the in-house GCP adjustment applies the exact mask afterwards.

- `allFixed` — every group is pinned. The mapper runs with focal, principal point and distortion
  refinement disabled.
- `allRefine` — no group is pinned. The mapper runs with COLMAP's focal and distortion refinement.
- `mixed` — the groups disagree. The mapper refines every seeded group, the pinned groups are then
  restored to their exact seeds by rewriting `cameras.txt`, and COLMAP's standalone
  `bundle_adjuster` re-optimizes poses and points with all three refine flags disabled. The run
  fails when that re-adjustment loses a registered image or more than ten percent of the 3D points,
  because a pinned calibration that cannot explain the block is a review finding, not a product.

A run whose groups disagree previously froze every group's intrinsics as soon as one group carried
embedded calibration, which silently froze a metadata-poor mission's default intrinsics in an
overlap merge. An overlap merge additionally seeds each group from the intrinsics its own input
alignment solved, instead of restarting the joint solve from COLMAP defaults.

Every alignment and merge record freezes the strategy that ran, the pinned group ids, the
re-adjustment path and evidence, and the per-group seed and solved focal lengths.

## Optimize-adjustment parameters beyond intrinsics

The adjustment policy treats the following as separate, visible parameter
families with their own priors and observability diagnostics:

- camera rotations and centres;
- 3D tie points and GCP/checkpoint role masks;
- one similarity/project transform with an explicit gauge;
- GNSS/RTK camera-centre covariance, optional orientation priors, lever arm and
  boresight;
- rolling-shutter readout and continuous/interpolated camera motion;
- time offset for synchronized GNSS/IMU sources;
- per-image focal/focus variation only when the capture requires it;
- robust loss, outlier state and observation covariance.

Checkpoints remain evaluation-only. GCP uncertainty and image measurement
uncertainty are covariance inputs, not interchangeable weights. Every published
run freezes the exact observations, calibration groups, priors, parameter masks
and solver version.

## Evidence

- The local thesis, `photolab/Bachelorarbeit Florian Fischer - Titelblätter
Ausgebessert.pdf`, section 2.3.4 and page 12, describes Metashape's eleven
  Brown-style parameters and notes that the default omits `b1`, `b2` and `k4`;
  section 2.3.8 describes joint bundle adjustment. This supports the ordinary
  eight-parameter target, but not blindly enabling all eight on weak data.
- The current [Agisoft Metashape 2.3 manual](https://www.agisoft.com/pdf/metashape-pro_2_3_en.pdf)
  distinguishes initial, fixed and image-variant parameters and states that
  non-fixed initial calibration is adjusted during alignment/optimization.
- The official [COLMAP camera-model guidance](https://colmap.github.io/cameras.html)
  recommends the simplest adequate model, shared intrinsics for reliable
  higher-dimensional estimation and warns that overly complex models become
  degenerate. This is the basis of staged Auto rather than a universal full
  model.
- Ito and Okatani, [Self-calibration-based Approach to Critical Motion
  Sequences of Rolling-shutter Structure from Motion](https://arxiv.org/abs/1611.05476),
  derive rolling-shutter critical motion sequences. This supports diagnosing
  shutter/motion observability rather than letting lens coefficients absorb
  the effect.
- Ovrén and Forssén, [Gyroscope-Based Video Stabilisation with Auto-Calibration](https://openaccess.thecvf.com/content_cvpr_2015/papers/Ovren_Gyroscope-Based_Video_Stabilisation_2015_CVPR_paper.pdf),
  and subsequent rolling-shutter calibration literature motivate explicit
  timing/motion parameters for smartphone/video capture instead of image-wise
  arbitrary intrinsics.

## Required implementation gates

- synthetic recovery for every supported mask, covariance and critical motion;
- deterministic weak-group fallback to the last stable stage;
- group partition tests for DJI, smartphone multi-camera/autofocus and mixed
  ordinary/fisheye inputs;
- held-out Golden comparisons against a pinned Metashape version;
- before/after residual-field and parameter-correlation snapshots;
- schema/version migration for all frozen policies and reports.
