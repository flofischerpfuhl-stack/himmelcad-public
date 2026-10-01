# Third-Party Licenses

This file tracks dependencies that are **incorporated into the product
build**, including code vendored into `vendor/` per `AGENTS.md` §1.6
(vendored open-source code is treated as part of Himmel:CAD).

Important: entries under `libs/` are references/inspiration unless an
entry below explicitly says they are used in the product build.

## Vendored sources (treated as part of Himmel:CAD per §1.6)

| Name                           | Upstream commit / version                                                       | License                                          | Vendored at                                                                        | Upstream URL                                                          | Use                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| acadrust                       | `0.4.1`, commit `f249c2f816acf36ee51cd5533716bdd443c2517e`                      | MPL-2.0                                          | `vendor/acadrust/`                                                                 | https://github.com/hakanaktt/acadrust                                 | Isolated pure-Rust DWG/DXF parser fork for the canonical IO provider. MPL file boundary and changes are inventoried in `VENDOR.md`; the separately authored specification PDF is excluded.          |
| T3 Code adapted agent slice    | `v0.0.24`, commit `ea20e800216417c8d3b5dfc54a863bbd9e0b3e20`                    | MIT                                              | `packages/@himmelcad/agent/vendor/t3code/`                                         | https://github.com/pingdotgg/t3code                                   | Narrow rewritten provider-driver, normalized-event, stable-row and virtual-list/scroll-anchor concepts. Project/worktree/Git/account/update/telemetry/remote/persistence authority is excluded.     |
| PotreeConverter                | `2.1.1` (release tag, build `2022-11-29`)                                       | BSD 2-Clause                                     | `vendor/potreeconverter/<platform>/` (downloaded on `pnpm install`, not committed) | https://github.com/potree/PotreeConverter                             | LAS / LAZ → Potree 2.0 octree generation (`metadata.json` + `hierarchy.bin` + `octree.bin`). Invoked headlessly by `crates/himmelcad-io::las_import`.                                               |
| Brush                          | `0.3.0`                                                                         | Apache-2.0                                       | `vendor/brush/<platform>/` (downloaded on `pnpm install`, not committed)           | https://github.com/ArthurBrussee/brush                                | Cross-platform WebGPU Gaussian-splat training and PLY export on NVIDIA, AMD, Intel, Windows and Linux.                                                                                              |
| COLMAP learned feature models  | COLMAP `3.13.0` pinned artifacts                                                | BSD-3-Clause / upstream model notices            | `vendor/photolab-models/colmap-4.1.0/` (verified download, not committed)          | https://github.com/colmap/colmap/releases/tag/3.13.0                  | Offline ALIKED N16Rot/N32 and LightGlue models used by the curated COLMAP 4.x worker.                                                                                                               |
| Himmel:CAD COLMAP worker       | COLMAP `4.1.0` + audited no-copyleft patch                                      | BSD-3-Clause and permissive transitive inventory | `vendor/colmap/<platform>/` (local/release build, not committed)                   | https://github.com/colmap/colmap/tree/4.1.0                           | Headless SfM/MVS worker. CHOLMOD/SuiteSparse and CGAL are removed; Eigen sparse solvers are used instead.                                                                                           |
| COLMAP numerical kernels       | OpenBLAS `0.3.33` + CLAPACK `3.2.1` (vcpkg lockfile)                            | BSD-3-Clause                                     | statically linked into the local COLMAP worker                                     | https://github.com/OpenMathLib/OpenBLAS / https://netlib.org/clapack/ | Required by the permissively licensed Faiss retrieval backend; no SuiteSparse/CHOLMOD/Fortran runtime.                                                                                              |
| Himmel:CAD portable MVS worker | Himmel:CAD release-matched                                                      | BUSL-1.1; permissive build closure only          | `vendor/photolab-mvs/<platform>/` (release build, not committed)                   | This repository                                                       | Offline CPU-reference depth maps and dense fusion on Windows/Linux. Optional wgpu acceleration is enabled only after parity validation; no AliceVision/OpenSfM source is incorporated.              |
| DeDoDe                         | commit `6d156183f4dc84cd704ae779eebc8350995c5b06`; Detector-L-v2 + Descriptor-G | MIT                                              | `vendor/dedode/<platform>/` (release bundle; dev fetched, not committed)           | https://github.com/Parskatt/DeDoDe                                    | Offline large-feature rescue. Detector SHA-256 `4113809d…bdc17`, Descriptor-G SHA-256 `ef6e3f29…fee41`; exact sizes and full hashes are release gates in `dedode_runtime.rs`.                       |
| DINOv2 ViT-L/14                | pretrained checkpoint, published 2023-04-13                                     | Apache-2.0                                       | `vendor/dedode/<platform>/models/` (release bundle; dev fetched, not committed)    | https://github.com/facebookresearch/dinov2                            | Frozen Descriptor-G backbone; 1,217,586,395 bytes, SHA-256 `d5383ea8f4877b2472eb973e0fd72d557c7da5d3611bd527ceeb1d7162cbf428`.                                                                      |
| ONNX Runtime                   | `1.24.4`                                                                        | MIT                                              | PhotoLab DeDoDe release worker                                                     | https://github.com/microsoft/onnxruntime                              | Executes the full Detector-L-v2 and Descriptor-G/DINOv2 graphs offline without PyTorch, OpenMP or a model substitution.                                                                             |
| LLVM-MinGW libc++ / libunwind  | `20260407`                                                                      | Apache-2.0 with LLVM exception                   | Windows PhotoLab application and Geo runtime                                       | https://github.com/mstorsjo/llvm-mingw                                | C++ and unwind runtimes required by the UCRT-based Rust, GDAL, PROJ and COLMAP workers.                                                                                                             |
| MinGW-w64 winpthreads          | LLVM-MinGW `20260407`, SHA-256 `aee4e547…53f7cb`                                | MIT and BSD-3-Clause                             | Windows COLMAP worker                                                              | https://www.mingw-w64.org/                                            | Permissive POSIX-thread runtime imported by the LLVM-MinGW COLMAP worker; its full upstream notice is bundled beside the DLL.                                                                       |
| Microsoft Visual C++ Runtime   | `14.44.35211.0` plus NumPy-wheel-pinned `MSVCP140`                              | Microsoft Visual Studio redistributable license  | Windows ONNX/COLMAP closures and Windows automation NumPy wheel                    | https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist    | Officially redistributable C++ runtime DLLs required by the pinned MSVC binaries. Every DLL and the redistributable terms are SHA-256 pinned; the automation wheel embeds its applicable RTF terms. |
| PROJ BETA2007 grid             | official PROJ-data conversion                                                   | permissive redistribution notice                 | `vendor/proj-data/de_adv_BETA2007.tif`                                             | https://cdn.proj.org/                                                 | Offline national DHDN/ETRS89 NTv2 transformation.                                                                                                                                                   |
| BKG GCG2016 geoid              | official PROJ-data conversion                                                   | CC-BY-4.0                                        | `vendor/proj-data/de_bkg_gcg2016.tif`                                              | https://cdn.proj.org/                                                 | Offline German normal-height conversion; attribution © BKG Germany.                                                                                                                                 |
| LVGL Saarland SeTa2016         | official GSB and PROJ-data conversion                                           | licence-free source grant; GeoTIFF CC-BY-4.0     | `vendor/proj-data/seta2016/`, `vendor/proj-data/de_lgvl_saarland_SeTa2016.tif`     | https://www.saarland.de/lvgl/                                         | Offline Saarland NTv2 transformation and 52-point golden comparison; attribution LVGL Saarland.                                                                                                     |

## Runtime Node dependencies

| Name                 | Version    | License | URL                                                   | Use                                                               |
| -------------------- | ---------- | ------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `react`, `react-dom` | `^19.x`    | MIT     | https://react.dev                                     | UI shell.                                                         |
| `zustand`            | `^5.x`     | MIT     | https://github.com/pmndrs/zustand                     | UI mirror state.                                                  |
| `lucide-react`       | `^0.460.0` | ISC     | https://github.com/lucide-icons/lucide                | Shared ribbon, tree and action icons.                             |
| `electron`           | `43.1.0`   | MIT     | https://www.electronjs.org                            | PhotoLab desktop shell.                                           |
| `vite`               | `^5.x`     | MIT     | https://vite.dev                                      | Dev/build tooling.                                                |
| `electron-builder`   | `26.15.6`  | MIT     | https://github.com/electron-userland/electron-builder | Reproducible Linux and Windows desktop packaging.                 |
| `electron-updater`   | `6.8.9`    | MIT     | https://github.com/electron-userland/electron-builder | Update discovery and installation for NSIS and AppImage packages. |

| `replicad` | `1.1.0` | MIT | https://replicad.xyz | Assembler CAD-kernel worker: B-rep modelling API over OCCT (bundled into the worker chunk). Transitives `flatbush` 4.6.2 (ISC), `flatqueue` 3.1.0 (ISC), `opentype.js` 1.3.4 (MIT), `tiny-inflate` 1.0.3 (MIT), `string.prototype.codepointat` 0.2.1 (MIT). |

| `opentype.js` | `1.3.4` | MIT | https://github.com/opentypejs/opentype.js | Assembler sketch text (direct dependency since 2026-09-30): parses the bundled font to turn typed text into glyph outlines (`renderer/src/foundation/sketch-solver/text/fonts.ts`), in the renderer and the headless CLI. Transitives `tiny-inflate` 1.0.3 (MIT, WOFF decompression), `string.prototype.codepointat` 0.2.1 (MIT). |
| `@fontsource/inter` | `5.3.0` | OFL-1.1 | https://fontsource.org/fonts/inter (upstream https://github.com/rsms/inter) | Assembler sketch text font: only `files/inter-latin-400-normal.woff` (Inter 4.001, Latin subset, OS/2 `fsType` 0 = installable embedding) is bundled as an asset and parsed at runtime. SIL OFL 1.1 permits bundling and embedding with software; the font is shipped unmodified and never sold on its own; its license text ships in `renderer/public/licenses/Inter-OFL.txt`. Checked 2026-09-30 from the package's `LICENSE` and the font's name table. The theme's `Kamikaze` display fonts are **not** used for sketch text: their license is not recorded here, so they are not cleared for embedding into user geometry. |

(The full production Node tree is enumerated by `pnpm licenses list --prod`
and gated in CI by `node scripts/check-licenses.mjs --pnpm`. The list above
covers the load-bearing runtime entries.)

## Conditionally admitted LGPL components

Admitted per `docs/DEPENDENCY-POLICY.md` "Conditionally allowed: LGPL",
conditions 1–7, by name and version only. Anything else under LGPL stays
excluded.

### `replicad-opencascadejs` 1.1.0 — OCCT 8.0.1 as WebAssembly (Assembler)

Admitted 2026-09-29 for the Assembler Phase 1 CAD-kernel spike
(`assembler/KERNEL-SPIKE.md`). Recorded from the published package contents
(npm tarball `replicad-opencascadejs-1.1.0.tgz`, integrity
`sha512-s0KHR5V+ivsOE4nZXfuoW70lW0/rldkb3ZDY34LpXOQRFLQN5qVydQm3BRo7boZPdFkkAZBERJ+NzB0DYxrivw==`),
not from memory.

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Component               | npm `replicad-opencascadejs` `1.1.0` (author Steve Genoud; `gitHead` `e4b05f67dc4e2393a876ce8c5064a9c93db05bf1`), a custom opencascade.js build containing only the bindings replicad needs.                                                                                                                                                                                                                                                                                                                                         |
| Contents                | Open CASCADE Technology **8.0.1** (tag `V8_0_1`, commit `b8f597c677811d1f9f4d8a97f5ae2825c0353a42`) plus opencascade.js bindings (`taucad/opencascade.js` commit `ebd263f15337b440b391492af073662707e86482`, Docker image `ghcr.io/taucad/opencascade.js:canary-ebd263f1-single-threaded`), compiled with Emscripten 5.0.1. The wasm strings report "Open CASCADE 8.0"; the pin comes from opencascade.js `DEPS.json` at that commit.                                                                                                |
| License variant         | Package: `LGPL-2.1-only` (package.json; `LICENSE` = full LGPL 2.1 text). OCCT itself: LGPL 2.1 **with the Open CASCADE exception version 1.0** (`OCCT_LGPL_EXCEPTION.txt` at `V8_0_1`; the exception only adds permissions). opencascade.js bindings: LGPL-2.1. Emscripten runtime/system libraries inside the wasm: MIT or NCSA (Emscripten), MIT (musl), Apache-2.0 WITH LLVM-exception (libc++/libc++abi). A string scan of the shipped wasm found no FreeType or RapidJSON code (both are optional opencascade.js dependencies). |
| Shipped files           | Only the single-threaded variant: `dist/replicad_single.wasm` (22,980,267 bytes, SHA-256 `4c9f22e9f3828dca6f3c95405934cdbe624e593c35266f47f392ab337478dbde`, copied unchanged to `assets/replicad_single-<hash>.wasm`) and its Emscripten loader `dist/replicad_single.js` (emitted as its own chunk `assets/replicad_single-<hash>.js`, minified by the app build). The multi-threaded variant is not shipped.                                                                                                                      |
| Link type               | **Runtime-loaded WebAssembly module in a Web Worker.** No static linking: the Assembler worker dynamically `import()`s the loader chunk and fetches the `.wasm` at runtime (`apps/assembler/renderer/src/app/kernel.worker.ts`); Assembler code talks to it only through replicad and the app-owned `KernelAdapter` interface. It is the LGPL "library"; the Assembler bundle is the "work that uses the library".                                                                                                                |
| Source availability     | Exact build inputs are public: OCCT `V8_0_1`, opencascade.js commit above, replicad build configuration `packages/replicad-opencascadejs/build-source/` at commit `e4b05f67…` (https://github.com/sgenoud/replicad). Himmel:CAD makes **no modifications**. If a release ever ships a modified build, its source and build configuration must be published under LGPL-2.1 with that release (condition 3).                                                                                                                           |
| How a user replaces it  | Rebuild (build configuration + opencascade.js Docker toolchain) and overwrite the two files `assets/replicad_single-<hash>.wasm` and `assets/replicad_single-<hash>.js` in the installed app, keeping file names; the replacement must export the bindings replicad uses. Packaged-Electron layout (asar vs. unpacked) must keep these two files replaceable — to be checked when Assembler packaging is added.                                                                                                                      |
| Notices shipped         | `apps/assembler/renderer/public/licenses/` → `licenses/` in the app: `THIRD-PARTY-NOTICES.txt` (prominent OCCT notice required by the exception, component/version/source/replacement text), `LGPL-2.1.txt`, `OCCT-LGPL-EXCEPTION.txt`, and the MIT/ISC texts of replicad and its transitives. Help → About summarizes them.                                                                                                                                                                                                         |
| Product-terms check (4) | `LICENSE`/`LICENSING.md` contain no clause forbidding modification or reverse engineering of third-party libraries (searched 2026-09-29). Any future EULA must keep the LGPL-2.1 §6 permissions.                                                                                                                                                                                                                                                                                                                                     |
| License gate            | `scripts/check-licenses.mjs` `ADMITTED_LGPL` entry for exactly `replicad-opencascadejs@1.1.0` / `LGPL-2.1-only`. No Rust crate is involved, so `deny.toml` is unchanged.                                                                                                                                                                                                                                                                                                                                                             |

**AGPL-3.0-or-later compatibility check for an LGPL-2.1-only component
(condition 6).** _Engineering analysis, not legal advice; confirm with
counsel before the first AGPL-converted release that ships this component._

1. The Assembler bundle is a "work that uses the Library" (LGPL-2.1 §5).
   LGPL-2.1 §6 lets such a work be distributed under terms of the
   distributor's choice if those terms permit modification of the work for
   the customer's own use and reverse engineering for debugging, and the
   library can be replaced — §6(b) is met because the library is a separate,
   runtime-loaded unit (see "Link type"). AGPL-3.0 grants modification and
   imposes no reverse-engineering ban, so distributing the Assembler code
   under AGPL-3.0-or-later while the OCCT module stays under LGPL-2.1 raises
   no conflict: each part keeps its own license.
2. AGPL-3.0 §1 counts libraries the work is "specifically designed to
   require" as part of its Corresponding Source. The LGPL permits
   redistributing the library's source, and the exact sources are public
   (above), so the AGPL source obligation can be satisfied without
   relicensing the library.
3. As a fallback, LGPL-2.1 §3 allows a copy to be converted to the GNU GPL
   version 2 "or, if you wish, a newer version", i.e. GPL-3.0, which AGPL-3.0
   §13 allows to be combined with; the FSF lists LGPL-2.1 as GPLv3-compatible
   on that basis. The Open CASCADE exception only adds permissions and does
   not restrict either route.
4. AGPL §13 (network use) applies to the Assembler work, not to the LGPL
   library; the LGPL does not restrict it.

Conclusion: no conflict found between this LGPL-2.1-only component (with
the OCCT exception) and a future AGPL-3.0-or-later distribution of
Assembler, provided the separate-module/replaceability conditions above
stay true.

### `@himmelcad/occt-wasm` 8.0.1-hc.3 — HimmelCAD build of OCCT 8.0.1 as WebAssembly (Assembler, default module)

Recorded 2026-09-30 by the OCCT-build spike (`assembler/OCCT-BUILD-SPIKE.md`).
The Assembler's default OCCT module since the Block-6 integration
(2026-09-30): app builds and the Windows installer ship it unless built with
`HIMMELCAD_OCCT=replicad` (then `replicad-opencascadejs` 1.1.0 above ships
instead). A release that ships it must publish `vendor/occt-wasm` at its
commit (condition 3).

The web build (`apps/assembler-web`, Block 8, `assembler/WEB.md` §8) ships the
same two files as static assets and offers the source from the same place as
the application: a copy of `vendor/occt-wasm` under `licenses/source/occt-wasm/`
and `licenses/SOURCE-OFFER.txt` (how to replace the module in a copy of the
static site), linked from Help › About. A deployment keeps these files for as
long as it serves that version.

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component               | `vendor/occt-wasm` (`package.json` name `@himmelcad/occt-wasm`, version `8.0.1-hc.3`, not an npm dependency): the `replicad-opencascadejs` 1.1.0 build configuration relinked with 8 more bindings (`BRepAlgoAPI_Defeaturing`, `IGESControl_Controller/Reader/Writer`, `STEPCAFControl_Reader`, `HimmelcadOffset`, `HimmelcadXcaf`, `BRepBuilderAPI_GTransform`) and two added C++ files (`build-config/wrappers/himmelcad-offset.cpp`, a facade over `BRepOffset_MakeOffset`; `himmelcad-xcaf.cpp`, XCAF label names).                                                                                                                                  |
| Contents                | Same inputs as `replicad-opencascadejs` 1.1.0 above: OCCT **8.0.1** (`V8_0_1`, `b8f597c677811d1f9f4d8a97f5ae2825c0353a42`), opencascade.js `ebd263f15337b440b391492af073662707e86482` via its published toolchain image `ghcr.io/taucad/opencascade.js:canary-ebd263f1-single-threaded` (linux/amd64 manifest `sha256:deb9be8470038652c060b47f2d2e7e2e46d899bb896ecabb007bf60307ee2d54`, Emscripten 5.0.1), replicad build configuration at `e4b05f67dc4e2393a876ce8c5064a9c93db05bf1`. No FreeType/RapidJSON code linked (same link filter as replicad's build). |
| License variant         | `LGPL-2.1-only` for the module (OCCT: LGPL-2.1 with the Open CASCADE exception 1.0; opencascade.js: LGPL-2.1); the HimmelCAD wrapper C++ file is LGPL-2.1-only (SPDX header) because it is compiled into the module. Emscripten runtime as above.                                                                                                                                                                                                                                                                                                                 |
| Shipped files           | By default (not with `HIMMELCAD_OCCT=replicad`): `himmelcad_occt.wasm` (25,350,953 bytes, SHA-256 `d28d42fa84727d260bb03d60c7ad50842e1da345f698f488cea6a9c264695317`) → `assets/himmelcad_occt-<hash>.wasm`, and `himmelcad_occt.js` (SHA-256 `9ee3e8642f1b4bb47bb8ba4fd441d1ab160990ee98dc95d442322b40e8fa4af2`) → its own chunk `assets/himmelcad_occt-<hash>.js`. Checksums: `vendor/occt-wasm/artifacts.sha256`.                                                                                                                                              |
| Link type               | Identical to `replicad-opencascadejs`: runtime-loaded WebAssembly module + Emscripten loader chunk in the CAD-kernel Web Worker (the Vite build aliases the package specifier to the two files); the app talks to it through replicad and `KernelAdapter`; extra classes are detected at runtime (`kernel/occtExtras.ts`).                                                                                                                                                                                                                                        |
| Source availability     | **Modified build** (condition 3): recipe `vendor/occt-wasm/build.sh`, binding diff `build-config/extra-bindings.yml`, added source `build-config/wrappers/himmelcad-offset.cpp`, pinned revisions in `build.sh`/`README.md`; all upstream inputs public (above). The recipe relinks replicad's unmodified configuration bit-for-bit reproducibly (two runs identical) and matches the npm files except 6 bytes of wasm code (see the spike report).                                                                                                               |
| How a user replaces it  | `vendor/occt-wasm/build.sh` (x86_64 Linux, root; no Docker needed) or any modification of it, then overwrite `assets/himmelcad_occt-<hash>.{wasm,js}` keeping the names.                                                                                                                                                                                                                                                                                                                                                                                          |
| Notices shipped         | `THIRD-PARTY-NOTICES.txt` section "Open CASCADE Technology" describes both variants; license texts as for `replicad-opencascadejs`.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Product-terms check (4) | As above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| License gate            | `scripts/check-licenses.mjs` `ADMITTED_LGPL` entry for exactly `@himmelcad/occt-wasm@8.0.1-hc.3` / `LGPL-2.1-only`; the `--pnpm` run also reads `vendor/occt-wasm/package.json` (`VENDORED_RUNTIME_MODULES`).                                                                                                                                                                                                                                                                                                                                                     |

AGPL-3.0-or-later compatibility (condition 6): the analysis of
`replicad-opencascadejs` 1.1.0 above applies unchanged — same components,
same license variant, same separate runtime-loaded module; the added wrapper
is LGPL-2.1-only like the module.

### `@salusoft89/planegcs` 1.2.0 — FreeCAD planeGCS as WebAssembly (Assembler)

Admitted 2026-09-29 for the Assembler sketch solver (`assembler/SKETCHING.md`).
Recorded from the published package contents (npm tarball
`planegcs-1.2.0.tgz`, integrity
`sha512-NcdWJnJRCnIDvM9yJD98Jm8qaK//wRqMEbJ0WtibKnhbzI484TjIEbYD6EVUZejndXGC9yBkuKgqXg+9buzi6Q==`,
`gitHead` `ee9b156da9827a91a56a888a53520f63d5cffaa6`), not from memory; build
inputs from the repository at that commit.

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component               | npm `@salusoft89/planegcs` `1.2.0` (Miroslav Šerý / Salusoft89, https://github.com/Salusoft89/planegcs): FreeCAD's `src/Mod/Sketcher/App/planegcs` 2D constraint solver compiled to WebAssembly with Emscripten embind bindings, plus a TypeScript wrapper (`GcsWrapper`). No runtime npm dependencies.                                                                                                                                                                                                                                                                                                       |
| Contents                | `dist/planegcs_dist/planegcs.wasm` (508,141 bytes), its Emscripten loader `planegcs.js`, the wrapper/index JS and TypeScript sources. Built in Docker image `emscripten/emsdk:3.1.45` with the Ubuntu packages `libeigen3-dev` and Boost headers (versions not pinned by the upstream Dockerfile). A string scan of the wasm shows Eigen (`EigenSparseQR`), Boost (`boost::detail::sp_counted…`, Boost.Graph `connected_components` per `GCS.cpp`) and Emscripten embind.                                                                                                                                     |
| License variant         | Package: `LGPL-2.0-or-later` (package.json); the shipped `LICENSE` file is the LGPL 2.1 text. planeGCS sources (e.g. `GCS.cpp`): "GNU Library General Public License … version 2 of the License, or (at your option) any later version" = LGPL-2.0-or-later. Wrapper/bindings (`gcs_wrapper.ts`, `gcs_system.ts`): LGPL-2.1-or-later. Inside the wasm: Eigen 3 (MPL-2.0; `Eigen/OrderingMethods` adapts CSparse code under LGPL-2.1-or-later), Boost (BSL-1.0), Emscripten runtime (MIT or NCSA), musl (MIT), libc++/libc++abi (Apache-2.0 WITH LLVM-exception).                                              |
| Shipped files           | `assets/planegcs-<hash>.wasm` (unchanged copy of `dist/planegcs_dist/planegcs.wasm`, SHA-256 `039601df53b11cd06d0f8626cd2e9422b07aca31b18db9ba437b7d26cf5594c5`) and `assets/planegcs-<hash>.js` (the loader + wrapper as one separately emitted chunk, forced by `worker.rollupOptions.output.manualChunks` in `apps/assembler/vite.config.ts`, minified by the app build).                                                                                                                                                                                                                                  |
| Link type               | **Runtime-loaded WebAssembly module + JS chunk in a Web Worker.** `apps/assembler/renderer/src/foundation/sketch-solver/solver.worker.ts` dynamically `import()`s the package and fetches the `.wasm` at runtime; Assembler code (`sketch/planegcsSolver.ts`) only calls its public API through handles it receives (type-only imports, no bundling into app code) behind the app-owned `SketchSolver` interface. The worker and the glue chunk get the same worker-scoped CSP as the kernel worker (`'unsafe-eval' 'wasm-unsafe-eval'`, `electron/main.ts` `WORKER_CSP`): the embind glue builds invokers with `new Function`. |
| Source availability     | https://github.com/Salusoft89/planegcs at `ee9b156d…` (Dockerfile, bindings generator, vendored FreeCAD planegcs sources); FreeCAD upstream https://github.com/FreeCAD/FreeCAD. Himmel:CAD makes **no modifications**; a modified build would have to be published under the LGPL with that release (condition 3).                                                                                                                                                                                                                                                                                            |
| How a user replaces it  | Rebuild (`npm run build:all` in the repository above) and overwrite `assets/planegcs-<hash>.wasm` and `assets/planegcs-<hash>.js`, keeping file names; the replacement must keep the package API (`init_planegcs_module`, `GcsWrapper`).                                                                                                                                                                                                                                                                                                                                                                      |
| Notices shipped         | `apps/assembler/renderer/public/licenses/`: `THIRD-PARTY-NOTICES.txt` (planeGCS section), `LGPL-2.1.txt`, `MPL-2.0.txt` (Eigen), `BSL-1.0.txt` (Boost). Help → About mentions it.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Product-terms check (4) | Same as for `replicad-opencascadejs` above: no clause forbids modification or reverse engineering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| License gate            | `scripts/check-licenses.mjs` `ADMITTED_LGPL` entry for exactly `@salusoft89/planegcs@1.2.0` / `LGPL-2.0-or-later`. No Rust crate involved; `deny.toml` unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**AGPL-3.0-or-later compatibility (condition 6).** Every LGPL part is
"or later" (planeGCS LGPL-2.0-or-later, wrapper LGPL-2.1-or-later, the
CSparse-derived Eigen code LGPL-2.1-or-later), so policy condition 6 needs
no separate case: LGPL-2.1-or-later/LGPL-3.0 combine into an
AGPL-3.0-or-later distribution. MPL-2.0 (Eigen) is GPL-compatible via its
secondary-license clause and BSL-1.0 is permissive. _Engineering analysis,
not legal advice._

## Development and test Node dependencies

| Name       | Version  | License | URL                                   | Use                                                                                                                                                                                               |
| ---------- | -------- | ------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `axe-core` | `4.13.0` | MPL-2.0 | https://github.com/dequelabs/axe-core | PhotoLab accessibility audits only; injected from the unmodified package. Its upstream `LICENSE` and `LICENSE-3RD-PARTY.txt` notices remain intact; the package declares no runtime dependencies. |

## Runtime Rust dependencies

bevy_basisu_loader_sys 0.4.4 (MIT or Apache-2.0,
https://github.com/beicause/bevy_basisu_loader) provides native/WASM Basis
Universal transcoding of KTX2 textures to device-optimal BC, ETC2, ASTC or
RGBA formats.

| Name                                                         | Version                         | License                 | URL                                                                      | Use                                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------- | ----------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `las`, `laz`                                                 | `0.9.11`, `0.12.1`              | MIT, Apache-2.0         | https://github.com/gadomski/las-rs, https://github.com/tmontaigu/laz-rs  | Native LAS/LAZ import and prepared point-source conversion.                                                                                                                        |
| `e57`, `crc32c`                                              | `0.11.13`, `0.6.8`              | MIT, MIT or Apache-2.0  | https://github.com/cry-inc/e57, https://github.com/zowens/crc32c         | Bounded E57 scan and embedded-image decoding with hardware-accelerated CRC32C verification before canonical point-cloud, raster and panorama admission.                            |
| `quick-xml`                                                  | `0.41.0`                        | MIT                     | https://github.com/tafia/quick-xml                                       | Bounded event parsing and deterministic writing for canonical LandXML 1.2 civil-data import/export.                                                                                |
| `dxf`                                                        | `0.6.1`                         | MIT                     | https://github.com/ixmilia/dxf-rs                                        | Native ASCII DXF import/export for the canonical Civil/CAD interchange subset.                                                                                                     |
| `geotiff-reader`, `geotiff-core`, `tiff-reader`, `tiff-core` | `0.7.0`                         | MIT or Apache-2.0       | https://github.com/roteiro-gis/geotiff-rust                              | Pure-Rust, bounded local GeoTIFF/BigTIFF/COG metadata and tile/strip/window access; no GDAL or C system dependency.                                                                |
| `geotiff-writer`, `tiff-writer`                              | `0.7.0`                         | MIT or Apache-2.0       | https://github.com/roteiro-gis/geotiff-rust                              | Development-test fixture generation and independent round-trip validation for the lossless canonical GeoTIFF/COG exporter.                                                         |
| buildingSMART `tessellated-item.ifc` test fixture            | IFC 4.0.2.1 Reference View V1.2 | CC BY 4.0               | https://github.com/buildingSMART/Sample-Test-Files                       | Official parser/placement/tessellation conformance fixture; trailing whitespace normalized, SHA-256 pinned alongside the file, not shipped as runtime code.                        |
| `nom-exif`                                                   | `3.6.1`                         | MIT                     | https://github.com/mindeng/nom-exif                                      | Pure-Rust EXIF/GPS image metadata parsing for PhotoLab import.                                                                                                                     |
| `zip`                                                        | `8.6.0`                         | MIT                     | https://github.com/zip-rs/zip2                                           | Streaming `.hcadx` project bundles and bounded SLPK/I3S ZIP64 STORE/DEFLATE archive access.                                                                                        |
| `flate2`                                                     | `1.1.9`                         | MIT or Apache-2.0       | https://github.com/rust-lang/flate2-rs                                   | Bounded inner-gzip I3S resource decoding and ZIP DEFLATE support for the canonical SLPK importer.                                                                                  |
| `fs2`                                                        | `0.4.3`                         | MIT or Apache-2.0       | https://github.com/danburkert/fs2-rs                                     | Cross-platform OS file locks with automatic crash release.                                                                                                                         |
| `image`                                                      | `0.25.8`                        | MIT or Apache-2.0       | https://github.com/image-rs/image                                        | Pure-Rust JPEG/PNG decoding in the portable PhotoLab MVS worker.                                                                                                                   |
| `brotli-decompressor`                                        | `5.0.3`                         | BSD-3-Clause/MIT        | https://github.com/dropbox/rust-brotli-decompressor                      | Bounded PotreeConverter 2 BROTLI node decoding in native and WASM workers.                                                                                                         |
| `wgpu`                                                       | `30.0.0`                        | MIT or Apache-2.0       | https://github.com/gfx-rs/wgpu                                           | Shared native/WASM render backend over WebGPU, WebGL2, Vulkan, Metal, Direct3D 12 and OpenGL.                                                                                      |
| `bytemuck`                                                   | `1.x`                           | Zlib, Apache-2.0 or MIT | https://github.com/Lokathor/bytemuck                                     | Checked plain-data casts for renderer vertex and uniform uploads.                                                                                                                  |
| `gltf`                                                       | `1.4.x`                         | MIT or Apache-2.0       | https://github.com/gltf-rs/gltf                                          | Validated glTF 2.0/GLB mesh and material decoding for 3D Tiles content.                                                                                                            |
| `draco-gltf`, `draco-core`                                   | `0.1.0`, `1.0.3`                | Apache-2.0              | https://github.com/Filyus/draco-rust                                     | Pure-Rust `KHR_draco_mesh_compression` materialization shared by native and WASM viewer backends.                                                                                  |
| `meshopt-rs`                                                 | `0.1.2`                         | MIT                     | https://github.com/yzsolt/meshopt-rs                                     | Pure-Rust `EXT_meshopt_compression` decode on native and WASM viewer backends.                                                                                                     |
| `earcut`                                                     | `0.4.10`                        | ISC                     | https://github.com/georust/earcut                                        | Polygon triangulation with interior rings for authored CAD area render proxies.                                                                                                    |
| `spade`, `robust`                                            | `2.15.0`, `1.2.0`               | MIT or Apache-2.0       | https://github.com/Stoeoef/spade, https://github.com/georust/robust      | Robust constrained-Delaunay predicates and topology for checked DGM/TIN creation; `robust` is Spade's predicate dependency.                                                        |
| `hashbrown`, `foldhash` (Spade transitives)                  | `0.15.5`, `0.1.5`               | MIT or Apache-2.0; Zlib | https://github.com/rust-lang/hashbrown, https://github.com/orlp/foldhash | Hash table implementation selected by Spade and its non-cryptographic hash implementation.                                                                                         |
| `serde`, `serde_json`                                        | `1.x`                           | MIT or Apache-2.0       | https://serde.rs                                                         | JSON-RPC payloads, project objects.                                                                                                                                                |
| `bincode`                                                    | `2.0.1`                         | MIT                     | https://github.com/bincode-org/bincode                                   | Allocation-bounded ephemeral `HCDECODE v5` worker artifacts only; its maintenance-status exception and replacement trigger are recorded in `docs/security/advisory-exceptions.md`. |
| `thiserror`                                                  | `^1`                            | MIT or Apache-2.0       | https://github.com/dtolnay/thiserror                                     | Error enums.                                                                                                                                                                       |
| `tracing`, `tracing-subscriber`                              | `^0.1`, `^0.3`                  | MIT                     | https://tokio.rs/#tracing                                                | Structured logging.                                                                                                                                                                |

(Full graph audited by `cargo deny` per AGENTS.md §1.4.)

## Download-on-demand verification data

The explicit real-DGM section gate downloads two unchanged Brandenburg DGM1
ZIP archives (`dgm_33250-5888` and `dgm_33251-5888`) into `target/`; they are
test data and are not packaged with Himmel:CAD. The source is Landesvermessung
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

## Automation Python runtime

The automation runtime pins CPython 3.12.13, NumPy 2.2.6 and Pillow 11.3.0.
The Linux NumPy artifact is a no-BLAS build. Stock `opencv-python-headless`
wheels remain development-only because they incorporate FFmpeg and, on Linux,
OpenBLAS/Fortran runtimes. Release builds instead use the project-owned
`himmelcad-opencv-headless` 4.13.0 distribution built from the pinned OpenCV
source archive.

The Windows NumPy wheel retains the pinned official MSVC extension modules but
removes the stock OpenBLAS/GCC/Fortran payload. It supplies only the exact 57
symbols imported by those modules through NumPy's BSD-licensed ILP64 f2c
reference BLAS/LAPACK and a small CBLAS bridge. The native provider imports
only UCRT/Windows APIs and has no provider threads, OpenMP, GCC or Fortran
runtime. Float32/64 and complex64/128 GEMM, solve, inverse, SVD, eig/eigh,
least-squares, QR and Cholesky, failure cases, concurrent import, threaded SVD,
OpenCV PNG and SIFT all pass under the exact CPython 3.12 runtime in Wine
11.13. Two clean builds are byte-identical. The wheel embeds NumPy and bundled
notices plus the separately pinned Microsoft redistributable terms; its
manifest-pinned SHA-256 is
`37203f9cf97964e0ec2b2c959ff9dba53b8b496b54943184506fc2f958935ddc`.

The Linux `cp312-cp312-manylinux_2_28_x86_64` wheel is produced by
`scripts/build-automation-linux-opencv.sh` with the pinned Zig 0.14.1 glibc
2.28 toolchain. Its native modules are `core`, `imgproc`, `imgcodecs`,
`calib3d`, `features2d`, `flann`, `photo` and `video`; FFmpeg, GStreamer,
VideoIO, GUI, DNN, BLAS/LAPACK/Fortran/OpenMP, IPP and OpenCL are disabled.
The audited dynamic closure is the glibc platform runtime only, and the
manifest-pinned wheel SHA-256 is
`1a3060c4bbe5c4d238abf35fb6fd70d1e4568105e790ae0cb3a97e1d9d76e9e2`.

The Windows `cp312-cp312-win_amd64` wheel is independently cross-built by
`scripts/build-automation-windows-opencv.sh` with LLVM-MinGW 20260407/UCRT.
The same eight OpenCV modules and bundled JPEG, PNG, TIFF, WebP and zlib codecs
are statically linked. Static PE auditing allows only `python312.dll`, Windows
API-set/UCRT DLLs, `KERNEL32.dll` and `ole32.dll`; every incorporated codec,
SoftFloat, DLPack, LLVM/libc++/libunwind and MinGW-w64/winpthreads notice is
bundled in the wheel. Two clean, different build roots produced a
byte-identical wheel. The exact OpenCV wheel passed CPython 3.12, PNG
encode/decode and SIFT smoke tests under Wine 11.13 with the final
manifest-pinned Windows NumPy wheel. The official stock NumPy wheel remains a
build input only; its OpenBLAS/GCC/Fortran payload is never copied into the
release artifact.

## Policy

Allowed licenses:

- MIT
- MIT-CMU
- 0BSD
- BSD-2-Clause
- BSD-3-Clause
- Apache-2.0
- Apache-2.0 WITH LLVM-exception
- PSF-2.0
- ISC
- HPND
- IJG
- libpng-2.0
- libtiff
- SunPro
- ZPL-2.1
- `LicenseRef-Cephes-MinGW-w64`, only for the permissive Cephes notice bundled
  with the pinned MinGW-w64 runtime and with that notice redistributed
- `LicenseRef-Microsoft-Visual-Cpp-Runtime`, only for an officially
  redistributable Microsoft runtime whose applicable terms and exact binary
  hash ship in the same release component
- MPL-2.0, if file-level separation is preserved
- Zlib
- Unlicense
- CC0
- BUSL-1.1 / BSL 1.1

Forbidden licenses for incorporated product code:

- GPL
- LGPL, except components admitted by name under
  `docs/DEPENDENCY-POLICY.md` "Conditionally allowed: LGPL" (currently
  `replicad-opencascadejs` 1.1.0, `@himmelcad/occt-wasm` 8.0.1-hc.3 and
  `@salusoft89/planegcs` 1.2.0, see "Conditionally admitted LGPL
  components" above)
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
