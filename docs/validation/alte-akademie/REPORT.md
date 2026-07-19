# Alte Akademie — Builder mixed-scene validation

Dataset: IFC (895 canonical entities), 96,600,723-point cloud, 20 cm orthomosaic, and a tiled DEM draped with the orthomosaic. The IFC translation used for the shared project frame is `691112.110, 5334890.385, 517.620 m`.

## Result

All four entity classes were loaded into one shared viewer and exercised together. The final renderer keeps exact BIM geometry resident, streams point and terrain hierarchy independently, uses one camera/clip/depth world, and keeps viewport allocation stable while panels resize over it.

The final follow-up fixed two correctness issues found during visual review:

- Binary orthophoto NoData alpha now uses an alpha-test pass with depth writes; a single transparent border pixel no longer makes an entire terrain tile transparent.
- Untextured IFC solids/surfaces use neutral PBR lighting, while points, CAD strokes and rasters retain their appropriate unlit/textured paths.

Point-cloud RGB is now decoded from source sRGB into the renderer's linear-light framebuffer before the single presentation transfer. This removes the washed-out double-transfer appearance without a cosmetic saturation adjustment.

## Visual record

### Individual entity paths

![Point cloud overview](63-pointcloud-frame-all.png)

![Point cloud orbit](64-pointcloud-orbit-settled.png)

![Point cloud at 1 px in locked top-down](83-pointcloud-1px-topdown.png)

![Color-managed point cloud](99-color-managed-point-cloud.png)

![Full-resolution orthomosaic](68-orthomosaic-full-resolution-top.png)

![Orthomosaic detail](69-orthomosaic-detail-top.png)

![Textured terrain top](70-textured-terrain-top.png)

![Textured terrain orbit](71-textured-terrain-orbit.png)

![IFC complete top-down](91-ifc-895-entities-topdown.png)

![IFC complete orbit](92-ifc-895-entities-orbit.png)

![Lit IFC after final material correction](102-lit-ifc-only.png)

### Combined scene and navigation

![Complete project orbit](72-complete-project-orbit.png)

![Complete project rotated orbit](73-complete-project-orbit-rotated.png)

![Complete project locked top-down](74-complete-project-locked-topdown.png)

![All entities top](55-verified-all-entities-top.png)

![All entities perspective](56-verified-all-entities-perspective.png)

![Fast zoom immediate fallback frontier](84-fast-zoom-immediate-frontier.png)

![Fast zoom settled frontier](85-fast-zoom-settled-frontier.png)

![Locked top-down pan](87-locked-topdown-pan.png)

![Console expanded without viewport reallocation](88-window-mask-console-expanded.png)

![Console collapsed with stable camera](89-window-mask-console-collapsed.png)

### Presentation, exaggeration and clipping

![Transparent IFC over survey](75-transparent-ifc-over-survey.png)

![Transparent terrain over point cloud and IFC](76-transparent-terrain-over-cloud-ifc.png)

![Terrain at 1× datum-relative exaggeration](93-terrain-datum-exaggeration-1x.png)

![Terrain at 3× datum-relative exaggeration](94-terrain-datum-exaggeration-3x.png)

![Horizontal section at Z 520 m](79-horizontal-section-z520.png)

![Horizontal section at Z 535 m](80-horizontal-section-z535.png)

![Vertical east section](81-vertical-section-east-691160.png)

![Vertical north section](82-vertical-section-north-5334900.png)

### Final depth/material review

![Opaque IFC with alpha-masked terrain](100-opaque-ifc-masked-terrain-depth.png)

The ragged photogrammetric surface visible outside the BIM envelope is source DEM geometry. Opaque IFC surfaces and binary-masked terrain now both write and test the same reverse-Z depth buffer; deliberately reduced entity opacity still reveals geometry behind it by design.

## Verification

- Builder TypeScript and Electron typechecks pass.
- Renderer alpha-mask and point-color-transfer regression tests pass.
- The scene was inspected in perspective orbit, locked top-down, rapid zoom, panel resize, transparency, vertical exaggeration, and two horizontal plus two vertical clip configurations.
