# ADR 0007: Portable Depth Maps and Dense MVS

- Status: accepted
- Date: 2026-07-11

## Context

PhotoLab needs depth maps suitable for measurement and dense point clouds on
Windows and Linux, including machines without an NVIDIA GPU. The mature COLMAP
PatchMatch implementation is a valuable CUDA accelerator, but its documented
dense path is CUDA-oriented. Making it the only MVS implementation would make
AMD/Intel systems second-class and would not provide a stable cross-platform
quality reference.

AliceVision 3.3 is MPL-2.0 and OpenSfM is BSD-2-Clause. Both provide useful
algorithm and interoperability references. AliceVision's production depth-map
path is CUDA-centric. Shipping the complete OpenSfM Python environment would
also bring a much wider, historically mixed dependency inventory than its
dense kernel requires. Neither complete distribution is therefore incorporated
into the PhotoLab product.

The classical plane-sweep/PatchMatch family does not require learned weights.
Gallup et al. describe multi-view plane sweeping for slanted surfaces; the
OpenSfM public API demonstrates the practical sequence of patch matching,
cross-view depth cleaning and redundant-point pruning. These publications and
APIs are algorithm references only. HimmelCAD does not copy or port their
source.

## Decision

1. A separately built `himmelcad-portable-mvs` worker is the authoritative CPU
   quality reference on Linux and Windows. Its own implementation uses
   coarse-to-fine plane hypotheses, normalized cross-correlation, PatchMatch
   propagation/refinement, pixelwise source-view selection, forward/backward
   geometric consistency, and confidence-weighted fusion.
2. Identical scene manifests and quality settings are used on both platforms.
   Hardware adaptation may change thread count, in-flight tile count and cache
   size, but not resolution, depth hypotheses, view count, consistency
   threshold or confidence threshold.
3. Images are processed as overlapped tiles and pyramid levels. A cancellation
   point exists between every bounded cost-volume chunk and every tile. A
   checkpoint is atomically written after a bounded number of completed tiles.
4. CUDA remains an optional accelerator, including curated COLMAP PatchMatch.
   It is never required for opening or completing a project. CUDA output must
   pass the same geometric golden-data gates as the CPU reference.
5. Vulkan acceleration uses `wgpu` (MIT OR Apache-2.0) so the same WGSL kernels
   can run over Vulkan on Linux and Vulkan/D3D12 on Windows. It is advertised
   by a release worker only after deterministic golden datasets prove depth and
   confidence parity within the frozen tolerance. Until then selection falls
   back to CPU rather than changing quality silently.
6. The worker receives an immutable neutral scene manifest with undistorted
   image hashes, dimensions, pinhole intrinsics, world-to-camera transforms,
   depth bounds and an explicit view graph. No project mutation or network
   capability is available to it.
7. Depth products use independent `HCDEPTH1` tiles with float32 depth and
   confidence. The index repeats the camera model so the image viewer can turn
   a pixel plus depth into a revalidated 3D coordinate. Dense fusion exports a
   binary little-endian PLY for the existing point-cloud preparation path.
8. Release executables are content-pinned by a detached signed manifest. The
   manifest enumerates capabilities and all licenses; GPL, LGPL, AGPL, SSPL,
   Commons Clause and unknown licenses are rejected before execution. Runtime
   download is impossible.
9. Partial files live only in unique per-job scratch directories. Output tiles,
   PLY framing, finite values, hashes, provenance and checkpoint compatibility
   are validated before one atomic core command may publish them.

## Release gates

- The CPU worker completes the same golden scenes on Windows and Linux with
  equal tile topology and depth differences within the documented floating
  tolerance.
- Vulkan and CUDA are opt-in capabilities and each has separate parity,
  cancellation and out-of-memory fallback tests.
- A cancellation request is acknowledged cooperatively; after 300 ms the
  supervisor force-kills the isolated process. The active project generation
  never references its scratch directory.
- Peak memory is bounded by the configured number of overlapped tiles and
  source views. Low-memory hardware reduces concurrency, not output quality.
- The release SBOM and signed worker manifest contain no forbidden license.

## Consequences

PhotoLab has one portable correctness baseline instead of equating product
quality with a GPU vendor. GPU acceleration can evolve without changing the
project/data contracts. The cost is maintaining a focused numerical worker and
golden MVS corpus, but that work is also necessary to substantiate the promised
Metashape-class quality.

## Primary references

- https://people.inf.ethz.ch/marc.pollefeys/pubs/GallupCVPR07.pdf
- https://github.com/mapillary/OpenSfM
- https://github.com/mapillary/OpenSfM/blob/main/opensfm/src/dense/depthmap.h
- https://github.com/alicevision/AliceVision
- https://github.com/colmap/colmap
- https://colmap.github.io/faq.html
- https://github.com/gfx-rs/wgpu
