# PhotoLab Agisoft Golden Dataset

The local `photolab/Agisoft Exampleprojects/260706_Sulzberg_SUMA_UrGel` survey is PhotoLab's first full-scale regression dataset. The multi-gigabyte source data stays outside normal build inputs; the small versioned baseline records the reference metrics and expected product geometry.

Run `pnpm photolab:golden:agisoft` to validate the source inventory, Metashape ZIP containers, camera count, GCP count, exported LAS bounds and point count, and orthomosaic CRS, dimensions, resolution, bands, and overviews. Override the dataset location with `PHOTOLAB_AGISOFT_GOLDEN_ROOT` or `--dataset`.

After a PhotoLab run, export its metrics as JSON and pass `--candidate path/to/metrics.json`. The candidate contract currently requires `alignedImages`, `reprojectionRmsPixels`, `controlSpatial3dRmseMeters`, and `checkpointSpatial3dRmseMeters`. Product-level image/cloud comparisons are added to this contract as the full golden run is automated.

The reference orthomosaic uses EPSG:31468 and a seven-parameter bound transformation. This intentionally exercises PhotoLab's warning that millimeter-grade WGS84-to-DHDN/Gauss-Krüger work requires an explicitly selected and locally validated NTv2/GTG grid.
