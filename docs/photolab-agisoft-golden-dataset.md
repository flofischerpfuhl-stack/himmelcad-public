# PhotoLab Agisoft Golden Dataset

The local `photolab/Agisoft Exampleprojects/260706_Sulzberg_SUMA_UrGel` survey is PhotoLab's first full-scale regression dataset. The multi-gigabyte source data stays outside normal build inputs; the small versioned baseline records the reference metrics and expected product geometry.

Run `pnpm photolab:golden:agisoft` to validate the source inventory, Metashape ZIP containers, camera count, GCP count, exported LAS bounds and point count, and orthomosaic CRS, dimensions, resolution, bands, and overviews. Override the dataset location with `PHOTOLAB_AGISOFT_GOLDEN_ROOT` or `--dataset`.

`pnpm photolab:e2e` writes the corresponding PhotoLab candidate metrics into
`result.json`. Pass that file to
`pnpm photolab:golden:agisoft -- --candidate path/to/result.json`. The candidate
gate requires the complete 135-image Quality Hybrid workflow in horizontal
EPSG:31468 and DHHN2016 height (EPSG:7837). It checks aligned
cameras and alignment reprojection RMS; separate East, North, Height,
Horizontal, 3D and pixel RMS statistics for controls and checkpoints; and the
published sparse cloud, depth maps, dense cloud, DEM, orthomosaic, textured
mesh and Gaussian splat. Product counts, point/image/vertex/triangle/splat
counts, CRS, bounds and raster resolutions are read back from the project
manifests and cross-checked against the values reported in `result.json`.

Use the frozen golden preset for a fresh comparable candidate:

```bash
node scripts/photolab-e2e.mjs \
  --golden-agisoft \
  --output .build/photolab-e2e/agisoft-quality-hybrid-golden \
  --horizontal-grid photolab/01_Transformation/Projektionsgitter/Bayern/kanu_ntv2_schwaben.gsb \
  --vertical-grid 'photolab/01_Transformation/Geoide/DHHN 2016/GCG2016_SU.tif'
```

The preset refuses smoke subsets, profiles other than `qualityHybrid`, missing
products, a CRS other than `EPSG:31468+7837`, or non-golden raster settings. It
uses 0.015 m/px for the DEM and 0.0075199430321273 m/px for the orthomosaic.
The two grid paths remain explicit inputs and are never silently substituted.

The result contract pins the selected entity ID for every product. All selected
products must share one alignment and Processing Set lineage. Alignment counts,
sparse points, observations and reprojection RMS are checked against the
published COLMAP summary. GCP component and pixel statistics are checked against
the exact hash-pinned optimization object in the project store. The optimization
snapshot is also content-hash verified: the 79 pinned manual observations,
per-point counts, control/checkpoint roles, empty camera-prior scope and the
CSV/chunk/frame source hashes must match the frozen Agisoft observation set. DEM and
orthomosaic dimensions, geotransform bounds, resolution and canonical WKT hash
are independently read from each COG by the E2E runner and cross-checked against
its raster manifest. PhotoLab's normal-height products correctly publish the
compound GDAL CRS `EPSG:31468+7837`; the horizontal and vertical components are
validated separately. Orthomosaic bounds must contain the reference footprint
within 5 cm. Rebuildable 512-pixel tile padding is allowed by at most one tile
per edge; missing reference coverage or unbounded padding still fails.

Alignment, GCP optimization, depth, dense-cloud, DEM, orthomosaic, mesh and
splat runtimes are mandatory. Ratios against the Metashape report are
informational because the hardware differs. The separate 3,600-second Fast
alignment target is retained as a performance-regression threshold; it does not
relax the golden gate's mandatory Quality Hybrid profile.
Run `pnpm photolab:test:golden:agisoft` for the small, versioned candidate
contract fixtures; this test does not access the multi-gigabyte source survey.

The reference orthomosaic uses EPSG:31468 and a seven-parameter bound transformation. This intentionally exercises PhotoLab's warning that millimeter-grade WGS84-to-DHDN/Gauss-Krüger work requires an explicitly selected and locally validated NTv2/GTG grid.

Run `pnpm photolab:golden:grids` for the independent offline grid gate. The
versioned Saarland SeTa2016 fixture currently has a maximum horizontal residual
of 0.6974 mm and identical GSB/GeoTIFF results. When the locally supplied
`kanu_ntv2_schwaben.gsb` is present, the same command additionally validates 23
official KANU points; the current maximum is 6.3266 mm and the mean is 3.8150 mm.
The large user grid remains outside normal build inputs and is selected or
registered explicitly by the user.

The completed eight-image Fast smoke run at
`.build/photolab-e2e/smoke-8-final/result.json` exercises the entire publication
chain: 8/8 cameras aligned, 4,584 sparse points, 1,336,218 dense points, eight
depth maps, DEM, orthomosaic, textured terrain mesh and Gaussian splat. This
small, downscaled smoke proves orchestration and atomic publication; it is not a
substitute for the 135-image quality acceptance run.

The Metashape report is also the runtime reference. On its substantially faster
Intel Xeon Gold 5220R workstation with 127.63 GB RAM and an NVIDIA RTX A4000,
the 135-image job reports 2:45 for matching, 1:16 for camera alignment and 0:05
for optimization (4:06 combined). High-quality depth maps took 9:43, dense-cloud
generation 16:11, DEM reconstruction 14:51 and orthomosaic generation 5:37.
Hardware-normalized ratios are informative, while the PhotoLab Fast-profile
acceptance target on the current 31 GB / Quadro M2200 development laptop is
15–30 minutes and at most 60 minutes for fewer than 150 images.

## Metashape report ground truth

The eight-page PDF was generated by Metashape Professional 2.1.0 build 17532 on
Windows 64 bit. It records 135 aligned M4E images (5280 × 3956 px, 12.29 mm
nominal focal length), 28 m flight height, 7.5 mm/px survey GSD and 0.0144 km²
coverage. The exact effective alignment error is 0.829932 px, while the summary
page rounds it to 0.83 px. The reconstruction contains 156,158 tie points from
183,450 candidates, 970,914 projections and an average tie-point multiplicity
of 6.28765. The report's maximum residual is 62.6265 px; it is a maximum, not an
RMS value, and is therefore not used as the candidate RMS gate.

The four controls have East/North/Height/Horizontal/3D RMSE values of
0.998/2.207/3.909/2.422/4.599 mm and 0.758 px observation RMS. The two
checkpoints have 2.573/5.783/7.843/6.330/10.078 mm and 0.795 px. The PDF
truncates the point names in its detail tables, so the four control observation
counts (42, 42, 31, 42) and two checkpoint counts (39, 43) are recorded only as
aggregate sets and are not assigned to named GCPs.

The high-quality, mild-filtered reference uses 135 depth maps and at most 16
neighbours. Its dense cloud contains 59,642,494 report points; the exported LAS
contains 59,639,872 points. The DEM is reported as 10,091 × 10,465 px at
0.015 m/px with interpolation enabled and a displayed 687–723 m elevation
range. The report's in-project orthomosaic is 19,523 × 19,479 px with three
colour channels. The exported GeoTIFF is independently measured as
19,523 × 19,478 px with four bands including alpha, seven overviews and
0.0075199430321273 m/px. Those one-row and colour/alpha differences are kept as
separate report and export facts rather than treated as a contradiction.

The project metadata removes any ambiguity about Metashape's `High` label:
`BuildDepthMaps/downscale=2`, so each 5280 × 3956 M4E source is evaluated at
most 2640 × 1978 pixels. `filter_mode=0` is the reported mild filter and
`max_neighbors=16`. Point-cloud construction reuses those maps, keeps colours
and confidence, disables uniform sampling and records `max_neighbors=100`,
`points_spacing=0.1` and `resolution=0.00313357040974498`. The latter values are
reference metadata, not a permitted target-count sampler in PhotoLab.

The frozen PhotoLab golden MVS settings therefore use linear downscale 2, mild
filtering, 16 matching views and two-view geometric consistency. For this
worker that maps to a 2640-pixel maximum edge, confidence threshold 0.2 and
relative geometric tolerance 0.025. The dense job must consume the exact
published depth maps with the same settings. A cloud produced at downscale 8,
or with stricter filtering, is rejected even if its final point count happens
to match the reference.

The retained 135-image smoke cloud makes the fusion requirement measurable. At
downscale 8 (660-pixel maximum edge) it emitted 23,302,554 valid per-camera
samples. Downscale 2 has 16 times as many input pixels, projecting to roughly
372.8 million samples before overlap removal. The 59,642,494-point reference is
a factor of about 6.25 smaller, close to the report's 6.28765 average tie-point
multiplicity. Reaching the ±5% dense-count gate must therefore result from real
cross-view fusion/deduplication at the High depth scale. Lowering resolution,
raising confidence, requiring extra views or applying a target point-count cap
would be quality reduction or metric gaming and cannot satisfy the golden
contract.

The portable worker now publishes this as auditable fusion evidence rather
than treating the final Potree count as proof. It derives one scene voxel edge
from the median representative depth-pixel footprint (`depth / sqrt(fx*fy)`
after the configured image downscale), retains the local footprint on every
sample, and merges only position- and normal-consistent samples. Position,
colour, confidence and normals are confidence-weighted. Raw samples are
externally sorted in bounded chunks and merged in canonical voxel/sample order,
so changing the chunk size cannot change the output bytes. Image-boundary
checkpoints make cancellation and resume safe without publishing a partial
cloud. Golden validation requires the stable algorithm identifier, raw and
fused counts, footprint range, voxel size, external-run count and memory bound;
it rejects a matching final point count when that artifact evidence is absent.

The memory figures are rounded display values from the PDF, not byte-precise
measurements: 998.34 MB matching, 2.88 GB alignment, 4.68 GB depth, 17.93 GB
dense cloud, 8.98 GB DEM and 2.39 GB orthomosaic. The baseline preserves their
reported units and does not manufacture exact byte counts from them.

## Current full-publication diagnostic

`.build/gcp-dewarp-debug/result.json` is the first retained 135-image Fast run
that published every requested product, but it is a smoke/debug configuration,
not a golden quality candidate. It reports 135/135 aligned cameras, 24,736
sparse points, 135 depth maps, 23,302,554 dense points, DEM, orthomosaic,
terrain mesh and Gaussian splat. Alignment took 1,637.133 seconds (27:17),
inside the explicit 60-minute Fast ceiling on the development laptop.

Its other timings were 4,893.063 seconds for depth, 833.768 seconds for dense
cloud, 254.238 seconds for DEM, 627.628 seconds for orthomosaic, 0.884 seconds
for mesh and 27.354 seconds for splats. Ratios to the Metashape workstation are
6.655×, 8.393×, 0.859×, 0.285× and 1.862× for alignment, depth, dense, DEM and
orthomosaic respectively. The apparently faster dense and DEM stages are not a
quality advantage: the dense cloud has only 39.1% of the reference point count,
the 0.25 m DEM is 16.7× coarser and the 0.2 m orthomosaic is 26.6× coarser.

The diagnostic also reports 1.00585 px reprojection RMS, a zero control 3D RMSE
without the required component statistics, and 8.686 mm checkpoint 3D RMSE.
It declares candidate EPSG:25832 while its raster manifests declare the
compound `EPSG:31468+7837` reference. These facts make its residuals, raster
bounds and 35.1% valid-pixel fraction non-comparable to the EPSG:31468 golden
contract. The validator rejects this legacy result before quality acceptance
because it lacks hash-pinned GCP/alignment/raster evidence and declares a
different project frame. Its compound raster CRS is itself valid, but it does
not match the run declaration; the coarse raster settings are also
incomparable.

The first 24-image PhotoLab Fast baseline aligned 24/24 cameras with 18,907
sparse points and 0.555 px reprojection RMS, but took 6,176 seconds. Profiling
showed full-resolution CPU ALIKED inference and repeated extractor startup as
the bottlenecks. This result is retained as a performance regression baseline,
not accepted as the final Fast-profile runtime.

The optimized Fast path uses one batched native SIFT extraction at a 2,400 px
maximum edge, a 4,096-feature budget, four-worker sequential matching and only
invokes ALIKED/LightGlue as a failed-reconstruction rescue. Its independent
24-image regression run at
`.build/photolab-e2e/fast-sift-24-perf/result.json` aligned 24/24 cameras with
0.724 px reprojection RMS in 398.660 seconds (6:39), a 15.5-fold runtime
improvement over the retained baseline.

The first exact 135-image Schwaben NTv2, GCG2016_SU and GCP run exposed a
candidate-order defect: immutable calibration-group IDs had reordered the
materialized image paths before COLMAP's sequential matcher. The retained
`.build/photolab-e2e/agisoft-full-fast-final/result.json` diagnostic took
1,897.338 seconds (31:37) and registered only 127/135 cameras. It is useful for
regression archaeology, but it is superseded by the corrected run below.

The current canonical Fast diagnostic is
`.build/photolab-e2e/agisoft-full-dewarp-gk4/result.json`. The corrected path
layout keeps calibration partitions intact while ordering their directories by
the first source image. It registered 135/135 cameras, 26,951 sparse points and
171,009 valid observations at 0.965733 px mean reprojection error. The retained
recovery job reports 1,422.416 seconds; approximately 739 seconds of SIFT
extraction happened in the preceding interrupted job, so the cumulative sparse
work is about 2,161 seconds (36:01), not merely the recovery-job duration.

The robust GCP optimization used the exact 79 pinned manual observations from
the Agisoft frame: 15/13/12/11/15/13 observations for points `.001` through
`.006`. Points `.001` and `.005` are checkpoints; the other four are controls;
camera-reference priors are empty. The source observation-set SHA-256 is
`32205e6ae087c23a31f2fdec22be4ab66aeef96e221881a83ff96679916c9f15`,
the immutable PhotoLab snapshot is
`43b368c539e57b5551728c9dafa336dfe8421507dc6d3180504a974ed4d91c3f`,
and the published optimization artifact is
`57d6fac504148f88e2be431f64c6f74a4611fc268b78ba3902b066c907303da5`.
It reports 4.371 mm control 3D RMSE at 0.697 px and 8.357 mm checkpoint 3D
RMSE at 0.611 px. Those GCP figures pass the frozen Agisoft thresholds, while
the 0.965733 px alignment reprojection error does not pass the 0.829932 px gate.
The result declares `profile: fast` and `goldenAgisoft: false`; it therefore
remains a diagnostic regardless of later products. Only a complete
`Quality Hybrid` run produced with `--golden-agisoft` can be accepted. No full
135-image PhotoLab result with every required product has passed that gate yet.

`Quality Hybrid` retains independent ALIKED/LightGlue and SIFT graphs for every
edge of its frozen candidate graph, but uses a bounded 24-neighbour flight
sequence graph instead of quadratic exhaustive matching. `Maximum Robustness`
remains the explicit exhaustive-pair profile.
