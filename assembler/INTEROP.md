# Assembler import/export (interop)

Status 2026-09-30, branch `asm/interop-20260930`, integrated with the own OCCT build
(`OCCT-BUILD-SPIKE.md`) on `feat/assembler-phase0-20260929`. Code:
`apps/assembler/renderer/src/interop/` (pure TypeScript: parsers, writers, document edits, UI),
`renderer/src/kernel/stepImport.ts`, `stepXcafImport.ts`, `igesExchange.ts`, `stepExport.ts`,
`meshSolid.ts` (OCCT), agent API `renderer/src/api/interopApi.ts`, Python
`sdk/python/src/himmelcad/assembler/interop.py`.

Two OCCT modules (`HIMMELCAD_OCCT`): the HimmelCAD build (`vendor/occt-wasm`, the default
since 2026-09-30), which adds IGES and OCCT's XCAF STEP reader, and `replicad-opencascadejs`
1.1.0 (`HIMMELCAD_OCCT=replicad`). The kernel
reports what the loaded module has (`KernelStatusInfo.capabilities`); menus, `interop.formats`
and Python follow it.

## Formats

| Format                 | Import becomes                                                   | Kept                                                                                                                                                                                                              | Export from                       | Kept                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STEP (`.step`, `.stp`) | bodies, **one** `Import` History step                            | exact B-rep; product structure as nested Items folders; part names; part colours; placements (nested, rotated, shared sub-assemblies); file unit converted to mm                                                  | bodies                            | exact B-rep, names (Items names), colours, Items folders as sub-assemblies (optional), AP242 or AP214, mm/cm/m/in, flat / assembly / one file per body, all / visible / selected |
| IGES (`.igs`, `.iges`) | bodies, one `Import` History step (HimmelCAD OCCT build only)    | exact geometry: surfaces sewn, closed shells → solids, open shells → surface bodies (warning); file unit → mm. No names, colours or structure                                                                     | bodies (HimmelCAD OCCT build)     | exact geometry as trimmed surfaces (default) or MSBO solids; mm/cm/m/in; all / visible / selected. No names or colours. Default module: disabled, "not in this build"            |
| STL                    | reference mesh                                                   | triangles; unitless: a rescale is offered, never applied                                                                                                                                                          | bodies + visible reference meshes | print export: binary/ASCII, resolution presets; all / **visible** (new) / selected bodies in one file, or one file per body                                                      |
| 3MF                    | reference meshes, one per build item                             | object names, item and component transforms (baked), Production-extension parts (`p:path`), colour (base material / colour group, most common per object), declared unit → mm                                     | bodies + visible reference meshes | unchanged (print export)                                                                                                                                                         |
| OBJ                    | reference meshes, one per group (folder per file/object)         | polygons (fan-triangulated), groups/objects, vertex colours (average)                                                                                                                                             | —                                 | —                                                                                                                                                                                |
| DXF (ASCII)            | a new sketch on XY/XZ/YZ (+ offset) or the selected planar face  | LINE, ARC, CIRCLE, LWPOLYLINE/POLYLINE with bulges (→ arcs), SPLINE, ELLIPSE, POINT, INSERT (translation, rotation, uniform scale; nested); `$INSUNITS`; end points connected (shared sketch points = coincident) | a sketch or a planar face outline | R2000: LINE, ARC, CIRCLE, ELLIPSE, SPLINE, LWPOLYLINE, POINT, layer `CONSTRUCTION`; R12: splines/ellipses as polylines; `$INSUNITS` 4                                            |
| `.hcasm`               | opens the project (same unsaved-changes question as File › Open) |                                                                                                                                                                                                                   |                                   |                                                                                                                                                                                  |

Entry points (all formats): **File › Import…** (one picker for every format), **Import
STEP…**, **Import STL…**, **Import DXF into Sketch…**, dropping files anywhere on the window
(an overlay lists the formats), command search. Exports: **Export STEP…** (dialog), **Export
DXF…** (dialog; enabled with a sketch or planar face selected), the print exports (STL…, 3MF,
Open in Slicer). **Convert Mesh to Solid** is in the adaptive toolbar and context menu of a
selected reference mesh. **Import IGES…** / **Export IGES…** (dialog: bodies, trimmed surfaces
or solids, unit) are enabled with the HimmelCAD OCCT build (the default); with
`HIMMELCAD_OCCT=replicad` they stay disabled with the reason, and a dropped `.igs` is refused
with it.

Progress and Cancel: reading/parsing (3MF, OBJ, STL, DXF, the mesh-to-solid check) runs in
the import worker (`import.worker.ts`) — a progress island with **Cancel**, which terminates
the worker. Kernel work (STEP geometry, Mesh to Solid) runs in the kernel worker after the
step is added; Cancel stops it and restores the document as it was
(`store.cancelKernelWork`, the step stays available as Redo). A step whose evaluation fails is
taken back and the reason is shown; nothing half-imported stays behind. Results and anything
converted or skipped are reported (toast, or a dialog when there is something to read).

## STEP assemblies

**HimmelCAD OCCT build: OCCT's XCAF reader.** `kernel/stepXcafImport.ts` reads the file with
`STEPCAFControl_Reader` (name and colour mode) into an XCAF document and walks it: free shapes
under the shapes label, components (`XCAFDoc_ShapeTool::IsComponent`, `GetReferredShape`,
`GetLocation`, composed down the tree), names from `TDataStd_Name` and colours from
`XCAFDoc_ColorTool` (instance colour, else part colour, else a solid sub-shape's, else the most
frequent face colour; linear RGB → sRGB `#RRGGBB`). Label names and child labels come through the
build's `HimmelcadXcaf` facade (the stock bindings lack `Standard_GUID` and the
`TDF_LabelSequence` base). The walk reproduces the text route's conventions (depth-first in
file order, product name else instance name, `(2)` per folder, same colour rule), so both
routes give the **same bodies, ids and face keys** for the same file (test
`occtInterop.test.ts`: robot fixture identical in names, colours, folders, faces, volumes and
boxes; UTF-8 names such as `Grundplatte Größe 1`). If the XCAF reader fails, the text route
below runs and a warning says so. `interop.formats` reports the route (`reader: xcaf | text`).

**Default module (and fallback): the file text.**
The OCCT build (`replicad-opencascadejs` 1.1.0, OCCT 8.0.1) exposes `STEPControl_Reader`,
`STEPControl_Writer` and the XCAF **writer** (`STEPCAFControl_Writer`, `XCAFDoc_ShapeTool`,
`XCAFDoc_ColorTool`, `TDataStd_Name`), but **no XCAF reader** (`STEPCAFControl_Reader`) and no
`XSControl_TransferReader` binding. Names and colours therefore cannot come from OCCT on
import. Instead:

1. `interop/step/p21.ts` scans the ISO 10303-21 text once (records counted in file order,
   arguments parsed only for the ~40 entity types needed); `stepStructure.ts` builds the
   product tree: `PRODUCT` → `PRODUCT_DEFINITION_FORMATION` → `PRODUCT_DEFINITION`, children
   by `NEXT_ASSEMBLY_USAGE_OCCURRENCE`, colours from `STYLED_ITEM` → presentation style chain →
   `COLOUR_RGB` / `DRAUGHTING_PRE_DEFINED_COLOUR`, mapped to the product through
   `SHAPE_DEFINITION_REPRESENTATION` and plain `SHAPE_REPRESENTATION_RELATIONSHIP`s (face
   colours are walked up shell → solid → representation; a solid colour wins over the most
   frequent face colour). The length unit and the protocol (AP203/214/242) are read too.
2. `kernel/stepImport.ts` hands OCCT one NAUO at a time (`XSControl_Reader::TransferEntity`
   of `StepModel::Entity(n)`, `n` = record position, checked against `IdentLabel`). The result
   is the component placed in its parent's coordinates; parts shared by several instances are
   transferred once (OCCT caches the product definition) and only carry a `TopLoc_Location`.
   Placements are composed down the tree. Every leaf solid becomes a body with its name
   (duplicates in one folder: `Link (2)`), colour and `itemPath`.
3. Items: the import step's id is registered (`interop/importFolders.ts`); when its bodies
   first appear, folders are created and the bodies filed once. Moving a part out, undo/redo
   or reopening the project never re-files it (folders are Items properties, not History).

Fallback: a file without product records, or a component OCCT cannot transfer, is imported
by shape hierarchy (all roots, one body per solid, named after the file) with a warning
"names and colours from the file are not applied".

Compatibility: the `importStep` feature gained `structure: 'assembly'`. Older projects (no
field) keep evaluating the file as one body, so their references stay valid. The first part
keeps the plain body id `body:<feature>` and face keys `<feature>:face:<n>`; later parts are
`body:<feature>:<i>` with keys `<feature>:<i>:face:<n>`.

Export (`kernel/stepExport.ts`): an XCAF document with one label per body (name, surface
colour) — flat top-level parts, or an assembly named after the project whose sub-assemblies
are the Items folders (identity placements: bodies are already in model coordinates). Colours
are converted sRGB → linear before `Quantity_ColorRGBA`: OCCT stores linear RGB and writes
sRGB, so replicad's `exportSTEP`, used before, wrote every mid-tone brighter (`#9AAE9B` came out
as ≈ `#CAD6CB`); now the file carries exactly the body colour. Options: `write.step.schema` 5
(AP242 DIS, default, what the app wrote before) or 4 (AP214 IS); `write.step.unit`
MM/CM/M/INCH (the model stays in mm; OCCT converts).

Fidelity checks (tests, real OCCT):

- `test/fixtures/interop/robot-assembly.step` (generator next to it): Robot = Base plate (red)
  - Arm:1 (translated) + Arm:2 (rotated 90° about Z, translated), Arm = Link (blue) + Pin
    (#33AA55, nested placement). Import: 5 bodies, names, colours, folders `Robot`, `Robot/Arm`,
    `Robot/Arm (2)`, bounding boxes of every part equal the hand-computed placements to 1e-3 mm,
    volumes exact.
- Export as assembly → re-import: tree `Kit/{Cube renamed, Round parts/Disc}`, names (Items
  name wins), colour `#9AAE9B` exact in the file and after re-import, volumes to 1e-6.
- AP214 + inches: `AUTOMOTIVE_DESIGN`, `CONVERSION_BASED_UNIT('INCH')`, re-imported cube
  volume 1000 mm³ ± 1e-3.
- Third-party read (evidence, not a test dependency): the robot re-exported as an assembly
  (AP242) and flat (AP214, inches) and read with OCP's full XCAF reader
  (`STEPCAFControl_Reader`, OCCT 7.8 in the build123d venv): assembly tree
  `Robot export/{Base plate, Arm/{Link, Pin}, Arm (2)/{Link, Pin}}` and flat
  `Base plate, Link, Pin, Link, Pin` as parts (no wrapper assemblies), colours `#FF0000`,
  `#0000FF`, `#33AA55` exact. Imported (located) parts are baked before the XCAF writer:
  otherwise XCAF writes each as an assembly around an unnamed part ("Open CASCADE STEP
  translator …") — found by this check, covered by
  `interopStep.test.ts` "imported (located) parts re-export flat and as an assembly".
- DXF: `ezdxf.recover` + auditor on the R2000 and R12 exports of the plate: 0 errors, 0
  fixes; entity counts LINE 5, ARC 3, CIRCLE 2, SPLINE 1, ELLIPSE 1, POINT 1 (R12: the spline
  and ellipse as 2 POLYLINEs).

## IGES

Only with the HimmelCAD OCCT build (`IGESControl_Reader`/`IGESControl_Writer`;
`replicad-opencascadejs` 1.1.0 has neither — `kernel/stepImport.ts#occtFormatCapabilities`
checks at run time).

- Import (`kernel/igesExchange.ts#readIges`): one `importStep` History step with
  `format: "iges"` (the file embedded like STEP, so the project stays self-contained).
  `TransferRoots`, then solids in the file (MSBO) are kept; loose faces are sewn
  (`BRepBuilderAPI_Sewing`, 1e-3 mm) and every closed shell becomes a solid
  (`ShapeFix_Solid::SolidFromShell`); open shells and unsewn faces stay surface bodies with a
  warning. Bodies are named after the file (`kit 1`, `kit 2`, …), palette colours. The file
  unit is converted to mm by OCCT.
- Export (`writeIges`, `export.iges`, File › Export IGES…): `IGESControl_Writer` with the
  chosen unit and mode `faces` (trimmed surfaces, type 144 — what every IGES reader takes;
  default) or `brep` (MSBO solids, IGES 5.3). Geometry and unit only: the XCAF IGES writer is
  not bound, so no names or colours (the dialog says so).
- Default module: Import/Export IGES are disabled with "IGES is not in this build …", a dropped
  `.igs` is refused, `import.iges`/`export.iges` answer `unsupported`, `interop.formats`
  reports `available: false` with the reason. A project with an IGES step opened on the default
  module shows that step failed with the same reason (the document is kept).
- Checks (`occtInterop.test.ts`, `api/interop.test.ts`, Python): cube + disc exported in inches
  (both modes) and re-imported → 2 valid solids, volumes to 1e-3, boxes to 1e-3 mm, same face
  counts; the robot assembly through `export.iges` → `import.iges`; a non-IGES file fails the
  step with "not a readable IGES file".

## Mesh → solid

Shapr3D keeps STL as a reference only ("STL-Import ist … Referenz und nicht ein vollständig
editierbarer parametrischer B-Rep", `research/2026-09-28/notes/scope-media.md` §3; "daraus
folgt weiterhin keine vollwertige Mesh→B-rep-Bearbeitung", `coverage-audit.md`, Mesh-
Referenzen, Shapr3D changelog 26.110). The Assembler adds an explicit, limited conversion so
simple printed-part meshes can be modified by kernel tools:

- `interop/meshSolid.ts`: weld (1e-6 of the diagonal), drop degenerate triangles, refuse open
  edges / edges shared by >2 triangles / several separate parts / non-orientable surfaces (the
  reason and the counts are shown), re-orient flipped triangles by walking shared edges,
  reverse an inside-out mesh (negative volume), group edge-connected coplanar triangles
  (normals within ~1e-4 rad, vertices within 1e-6 of the diagonal) into planar regions with
  boundary loops.
- `kernel/meshSolid.ts`: one `TopoDS_Vertex` per vertex, one `TopoDS_Edge` per mesh edge,
  one planar face per region (outer loop + holes; one face per triangle where a region's
  boundary is ambiguous or OCCT rejects the merged face), shell → `BRepBuilderAPI_MakeSolid`,
  `ShapeUpgrade_UnifySameDomain` (≤ 3 000 faces) to merge collinear edges, `BRepCheck`; if the
  merged build is invalid the per-triangle build is tried, and a second failure is an error.
  Measured in this wasm build: sewing 19 k separate triangles took 34 s (+28 s unify); the
  shared-topology build 9.5 s; an L-bracket (20 triangles → 8 faces) a few ms.
- Limits (`MESH_SOLID_LIMITS`): 60 000 triangles, 6 000 faces after merging. Curved surfaces
  stay faceted (one planar face per triangle) — a tessellated cylinder does not become a
  cylinder. The source reference mesh is hidden, not deleted. The step embeds the welded mesh
  (`meshSolid` feature, 12 bytes + 12 per vertex and per triangle, base64) so it replays
  without the mesh.
- Check: `l-bracket.stl` → 8 planar faces, volume 6000 mm³ exact, valid; filleting its outer
  vertical edge (r 3) gives 6000 − (9 − 9π/4)·10 mm³; a subdivided icosahedron (320 triangles,
  no coplanar pairs) → 320 faces, valid; `open-box.stl` refused "4 open edges (holes)".

## 3MF and OBJ

- 3MF (`interop/threeMfImport.ts`): ZIP read by `zipReader.ts` (stored + deflate via the
  platform's `DecompressionStream('deflate-raw')`; ZIP64/encryption refused), the root model
  from `_rels/.rels`, XML by `xmlScan.ts` (attributes, entities, namespace prefixes stripped).
  Each build item → one reference mesh; component and item transforms composed and baked
  (a mirroring transform flips the winding back); `unit` micron…meter → mm (reported);
  colours from `basematerials`/`colorgroup` via object `pid/pindex` or triangle `pid/p1`, the
  most common per object (per-triangle colours are not kept; reported when mixed). Checked by
  `parts.3mf` (cm unit, `p:path` part, colour group, mirrored item: bounding boxes and
  volumes exact) and by a round trip through the app's own 3MF writer (names, colours,
  placements, volumes).
- OBJ (`objImport.ts`): `v` (+ `r g b`), `f` with all index forms and negative indices,
  `o`/`g`; one mesh per group, folder = file (+ object). Not read: `.mtl` materials (a
  separate file), texture coordinates, normals, curves/surfaces (counted and reported).
- Both are unitless or declared: STL/OBJ get the one-time rescale offer (metres/inches by
  size), never applied silently; 3MF uses its declared unit.

## DXF

Reader (`interop/dxf.ts`), written from Autodesk's DXF reference: group-code pairs, HEADER
(`$INSUNITS`, `$ACADVER`), BLOCKS, ENTITIES. OCS extrusion (0,0,−1) is handled (x mirrored,
arcs turned around); entities on other planes, 3D polylines, polyface meshes, TEXT/MTEXT,
DIMENSION, HATCH, IMAGE, 3DSOLID … are skipped and counted ("Not imported: 1 × TEXT").
Binary DXF is refused. INSERT arrays import the first copy (reported).

Sketch (`dxfSketch.ts`): coordinates × unit scale into the sketch frame; bulged polyline
segments become arcs; clamped non-rational splines stay exact control-point splines (knots
normalised), fit-point splines become fit splines, rational/periodic ones are sampled into fit
splines (reported as approximated). "Connect end points" welds curve ends closer than 1e-6
of the drawing size into one sketch point — the sketch's own form of a coincident constraint,
so closed outlines become profiles. No other constraints or dimensions are invented (the
imported sketch is under-constrained and shows its DOF). Units: `$INSUNITS` when present;
otherwise read as mm and said so; the dialog can override (mm, cm, m, in, ft).

Writer: R12 (AC1009: LINE, ARC, CIRCLE, POLYLINE/VERTEX, POINT) and R2000 (AC1015 with
handles, owner links, `$HANDSEED`, CLASSES, the VPORT/LTYPE/LAYER/STYLE/VIEW/UCS/APPID/
DIMSTYLE/BLOCK_RECORD tables, `*Model_Space`/`*Paper_Space` blocks and the root dictionary);
sketch text is written as its glyph outlines. Face outline: lines, circles/arcs (centre from
the kernel's edge polyline, radius from the kernel), other curves as polylines, in the face's
sketch frame. R12 has no SPLINE/ELLIPSE: they become polylines within a chord tolerance of
max(1 µm, 1e-5 × drawing size) (was 64 pieces per knot span: one glyph outline became ~3 900
vertices and re-importing "HC" built a 7 800-line sketch, 13 s and 1.6 GB of kernel heap —
fuzzer finding F9, `ROBUSTNESS.md`; now 336 vertices, 0.2 s). Text through DXF is plain
curves: on import a glyph's counter (the hole of "A", "g") is a region of its own, so the
round trip does not keep the "counter is a hole" meaning of sketch text (finding D1).

Found and fixed on the way (`kernel/sketchGeometry.ts#regionFace`): a profile with holes
whose wires ran different ways (a circle next to an arc+line "D" hole) failed with "the face
with holes is off by …" because all holes were flipped together; holes are now oriented one by
one when the all-or-nothing attempts fail.

## Agent API and Python

Methods (`hcasm.agent-api@1`, schema regenerated): `interop.formats`; `import.step`
(`structure: assembly | single`, result `parts [{bodyId, name, color, itemPath}]`);
`import.mesh` (STL/3MF/OBJ → `meshes`, `unitHint`); `import.dxf` (plane/offset/face, connect,
unitScale → one sketch step; stats, skipped, units, warnings); `export.dxf` (sketchId or face,
R2000/R12); `mesh.toSolid` (meshId → one step, `unsupported` with the reason otherwise);
`export.step` (`schema`, `unit`, `structure: flat | folders`, `visibleOnly`); `import.iges`
and `export.iges` (`unit`, `mode: faces | brep`, `visibleOnly`) — HimmelCAD OCCT build only,
`unsupported` otherwise. `bodies.list` shows `itemPath`. Python:
`Document.import_step/import_iges/import_mesh/import_dxf/export_dxf/mesh_to_solid/
export_step/export_iges/formats` (`interop.py`), `AssemblerClient` counterparts.

## Evidence

- Tests: `test/kernel/interopStep.test.ts`, `test/kernel/meshSolid.test.ts`,
  `test/interop/meshImport.test.ts`, `test/interop/dxf.test.ts`, `test/api/interop.test.ts`,
  `test/electron/interop.test.ts` (packaged app, drag & drop), Python
  `test_interop_step_assembly_mesh_solid_dxf`.
- Screenshots (DEV hook): `D:\AgentWork\HimmelCAD-Assembler\shots\io-*.png` (drop overlay,
  STEP assembly in Items, DXF dialog/sketch/sketch mode, mesh selected, mesh → solid,
  fillet, open mesh refused, STEP export dialog), script `shots\io-shots.mjs`.
- Third-party validation: `D:\AgentWork\HimmelCAD-Assembler\interop-spike\validate.py`
  (inputs from `make-outputs.mjs`, output `validate-output.txt`).

## Limits

- Default module (no XCAF reader): layers, per-face colours beyond the part colour, instance
  (over-riding) colours, validation properties and PMI are not imported; the product structure
  comes from the file text (AP203/214/242 product/NAUO entities). The HimmelCAD build's XCAF
  route adds instance colours; layers, PMI and validation properties are still not imported.
- A file whose structure only the XCAF reader follows imports differently on the two
  modules (text route: shape-hierarchy fallback). Projects stay self-contained, but body ids
  of such an import depend on the module it is evaluated with.
- IGES: HimmelCAD OCCT build only; geometry only (no names, colours, structure).
- Mesh → solid: planar faces only (no surface fitting), ≤ 60 k triangles / 6 k faces, one
  closed part per conversion.
- 3MF: one colour per object; beam lattices, slices, textures and slicer project settings
  are ignored. OBJ: no materials.
- DXF: 2D in the XY plane of the drawing; no text/dimensions/hatches/layers/colours on import;
  INSERT arrays: first copy only. DWG is not read.
- Export "per body" asks for one file name per body (stop on Cancel), like the STL export.
