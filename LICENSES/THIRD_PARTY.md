# Third-Party Licenses

This file tracks dependencies that are **incorporated into the product
build**, including code vendored into `vendor/` per `AGENTS.md` §1.6
(vendored open-source code is treated as part of HimmelCAD).

Important: entries under `libs/` are references/inspiration unless an
entry below explicitly says they are used in the product build.

## Vendored sources (treated as part of HimmelCAD per §1.6)

| Name                          | Upstream commit / version                                                       | License                                                    | Vendored at                                                                        | Upstream URL                                                          | Use                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@pnext/three-loader`         | `1.0.0` (snapshot pending vendoring)                                            | MIT (Pnext) + BSD-2-Clause (Potree-derived) + MIT (Plasio) | `vendor/three-loader/`                                                             | https://github.com/pnext/three-loader                                 | Streaming + LOD + LRU + GPU pick of Potree 2.0 octrees inside `@himmelcad/viewer`. Vendored to allow free modification (BROTLI support, MRT pick, custom materials) per ADR 0003.      |
| PotreeConverter               | `2.1.1` (release tag, build `2022-11-29`)                                       | BSD 2-Clause                                               | `vendor/potreeconverter/<platform>/` (downloaded on `pnpm install`, not committed) | https://github.com/potree/PotreeConverter                             | LAS / LAZ → Potree 2.0 octree generation (`metadata.json` + `hierarchy.bin` + `octree.bin`). Invoked headlessly by `crates/himmelcad-io::las_import`.                                  |
| Brush                         | `0.3.0`                                                                         | Apache-2.0                                                 | `vendor/brush/<platform>/` (downloaded on `pnpm install`, not committed)           | https://github.com/ArthurBrussee/brush                                | Cross-platform WebGPU Gaussian-splat training and PLY export on NVIDIA, AMD, Intel, Windows and Linux.                                                                                 |
| COLMAP learned feature models | COLMAP `3.13.0` pinned artifacts                                                | BSD-3-Clause / upstream model notices                      | `vendor/photolab-models/colmap-4.1.0/` (verified download, not committed)          | https://github.com/colmap/colmap/releases/tag/3.13.0                  | Offline ALIKED N16Rot/N32 and LightGlue models used by the curated COLMAP 4.x worker.                                                                                                  |
| HimmelCAD COLMAP worker       | COLMAP `4.1.0` + audited no-copyleft patch                                      | BSD-3-Clause and permissive transitive inventory           | `vendor/colmap/<platform>/` (local/release build, not committed)                   | https://github.com/colmap/colmap/tree/4.1.0                           | Headless SfM/MVS worker. CHOLMOD/SuiteSparse and CGAL are removed; Eigen sparse solvers are used instead.                                                                              |
| COLMAP numerical kernels      | OpenBLAS `0.3.33` + CLAPACK `3.2.1` (vcpkg lockfile)                            | BSD-3-Clause                                               | statically linked into the local COLMAP worker                                     | https://github.com/OpenMathLib/OpenBLAS / https://netlib.org/clapack/ | Required by the permissively licensed Faiss retrieval backend; no SuiteSparse/CHOLMOD/Fortran runtime.                                                                                 |
| HimmelCAD portable MVS worker | HimmelCAD release-matched                                                       | BUSL-1.1; permissive build closure only                    | `vendor/photolab-mvs/<platform>/` (release build, not committed)                   | This repository                                                       | Offline CPU-reference depth maps and dense fusion on Windows/Linux. Optional wgpu acceleration is enabled only after parity validation; no AliceVision/OpenSfM source is incorporated. |
| DeDoDe                        | commit `6d156183f4dc84cd704ae779eebc8350995c5b06`; Detector-L-v2 + Descriptor-G | MIT                                                        | `vendor/dedode/<platform>/` (release bundle; dev fetched, not committed)           | https://github.com/Parskatt/DeDoDe                                    | Offline large-feature rescue. Detector SHA-256 `4113809d…bdc17`, Descriptor-G SHA-256 `ef6e3f29…fee41`; exact sizes and full hashes are release gates in `dedode_runtime.rs`.          |
| DINOv2 ViT-L/14               | pretrained checkpoint, published 2023-04-13                                     | Apache-2.0                                                 | `vendor/dedode/<platform>/models/` (release bundle; dev fetched, not committed)    | https://github.com/facebookresearch/dinov2                            | Frozen Descriptor-G backbone; 1,217,586,395 bytes, SHA-256 `d5383ea8f4877b2472eb973e0fd72d557c7da5d3611bd527ceeb1d7162cbf428`.                                                         |

## Runtime Node dependencies

| Name                 | Version    | License | URL                                                   | Use                                               |
| -------------------- | ---------- | ------- | ----------------------------------------------------- | ------------------------------------------------- |
| `three`              | `^0.169.0` | MIT     | https://github.com/mrdoob/three.js                    | WebGL renderer (Builder + WeltView).            |
| `react`, `react-dom` | `^19.x`    | MIT     | https://react.dev                                     | UI shell.                                         |
| `zustand`            | `^5.x`     | MIT     | https://github.com/pmndrs/zustand                     | UI mirror state.                                  |
| `lucide-react`       | `^0.460.0` | ISC     | https://github.com/lucide-icons/lucide                | Shared ribbon, tree and action icons.             |
| `electron`           | `43.1.0`   | MIT     | https://www.electronjs.org                            | PhotoLab desktop shell.                           |
| `vite`               | `^5.x`     | MIT     | https://vite.dev                                      | Dev/build tooling.                                |
| `electron-builder`   | `26.15.6`  | MIT     | https://github.com/electron-userland/electron-builder | Reproducible Linux and Windows desktop packaging. |

(The full Node tree is enumerated by `pnpm licenses list` once the
license-checker job is wired into CI per AGENTS.md §1.4. The list above
covers the load-bearing runtime entries.)

## Runtime Rust dependencies

| Name                            | Version            | License           | URL                                                                     | Use                                                              |
| ------------------------------- | ------------------ | ----------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `las`, `laz`                    | `0.9.11`, `0.12.1` | MIT, Apache-2.0   | https://github.com/gadomski/las-rs, https://github.com/tmontaigu/laz-rs | Native LAS/LAZ import and prepared point-source conversion.      |
| `nom-exif`                      | `3.6.1`            | MIT               | https://github.com/mindeng/nom-exif                                     | Pure-Rust EXIF/GPS image metadata parsing for PhotoLab import.   |
| `zip`                           | `8.6.0`            | MIT               | https://github.com/zip-rs/zip2                                          | Streaming `.hcadx` project bundle read/write with ZIP64 support. |
| `fs2`                           | `0.4.3`            | MIT or Apache-2.0 | https://github.com/danburkert/fs2-rs                                    | Cross-platform OS file locks with automatic crash release.       |
| `image`                         | `0.25.8`           | MIT or Apache-2.0 | https://github.com/image-rs/image                                       | Pure-Rust JPEG/PNG decoding in the portable PhotoLab MVS worker. |
| `serde`, `serde_json`           | `1.x`              | MIT or Apache-2.0 | https://serde.rs                                                        | JSON-RPC payloads, project objects.                              |
| `thiserror`                     | `^1`               | MIT or Apache-2.0 | https://github.com/dtolnay/thiserror                                    | Error enums.                                                     |
| `tracing`, `tracing-subscriber` | `^0.1`, `^0.3`     | MIT               | https://tokio.rs/#tracing                                               | Structured logging.                                              |

(Full graph audited by `cargo deny` per AGENTS.md §1.4.)

## PhotoLab DeDoDe worker runtime

Release manifests enumerate and hash every incorporated file. The runtime
contract pins an exact CPython patch version (Linux dev: 3.12.3, PSF-2.0),
PyTorch 2.5.1 and torchvision 0.20.1
(BSD-3-Clause), NumPy 2.1.3 (BSD-3-Clause), Pillow 11.0.0 (MIT-CMU), and einops
0.8.0 (MIT). DeDoDe's unused OpenCV geometry/augmentation import is replaced by
an inert module in the worker; no OpenCV/FFmpeg binary is incorporated.
Build-time resolution
does not constitute release approval: packaging fails until the complete
platform inventory, license texts and detached HimmelCAD signature are present.
Application runtime never invokes pip, git, HTTP, Torch Hub or another package
manager.

The pinned PyTorch support closure is filelock 3.16.1 (Unlicense),
typing-extensions 4.12.2 (PSF-2.0), NetworkX 3.4.2 (BSD-3-Clause), Jinja2
3.1.4 (BSD-3-Clause), fsspec 2024.10.0 (BSD-3-Clause), setuptools 75.1.0
(MIT), SymPy 1.13.1 and mpmath 1.3.0 (BSD-3-Clause), and MarkupSafe 3.0.2
(BSD-3-Clause). The fetch script installs the complete pinned support closure
first and then installs PyTorch/torchvision with `--no-deps`, preventing the
resolver from silently changing the release graph.

The official PyTorch development wheel is **not** a release artifact: on Linux
it may carry `libgomp` under GPL-with-GCC-runtime-exception, which HimmelCAD's
product policy does not accept. The curated release runtime must use a
no-copyleft PyTorch build (for example permissively licensed LLVM OpenMP or an
OpenMP-disabled build) and must inventory its native libraries. The Rust release
preflight rejects GPL/LGPL expressions; a stock dev wheel therefore cannot be
promoted merely by adding a signature.

Stock distribution GDAL/PROJ binaries and their `ldd`/DLL closure are likewise
not release artifacts. PhotoLab may invoke a separately installed system
toolchain during development, but packaging must use a pinned, signed,
permissive-only runtime inventory. The release scripts must never copy a system
dependency closure automatically.

## Policy

Allowed licenses:

- MIT
- MIT-CMU
- BSD-2-Clause
- BSD-3-Clause
- Apache-2.0
- PSF-2.0
- ISC
- MPL-2.0, if file-level separation is preserved
- Zlib
- Unlicense
- CC0
- BUSL-1.1 / BSL 1.1

Forbidden licenses for incorporated product code:

- GPL
- LGPL, except as a separately loaded external plugin after explicit ADR
- AGPL
- SSPL
- unknown/proprietary dependencies without written permission

## Vendoring requirements

Per `AGENTS.md` §1.6, anything under `vendor/` must:

1. Mirror the upstream `LICENSE` file alongside the vendored sources
   (`vendor/<name>/LICENSE` or `vendor/<name>/LICENSES/`).
2. Document the upstream commit SHA in a per-vendor `VENDOR.md` so
   future contributors can diff against upstream when pulling fixes.
3. Be listed in this file (above) with name, version, license, source
   URL, and what it does.
4. Be referenced from an ADR explaining why it was vendored instead of
   used as a managed dependency (see ADR 0003 for the Potree stack).
