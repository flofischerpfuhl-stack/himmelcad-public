# PhotoLab capture sources, video and local scale

Status: M5 implementation contract, 2026-07-20. ADR 0023 remains the
architectural decision for non-CRS projects.

## Capture sources

`DiscoveredPhoto` retains the byte-exact source SHA-256 and adds an independent
`CaptureSourceProfile`. Classification uses ordinary EXIF make/model/lens
evidence and optional vendor metadata; DJI fields are neither required nor the
generic source model. Supported device classes are smartphone, system camera,
drone, action camera, scanner and unknown.

Embedded GNSS and RTK values become `priorOnly` observations. Their ENU
covariance is explicit. EXIF positions without accuracy metadata receive a
conservative 25 m horizontal and 50 m vertical standard deviation. They never
establish a CRS, overwrite an aligned pose or silently convert a local project
to a map-referenced project.

JPEG, PNG and TIFF have packaged decoders. RAW, HEIC, HEIF and AVIF support is
reported per host. A source is still hashed and retained when no decoder is
available, but inspection emits `decoderUnavailable`. A transcode is allowed
only when ImageMagick or FFmpeg advertises a matching decoder. Every normalized
PNG records original source hash, artifact hash, algorithm/parameter hashes and
the exact external tool/version.

No new decoder dependency is incorporated. System executables are optional,
separately installed capabilities and are never copied into a release by this
path. Release-bundled decoders still require the normal license inventory and
`LICENSES/THIRD_PARTY.md` entry. Overrides for pinned deployments are
`HCAD_MAGICK`, `HCAD_FFMPEG` and `HCAD_FFPROBE`.

## Local metric projects and scale

New projects start as `localMetric`: metre units, right-handed Cartesian axes,
Z up. This does not claim an EPSG code, geographic origin, project north or a
gravity observation. A CRS-backed image commit explicitly changes the spatial
reference to `crsBacked`; local commits contain no projected positions or fake
PROJ operation.

A scale constraint contains two independently triangulated 3D endpoints, their
3×3 covariance matrices, observation counts, maximum ray-intersection angles,
the measured length/unit and its standard deviation. The evaluator rejects
single-image endpoints, weak intersections, coincident points, non-finite
values and invalid covariance. One accepted constraint determines scale only;
it does not determine translation, orientation, north or gravity.

## Video preparation

Video is copied into a content-addressed source path after SHA-256 verification.
`ffprobe` supplies bounded container/stream metadata. FFmpeg creates a fixed
2 fps, 320-pixel thumbnail sequence; Rust computes normalized Laplacian
sharpness, inter-frame motion and an overlap proxy. Selection is versioned as
`hcad-video-frame-selection-v1`, deterministic and constrained by quality,
overlap, temporal separation and maximum frame count.

Selected timestamps are materialized as full-resolution PNG files and passed
through the ordinary image inspection path. Each image retains the source video
hash, timestamp, frame index, selection version, parameter hash and FFmpeg
version.

Long operations report monotonic progress. Cancellation terminates an active
child process. An atomically replaced JSON checkpoint freezes source hash,
policy hash, algorithm version, candidates, selection and materialized paths;
an exact retry resumes completed stages. A changed source, policy, operation ID
or algorithm version is rejected instead of reusing stale work.

## Current limits

- Container GNSS tags are retained inside raw probe metadata but are not yet
  converted into a position prior because their datum/accuracy conventions are
  not portable.
- The v1 overlap value is an image-difference proxy, not feature-track overlap.
  Alignment remains the authority for actual connectivity.
- Rolling-shutter correction, exposure normalization and video audio are out of
  scope for frame preparation.
- Unsupported external tools remain a normal capability result; PhotoLab never
  downloads a codec or invokes a package manager automatically.
