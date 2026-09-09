# WIN-05 — PhotoLab import → align → sparse on Windows (DESKTOP-BNB2PBA), 2026-09-10

Run 23:57–00:34 CEST via the remote Codex channel with the staged workers (COLMAP cross-built in WIN-04, PROJ/GDAL geo, DeDoDe) and the Sulzberg 24-image source; report and screenshots on the host under `.build\win-05\`.

| Step | Result |
| --- | --- |
| Staged workers (`colmap.exe -h`, `projinfo.exe`, `cct.exe`) | PASS |
| Sidecar startup with PROJ root and `HIMMELCAD_COLMAP_EXECUTABLE` | PASS (probes) |
| Project create, image inspect, CRS discovery/freeze, atomic commit of 24 images | PASS |
| `photolab.jobs.startAlignment` | **REFUSED** — typed `-32042 / insufficientDisk`: the Windows free-space probe parses localized `fsutil` output (German) and believes 784 bytes are free (~25 GB actually free) |
| COLMAP discovery / launch, sparse publication | not reached |
| PhotoLab UI | project opens, SwiftShader WebGL2 viewer works, Jobs tab "No jobs yet", no sparse product row |

Defect (PhotoLab lane, B4 disk preflight): locale-dependent parsing of tool output on Windows; fix = Win32 free-space API, no parsing. WIN-05 reruns after the fix; everything else on the PC is in place.
