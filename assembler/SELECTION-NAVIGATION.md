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
dimensions stay mm), grid defaults, navigation preset, projection and field
of view, camera animation, single-key hotkeys.

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
  → Home, Zoom to fit, Perspective/Orthographic, Save view; in face-on views
  two arrows roll the view by 90°.
- Projection: perspective (FOV 15–90°) or orthographic, kept at the same
  apparent size (`withFov`). Transitions animate (300 ms ease-out) unless
  reduced motion or turned off.
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
  all; right click without drag opens the context menu. The wheel direction
  of Fusion/SolidWorks was not verified against those products.

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
