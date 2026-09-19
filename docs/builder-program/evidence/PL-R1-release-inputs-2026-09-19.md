# PL-R1 — PhotoLab release inputs and automation drift, 2026-09-19

Run on the Linux laptop in the existing repository. The final inspected HEAD was
`2818e25913c500f31bbfe1dc258704292015c148`; the working tree was already dirty
and received unrelated Builder-lane edits during this run. PL-R1 did not commit,
copy the repository or a dataset, or touch `DISPLAY=:0`.

Root free space passed the required preflight with 33 GB available and ended at
24 GB. Cargo used
`CARGO_TARGET_DIR=/home/oem/Dokumente/003_Projekte/10_himmelcad/target/photolab`.
Both release builds ran once in a user systemd scope with `MemoryMax=12G`,
`MemorySwapMax=0`, and four Cargo jobs.

## Result

| Gate                                          | Result                                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux runtime staging                         | PASS — the audited stager restored the absent 419-file COLMAP subtree from `vendor/colmap/linux-x64`; DeDoDe and Geo were restaged from their existing approved inputs |
| Linux release Rust binaries                   | PASS — native release build completed in 13m49s; systemd peak was 6.4 GB with zero swap                                                                                |
| Linux inventory                               | PASS — 4,876 files, 3,789,940,615 bytes, 76 ELF dependency records                                                                                                     |
| Windows Rust cross-target                     | PASS — sidecar and portable MVS built in 19m33s; systemd peak was 5.7 GB with zero swap; the producer copied pinned `libunwind.dll` beside them                        |
| Windows aggregate restage                     | EXPECTED BLOCK — all locally available workers and runtime DLLs were refreshed before the exact absent Geo source stopped the stager                                   |
| Windows inventory                             | PASS — 2,612 files, 3,669,802,335 bytes, 103 PE dependency records, using the deliberately retained/restored staged Geo worker                                         |
| Python SDK regeneration                       | PASS — only `generator-manifest.json` changed, updating the pinned `canonical_document.rs` hash; every generated SDK output was byte-identical                         |
| Python SDK tests                              | PASS — 14/14                                                                                                                                                           |
| Generated command-table freshness / app tests | PASS — 83/83                                                                                                                                                           |
| Automation host                               | PASS — 48 passed, 0 failed, 1 skipped; the real Codex probe expects 0.144.5 and found 0.155.1; the pin was not changed                                                 |
| R22 real sync/async smoke                     | NOT RUN — no public PhotoLab sync/async methods or compliant smoke harness exist in the generated SDK; the specification says private sidecar RPC is not a substitute  |

## Linux inventory

The initial fail-closed result was:

```text
PhotoLab release inventory failed: required release input is missing: .build/photolab-runtime/linux-x64/workers/colmap
```

`node scripts/stage-photolab-runtime.mjs linux-x64` exited 0 and recreated the
runtime solely from existing vendored/approved inputs. The first post-stage
inventory then reached the next absent input,
`target/release/himmelcad-portable-mvs`; that root-target path also conflicted
with the PhotoLab lane's mandatory Cargo target. The inventory checker now
honors `CARGO_TARGET_DIR`, as does the Windows Rust producer.

The lane-compliant native producer was:

```bash
systemd-run --user --scope -p MemoryMax=12G -p MemorySwapMax=0 \
  /usr/bin/env \
  CARGO_TARGET_DIR=/home/oem/Dokumente/003_Projekte/10_himmelcad/target/photolab \
  CARGO_BUILD_JOBS=4 \
  /home/oem/.cargo/bin/cargo build --release --bins \
  --package himmelcad-sidecar -j 4
```

The final command and result were:

```bash
CARGO_TARGET_DIR=/home/oem/Dokumente/003_Projekte/10_himmelcad/target/photolab \
  node scripts/check-photolab-release-inventory.mjs linux-x64
```

```text
PhotoLab release inventory passed: 4876 files · .build/release-inventory/photolab-linux-x64.json
```

The inventory SHA-256 is
`21ea0a35595307ef012c832d48a15f447ec96b1ac3998d8448a3c1404dcc3a33`.
Its worker counts are COLMAP 419 files (418 manifest records plus
`VENDOR.json`), DeDoDe 4,174, and Geo 265.

## Windows inputs and producers

The initial inventory stopped at the first missing input,
`target/x86_64-pc-windows-gnullvm/release/himmelcad-sidecar.exe`. The complete
producer audit was:

| Input                                                                                                      | Producer or materialization step                                                                                                                                                             | PL-R1 disposition                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `target/photolab/x86_64-pc-windows-gnullvm/release/himmelcad-sidecar.exe` and `himmelcad-portable-mvs.exe` | `scripts/build-photolab-windows-rust.mjs`                                                                                                                                                    | Built once locally under the bounded systemd scope; outputs are 34,310,144 and 1,764,352 bytes                                                                                                                                 |
| Adjacent `libunwind.dll`                                                                                   | The same Rust script copies it from the pinned LLVM-MinGW root                                                                                                                               | Materialized; 203,264 bytes                                                                                                                                                                                                    |
| `.build/photolab-geo/vcpkg_installed-win/x64-mingw-static`                                                 | Native Windows vcpkg GDAL/PROJ build described in `PHOTOLAB-HANDOFF.md`; there is no checked-in aggregate Geo producer script                                                                | **Missing on this laptop.** Rebuilding requires the pruned multi-GB vcpkg source/build lane, so it was not downloaded. The restored 272-file `.build/photolab-runtime/win32-x64/workers/geo` was retained and passed inventory |
| `.build/dedode-runtime/win32-x64/python`                                                                   | Retained embedded CPython source consumed/pruned by `stageDedodeRuntime`; `scripts/build-photolab-windows-numpy.sh` produces its audited NumPy replacement but assumes the base CPython tree | Present (3,737 source files before release pruning); staged successfully. No checked-in script materializes the base Windows CPython tree from nothing                                                                         |
| `vendor/msvc-runtime/win32-x64`                                                                            | `scripts/fetch-msvc-runtime.mjs` with pinned URL and hashes                                                                                                                                  | Already present; the stager reported version 14.44.35211.0 materialized and copied its four DLLs/license into COLMAP and DeDoDe                                                                                                |
| `.build/llvm-mingw/llvm-mingw-20260407-ucrt-ubuntu-22.04-x86_64`                                           | `scripts/fetch-llvm-mingw.mjs` with pinned archive SHA-256                                                                                                                                   | Already present (687 MB); no download. The stager copied `libc++.dll`, `libunwind.dll`, `libwinpthread-1.dll`, and the winpthreads license into the applicable workers                                                         |
| `vendor/colmap/win32-x64` and `vendor/potreeconverter/win32-x64`                                           | Audited cross-build scripts/evidence WIN-04 and PL-B1a                                                                                                                                       | Present and restaged; 597 COLMAP files and eight Potree files                                                                                                                                                                  |

The aggregate stager was changed so independent LLVM/MSVC closure copies occur
before the known-missing Geo source check. It refreshed COLMAP, DeDoDe, Potree,
and runtime DLLs, then stopped exactly at:

```text
Required release runtime is missing: .build/photolab-geo/vcpkg_installed-win/x64-mingw-static/tools/gdal/gdal_grid.exe
```

The inventory subsequently exposed a Linux-host checker defect: PE import names
such as `VCRUNTIME140.dll` were compared case-sensitively with bundled Windows
filenames. The checker now performs case-insensitive directory lookup, matching
Windows loader semantics.

The Linux and Windows Electron builder manifests now consume the same
`target/photolab` binaries that the lane builds and the inventory verifies. The
release-contract fixture and assertions were updated to keep that producer →
inventory → package path aligned.

The final command and result were:

```bash
CARGO_TARGET_DIR=/home/oem/Dokumente/003_Projekte/10_himmelcad/target/photolab \
  node scripts/check-photolab-release-inventory.mjs win32-x64
```

```text
PhotoLab release inventory passed: 2612 files · .build/release-inventory/photolab-win32-x64.json
```

The inventory SHA-256 is
`dad79a4b8625d612270cffacb354258768f00ffbbf51e8f10c4fae65ccfba2ac`.
The staged worker counts are COLMAP 597, DeDoDe 1,723, Geo 272, and Potree 8.

## SDK drift and R22

`python3.12 scripts/generate-automation-sdk.py` ran with Python 3.12.3. Review
showed one manifest-only change:

```text
crates/himmelcad-core/src/canonical_document.rs
  cb80db19... -> f7e744f2...
```

The last checked-in manifest already included the earlier G1b, V-06, V-08,
and R-02b through R-02e command surfaces. Since that manifest, the only pinned
contract-source commit is `99ea7a8` (R-02 default-layer lifecycle coverage), so
the narrower one-hash diff contains no unrelated generated surface.

Verification:

```text
python3.12 -m unittest discover -s sdk/python/tests
  Ran 14 tests — OK; generated Python SDK is current

pnpm --filter @himmelcad/app test
  83 passed, 0 failed; generated command table current

pnpm --filter @himmelcad/automation-host test
  48 passed, 0 failed, 1 skipped
  skip: expected Codex 0.144.5, installed codex-cli 0.155.1
```

R22 cannot be executed honestly on this tree. `HimmelcadClient` and
`AsyncHimmelcadClient` expose shared canonical/view/product-registration
methods, but no public `photolab.images.*`, `photolab.alignment.*`,
`photolab.gcp.*`, or `photolab.products.start` methods. No repository smoke
harness implements the specified brokered-grant import → align → optimize →
product → reopen flow. `docs/photolab-automation-command-rows.md` explicitly
states that a private sidecar RPC smoke does not satisfy G-2.

## Additional checks and limits

`node --check` passed for all three changed scripts,
`scripts/test-photolab-release-contract.mjs` passed, and `git diff --check`
passed. Native Windows execution, NSIS packaging/install, signature/update
policy, and a from-source Windows Geo restage were not run. The Windows
inventory proves the cross-target and retained staged payload; it is not a
native Windows startup claim.
