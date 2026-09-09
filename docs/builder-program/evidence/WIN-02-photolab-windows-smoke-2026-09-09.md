# WIN-02 — PhotoLab Windows smoke (DESKTOP-BNB2PBA), 2026-09-09

Run 17:50–18:39 CEST on branch `win/fsync-durability` (1933da2, since merged into main as f3241da) via the remote Codex channel. Full report, logs and screenshots on the host under `.build\win-02\`.

| Step | Result |
| --- | --- |
| Sidecar + portable MVS release build (`target\win`) | PASS (19 min) |
| PhotoLab application build (`pnpm --filter @himmelcad/photolab build`) | PASS — release viewer wasm staged, 1 803 modules |
| Electron PhotoLab shell + Jobs tab | PARTIAL — shell renders and Jobs tab opens ("No jobs yet"); status bar `Core unavailable`; viewer session fails |
| Import → align → sparse | BLOCKED before import — no Sulzberg images on the host, no Windows COLMAP, no offline PROJ runtime |

Windows defects and gaps:
1. **Dev sidecar path without `.exe`** — `apps/photolab/electron/sidecar.ts:44` returns `target/debug/himmelcad-sidecar` in development; Windows needs the platform-aware name (PhotoLab-owned path; bounded fix + Windows Electron test).
2. **No offline Windows PROJ runtime** — the sidecar fails closed (`offline PROJ worker is missing; set HIMMELCAD_PROJ_ROOT`), correct behaviour, but the pinned PROJ/GDAL runtime must be staged from the repository's audited pipeline and pointed to by `HIMMELCAD_PROJ_ROOT` for development.
3. **Vega 8: Chromium GPU process exits (`exit_code=34`) three times, then `Failed to create surface for any enabled backend … webgl2 not available`** — the shared viewer has no fallback path on this iGPU/driver (31.0.12027.9001); needs a reproduction with GPU diagnostics and a tested fallback (Builder lane, shared viewer; package V-08).
4. Native Computer Use harness pipe unavailable on the host (test-harness defect; CDP was used instead).

Inputs missing for the smallest Windows workflow: Sulzberg 24-image source; `vendor\colmap\win32-x64\bin\` COLMAP bundle (only VENDOR.json present); offline PROJ worker (`projinfo.exe`, `cct.exe`, `proj.db`, grids). Present: `himmelcad-sidecar.exe`, `himmelcad-portable-mvs.exe`, Brush, the four COLMAP ONNX models. For the full release gate additionally: staged runtime root `.build\photolab-runtime\win32-x64`, PotreeConverter, DeDoDe embedded Python + ONNX Runtime/NumPy, GDAL tools/data, MSVC/LLVM-MinGW runtime closure, cross-target `x86_64-pc-windows-gnullvm` artifacts. First packaging-audit failure: `required release input is missing: .build\photolab-runtime\win32-x64\workers\colmap`.

Next: WIN-03 — transfer the Sulzberg subset, stage COLMAP/PROJ/GDAL for win32-x64 with the audited scripts, fix the dev sidecar path, rerun import → align → sparse; V-08 — Vega 8 viewer fallback.
