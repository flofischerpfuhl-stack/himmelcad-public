# 3D-printing tools — methods, thresholds and limits

Status: implemented 2026-09-30 (branch `asm/printability-20260930`). Owner
intent U1 (a CAD focused on 3D printing); PLAN §2 keeps an integrated slicer
out of scope — the app analyses, orients and exports, then hands the model to
an existing slicer. Code: `apps/assembler/renderer/src/print/**` (analysis,
orientation, UI), `renderer/src/kernel/{threeMf,stlExport,meshExport}.ts`
(exports), `electron/slicer{Paths,Ipc}.ts` (handoff), agent methods in
`renderer/src/api/printApi.ts`.

## Where it is in the UI

| Capability               | Entry points                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Printability mode        | `P`, left dock mode group "Print", command search "Printability". Panel next to Items; overlays in the viewport.                                                   |
| Place on Plate           | Select a flat face → adaptive toolbar / context menu / panel button; or select a body, run it, then click the face (hint chip; Esc or an empty click cancels).     |
| Auto Orient for Print    | Select one body → toolbar / context menu / panel button; the panel lists the top 3 candidates, the selected one is a green ghost; Apply (or double-click) commits. |
| Export STL…              | File menu / command search / panel button: scope, binary/ASCII, resolution, live triangle count and size.                                                          |
| Open in Slicer, Slicers… | File menu / command search / panel button. Desktop: launch the default slicer; browser build: download the 3MF.                                                    |

Print mode is view state (like Section/Measure): not saved in the project,
not undoable. Thresholds, material and printer are user preferences in
`localStorage` (`hcasm.print.settings.v1`). Place on Plate and an applied
orientation are ordinary `transform` History steps ("Place on Plate n",
"Orient for Print n": rotate about world X, Y, Z through the body's box
centre, then translate) — one undo step, editable afterwards, replayed by the
kernel like Move/Rotate.

## Analysis (build direction +Z)

Runs in its own Web Worker (`print/printability.worker.ts`), off the UI
thread, on the evaluated bodies of the committed document: automatically
when Print mode turns on and 350 ms after every document change (a newer
request cancels the running one), with progress per body and step and a
Cancel that terminates the worker (measured: 84–118 ms until "Cancelled" on a
32-body document). A report is only drawn on the meshes it was computed from;
while a newer one is pending the panel says "Out of date". Measured: 3 bodies
≈ 36 000 wall samples in 54–100 ms; 32 bodies ≈ 384 000 samples in 555 ms
(worker time, Ryzen 3 PRO 3200G, dev build).

| Check                 | Method                                                                                                                                                                                                                                                                                                             | Default threshold      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| Overhang              | Per triangle: angle from vertical = asin(−n_z) for downward normals (0° wall, 90° ceiling). Overhang if the angle exceeds the threshold by > 0.01°. Triangles whose three corners lie within 0.01 mm of the body's lowest point are "on the plate" and never overhangs. Reported per B-rep face (area, max angle). | 45°                    |
| Wall thickness        | Area-weighted sample points (≈ 12 000 per body, R2 low-discrepancy inside triangles, every B-rep face at least one) cast a ray inwards along the triangle's negative normal; the first hit on the same mesh (BVH, Möller–Trumbore) is the local thickness. Faces with thin samples are highlighted.                | 0.8 mm (two 0.4 lines) |
| Small holes / pins    | Cylindrical B-rep faces spanning at least half a turn (a circular boundary edge ≥ 0.98·π·r): diameter 2r from the edge radius; hole (concave) or pin (convex) from the sign of Σ area·n·(p − face centroid).                                                                                                       | hole 2 mm, pin 1 mm    |
| B-rep validity        | The kernel's `BRepCheck_Analyzer` verdict (`Body.valid`).                                                                                                                                                                                                                                                          | —                      |
| Watertight / manifold | The render mesh is welded (vertices within 1 µm merged, collapsed triangles dropped); every edge must be used by exactly two triangles running in opposite directions. Open, non-manifold and flipped edges are counted.                                                                                           | —                      |
| Volume, mass, cost    | Exact B-rep volume × density (solid part); cost = mass × price per kg. Presets PLA 1.24, PETG 1.27, ABS 1.04, TPU 1.21 g/cm³ (price 20/22/22/35 per kg, editable, currency label only).                                                                                                                            | PLA                    |
| Build volume          | Body bounding-box size ≤ printer volume (X, Y, Z); "fits only rotated 90° about Z" is a warning, not fitting at all an error. Presets Bambu Lab X1/P1 256³, Prusa MK4 250×210×220, Creality Ender-3 220×220×250, custom, none. The box is drawn centred on the origin on Z = 0.                                    | Bambu X1               |
| Not on plate          | Info when the lowest point is not at Z = 0 (slicers drop parts to the plate).                                                                                                                                                                                                                                      | ±0.01 mm               |

Overlay colours (fixed print semantics, legend in the panel): overhang amber
(threshold) → red (90°), thin walls violet, build volume translucent blue,
orientation preview translucent green. Clicking a finding selects its faces
(or the body) and frames them; thin walls are one finding per body with all
affected faces (a wall has two sides).

### Limits (stated honestly)

- **Wall thickness is sampled.** Features narrower than the sample spacing
  (≈ √(area / 12 000)) can be missed; the ray follows the surface normal, so
  it measures the thickness perpendicular to that face, not the true minimal
  distance to any other surface (a thin wedge is found near its tip only
  where samples land). Floors and roofs count as walls (a 0.6 mm floor is
  flagged although a slicer prints it as top/bottom layers). Tessellation
  chord error (≤ the display deflection) enters the result on curved walls.
- **Overhangs ignore bridging and self-support.** A horizontal ceiling
  spanning two walls (a bridge) is reported like any 90° overhang; overhangs
  above other parts of the same body are not distinguished from ones above
  the plate; the angle is per triangle of the display mesh.
- **Holes/pins:** only cylindrical faces with a circular edge are
  considered; holes split into several faces of less than half a turn each,
  slots and non-circular holes are not reported. Countersinks/cones are not
  analysed.
- **Mass/cost** assume a solid part; infill, walls, supports and waste are
  not modelled (the slicer's estimate is authoritative).
- Reference meshes (imported STL) are not analysed; they are exported and
  handed to slicers like bodies.
- Watertightness is checked on the render mesh after welding; it is the mesh
  the STL/3MF export writes, not the B-rep itself (that is `BRepCheck`).

## Build-plate orientation

- **Place on Plate:** rotation R = shortest rotation of the face's outward
  normal onto −Z (180° about X for +Z), decomposed into the transform
  feature's X-then-Y-then-Z angles (`eulerXYZ`, gimbal lock handled, float
  noise snapped to 1e-9°); pivot = body box centre; dz = −(lowest mesh vertex
  after the rotation). Only planar faces. On curved bodies the exact B-rep
  minimum can lie up to one tessellation deflection below the lowest vertex.
- **Auto orient:** candidates = the 6 principal directions + the normals of
  the 8 largest planar faces (duplicates within 1° merged). Each is scored on
  the rotated mesh: overhang area beyond the threshold (plate triangles
  excluded), height, plate contact area. Ranking: overhang area (ties within
  0.5 % of the surface area), then lower height, then larger contact, then
  candidate order — deterministic for the same input. Candidates are re-ranked
  after any change of the body.

## Exports

- **STL** (`kernel/stlExport.ts`): binary or ASCII (one `solid` per body,
  facet normals from the winding, 7-digit exponent numbers), all bodies in
  one file, the selected bodies, or one file per body (a save dialog per body
  in the desktop app, cancel stops). Resolution: the display mesh, or presets
  that re-tessellate the exact B-rep (`kernel/meshExport.ts`) — coarse 0.1 mm /
  0.5 rad, standard 0.025 mm / 0.25 rad, fine 0.005 mm / 0.1 rad (chordal /
  angular deflection). The preset meshes a triangulation-free deep copy
  (`BRepBuilderAPI_Transform`, identity, copy geometry, not meshes): OCCT never
  coarsens a finer existing triangulation, and the viewport's face-mesh cache
  is not disturbed. The dialog previews the triangle count per body and the
  expected file size.
- **3MF** (`kernel/threeMf.ts`, 3MF Core 1.3 + Materials and Properties
  1.2): content types, root relationship, `unit="millimeter"`; model metadata
  `Title`, `Application` (no timestamp unless given: byte-reproducible);
  one `m:basematerials` group with a `m:base` per body (name, `#RRGGBBAA`);
  an `m:colorgroup` per body with per-face colours (`faceColors`, per-triangle
  `pid`/`p1`; the app has no per-face colours yet, the writer supports them);
  one `object type="model"` per body with its display name, `partnumber` =
  stable body id and a `metadatagroup` (`hcasm:bodyId`, own declared
  namespace, not a required extension); the mesh is **welded** (the render
  mesh duplicates vertices per face; 3MF requires shared vertices and no
  degenerate triangles) and stored relative to the footprint centre / lowest
  point; one build `item` per object whose `transform` translates it back, so
  slicers keep the arrangement. No proprietary slicer project files
  (Bambu/Orca `Metadata/*.config`, PrusaSlicer `Slic3r_PE_model.config`) are
  written: they are not documented as a public format. The three slicers read
  core 3MF names, colours and item transforms.
- `test/kernel/threeMfValidator.ts` is an independent strict validator (own
  ZIP reader with CRC check and XML parser): content types for every part,
  the 3D-model relationship and target, model namespace and unit, metadata
  names (well-known or declared prefix), unique resource ids, property
  references and indices, vertex numbers, triangle indices in range and
  distinct, per-object closed and consistently oriented mesh with positive
  volume, build items referencing objects, 12-number non-mirroring
  transforms.

## Slicer handoff ("Open in Slicer")

- Detection (Windows, main process): `Bambu Studio\bambu-studio.exe`,
  `OrcaSlicer\orca-slicer.exe`, `Prusa3D\PrusaSlicer\prusa-slicer.exe` and
  `UltiMaker Cura <version>\UltiMaker-Cura.exe` (also `Ultimaker-Cura.exe`,
  `Cura.exe`; the newest version folder wins) under Program Files, Program
  Files (x86) and `%LOCALAPPDATA%\Programs`. Users add other slicers with a
  native "choose program" dialog (`.exe` only); registered slicers and the
  default live in `userData/assembler-slicers.json`.
- Launch: the renderer sends the 3MF bytes and a slicer **id** — never a path.
  The main process resolves the id from detection/settings, validates the
  executable again (absolute drive path, `.exe`, no UNC, no shells or script
  hosts such as `cmd.exe`/`powershell.exe`/`wscript.exe`, must exist), writes
  `%TEMP%\HimmelCAD-Assembler\slicer-handoff\<project>-<timestamp>.3mf`
  (older than a day removed on the next handoff) and starts
  `spawn(exe, [file], { shell: false, detached: true, stdio: 'ignore' })`.
- `pnpm dev:web` / the browser build: the 3MF is downloaded instead.
- **This host (DESKTOP-BNB2PBA, 2026-09-30): no slicer installed** — neither
  in the install folders nor in the Windows uninstall registry. Nothing was
  installed. The launch path is therefore verified by the unit tests
  (argument array, `shell: false`, path validation) and the IPC wiring by
  typecheck/build, not by launching a real slicer.

## Agent API and Python

`print.analyze`, `print.orientations` (queries), `print.placeOnPlate`,
`print.orient` (commands, transactional, one undo step), `export.meshStats`
and the `format`/`resolution` options of `export.stl`/`export.3mf` — schema in
`apps/assembler/api/agent-api-v1.schema.json`. In the app the queries run in
the print worker (a separate runner, so an agent never cancels the panel's
analysis) with the user's panel settings as defaults. Python:
`doc.printability(...)` → `PrintReport` (`findings_of`, `printable`,
`mass_g`, `body`), `doc.place_on_plate(face)`, `doc.orientations(body)`,
`doc.orient(body, rank=|down=)`, `doc.mesh_stats(resolution=)`,
`doc.export_stl(path, ascii=, resolution=)`, `doc.export_3mf(path, resolution=)`.

## Evidence

- `test/print/analysis.test.ts` — 45°/60° chamfered block (60° side only at
  45°, both at 44°, none at 65°, bottom on the plate never), shelled box
  (1.5 mm walls measured 1.5 ± 0.02 mm, none flagged at 0.8, all walls at 2),
  holes Ø1.5/Ø6 and a Ø0.8 pin, watertight welds and mesh volume ≈ B-rep
  volume, build-volume fit/rotated/none/custom, PETG mass and cost.
- `test/print/orientation.test.ts` — rotations onto −Z, Euler decomposition
  against the transform feature's own affine map (200 random rotations +
  gimbal lock), Place on Plate replayed by OCCT (face on Z = 0 facing −Z,
  volume kept), deterministic ranking (mushroom flipped upside down).
- `test/print/printStore.test.ts` — analysis on enable, debounced
  re-analysis after a document change, cancel, one undo step per placement /
  orientation, the face-click pick.
- `test/print/exportOptions.test.ts` — coarse < standard < fine, display
  mesh unchanged, coarse after fine stays coarse; ASCII = binary triangles.
- `test/kernel/threeMfStrict.test.ts` — four bodies (two coloured), face
  colour groups, rejection of open meshes, corrupted bytes, escaped names.
- `test/electron/slicerPaths.test.ts` — path validation, detection,
  settings parsing, launch description, handoff names.
- `test/api/print.test.ts`, `sdk/python/tests/test_assembler.py` — the
  agent contract and the Python helpers (headless integration included).
- Screenshots (DEV hook, `D:\AgentWork\HimmelCAD-Assembler\shots\pr-*.png`,
  script `pr-shots.mjs`): analysis overlays, finding focus, orientation
  ghost, placement, settings, STL dialog, slicers dialog (browser fallback),
  pick hint, progress and cancel on 32 bodies.

## Found on the way (fixed by the sketch merge)

Extruding a sketch region **with holes** directly (a rectangle with circles
inside, one region with holes) produced a body whose holes were added
instead of subtracted (volume 4141 mm³ instead of 3859 mm³), `BRepCheck`
invalid and inverted hole faces; the Printability panel reported it
(invalid B-rep, open mesh, the "hole" as a pin). Fixed on the sketch side
(`2efbc7c`, regions with holes cut their holes on every plane); since the
integration merge `test/print/analysis.test.ts` checks that case on the
merged kernel: valid B-rep, watertight, exact volume, two holes and no pin.

## Keyboard

`P` toggles Printability in the model. Inside an open sketch `P` is the
sketch **Project** tool instead: registry commands carry a
`shortcutScope` (`'sketch'` / `'model'`), the keyboard resolves with the
current context, and a test allows shared keys only in disjoint scopes.
Leave the sketch (Enter / Finish) to toggle Printability by key.
