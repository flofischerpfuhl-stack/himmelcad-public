# @himmelcad/assembler

Himmel:CAD Assembler, a Shapr3D-like desktop CAD for 3D-printed parts.
Electron + TypeScript + React on `@himmelcad/theme` and `@himmelcad/ui`,
with a WebGL2 viewport and — since the Phase 1 kernel spike — a real B-rep
CAD kernel: OCCT 8.0.1 compiled to WebAssembly (`replicad-opencascadejs`),
driven through `replicad`, running in a Web Worker behind the app-owned
`KernelAdapter` (`renderer/src/kernel/`). Decision, measurements, the
stable-reference scheme and open risks: `assembler/KERNEL-SPIKE.md`.

## Layout

- `renderer/src/model/` — feature document (`document.ts`), store with
  async evaluation, undo/redo, tools and selection (`store.ts`), command
  registry.
- `renderer/src/kernel/` — kernel adapter contract, OCCT evaluator,
  naming/reference resolution, worker.
- `renderer/src/viewport/` — WebGL2 scene, picking by face/edge naming key.
- `renderer/src/sketch/` — constrained sketches and sketch mode: data model,
  region (profile) detection, planeGCS solver worker, drawing tools,
  inference, session store and overlay UI (`assembler/SKETCHING.md`).
- `renderer/public/licenses/` — third-party notices and license texts
  shipped with the app (OCCT is LGPL-2.1 with the Open CASCADE exception; see
  `LICENSES/THIRD_PARTY.md`).

## Scripts

- `pnpm dev` — Vite dev server + Electron together.
- `pnpm dev:web` — Vite only, for iterating on the renderer in a browser.
- `pnpm build` — renderer (Vite) + Electron main/preload (`tsc`) + headless CLI.
- `pnpm typecheck` — renderer and main-process TypeScript projects.
- `pnpm test` — Node test runner; kernel tests load the real OCCT wasm in
  Node (once per test file).
- `pnpm test:electron` — production build, then Playwright-driven Electron
  checks (packaged code path, agent access, kernel determinism).
- `pnpm bench:kernel` — kernel performance table (`assembler/KERNEL-SPIKE.md`).
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
`assembler/SELECTION-NAVIGATION.md`.

## Files, reference meshes and the Windows installer

- `.hcasm` projects (schema 2, `model/project/format.ts`) also carry the
  view state (display mode, section, grid, panels, last camera preset, saved
  views), Items names/folders (`items`) and STL reference meshes
  (`referenceMeshes`, gzip+base64 via `meshCodec.ts`); all three are
  optional and additive, so no schema bump. Dirty tracking covers features,
  Items, saved views and reference meshes; the feature-id counter is reseeded
  from each loaded document.
- STL import (File > Import STL…, binary or ASCII, `kernel/stlImport.ts`):
  a reference mesh is shown, measured (bounding box), hidden, renamed,
  filed in folders, deleted and exported (STL/3MF) like a body, but it is
  never a kernel input — modelling tools refuse it as a reference. A bounding
  box that looks like metres or inches offers a one-time rescale to mm; it is
  never applied silently.
- File > Open Recent (Electron): up to 8 files, missing ones greyed with
  Locate…/Remove (`electron/recentFiles.ts`, stored in `userData`). The main
  process only opens paths that are on that list.
- Windows installer (`pnpm package:win`): NSIS, per-user install into
  `%LOCALAPPDATA%\Programs\HimmelCAD Assembler`, `.hcasm` file association
  (a double-click or a command-line path opens the project; a second launch
  forwards it to the running window). The OCCT and planeGCS `.wasm` files,
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

`renderer/src/api/` implements the canonical command/query contract
`hcasm.agent-api@1` (schema: `api/agent-api-v1.schema.json`). Two
transports run it: `assembler-headless` (JSON-RPC over stdio with the
in-process kernel — `pnpm build:headless`, then
`node bin/assembler-headless.mjs`) and, in the desktop app, the opt-in
"Agent Access (Local)" loopback endpoint (off by default, bearer token,
indicator while on). Python: `sdk/python/src/himmelcad/assembler`.
Benchmark: `bench/run_bench.py`. Design, trust boundary, evidence and
limits: `assembler/AGENT-API.md`.

- `pnpm api:schema` — regenerate the checked-in contract after changing
  `renderer/src/api/schema.ts` (a test fails while they differ).
- New feature kinds: add an entry to `FEATURE_KIND_SCHEMAS`
  (`renderer/src/api/schema.ts`); until then they are accepted generically.

## Dev automation hook (DEV only)

`pnpm dev:web` / `pnpm dev` builds expose `window.__assembler` for cheap,
calibration-free screen recordings and UI smoke scripts (Playwright). It is
installed from `renderer/src/devtools/automationHook.ts` behind
`import.meta.env.DEV`, is absent from production builds and is **not part
of the product contract** (agents use the agent API above). Screen positions are CSS pixels relative to the page
viewport, directly usable with `page.mouse`.

| Member                            | Returns                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `store`                           | The zustand store (`getState()`, actions).                                                                                                                                                                                           |
| `project([x, y, z])`              | `{ x, y }` of a world point (mm), or `null` behind the camera.                                                                                                                                                                       |
| `faceAnchor({ bodyId, faceKey })` | A visible, unoccluded pixel of the face, found in the picking id buffer (largest clearance to other ids), or `null` if hidden/occluded.                                                                                              |
| `edgeAnchor({ bodyId, edgeKey })` | Same for an edge (its pick ribbon).                                                                                                                                                                                                  |
| `handleAnchor(kind)`              | Same for a drag handle: `'extrude' \| 'blend' \| 'shell' \| 'section'`, a feature-tool handle `'feature:<id>'` (`angle`, `offset`, `spacing`, `distance`, `length`), a Move/Rotate ring `'ring:0..2'` or the gizmo centre `'pivot'`. |
| `bodies()`                        | Displayed bodies (the active tool's preview if any): `id`, `name`, `volume`, `min`, `max`.                                                                                                                                           |
| `faces(bodyId)` / `edges(bodyId)` | Stable references (`faceKey`/`edgeKey`) with readable names (`"Extrude 1 end · plane +Z at …"`, `"Circle Ø6 at …"`) plus geometry.                                                                                                   |
| `waitForKernelIdle()`             | Resolves when no document/preview evaluation is outstanding and that state has been drawn (so anchors are current).                                                                                                                  |
| `sketchToScreen([u, v], id?)`     | Page pixel of sketch coordinates in the open sketch session (or in the evaluated sketch `id`), `null` if not visible.                                                                                                                |
| `sketchSession()`                 | Open session summary: feature id, tool, DOF, problem message, constraint kinds, dimensions (`id`, `name`, `kind`, `value`), selection.                                                                                               |
| `dimensionChip(name)`             | Centre of the value chip of dimension `name` (e.g. `"d1"`), or `null`.                                                                                                                                                               |
| `waitForSketchIdle()`             | Resolves when no sketch edit/drag solve is pending, the document settled and the frame is drawn.                                                                                                                                     |
| `sketchStore`                     | The sketch-mode zustand store (`begin`, `dispatch`, `setTool`, …).                                                                                                                                                                   |
| `workspaceStore`                  | Workspace view state: Select Through, saved views, `sendCamera({ kind: 'home' \| 'fitAll' \| 'fitSelection' \| 'direction' \| 'roll' \| 'pose' \| 'lookAtFace' })`, overlays.                                                        |
| `itemsStore` / `preferences`      | Item names and folders; user preferences (theme, units, navigation preset, projection, `animateCamera` — set `false` for deterministic shots).                                                                                       |
| `cameraPose()`                    | The live camera pose (`yaw`, `pitch`, `roll`, `fov`, `target`, `distance`).                                                                                                                                                          |

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

Assembler must not depend on Builder: no `apps/builder`, `@himmelcad/agent`,
`@himmelcad/automation-host`, `@himmelcad/viewer`, `@himmelcad/app`, or the
Builder sidecar. See `assembler/README.md` (product/plan overview) and
`docs/adr/0033-assembler-product-boundary.md` (the boundary decision) for the
authoritative rules.
