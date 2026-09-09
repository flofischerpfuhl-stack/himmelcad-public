# G1a-3b — tile-local DEM validity masks (2026-09-09)

Result: **PASS for the G1a-3b publication defect.** PhotoLab now publishes one
tile-local `bitsetLsb0` validity band for every DEM pyramid tile. Fresh DSM and
DTM packages are complete, pass the Builder package reader, and no longer
produce the G1b-fix `invalid_package` refusal. This does not close the G1c
render/pick/snap cells, and the previously reported DTM SMRF-lineage identity
gap remains open.

## Contract and implementation

- Each 512 × 512 tile owns `view/validity/Lxx/<column>/<row>.bin`, exactly
  32,768 bytes. Bits are row-major and least-significant-bit first, matching
  the existing full-grid encoding. Non-finite values, the frozen numeric NoData
  value, and padded cells outside a level's logical bounds have bit `0`.
- Every tile's `decoderParameters.validityReference` has `byteOffset: null`,
  `byteLength: 32768`, the relative tile-local URI, and that file's SHA-256.
- `view/validity.bin` remains the 524,288-byte base-grid authority cited by
  `lineage.dem_facts.validity.resource` and the package resource table.
- The canonical package publisher now validates and inventories every local
  tile mask instead of requiring it to equal the full-grid resource.
- The Builder reader resolves each tile reference relative to its content URI,
  rejects unsafe/non-local references, and requires the resolved mask's length
  and hash to agree with both the dataset and package artifact inventories.
- `dem_2048_pyramid_publishes_one_exact_validity_mask_per_tile` publishes a
  synthetic 2048 × 2048 DEM with deterministic holes. It checks all 21 masks
  over levels 0/1/2 (16/4/1), including each base tile against the corresponding
  region of the full validity bitset.

Implementation paths:

- `crates/himmelcad-sidecar/src/viewer_raster_manifest.rs`
- `crates/himmelcad-sidecar/src/project_runtime.rs`
- `crates/himmelcad-io/src/product_import_package.rs`

## Fresh read-only fixtures for Builder

Both runs used `scripts/photolab-e2e.mjs --products dem --reuse` with the
existing 24-image fast projects and the same sidecar binary built once at
`target/photolab/debug/himmelcad-sidecar` (SHA-256
`ae341ca34f718ba34fe1775d4e5396285b451a032c6c41b0cf6fd3b1c14f05b0`).
The observed stage list added only `openProject`, `start:dem`, and `wait:dem`;
alignment, depth, and dense-cloud stages were not rerun.

Timing/log records are `.build/logs/g1a3b-dsm-reuse-attempt2.{log,time}` and
`.build/logs/g1a3b-dtm-reuse.{log,time}`; the canonical results are the two
fixtures' `result.json` files.

| Surface | Product/package | Ready result | Read-only package root | Wall time | Peak RSS |
| --- | --- | --- | --- | ---: | ---: |
| DSM | entity suffix `e2e-dem-1788965948525`; `product-2868864c0c0e658f3571764507a20b82d25fcbb095f893254e25b7ee53ea7261`; package SHA-256 `e877d4b4e72409edb398fb442238b2445576fe541d4a4a142565272425288506` | `complete/available`; 92 artifacts; 23,594,699 bytes | `.build/photolab-e2e/g1a3-dsm-smoke/photolab-e2e.hcad/.photolab/product-import-packages/product-2868864c0c0e658f3571764507a20b82d25fcbb095f893254e25b7ee53ea7261/` | 9:06.44 | 4,547,940 KiB |
| DTM | entity suffix `e2e-dem-1788966535142`; `product-3d43364ef8b8740667cd94d8a26f4120994357c8e1a4569250605f36e6198fee`; package SHA-256 `d08947d81af5557ab43dd813b147584d14bbf938c943faa5bac158bbee34b0ee` | `complete/available`; 92 artifacts; 23,499,127 bytes | `.build/photolab-e2e/g1a3-dtm-smoke/photolab-e2e.hcad/.photolab/product-import-packages/product-3d43364ef8b8740667cd94d8a26f4120994357c8e1a4569250605f36e6198fee/` | 8:39.09 | 4,537,996 KiB |

The first DSM attempt failed inside the GDAL-backed dense-input preparation
after 5:54.28 (peak 4,547,976 KiB, exit 1); the wrapper exposed no GDAL
diagnostic. Its result/log was preserved, then the same bounded `--reuse`
command succeeded on the retry above. The failure record is
`.build/photolab-e2e/g1a3-dsm-smoke/attempts/failed-2026-09-09T14-50-03-579Z.json`
and its timing/log records are `.build/logs/g1a3b-dsm-reuse.{log,time}`. To
relieve disk pressure without touching sources, fixtures, or the running R-01
lane, 7.42 GiB of recoverable stale Cargo test executables under
`target/photolab/debug/deps` were removed; Cargo rebuilt what subsequent gates
needed.

## Package validation

An independent Node check opened both new package roots and, for every one of
their 21 tiles:

1. resolved the elevation and validity references;
2. required a 32,768-byte local mask with matching viewer-reference, dataset,
   package-artifact, and on-disk SHA-256/length declarations;
3. compared every mask bit with the referenced Float32 tile's finite/NoData
   state; and
4. for all 4,194,304 base-level cells, compared the tile bit with the retained
   full-grid validity resource.

Observed full resources were unchanged and remain correctly bound by
`dem_facts`: DSM `e51739bedbf7c91c33e908b05562cbbb28736f50530883116f3a03be776e7f43`,
DTM `dbff5b8beae260697004f86addbe98c427f4bad2e988841e4453cab9414c7eae`.
The new Builder-reader regression
`landed_dsm_and_dtm_accept_tile_local_validity_bands` imports both real package
roots successfully. The older two malformed fixtures continue to return the
expected typed `invalid_package` refusal.

## G1c DSM/DTM identity re-check

| Row | Re-check | Status for the G1c matrix |
| --- | --- | --- |
| DEM — DSM | New package hash is internally valid and Builder-readable. Frozen DEM config `3570a4f069f9cabced238d153ead4a70e95c66c8e53f1eb171e5a25a02604ef7`, build algorithm `57665a5a…`, camera selection `5b911a11…`, source-alignment entity/version, reference frame `EPSG:31468+7837`, and full validity resource all match the prior DSM publication. | **Publication identity re-check PASS.** Replace `product-e288ad8f…` with `product-2868864c…` for the Builder matrix. Literal UI registration/idempotence was not rerun here; render/pick/snap remain awaiting the G1c consumer/oracle pass. |
| DEM — DTM | New package hash is internally valid and Builder-readable. Frozen DEM config `7d2f36735e7ce8fb7d4f736489b281cdd4418f704cfc7fc316d85ad15357b4ec`, build algorithm `57665a5a…`, camera selection `702d882c…`, source-alignment entity/version, reference frame `EPSG:31468+7837`, and full validity resource match the prior DTM publication. The lineage still says `all_imported_cameras` and contains no SMRF or `ground_classification_sha256` identity. | **Mask/admission PASS; identity still FAIL.** Replace `product-60af8cb2…` with `product-3d43364e…` for the Builder matrix, but retain the DTM identity finding from G1b-check. Render/pick/snap remain awaiting the G1c consumer/oracle pass. |

## Verification

All Cargo commands used `CARGO_TARGET_DIR=target/photolab` and `-j 4`.

| Command | Result |
| --- | --- |
| `cargo test -p himmelcad-sidecar -j 4 viewer_raster` | **PASS**, one invocation; includes the 2048 × 2048, 21-tile exact-mask regression |
| `cargo test -p himmelcad-sidecar -j 4 dem` | **PASS**, one invocation |
| `cargo check -p himmelcad-sidecar --tests --bins -j 4` | **PASS** after the final reader-fixture addition; two pre-existing warnings in `main.rs` (`unused_mut`, dead `adaptive_job_concurrency`) |
| `cargo test -p himmelcad-io -j 4 product_import` | **PASS** final: 7/7, including both new accepted packages and both old refused packages; three invocations total (the first result stream was lost, the second observed 6/6 before adding the real-package acceptance regression, final 7/7) |
| independent Node package/mask check | **PASS**: 42/42 tile masks; 8,388,608 base cells compared across DSM + DTM; all level masks also compared with their elevation tiles; no invalid-package condition |
| `pnpm --filter @himmelcad/photolab typecheck` | **PASS**, including English UI check |
| `pnpm --filter @himmelcad/photolab test` | **PASS**: renderer 86/86, Electron 8/8, processing-report and HimmelCAD Cap contract checks passed |
| `cargo fmt -p himmelcad-sidecar -p himmelcad-io`; `git diff --check` | **PASS** |

No full DSM smoke, dataset copy, repository copy, `.build/codex-partials`
access, commit, or Builder UI import was performed. R-01 was active, so the
optional literal UI import was deliberately left to the Builder matrix owner.
