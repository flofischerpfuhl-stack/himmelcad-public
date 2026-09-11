# PhotoLab → Builder product matrix (G1c)

R1 gate 8 ("products open in Builder/WeltView") closes when every **Available**
row below passes all four checks on the landed G1b import path (Builder 437789f,
2026-09-09: V-02 native point clouds, DEM elevation surface with the validity
bitset as NoData holes, typed refusals, idempotent re-import by sha256). Rows that are
explicitly unavailable must stay unavailable with the typed reason and never
reach a consumer (DECISION-DOCTRINE D2 for this surface).

Admitted package kinds (`product_import_package.rs`): sparse, dense, dem,
orthomosaic, mesh, gaussianSplat — formats `potree@2` and
`himmelcad-prepared-hierarchy@1`. Everything else publishes
`complete/unsupported_format`.

## Checks

| Check        | Pass criterion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **identity** | `ready.json` package hash equals the recomputed hash of the package directory; lineage group carries the frozen PhotoLab source (`normalized_format_id`, alignment/tool identity, `dem_facts` where present); re-import of the same package is idempotent (no second entity, same ids); the profile is snapshot Import only (IF-D23 / ADR 0030: no continuing source dependency, no staleness lifecycle) — a re-run in PhotoLab publishes a new package that Builder imports as a new snapshot; there is no Attach. |
| **render**   | The product opens in the Builder viewport through the chooser without a manual step; potree@2 via V-02 with LOD continuity; DEM prepared hierarchy renders with the validity bitset applied as NoData (holes, not zero); colours/scale match PhotoLab's own view of the product.                                                                                                                                                                                                                                    |
| **pick**     | A point pick returns coordinates in the project CRS that agree with PhotoLab's pick on the same feature within the product's resolution (points: nearest-point distance; DEM: elevation query at a picked XY equals the DEM cell value).                                                                                                                                                                                                                                                                            |
| **snap**     | Builder snapping (0.5-04 line tool) snaps to the imported product's geometry (points: nearest point; DEM: surface elevation) with the snap latency gate of Q-01 still met.                                                                                                                                                                                                                                                                                                                                          |

## Rows

| Row                | Format                         | Status                                                  | Fixture (read-only)                                                                                                                                                                                                                                                                                                                     | identity                                                                                                          | render                                                                                                                                                        | pick                                                                                                                                     | snap                                                                                                              |
| ------------------ | ------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| sparse point cloud | potree@2                       | Available (DSM smoke 09-09)                             | `.build/photolab-e2e/g1a3-dsm-smoke/photolab-e2e.hcad/.photolab/product-import-packages/product-9ad8b322…`                                                                                                                                                                                                                              | **PASS** — [fix evidence](evidence/G1b-fix-2026-09-09.md#sparse-point-cloud)                                      | **PASS** — Frame All has non-background coloured points; [oracle check](evidence/G1b-check-2-2026-09-10.md#sparse-point-cloud) | **FAIL** — 4/7 oracle picks exceed `0.2211756253 m`; [oracle check](evidence/G1b-check-2-2026-09-10.md#sparse-point-cloud) | **FAIL** — `Snap: Point` at 7/7 but 4/7 resolve outside tolerance; [oracle check](evidence/G1b-check-2-2026-09-10.md#sparse-point-cloud) |
| dense point cloud  | potree@2                       | Available (DSM smoke 09-09)                             | same root, `product-75db7ea1…` (1.24 GB)                                                                                                                                                                                                                                                                                                | **PASS** — [fix evidence](evidence/G1b-fix-2026-09-09.md#dense-point-cloud)                                       | **NOT RUN** — free RAM below 8 GB safety gate; [oracle check](evidence/G1b-check-2-2026-09-10.md#dense-point-cloud) | **NOT RUN** — free RAM below 8 GB safety gate; [oracle check](evidence/G1b-check-2-2026-09-10.md#dense-point-cloud) | **NOT RUN** — free RAM below 8 GB safety gate; [oracle check](evidence/G1b-check-2-2026-09-10.md#dense-point-cloud) |
| DEM — DSM surface  | himmelcad-prepared-hierarchy@1 | **Blocked: invalid PhotoLab publication**               | same root, `product-e288ad8f…` (dem_facts: elevationZ, continuous connectivity, validity bitset)                                                                                                                                                                                                                                        | **BLOCKED** — typed `invalid_package`; [producer finding](evidence/G1b-fix-2026-09-09.md#dem-publication-finding) | **FAIL** — republished `2868864c…` imports but viewport is blank; [oracle check](evidence/G1b-check-2-2026-09-10.md#dsm-surface) | **FAIL** — no elevation at 7/7 valid XYs or valid centre; [oracle check](evidence/G1b-check-2-2026-09-10.md#dsm-surface) | **FAIL** — no DEM surface snap; [oracle check](evidence/G1b-check-2-2026-09-10.md#dsm-surface) |
| DEM — DTM surface  | himmelcad-prepared-hierarchy@1 | Available (republished 2026-09-10 01:39 with G1a-3c/3d) | `.build/photolab-e2e/g1a3-dtm-smoke/photolab-e2e.hcad/.photolab/product-import-packages/product-00e33bcd…` — `dem_facts.surface = dtm`, `ground_classification { sha256 a4ecae15…, algorithm_id smrf@1, parameters_sha256 234535f0… }`, tool entry `smrf@1`; older DTM packages (60af8cb2…, 3d43364e…) stay valid but lack these fields | to run                                                                                                            | **FAIL** — requested `3d43364e…` imports but viewport is blank; [oracle check](evidence/G1b-check-2-2026-09-10.md#dtm-surface) | **FAIL** — no elevation at 7/7 valid XYs; expected holes also empty; [oracle check](evidence/G1b-check-2-2026-09-10.md#dtm-surface) | **FAIL** — no DEM surface snap; [oracle check](evidence/G1b-check-2-2026-09-10.md#dtm-surface) |
| dense mesh (tiled) | himmelcad-prepared-hierarchy@1 | pending dense-mesh smoke (running 2026-09-10 14:32) | A3 publication path; the mesh derives from the completed DEM raster of the same lineage, so the product chain is depth → dense → dem → mesh (a run without `dem` refuses: "no completed raster product is available for this alignment lineage") | to run | to run | to run | to run |
| orthomosaic | himmelcad-prepared-hierarchy@1 | pending (no publisher yet) | — | **N/A** — [no fixture](evidence/G1b-check-2026-09-09.md#unavailable-rows) | **N/A** — [no fixture](evidence/G1b-check-2026-09-09.md#unavailable-rows) | **N/A** — [no fixture](evidence/G1b-check-2026-09-09.md#unavailable-rows) | **N/A** — [no fixture](evidence/G1b-check-2026-09-09.md#unavailable-rows) |
| gaussian splat     | himmelcad-prepared-hierarchy@1 | pending (no publisher yet)                              | —                                                                                                                                                                                                                                                                                                                                       | **N/A** — [no fixture](evidence/G1b-check-2026-09-09.md#unavailable-rows)                                         | **N/A** — [no fixture](evidence/G1b-check-2026-09-09.md#unavailable-rows)                                                                                     | **N/A** — [no fixture](evidence/G1b-check-2026-09-09.md#unavailable-rows)                                                                | **N/A** — [no fixture](evidence/G1b-check-2026-09-09.md#unavailable-rows)                                         |
| depth maps         | —                              | unsupported_format by design                            | DSM smoke: `complete/unsupported_format`, no package                                                                                                                                                                                                                                                                                    | must not import (typed refusal)                                                                                   | n/a                                                                                                                                                           | n/a                                                                                                                                      | n/a                                                                                                               |
| merged point cloud | potree@2                       | not a package kind yet                                  | —                                                                                                                                                                                                                                                                                                                                       | —                                                                                                                 | —                                                                                                                                                             | —                                                                                                                                        | —                                                                                                                 |

## Evidence rules

- Every cell gets a pointer: the Builder-side evidence path (screenshot, test
  name, or log) and the PhotoLab counterpart (e2e `result.json`, pick
  coordinates from the PhotoLab viewport).
- A failing cell is a defect in the lane that owns the failing side: package
  content → PhotoLab (G1a), import/registration/render → Builder (G1b/V-02).
- Rows move from "pending" to "Available" only through a smoke on a clean
  HEAD binary whose `result.json` lists the product `complete/available`.

## Oracle

Generate the PhotoLab-side numeric reference without opening PhotoLab or
starting the sidecar:

```sh
pnpm photolab:g1c:oracle -- --project <path/to/project.hcad> --out <output-directory>
```

The command reads only packages whose directory has `ready.json`. It writes
`oracle.md` first and atomically publishes `oracle.json` last, using schema
`hcad.photolab-g1c-oracle@1`. Unsupported kind/format combinations remain in
the output with an explicit skip reason. Repeating the command against an
unchanged project produces byte-identical JSON except for `generated_at`.

For sparse and dense point clouds, Builder compares the imported entity's
pick/snap world XYZ with the seven source-PLY points at indices `0`, `⌊n/8⌋`,
`⌊n/4⌋`, `⌊n/2⌋`, `⌊3n/4⌋`, `⌊7n/8⌋`, and `n − 1`. The allowed distance is
the source cloud's mean nearest-neighbour spacing, estimated from at most
10,000 points selected by an endpoint-inclusive deterministic stride. Dense
rows also compare RGB and the current classification byte; the oracle records
the hash-named classification snapshot that is byte-identical to
`dense.classification.bin`.

For DEMs, Builder queries the imported surface at the seven dense-cloud XY
positions and at the source raster's four corner-interior cell centres plus
its geometric centre. Elevation and NoData must match `oracle.json`; NoData is
decided by the manifest's `bitsetLsb0` validity authority when present. The
allowed elevation difference is the larger of half the raster data type's
vertical quantum and `0.01 m`. The Markdown file contains one paste-ready
comparison table per package.

For meshes, the oracle selects the DEM package referenced by the mesh or the
newest package with the same source alignment and processing set, falling back
to the project's newest ready DEM. It records the kernel manifest's discovered
bounds keys and values, tile and texture counts, total triangle count when the
tile index provides one, and the DEM elevations at the seven dense-cloud XY
positions plus the raster centre. The allowed elevation difference is the
larger of the DEM tolerance and one DEM cell. DEM NoData remains a mesh hole
unless `interpolateHoles` is true; interpolated holes are marked without an
elevation assertion.

The mesh table also includes the first, middle, and last POSITION vertices from
the first indexed glTF/GLB tile. The reader requires a FLOAT VEC3 accessor and
applies the glTF node world transform followed by the kernel tile transform to
report project-CRS coordinates. The applied matrices and multiplication order
are included in the oracle.
