# PL-B1b — Windows-safe durability and Builder DEM residency (2026-09-11)

## Outcome

The four Builder-owned read-only synchronization sites now use the shared
`durable_fs` contract. On Windows, file synchronization opens an existing file
with read and write access and directory synchronization is the documented
no-op; Unix retains `File::open(...).sync_all()` for both files and directories.

The exact republished DSM `product-2868864c…` and current DTM
`product-00e33bcd…` were imported through the visible Builder chooser and are
resident prepared raster hierarchies after reopen. Their tile-local elevation
and `bitsetLsb0` validity resources stream through the shared R-02d prepared
dataset path. Valid samples render and return elevation picks; NoData cells are
transparent and return no pick.

The prescribed gate set is qualified rather than wholly green: every
correctness/build/type/UI gate passed, but the canonical-store machine timing
test missed its fixed 100 ms gesture-to-durability-ack p95 ceiling on all three
permitted invocations (2.431 s cold, then 118.465 ms and 112.844 ms). Its other
19 canonical-store tests passed on every invocation.

No fixture or PhotoLab-owned source was changed, and no commit was created.

## Durability change surface

- `canonical_project_store.rs`: the transaction `ready.json` flush, staged
  `journal.json` flush, and transaction/canonical journal directory flushes now
  delegate to local wrappers over `durable_fs::sync_file` and
  `durable_fs::sync_dir`. The unit test
  `transaction_file_and_directory_sync_helpers_are_platform_safe` exercises
  both transaction files and the directory helper.
- `brush_runtime.rs`: completed brush checkpoints now go through
  `sync_checkpoint_file`, which delegates to `durable_fs::sync_file`. The unit
  test `durable_checkpoint_sync_helper_uses_a_platform_safe_file_handle` exercises that
  call site.
- `durable_fs.rs`: the file and directory helper tests now compile and run on
  Windows too; only the Unix permission-mode assertion remains Unix-only.

The requested multiline grep over `crates/himmelcad-sidecar` and
`crates/himmelcad-core` found no additional unguarded Builder-owned read-only
file flush. Remaining matches were classified as follows:

| Match | Classification |
| --- | --- |
| `durable_fs.rs:21-23` | Intentional Unix implementation of `sync_file`; Windows uses `OpenOptions::read(true).write(true)` |
| `durable_fs.rs:32-34` | Intentional Unix-only directory flush; Windows branch is a no-op |
| `image_commit.rs:1042-1050` | Unix-only directory flush; non-Unix is already a no-op |
| `gcp_runtime.rs:1459-1469` | Unix-only directory flush |
| `gcp_optimization_runtime.rs:341-344` | Unix-only directory flush |
| `job_runtime.rs:3397-3401` | Unix-only test directory flush |
| `project_archive.rs:729-740` | Unix-only directory flush; non-Unix is already a no-op |
| `gcp_local_estimate_runtime.rs:177-179` | PhotoLab-owned GCP local-estimate cache path; deliberately not edited under this work package |
| `brush_runtime.rs:1878-1881`, portable-MVS copy | False positives: `sync_all` is called on the newly created writable output handle, not the read-only input |

## DEM residency fixes

This work extends the R-02d prepared-hierarchy registration already used by
`hcad.pointcloud.height-grid@1`; it does not add another bootstrap path.

Two downstream defects had hidden behind the earlier missing dataset binding:

1. PhotoLab's valid whole-file raster side-band references carry
   `byteOffset: null` and a known positive `byteLength`. The streaming driver
   accepted only null/null or integer/integer references, so it rejected the
   elevation/validity references as malformed. `validByteReference` now admits
   null offset plus either null or a positive safe-integer length. The viewer
   regression uses known whole-file lengths for elevation, validity, and
   confidence while retaining hash verification and packed worker input.
2. A leaf whose validity mask rejects every triangle decoded correctly to an
   empty raster mesh, but the generic GPU batch builder rejected it as
   `GPU draw batch is empty`. Raster publication now commits such a tile as a
   zero-GPU-cost resident raster proxy with bounds and pick ownership but no
   draw batch. This lets REPLACE refinement cover the leaf transparently. Mesh,
   point, and non-empty raster validation is unchanged. The focused WASM unit
   test `raster_without_admitted_triangles_is_valid_transparent_coverage`
   passed, and the exact DTM `L00/0/0` leaf changed from failed upload to
   resident transparent coverage.

The landed-package reader and Builder catalog tests also include the exact DTM
package so its frozen `dem_facts`, SMRF ground-classification lineage, format,
and package hash stay covered.

## Literal Builder verification

Both read-only packages were selected through **File → Import… options →
PhotoLab product dataset → Choose… → native directory chooser → Import** on
`DISPLAY=:0`. The reopened canonical projects contain the exact immutable
identities:

| Product | Manifest id | Package SHA-256 | Resident dataset id |
| --- | --- | --- | --- |
| DSM | `product-2868864c0c0e658f3571764507a20b82d25fcbb095f893254e25b7ee53ea7261` | `e877d4b4e72409edb398fb442238b2445576fe541d4a4a142565272425288506` | `photolab-e877d4b4e72409edb398fb442238b2445576fe541d4a4a142565272425288506-0` |
| DTM | `product-00e33bcd9b10cdb78c509648562488508c5263bfa8ed0dd249fec77ffb46a06c` | `7579d65aed2260712ece0834bfe817c58d4dcd24ff83d5e5c5b24ff66fa83a05` | `photolab-7579d65aed2260712ece0834bfe817c58d4dcd24ff83d5e5c5b24ff66fa83a05-0` |

The unattended Electron window was rAF-throttled and the laptop adapter was
classified I. A 512×512 DEM leaf is larger than that class's refinement-lane
upload allowance, so the verification held full quality and asked the existing
hardware-policy resolver for its canonical D-class budget. This changes only
the test-time budget, not product code or decoded values. Numeric results came
from Builder's public kernel pick path in the live viewport; a separate visible
Draw → Line hover pass reported `Snap: Face` at all seven valid dense-sample XYs
for both products and `Snap: —` at every DTM NoData probe.

- DSM chooser: `../../../.build/pl-b1b/screenshots/dsm-01-chooser.png`
- DSM render with visible masked boundaries: `../../../.build/pl-b1b/screenshots/dsm-03-render.png`
- DSM numeric log: `../../../.build/pl-b1b/logs/dsm-oracle.json`
- DSM visible Line snap log/screenshot: `../../../.build/pl-b1b/logs/dsm-ui-oracle.json`, `../../../.build/pl-b1b/screenshots/dsm-06-ui-oracle.png`
- DTM chooser: `../../../.build/pl-b1b/screenshots/dtm-01-chooser.png`
- DTM centre-hole view: `../../../.build/pl-b1b/screenshots/dtm-05-oracle.png`
- DTM numeric log: `../../../.build/pl-b1b/logs/dtm-oracle.json`
- DTM visible Line snap log/screenshot: `../../../.build/pl-b1b/logs/dtm-ui-oracle.json`, `../../../.build/pl-b1b/screenshots/dtm-06-ui-oracle.png`

### DSM `product-2868864c…`

Tolerance: 0.01 m. Maximum absolute delta across the seven requested dense XYs
is 0.0088501 m.

| Sample | Oracle Z (m) | Builder Z (m) | Builder − oracle (m) | Result |
| --- | ---: | ---: | ---: | :---: |
| dense point 0 | 705.146728515625 | 705.137878417969 | -0.008850097656 | **PASS** |
| dense point 5734032 | 705.406188964844 | 705.406188964844 | -0.000000000000 | **PASS** |
| dense point 11468064 | 707.913940429688 | 707.913940429688 | -0.000000000000 | **PASS** |
| dense point 22936129 | 710.771728515625 | 710.771728515625 | 0.000000000000 | **PASS** |
| dense point 34404193 | 706.335876464844 | 706.335876464844 | -0.000000000000 | **PASS** |
| dense point 40138225 | 706.114318847656 | 706.114318847656 | 0.000000000000 | **PASS** |
| dense point 45872257 | 706.751770019531 | 706.751770019531 | 0.000000000000 | **PASS** |
| centre (oracle-valid) | 711.572204589844 | 711.572204589844 | -0.000000000000 | **PASS** |

All four oracle corner-interior NoData probes returned no candidate. Final
streaming state: 18 resident entries, 15 draw calls, 3,577,567 triangles, zero
failed entries, and an empty recent-failures list.

### DTM `product-00e33bcd…`

Tolerance: 0.01 m. All seven requested valid dense XYs agree to the precision
retained in the log (maximum absolute delta below 5×10⁻¹³ m).

| Sample | Oracle Z (m) | Builder Z (m) | Builder − oracle (m) | Result |
| --- | ---: | ---: | ---: | :---: |
| dense point 0 | 704.836608886719 | 704.836608886719 | -0.000000000000 | **PASS** |
| dense point 5721617 | 704.955139160156 | 704.955139160156 | 0.000000000000 | **PASS** |
| dense point 11443235 | 705.047668457031 | 705.047668457031 | 0.000000000000 | **PASS** |
| dense point 22886470 | 704.976196289062 | 704.976196289063 | 0.000000000000 | **PASS** |
| dense point 34329705 | 705.611694335938 | 705.611694335938 | -0.000000000000 | **PASS** |
| dense point 40051323 | 705.155273437500 | 705.155273437500 | 0.000000000000 | **PASS** |
| dense point 45772940 | 706.150329589844 | 706.150329589844 | -0.000000000000 | **PASS** |

The four corner-interior probes and centre are genuine oracle NoData cells;
all five returned no candidate and visible Line status `Snap: —`. Final
streaming state: 19 resident entries, 17 draw calls, 2,835,944 triangles, zero
failed entries, and an empty recent-failures list.

## Gates

| Gate | Result |
| --- | --- |
| `cargo test -p himmelcad-sidecar durable -j 4` in `target/builder` | **PASS**, final 13/13 (second invocation after naming the brush helper regression into the required filter) |
| `cargo test -p himmelcad-sidecar canonical_project_store -j 4` in `target/builder` | **TIMING FAIL**, 19/20 correctness tests pass on each of three allowed runs; machine p95 2.431 s, 118.465 ms, 112.844 ms vs 100 ms |
| `cargo check -p himmelcad-sidecar --tests --bins -j 4` in `target/builder` | **PASS**; pre-existing `adaptive_job_concurrency` dead-code warning |
| `pnpm --filter @himmelcad/builder test` | **PASS**, 47/47 |
| `pnpm --filter @himmelcad/viewer test` | **PASS**, 165/165 |
| `pnpm --filter @himmelcad/app test` | **PASS**, 80/80 |
| `pnpm --filter @himmelcad/builder typecheck` | **PASS** |
| `pnpm --filter @himmelcad/photolab typecheck` | **PASS**, including English-UI check |
| `pnpm --filter @himmelcad/photolab test` | **PASS**, renderer 87/87, Electron 10/10, both contract scripts |
| `pnpm --filter @himmelcad/theme lint:tokens` | **PASS** |
| Focused `himmelcad-wasm` transparent-raster test | **PASS**, 1/1 |
| Formatting / whitespace | targeted `cargo fmt` and `git diff --check` pass |

No gate was invoked more than three times. A native Windows run was not made:
the Windows lane accepts repository changes only through Git, while this work
package explicitly forbids committing. Windows behavior therefore rests on the
already-landed `durable_fs` platform branch plus the newly cross-platform unit
coverage; live Windows execution remains unclaimed.

## Changed surfaces

- `crates/himmelcad-sidecar/src/canonical_project_store.rs`
- `crates/himmelcad-sidecar/src/brush_runtime.rs`
- `crates/himmelcad-sidecar/src/durable_fs.rs`
- `packages/@himmelcad/viewer/src/kernel/KernelStreamingDriver.ts`
- `packages/@himmelcad/viewer/test/kernel-streaming-driver.test.ts`
- `crates/himmelcad-wasm/src/lib.rs`
- `crates/himmelcad-io/src/product_import_package.rs`
- `apps/builder/test/productImportCatalog.test.ts`
- `docs/builder-program/PHOTOLAB-G1C-MATRIX.md` (Builder columns only)
