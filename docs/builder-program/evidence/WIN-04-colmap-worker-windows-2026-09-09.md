# WIN-04 — Windows COLMAP worker cross-build, 2026-09-09

Run on the Linux laptop in the existing repository at `116a26ca428e366e960dec8581f26a5de0711965`, approximately 21:01–22:22 CEST. No repository, dataset, or build-tree copy was made; the existing `.build/colmap-worker` cache was reused. No Cargo command ran. The build used four jobs and finished within the three-hour hard stop.

## Result

| Gate | Result |
| --- | --- |
| Root filesystem preflight (at least 25 GB free) | PASS — 36 GB free before launch |
| Pinned inputs | PASS — COLMAP `fa8e3b3ff591552855f8ad2806723c80f963f69c`, vcpkg `03e366fb91e38b9432ebd5f8cc79f7c8f55e96ab`, LLVM-MinGW `20260407-ucrt` / Clang 22.1.3, audited COLMAP patch SHA-256 `da8074b603ab616e273f219e1e913ae0388dd83048dd15cb1f713dc23aa41e36` |
| vcpkg dependency build | PASS — 191/191 actions; OpenColorIO overlay patch applied and built |
| COLMAP configure/build/link/install | PASS — 387/387 Ninja actions; `colmap.exe` linked and installed |
| Forbidden import check in build script | PASS — no gomp, gfortran, quadmath, iomp, GPL, LGPL, or AGPL import |
| Vendor payload audit | PASS — all 596 manifest records match byte size and SHA-256; exact path set; no extras |
| `vendor/colmap/win32-x64/bin` closure | PASS — 12/12 expected files present; no extras; one documented reproducibility delta |
| Staged COLMAP subtree | PASS — all 596 manifest records match in `.build/photolab-runtime/win32-x64/workers/colmap`; exact path set; no extras |
| Aggregate `node scripts/stage-photolab-runtime.mjs win32-x64` | BLOCKED after staging COLMAP and DeDoDe — the separately owned Windows Geo source is absent |
| Aggregate release inventory | BLOCKED — `.build/photolab-runtime/win32-x64/workers/geo` is absent |

The WIN-04 artifact itself is complete at `vendor/colmap/win32-x64/bin` and is staged at `.build/photolab-runtime/win32-x64/workers/colmap`. The aggregate Windows runtime cannot be declared complete from this run because the mandatory Geo/GDAL input had been deliberately deleted on 2026-09-08 (`docs/builder-program/PHOTOLAB-HANDOFF.md`, entries 18:15–18:43), while only the prior staged copy was retained. The staging script deletes the aggregate output before validating all sources, so its attempted rerun also removed that retained Geo copy before reporting the missing source. Rebuilding the separately owned GDAL/PROJ closure was outside WIN-04 and was not attempted.

## Commands and timings

Preflight:

```bash
df -h /
du -sh .build/colmap-worker .build/llvm-mingw vendor/colmap/win32-x64
```

Build, with the requested cache root and four-job cap (the `timeout` enforces the three-hour hard stop):

```bash
set -o pipefail
mkdir -p .build/win-04
/usr/bin/time -v -o .build/win-04/build.time \
  timeout --signal=INT --kill-after=2m 10800s \
  env HIMMELCAD_COLMAP_BUILD_ROOT=.build/colmap-worker HIMMELCAD_BUILD_JOBS=4 \
  bash scripts/build-colmap-worker-win-cross.sh \
  2>&1 | tee .build/win-04/build.log
```

Result: exit 0; wall time `1:15:47`; user CPU `11271.75 s`; system CPU `969.21 s`; average CPU `269%`; maximum RSS `1,517,440 KiB`; no swap. vcpkg reported all requested installations complete in one hour. COLMAP configured successfully and Ninja completed 387/387 actions. The only COLMAP diagnostics were non-fatal upstream Clang warnings about the MinGW `environ` declaration and ignored `nodiscard` future results; no pinned source was changed.

The on-disk build script already contained uncommitted architect changes before this run: absolute normalization of a relative build root, vcpkg binary/XDG caches below that root, and a Ninja-fetch fallback. This run validated those changes; WIN-04 made no additional script edit.

Aggregate staging:

```bash
set -o pipefail
/usr/bin/time -v -o .build/win-04/stage.time \
  node scripts/stage-photolab-runtime.mjs win32-x64 \
  2>&1 | tee .build/win-04/stage.log
```

Result: exit 1 after `0:20.18`. `stageColmapRuntime('win32-x64')` and DeDoDe copying completed. The next required copy failed exactly at:

```text
Required release runtime is missing: .build/photolab-geo/vcpkg_installed-win/x64-mingw-static/tools/gdal/gdal_grid.exe
```

The repository and the rest of `/home/oem` were searched for the ten required Windows GDAL/PROJ executables; no alternate runtime root existed, so the supported `HIMMELCAD_GEO_RUNTIME_ROOT` override could not be used.

Aggregate inventory verification:

```bash
set -o pipefail
/usr/bin/time -v -o .build/win-04/inventory.time \
  node scripts/check-photolab-release-inventory.mjs win32-x64 \
  2>&1 | tee .build/win-04/inventory.log
```

Result: exit 1 after `0:00.04`:

```text
PhotoLab release inventory failed: required release input is missing: .build/photolab-runtime/win32-x64/workers/geo
```

Vendor and staged-COLMAP verification (run once in each root):

```bash
jq -r '.files[] | "\(.sha256)  \(.path)"' VENDOR.json | sha256sum -c -
jq -r '.files[] | [.path, (.bytes|tostring)] | @tsv' VENDOR.json |
  while IFS=$'\t' read -r rel expected_bytes; do
    test "$(stat -c %s "$rel")" = "$expected_bytes" || exit 1
  done
diff -u \
  <(jq -r '.files[].path' VENDOR.json | sort) \
  <(find . -type f ! -name VENDOR.json -printf '%P\n' | sort)
```

Results: exit 0 for `vendor/colmap/win32-x64` and exit 0 for `.build/photolab-runtime/win32-x64/workers/colmap`. Full outputs are `.build/win-04/vendor-full-audit.log` and `.build/win-04/staged-colmap-full-audit.log`.

## Windows `bin/` file table

“MATCH” compares the rebuilt file with the manifest that existed before this run. The current hashes below are recorded in the regenerated `VENDOR.json`.

| Path | Bytes | Current SHA-256 | Prior manifest |
| --- | ---: | --- | --- |
| `bin/LICENSE-Microsoft-VC-Runtime.rtf` | 9235 | `8099dc3cf9502c335da829e5c755948a12e3e6de490eb492a99deb673d883d8b` | MATCH |
| `bin/LICENSE-winpthreads.txt` | 2883 | `63263614cdd29f2f93cba85e992f041b31f9fc7b4033692f31269489a8a1b177` | MATCH |
| `bin/colmap.exe` | 68183552 | `1bfb4b9a2ee37c560666bf1744e2adfb46e0f97b849810c469ee69d7ccc6e441` | UPDATED; prior `f4710b8c5be3ca21e81fbc21e7831c3385a76469afae6b1eef2ee4e3612a1ee6` |
| `bin/libc++.dll` | 2094080 | `febfbd61d2a027ac08ed757399be8e145a68affcbf5c86c10f7d4fc28e388e03` | MATCH |
| `bin/libunwind.dll` | 203264 | `e936b0ad68c0421a0ccdb84fb3792133f0155e228d9d25a7dcb3abf5358bac3a` | MATCH |
| `bin/libwinpthread-1.dll` | 274944 | `aee4e547c0c36221a16435aa76f485735fdd49284fa83d6fa7956bebcc53f7cb` | MATCH |
| `bin/msvcp140.dll` | 557728 | `0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9` | MATCH |
| `bin/msvcp140_1.dll` | 35952 | `bfad5aef4c63a669e3c140655cdfdf395b6c979b400a447bd5dcb65ed8826c3d` | MATCH |
| `bin/onnxruntime.dll` | 14430752 | `3b46571d12a9567791a42a2b2967a79c4e2e957aacdba09a2ddb4fb391707baa` | MATCH |
| `bin/onnxruntime_providers_shared.dll` | 22040 | `1bcbad19d14bc8395c1422c752e9e4cdd79e316e2582cdcd767bb8f500cdae99` | MATCH |
| `bin/vcruntime140.dll` | 124544 | `d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066` | MATCH |
| `bin/vcruntime140_1.dll` | 49792 | `1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f` | MATCH |

`colmap.exe` is a PE32+ x86-64 Windows console executable. Its byte size is unchanged, while its PE header records the new link time `Wed Sep 9 22:16:59 2026`; this link timestamp makes the rebuilt executable legitimately non-reproducible byte-for-byte. The runtime/license closure is otherwise identical to the prior audit.

The executable imports only Windows system/UCRT APIs plus the bundled `libc++.dll`, `libunwind.dll`, `libwinpthread-1.dll`, and `onnxruntime.dll`. The exact import list is `.build/colmap-worker/build-win/colmap-imports.txt`.

## Manifest deltas requiring reviewer acceptance

The build script regenerated `vendor/colmap/win32-x64/VENDOR.json`. Exactly two of its 596 file records differ from the pre-run manifest:

| Path | Prior bytes / SHA-256 | Current bytes / SHA-256 | Reason |
| --- | --- | --- | --- |
| `bin/colmap.exe` | 68183552 / `f4710b8c5be3ca21e81fbc21e7831c3385a76469afae6b1eef2ee4e3612a1ee6` | 68183552 / `1bfb4b9a2ee37c560666bf1744e2adfb46e0f97b849810c469ee69d7ccc6e441` | PE link timestamp changed |
| `share/faiss/faiss-config-version.cmake` | 1862 / `bb49ea586f797f99772aa3cd29dcc541ece3174c2f9e4829461a8d03a3745966` | 1861 / `6652ce625b32105b81111beb93f162f182f90891fbd6d89fcb6376086c14f3d9` | Regenerated CMake package metadata under the current pinned build toolchain |

These are the complete manifest changes. The reviewer decides whether to accept the updated audit closure.

## Disk use and load qualification

| Measurement | Value |
| --- | ---: |
| Root free before build | 36 GB (`df -h /`) |
| Existing build root before build | 2.7 GB |
| Root free immediately after build | 24 GB |
| Root free after staging/audits | 25 GB |
| Final `.build/colmap-worker` | 11 GB |
| Final `build-win` subtree | 4.4 GB |
| Final vcpkg tree | 7.5 GB |
| Final vcpkg binary cache | 333 MB |
| LLVM-MinGW cache | 687 MB |
| Installed vendor payload | 187 MB |
| Staged COLMAP subtree | 187 MB |
| WIN-04 logs | 672 KB |

This was not an idle-host measurement. A parallel PhotoLab smoke and UI workload was active. During the build, that lane's `ogr2ogr` held a deleted `dense_temp.fgb` that grew to approximately 7.3 GB, briefly reducing free space to 15.2 GB; when that process closed the file, space recovered. WIN-04 stayed at four build jobs and was not interrupted.

## Files left for the architect

- `vendor/colmap/win32-x64/bin/*`: complete worker executable and audited DLL/license closure (ignored binary payload, present on disk).
- `vendor/colmap/win32-x64/VENDOR.json`: regenerated manifest with the two record deltas above.
- `.build/photolab-runtime/win32-x64/workers/colmap`: complete staged COLMAP worker subtree.
- `.build/win-04/*`: build, timing, stage, inventory, and audit logs.
- `scripts/build-colmap-worker-win-cross.sh`: pre-existing uncommitted architect changes, validated but not edited by WIN-04.
- This evidence file.

No commit was made.

## Not verified in this lane

- Full aggregate Windows runtime staging and inventory, because the independently owned Windows Geo/GDAL source tree is absent.
- Native Windows execution or CPU smoke of the rebuilt `colmap.exe`; that is assigned to the parallel smoke/Windows lane.
- Windows packaging/installer execution.

