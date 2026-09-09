# WIN-03 — PhotoLab core on Windows: staged runtime, dev sidecar path, import smoke, Vega 8 diagnostics (DESKTOP-BNB2PBA), 2026-09-09

Run 21:54–23:20 CEST via the remote Codex channel; full report and screenshots on the host under `.build\win-03\` (report fetch over SSH failed afterwards: the host stopped accepting SSH sessions under load — the log `.claude/codex/out/remote-win-03.log` carries the printed report).

| Item | Result |
| --- | --- |
| Dev sidecar path fix (`apps/photolab/electron/sidecar.ts`, `.exe` on win32, `HIMMELCAD_SIDECAR_BIN` override, Windows Electron test) | DONE — committed on branch `win/photolab-dev-sidecar-path` (bundle `.build\win-03\dev-sidecar.bundle`, not yet fetched: SSH unreachable) |
| Sidecar startup with `HIMMELCAD_PROJ_ROOT=<repo>\.build\photolab-runtime\win32-x64\workers\geo` (+ `PROJ_DATA=…\share\proj`) | PASS — both probes; expected layout `bin\projinfo.exe`, `bin\cct.exe`, `share\proj\proj.db` |
| PhotoLab dev UI | PASS — `Core ready`, project opened, `Images: 24` (Sulzberg) imported through the e2e up to image commit; shell, imported-images and Jobs screenshots captured |
| Alignment without the COLMAP worker (`HIMMELCAD_COLMAP_EXECUTABLE` pointing at the not-yet-transferred `workers\colmap\bin\colmap.exe`) | Sidecar stays alive but answers a generic JSON-RPC `-32000` with localized filesystem text — **no typed reason** (PhotoLab finding: add `colmapWorkerMissing`) |
| Vega 8, `--use-angle=d3d11` | PARTIAL — WebGL2 surface works, product viewer selected WebGPU, one GPU-process crash (`exit_code=34`) then readback/software mode |
| Vega 8, `--use-gl=angle --use-angle=swiftshader` | PASS as fallback — no crash, product viewer on WebGL2, WebGPU unavailable; slow with large p95/max frame spikes; Electron deprecates automatic software WebGL (`--enable-unsafe-swiftshader`) |

Consequences: V-08 (Builder, shared viewer) — detect the D3D11 GPU-process crash and fall back to the ANGLE/SwiftShader path automatically with a visible "software rendering" state; PhotoLab — typed refusal when the COLMAP worker is missing. WIN-05 (import → align → sparse with the staged COLMAP worker) runs once the worker transfer and SSH access recover.
