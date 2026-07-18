# ADR 0014: PhotoLab multi-flight calibration and explicit alignment merge

## Status

Accepted

## Context

A survey can contain several drone missions. A landing, autofocus cycle, zoom change or
camera replacement can change the internal camera parameters even when image dimensions and
EXIF model names remain identical. Treating every photo as one calibration group can bias the
bundle adjustment. Conversely, silently combining independently adjusted flights hides which
observations and controls established the common frame.

## Decision

- A `CaptureGroup` is an immutable, named mission/capture snapshot with exact camera membership.
- Every capture group is partitioned completely and without overlap into one or more
  `CameraCalibrationGroup` records. The grouping basis (`missionAutofocus`, embedded calibration
  or manual) and optional initial intrinsics are persisted. Matching metadata may propose a
  group, but never silently merges autofocus sessions.
- Valid DJI `drone-dji:DewarpData` is persisted as a complete Brown-Conrady calibration with its
  date and provenance. Principal-point offsets are converted once to absolute source-image pixel
  coordinates, and the complete calibration participates in group identity. COLMAP receives it as
  `FULL_OPENCV` in the exact `fx,fy,cx,cy,k1,k2,p1,p2,k3,k4,k5,k6` order with the unsupported
  rational denominator fixed to zero.
- Any alignment run containing reliable embedded calibration freezes focal length, principal
  point and distortion in mapper bundle adjustment for Fast, Quality Hybrid and Maximum
  Robustness. Profile quality changes matching and reconstruction robustness, not the supplied
  camera calibration. Metadata-poor runs retain explicit COLMAP focal/distortion refinement.
- Processing sets, capture groups and calibration groups remain different concepts: the first
  selects compute scope, the second describes acquisition, and the third controls shared
  intrinsics in bundle adjustment.
- Flights are aligned and GCP-optimized independently. `MergeAlignmentRuns` creates an explicit,
  immutable `MergedAlignmentRun` lineage over at least two published sparse alignments and any
  GCP-optimization runs used to connect them.
- A merge is accepted only when its connection graph is complete. Each edge needs either at least
  three verified cross-run tracks or at least three common control points that participated as
  controls in both referenced optimizations. Checkpoints do not establish a merge constraint.
- Planned overlap edges carry a track count of zero. The UI cannot claim connection evidence;
  only the joint solver may populate the count after inspecting its registered images and
  triangulated cross-run tracks.
- Creating a merge record publishes only a validated plan. It does not masquerade as a solved
  alignment. Dense, raster, mesh and splat jobs may retain a merged-alignment ID in their lineage
  only after the joint solve atomically publishes the merged camera poses and sparse dataset.
- No newest-run heuristic or implicit cross-processing-set merge is permitted.
- Every alignment artifact freezes its exact processing-set ID and calibration-group partition;
  later edits to capture metadata cannot retroactively change merge or report lineage.
- Every downstream product pins the exact GCP-optimization entity and immutable snapshot hash it
  used. Dependency reuse requires alignment, processing set and GCP revision to match together.

## Consequences

Separate autofocus sessions can have distinct intrinsics while still contributing to one final
product. The project tree and report can show capture membership, calibration sharing, independent
alignment/GCP lineage and the exact connection evidence. A disconnected or merely adjacent pair
of flights is rejected instead of producing an apparently georeferenced product.

The Sulzberg fixed-calibration replay supports the conservative mapper policy: fully frozen
`FULL_OPENCV` produced 0.955521 px reprojection RMS and an approximately 2 cm camera fit, while
focal-only refinement produced 0.959639 px. Enabling extra-parameter refinement reduced the
reported RMS to 0.863055 px only by driving the rational distortion coefficients to physically
implausible values (including k1 -5.73 and k2 12.62), so that numerically attractive but unstable
solution is explicitly rejected.

The runtime now has two explicit publication paths. Overlapping blocks are reconstructed from an
exhaustive cross-run feature graph and accepted only from the registered images and triangulated
tracks in that solved model. Non-overlapping blocks require the persisted shared-control evidence;
their independently optimized camera extrinsics and sparse points are assembled in the common
survey frame while their intrinsics and observations remain separate. The latter does not claim
cross-block bundle observations. Both paths checkpoint content hashes, reject incompatible resume
state and publish the dataset plus `MergedAlignmentRun` state atomically. Products must select the
published merged alignment explicitly.

The PhotoLab UI can turn a reviewed capture group into a reused or newly frozen processing set,
run its alignment and GCP adjustment independently, select a concrete converged GCP revision per
input block, and only then create the merge plan. The live and exported reports expose camera
membership, the frozen intrinsics groups, alignment job, processing set, GCP snapshot and final
product lineage. Identical processing-set memberships are rejected so two labels cannot make the
same immutable scope appear to be different computational input.
