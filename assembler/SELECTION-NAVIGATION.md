# Selection, navigation and workspace UX

Status: implemented 2026-09-29 (branch `asm/selection-20260929`). Spec:
`research/2026-09-28/notes/interaction.md` §2 (selection), §3 (Items/History),
§5 (camera, cube), §6 (input mapping), §7 (context menus, persistence), §8
(acceptance scenarios). This note records the decisions and the known limits;
the code is in `apps/assembler/renderer/src/{viewport,model,chrome}`.

## State layers (§7)

| Layer                | Where                                              | Persisted                                  | Undo |
| -------------------- | -------------------------------------------------- | ------------------------------------------ | ---- |
| User preferences     | `model/preferences.ts` (Settings dialog)           | renderer `localStorage` (Electron profile) | no   |
| Workspace view state | `model/workspace.ts` (Select Through, saved views) | saved views in `.hcasm` `viewState`        | no   |
| Item organisation    | `model/items.ts` (names, folders)                  | `.hcasm` `items` (optional, additive)      | no   |
| Document             | `model/store.ts` features                          | `.hcasm` `features`                        | yes  |

Preferences: theme, toolbar labels (icons / hover / always), display units
(mm / inch — read-outs and tool value chips only; documents stay mm, sketch
dimensions stay mm), grid defaults, navigation preset, orbit pivot (Orbit around),
projection (Orthographic / Adaptive / Perspective) and field of view, camera
animation, single-key hotkeys.

## Body names, folders and colour — decision

- **Names and folders are item properties** (`items` in the project file,
  keyed by the stable body id `body:<creating feature>` and sketch feature
  ids). They are not History steps: they do not change geometry, so they must
  not appear as parametric steps, and they survive edits of earlier steps.
  Not undoable (like visibility); saved, dirty-tracked and restored by New /
  Open / crash recovery. Exports (STL file names, 3MF object names) and the
  Measure read-out use the display names.
- **Colour is a document feature** (`setAppearance`, already evaluated by the
  kernel): one undo step, follows the body through booleans/copies, written
  to STEP and 3MF (`displaycolor`) through `Body.color`. Picking another
  colour right after updates that same step instead of stacking steps.

## Selection

- **Box selection** (`viewport/boxSelect.ts`, pure): drag from empty canvas.
  Left → right = window (only completely enclosed; solid accent outline),
  right → left = crossing (touched; dashed selection-orange outline). While
  dragging: Tab / Shift+Tab cycle All → Bodies → Faces → Edges, A/B/F/E set
  it, Esc cancels; the strip under the box shows mode and filter. Shift adds.
  "All" selects whole items (bodies, sketch profiles). Without Select Through
  only visible geometry counts: crossing uses the picking id buffer inside
  the rectangle, window requires full enclosure plus visibility anywhere.
  Sketch mode (`sketch/ui/sketchBoxSelect.ts`): same rules on entities with
  filters All / Curves (E) / Points (P).
- **Overlapping picks** (`viewport/pickCandidates.ts`, pure): a click collects
  the pick targets visible within 4 px (12 px touch) plus a CPU ray cast
  through the body meshes. A list appears when two or more candidates of the
  winning kind overlap (edges at a vertex, stacked profiles), when a sketch
  profile lies on a face, or — with Select Through — whenever there is a
  choice. Hover/focus previews (store hover, drawn "on top"), click/Enter
  selects, Esc closes.
- **Select Through** (Ctrl+Shift+S, context menu, command search): occluded
  faces/edges become candidates and count for boxes; a chip at the top of the
  viewport shows it is on and turns it off. **Save As moved to
  Ctrl+Shift+Alt+S** (the Shapr3D mapping gives Ctrl+Shift+S to Select
  Through).

## Camera, view cube, navigation

- The view cube's orientation is derived from the same camera basis as the
  scene (`camera.ts` `cubeMatrix3d`). The old cube rotated by the raw yaw and
  showed "Right" in the Front view; also the pole handling flipped Top
  upside down. The camera basis is now continuous (Top/Bottom exact, +Y up in
  Top). Tests check all six presets and iso.
- Cube: faces → preset views; edge strips → the 12 edge views; corners → the
  8 isometric views; drag orbits; double-click → Home (iso + fit); right-click
  → Home, Zoom to fit, the three projections (checked), Save view; in face-on
  views two arrows roll the view by 90°.
- Camera transitions animate (300 ms ease-out) unless reduced motion or
  turned off. Projection and pivot: the two sections below.
- Zoom to selection `Z`; Look at face = pointer over a face + Space (or one
  selected planar face) — Shapr3D's mapping; `F` stays Fillet.
- Saved views: up to 8 (View menu, cube menu, command search; the used count
  is shown), saved in the project with the Section View state (on/off, axis
  or face plane, offset, flip, Section only — Shapr3D 26.30/26.80); restoring
  applies the section and keeps the Settings projection. Views saved by older
  builds restore the camera only. "Nearest ortho view" snaps to the closest
  world axis direction.
- Grid resolution (2026-09-30): follows the zoom in a 1-2-5 series (minor
  lines ≥ 14 px apart) and is shown next to the magnet in the right dock;
  clicking it locks the current step (Shapr3D's unit icon). Sketch snapping
  and the sketch grid use the same step. `.hcasm` stores `grid.auto`;
  projects without it reopen locked at their stored step.
- Snapping popover (magnet): Grid, Points, Midpoints, Guidelines, On curves,
  Auto-constrain (inferred H/V/perpendicular/parallel; point connections
  stay) and Show snap hints. Grid snapping is project view state, the other
  switches are preferences.
- Navigation presets (`viewport/navigation.ts`, data): Shapr3D (right drag
  orbit, middle / Shift+right pan), Fusion 360 style (Shift+middle orbit,
  middle pan), SolidWorks style (middle orbit, Ctrl+middle pan). Wheel zoom in
  all (at the cursor, below); right click without drag opens the context
  menu. The wheel direction of Fusion/SolidWorks was not verified against
  those products.

## Projection (owner decision 2026-10-01)

Three modes, one user preference (`preferences.ts` `projection`, not per
project), policy in `viewport/projection.ts`:

| Mode                       | Behaviour                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Orthographic** (default) | Parallel projection everywhere.                                                                                                                                                                                                                                                                                                |
| **Adaptive**               | Like Fusion 360's "Perspective with Ortho Faces": perspective while the user orbits freely; parallel while a sketch is open and after a view-cube face/edge/corner click, a named view (Front … Iso, Ctrl+1…7, Nearest ortho view), Home, a saved view or Look at face — until the next orbit (mouse, pen, finger, cube drag). |
| **Perspective**            | The field of view from Settings (15–90°) everywhere.                                                                                                                                                                                                                                                                           |

Where: a compact three-choice row in the Display popover (right dock), View
menu entries with a check (Orthographic/Adaptive/Perspective projection, Next
projection), command search ("orthographic", "perspective", "adaptive",
"projection"), **Alt+P** cycles (with a notice), the view cube's context menu
and Settings › Navigation › Projection (same preference; the field of view
stays there). Preferences stored by older builds with `perspective` (the old
default, `projectionChosen` missing) move to Orthographic; a later choice is
kept. The agent API exposes no view state, so there is no API method or
Python call for it.

Transitions never jump in apparent size: a camera animation carries the
change (`lerpPose` blends the perspective strength `tan(fov/2)` while the
visible height at the target follows the zoom); otherwise a 220 ms blend
(`withFovAt`) keeps the plane through the orbit pivot (or the target)
exactly in place and size — the target moves along the viewing axis to that
plane. Blends pass through ≥ 2° perspective and end exactly on 0
(orthographic). Zoom-dependent sizes (grid extent, axes, edge pick ribbons)
follow the visible height at the target, not the eye distance.

While a sketch is open the world axis out of its plane (within 1°) is hidden
in every mode (`ViewportMode.drawingPlaneNormal`, scene `sketchNormal`); in
perspective it showed as a misleading diagonal line. Sketch snapping to far
edges (`bodySnaps.ts`) follows the projection the sketch is shown in
(Orthographic and Adaptive: on).

## Orbit and zoom pivot (owner request 2026-10-01)

Orbit turns about a pivot decided **once per gesture** (mouse/pen: where the
button went down, when the drag passes the click threshold; finger:
`orbitStart`; pen Shift-hover: when the modifier starts it), from a 64 × 64
px window (device pixels × dpr) of the id pass's new depth attachment around
the cursor (`gl.ts` `readPickDepthWindow`; the lazily drawn picking pass
writes its window depth, 24 bits, into a second colour attachment —
WebGL2 cannot read a depth buffer back). Rules (`viewport/orbitPivot.ts`):

1. **surface** — something pickable is drawn under the cursor: its depth.
2. **near** — the cursor is in a hole/slot or just beside the part: the
   depths drawn within 32 CSS px, weighted by `(1 − d/R)²` and linearised
   (perspective or orthographic clip planes of that frame), averaged — over a
   bore the pivot sits inside it at rim depth, not on whatever is behind it.
3. **model** — nothing near: the depth of the visible model's centre
   (`target` without a model).

The pivot is always the point on the cursor ray at that depth, so it stays
under the cursor while the view turns (`camera.ts` `orbitAbout`: the
camera rotates rigidly about it; inertia glides keep it). No depth data
(before the first frame, or the camera moved since the last drawn frame,
e.g. during a kernel rebuild nothing waits) → rule 3 immediately. A subtle
dot shows the pivot during an orbit only (`data-pivot`, `data-pivot-rule`
for tests). Settings › Navigation › **Orbit around**: Point under cursor
(default) / Selection (the selection's bounds centre, else the cursor rules)
/ Screen centre (the old orbit about the target). Dragging the view cube
orbits about the target.

**Zoom** (owner rule 2026-10-01) stays anchored purely at the cursor's pixel
— over the model or over empty background (`camera.ts` `zoomAtRay`):
orthographic views scale about that pixel and read no depth at all;
perspective dollies along the cursor ray, and the depth of the pivot rules
(read once per wheel burst — kept while the wheel keeps turning within
300 ms and 4 px —, at pen-Alt-down and at the start of a pinch) only sets the
step, so a zoom-in never passes the surface under the cursor. Adaptive:
whichever projection is active. No dot for zoom. Pinch zoom anchors at the
fingers' midpoint the same way and two-finger pan moves the content at that
depth 1:1.

Cost (Radeon Vega 8, headed Chromium, bracket template, DEV probes
`window.__assembler.pivotPrefetchAt` / `pivotAt`, 30 runs each): an orbit
starts reading the window at pointer/finger down into a pixel buffer with a
fence (`gl.ts` `requestPickDepthWindow`) and takes it when the drag passes
the click threshold (`takePickDepthWindow`, never waits) — 0.5 ms median,
0.8 ms max, ready in 30 of 30 runs (id pass drawn first included). The
synchronous fallback (wheel in perspective, pen hover, a read not ready yet)
is 0.6–0.7 ms median with a fresh id pass, 1.9 ms when the id pass has to be
drawn first, but up to 6–9 ms when it waits behind a frame's GPU work. The
CPU part (rules and ray on 64 × 64) is 0.04 ms (`bench:interactive` row
"e orbit pivot"). Orbit and zoom frames read nothing: orbit frame cost A/B
against 6ef20984 (90 back-to-back frames, GPU synced, 6 interleaved runs)
0.935 → 0.948 ms orthographic, 1.014 → 1.019 ms perspective. Evidence:
`D:\AgentWork\HimmelCAD-Assembler\shots\nav\` (`pivot-headed.json`,
`frames-ab.md`, `bench-ab.md`).

## Items and History

- Items: folders (create — with the selection inside —, rename, nest, delete
  keeping the contents, collapse), drag & drop rows into folders or back to
  the top level, folder eye toggles all children, type filter (All / Bodies /
  Sketches), inline rename (double-click or F2), colour swatch, "Show hidden
  items", "Invert visibility", "Reveal in Items" (context menu) scrolls to and
  outlines the row.
- Items rows also have Zoom to (frames the item without selecting it); a
  Meshes filter appears once the project has a reference mesh.
- History card settings (Shapr3D): Rename, Suppress (Del on a focused card),
  Breakpoint after this step / Remove breakpoint (the rollback marker below),
  Zoom to, Duplicate (a copy right after the step, one undo step), Move
  up/down, Delete (Shift+Del); the header expands/collapses all cards.
- History: filter to the selection's steps (their creators, the steps that
  reference the selected bodies, and their dependencies —
  `model/historyTools.ts`); rollback marker (drag the bar, or "Roll back to
  here" / "Roll forward"): steps below are not evaluated and greyed, new steps
  are inserted at the marker (`store.ts` `rollbackBefore`, view state, not
  saved; agent commits lift it). Reorder by dragging a card (or Move up/down):
  a step cannot move above a step it references or below one that references
  it; refusals explain why in a toast. References are read from the feature
  data (sketch ids, `body:<id>`, naming keys); implicit order effects (e.g.
  an extrude joining "the most recent body") are not modelled.
  Interplay with the kernel's prefix cache (`kernel/evalCache.ts`): the
  evaluator only receives the steps above the bar, and checkpoints are keyed
  by a hash chain over feature content in order, so rolling back to a
  computed prefix is free, while an edit above the bar, a reorder or a
  roll-forward onto an edited prefix never reuses a checkpoint of another
  order (`test/model/rollback.test.ts` compares each state with a cache-free
  replay). Cancel of a long computation restores the full step list and the
  bar position together.

## Keyboard, touch, pen

- Hold Ctrl (0.7 s) or press `?`: cheat sheet generated from the command
  registry plus the active preset's gestures. Single-key hotkeys off: typing a
  letter opens command search with it.
- Settings › Keyboard: every registry command can get another shortcut (press
  the new keys; a key used by another command in the same sketch/model
  context, or by the shell itself — Esc, Enter, Tab, Space, X, Ctrl+F, ?,
  panel keys — is refused with the reason). Overrides are preferences and
  are written onto the registry, so menus, search and the cheat sheet show
  them. Settings › Selection extension: every click adds to the selection.
- Touch and pen (Block 8, [TOUCH.md](TOUCH.md)): one finger orbits, two
  fingers pan, pinch-zoom and twist-roll, flicks glide; tap selects (taps add
  up, like Shapr3D), a double tap looks at a face / fits an empty view /
  selects the body; long press opens the context menu, long press + drag
  draws a selection box whose filters a second finger taps; two-finger tap
  undoes, three-finger tap redoes, three-finger swipes undo/redo. The pen
  acts like the mouse in 3D (hover highlights; barrel button = right button;
  Shift/Ctrl/Alt + drag or hover orbits/pans/zooms) and draws shapes in
  sketches; palms are ignored while it is used. The tablet layout (touch
  primary or Settings) enlarges targets and tool handles and adds the number
  keypad; Settings › Touch and pen holds the switches and the tool side.

## Limits

- Units: sketch dimension chips and History parameter fields still show mm.
- The id buffer is from the last drawn frame; boxes are evaluated on release
  (no live candidate highlight while dragging).
- Rollback marker and Select Through are not saved with the project.
- Pivot: the search radius is fixed (32 CSS px), so a bore wider than about
  64 px on screen falls back to the model-centre depth (still on the cursor
  ray); only pickable geometry counts (not the grid, not reference-image
  quads). The depth is that of the last drawn frame; when the camera moved
  since (no frame in between) the model rule is used instead of waiting.
- Adaptive treats Look at face and saved views as standard views (the
  research archive documents only cube faces/edges/corners as parallel
  views, Report §5).
