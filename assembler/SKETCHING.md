# Assembler — constrained sketches and sketch mode

Status: **implemented slice** (2026-09-29, branch `asm/solver-20260929`;
merged with the modelling features and the agent API on
`feat/assembler-phase0-20260929`), extended by **advanced sketching**
(2026-09-30, branch `asm/sketch2-20260930`: splines, slots, ellipses,
text, project, mirror, patterns, sketch fillet/chamfer, reference
dimensions, editing polish — see "Advanced sketching" below). This
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
  points; counter-clockwise), `ellipse`, `ellipticArc`, `spline`, `text`
  (see "Advanced sketching"), each optionally `construction`;
- optional `projections` (projected body geometry with its source
  reference) and `regionMemory` (region fingerprints), both additive — the
  schema stays 2; a file with the new entity kinds fails loudly ("unknown
  entity kind") in older builds;
- **constraints** `{ id, kind, refs }`: coincident, horizontal, vertical,
  parallel, perpendicular, tangent, equal, fixed (lock), midpoint, symmetric,
  concentric, pointOnObject (the table in `types.ts` lists the refs per kind);
- **dimensions** `{ id, name: 'd<n>', kind, refs, value, expression? }`:
  distance (line length, point–point, point–line, parallel lines),
  horizontalDistance, verticalDistance, radius, diameter, angle (degrees);
  `driven: true` marks a reference dimension; `offset`/`along` place the
  label.
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
region itself does (then the kernel re-binds the extrude by the region's
unchanged edges, or to the sketch's only remaining profile, with a warning —
else it reports `Missing reference: profile …`; `KERNEL-SPIKE.md` "Reference
scheme v2").

Extrudes reference `profile: { kind: 'sketch', featureId, regions?: string[] }`
(absent = every region). Kernel naming (`kernel/sketchGeometry.ts`): caps
`<extrude>:start|end:<p>` with `p` the region's position in that list, side
faces `<extrude>:side:<p>:<entityId>` (`~k` for several pieces of one entity),
found from the face's parametric midpoint. Faces are built from the shared
region vertices so OCCT wires always close; a region the kernel cannot build
is skipped with a warning instead of failing the sketch.

### v1 → v2 migration (`sketch/migration.ts`, schema version 2)

The project format has one ordered migration chain (`model/project/format.ts`
`MIGRATIONS`, `n` → `n + 1`, then strict validation of the current schema);
v1 → v2 is its first step.

`.hcasm` files of schema 1 (rectangle/circle `profiles`) load through a
tested migration: each profile becomes a fully dimensioned sketch (rectangle:
4 lines, 2 horizontal + 2 vertical, corner position from the origin + width

- height; circle: centre position + diameter), so editing a width keeps the
  lower-left corner like the old parameters did; `profileIndex` becomes region
  keys; index-based face keys in fillet/chamfer/shell/sketch-plane references
  are renamed (`side:0:0` → `side:0:l1`). The stored v1 demo bracket migrates
  to exactly the v2 demo document (`test/model/project/format.test.ts`).
  Schema-1 files written by the modelling-features build migrate the same way:
  revolve/sweep/loft `profileIndex` → `regions` (and their face keys), a
  sweep's sketch path → `region`, a revolve/pattern `sketchEdge` axis
  (profile segment) → `sketchLine` (entity id)
  (`test/kernel/features.test.ts`, migrated and evaluated on the kernel).

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
- **Tools** (the advanced ones — Spline, Slot, Ellipse, Text, Fillet/Chamfer,
  Mirror, Pattern, Project — are described under "Advanced sketching"):
  Line `L` (click-click polyline, chains until it closes on its
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
  Dimensions render as chips in the shared chip style; click selects,
  double-click edits, the field accepts expressions.
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

## Advanced sketching (2026-09-30)

### Curves beyond lines and arcs

| Entity        | Stored as                                                                                                                                                                                                        | Solver (planeGCS)                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ellipse`     | centre, major-axis end, minor-axis end (points)                                                                                                                                                                  | planeGCS ellipse with hidden focus / opposite vertices tied by internal alignment; 5 DOF; point-on, line tangency, concentric                                                   |
| `ellipticArc` | + start / end points, counter-clockwise in the ellipse frame                                                                                                                                                     | `arc_of_ellipse` + rules; 7 DOF                                                                                                                                                 |
| `spline`      | `fit`: points the curve passes through (C2, chord-length) + two end tangent handles (the first/last Bézier control point); `control`: control polygon of a clamped cubic B-spline (+ `knots` after a trim split) | points only (no planeGCS B-spline): coincident on end points; **tangent** to a line / arc / spline sharing an end point keeps the second pole / handle on the tangent direction |
| `text`        | anchor point + text, cap height, rotation, font id and the **stored glyph outline** (SVG path data normalized to the cap height) — documents evaluate without the font                                           | anchor point only (position by constraints/dimensions)                                                                                                                          |

All curves reduce to one pure curve model (`sketch/geometry.ts`: segments,
circular arcs, elliptical arcs, Bézier chains) with exact areas,
Newton-refined intersections and closed-curve handling, so region
detection, trim, snapping, hit testing, box selection and the kernel see
the same geometry. The kernel builds elliptical arcs exactly and one cubic
B-spline edge per spline/glyph piece (triple knots), so one piece gives one
extruded side face (`<extrude>:side:<p>:<entityId>`). Text regions follow
the font's fill rule: counters (inside of O, e, B) are holes, never
profiles; region keys are `<textId>.<n>`. A region face with holes is
checked against the region's exact area and rebuilt with reversed hole
wires when OCCT's plane faced the other way (fix 2026-09-30: holes were
added on XY/YZ sketches). Spline and glyph math: `sketch/spline.ts`,
`sketch/text/outline.ts`.

Text uses **Inter** (SIL OFL 1.1, `@fontsource/inter` 5.3.0, Latin subset)
parsed with opentype.js 1.3.4 (MIT); the theme's Kamikaze display fonts
are not used because their license is not recorded for embedding
(`LICENSES/THIRD_PARTY.md`). Height is the cap height. Characters outside
the subset are drawn as the font's missing-glyph box and reported.

### Tools (toolbar, command search, shortcut; preview + value chips)

| Tool                       | Input                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spline `I`                 | Fit points / Control points; click points, Enter, double-click or the first point ends (closed). Selected fit splines show their tangent handles, control splines their polygon.                                                                                         |
| Slot `U`                   | Straight: centre, centre (or type the centre distance), width (click or type) — dimensioned. Arc: arc centre, start, end, width.                                                                                                                                         |
| Ellipse `Y`                | Ellipse / Elliptical arc: centre, first axis end (or type its radius), second axis (click or type), then arc start and end.                                                                                                                                              |
| Polygon `G`                | 3/5/6/8 or any side count; Inscribed (vertices on the construction circle) / Circumscribed (edges tangent to it).                                                                                                                                                        |
| Text `K`                   | Click the baseline start; the text panel sets content, height, rotation; Place / Update. Double-click a text (or Edit Text) edits it in place.                                                                                                                           |
| Fillet / Chamfer `Shift+R` | Click a corner between two lines, move or type the radius / set-back. The corner point stays as a virtual sharp on both line extensions, so dimensions to it survive; a length dimension of a shortened line is re-attached to the virtual sharp.                        |
| Mirror `J`                 | Selection (or click curves, then Next / Enter), then click the mirror line. Copies are tied by Symmetric constraints (circles also Equal).                                                                                                                               |
| Pattern `N`                | Linear: count, then move/click where the last copy goes or type the spacing (a spacing dimension on a construction line drives all copies, H/V inferred). Circular: count, total angle, click the centre. Copies are tied by `translate` / `rotate` pattern constraints. |
| Project `P`                | Click body edges or faces: they are projected along the sketch normal (lines, parallel circles/arcs, otherwise fit splines). Construction by default (`Q` toggles).                                                                                                      |

Every completed operation is one session undo step. Trim now also cuts
ellipses (→ elliptical arcs on the same axis points) and splines (→ exact
control-point splines). Tangency at a **shared end point** (line/arc,
arc/arc, spline ends) is mapped to a direction constraint instead of the
curve-distance form, which is degenerate there (planeGCS reported it
redundant — the old tangent-arc tool silently dropped it).

### Projection is associative

A projection stores its source (`{kind: 'edge'|'face', ref}` — a naming v2
reference) and its entities. The kernel re-derives it on every evaluation
(`kernel/sketchProjection.ts`, one hook in `evaluateSketch`): same
structure → the projected points move with the source (dependent profiles
and extrudes follow); a missing source or a different structure keeps the
stored geometry **frozen** and puts a warning on the sketch (History card,
sketch-mode banner, amber dashed curves). Sketch mode adopts moved
projections on entry and re-solves them as one session step. Projected
points are fixed for the solver; fully fixed projected arcs are solved as
fixed circles (their arc rules would be redundant).

### Reference (driven) dimensions

A dimension that is already determined is no longer only rejected: the
banner offers **Add as reference**. Reference dimensions are measured after
every solve, shown in parentheses (dashed, italic), cannot be edited or
used in expressions, and can be toggled with **Reference Dimension**
(command search) or `sketch.setReference`.

### Constraint and dimension editing polish

- Dimension chips: click selects (Delete removes, Reference Dimension
  toggles), **double-click edits** (Enter/F2 on a focused chip too),
  **Shift+drag moves the label** (offset + position along the dimension,
  one undo step).
- Dense sketches: chips are pushed apart along their normal, constraint
  badges take the nearest free slot around their anchor
  (`sketch/ui/declutter.ts`).
- A selected badge shows a delete button; right-click on a badge deletes
  that constraint. Coincident badges show for selected points.
- Keystrokes typed right after a value chip opens are kept (the overlay
  owns the typed text; Enter before the field has focus applies it) — the
  known "lost keystrokes" limit is fixed.

### Region keys after redraws

Every sketch commit records region fingerprints (`regionMemory`: sample,
area, bounding box, also for keys that vanished). A reference to a profile
whose boundary was redrawn — even completely — re-binds by geometry first
(unique free region with the same box and area ±1 %), with the warning
"re-bound by geometry"; then the topological rebind as before.

### Agent API / Python

`sketch.addSpline`, `sketch.addEllipse`, `sketch.addSlot`,
`sketch.addPolygon`, `sketch.addText`, `sketch.mirror`, `sketch.pattern`,
`sketch.roundCorner`, `sketch.project`, `sketch.setReference`
(`api/sketchAdvancedApi.ts`, same builders as the tools); the contract
describes the new entity/constraint kinds. Python: `Sketch.spline`,
`ellipse`, `slot_between`, `arc_slot`, `polygon`, `text`, `mirror`,
`pattern`, `fillet_corner`, `chamfer_corner`, `project`, `set_reference`.

## Tests

`test/sketch/curves.test.ts` (spline math, exact curve areas and
intersections, regions with splines/ellipses/text, ellipse/elliptical-arc
DOF and dimensions, spline tangency, pattern constraints, reference
dimensions, kernel solids from spline/ellipse/text regions),
`advancedTools.test.ts` (every new tool through its reducer and the real
solver: DOF, areas, copies following their originals, trims),
`advancedSession.test.ts` (UI-path plate with a hole, the reference offer
and toggle, label moves as undo steps, text place/edit, associative and
frozen projection, geometric re-binding of a completely redrawn profile),
`declutter.test.ts`, `test/kernel/sketchHoles.test.ts` (regions with holes
on XY/XZ/YZ, symmetric/reversed extrudes, revolve, text "OeAB" extruded and
engraved: exact volumes, valid B-rep), `test/api/sketchAdvanced.test.ts`,
Python `test_assembler.py`. Screens: `D:\AgentWork\HimmelCAD-Assembler\shots\s2-*.png`
from `s2-shots.mjs` (DEV hook).

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

- No construction planes/axes; no parabola/hyperbola; no offset of splines
  or ellipses; no point-on-spline constraint (splines take coincident on
  their end points and endpoint tangency only); a spline tangent to an
  ellipse/elliptical arc is not supported; ellipse minor radius must stay ≤
  the major radius (planeGCS; a dimension forcing the opposite fails).
- Fit splines through many points are smooth but not curvature-continuous
  at their handles; after a trim a spline becomes a control-point spline
  with triple knots (dragging a pole then gives C0 joints).
- Text: one line, one font (Inter Latin); editing re-generates the whole
  text (region keys of a changed text change, re-pick them). Shapr3D
  "text on a path" is not implemented.
- Project: parallel projection only (no wrap onto curved faces); tilted
  circles/ellipses/B-spline edges become fit splines through 12–16 points
  (approximate); a face projects its boundary edges, not the silhouette of
  a curved face; a source whose projection changes shape (e.g. a face that
  gained an edge) freezes with "project it again". Projection reads the
  current bodies, so it only works for sources that exist before the sketch
  in the history.
- Sketch patterns and mirrors: count/angle cannot be edited after creation
  (the spacing dimension can); patterned text is not supported; the linear
  pattern's direction line is a construction line (dimension/constrain it
  to fix the direction).
- Sketch fillet/chamfer: line–line corners only.
- Label de-cluttering is greedy (chips move along their normal, badges to
  the nearest free slot); very dense sketches can still overlap.
- Region keys use entity ids; a redrawn profile re-binds by its recorded
  geometry (±1 % box and area) or its unchanged edges, with a warning;
  a redrawn profile whose size also changed must be re-picked.
- "Fully constrained" per entity costs two solves per point (off the UI
  thread; skipped above 120 points — the global DOF is always shown).
- planeGCS may converge to a mirrored solution for large dimension jumps
  (same as FreeCAD); undo restores the previous state.
- Sketches on non-XY planes draw their own light grid in the overlay; the
  WebGL grid stays on world XY.
- Revolve, Sweep and Loft read profiles through `regions` like Extrude; a
  sweep path is a region's outer outline (open sketch curves are not a sweep
  path yet).
- Agents drive sketches through the agent API (`assembler/AGENT-API.md`):
  shapes, polylines, arcs, constraints and dimensions, each solved by the same
  planeGCS solver (in-process in the headless CLI).
