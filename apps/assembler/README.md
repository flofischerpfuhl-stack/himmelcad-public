# @himmelcad/assembler

Himmel:CAD Assembler, a Shapr3D-like desktop CAD for 3D-printed parts.
Electron + TypeScript + React on `@himmelcad/theme` and `@himmelcad/ui`,
with a WebGL2 viewport and — since the Phase 1 kernel spike — a real B-rep
CAD kernel: OCCT 8.0.1 compiled to WebAssembly (`replicad-opencascadejs`),
driven through `replicad`, running in a Web Worker behind the app-owned
`KernelAdapter` (`renderer/src/foundation/geometry-kernel/`). Decision, measurements, the
stable-reference scheme and open risks: `assembler/KERNEL-SPIKE.md`.
The default OCCT module (since Block 6, 2026-09-30) is the HimmelCAD build with
more OCCT classes (`vendor/occt-wasm`, `assembler/OCCT-BUILD-SPIKE.md`), read
from the SHA-256-verified local artifact cache (`D:\AgentWork\HimmelCAD-Assembler\occt-wasm`
on Windows, `~/.cache/himmelcad/occt-wasm` elsewhere; `HIMMELCAD_OCCT_DIR`
overrides); a missing or wrong module fails loudly. `HIMMELCAD_OCCT=replicad`
(build, dev server, tests, benches, fuzzer) selects `replicad-opencascadejs`
1.1.0 instead — machines without the cache (CI) set it.

## Layout

Modules per ADR 0032 (`assembler/MODULES.md`; the map is `modules.json`,
checked by `pnpm check:assembler-modules`):

- `renderer/src/foundation/` — `document` (feature kinds, core kinds,
  references, parameters, `.hcasm` format), `sketch-solver`,
  `geometry-kernel` (the only OCCT code: adapter, worker runtime, evaluator,
  naming, tessellation, exchange), `commands` (store core with slices,
  command and API registries, the module contract), `jobs`.
- `renderer/src/platform/` — `input` (navigation, preferences), `viewport`
  (WebGL2 scene, picking by face/edge naming key, overlay host), `widgets`
  (shared panel building blocks, the UI contract).
- `renderer/src/modules/` — domain modules; `parameters`, `print` and
  `printers` are migrated, the others are descriptors over files still in
  `model/`, `chrome/`, `sketch/`, `interop/`, `kernel/features/`,
  `viewport/`, `api/` (phase B moves them).
- `renderer/src/interface/` — `agent-api` (the canonical command layer) and
  `shell-ui` (the application shell).
- `renderer/src/app/` — compositions: modules, UI parts, kernel worker entry.
- `renderer/public/licenses/` — third-party notices and license texts
  shipped with the app (OCCT is LGPL-2.1 with the Open CASCADE exception; see
  `LICENSES/THIRD_PARTY.md`).

## Scripts

- `pnpm dev` — Vite dev server + Electron together.
- `pnpm dev:web` — Vite only, for iterating on the renderer in a browser (the
  deployable browser product, a PWA, is `apps/assembler-web`; `assembler/WEB.md`).
- `pnpm build` — renderer (Vite) + Electron main/preload (`tsc`) + headless CLI.
- `pnpm typecheck` — renderer and main-process TypeScript projects.
- `pnpm test` — Node test runner; kernel tests load the real OCCT wasm in
  Node (once per test file).
- `pnpm test:electron` — production build, then Playwright-driven Electron
  checks (packaged code path, agent access, kernel determinism).
- `pnpm test:acceptance` — production build, then the PLAN §7 acceptance
  cases: headless through the agent API (parts, negative cases, hand-over,
  persistence) and one long Electron scenario (Home → template, hand-over,
  Select Through, kernel worker killed mid-edit, app killed → recovery).
  Case list and results: `assembler/ACCEPTANCE.md`.
- `pnpm test:fuzz [-- --seed N --minutes M]` — model-based fuzzer of the agent
  API with invariant checks and delta-debugged reproducers (default 3 min, on
  the module `HIMMELCAD_OCCT` selects; 51 operation kinds incl. sweep/loft/
  draft/rib/thicken, sketch text, construction planes, extrude extents and
  STEP/IGES/DXF export → import round trips);
  `pnpm test:monkey` — seeded random UI input against the production app
  (after `pnpm build`; `ASSEMBLER_MONKEY_MINUTES`, default 5). Design,
  invariants and findings: `assembler/ROBUSTNESS.md`.
- `pnpm bench:kernel` — kernel performance table (`assembler/KERNEL-SPIKE.md`).
- `pnpm bench:interactive` — interactive latency per stage (text + engrave,
  hole, fillet drag, 60-entity sketch drag) in Node; `-- --browser` also
  replays them in Chromium against a Vite dev server
  (`assembler/KERNEL-SPIKE.md` "Interactive latency").
- `pnpm package:win` — Windows installer (NSIS, per-user, no admin prompt)
  into `release/` via `electron-builder.win.yml`; `pnpm icon` regenerates the
  placeholder app icon (`scripts/generate-icon.mjs`).

## Modelling tools

Every tool that adds a feature is a session in the store's tool state
machine (`collectingReferences -> preview -> numericEditing -> committing`;
Cancel/Escape from any uncommitted state leaves the document untouched;
Done is exactly one undo step). Kernel tools (Extrude, Fillet/Chamfer `F`,
Shell `H`, Union/Subtract/Intersect) preview `features + provisional
feature` on the kernel's preview channel — one request in flight, newest
parameters next, stale results dropped. A kernel failure keeps the last
valid preview, shows the error under the tool pill and disables Done.
Extrude picks New/Join/Cut from face contact (out of a face joins, into a
body cuts, free-standing is new) until the badge overrides it; a single
clicked sketch region extrudes just that profile. A closed profile lying
inside a body face starts as a through-cut preview (Cut, the material's
depth under the profile) instead of "Join, 0 mm". Escape order: dimension
field, tool, selection.

## Sketch mode

Constrained sketches solved by FreeCAD's planeGCS (WebAssembly, own worker;
LGPL record in `LICENSES/THIRD_PARTY.md`). Line `L`, Arc `A`, Circle `C`,
Rectangle `R`, Polygon `G` start a sketch (on XY, or on the selected planar
face; the first click on a face moves an empty new sketch there); Trim `T`,
Offset `O`, Dimension `D`, Construction `Q` and the constraints (Shift +
letter) work inside it. Double-click a sketch (viewport, Items, History) to
edit it. Advanced tools: Spline `I` (fit/control points, tangent
handles), Slot `U` (straight/arc), Ellipse `Y` (full/arc), Text `K`
(Inter, stored outlines), Fillet/Chamfer `Shift+R`, Mirror `J`, Pattern
`N` (linear/circular), Project `P` (associative body edges/faces);
polygons inscribed or circumscribed; determined dimensions can be added as
reference dimensions. Snapping and inferred horizontal/vertical/perpendicular/parallel/
midpoint/point-on constraints while drawing; typed values add dimensions;
dimensions accept expressions (`d1 / 2`). Blue = under-constrained, green =
fully constrained; conflicting edits are rejected with a red banner and the
last valid sketch is kept. Dragging moves unconstrained geometry through the
solver. Esc cancels the tool, then leaves the sketch; the session undoes step
by step and becomes one document undo step. Profiles are the detected closed
regions (holes and intersections included), referenced by stable keys.
Project files are schema 2; schema 1 files migrate on load. Details and
limits: `assembler/SKETCHING.md`.

Modelling features (`model/features.ts`, kernel in `kernel/features/`,
tools in `model/featureTools.ts`, commands in
`model/commands/featureCommands.ts`) run as one generic `feature` tool
session with the same preview/commit/cancel contract. Each starts from the
selection (a disabled command says what is missing), and clicks while it
runs edit its references; clicking empty space finishes:

| Tool                         | Start from                                           | Handles / badges                                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revolve `V`                  | one sketch profile or planar face (+ axis edge)      | angle arc (15° snap, Shift free), New/Join/Cut, axis X/Y/Z; click an edge or sketch line (construction lines included) for the axis; default 360° about a construction line of the sketch, else an in-plane world axis                 |
| Sweep `W`                    | profile + path edges (chain), or a straight line     | New/Join/Cut; line-path length arrow; click edges/a sketch outline for the path                                                                                                                                                        |
| Loft                         | two or more profiles, in selection order             | New/Join/Cut, Smooth/Straight                                                                                                                                                                                                          |
| Mirror                       | bodies (+ a planar face as plane)                    | plane YZ/XZ/XY/face with offset arrow, Keep original / Mirror in place                                                                                                                                                                 |
| Pattern                      | bodies (+ an edge as direction/axis)                 | Linear/Circular, X/Y/Z, spacing arrow or angle arc, count chip                                                                                                                                                                         |
| Split Body                   | one body (+ a planar face)                           | plane YZ/XZ/XY/face with offset arrow                                                                                                                                                                                                  |
| Align                        | a face on the moving body, then a face on the target | Face to face / Same direction, Centred / Keep position, gap arrow                                                                                                                                                                      |
| Rotate Around Axis           | bodies (or a face of one) + an edge as the axis      | angle arc, Rotate/Copy, axis X/Y/Z/edge; click an edge or sketch line for the axis, bodies to add/remove; suggested for an edge + face (Shapr3D)                                                                                       |
| Offset Face                  | faces of one body (recommended for curved faces)     | distance arrow (negative removes material, e.g. enlarges a hole); printing clearance presets −0.1/−0.2/−0.3/−0.4 mm                                                                                                                    |
| Delete Face (`Del` on faces) | faces of one body                                    | — (holes, fillets and chamfers between planar faces)                                                                                                                                                                                   |
| Hole                         | a planar face, or a sketch with points/circles       | click the face to add a hole where clicked, click a hole to remove it; Simple/Counterbore/Countersink, Through all/Blind (depth arrow), size M2–M10 + ISO clearance/tap-drill or printed fit menu, Ø/head chips, cosmetic thread label |
| Emboss                       | sketch profiles + a planar or cylindrical face       | height/depth arrow, Emboss/Engrave; wraps around cylinders keeping surface lengths                                                                                                                                                     |
| Draft                        | side faces of one body                               | angle chip, pull direction; default neutral plane: the body's bottom (XY); click a flat face to make it the neutral plane                                                                                                              |
| Rib                          | a sketch with the rib line (History card or profile) | thickness chip, Towards the body / Other side; click sketch lines to add or remove                                                                                                                                                     |
| Thicken                      | faces of one body, or a sketch profile               | thickness arrow, Outside/Inside/Both sides, New body/Join/Cut                                                                                                                                                                          |

New/Join/Cut is chosen automatically: a profile mostly inside a body cuts
it, one touching a body (or lying on its face) joins, a free-standing one
makes a new body; the badge overrides it. The Move/Rotate gizmo (`M`) has
X/Y/Z arrows, X/Y/Z rotation rings (15° snap, Shift free), a centre that
can be dragged onto a face centroid, an edge midpoint or a circle centre
(the rotation pivot), and a Move/Copy badge; a pure translation commits a
`move` feature, anything else a `transform` feature. Every new feature has
a History card with editable parameters.

Variants of the kernel tools (`model/blendOptions.ts`): the Fillet/Chamfer
pill has Constant/Variable (end radius field) and Equal/Two distances/
Distance + angle (with Flip); **Fillet Face Edges** (selected faces),
**Fillet Inside Edges** / **Fillet Outside Edges** (a selected body) pick
edges by rule, re-evaluated on every edit. A fillet that fails outlines the
failing edge in the error colour (also when its History card is selected);
the History card lists picked edges and rules, each removable. Shell has
Inside/Outside, a printing clearance for outward shells (+0.1…+0.4 mm: a case
that fits over the part) and opens/closes faces clicked while it runs; its
History card edits the clearance and per-wall thickness. Booleans keep or
consume their tools, Swap exchanges target and tool, clicking bodies
adds/removes tools.

## Selection, navigation and workspace

Box selection from empty canvas (drag right: enclosed, drag left: touched;
Tab or A/B/F/E filter while dragging; also in sketch mode), a pick list for
overlapping geometry, Select Through (`Ctrl+Shift+S`; Save As is
`Ctrl+Shift+Alt+S`), a view cube with face/edge/corner views, roll arrows
and a menu, perspective/orthographic, zoom to selection (`Z`), look at face
(pointer over a face + Space), up to 8 saved views, navigation presets,
Items folders/renaming/colour, History filter, rollback marker and
validated reordering, the shortcut sheet (hold Ctrl or `?`), Settings
(`Ctrl+,`) and touch/pen gestures. Decisions (e.g. names/folders are item
properties, colour is a `setAppearance` step) and limits:
`assembler/SELECTION-NAVIGATION.md`. Touch and pen (gestures, pen strokes
that become constrained sketch geometry, palm rejection, tablet layout,
handedness, number keypad, Settings › Touch and pen): `assembler/TOUCH.md`.

## Shapr3D parity (gap inventory)

`assembler/GAP-INVENTORY.md` lists every documented Shapr3D behaviour with
its status here, evidence and effort, and a weighted parity estimate; update
the rows when a behaviour changes. Behaviours added from it (2026-09-30):

- **Adaptive toolbar** (`registry.ts` `resolveAdaptive`): only actions for the
  selection; face → Offset Face (then Extrude), two faces of two bodies →
  Align, edge + face/body → Rotate Around Axis, profile + edge → Revolve; the
  bar fills the window height and shows More only for what does not fit
  (`chrome/adaptiveLayout.ts`).
- **Command search**: exact > prefix > word > abbreviation ("p3", "nsxy") >
  subsequence; with a selection only valid actions (plus strong name matches
  with their reason).
- **Empty-space click = Done** for Fillet/Chamfer, Shell, Booleans and the
  feature tools, said in the tool pill (`model/toolFinish.ts`).
- **History card**: Breakpoint after this step, Zoom to, Duplicate, expand/
  collapse all; focused card: Del suppresses, Shift+Del deletes.
- **Snapping** (right dock magnet): Grid, Points, Midpoints, Guidelines, On
  curves, Body points, Far edges, Auto-constrain, New constraints keep, Show
  snap hints; the grid resolution follows the
  zoom (read-out + lock, `model/gridResolution.ts`).
- **Settings**: custom shortcuts (`commands/shortcutOverrides.ts`), Selection
  extension. Saved views keep the section state; Nearest ortho view; quick
  measurement in the status strip.

Parity round 2 (branch `asm/parity2-20260930`):

- **Extrude**: New/Join/Cut/Intersect; extent Distance / To Object (click a
  face, construction plane or body) / Through All; One side / Symmetric / Two
  sides (second handle); start offset — pill badges and History card
  (`kernel/features/extrudeExtent.ts`).
- **Construct** flyout (`constructCommands.ts`, `model/construction.ts`):
  planes (offset, angle about an edge/axis, 3 points, midplane, tangent to a
  cylinder) and axes (edge, two points, cylinder, plane intersection) as
  History steps and Items rows; usable as sketch, mirror, split and section
  planes and as revolve/pattern/rotate/mirror axes.
- **Tool before selection** (`model/pickSession.ts`): a command started
  without its selection asks for each reference in the pill; picks become
  badges (× removes, Swap), Next/Start.
- **Move/Rotate**: plane tiles, Auto-orient (the gizmo follows the face/edge
  the centre is dropped on; World axes resets); a face moves along its normal
  (Offset Face step), a sketch region moves in its plane; edges are refused
  with the reason (no face replacement in this kernel build).
- **History Fix…** (`model/fixReference.ts`): the missing reference's last
  place as a red ghost; pick a replacement, one undo step each.
- **Booleans** Keep target; **Mirror** sketches, faces and about an axis;
  **History filter** uses the isolated objects when nothing is selected.
- Sketch additions (3D snaps, arc ends-then-bulge, 3-point rectangle, First/
  Last selected, continue previous sketch): `assembler/SKETCHING.md`.

Block 8, sketch stream (branch `asm/b8-sketch-20261001`):

- **Sketch curves outside sketch mode**: pick a line/arc/curve in the model;
  Edit Sketch opens it with the curve selected, Delete from Sketch, Toggle
  Construction (`SKETCHING.md` › Block 8, with patterns in two directions
  editable later, spline/ellipse offsets with per-loop arrows, fillets on
  arcs, installed fonts + alignment + text gizmo, Disconnect, Unlink, circle
  radius/diameter, units in expressions).
- **Reference images** (`renderer/src/modules/canvas`): Add › Image… puts a
  PNG/JPEG on the selected planar face / construction plane (else XY) as a
  History step; width, centre, rotation and opacity on its card, an opacity
  slider under its selected Items row, Calibrate Image (two points + the real
  distance); pictures are saved in the project (`images`).
- **Measure**: sums over several edges/faces/bodies, ΔX/ΔY/ΔZ of a distance.
- **Display**: X-Ray opacity slider; grid plane XY/XZ/YZ; Export image Body
  edges toggle. **Export OBJ**. **Ctrl+A** in Items selects the listed rows.
- Readable missing-reference messages (`the end face of "Body 1" created by
"Extrude 2"`); command search Esc clears first, then closes; the shared
  Select opens with Arrow keys and closes only itself on Escape.

## 3D printing (Print mode, build plate, exports, slicer handoff)

`P` (or "Print" in the left dock's mode group) opens the Printability
panel: overhang map (default 45° from vertical, build direction +Z), sampled
wall thickness (default 0.8 mm), small holes/pins, B-rep validity and
watertight mesh per body, volume/mass/cost (PLA/PETG/ABS/TPU presets) and a
printer build volume (Bambu X1/P1, Prusa MK4, Ender-3, custom) drawn as a
translucent box. The analysis runs in its own worker with progress and
Cancel and re-runs after every document change; clicking a finding selects
and frames its faces. Place on Plate (a flat face → −Z on Z = 0) and Auto
Orient (top 3 candidates by overhang area and height, ghost preview) commit
one editable `transform` step. Export STL… (binary/ASCII, per body/all,
coarse/standard/fine re-tessellation with a triangle preview), 3MF (welded
manifold objects, names, colours, item transforms) and Open in Slicer
(detected or added Bambu Studio / OrcaSlicer / PrusaSlicer / Cura, temp 3MF,
`spawn` without a shell; the browser build downloads). Code in
`renderer/src/modules/print/`, `renderer/src/modules/printers/`, `electron/slicer*.ts`; methods, thresholds and limits:
`assembler/PRINTING.md`.

## Display, Measure, Section View and image export

- **Display** (right dock, View › Display, command search, `Alt+1…7`): Shaded
  with edges, Shaded, Wireframe, X-Ray, Visualized (per-body material: PLA
  matte, PETG glossy, metal, resin — set with the body's colour in the
  Appearance dialog, stored as `material` on its `setAppearance` step),
  Zebra stripes and Curvature map; toggles for edges, hidden edges (dashed,
  `Alt+H`), grid (`Alt+G`) and axes; High quality (screen-space ambient
  occlusion, ground contact shadow) is a preference. The curvature map is
  the maximum normal curvature estimated per mesh vertex from the kernel's
  vertex normals (`viewport/bodyGeometry.ts`) — an approximation that
  depends on the tessellation, stated in its legend; zebra stripes are view-
  anchored reflections of parallel bars (continuity check).
- **Renderer** (`viewport/gl.ts`): kernel meshes stay on the GPU (uploaded
  once per tessellation), edges/silhouettes/highlights are anti-aliased
  instanced screen-space lines of the same CSS width at any DPR, silhouettes
  of curved faces come from per-mesh candidate edges, clip planes adapt to
  the visible model (`camera.ts#depthRange`), picking is drawn lazily (only
  when something reads it) with one draw per body. Idle: no frames drawn.
  Measured 2026-09-30 (Ryzen 3 3200G, Radeon Vega 8, `viewportBenchmark`):
  the 60-feature synthetic plate (53k triangles) costs 2.6 ms per frame at
  1440 × 900 with High quality (1.7 ms wireframe), 5.3 ms at DPR 2.
- **Measure** (left dock › Measure): a movable panel with the current
  measurement (selection, or two points picked with Points — snapped to
  vertices, edge midpoints and circle centres) and pinned ones (pin, show/hide
  in the view, copy, delete; saved in the project's `viewState.measurements`
  as references and re-measured on every change). Body box/volume/mass
  (density from the material, PLA otherwise), edge length, circle/arc
  radius/diameter, face area, cylinder diameter, parallel distances, angles
  between faces/edges, centre distances; minimum distance between any two
  bodies/faces/edges/points is exact from the kernel (`BRepExtrema`,
  `KernelAdapter.measureDistance`), else (reference meshes) a mesh estimate
  labelled "approx.". Values in the display unit (Settings).
- **Section View**: X/Y/Z or **Face** (the selected planar face, or pick
  one), caps in each body's own colour (stencil parity per body, hatched),
  cut outlines, **Section only** (2D: just the cut regions, camera normal to
  the plane) and **Look at section**. Plane and section-only are view state.
- **File › Export image…** (`Ctrl+Shift+E`): the current view as PNG — view
  size ×1–4, Full HD, QHD, 4K or custom, optional transparent background and
  grid/axes; rendered offscreen (4× MSAA) without tool handles and hover.

## Files, reference meshes and the Windows installer

- `.hcasm` projects (schema 3, `foundation/document/format.ts`) also carry the
  view state (display mode, section, grid, panels, last camera preset, saved
  views), Items names/folders (`items`) and STL reference meshes
  (`referenceMeshes`, gzip+base64 via `meshCodec.ts`); all three are
  optional and additive, so no schema bump. Block 8 adds, also additive:
  `images` (reference-image pictures, base64, only those a step uses),
  `SketchData.patterns`, `SketchText.align`, `viewState.display.xrayOpacity`/
  `gridPlane` (written only when not default), the optional fields
  `extrude.taper`, `revolve.helix`, the second direction and spacing modes
  of `pattern`, `split.profile`/`keepOriginal`, and the feature kinds
  `referenceImage`, `primitive`, `scale`, `translate`, `moveEdge` and
  `moveFace`. Files without them read exactly as before, so the schema
  stays 3 and there is no migration. Older builds refuse a file with a new
  kind (unknown kind) but ignore unknown optional fields: a tapered
  extrude, a helical revolve or a two-direction pattern opens there as the
  plain feature (no released build is affected; decide on a version bump
  or a minimum-reader field before the first release). Dirty tracking covers features,
  Items, saved views and reference meshes; the feature-id counter is reseeded
  from each loaded document.
- STL import (File > Import STL…, binary or ASCII, `kernel/stlImport.ts`):
  a reference mesh is shown, measured (bounding box), hidden, renamed,
  filed in folders, deleted and exported (STL/3MF) like a body, but it is
  never a kernel input — modelling tools refuse it as a reference. A bounding
  box that looks like metres or inches offers a one-time rescale to mm; it is
  never applied silently. **Convert Mesh to Solid** (adaptive toolbar/context
  menu of a selected mesh) turns a closed, manifold mesh into a B-rep body
  (one step; coplanar triangles merged into planar faces; open, non-manifold
  or too large meshes are refused with the reason).
- **Import/export** (`renderer/src/modules/interop/`, details, fidelity checks and
  limits: `assembler/INTEROP.md`): File › Import… (every format), drag & drop
  of files onto the window, progress with Cancel. STEP assemblies keep their
  product structure (nested Items folders, part names and colours, one Import
  step); 3MF (objects, transforms, unit, colours) and OBJ (groups) become
  reference meshes; DXF becomes a sketch on a plane or planar face. Export
  STEP… (assembly from Items folders / flat / per body, AP242/AP214, mm/cm/m/in,
  all/visible/selected), Export DXF… (sketch or planar face outline, R2000/R12),
  STL "visible bodies" scope. IGES import/export and OCCT's XCAF STEP reader
  need the HimmelCAD OCCT build (the default; `assembler/OCCT-BUILD-SPIKE.md`);
  with `HIMMELCAD_OCCT=replicad` the IGES entries are disabled with the reason. Agent API: `import.step/iges/mesh/dxf`,
  `export.step/iges/dxf`, `mesh.toSolid`, `interop.formats`.
- File > Open Recent (Electron): up to 8 files, missing ones greyed with
  Locate…/Remove (`electron/recentFiles.ts`, stored in `userData`). The main
  process only opens paths that are on that list. A file is added only after
  it opened successfully (the renderer confirms, `recentFiles.confirmOpened`);
  a corrupt file never enters the list.
- **Home screen** (`chrome/HomeScreen.tsx`): shown when the app starts without
  a file (Settings › Home at start) and via File › Home (Ctrl+Shift+H).
  New project, Open…, templates, recent projects with thumbnails, a crash
  recovery offer (instead of the dialog while Home is up) and a "Getting
  started" card whose five keys are read from the command registry. A modal
  layer: Escape/close returns to the current document; only File shortcuts
  work while it is open; everything is a real button (Tab order: New, Open,
  templates, recent projects). Unsaved changes are asked about by the same
  dialog as New/Open (`projectStore` pending action `template`).
- **Templates** (`templates/projectTemplates.ts`): Blank, Enclosure with lid
  (parametric: `width`, `depth`, `height`, `wall`, `clearance`,
  `screw_clear`), Bracket, Cable clip. Each is a script of canonical
  agent-API commands run by an `AgentSession` on the live document
  (`projectStore.newFromTemplate`), so it is a real, editable History; the
  result becomes the baseline (undo cleared, not dirty, no recovery copy).
  The same builders run headless in the acceptance suite, which checks their
  volumes against hand calculations.
- **Thumbnails — decision: inside the `.hcasm`.** Save renders a 320 × 200
  PNG of the current view through the image-export path
  (`model/project/thumbnail.ts` → `renderViewportImage`, transparent, no
  grid) and stores it as `thumbnail` (`data:image/png;base64,…`, ≤ 400 kB)
  right after `projectName`. The main process reads only the first 512 kB of
  each recent file to find it (`recentFiles.ts` `extractThumbnail`, PNG data
  URLs only), so a large model is never parsed for the Home screen. Chosen
  over a sidecar file or a `userData` cache because the preview then travels
  with the project (copy, sync, e-mail), needs no invalidation and cannot go
  stale or orphaned; cost ~50–150 kB per file. Optional and additive (no
  schema bump; an invalid thumbnail is dropped on load, never a reason to
  reject the project). Recovery copies and agent `project.save` texts carry
  none.
- Windows installer (`pnpm package:win`): NSIS, per-user install into
  `%LOCALAPPDATA%\Programs\HimmelCAD Assembler`, `.hcasm` file association
  (a double-click or a command-line path opens the project; a second launch
  forwards it to the running window). The installer bundles the default OCCT
  module (the HimmelCAD build, `assets/himmelcad_occt-<hash>.{js,wasm}`; built
  from the verified local cache). The OCCT and planeGCS `.wasm` files,
  their Emscripten loader chunks and the licence texts are unpacked next to
  `app.asar` (`resources/app.asar.unpacked/dist/renderer/`) so the LGPL
  components stay replaceable files (verified: a broken replacement of either
  `.wasm` makes the installed app report that module's load failure).
  `app.asar` holds only `dist/` (~1.6 MB; `node_modules` are excluded, Vite
  bundles everything). Measured 2026-09-30: installer 108 MB, 372 MB
  installed, silent install `/S /D=<dir>` about 18 s; the uninstaller also
  removes the `.hcasm` association (`build/installer.nsh`). Unsigned; the
  icon is a placeholder.

## Agent API (UI, Python and agents share one command layer)

`renderer/src/interface/agent-api/` implements the canonical command/query contract
`hcasm.agent-api@1` (schema: `api/agent-api-v1.schema.json`). Two
transports run it: `assembler-headless` (JSON-RPC over stdio, OCCT in a
worker thread with a time budget — `pnpm build:headless`, then
`node bin/assembler-headless.mjs`) and, in the desktop app, the opt-in
"Agent Access (Local)" loopback endpoint (off by default, bearer token,
indicator while on). Python: `sdk/python/src/himmelcad/assembler`.
Benchmark: `bench/run_bench.py`. Design, trust boundary, evidence and
limits: `assembler/AGENT-API.md`.

- `pnpm api:schema` — regenerate the checked-in contract after changing
  the modules' API registrations (composed in
  `renderer/src/interface/agent-api/schema.ts`; a test fails while they
  differ).
- New feature kinds: register the kind's schema with its module's
  `api.featureKinds` (`assembler/MODULES.md` §3); until then the kind is
  accepted generically.

## Dev automation hook (DEV only)

`pnpm dev:web` / `pnpm dev` builds expose `window.__assembler` for cheap,
calibration-free screen recordings and UI smoke scripts (Playwright). It is
installed from `renderer/src/app/devtools/automationHook.ts` behind
`import.meta.env.DEV`, is absent from production builds and is **not part
of the product contract** (agents use the agent API above). Screen positions are CSS pixels relative to the page
viewport, directly usable with `page.mouse`.

| Member                                | Returns                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `store`                               | The zustand store (`getState()`, actions).                                                                                                                                                                                           |
| `project([x, y, z])`                  | `{ x, y }` of a world point (mm), or `null` behind the camera.                                                                                                                                                                       |
| `faceAnchor({ bodyId, faceKey })`     | A visible, unoccluded pixel of the face, found in the picking id buffer (largest clearance to other ids), or `null` if hidden/occluded.                                                                                              |
| `edgeAnchor({ bodyId, edgeKey })`     | Same for an edge (its pick ribbon).                                                                                                                                                                                                  |
| `handleAnchor(kind)`                  | Same for a drag handle: `'extrude' \| 'blend' \| 'shell' \| 'section'`, a feature-tool handle `'feature:<id>'` (`angle`, `offset`, `spacing`, `distance`, `length`), a Move/Rotate ring `'ring:0..2'` or the gizmo centre `'pivot'`. |
| `bodies()`                            | Displayed bodies (the active tool's preview if any): `id`, `name`, `volume`, `min`, `max`.                                                                                                                                           |
| `faces(bodyId)` / `edges(bodyId)`     | Stable references (`faceKey`/`edgeKey`) with readable names (`"Extrude 1 end · plane +Z at …"`, `"Circle Ø6 at …"`) plus geometry.                                                                                                   |
| `waitForKernelIdle()`                 | Resolves when no document/preview evaluation is outstanding and that state has been drawn (so anchors are current).                                                                                                                  |
| `sketchToScreen([u, v], id?)`         | Page pixel of sketch coordinates in the open sketch session (or in the evaluated sketch `id`), `null` if not visible.                                                                                                                |
| `sketchSession()`                     | Open session summary: feature id, tool, DOF, problem message, constraint kinds, dimensions (`id`, `name`, `kind`, `value`), selection.                                                                                               |
| `dimensionChip(name)`                 | Centre of the value chip of dimension `name` (e.g. `"d1"`), or `null`.                                                                                                                                                               |
| `waitForSketchIdle()`                 | Resolves when no sketch edit/drag solve is pending, the document settled and the frame is drawn.                                                                                                                                     |
| `sketchStore`                         | The sketch-mode zustand store (`begin`, `dispatch`, `setTool`, …).                                                                                                                                                                   |
| `workspaceStore`                      | Workspace view state: Select Through, saved views, `sendCamera({ kind: 'home' \| 'fitAll' \| 'fitSelection' \| 'direction' \| 'roll' \| 'pose' \| 'lookAtFace' })`, overlays.                                                        |
| `itemsStore` / `preferences`          | Item names and folders; user preferences (theme, units, navigation preset, projection, `animateCamera` — set `false` for deterministic shots).                                                                                       |
| `cameraPose()`                        | The live camera pose (`yaw`, `pitch`, `roll`, `fov`, `target`, `distance`).                                                                                                                                                          |
| `printStore`                          | Print mode: `setEnabled`, `settings`/`updateSettings`, `status`/`progress`/`report`, `focusFinding`, `startPlacePicking`, `startAutoOrient`/`applyOrientation` (`D:\AgentWork\HimmelCAD-Assembler\shots\pr-shots.mjs`).              |
| `viewportStats(finish?)`              | Renderer counters: frames drawn (idle check), last frame CPU ms, uploads, draw calls, AO/shadow state; `finish` syncs the GPU after each frame.                                                                                      |
| `viewportBenchmark(frames)`           | Mean ms per frame over `frames` back-to-back renders while orbiting (scene build + GPU, no vsync).                                                                                                                                   |
| `measureStore`                        | Measure panel state: pins, picked points, Points tool.                                                                                                                                                                               |
| `commands`                            | The command registry as the UI sees it: `list()`, `adaptive()` (order + recommendation for the selection), `search(query)`, `run(id)` (`D:\AgentWork\HimmelCAD-Assembler\shots\g-probe.mjs`, `g-shots.mjs`).                         |
| `projectStore`                        | Project file state: `newFromTemplate(id)`, `requestTemplate`, `checkRecovery`/`restoreRecovery`, `dirty`, `busyMessage`; Home is `workspaceStore.setHomeOpen` (`D:\AgentWork\HimmelCAD-Assembler\shots\h-shots.mjs`).                |
| `interopStore`                        | Import/export: `importFiles`, the running `job` (`cancelJob`), DXF/STEP/DXF-export dialogs, `convertMeshToSolid`; files can also be dropped as a synthetic `DataTransfer` (`D:\AgentWork\HimmelCAD-Assembler\shots\io-shots.mjs`).   |
| `datums()` / `datumAnchor(featureId)` | Displayed construction planes/axes (`featureId`, `kind`, `center`, `size`) and a clickable pixel of one (`p2-shots.mjs`).                                                                                                            |
| `fixStore`                            | History "Fix…" session (`session`, `end`).                                                                                                                                                                                           |

The view cube's cells carry `data-cell="<face>:<i>:<j>"` (e.g. `front:1:1` =
the Front-Right-Top corner) for DOM-anchored clicks. Example (see
`D:\AgentWork\HimmelCAD-Assembler\shots\tool-shots.mjs` and `n-shots.mjs` on
the Windows host for full scripts):

```js
const a = window.__assembler;
const body = a.bodies()[0];
const edge = a.edges(body.id).find((e) => e.curve === 'line' && e.midpoint[2] === 46);
const p = a.edgeAnchor(edge); // then: page.mouse.click(p.x, p.y), press 'f'
await a.waitForKernelIdle();
```

## Boundary

Assembler must not depend on Builder: no `apps/builder`,
`@himmelcad/automation-host`, `@himmelcad/viewer`, `@himmelcad/app`, or the
Builder sidecar. The shared agent package `@himmelcad/agent` is used by the
assistant module only (owner decision, ROADMAP-LATER §2; changes to it stay
additive and keep Builder's tests green), like the shared theme and UI
packages. See `assembler/README.md` (product/plan overview),
`assembler/AGENT-ASSISTANT.md` and `docs/adr/0033-assembler-product-boundary.md`
(the boundary decision) for the authoritative rules.
