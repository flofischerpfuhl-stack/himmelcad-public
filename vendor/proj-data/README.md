# Offline transformation grids

`de_adv_BETA2007.tif` is the official PROJ-data GeoTIFF conversion of the AdV
BETA2007 NTv2 grid for DHDN (EPSG:4314) to ETRS89 (EPSG:4258).

- Source: https://cdn.proj.org/de_adv_BETA2007.tif
- Agency notice: https://cdn.proj.org/de_adv_README.txt
- SHA-256: `46e681fcc7d022dde1db1f9d0a3426a9bfb1d4a151af69a81b3c30104c9388e2`
- License: free redistribution is allowed and welcome (AdV/PROJ-data notice)
- Coverage: Germany, 5.4166667° E–15.75° E and 46.95° N–55.35° N

PhotoLab always uses this file locally with `PROJ_NETWORK=OFF`. Its hash,
license, coverage, and selected operation are frozen into each import decision;
it is never downloaded implicitly at runtime.
