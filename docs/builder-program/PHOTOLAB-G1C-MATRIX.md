# PhotoLab → Builder product matrix (G1c)

R1 gate 8 ("products open in Builder/WeltView") closes when every **Available**
row below passes all four checks on the landed G1b import path. Rows that are
explicitly unavailable must stay unavailable with the typed reason and never
reach a consumer (DECISION-DOCTRINE D2 for this surface).

Admitted package kinds (`product_import_package.rs`): sparse, dense, dem,
orthomosaic, mesh, gaussianSplat — formats `potree@2` and
`himmelcad-prepared-hierarchy@1`. Everything else publishes
`complete/unsupported_format`.

## Checks

| Check        | Pass criterion                                                                                                                                                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **identity** | `ready.json` package hash equals the recomputed hash of the package directory; lineage group carries the frozen PhotoLab source (`normalized_format_id`, alignment/tool identity, `dem_facts` where present); re-import of the same package is idempotent (no second entity, same ids); Import vs Attach both register the same lineage. |
| **render**   | The product opens in the Builder viewport through the chooser without a manual step; potree@2 via V-02 with LOD continuity; DEM prepared hierarchy renders with the validity bitset applied as NoData (holes, not zero); colours/scale match PhotoLab's own view of the product.                                                         |
| **pick**     | A point pick returns coordinates in the project CRS that agree with PhotoLab's pick on the same feature within the product's resolution (points: nearest-point distance; DEM: elevation query at a picked XY equals the DEM cell value).                                                                                                 |
| **snap**     | Builder snapping (0.5-04 line tool) snaps to the imported product's geometry (points: nearest point; DEM: surface elevation) with the snap latency gate of Q-01 still met.                                                                                                                                                               |

## Rows

| Row                | Format                         | Status                       | Fixture (read-only)                                                                                        | identity                        | render | pick   | snap   |
| ------------------ | ------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------- | ------ | ------ | ------ |
| sparse point cloud | potree@2                       | Available (DSM smoke 09-09)  | `.build/photolab-e2e/g1a3-dsm-smoke/photolab-e2e.hcad/.photolab/product-import-packages/product-9ad8b322…` | to run                          | to run | to run | to run |
| dense point cloud  | potree@2                       | Available (DSM smoke 09-09)  | same root, `product-75db7ea1…` (1.24 GB)                                                                   | to run                          | to run | to run | to run |
| DEM — DSM surface  | himmelcad-prepared-hierarchy@1 | Available (DSM smoke 09-09)  | same root, `product-e288ad8f…` (dem_facts: elevationZ, continuous connectivity, validity bitset)           | to run                          | to run | to run | to run |
| DEM — DTM surface  | himmelcad-prepared-hierarchy@1 | pending DTM smoke            | `.build/photolab-e2e/g1a3-dtm-smoke/…` (fill in after the smoke)                                           | to run                          | to run | to run | to run |
| dense mesh (tiled) | himmelcad-prepared-hierarchy@1 | pending dense-mesh smoke     | A3 publication path; smoke after Q-01                                                                      | to run                          | to run | to run | to run |
| orthomosaic        | himmelcad-prepared-hierarchy@1 | pending (no publisher yet)   | —                                                                                                          | —                               | —      | —      | —      |
| gaussian splat     | himmelcad-prepared-hierarchy@1 | pending (no publisher yet)   | —                                                                                                          | —                               | —      | —      | —      |
| depth maps         | —                              | unsupported_format by design | DSM smoke: `complete/unsupported_format`, no package                                                       | must not import (typed refusal) | n/a    | n/a    | n/a    |
| merged point cloud | potree@2                       | not a package kind yet       | —                                                                                                          | —                               | —      | —      | —      |

## Evidence rules

- Every cell gets a pointer: the Builder-side evidence path (screenshot, test
  name, or log) and the PhotoLab counterpart (e2e `result.json`, pick
  coordinates from the PhotoLab viewport).
- A failing cell is a defect in the lane that owns the failing side: package
  content → PhotoLab (G1a), import/registration/render → Builder (G1b/V-02).
- Rows move from "pending" to "Available" only through a smoke on a clean
  HEAD binary whose `result.json` lists the product `complete/available`.
