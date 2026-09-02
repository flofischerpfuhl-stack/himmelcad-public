# Agisoft Metashape reference dossier (PhotoLab A2 evidence)

Status: reference dossier, 2026-09-02. Evidence for FUNCTION-CONTRACT A2
claims in `docs/implementation-plans/2026-09-photolab-release-polish.md`.
A dossier is evidence, never normative. Baseline: Metashape Professional
2.3.2 build 22956 (25 Aug 2026); 2.2.3 is the previous branch.

Sources (verified 2026-09-01): Metashape Professional features page
(https://www.agisoft.com/features/professional-edition/); change log through
2.3.2 (https://www.agisoft.com/pdf/metashape_changelog.pdf); Professional
User Manual 2.2, Appendix B formats and Appendix D camera models
(https://www.agisoft.com/pdf/metashape-pro_2_2_en.pdf); downloads page
(https://www.agisoft.com/downloads/installer/); agisoft-llc/metashape-scripts
`export_for_gaussian_splatting.py`. Measured survey outputs for the Sulzberg
dataset are in `docs/photolab-agisoft-golden-dataset.md` (pinned Metashape
run), which remains the only accuracy evidence.

| Step               | Metashape behavior (source)                                                                                                                                                                              | PhotoLab disposition in the plan                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Add photos         | JPEG/JP2/JXL/TIFF/PNG/BMP/EXR/TGA/PGM/DNG; multispectral/thermal/rigs; video import with frame extraction and GPS from SRT/GPX; laser scans as input; AI/depth masks (features page; change log 2.1–2.3) | Adopt image formats + video frames (WP-C5); defer multispectral, laser scans (not R1)             |
| Camera calibration | Brown model f, cx, cy, K1–K4, P1, P2, B1, B2; frame/fisheye/spherical types; rolling shutter; ~12 calibration exchange formats (manual Appendix D)                                                       | Adopt FULL_OPENCV seeding + lab-calibration entry (WP-D4); defer fisheye/rolling shutter (not R1) |
| Align photos       | accuracy presets; generic/reference/sequential preselection; key/tie limits; guided matching; adaptive fitting (manual ch. 3)                                                                            | Presets adopted (WP-C1); reference (GPS) preselection is the WP-A5 lever                          |
| Reference          | per-camera GPS/IMU with individual accuracies; GCP control vs check; scale bars; coded targets (manual ch. 4)                                                                                            | Per-point σ adopted (WP-E3); scale bars/targets deferred (not R1)                                 |
| Optimize cameras   | selectable parameters; gradual selection by reprojection error / reconstruction uncertainty / projection accuracy; residual plots; correlation matrix in report                                          | Transparency-first inspector (WP-E1); gradual-selection editing parked (WP-E2)                    |
| Chunks / merge     | duplicate/merge/align chunks by points, markers or cameras                                                                                                                                               | Deliberately different model (ADR 0014): explicit merge with evidence (WP-D1/D3)                  |
| Depth maps / dense | quality presets; filtering aggressive/moderate/mild; confidence; ML classification; Classify Ground for DTM                                                                                              | DTM via SMRF ground classification (WP-A4); ML classification deferred                            |
| Mesh / texture     | from depth maps / dense / tie points; arbitrary vs height field; close holes, decimate, refine; texture mapping/blending modes                                                                           | Mesh from dense stage 1 (WP-A3); texture blending deferred                                        |
| DEM / orthomosaic  | point-class DSM/DTM; breaklines; seamline editing; colour calibration; COG/ASC/XYZ/GPKG exports                                                                                                          | COG adopted; seamlines explicitly not claimed (ADR 0011)                                          |
| Report             | PDF with survey stats, per-group calibration + correlation matrix, GCP RMSE tables, residual plots                                                                                                       | Report v2 (WP-A2) adopts survey overview, calibration tables, residual map                        |
| Exports            | point cloud LAS/LAZ/COPC/E57/PLY/OBJ; mesh OBJ/FBX/GLB/STL; cameras in ~20 formats incl. COLMAP; shapes SHP/KML/GeoJSON                                                                                  | LAS/LAZ + COLMAP cameras adopted (WP-A1); E57/OBJ/FBX/GLB deferred (no writers)                   |
| Gaussian splats    | not native; COLMAP export feeds external trainers (metashape-scripts note)                                                                                                                               | PhotoLab ahead: native Brush training (ADR 0007)                                                  |
| Automation         | Python 3.12 + Java API; network/cloud processing                                                                                                                                                         | P11 rows (WP-G2); network/cloud deliberately out of scope (ADR 0006/0013)                         |

Unresearched (no repo-resident evidence beyond this dossier): exact Metashape
LAS header conventions (WP-A1 chose LAS 1.4 PF2, scale 0.001 on survey
precision grounds, not by reference), Metashape's overlap-map algorithm
(WP-E4, parked), and its report layout specifics.
