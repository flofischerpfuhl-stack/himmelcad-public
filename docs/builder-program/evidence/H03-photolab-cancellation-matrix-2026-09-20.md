# H03 — PhotoLab cancellation matrix on the HEAD release sidecar (2026-09-19/20)

Run by the architect as capped user units (MemoryMax 18 G, CPUQuota 600 %, Nice 10, no core dumps; no Codex): `.build/photolab-runtime/run-cancel-matrix.sh` — one fresh `scripts/photolab-e2e.mjs` run per stage on the 24-image Sulzberg set, profile fast, `--cancel-stage <stage> --cancel-after-units 1` (raster/mesh/splat with `--smoke`). ALIKED/DeDoDe stages were not run on this laptop (memory rule).

| Stage | Observed stage | Ack ms | Terminal state | Terminal ms | Error |
| --- | --- | --- | --- | --- | --- |
| sift | Extract SIFT | 9 | cancelled | 1016 |  |
| mapper | — | — | — | — | Error: Cancellation stage was not observed: mapper |
| mvs | Prepare MVS scene | 40 | cancelled | 1051 |  |
| raster | pyramid:0:0:0 | 8 | cancelled | 1015 |  |
| mesh | — | — | — | — | Error: no completed raster product is available for this alignment lineage |
| splat | — | — | — | — | Error: Cancellation stage was not observed: splat |

Open: `mapper` — the harness never observed the stage on 24 images (it completes between progress polls; harness issue or label mismatch, to be decided). `mesh` — the run stopped before the mesh job with "no completed raster product is available for this alignment lineage" although `dem` was requested; H01 built the mesh after the DEM without error, so this is either the harness's job ordering under `--cancel-stage mesh` or an admission defect — needs a look before the row can close. Logs: `.build/logs/h03-cancel-<stage>.log`; results: `.build/photolab-e2e/h03-cancel-<stage>/result.json`.
