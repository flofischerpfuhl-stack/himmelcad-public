# PL-I1 product publishers — 2026-09-19

## Outcome

PL-I1 closes the missing package-publication implementations without widening
the release-kind contract.

| Product | Publication result |
| --- | --- |
| Orthomosaic | Publishes `orthomosaic` as `himmelcad-prepared-hierarchy@1`, with an RGB(A) raster hierarchy, plan-grid georeference facts, and tile-local LSB0 alpha-validity resources. |
| Dense mesh | The A3 path publishes `mesh` as `himmelcad-prepared-hierarchy@1`; its package inventory now includes the complete prepared hierarchy, including glTF/render buffers and hierarchy pages. |
| Gaussian splat | Publishes `gaussianSplat` as `himmelcad-prepared-hierarchy@1`, including a typed kernel manifest whose resource hashes and lengths bind the prepared splat payload. |
| Merged point cloud | **Not a release kind.** IF-D19–IF-D25 admit only `sparse`, `dense`, `dem`, `orthomosaic`, `mesh`, and `gaussianSplat`. No new kind or container was invented. |

Every successful publisher uses the shared product-package writer: artifacts
are durable before the manifest, the manifest is durable before `ready.json`,
and the publication record is written last. Failure removes the incomplete
package and does not publish a ready record. Frozen input/configuration/tool
lineage and exact artifact/package hashes remain part of the package contract.

The Builder-side package reader now admits the three added arrival shapes. It
also validates that prepared-hierarchy content references resolve to declared
artifacts with matching optional hashes and lengths. Orthomosaic admission
requires schema-v2 plan-grid mapping and exact tile-local validity bindings.

Alignment admission now returns JSON-RPC domain error `-32044` with data shaped
as follows when the configured COLMAP worker is absent or invalid:

```json
{
  "code": "colmapWorkerMissing",
  "reasonCode": "colmapWorkerMissing",
  "message": "The COLMAP worker is missing or invalid.",
  "resolvedPath": "/resolved/path/to/himmelcad-colmap-worker",
  "retryable": false
}
```

The response contains the resolved path and stable English domain text; raw OS
filesystem text is not exposed.

## Synthetic acceptance

The sidecar fixtures exercise real publication and then load each result using
`PhotoLabProductPackageProvider`:

- `publish_product_import_orthomosaic_package_is_reader_ready`
- `publish_product_import_gaussian_splat_package_is_reader_ready`
- `publish_product_import_prepared_colmap_meshes_and_export_originals`
- `publish_product_import_cancelled_inventory_never_creates_a_ready_record`
- `publish_alignment_admission_types_a_missing_or_invalid_colmap_worker`

The common assertion recomputes the package hash, checks the exact frozen
lineage and ready-record counts, confirms that `package_sha256` is the final
ready-record member, verifies that no pending package remains, and requires the
reader to return the expected prepared hierarchy. The orthomosaic fixture also
checks validity bits derived from one opaque and one transparent RGBA pixel.
The I/O fixture `product_import_reader_accepts_new_release_kinds` independently
accepts orthomosaic, mesh, and gaussian-splat typed arrivals and rejects an
orthomosaic with the old entity schema.

## Gate record

All Rust commands used `CARGO_TARGET_DIR=target/photolab` and `-j 4`. No
COLMAP, ALIKED, MVS, product, or UI smoke was run; `DISPLAY=:0` was not used.

| Gate | Result |
| --- | --- |
| `cargo test -p himmelcad-sidecar product_import -j 4` | Three development attempts. The final permitted attempt exposed the incomplete dense-mesh render inventory; that defect was fixed afterward. The same final publisher tests subsequently passed under the `publish` filter below. This filter was not run a fourth time. |
| `cargo test -p himmelcad-sidecar publish -j 4` | Passed after the final crash-order test name was included by the filter: sidecar library 26 tests, portable-MVS binary 1 test, and sidecar binary 8 tests. This includes orthomosaic, both A3 mesh variants, gaussian splat, typed missing-COLMAP admission, ready-last/cancellation, and the existing DEM publication regression. |
| `cargo test -p himmelcad-sidecar publish_alignment_admission_types_a_missing_or_invalid_colmap_worker -j 4` | Passed after extending the same test to cover invalid-worker preflight classification. |
| `cargo test -p himmelcad-io product_import -j 4` | Passed: 8 tests. |
| `cargo check -p himmelcad-sidecar --tests --bins -j 4` | Passed. One pre-existing `adaptive_job_concurrency` dead-code warning remains. |
| `pnpm --filter @himmelcad/photolab typecheck` | Passed, including the English UI check. |
| `pnpm --filter @himmelcad/photolab test` | Passed: renderer 94, Electron 10, and both contract scripts. |
| `cargo check -p himmelcad-wasm -j 4` | Passed as an additional change-surface check for the new plan-only raster mapping. |

The package-specific scratch fixtures were confined to
`.build/codex-scratch/pl-i1/`. The repository and datasets were not copied, no
new dependency was added, and no commit was created.

## Remaining release evidence

This package establishes implementation and synthetic contract acceptance. It
does not claim the G1c render/pick/snap cells or a retained all-product smoke.
Those remain explicit closing runs in the matrix and release-acceptance status.
