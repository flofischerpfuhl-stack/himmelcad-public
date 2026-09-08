# G1b — PhotoLab product-package registration evidence

Date: 2026-09-08  
Owner: `import-formats`  
Scope: PhotoLab release gate 8, ADR 0030 chain **PhotoLab publishes → Builder registers → WeltView reads**

## Result

This work lands the common Builder registration substrate for a ready PhotoLab
product package:

- the canonical I/O registry recognizes a package directory, `ready.json`, or
  `manifest.json` as `hcad.product-import-package@1`;
- import validates the exact ready-record member set and last-member rule, raw
  `manifest_sha256`, canonical `package_sha256`, manifest/ready agreement,
  lineage completeness, admitted row shape, safe paths, every declared hash and
  byte length, and prepared-root content kind before it exposes a staged result;
- IF-D28 refusals cross the sidecar boundary as typed errors with the closed
  reason code and required recovery sentence;
- commit creates the package admission as one normal canonical entity and adds
  `hcad.photolab-product-provenance@1` in that entity's immutable component
  object;
- prepared and binary payloads remain at their authoritative package paths.
  The destination inventory retains content hash, media type, byte length, and
  a sidecar-only locator. Renderer URLs and RPC results remain path-free;
- an exact repeat resolves the existing package-derived destination and returns
  its original commit without changing document generation, adding an entity,
  or appending a journal command;
- File ▸ Import, file/directory drop, console `import <path>`, and generated
  automation `file.import` all enter the existing D-02 registration job/island;
  the row label is `PhotoLab product · <product label>`;
- committed tree rows show a product-kind glyph and provenance tooltip, and
  Properties shows the read-only PhotoLab projection in 12 px monospace.

The full G1b release gate is **not closed** by this run. The producer output
available in `.build/` contains only the sparse `potree@2` package. The already
running documented G1a-3 DSM smoke is still computing depth tiles and has not
yet published dense or DEM packages. No real tiled-mesh, prepared-splat, or
merged-alignment package is present. Consequently the required real-fixture
matrix, browser-GPU DEM+dense screenshot, explicit lineage-update workflow,
and WeltView archive round trip remain unproved. Builder's current viewport
restore/island dispatch also loads `potree@2` only; the prepared Raster, glTF,
and GaussianSplats rows are validated and committed but do not yet reach their
owner render providers through that UI path.

## Real producer fixture and machine state

Fixture discovered (not copied or rewritten):

```text
.build/photolab-e2e/g1a3-dsm-smoke/photolab-e2e.hcad/.photolab/product-import-packages/product-e5cb1a6337969eeddf390cff7877137131d3c96b30874551aede4921756dd4ea
```

Its landed producer facts are:

```text
product label: Sparse Point Cloud · e2e-align-1788882383247
product kind: sparse
canonical type: hcad.point-cloud@1
prepared format: potree@2
publication generation: 3
manifest id: product-e5cb1a6337969eeddf390cff7877137131d3c96b30874551aede4921756dd4ea
manifest sha256: 14dd0c1ef64e02fbaac3fc3f1fb39028e2ef8e1493516115462a43da55b6f921
package sha256: bd5274dfa1e25ab1c7f143856742220e5a54b813b749ec129a665705b168eba2
artifact count: 10
object count: 6
declared bytes: 479983
provenance: complete
```

The documented fast smoke was already active, so a second writer was not
started. At the final fixture check at 20:07 CEST it was running:

```text
node scripts/photolab-e2e.mjs ... --max-images 24 --profile fast --products depth,dense,dem --dem-surface dsm ...
[PhotoLab E2E] e2e-depth-1788882905765 · running:Build depth tiles:300
```

Pre-Rust-gate memory check:

```text
Mem: 31 GiB total, 6 GiB used, 1 GiB free, 24 GiB available
Swap: 1 GiB total, 1 GiB used
```

The in-app Browser had no available browser session, so no visual capture could
be made. This is not substituted with a synthetic or source-code screenshot.

## Registration identity and consumer matrix for G1c

The import-owned identity is deterministic per immutable publication:
destination entity `photolab-product-<package_sha256>` and destination dataset
`photolab-<package_sha256>-0`. Package-local product, dataset, representation,
and lineage identities remain in the immutable provenance/payload records. A
new package hash therefore imports alongside the old publication by default.

| PhotoLab row | Destination identity | Render behavior | Pick / snap / edit behavior | 2026-09-08 evidence |
| --- | --- | --- | --- | --- |
| sparse `potree@2` | one `hcad.point-cloud@1`; package-derived destination id | existing V-02 Potree metadata/hierarchy/octree URL and frontier | exact resident point pick/snap; normal point-cloud entity selection/edit rules | real package validates; registration/idempotence/external-range test passes; browser-GPU capture unavailable |
| dense `potree@2` | one `hcad.point-cloud@1`; same identity rule | same V-02 frontier as sparse | same exact point pick/snap and Pointcloud rules | code path shared with sparse; real package absent |
| merged alignment `potree@2` | ordinary point-cloud identity; merge entity and ordered input identities remain only in exact lineage bytes | same V-02 frontier | same point behavior; no merge-private interaction model | core lineage validator is consumed; real package absent |
| DEM prepared Raster | one `hcad.elevation-surface@1` Grid | prepared hierarchy `raster`; every tile decoder must bind the frozen validity resource, NoData, topology, and `bilinear` interpolation | Raster-owned authoritative terrain pick/snap; Grid conversion/edit rules; validity bit `0` is never elevation authority | validator is implemented; no real package and current Builder UI restore does not dispatch the prepared Raster provider |
| open tiled mesh | one `hcad.surface-3d@1` | prepared hierarchy `gltf` | face/edge/vertex pick and snap; Surface3d selection/edit semantics; no solid-volume claim | validator/admission path implemented; real package and UI dispatch absent |
| closed tiled mesh | one `hcad.object-3d@1` | prepared hierarchy `gltf` | boundary pick/snap and Object3d transform/edit semantics; solid-volume meaning retained | validator/admission path implemented; real package and UI dispatch absent |
| prepared splat | one `hcad.gaussian-splat-cloud@1` | prepared hierarchy `gaussianSplats` | entity/bounds pick and snap, whole-entity placement; per-point editing remains typed unsupported | validator/admission path implemented; real package and UI dispatch absent |
| orthomosaic | no entity in this schema revision | none | typed `needs_preparation`; never Z=0 or a partial entity | explicit refusal path implemented |

## Gate status

| Gate | Status | Evidence / remaining work |
| --- | --- | --- |
| `G-IF-PD-1` contract | partial | Exact ready/manifest/package, complete lineage, safe resolved paths, all declared artifact hashes/lengths, prepared content kinds, and DEM facts are checked. Real sparse package and refusal tests pass. The complete disposition and malicious-path fixture corpus, unknown-field archive preservation, and every producer row fixture are still missing. |
| `G-IF-PD-2` Builder E2E | open | Real sparse package commits atomically and exact repeat is idempotent in the runtime test. File/drop/console/generated `file.import` route into D-02. No browser-GPU matrix, close/reopen/undo/redo/cancel sweep, explicit `already_registered` result envelope, `import.update.plan/execute`, or Relocate proof. |
| `G-IF-PD-3` lineage | partial | Exact lineage resource bytes are embedded in the immutable provenance component and queried by component hash; incomplete lineage refuses with `needs_republish_recompute`. Source-mutation/save/archive/export/undo test matrix remains open. |
| `G-IF-PD-4` command parity | open | Existing generated `file.import` automation accepts package paths and the generated-table test passes. The specification's dedicated `io.import.product_dataset.*` list/register/update rows and Python round trips are not implemented; the user-named `import.open` alias is not a canonical command in the current table. |
| `G-IF-PD-5` source/bounds | partial | Validation and publication stream in 1 MiB chunks with progress/cancellation; committed reads are bounded to 4 MiB and path-free. The requested package-authority behavior deliberately retains external payloads instead of copying. Busy-source leases, GC pinning, archive held-handle replacement, 100,000-row catalog, multi-terabyte/RSS/restart/preflight tests remain open. |
| `G-IF-PD-6` consumers | open | Tree badge, Properties projection, content-addressed V-02 reads, and point-cloud route are implemented. Full row render/pick/snap/edit refusal, Plan/export, archive byte preservation, automation paging, WeltView, and unsupported-sibling matrix remain open. |

Two schema gaps prevent exact visual-copy compliance without inventing truth:
ADR 0030 V1 carries `publication_generation`, not a publication timestamp, so
the tooltip states `Published by PhotoLab · generation <n> · sha <prefix>…`.
The provenance contract requires a destination registration audit but does not
define its serialized component member shape; the implementation does not
invent one. It preserves any source `registration_audit` in the exact lineage
bytes.

## Verification

Required commands were run with `CARGO_TARGET_DIR=target/builder` after `free -g`.

| Command | Result |
| --- | --- |
| `pnpm --filter @himmelcad/app test` | **PASS** — 64/64 |
| `pnpm --filter @himmelcad/builder typecheck` | **PASS** on final rerun; the first run observed a concurrent ground-extraction branded-`EntityId` error which its owner corrected |
| `pnpm --filter @himmelcad/photolab typecheck` | **PASS**, including English UI check |
| `cargo test -p himmelcad-core product` | **PASS** — 23 tests, 205 filtered; integration target 0 tests, 1 filtered |
| `cargo test -p himmelcad-sidecar import` | **PASS** on final rerun — lib 16/16, main 2/2, portable-MVS 0; the first attempt observed two transient concurrent `ColmapOutputSummary` compile errors which their owner corrected |
| `cargo test -p himmelcad-io product_import_package --lib` | **PASS** — 4 tests, 87 filtered |
| `cargo test -p himmelcad-sidecar canonical_app_runtime::tests::photolab_product_import_is_idempotent_and_keeps_package_payload_external --lib -- --exact` | **PASS** — 1 test, 308 filtered |
| `cargo test -p himmelcad-sidecar --bin himmelcad-sidecar product_import` | **PASS** — typed refusal and public-commit authority-path redaction, 2/2 |
| `pnpm registry:lint` | **PASS** — all seven checks |
| focused ESLint on Builder Electron/preload/project/App | **PASS**, zero warnings |
| targeted `git diff --check` | **PASS** at handoff, including this evidence file |

## Shared-substrate notice

All G1b changes in shared substrate are additive. Concurrent changes in these
files belong to other work packages and are not attributed here.

- `crates/himmelcad-io`: new `product_import_package` provider; registry
  registration in `canonical_builtin_import_registry`; new typed
  `ProviderContractError::ProductImportRefused` variant.
- sidecar store: `CanonicalImportInventory.external_objects`,
  `insert_external_object`, `publish_package_transaction_with_progress_and_cancel`
  product-package branch, `read_object`, `contains_object`,
  `object_byte_length`, `read_object_range`, `materialize_object`,
  `verified_object_source`, `object_source_path`,
  `external_object_reference`, and `imported_object_metadata`.
- sidecar app/RPC: `publish_staged_import`,
  `publish_staged_import_with_progress`,
  `publish_staged_import_with_progress_and_cancel`,
  `existing_product_import`, `photolab_product_provenance`,
  `read_residency_resource_range`, `handle_io_rpc`, `io_probe_prefix`,
  `handle_registration_rpc`, `product_rpc_err`, `public_import_commit`, and the
  `canonical.residency.resource.read` /
  `product.import.provenance` routes.
- `packages/@himmelcad/data/src/index.ts`: additive
  `PhotoLabProductProvenanceV1` interface.
- Builder Electron/renderer: package-aware file-or-directory selection,
  bounded inspection, path-free external CAS fallback, package job label,
  tree badge, and Properties projection.

Deliberately untouched for concurrency: command table/menus and generated
automation/Python files (S-06d), viewing-box/viewport-owner files (0.5-01),
snapshot files (S-07b), and gallery source/snapshot regeneration. These are the
integration surfaces for the remaining dedicated command, prepared-row viewport
dispatch, and serial `Product import` gallery capture.
