# WIN-23 / WIN-23b — ADR 0032 split on Windows (DESKTOP-BNB2PBA), 2026-09-24

- **WIN-23 (commit 224e381):** MSVC build failed — `himmelcad-document` used
  `tracing::debug!` under `cfg(windows)` without the dependency (introduced by
  step 4a; Linux gates never compile that branch). Fixed in 7f7d4a8; every split
  gate now includes `cargo check --target x86_64-pc-windows-gnullvm` on Linux.
- **WIN-23b (commit 8e77b9a):** MSVC release build of `himmelcad-builder-sidecar`
  (25.5 MB), `himmelcad-photolab-sidecar` (40.5 MB) and the PhotoLab-only
  `himmelcad-portable-mvs` (1.8 MB) passed. `--list-routes`: Builder 81/81,
  PhotoLab 115/115 against the golden filtered by product.
- Headless start of the direct MSVC binaries, one `ping` line, stdin closed:
  Builder `{"ok":true}`, exit 0 in 0.30 s; PhotoLab exits with "offline PROJ
  worker is missing; set HIMMELCAD_PROJ_ROOT" unless the staged geo worker is
  configured, then `{"ok":true}`, exit 0 in 0.24 s (pre-existing start-up
  contract; the packaged app provides the worker path).
- The frozen-corpus replay failed on Windows because the lifecycle fixture put a
  raw backslash path into JSON — a test-harness defect, fixed in c70df55.
- Official Windows packaging did not run on the PC: both pipelines require the
  pinned LLVM-MinGW toolchain used by the Linux cross-build. Windows packages are
  produced by that cross-build; installer/signing verification stays with R10.
- Owner files untouched; C: 83.3 GB free afterwards. Full logs on the PC under
  `C:\Users\flori\source\HimmelCAD\.build\win-23\` and `…\win-23b\`.
