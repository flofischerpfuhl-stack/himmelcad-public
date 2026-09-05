# Reference dossier: Trimble RealWorks

Status: research dossier, compiled 2026-09-01 and extended 2026-09-02 from
public web sources.
Class: evidence for X4/A2 derivations (`docs/FUNCTION-CONTRACT.md` A2). This
document describes what RealWorks does and how users experience it. It is
never normative for Himmel:CAD by itself; function catalogs derived from it go
through owner pruning.

## 1. Product overview and reference role

Trimble RealWorks is Trimble's desktop point cloud processing suite: it
imports scan data from "virtually any source" (native Trimble TZF/TDX plus
E57, LAS/LAZ, PTX, ZFS, RCP, and others), registers scans with target-based
and targetless methods, and turns registered clouds into deliverables —
segmented and classified clouds, cross sections, contours, meshes, volumes,
ortho-images, inspection maps, and modeled geometry — with dedicated
publishing to viewers and BIM/CAD targets (Revit, SketchUp, DWG/DXF/DGN,
RCP). It is sold in tiered editions (Viewer, Base, Advanced/Core,
Advanced-Modeler/Plant, Advanced-Tank) and organizes work into processing
configurations (Registration vs. Production, plus Modeling and Inspection
tooling) under a ribbon UI. For Himmel:CAD, RealWorks is **the** reference
for the point cloud domain: the Builder Pointcloud tab catalog derives
primarily from this dossier, and the owner has explicitly named RealWorks'
interaction fluidity with large clouds (segmentation, limit box) as the bar
to match.

Sources: Trimble product page [1], KOREC edition overview [4], BuildingPoint
Ohio Valley technical notes PDF [5], release notes portal [6].

## 2. Function catalog by area

UI-surface abbreviations: ribbon path as documented in release notes
(`Tab > Group > Command`), toolbar = vertical display toolbar in the 3D view,
dialog = modal dialog, tool-window = tool takes over the workspace with its
own panel. Where the exact surface is unverified it is marked (?).

### 2.1 Import, project structure, sampling

| Function                             | What it does                                                                                                                                        | UI surface                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Import scans                         | Imports TZF/TDX (native), E57, LAS/LAZ, PTX, ZFS, RCP, JXL, CSV survey networks, images (incl. PNG since 12.4), DWG/DXF profiles                    | File menu / Home tab, import dialog with per-format options [5][6][8] |
| Station sampling on import           | Choose sampling density per station when loading TZF scans, so the working cloud is a controlled subset of the raw scan files                       | Import dialog options [8]                                             |
| Sampling (spatial, intensity, range) | Resample loaded clouds by spatial step, intensity, or scanner range; filters also apply when extracting points from TZF                             | Sampling group; TZF extraction dialog (12.1) [6][8]                   |
| Scan-Based Sampling > Split per Scan | Creates one cloud per scan in the project                                                                                                           | `Sampling > Scan-Based Sampling` (12.0) [6]                           |
| Project tree (WorkSpace)             | Hierarchical stations/clouds/objects tree; groups (Ctrl+G), display toggles (light bulb), batch Rename Stations and Objects with patterns (2026.10) | WorkSpace window + context menu [6]                                   |
| Scan Explorer                        | Station-centric viewing/measuring on raw TZF scans (panorama view); also the export path for structured (gridded) E57                               | Dedicated explorer window [5][11]                                     |

### 2.2 Registration and georeferencing

| Function                           | What it does                                                                                                                                                                                                                                                            | UI surface                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Auto-Extract Targets and Register  | Detects sphere and flat B/W targets automatically, then registers stations; target auto-extract speed doubled in 2024.00                                                                                                                                                | Registration tab, batch command with report [5][6]              |
| Target Analyzer                    | Inspect and edit extracted targets, quality-check target fits                                                                                                                                                                                                           | Registration tab, tool-window [5]                               |
| Auto-Register using Planes         | Targetless registration: dialog lists stations, user picks a reference station (leveled stations flagged with blue icon), optionally generates preview scans, hits Start; produces a Registration Report (errors, overlap %, confidence per link), savable as RTF       | `Registration` tab, dialog + report window [7]                  |
| Cloud-Based Registration           | Manual/assisted pairwise alignment: three-pane view (reference scan, moving scan, alignment preview); Automatic ("magic wand"), Pan/Rotate manual alignment, or Pairwise point picking; then Refine (best fit) and Registration Visual Check; Apply groups the stations | Registration tab, dedicated multi-pane tool-window [7]          |
| Refine Registration using Scans    | Cloud-to-cloud best-fit refinement of a whole registration group against a chosen (central) reference station, with final report                                                                                                                                        | Registration tab [7]                                            |
| Adjust Registration                | One operation applying refinement using targets, points, and clouds together; imports station links from Trimble Perspective (TDX); network visualization; link create/delete/disable (2024.10/2026.10)                                                                 | Registration tab + `Support > Preferences > Tools > Refine` [6] |
| Bundle adjustment                  | Network adjustment across stations                                                                                                                                                                                                                                      | Registration tab (?) [5]                                        |
| Georeferencing / Orientation / UCS | Georeference by control points (duplicate-point prevention fixed 2024.10), orientation tool, coordinate frame (UCS) creation                                                                                                                                            | Registration tab, dialogs [5][6]                                |
| Registration report & visual check | Errors/overlap/confidence tables, station visualization, Registration Visual Check overlay                                                                                                                                                                              | Report window; viewport overlay [5][7]                          |

### 2.3 Segmentation and cloud editing

| Function                       | What it does                                                                                                                                                                                                                                                                       | UI surface                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Segmentation tool              | Fence-based split of clouds (polygon Shift+X, rectangle Shift+S, circle Shift+C, Magic Wand Shift+W with single-click region grow and Shift-click exclusions since 2024.00); in/out keep; per-vertex undo (Ctrl+Z); only enabled in Production configuration with a cloud selected | Viewport takeover tool with toolbar; keyboard shortcuts [6][12] |
| Auto-Segment Moving Objects    | Detects and removes moving objects (people, vehicles) from TZF-based scans                                                                                                                                                                                                         | `Edit > Cloud > Auto-Segment (TZF Based)` (12.0) [6]            |
| Auto-Segment Steel Beams       | Segments steel beams out of the cloud                                                                                                                                                                                                                                              | `Edit > Cloud > Auto-Segment Steel Beams` [6]                   |
| Auto-Segment Reflection        | Removes window reflections from colorized TZF scans (2026.10, Production mode)                                                                                                                                                                                                     | `Edit > Cloud > Auto-Segment (TZF-Based)` [6]                   |
| Remove Points from TZF Scans   | Pushes deletions back into the raw TZF scan files (multi-scan stations supported since 12.2)                                                                                                                                                                                       | Edit > Cloud [6]                                                |
| Noise Reduction (Trimble Labs) | Density-based range-noise thinning for X7/X9 scans (2026.10)                                                                                                                                                                                                                       | Trimble Labs command [6]                                        |

**Cloud merge.** Two selected cloud objects merge into one with **Ctrl+M**
("CTRL M to merge two cloud objects") — an explicit user command, listed
in the practitioner shortcut round-up alongside F4 (Limit Box) and
Ctrl+C/Ctrl+V; the full shortcut list ships in the in-product help
(`Support > Help`, search "shortcut"). Menu path for the same command
unverified (?). [22]

### 2.4 Classification

| Function               | What it does                                                                                                                                                                  | UI surface                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Auto-Classify Indoor   | Classifies interior clouds into floor, walls, ceiling (etc.); optimized for large clouds; known to need manual review                                                         | Classification command group, batch dialog [1][9] |
| Auto-Classify Outdoor  | Classifies ground, buildings, vegetation, curbs/gutters; building-roof detection from aerial lidar improved 12.2; power lines since 10.3                                      | Classification command group, batch dialog [6][9] |
| Layer/class management | Classified regions land in layers/classes; users extract classified interior regions as separate clouds; layered RCP export preserves classes for Revit/ReCap display control | WorkSpace + export dialog [9][10]                 |

### 2.5 Limit box and clipping

| Function                         | What it does                                                                                                                                                                                                                              | UI surface                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Limit Box                        | Clips the view to a box: pick a center, then resize/reshape via colored grips (axis arrows + red corner spheres that scale all sides); clicking the box manipulator toggles pan/rotate/reshape modes; box contents remain fully navigable | Vertical display toolbar, View tab, or **F4**; in-viewport gizmo + toolbar [13] |
| Show limit box / outside content | Toggle box border visibility (clean screenshots) and show/hide clouds and geometries outside the box for orientation                                                                                                                      | Limit Box toolbar commands [13]                                                 |
| Store / manage limit boxes       | "Store the current Limit Box" names and saves boxes; Limit Box Window lists them; Import/Export shares box files (small) with other users incl. the free Viewer                                                                           | Limit Box toolbar + Limit Box Window [13]                                       |
| Limit Box Extraction             | Same box, plus a sampling method chooser and "Extract points from TZF Scans" — pulls a fresh, full- or sampled-density cloud of the boxed region from raw scans, with range/intensity filtering                                           | Limit Box Extraction tool variant [8][13]                                       |
| Limit box slices                 | Horizontal and perpendicular-to-screen slice modes (2024.10)                                                                                                                                                                              | Limit Box toolbar [6]                                                           |
| Cutting plane                    | Positionable section plane through the model/cloud for viewing and 2D work                                                                                                                                                                | Toolbar/tab tool (?) [5]                                                        |
| Station markers vs. box          | Markers outside the limit box can be hidden (12.4)                                                                                                                                                                                        | View option [6]                                                                 |

### 2.6 Measurement and annotation

| Function                                         | What it does                                                                                                                                                    | UI surface                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Measurement tools                                | Point coordinates, distances; "smart measurement": semi-automatic clearance, projected vertical and horizontal distances                                        | Measure group; viewport picking [5] |
| Annotations                                      | 3D annotations with text, hyperlinks (12.1), inspection-distance fields on inspection maps, attached screen captures and saved camera "view stations" (2026.10) | `Home > Annotation > Annotate` [6]  |
| Feature coding / 2D Easy Line / Polyline drawing | Coded field-style feature drawing and polyline tracing over the cloud                                                                                           | Production drawing tools [5]        |
| Catenary drawing tool                            | Draws catenary curves (wires) from cloud points                                                                                                                 | Advanced deliverables group [5]     |

### 2.7 Inspection and analysis

| Function                                                  | What it does                                                                                                                                                                                                                                                                                                                                        | UI surface                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Surface to Model Inspection                               | Compares cloud against a design model (mesh/geometry); colorized deviation map                                                                                                                                                                                                                                                                      | Inspection tools, tool-window + map [5]                       |
| Twin Surface Inspection                                   | Compares two surfaces/clouds (pre/post event)                                                                                                                                                                                                                                                                                                       | Inspection tools [5]                                          |
| 3D Inspection tool + analyzer                             | Cloud-to-model/cloud 3D deviation with min/max distance filtering (12.1); low-density error messaging (2024.10); annotate directly on inspection clouds                                                                                                                                                                                             | Inspection tools; analyzer tool-window [5][6]                 |
| 2D Inspection tool + Inspection Map Analyzer              | Plane/cylinder/tunnel-projected deviation maps; empty-pixel color preference; CSV export of inspection maps (2024.00)                                                                                                                                                                                                                               | Inspection tools; map window [5][6]                           |
| Floor flatness and levelness                              | Extracts floor-only points, computes FF/FL-style flatness/levelness analysis and reports; markets ~1/4-inch tolerance deviation flagging                                                                                                                                                                                                            | Dedicated flatness inspection tool (Advanced) [5][14]         |
| Wall Verticality Inspection                               | Verticality deviation of walls, reversible projection direction (12.3)                                                                                                                                                                                                                                                                              | Inspection tools [6]                                          |
| Vertical/Horizontal Storage Tank Calibration & Inspection | Guided 6-step tank workflow: import/register, clean to shell, define courses and vertical stations, set tolerances, focused inspection of out-of-tolerance areas, generate API 653-style roundness/verticality reports and volume filling tables; secondary containment analysis (overflow points, holding volume, multi-tank basins since 2024.00) | Advanced-Tank edition: guided wizard/workflow surface [15][6] |
| Volume calculation                                        | Volumes from clouds/surfaces (stockpiles etc.)                                                                                                                                                                                                                                                                                                      | Production tools [5]                                          |

### 2.8 Modeling, mesh, drawing deliverables

| Function                                                                  | What it does                                                                                                                                                                                                                            | UI surface                                |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Mesh Creation / Editing                                                   | Meshes from clouds (incl. watertight); editing incl. hole filling and `Surfaces > Mesh Editing > Add Triangles` (12.0); Move Mesh with displacement toolbar (12.3)                                                                      | Surfaces group; mesh edit tools [5][6]    |
| Contouring / Profile & Cross section / Easy Profile / Profile Matcher     | Contours from surfaces; profiles and cross-section series from clouds; matching drawn profiles along runs                                                                                                                               | Production/Advanced deliverable tools [5] |
| Basic geometry fitting                                                    | Fit planes, cylinders, spheres etc. to segmented cloud                                                                                                                                                                                  | Modeling tools [5]                        |
| EasyPipe / Create Pipe / Create Cable Tray                                | Pipe runs with elbows/tees/reducers/flanges/valves fitted from cloud (`Model > Piping > Create Pipe`, 12.0+); eccentric reducers, bent pipe conversion (12.3); cable trays (12.4); direct "Send to Revit" as native objects (12.3/12.4) | Model tab, interactive fitting tools [6]  |
| Steel Beam / Steel Catalog Modeling                                       | Beams fitted from cloud against steel catalogs                                                                                                                                                                                          | Modeling tools (Advanced-Modeler+) [5]    |
| Auto-Extract Cylinders                                                    | Batch cylinder/pipe extraction into pipe groups                                                                                                                                                                                         | Model tab (12.0) [6]                      |
| Ortho-Projection / Multi Ortho Projection                                 | Ortho-images of clouds onto user-defined planes (facades, plans); segmentation inside the tool (12.1); memory-split guidance for huge outputs (2024.10)                                                                                 | Imaging group, tool-window [5][6]         |
| Convert to Ortho-Image / Image rectification / Image Matching / RealColor | Position and scale imported images in 3D (`Imaging > Ortho-Image > Convert to Ortho-Image`); rectify images; match/colorize clouds from panoramic imagery                                                                               | Imaging group [5][6]                      |
| Key plan creation                                                         | Key plans from ortho-imagery (also inside Scan Explorer since 12.4)                                                                                                                                                                     | Imaging group [5][6]                      |

### 2.9 Export, publishing, collaboration

| Function                               | What it does                                                                                                                                                                                                                                                        | UI surface                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Cloud/scan export                      | TDX, POD, LAS/LAZ 1.4 (4B+ points), PTX (one station per file), TZF, structured & unstructured E57, structured & unstructured RCP (with coordinate frame choice, multi-resolution imagery); structured E57 via Scan Explorer vs. unstructured via Production export | Export dialogs [6][11]                        |
| CAD/BIM export                         | DXF/DGN graphic export, DWG; IFC (pipes as IfcFlowSegment/Fitting); direct Revit link ("Open Revit", "Send to Revit"); SketchUp Pro live link (.skp); PDMS and centerline export (Plant)                                                                            | Home/Model tab > Revit; export dialogs [5][6] |
| Publisher                              | Self-contained published packages: recipients view, measure, annotate in a free viewer/browser; can embed media, doc/web links; data-extraction can be allowed or blocked                                                                                           | Publish dialog [5]                            |
| Publish to TRCPS / Export Clarity File | Upload to Trimble Reality Capture Platform Service with annotations as BCF topics (2026.10); TDZ upload to Trimble Clarity (`Home > Sharing`, 12.1)                                                                                                                 | Home > Sharing [6]                            |
| Media/report outputs                   | Video generation, Google Earth KML, integrated print-out interface, registration/inspection reports (RTF/HTML/CSV)                                                                                                                                                  | Various report dialogs [5][6][7]              |

### 2.10 Viewing/navigation functions relevant to the cloud domain

Examiner and Walkthrough navigation modes; "Fly to" via Shift+click (12.0);
pivot rotation around camera via right-click (12.4); cloud transparency
button; dark/light theme (`Support > Switch Theme`); display shortcuts
Ctrl+W/Ctrl+E/Alt+E/Ctrl+R/Alt+R (2024.00); station 3D markers scaled by view
distance; configurable Zoom Extents double-click. [6]

## 3. Key workflows, user perspective

### W1 — Targetless registration of a scan project

1. Import raw scans (TZF); stations appear in the WorkSpace tree. 2. On the
   `Registration` tab run **Auto-Register using Planes**; in the dialog pick the
   reference station (leveled ones are marked), generate preview scans if
   missing, Start. 3. Read the **Registration Report** — per-link error, overlap
   %, confidence — and save as RTF. 4. Run **Refine Registration using Scans**
   with a central reference station for the cloud-to-cloud best fit; get the
   final report. 5. Visually verify (Registration Visual Check, magnifier),
   then georeference against control points. [7]

### W2 — Manual cloud-based registration of a stubborn pair

1. Open **Cloud-Based Registration**: reference left, moving scan right,
   combined preview below. 2. Try the Automatic (magic wand) match; otherwise
   pan/rotate the moving scan into rough alignment or pick pairwise points.
2. **Refine** (best fit), check with **Registration Visual Check**, then
   Apply; the pair becomes a registered group and the process repeats until one
   group remains. [7]

### W3 — Isolate a region with the Limit Box and extract full density

1. Press **F4** (or toolbar/View tab) to activate the Limit Box; click a
   center point. 2. Drag arrow grips per face, red corner spheres for uniform
   scale; click the manipulator to switch pan/rotate/reshape. 3. Toggle
   visibility of outside content for orientation; store the box under a name for
   later reuse or export it to a colleague. 4. In the **Limit Box Extraction**
   variant, choose a sampling method (or range/intensity filter) and click
   **Extract points from TZF Scans** to pull a fresh cloud of just that region
   from the raw scans at chosen density. [8][13]

### W4 — Clean a cloud by segmentation

1. In Production configuration select the cloud; open the Segmentation tool.
2. Fence with polygon/rectangle/circle/Magic Wand (Shift+X/S/C/W), Ctrl+Z
   undoes vertices; keep inside or outside; repeat iteratively. 3. For known
   nuisances run batch tools instead: Auto-Segment Moving Objects, Steel Beams,
   or Reflections (colorized TZF). 4. Optionally push deletions back to the raw
   scans via Remove Points from TZF Scans. [6][12]

### W5 — Classify and hand off to Revit

1. Run **Auto-Classify Indoor** (floor/walls/ceiling) or **Outdoor**
   (ground/buildings/vegetation/curbs) on registered clouds. 2. Review and fix
   misclassifications manually (users report poles classified as vegetation
   etc.). 3. Extract classified regions as separate clouds where needed.
2. Export layered **RCP**; in Revit/ReCap the classes arrive as layers, giving
   display control per class. [9][10]

### W6 — Facade/plan ortho-image

1. Define the projection (cutting plane or fitted plane) over the region of
   interest. 2. Open the **Ortho-Projection** tool; set extents, resolution, and
   depth; segment away obstructing points inside the tool if needed.
2. Generate; for very large outputs follow the split guidance. 4. Export the
   georeferenced image, or build a key plan from it. [5][6]

### W7 — Mesh and volume from a cloud

1. Segment/sample the target region (limit box helps). 2. Run Mesh Creation;
   repair with hole filling and Add Triangles. 3. Use the mesh for volume
   calculation or export it (e.g. SketchUp, DXF, IFC-capable formats). [5][6]

### W8 — Surface-to-model inspection map

1. Import the design model (DWG/DXF/IFC/mesh) and align it with the cloud
   (Model-Cloud Alignment). 2. Run **Surface to Model Inspection** or the 3D
   Inspection tool; set min/max distance filters. 3. Read the colorized
   deviation map in the analyzer; annotate hotspots (annotations carry
   inspection distances). 4. Export the map/CSV and report. [5][6]

### W9 — Floor flatness report

1. Extract the floor (flatness tool auto-retrieves floor-only points; indoor
   classification can pre-select the floor). 2. Run flatness/levelness analysis
   with specified tolerance values. 3. Generate the report with deviation
   areas flagged; deliver alongside contour/heat-map graphics. [1][14]

### W10 — Storage tank inspection (Advanced-Tank)

1. Import and register tank scans. 2. Clean to isolate the shell. 3. Define
   courses and vertical inspection stations. 4. Set tolerances; the software
   flags out-of-tolerance areas automatically. 5. Inspect flagged areas in
   detail. 6. Generate API 653-style roundness/verticality reports and volume
   calibration tables; optionally analyze secondary containment (overflow
   points, holding volume). [15]

## 4. Practitioner sentiment

**Praise.**

- Guided, end-to-end scan-to-deliverable workflow is repeatedly called out;
  comparison pieces position RealWorks as strongest for "consistent visual QA
  and repeatable documentation work" and turning clouds into survey
  deliverables [16]; forum users testing it call it "a really powerful piece
  of software" [17].
- Targetless registration since v9/v10 seen as easy: pick two scans, the
  software connects them [16].
- Handles very large projects: a forum user reports a 5.6-billion-point
  project split into 23 RealWorks cloud objects [12]; official specs scale
  point load with RAM up to ~2 billion points at 64 GB [5]; since 12.2 a
  single scan may exceed 4 billion points [6].
- Limit box collaboration (small saved/exported box files, usable in the free
  Viewer) is presented as a workflow advantage [13].

**Complaints.**

- **Limit box regression in v12**: users report the box "jumping" and moving
  sides randomly while resizing, making it frustrating to isolate an area;
  reported as fixed in v2024 [18]. Evidence that grip/gizmo precision is a
  real-world quality bar, not polish.
- Segmentation crashes on some projects/hardware (dedicated forum thread)
  [19]; release notes repeatedly ship stability fixes for segmentation,
  registration, and large-cloud handling [6].
- G2 reviewers: UI "not very smooth and easy", "hard to get used to"; you
  cannot produce full CAD drawings inside it — 2D vectors by cutting planes
  only [20].
- Third-party comparisons: Trimble-ecosystem lock-in, learning curve, and
  "Cyclone leads in registration quality" [16][21]. Windows-only.
- Historical note: memory degradation and slow project opening were fixed in
  2024.00 [6] — long-session memory behavior is a known pain class.

**Relevance to Himmel:CAD.** The complaints cluster exactly where the owner
set the bar: grip behavior of the clip/limit box (predictable resize, no
jumping), interaction stability during segmentation on large clouds, and
smooth navigation at hundreds of millions of points. RealWorks' answer to
scale — sampled working clouds backed by full-density raw scans, with
box-scoped re-extraction on demand — is an architecture-level pattern, not a
feature detail.

## 5. Mapping hints to Himmel:CAD Builder ribbon tabs

| RealWorks capability                                                                                                                                                                                                                                                                      | Builder tab    | Notes                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Import scans/clouds, export all formats, Publisher/packages                                                                                                                                                                                                                               | **File**       | Import/export dialogs and publish live with project I/O                                                                         |
| Limit box (activate, grips, store/manage, slices), cutting plane, examiner/walkthrough, fly-to, cloud transparency, display shortcuts, themes                                                                                                                                             | **View**       | Matches existing Himmel:CAD viewing box; W3 + complaint [18] define the quality bar                                             |
| Registration (auto/targets/cloud-based/refine/adjust/georeference/reports), sampling, segmentation (manual + auto-segment), classification, Remove Points from TZF, noise reduction, limit-box extraction (the extraction half), cloud-to-cloud/model inspection, flatness, tank analysis | **Pointcloud** | Primary source for the Pointcloud tab catalog; registration could be a sub-group or its own contextual tab given its tool count |
| Polyline drawing, 2D Easy Line, feature coding, profiles/cross sections, contours, catenary, measurements, annotations                                                                                                                                                                    | **Draw**       | Cloud-referenced 2D/3D drafting                                                                                                 |
| Mesh creation/editing, geometry fitting, volume calculation                                                                                                                                                                                                                               | **Mesh**       | Surface-to-model inspection sits between Pointcloud and Mesh; decide by selection semantics                                     |
| Pipes/cable trays/steel, IFC/Revit/SketchUp links, classification-to-BIM handoff (layered RCP)                                                                                                                                                                                            | **BIM**        | RealWorks' Model tab maps here                                                                                                  |
| Ortho-projection, ortho-image conversion, image rectification/matching, key plans, inspection maps as images                                                                                                                                                                              | **Raster**     | Image-typed outputs and georeferenced rasters                                                                                   |

Derivation guidance: RealWorks separates _modes_ (Registration vs.
Production) more than tabs; Himmel:CAD's single-model ribbon should instead
use selection-contextual enabling (segmentation active only with a cloud
selected mirrors RealWorks' Production-only gating [12]).

## 6. Sources

1. Trimble RealWorks product page — https://geospatial.trimble.com/en/products/software/trimble-realworks
2. Trimble RealWorks for construction — https://www.trimble.com/en/products/building-construction-field-systems/trimble-realworks
3. Reseller feature summaries — https://www.buildingpointpacific.com/products/field-solutions/trimble-realworks ; https://optron.com/trimble/office-software/trimble-realworks/
4. KOREC edition overview (Starter/Core/Performance/Storage Tank) — https://www.korecgroup.com/product/trimble-realworks/
5. RealWorks Technical Notes PDF (full tool/edition matrix, RAM/point table) — https://buildingpointohiovalley.com/wp-content/uploads/2019/06/Technical-Notes-Trimble-RealWorks-English-USL-BPOV.pdf
6. Release notes portal (12.0, 12.1, 12.2, 12.3, 12.4, 2024.00, 2024.10, 2026.10) — https://help.fieldsystems.trimble.com/realworks/home.htm (e.g. https://help.fieldsystems.trimble.com/realworks/12.0.htm , .../2024.00.htm , .../2026.10.htm )
7. Scan-based registration walkthrough (NEI, Trimble tip mirror) — https://neigps.com/news/scanning-tip-of-the-week-scan-based-registration-in-trimble-realworks/
8. Import & station sampling tip; limit-box extraction snippets — https://geospatialresources.trimble.com/blog/import-and-station-sampling-options-in-trimble-realworks (JS-rendered; content confirmed via search excerpts)
9. Classification overview & caveats — https://buildingpointflorida.com/see-whats-new-in-trimble-realworks-10-3/ ; https://laserscanningforum.com/forum/viewtopic.php?t=10458
10. Layered RCP → Revit classification handoff — https://www.linkedin.com/posts/robert-greenhalgh-0316a920_classification-trimble-realworks-activity-6560450847027843072-3Yko ; https://community.trimble.com/blogs/erin-johnson1/2021/02/26/tip-141
11. Structured vs. unstructured E57 export paths (KOREC guide PDF) — https://hf-files-oregon.s3.amazonaws.com/hdpkorecgroup_kb_attachments/2018/03-14/40bf8324-799f-4a9a-b3b9-5be8512e3f1e/16.1-Exporting-an-E57-from-RealWorks.pdf ; forum: https://laserscanningforum.com/forum/viewtopic.php?t=12429
12. Forum: spatial sampling / 5.6B-point project; Production-mode gating — https://laserscanningforum.com/forum/viewtopic.php?t=11157
13. Limit Box tool tip (Trimble blog; mirrored on LinkedIn) — https://www.linkedin.com/pulse/thinking-outside-limit-box-jason-hayes ; https://www.laserinst.com/news/limitboxtoolinrealworks
14. Floor flatness tutorial (video) — https://www.youtube.com/watch?v=ZY1Sc2lTDZ8 ; https://nordics.construsoft.com/blog/laser-scanning-floor-flatness-water-drain-demo
15. Advanced-Tank techsheet (6-step workflow, API 653) — https://al-top.com/wp-content/uploads/2018/01/Trimble-RealWorks.pdf ; https://frontierprecision.com/wp-content/uploads/2025/06/Frontier-Precision-RealWorks-Advanced-Tank-Edition-Techsheet.pdf
16. Comparison articles — https://www.thefuture3d.com/equipment/compare/cyclone-vs-recap-vs-scene-vs-realworks/ ; https://www.thefuture3d.com/software/trimble-realworks/
17. Forum: Cyclone vs. RealWorks — https://www.laserscanningforum.com/forum/viewtopic.php?f=59&t=7974 ; https://www.laserscanningforum.com/forum/viewtopic.php?t=17875
18. Forum: Limit Box Behaviour v12.4 (jumping-grips complaint, fixed in 2024) — https://www.laserscanningforum.com/forum/viewtopic.php?t=20858
19. Forum: RealWorks crashing during segmentation — https://www.laserscanningforum.com/forum/viewtopic.php?t=19065
20. G2 reviews (4 reviews, 4.3/5) — https://www.g2.com/products/trimble-realworks/reviews
21. Slashdot comparison — https://slashdot.org/software/comparison/Leica-Cyclone-vs-Trimble-RealWorks/
22. RealWorks shortcut-keys tip (Jason Hayes, LinkedIn mirror read in full; Trimble blog original is JS-rendered) — https://www.linkedin.com/pulse/using-short-cut-keys-speed-up-your-point-cloud-workflow-jason-hayes ; https://geospatialresources.trimble.com/blog/using-realworks-shortcut-keys-to-speed-up-your-point-cloud-workflow

## 7. Evidence quality statement

**Well-sourced (primary/official).** The function catalog backbone: the
edition/tool matrix and exact tool names (Technical Notes PDF [5], read in
full); command paths, shortcuts, and feature evolution 12.0–2026.10 (official
release notes [6], five pages read in full); the tank workflow ([15], techsheet
read in full); the targetless/cloud-based registration walkthrough ([7], full
article); limit box operation incl. F4, grips, stored boxes, extraction
([13], full mirrored article; extraction button name from Trimble-blog search
excerpt [8]); the Ctrl+M cloud-merge shortcut ([22], mirrored article read
in full). Section 8's continued existence of smart-picking modes is also
primary/official in the 2024.10 release notes [P2].

**Moderately sourced (search excerpts, not full pages).** Classification
category lists and caveats [9][10]; structured-vs-unstructured export split
[11]; floor flatness details [14] (video tutorials not watched; steps
inferred from tool descriptions); forum sentiment [12][17][18][19] — the
laserscanningforum is Cloudflare-blocked, so quotes come from search
snippets; the limit-box-jumping complaint and its 2024 fix rest on one
snippet.

**Thin / treat with caution.** thefuture3d/slashdot comparison claims
(including price figures $4.5k–$12k) are third-party aggregator content of
unknown rigor [16][21]; G2 sample is only 4 reviews [20]; UI-surface column
entries marked (?) are inferred; the Technical Notes matrix is from 2017 —
edition packaging has since changed (KOREC now lists Starter/Core/
Performance/Storage Tank [4]). Section 8's detailed picking interactions come
from Trimble-authored RealWorks 10.1/11.0 user guides hosted by third-party
manual mirrors [P1, P3], not a current official help endpoint; their continued
availability in current RealWorks is not established except where the 2024.10
release notes name the feature. No statement in this dossier is invented;
where the surface or exact behavior was unverifiable it is marked as such.

## 8. Point creation and picking aids relevant to a movable 3D target

### 8.1 What RealWorks actually documents

- **Standard 3D constrained picking.** The `Picking Parameters` toolbar opens
  inside tools that need picks (including Measure, Polyline Drawing, and
  Geometry Creator). In the active coordinate frame, entering/locking one
  coordinate constrains the pick to a plane, two to a line, and all three to
  an exact point; it can also snap to a primitive center. The documented
  workflow still ends by picking in the 3D view. In 2D constraint mode it
  offers Cartesian H/V or polar angle/distance constraints [P1, P3].
- **Oriented working frame.** A user coordinate system (UCS) can be created
  with a typed origin and axes, picked origin/axis points, or an axis fitted
  from cloud points. Making that UCS active expresses subsequent coordinates,
  modeling, and measurements in the oriented frame. This supplies orientation
  to the coordinate constraints, but it is a separate frame tool—not a
  rotatable point cursor [P1, P3].
- **Cloud-derived picks.** RealWorks documents Standard, Highest Cloud Point,
  and Lowest Cloud Point modes. Highest/Lowest search a user-sized pixel
  neighborhood around the cursor and return the extremal acquired cloud point
  along the active frame's Z axis. Face-of-curb smart picking snaps a rough
  click to an acquired curb point; the gutter result can be a synthetic point
  below the curb when occlusion leaves no return. Official 2024.10 notes
  confirm that Faces of Curb, Gutter, Roadmark edge, and Fitted plane smart
  picks still existed in that release, but do not restate their algorithms
  [P1, P2].
- **Point objects.** `Geometry Creator > 3D Point` starts a provisional point
  at the middle of the 3D view, then lets the user define it by a constrained
  pick, three intersecting planes, plane/segment intersection, entity center,
  projection onto a plane, two axial entities, or direct position editing.
  `Registration > Create Points > Create Topo Point` creates a named point by
  typed coordinates. In Target Analyzer, `Pick Point to Create 3D Point`
  changes the cursor to a cross and creates an unmatched target by picking an
  actual point on the displayed scan [P1, P3].
- **Target fitting/manipulation.** A rough click can auto-extract a spherical
  target from neighboring scan points. A fitted **flat target** has a
  translation manipulator with two axis handles and a plane, allowing movement
  along an axis or in that plane. The guide does not document a rotation handle
  for this target adjustment, and the object being moved is fitted target
  geometry used for registration—not a generic point-placement reticle
  [P1, P3].
- **Orientation measurement is not point placement.** The orientation tool
  picks a surface point and a second point that sizes a spherical neighborhood,
  fits a circular plane, and reports two orientation angles. A three-point
  variant defines the plane explicitly; an existing result can be refined by
  dragging picked points, moving the sphere center, or changing its diameter.
  It saves an orientation-measurement object, not a freely placed 3D point
  [P1, P3].

### 8.2 Finding against the owner's S4 description

The broad design need—placing a meaningful point when a single nearest-cloud
sample is unreliable—is supported by RealWorks' combination of constrained
coordinates, an oriented UCS, neighborhood extrema, fitted/synthetic smart
picks, geometric intersections, and numeric point entry [P1, P2]. The exact
S4 precedent, however, is **not confirmed**: the reviewed RealWorks material
does not show one “3D target reticle” that can both rotate and translate freely
inside a sparse cloud and then emit a point. The closest visual controls are
(a) a cross cursor that must pick the scan, (b) a translation-only flat-target
manipulator, and (c) separately oriented UCS/direction tools. Treat the
rotatable-reticle attribution to RealWorks as unresearched/unsupported unless
a current in-product help page, training video, or reproducible build is
captured [P1–P3].

### Sources for section 8

- [P1] Trimble-authored _RealWorks 10.1 User's Guide_ (third-party full-text
  mirror): UCS Creation, Picking Parameters, highest/lowest and curb/gutter
  picking, orientation measurement/refinement, Geometry Creator 3D Point, and
  flat-target manipulator — https://manuals.plus/m/1197000ef6b7a956ba8ab4b9e2e81572dc4bf98255e56170e10576ebe9e85eaf
- [P2] Official Trimble RealWorks 2024.10 release notes (current evidence for
  Faces of Curb, Gutter, Roadmark edge, and Fitted plane smart-picking modes) — https://help.fieldsystems.trimble.com/realworks/2024.10.htm
- [P3] Trimble-authored _RealWorks 11.0 User's Guide_ (third-party PDF mirror):
  `Pick Point to Create 3D Point`, constrained picking, point creation, target
  fitting, and orientation tools — https://prin.ru/images/documents/instrukcii/trimble/soft/trw/TrimbleRealWorks%2011.0%20User%20Guide.pdf
