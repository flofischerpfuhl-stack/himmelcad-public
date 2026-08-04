# Third-Party Licenses

This file tracks dependencies that are **incorporated into the product
build**, including code vendored into `vendor/` per `AGENTS.md` §1.6
(vendored open-source code is treated as part of HimmelCAD).

Important: entries under `libs/` are references/inspiration unless an
entry below explicitly says they are used in the product build.

## Vendored sources (treated as part of HimmelCAD per §1.6)

| Name                          | Upstream commit / version                                                       | License                                                    | Vendored at                                                                        | Upstream URL                                                          | Use                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@pnext/three-loader`         | `1.0.0` (snapshot pending vendoring)                                            | MIT (Pnext) + BSD-2-Clause (Potree-derived) + MIT (Plasio) | `vendor/three-loader/`                                                             | https://github.com/pnext/three-loader                                 | Streaming + LOD + LRU + GPU pick of Potree 2.0 octrees inside `@himmelcad/viewer`. Vendored to allow free modification (BROTLI support, MRT pick, custom materials) per ADR 0003.                  |
| PotreeConverter               | `2.1.1` (release tag, build `2022-11-29`)                                       | BSD 2-Clause                                               | `vendor/potreeconverter/<platform>/` (downloaded on `pnpm install`, not committed) | https://github.com/potree/PotreeConverter                             | LAS / LAZ → Potree 2.0 octree generation (`metadata.json` + `hierarchy.bin` + `octree.bin`). Invoked headlessly by `crates/himmelcad-io::las_import`.                                              |
| Brush                         | `0.3.0`                                                                         | Apache-2.0                                                 | `vendor/brush/<platform>/` (downloaded on `pnpm install`, not committed)           | https://github.com/ArthurBrussee/brush                                | Cross-platform WebGPU Gaussian-splat training and PLY export on NVIDIA, AMD, Intel, Windows and Linux.                                                                                             |
| COLMAP learned feature models | COLMAP `3.13.0` pinned artifacts                                                | BSD-3-Clause / upstream model notices                      | `vendor/photolab-models/colmap-4.1.0/` (verified download, not committed)          | https://github.com/colmap/colmap/releases/tag/3.13.0                  | Offline ALIKED N16Rot/N32 and LightGlue models used by the curated COLMAP 4.x worker.                                                                                                              |
| HimmelCAD COLMAP worker       | COLMAP `4.1.0` + audited no-copyleft patch                                      | BSD-3-Clause and permissive transitive inventory           | `vendor/colmap/<platform>/` (local/release build, not committed)                   | https://github.com/colmap/colmap/tree/4.1.0                           | Headless SfM/MVS worker. CHOLMOD/SuiteSparse and CGAL are removed; Eigen sparse solvers are used instead.                                                                                          |
| COLMAP numerical kernels      | OpenBLAS `0.3.33` + CLAPACK `3.2.1` (vcpkg lockfile)                            | BSD-3-Clause                                               | statically linked into the local COLMAP worker                                     | https://github.com/OpenMathLib/OpenBLAS / https://netlib.org/clapack/ | Required by the permissively licensed Faiss retrieval backend; no SuiteSparse/CHOLMOD/Fortran runtime.                                                                                             |
| HimmelCAD portable MVS worker | HimmelCAD release-matched                                                       | BUSL-1.1; permissive build closure only                    | `vendor/photolab-mvs/<platform>/` (release build, not committed)                   | This repository                                                       | Offline CPU-reference depth maps and dense fusion on Windows/Linux. Optional wgpu acceleration is enabled only after parity validation; no AliceVision/OpenSfM source is incorporated.             |
| DeDoDe                        | commit `6d156183f4dc84cd704ae779eebc8350995c5b06`; Detector-L-v2 + Descriptor-G | MIT                                                        | `vendor/dedode/<platform>/` (release bundle; dev fetched, not committed)           | https://github.com/Parskatt/DeDoDe                                    | Offline large-feature rescue. Detector SHA-256 `4113809d…bdc17`, Descriptor-G SHA-256 `ef6e3f29…fee41`; exact sizes and full hashes are release gates in `dedode_runtime.rs`.                      |
| DINOv2 ViT-L/14               | pretrained checkpoint, published 2023-04-13                                     | Apache-2.0                                                 | `vendor/dedode/<platform>/models/` (release bundle; dev fetched, not committed)    | https://github.com/facebookresearch/dinov2                            | Frozen Descriptor-G backbone; 1,217,586,395 bytes, SHA-256 `d5383ea8f4877b2472eb973e0fd72d557c7da5d3611bd527ceeb1d7162cbf428`.                                                                     |
| ONNX Runtime                  | `1.24.4`                                                                        | MIT                                                        | PhotoLab DeDoDe release worker                                                     | https://github.com/microsoft/onnxruntime                              | Executes the full Detector-L-v2 and Descriptor-G/DINOv2 graphs offline without PyTorch, OpenMP or a model substitution.                                                                            |
| LLVM-MinGW libc++ / libunwind | `20260407`                                                                      | Apache-2.0 with LLVM exception                             | Windows PhotoLab application and Geo runtime                                       | https://github.com/mstorsjo/llvm-mingw                                | C++ and unwind runtimes required by the UCRT-based Rust, GDAL, PROJ and COLMAP workers.                                                                                                            |
| MinGW-w64 winpthreads         | LLVM-MinGW `20260407`, SHA-256 `aee4e547…53f7cb`                                | MIT and BSD-3-Clause                                       | Windows COLMAP worker                                                              | https://www.mingw-w64.org/                                            | Permissive POSIX-thread runtime imported by the LLVM-MinGW COLMAP worker; its full upstream notice is bundled beside the DLL.                                                                      |
| Microsoft Visual C++ Runtime  | `14.44.35211.0`                                                                 | Microsoft Visual Studio redistributable license            | Windows ONNX Runtime closure, copied beside the DeDoDe worker and COLMAP           | https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist    | Officially redistributable `MSVCP140`, `MSVCP140_1`, `VCRUNTIME140` and `VCRUNTIME140_1` DLLs required by the pinned ONNX Runtime 1.24.4 binaries; archive and extracted files are SHA-256 pinned. |
| PROJ BETA2007 grid            | official PROJ-data conversion                                                   | permissive redistribution notice                           | `vendor/proj-data/de_adv_BETA2007.tif`                                             | https://cdn.proj.org/                                                 | Offline national DHDN/ETRS89 NTv2 transformation.                                                                                                                                                  |
| BKG GCG2016 geoid             | official PROJ-data conversion                                                   | CC-BY-4.0                                                  | `vendor/proj-data/de_bkg_gcg2016.tif`                                              | https://cdn.proj.org/                                                 | Offline German normal-height conversion; attribution © BKG Germany.                                                                                                                                |
| LVGL Saarland SeTa2016        | official GSB and PROJ-data conversion                                           | licence-free source grant; GeoTIFF CC-BY-4.0               | `vendor/proj-data/seta2016/`, `vendor/proj-data/de_lgvl_saarland_SeTa2016.tif`     | https://www.saarland.de/lvgl/                                         | Offline Saarland NTv2 transformation and 52-point golden comparison; attribution LVGL Saarland.                                                                                                    |

## Runtime Node dependencies

| Name                 | Version    | License | URL                                                   | Use                                                               |
| -------------------- | ---------- | ------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `three`              | `^0.169.0` | MIT     | https://github.com/mrdoob/three.js                    | WebGL renderer (Builder + WeltView).                              |
| `react`, `react-dom` | `^19.x`    | MIT     | https://react.dev                                     | UI shell.                                                         |
| `zustand`            | `^5.x`     | MIT     | https://github.com/pmndrs/zustand                     | UI mirror state.                                                  |
| `lucide-react`       | `^0.460.0` | ISC     | https://github.com/lucide-icons/lucide                | Shared ribbon, tree and action icons.                             |
| `electron`           | `43.1.0`   | MIT     | https://www.electronjs.org                            | PhotoLab desktop shell.                                           |
| `vite`               | `^5.x`     | MIT     | https://vite.dev                                      | Dev/build tooling.                                                |
| `electron-builder`   | `26.15.6`  | MIT     | https://github.com/electron-userland/electron-builder | Reproducible Linux and Windows desktop packaging.                 |
| `electron-updater`   | `6.8.9`    | MIT     | https://github.com/electron-userland/electron-builder | Update discovery and installation for NSIS and AppImage packages. |

(The full Node tree is enumerated by `pnpm licenses list` once the
license-checker job is wired into CI per AGENTS.md §1.4. The list above
covers the load-bearing runtime entries.)

## Runtime Rust dependencies

bevy_basisu_loader_sys 0.4.4 (MIT or Apache-2.0,
https://github.com/beicause/bevy_basisu_loader) provides native/WASM Basis
Universal transcoding of KTX2 textures to device-optimal BC, ETC2, ASTC or
RGBA formats.

| Name                                                         | Version                         | License                 | URL                                                                     | Use                                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------- | ----------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `las`, `laz`                                                 | `0.9.11`, `0.12.1`              | MIT, Apache-2.0         | https://github.com/gadomski/las-rs, https://github.com/tmontaigu/laz-rs | Native LAS/LAZ import and prepared point-source conversion.                                                                                                 |
| `e57`, `crc32c`                                              | `0.11.13`, `0.6.8`              | MIT, MIT or Apache-2.0  | https://github.com/cry-inc/e57, https://github.com/zowens/crc32c        | Bounded E57 scan and embedded-image decoding with hardware-accelerated CRC32C verification before canonical point-cloud, raster and panorama admission.     |
| `quick-xml`                                                  | `0.41.0`                        | MIT                     | https://github.com/tafia/quick-xml                                      | Bounded event parsing and deterministic writing for canonical LandXML 1.2 civil-data import/export.                                                         |
| `dxf`                                                        | `0.6.1`                         | MIT                     | https://github.com/ixmilia/dxf-rs                                       | Native ASCII DXF import/export for the canonical Civil/CAD interchange subset.                                                                              |
| `geotiff-reader`, `geotiff-core`, `tiff-reader`, `tiff-core` | `0.7.0`                         | MIT or Apache-2.0       | https://github.com/roteiro-gis/geotiff-rust                             | Pure-Rust, bounded local GeoTIFF/BigTIFF/COG metadata and tile/strip/window access; no GDAL or C system dependency.                                         |
| `geotiff-writer`, `tiff-writer`                              | `0.7.0`                         | MIT or Apache-2.0       | https://github.com/roteiro-gis/geotiff-rust                             | Development-test fixture generation and independent round-trip validation for the lossless canonical GeoTIFF/COG exporter.                                  |
| buildingSMART `tessellated-item.ifc` test fixture            | IFC 4.0.2.1 Reference View V1.2 | CC BY 4.0               | https://github.com/buildingSMART/Sample-Test-Files                      | Official parser/placement/tessellation conformance fixture; trailing whitespace normalized, SHA-256 pinned alongside the file, not shipped as runtime code. |
| `nom-exif`                                                   | `3.6.1`                         | MIT                     | https://github.com/mindeng/nom-exif                                     | Pure-Rust EXIF/GPS image metadata parsing for PhotoLab import.                                                                                              |
| `zip`                                                        | `8.6.0`                         | MIT                     | https://github.com/zip-rs/zip2                                          | Streaming `.hcadx` project bundle read/write with ZIP64 support.                                                                                            |
| `fs2`                                                        | `0.4.3`                         | MIT or Apache-2.0       | https://github.com/danburkert/fs2-rs                                    | Cross-platform OS file locks with automatic crash release.                                                                                                  |
| `image`                                                      | `0.25.8`                        | MIT or Apache-2.0       | https://github.com/image-rs/image                                       | Pure-Rust JPEG/PNG decoding in the portable PhotoLab MVS worker.                                                                                            |
| `brotli-decompressor`                                        | `5.0.3`                         | BSD-3-Clause/MIT        | https://github.com/dropbox/rust-brotli-decompressor                     | Bounded PotreeConverter 2 BROTLI node decoding in native and WASM workers.                                                                                  |
| `wgpu`                                                       | `30.0.0`                        | MIT or Apache-2.0       | https://github.com/gfx-rs/wgpu                                          | Shared native/WASM render backend over WebGPU, WebGL2, Vulkan, Metal, Direct3D 12 and OpenGL.                                                               |
| `bytemuck`                                                   | `1.x`                           | Zlib, Apache-2.0 or MIT | https://github.com/Lokathor/bytemuck                                    | Checked plain-data casts for renderer vertex and uniform uploads.                                                                                           |
| `gltf`                                                       | `1.4.x`                         | MIT or Apache-2.0       | https://github.com/gltf-rs/gltf                                         | Validated glTF 2.0/GLB mesh and material decoding for 3D Tiles content.                                                                                     |
| `draco-gltf`, `draco-core`                                   | `0.1.0`, `1.0.3`                | Apache-2.0              | https://github.com/Filyus/draco-rust                                    | Pure-Rust `KHR_draco_mesh_compression` materialization shared by native and WASM viewer backends.                                                           |
| `meshopt-rs`                                                 | `0.1.2`                         | MIT                     | https://github.com/yzsolt/meshopt-rs                                    | Pure-Rust `EXT_meshopt_compression` decode on native and WASM viewer backends.                                                                              |
| `earcut`                                                     | `0.4.10`                        | ISC                     | https://github.com/georust/earcut                                       | Polygon triangulation with interior rings for authored CAD area render proxies.                                                                             |
| `serde`, `serde_json`                                        | `1.x`                           | MIT or Apache-2.0       | https://serde.rs                                                        | JSON-RPC payloads, project objects.                                                                                                                         |
| `thiserror`                                                  | `^1`                            | MIT or Apache-2.0       | https://github.com/dtolnay/thiserror                                    | Error enums.                                                                                                                                                |
| `tracing`, `tracing-subscriber`                              | `^0.1`, `^0.3`                  | MIT                     | https://tokio.rs/#tracing                                               | Structured logging.                                                                                                                                         |

(Full graph audited by `cargo deny` per AGENTS.md §1.4.)

## Download-on-demand verification data

The explicit real-DGM section gate downloads two unchanged Brandenburg DGM1
ZIP archives (`dgm_33250-5888` and `dgm_33251-5888`) into `target/`; they are
test data and are not packaged with HimmelCAD. The source is Landesvermessung
und Geobasisinformation Brandenburg under Datenlizenz Deutschland –
Namensnennung 2.0 (`DL-DE-BY-2.0`). Required attribution:
`GeoBasis-DE/LGB`; derived gate output is marked `Daten geändert`. Exact URLs,
publication date, byte lengths and SHA-256 locks are recorded in
`scripts/fixtures/viewer-real-data.json`.

## PhotoLab DeDoDe worker runtime

Release inventories hash every incorporated file. The shipping runtime pins
CPython 3.12.13 (PSF-2.0), ONNX Runtime 1.24.4 (MIT), a no-BLAS NumPy 2.2.6
build (BSD-3-Clause), Pillow 11.3.0 (MIT-CMU and permissive codec notices),
FlatBuffers 25.12.19 (Apache-2.0), Packaging 26.2 (Apache-2.0/BSD-2-Clause) and
Protobuf 7.35.1 (BSD-3-Clause). PyTorch and torchvision remain conversion and
developer-parity tools only. The full 784×784 and 1176×1176 graphs are exported
from the three pinned upstream checkpoints; weak hardware changes concurrency,
not the graph, feature count or inference dimensions.

The official PyTorch and stock NumPy wheels are **not** release artifacts: the
former carries `libgomp`, while stock NumPy wheels may incorporate libgfortran
under GPL-with-GCC-runtime-exception. PhotoLab builds NumPy with BLAS and LAPACK
disabled because the worker delegates every descriptor matrix multiplication
to ONNX Runtime's permissive MLAS kernels. Release staging removes pip and
`ensurepip`; application runtime cannot install packages and never invokes git,
HTTP, Torch Hub or another package manager.

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
