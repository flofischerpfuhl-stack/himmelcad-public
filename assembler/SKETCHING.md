# Assembler — constrained sketches and sketch mode

Status: **implemented slice** (2026-09-29, branch `asm/solver-20260929`). This
records the design, the solver decision, what works and the known limits. It
serves owner intent U1/U2 (Shapr3D-like sketching for printable parts) and the
`PLAN.md` §2 scope item "2D-Konstruktionsskizzen … Maße, Constraints und
numerische Ausdrücke". Code: `apps/assembler/renderer/src/sketch/`.

## Solver decision: FreeCAD planeGCS as WebAssembly

**Chosen:** FreeCAD's planeGCS via the npm package `@salusoft89/planegcs`
1.2.0 (LGPL-2.0-or-later; wrapper LGPL-2.1-or-later), a WebAssembly build of
FreeCAD's `Sketcher/App/planegcs` with a TypeScript wrapper. Verified from the
published tarball (license fields, `LICENSE` text, source headers, wasm
strings); the full record, AGPL analysis and replacement instructions are in
`LICENSES/THIRD_PARTY.md`.

Why planeGCS and not an own Newton/Levenberg–Marquardt solver:

- It is the solver FreeCAD's sketcher has matured over a decade: DogLeg / LM /
  BFGS, SQP for drags with lower-priority ("temporary") constraints, and a
  QR-based diagnosis that names **conflicting** and **redundant** constraints
  and reports the remaining **degrees of freedom** — exactly what Shapr3D-style
  feedback needs. Writing and hardening that ourselves would cost far more.
- Its constraint set covers everything Shapr3D exposes (plus FreeCAD's
  point-on-object, symmetric, angle, arc rules).
- A spike measured 30 ms module load in Node and 0.4–5 ms per solve for
  sketches of up to 40 lines (`test/sketch/solver.test.ts` asserts < 250 ms
  for a 40-line polygon with 39 equal constraints; typical runs ~4 ms).

How it is admitted (same pattern as `replicad-opencascadejs`): runtime-loaded
in its own Web Worker (`sketch/solver.worker.ts`), the LGPL glue + wrapper as
a separately emitted chunk `planegcs-<hash>.js` next to `planegcs-<hash>.wasm`
(forced by `worker.rollupOptions.output.manualChunks` in `vite.config.ts`),
used only through the app-owned `SketchSolver` interface
(`sketch/solverTypes.ts`); `sketch/planegcsSolver.ts` receives the library's
handles and never imports its runtime code. Worker-scoped CSP: planeGCS's
embind glue builds invokers with `new Function`, so the solver worker gets the
kernel worker's `'unsafe-eval' 'wasm-unsafe-eval'` policy; the main document
stays strict (checked by `test/electron/production.test.ts`, which now also
draws a circle through the solver in the packaged app). The UI thread never
solves: the main thread talks to the worker (`sketch/workerSolver.ts`); Node
tests run the same solver in-process (`test/sketch/nodeSolver.ts`).

What planeGCS does **not** give us, done in TypeScript: per-point "fully
constrained" state (probed with redundant coordinate constraints, one solve
per coordinate, skipped above 120 points) and detection of solutions that
collapse geometry (zero-length lines / radii are rejected as failures —
planeGCS happily "solves" a line made both horizontal and vertical).

## Data model (document schema v2)

A `sketch` feature (`model/document.ts`, `sketch/types.ts`) stores:

- **entities** in the sketch frame's (u, v) millimetres: `point`, `line`
  (two point ids), `circle` (centre point + radius), `arc` (centre, start, end
  points; counter-clockwise), each optionally `construction`;
- **constraints** `{ id, kind, refs }`: coincident, horizontal, vertical,
  parallel, perpendicular, tangent, equal, fixed (lock), midpoint, symmetric,
  concentric, pointOnObject (the table in `types.ts` lists the refs per kind);
- **dimensions** `{ id, name: 'd<n>', kind, refs, value, expression? }`:
  distance (line length, point–point, point–line, parallel lines),
  horizontalDistance, verticalDistance, radius, diameter, angle (degrees).
  Expressions are `+ - * /` with parentheses and names of other dimensions of
  the sketch (`d1 / 2 + 3`), evaluated in dependency order; cycles, unknown
  names and non-positive results are rejected (`sketch/expressions.ts`).

The reserved point id `origin` is the sketch origin (fixed, never stored).
Entity positions are always the **last solved state**, so the kernel never
needs the solver: a document evaluates deterministically from its data.

Planes: XY/XZ/YZ with offset, or a planar body face (existing
`SketchPlaneRef`/frame handling, face references by naming key).

### Profiles = detected regions, with stable keys

`sketch/regions.ts` builds the planar arrangement of all non-construction
curves (split at every intersection, duplicates removed, dangling pieces
pruned), traces faces on a half-edge graph and assigns nested component loops
as holes of the smallest enclosing face. Every bounded face is a profile —
including regions created by intersecting geometry — like Shapr3D.

A region's **key** is the sorted ids of the entities bounding its outer loop
(`l1+l2+l3+l4`), plus a line-side signature only when several regions share
that set (the two halves of a circle cut by a line: `c1+l1@L` / `@R`). Keys
survive dimension edits, drags and added holes; they disappear only when the
region itself does (then the extrude reports `Missing reference: profile …`).

Extrudes reference `profile: { kind: 'sketch', featureId, regions?: string[] }`
(absent = every region). Kernel naming (`kernel/sketchGeometry.ts`): caps
`<extrude>:start|end:<p>` with `p` the region's position in that list, side
faces `<extrude>:side:<p>:<entityId>` (`~k` for several pieces of one entity),
found from the face's parametric midpoint. Faces are built from the shared
region vertices so OCCT wires always close; a region the kernel cannot build
is skipped with a warning instead of failing the sketch.

### v1 → v2 migration (`sketch/migration.ts`, schema version 2)

`.hcasm` files of schema 1 (rectangle/circle `profiles`) load through a
tested migration: each profile becomes a fully dimensioned sketch (rectangle:
4 lines, 2 horizontal + 2 vertical, corner position from the origin + width

- height; circle: centre position + diameter), so editing a width keeps the
  lower-left corner like the old parameters did; `profileIndex` becomes region
  keys; index-based face keys in fillet/chamfer/shell/sketch-plane references
  are renamed (`side:0:0` → `side:0:l1`). The stored v1 demo bracket migrates
  to exactly the v2 demo document (`test/model/project/format.test.ts`).

## Sketch mode (Shapr3D behaviour)

Session store `sketch/session.ts`, overlay `sketch/ui/SketchOverlay.tsx`
(SVG in screen space over the WebGL viewport), chrome
`sketch/ui/SketchChrome.tsx`, commands `model/commands/sketchCommands.ts`.

- **Enter:** double-click a sketch (viewport, Items or History), _Edit Sketch_,
  or start drawing: L/A/C/R/G with nothing selected start a new sketch on XY
  (the first click on a planar body face moves the still empty sketch there),
  with a planar face selected on that face; _New Sketch on XY/XZ/YZ_ in
  command search. The camera animates normal to the plane (u right, v up;
  faces are viewed from outside).
- **Tools:** Line `L` (click-click polyline, chains until it closes on its
  start or an existing point, Enter/double-click ends), Arc `A` (3 points;
  starting on a line end — or pressing A while drawing lines — gives a tangent
  arc in two clicks), Circle `C`, Rectangle `R` (2 corners or centre),
  Polygon `G` (3/5/6/8 sides: construction circle + point-on + equal), Trim
  `T`, Offset `O` (chains through shared endpoints, mitred line joints),
  Dimension `D` (line → length/horizontal/vertical, circle → diameter, arc →
  radius, point–point, point–line, line–line → angle or parallel distance),
  Construction `Q` (selected curves, or the mode for new geometry).
  Constraints: Shift+C coincident, Shift+H/V, Shift+P parallel, Shift+L
  perpendicular, Shift+T tangent, Shift+E equal, Shift+F lock, Shift+M
  midpoint, Shift+S symmetric, Shift+O concentric, Shift+K point on curve —
  enabled only for a fitting selection (palette buttons show the reason).
- **Inference while drawing:** snaps to endpoints/centres/origin, line
  midpoints (midpoint constraint), curves (point-on), alignment guidelines
  with other points (no constraint), horizontal/vertical and
  perpendicular/parallel to the previous segment (inferred constraints), grid;
  small text hints and dashed guides show what was inferred. Inferred
  constraints are _optional_: if they over-constrain, they are dropped instead
  of rejecting the stroke.
- **Values:** typing a number while drawing opens the tool's chip (length,
  diameter, width/height, offset distance) and adds the matching dimension.
  Dimensions render as the shared `DimensionLabel` chip; click to edit, the
  field accepts expressions.
- **Feedback:** under-constrained geometry blue, fully constrained green,
  construction dashed, selection orange; the pill shows the remaining degrees
  of freedom or "Fully constrained". An edit that conflicts, is redundant, has
  an invalid expression or would collapse geometry is **rejected**: the last
  valid sketch stays, a red banner names the constraints/dimensions involved
  and they are drawn red.
- **Drag:** in Select, dragging a point/curve moves it through the solver
  live (temporary constraints; one request in flight, newest target next);
  locked or fully constrained geometry does not move.
- **Esc:** first cancels the tool with its unfinished segment, then dismisses
  a problem, then clears the sketch selection, then leaves the sketch.
- **Undo:** inside the session Ctrl+Z / Ctrl+Shift+Z (and the top-bar
  buttons, via the store's history delegate) step through the session;
  leaving commits exactly **one** document undo step (new feature, or one
  parameter edit). Edits are serialized through one queue so fast input never
  races the worker.
- **Outside sketch mode:** the History card lists the dimensions; changing
  one re-solves (`sketch/featureOps.ts` `setSketchDimension`) and commits one
  undo step; dependent extrudes follow through normal re-evaluation.

## Tests

`test/sketch/solver.test.ts` (DOF of each entity, every constraint kind,
every dimension kind, value changes, expressions, conflict, redundancy,
collapse, per-entity analysis, drag, timing), `regions.test.ts` (rectangle,
L, nested holes, three nesting levels, intersecting rectangles, line across a
circle, T-junction, open/construction, arc+line, key stability),
`tools.test.ts` (tool reducer, inference, trim, offset, constraint planning),
`session.test.ts` (L drawn with inference, dimension tool + chip, redundant
and conflicting edits rejected, drag, sketch → extrude → later dimension
change re-evaluates, editing an existing sketch is one undo step), migration
tests in `test/model/project/format.test.ts`, kernel naming in
`test/kernel/evaluator.test.ts`, store/tool integration in
`test/model/*.test.ts`. Screens: `D:\AgentWork\HimmelCAD-Assembler\shots\s-*.png`
from `sketch-shots.mjs` / `sketch-tools-shots.mjs` (DEV hook, no hand
calibration).

## Known limits and next steps

- No splines, ellipses, slots, text, sketch patterns, mirror, fillet-in-sketch,
  project/"use" of body edges, construction planes/axes; no box selection in
  sketch mode; no reference (driven) dimensions — dimensioning an already
  determined length is rejected as redundant instead of becoming a reference.
- Constraint glyphs are simple stacked badges; dimension labels can overlap
  glyphs in dense sketches. No per-constraint delete via right-click (select
  the glyph or the dimension line, then Delete).
- Region keys use entity ids: deleting and redrawing a boundary line gives a
  new key (the extrude then reports a missing profile; re-pick the profile).
- "Fully constrained" per entity costs two solves per point (off the UI
  thread; skipped above 120 points — the global DOF is always shown).
- planeGCS may converge to a mirrored solution for large dimension jumps
  (same as FreeCAD); undo restores the previous state.
- Sketches on non-XY planes draw their own light grid in the overlay; the
  WebGL grid stays on world XY.
- The other workstreams' features (e.g. revolve) must read sketch profiles
  through `regions`, not the removed v1 `profiles`/`profileIndex`.
