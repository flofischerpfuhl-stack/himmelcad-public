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
- Saved views: up to 8 (View menu, cube menu, command search), saved in the
  project; restoring keeps the Settings projection.
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

## Keyboard, touch, pen

- Hold Ctrl (0.7 s) or press `?`: cheat sheet generated from the command
  registry plus the active preset's gestures. Single-key hotkeys off: typing a
  letter opens command search with it.
- Touch: one finger orbits, two fingers pan and pinch-zoom, tap selects (taps
  add up, like Shapr3D), double tap selects the body, long press opens the
  context menu, long press + drag draws a selection box. Coarse pointers get
  wider edge pick ribbons and larger rows/buttons. Pen = mouse (hover
  highlights; barrel button = right button).

## Limits

- Units: sketch dimension chips and History parameter fields still show mm.
- The id buffer is from the last drawn frame; boxes are evaluated on release
  (no live candidate highlight while dragging).
- Touch box filters by a second finger (Shapr3D) are not implemented; the
  keyboard filters work.
- Rollback marker and Select Through are not saved with the project.
