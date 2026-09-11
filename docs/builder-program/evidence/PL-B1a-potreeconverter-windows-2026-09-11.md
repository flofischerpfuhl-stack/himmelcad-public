# PL-B1a — Windows PotreeConverter worker build and staging, 2026-09-11

Run on the Linux laptop in the existing repository, ending at
`18d298145bc8f5073ff77c5ed0d14594cfa2c9e9`, approximately 14:44–14:58 CEST.
No repository, dataset, or build-tree copy was made. The new source and build
tree stayed under `.build/potreeconverter-worker/`; the existing
`.build/potreeconverter-win/` tree was inspected read-only for comparison. No
Cargo command ran. Both build invocations used four jobs and the pinned
LLVM-MinGW cache under `.build/llvm-mingw`.

## Result

| Gate                                                          | Result                                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root filesystem preflight (at least 15 GB free)               | PASS — 21 GB free (`22,344,134,656` bytes) before launch                                                                                                        |
| Pinned source/toolchain                                       | PASS — PotreeConverter `d9387d52807bf8936fe98096b9992ea13b50ba94` (2.1.1), LLVM-MinGW `20260407-ucrt`, Clang 22.1.3                                             |
| Cross-build and static runtime closure                        | PASS — build exit 0; no LASzip or C++ runtime DLL import                                                                                                        |
| VENDOR artifact                                               | PASS — final `PotreeConverter.exe` is 3,587,584 bytes and matches the approved SHA-256 `6698bd0ddf65b6f12264720f6efc8f02e279a221028224f2365c7427447ea755`       |
| Rebuild comparison                                            | BLOCKED for byte-for-byte reproduction from the mandated renamed build root — details below; the delta was not timestamp-only, so `VENDOR.json` was not changed |
| Potree staging                                                | PASS — `workers/potree` is byte-for-byte identical to `vendor/potreeconverter/win32-x64`                                                                        |
| Retained Geo worker safety                                    | PASS — all 272 retained file path/size/mtime records and three representative content hashes were unchanged across staging                                      |
| Aggregate `node scripts/stage-photolab-runtime.mjs win32-x64` | EXPECTED BLOCK — Potree staged successfully, then the separately owned Geo source failed at missing `gdal_grid.exe`; retained Geo was not deleted               |
| PhotoLab release/packaging contract test                      | PASS                                                                                                                                                            |

The deliverable is present at
`vendor/potreeconverter/win32-x64/PotreeConverter.exe`, with its license and
metadata closure next to it. The manifest lists no auxiliary DLL. The PE
imports only `KERNEL32.dll` and API-set UCRT DLLs, so LASzip and the C++ runtime
are statically closed.

## Commands and timings

Preflight and pinned toolchain:

```bash
df -h /
du -sh .build/llvm-mingw .build/potreeconverter-worker \
  vendor/potreeconverter/win32-x64
.build/llvm-mingw/llvm-mingw-20260407-ucrt-ubuntu-22.04-x86_64/bin/x86_64-w64-mingw32-clang++ --version
```

The initial audited build used the required root, four-job cap, and 90-minute
hard stop:

```bash
set -o pipefail
/usr/bin/time -v -o .build/pl-b1a/build.time \
  timeout --signal=INT --kill-after=2m 5400s \
  env HIMMELCAD_POTREE_BUILD_ROOT=.build/potreeconverter-worker \
      HIMMELCAD_BUILD_JOBS=4 \
  node scripts/build-potreeconverter-windows.mjs \
  2>&1 | tee .build/pl-b1a/build.log
```

Result: exit 0; wall time `0:21.86`; user CPU `55.65 s`; system CPU
`4.67 s`; average CPU `275%`; maximum RSS `367,832 KiB`; no swap. The output
was 3,588,096 bytes with SHA-256
`683b70e0d45f3ae4df95004a3a19172be69e84db79ec6fb7addf9c3356666d5c`.
It had the same imported DLL/function set as the approved executable, but it
was 512 bytes larger because the compiled `__FILE__` strings contained
`.build/potreeconverter-worker/source` instead of the three-byte-shorter
historical `.build/potreeconverter-win/source`. That changed `.rdata` size and
shifted linked RVAs; it was therefore not eligible for the timestamp-only
manifest update allowed by this package.

A single diagnostic rebuild, still in the required tree and at four jobs,
used `-ffile-prefix-map` in `CFLAGS` and `CXXFLAGS` to test that explanation:

```bash
set -o pipefail
/usr/bin/time -v -o .build/pl-b1a/build-normalized.time \
  timeout --signal=INT --kill-after=2m 5400s \
  env HIMMELCAD_POTREE_BUILD_ROOT=.build/potreeconverter-worker \
      HIMMELCAD_BUILD_JOBS=4 \
      CFLAGS=-ffile-prefix-map=/home/oem/Dokumente/003_Projekte/10_himmelcad/.build/potreeconverter-worker=/home/oem/Dokumente/003_Projekte/10_himmelcad/.build/potreeconverter-win \
      CXXFLAGS=-ffile-prefix-map=/home/oem/Dokumente/003_Projekte/10_himmelcad/.build/potreeconverter-worker=/home/oem/Dokumente/003_Projekte/10_himmelcad/.build/potreeconverter-win \
  node scripts/build-potreeconverter-windows.mjs \
  2>&1 | tee .build/pl-b1a/build-normalized.log
```

Result: exit 0; wall time `0:19.08`; user CPU `56.01 s`; system CPU
`4.62 s`; average CPU `317%`; maximum RSS `368,136 KiB`; no swap. This restored
the expected file size and exact import set, but 47 bytes still differed:
the link timestamp, 33 separator bytes in three compiled `__FILE__` strings
(MinGW normalized the mapped prefix to backslashes), a second timestamp copy,
and the resulting PDB/build identifier. Its SHA-256 was
`6b4f2b13841bef3b5448fa828cb6c18adc51799ff1e5c4040d283c42f23ae07b`.
This confirmed that the remaining delta was also not solely the PE link
timestamp. No third build was attempted. The script-regenerated manifest and
binary were rejected; the approved pre-run artifact was restored. It is also
byte-identical to the prior audited script output retained at
`.build/potreeconverter-win/build/PotreeConverter.exe`.

Aggregate staging after adding `stagePotreeConverter('win32-x64')` and keeping
the Windows aggregate output in place until component validation:

```bash
set -o pipefail
/usr/bin/time -v -o .build/pl-b1a/stage.time \
  node scripts/stage-photolab-runtime.mjs win32-x64 \
  2>&1 | tee .build/pl-b1a/stage.log
```

Result: exit 1 after `0:27.66`, after staging COLMAP, DeDoDe, and Potree. The
failure was the separately owned and already-known missing source:

```text
Required release runtime is missing: /home/oem/Dokumente/003_Projekte/10_himmelcad/.build/photolab-geo/vcpkg_installed-win/x64-mingw-static/tools/gdal/gdal_grid.exe
```

The staged Potree subtree exists despite that aggregate failure. Before and
after the command, the retained Geo tree had 272 files and the same inventory
digest, `53538b667a12d0ee56d85f348b6c95f9f3b77def981e1a81a19159086b89f092`.
The hashes of retained `gdal_grid.exe`, `projinfo.exe`, and `proj.db` also
matched. Logs and inventories are under `.build/pl-b1a/`.

Artifact and contract checks:

```bash
diff -qr vendor/potreeconverter/win32-x64 \
  .build/photolab-runtime/win32-x64/workers/potree
sha256sum vendor/potreeconverter/win32-x64/PotreeConverter.exe \
  .build/photolab-runtime/win32-x64/workers/potree/PotreeConverter.exe
node scripts/test-photolab-release-contract.mjs
node --check scripts/stage-photolab-runtime.mjs
git diff --check
```

Results: every command exited 0. The contract test printed
`PhotoLab release/packaging contract tests passed.`

## Windows vendor file table

| Path                          |     Bytes | SHA-256                                                            |
| ----------------------------- | --------: | ------------------------------------------------------------------ |
| `BUILD.md`                    |       399 | `3cb433bbf0d9c0238369d48a51b0bf7b41cc6b0570fcb22606a2015330d4ea12` |
| `LICENSE-PotreeConverter.txt` |     1,267 | `37fa9d7bd72c9e2ebfbc5e3414ac0868dee7df67224939f2aac8565b8f10e913` |
| `LICENSE-brotli.txt`          |     1,084 | `3d180008e36922a4e8daec11c34c7af264fed5962d07924aea928c38e8663c94` |
| `LICENSE-json.txt`            |     1,095 | `87069239a317b636f0306d51cfcf09a27ac2fe76c7018b294ba3d31a97a80c34` |
| `LICENSE-laszip.txt`          |    26,530 | `dbc8eab1421212bf7b392ea00619f6b8286df50b702d21f6e7382805828a1cef` |
| `PotreeConverter.exe`         | 3,587,584 | `6698bd0ddf65b6f12264720f6efc8f02e279a221028224f2365c7427447ea755` |
| `README.md`                   |     3,700 | `5c1ce465e4d3d7f1bc14842326e5406e76f1f5ddaffb4e441f2b7cbf3e6d19b5` |
| `VENDOR.json`                 |       669 | `a2202658c4505a7b27d5520b71aac5a2d56e2307393034a20c2028bc347aefe8` |

`VENDOR.json` was not changed. Its only artifact record matches the final
executable. The Windows closure has no DLL, unlike the Linux comparison worker,
which carries `liblaszip.so`; the four license texts are byte-identical between
the Windows and Linux vendor closures.

## Disk use

| Measurement                                |                          Value |
| ------------------------------------------ | -----------------------------: |
| Root free before build                     | 21 GB (`22,344,134,656` bytes) |
| Root free after build, staging, and audits | 21 GB (`22,186,467,328` bytes) |
| Final `.build/potreeconverter-worker`      |                         132 MB |
| LLVM-MinGW cache                           |                         687 MB |
| Windows vendor payload                     |                         3.5 MB |
| Staged Potree subtree                      |                         3.5 MB |
| PL-B1a logs and comparison files           |                         7.5 MB |

## Files left for the architect

- `vendor/potreeconverter/win32-x64/PotreeConverter.exe` and adjacent license/
  metadata closure: approved artifact, present on disk and ignored where
  applicable.
- `.build/photolab-runtime/win32-x64/workers/potree`: staged byte-identical
  worker closure.
- `scripts/stage-photolab-runtime.mjs`: Potree staging plus the minimal Windows
  retained-worker ordering correction; Linux cleanup behavior is unchanged.
- `.build/potreeconverter-worker/`: resumable pinned source/build tree.
- `.build/pl-b1a/`: build, comparison, staging, timing, and retention evidence.
- This evidence file.

No commit was made.

## Not verified in this lane

- A byte-for-byte rebuild at the new mandated build-root spelling; embedded
  source paths make the current audited script root-dependent. The approved
  artifact was retained rather than broadening this slice into build-system
  reproducibility work.
- A successful full aggregate restage from source, because the independently
  owned Windows Geo/GDAL source tree is absent. The prior staged Geo worker was
  deliberately retained and proven unchanged.
- The full release-inventory script: in addition to the missing Geo source,
  this laptop does not currently have the Windows `himmelcad-sidecar.exe`,
  `himmelcad-portable-mvs.exe`, or adjacent `libunwind.dll` release inputs.
- Native Windows execution of `PotreeConverter.exe`, packaging/installer
  execution, or a Windows point-cloud conversion. The ignored payload and
  uncommitted staging edit cannot reach the Windows clone through the
  repository's git-only synchronization lane in this package.
