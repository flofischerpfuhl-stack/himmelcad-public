# ADR 0011: DEM-supported camera-based orthomosaics

- Status: accepted and implemented
- Date: 2026-07-11

## Decision

PhotoLab builds orthomosaics from undistorted source images, final camera
models, and an already published DEM. Dense-point-cloud RGB is not an
orthomosaic backend.

Orthorectification processes fixed 512-pixel tiles. Each tile considers only
overlapping cameras, limits candidates to 16, and loads images through a bounded
LRU cache. Each map pixel samples the DEM, projects into candidate cameras, and
uses bilinear source-image sampling. Users choose best view geometry, weighted
blending, or first valid camera. Bounded color balancing and one-pixel gap
filling are optional.

Every source tile receives explicit georeferencing before entering the existing
GDAL path. COG generation, raster pyramids, 2D streaming, 3D texturing,
checkpoints, and atomic publication remain unchanged.

## Invariants

- The DEM is an explicit immutable orthomosaic-job input.
- Cameras and DEM use the same projected project coordinate space.
- No network access and no implicit CRS transformation.
- Cancellation is checked at least every 16 image rows and throughout each
  GDAL process; partial results remain in transient staging.
- Working memory depends on tile and cache budgets, never total project or
  orthomosaic size.

## Not claimed

Global graph-cut seamline optimization is not part of this decision. UI copy
must describe the implemented view-geometry selection and must not claim
“seamline optimized.”
