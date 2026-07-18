# ADR 0006: PhotoLab Compute Backends and Offline Distribution

- Status: accepted
- Date: 2026-07-11

## Context

PhotoLab must produce survey-grade alignment, depth maps, dense geometry,
rasters, textured meshes and Gaussian splats on Windows and Linux without a
network connection. Reimplementing all mature numerical kernels before the
first usable release would create avoidable quality and validation risk. At the
same time, the product must not inherit GPL-family code or let an external tool
own project state, cancellation, provenance or quality policy.

COLMAP 4.0 integrates the maintained GLOMAP global mapper, ALIKED and SIFT
feature extraction, LightGlue matching, incremental and global SfM, bundle
adjustment, PatchMatch MVS, fusion, meshing and texture mapping behind a CLI.
COLMAP itself is BSD-3-Clause, but every enabled transitive dependency still
requires an independent release-build audit. Brush 0.3.0 provides an
Apache-2.0, dependency-free WebGPU worker for Gaussian-splat training on the
same Windows/Linux product tier across NVIDIA, AMD and Intel. `gsplat` provides
an optional Apache-2.0 CUDA accelerator; its Python, PyTorch and accelerator
distributions require the same independent audit.

## Decision

1. The Rust core remains authoritative. Compute backends receive immutable run
   manifests and write only into per-job scratch directories. The core
   validates outputs and atomically publishes product manifests.
2. V1 uses a curated, headless COLMAP 4.x worker for geometric computation:
   - ALIKED/LightGlue and SIFT/LightGlue run in independent feature stores;
   - only geometrically verified observations are fused into HimmelCAD tracks;
   - the global mapper is attempted first on a healthy view graph;
   - incremental/hierarchical mapping is the recorded robustness fallback;
   - PatchMatch, stereo fusion, meshing and texture mapping are resumable
     product stages, not opaque all-in-one runs.
3. The shipped COLMAP build disables GUI and every forbidden or unaudited
   optional component. In particular, no GPL/LGPL SuiteSparse, CHOLMOD,
   CXSparse or CGAL build enters the product. Sparse solvers are restricted to
   audited Eigen/Ceres paths until a separate ADR approves more.
4. Workers are bundled per platform and selected through a signed manifest with
   exact version, executable hash, capabilities and license inventory. Runtime
   download is forbidden. A missing or hash-invalid worker is a hard preflight
   error with a repair action.
5. The portable quality contract is backend-independent. Hardware detection may
   change concurrency, tile size, cache and GPU provider, but never silently
   changes the selected feature ensemble, geometric thresholds or output GSD.
6. Gaussian splats use isolated workers and remain appearance-only products:
   - Brush 0.3.0 is the platform-equivalent primary worker on Windows and Linux;
   - it consumes the validated COLMAP dataset, runs locally through WebGPU and
     exports a validated Gaussian PLY through the common artifact contract;
   - `gsplat` may be selected as an optional CUDA accelerator after its complete
     Python/PyTorch distribution passes the same release audit;
   - OpenSplat and other AGPL/GPL-family implementations are not product inputs.
7. PROJ and GDAL are likewise bundled as audited, network-disabled native tools.
   Project manifests freeze their versions, database versions, grids and command
   pipelines.
8. Every child process is spawned without a shell, with an allowlisted
   environment, bounded resources where supported, streamed logs, cooperative
   cancellation and a forced-kill deadline. Partial output remains isolated and
   is never referenced by the project manifest.
9. `Maximum Robustness` and quality-gated rescue use a separate DeDoDe-v2-G
   worker. The approved source is Parskatt/DeDoDe commit
   `6d156183f4dc84cd704ae779eebc8350995c5b06`; releases pin Detector-L-v2,
   Descriptor-G and DINOv2 ViT-L/14 by URL, byte length and SHA-256. The signed
   platform manifest inventories the exported ONNX graphs, bundled ONNX Runtime,
   minimal CPython worker, entrypoint and every runtime file. PyTorch is a
   build-time parity oracle only. Runtime downloads are forbidden.
10. DeDoDe extracts each image once, persists a checkpointed feature store and
    evaluates only a typed pair list. Dual-softmax is evaluated in bounded
    blocks with the same feature count, threshold and FP32 policy on CPU and
    CUDA. Its neutral `HCDEDG01` artifact contains mutual feature indices,
    coordinates and confidence. Rust validates framing, bounds, uniqueness and
    pair identity before COLMAP/Core performs geometric verification.
11. `scripts/fetch-photolab-dedode.py` is a build/development action, never an
    application-runtime action. Its local result remains explicitly untrusted;
    release packaging additionally requires the signed complete-file manifest.
    The byte-level interchange and validation rules are specified in
    `docs/photolab-dedode-worker.md`.
12. Release inference uses ONNX Runtime 1.24.4 and exact FP32 exports at both
    profile sizes (784 and 1176). Descriptor block products run through MLAS;
    the accompanying NumPy is built without BLAS/LAPACK, so no libgfortran,
    libquadmath, libgomp or lower-quality fallback enters Linux or Windows.

## Release gates

- Windows and Linux worker manifests describe identical algorithm capabilities.
- The full binary dependency graph contains no forbidden license.
- Golden datasets pass the Metashape comparison gates from the PhotoLab concept.
- Cancellation acknowledgement remains interactive and force termination
  cannot corrupt the current project generation.
- Offline tests run with networking disabled at the OS/process boundary.

## Consequences

- PhotoLab can reach mature SfM/MVS quality while retaining its own hybrid
  matching, project, UX and provenance model.
- Platform packages are several gigabytes; this is intentional and visible in
  the installer.
- COLMAP/Brush/gsplat are replaceable workers rather than canonical data models.
- A curated release toolchain and license SBOM become required build artifacts.

## Primary references

- https://github.com/colmap/colmap/releases
- https://github.com/colmap/colmap
- https://github.com/nerfstudio-project/gsplat
- https://github.com/nerfstudio-project/gsplat/blob/main/LICENSE
- https://github.com/ArthurBrussee/brush/releases/tag/v0.3.0
- https://github.com/ArthurBrussee/brush/blob/v0.3.0/LICENSE
- https://github.com/Parskatt/DeDoDe
- https://github.com/Parskatt/DeDoDe/releases/tag/v2
- https://github.com/Parskatt/DeDoDe/releases/tag/dedode_pretrained_models
- https://github.com/facebookresearch/dinov2
- https://pytorch.org/get-started/previous-versions/
