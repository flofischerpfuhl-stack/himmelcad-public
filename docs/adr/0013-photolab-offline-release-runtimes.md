# ADR 0013: License-compliant, quality-equivalent PhotoLab offline runtimes

## Status

Accepted.

## Context

PhotoLab's released alignment and geoproduct paths require large neural models,
DeDoDe-v2-G, GDAL, and PROJ. Common PyTorch, NumPy, and distribution packages
may introduce OpenMP, Fortran, or other runtimes forbidden by the Himmel:CAD
product policy. Replacing the model with a smaller one would violate the
quality contract. Windows and Linux must run the same algorithm fully offline.

## Decision

- Detector-L-v2, Descriptor-G, and DINOv2 ViT-L/14 are exported from exactly
  pinned source weights as FP32 ONNX graphs. The release runtime uses no smaller
  models or reduced inference resolution.
- A versioned manifest inventories every model and external-data fragment by
  size and SHA-256. Rust preflight verifies the complete manifest before start.
- DeDoDe uses CPython 3.12.13 and ONNX Runtime 1.24.4. NumPy 2.2.6 is built
  without BLAS or LAPACK; ONNX Runtime MLAS computes large similarity matrices.
  PyTorch is a conversion and parity tool only and is not distributed.
- Windows NumPy extensions are built as PE files with the pinned
  LLVM-MinGW-UCRT toolchain. `scripts/build-photolab-windows-numpy.sh` verifies
  source hash, long-double ABI, and DLL imports. Native Rust workers use the
  same UCRT target.
- Official ONNX Runtime 1.24.4 Windows binaries require MSVC 14.4. PhotoLab
  materializes only the four imported x64 DLLs from Microsoft Redistributable
  `14.44.35211.0`. Archive and files are hash-pinned, the license ships with
  them, PE closure is verified, and nothing is installed system-wide.
- COLMAP's additional `libwinpthread-1.dll` comes from the same pinned
  LLVM-MinGW archive, is MIT/BSD-3-Clause licensed, and ships with the complete
  `COPYING.winpthreads.txt`.
- GDAL 3.12.4 and PROJ 9.8.1 are built statically for Linux and Windows from the
  pinned vcpkg graph. Staging includes only required tools, databases, and the
  curated attributed BETA2007, GCG2016, and SeTa2016 grids.
- User-selected grids are copied once by role and safe filename into PhotoLab's
  local grid registry. A frozen operation binds role, registered path, and
  database version. Bundled official grids retain inventory checksums; local
  grids need no full inventory pin. Local DHDN NTv2 grids must declare
  `SYSTEM_F=DHDN` and `SYSTEM_T=ETRS89` and pass a forward/reverse probe within
  the image area of interest. Original filenames do not define validity, and
  an official operation's accuracy is not inherited by a replacement grid.
- Release audit hashes all files and verifies the complete ELF closure on Linux
  and all PE imports and bundle closure on Windows. `libgomp`, `libgfortran`,
  `libquadmath`, `libiomp`, GPL, LGPL, AGPL, or SSPL artifacts fail the build.
- Weaker hardware may reduce only parallelism and block or chunk size. Model,
  weights, feature budget, inference dimensions, and numeric mode stay equal.
- Python package managers, `ensurepip`, network configuration, and development
  sources are excluded. Workers start isolated with networking disabled.

## Consequences

Packages are several gigabytes and builds take longer. The full DeDoDe rescue
path remains installed, Linux and Windows share the model contract, and product
licensing does not depend on an accidental system-package closure. Every
runtime or model change requires manifest, parity, release-inventory, and
package tests on both platforms.

## Windows reproducibility

`scripts/build-colmap-worker-win-cross.sh` explicitly targets Windows and builds
COLMAP 4.1.0 from the audited patch, pinned vcpkg commit, and LLVM-MinGW.
`scripts/fetch-msvc-runtime.mjs` verifies Microsoft's redistributable before and
after extraction. `RELEASE_INVENTORY.json` is created only after complete PE
closure passes.

The x64 release produced on 2026-07-14 passed inventory verification with 2,612
runtime files. Setup and Portable contained the same 1,779,091,720-byte payload;
both NSIS containers decoded and passed `7za t`. The unpacked payload contained
2,690 files totaling 4,057,892,386 bytes. COLMAP 4.1.0 and the isolated DeDoDe
Python 3.12.13 runtime executed under Wine. Wine did not certify the native
Windows installer: incomplete PowerShell, WMI, and StdUtils behavior ended the
silent install with code 2 after payload verification. Native Windows install
remained a distinct release gate.

`scripts/check-photolab-packaged-runtime.mjs` verifies that every inventoried
file exists unchanged in the Electron payload. Linux and Windows carry the same
inventory; verification also binds DeDoDe files to the sidecar's ONNX manifest
and rejects Python bytecode, `ensurepip`, and package managers from staging.

Release staging never mutates pinned files under `vendor/`. COLMAP is copied to
`.build/photolab-runtime/<platform>/workers/colmap`; only that platform work
copy receives required UCRT or LLVM-MinGW files before audit and packaging.

## Package, installation, and startup gates

| Gate                                       | Linux                  | Windows cross/Wine       | Native Windows    |
| ------------------------------------------ | ---------------------- | ------------------------ | ----------------- |
| Inventory, hashes, license, binary closure | required               | required                 | required          |
| Unpacked payload against inventory         | required               | required                 | required          |
| Worker versions and DeDoDe import          | native                 | optional, non-certifying | required natively |
| Renderer, Electron, and sidecar startup    | required natively      | not certified            | required natively |
| Installer followed by startup              | native `.deb`/AppImage | not certified            | native NSIS       |

`scripts/photolab-package-smoke.mjs` checks unpacked payloads. Static mode checks
mapping and inventory; native mode also starts curated workers and the packaged
application and confirms a real `photolab.hardware.probe` round trip.
Wine-worker mode is only a cross-runtime sanity check.

`scripts/photolab-install-smoke.mjs` extracts `.deb` or AppImage on Linux or
installs NSIS silently on native Windows, runs the same native startup smoke,
and cleans the temporary installation. It rejects foreign-platform execution,
so Wine cannot accidentally pass this release gate.
