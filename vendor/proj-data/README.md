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

## Germany GCG2016 / DHHN2016

`de_bkg_gcg2016.tif` is the official PROJ-data vertical grid for the transition
between ETRS89/DREF91/2016 ellipsoidal heights and DHHN2016 heights.

- Source: https://cdn.proj.org/de_bkg_gcg2016.tif
- Agency notice: `de_bkg_README.txt`
- SHA-256: `598f18324dea7f8e72421d18add7ac6228259adf91eeb335cc9c27d98484f7ac`
- License: CC-BY-4.0
- Credit: © Bundesamt für Kartographie und Geodäsie (BKG), Germany
- Coverage: 3.25625° E–15.11875° E and 47.2208333° N–55.9791667° N

This is the hash-pinned grid advertised by PhotoLab's DHHN2016 import dialog;
shipping it makes that workflow genuinely offline instead of merely describing
a missing resource.

## Saarland SeTa2016

`de_lgvl_saarland_SeTa2016.tif` is the official PROJ-data GeoTIFF
conversion of the LVGL Saarland SeTa2016 NTv2 grid for DHDN (EPSG:4314) to
ETRS89 (EPSG:4258).

- Source: https://cdn.proj.org/de_lgvl_saarland_SeTa2016.tif
- PROJ-data notice: `seta2016/de_lgvl_saarland_README.txt`
- SHA-256: `529acdef6f5634669087de3dfc7923ab0100a9a7d94fa5e5b4aadb7ec4226c6c`
- License: CC-BY-4.0; source attribution is LVGL Saarland
- Coverage: Saarland, 6.345° E–7.455° E and 49.1° N–49.6466667° N

The product owner's original source archive is intentionally not shipped. The
three small source artifacts retained in `seta2016/` provide independent audit
and regression evidence:

- `SeTa2016.gsb` — original LVGL NTv2 grid, SHA-256
  `d4f021e5cd697e9a68a42bd66e9a7a82910ad7f10d9287542acb13aa3a586d59`;
- `Produktinformation_SeTa2016.pdf` — LVGL product and redistribution notice,
  SHA-256 `92ec105298da07237ff8b0f1b5db20d2582b15df6eeb304e24cb3a56c0de2ab6`;
- `SaarlaendischeVergleichspunkte_SeTa2016.csv` — official comparison points,
  SHA-256 `c9e2f87f83d8a8c4cf8966a511ba266f6c4539613d2f1afa64d91ed4528a2960`.

The product information explicitly permits free commercial integration and
redistribution with LVGL attribution. PhotoLab nevertheless uses the smaller,
official PROJ-data conversion at runtime and keeps the original GSB only as a
test oracle.
