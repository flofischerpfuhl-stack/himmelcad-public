# Touch and pen

Status: implemented 2026-10-01 (Block 8, branch `asm/b8-touch-20261001`),
verified with emulated touch and pen only — **real-device validation is
pending** (iPad through the coming web version `apps/assembler-web`, a
Windows pen tablet through the desktop app). Owner intent: U2 (“wie die
touch/maus bedienung funktioniert”), roadmap [ROADMAP-LATER.md](ROADMAP-LATER.md)
§1b. Gap rows: [GAP-INVENTORY.md](GAP-INVENTORY.md) §12 (TP-01…TP-11),
UI-23, SK-18, CON-07, VIEW-08.

Shapr3D comes from the iPad: the pen draws and selects, fingers navigate,
gestures do the rest. The research archive documents (**D**) the finger
navigation, taps adding up, double tap on a face, long press + drag boxes
with second-finger filters, the three-finger undo/redo swipe, the Windows pen
modifiers, the numpad on touch, the handedness switch and the pen’s automatic
Line/Arc (`research/2026-09-28/notes/interaction.md` §1, §2, §4, §6). Two-
and three-finger taps for Undo/Redo, circles/rectangles from strokes,
scribble-to-erase, palm rejection, inertia and the finger/pen setting are
the owner’s Block 8 brief (**I**); exact Shapr3D target sizes and timings
are **O**. No Shapr3D assets were copied.

## Behaviour

### Fingers (3D view and sketches)

| Gesture                       | Does                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| One finger drag               | Orbit (in a sketch only when fingers do not draw)                                                                       |
| Two fingers                   | Pan with the centroid, pinch zoom at the centroid, twist rolls the view after a 12° dead zone (Settings: Twist to roll) |
| Flick (one or two fingers)    | The camera glides (Settings: Inertia; off with reduced motion)                                                          |
| Tap                           | Select; taps add up; tap on empty canvas clears                                                                         |
| Double tap                    | On a face: look at it; on empty canvas: fit the view; on an edge/profile: like a double click (body, open the sketch)   |
| Long press                    | A ring appears; release opens the context menu; drag draws a box (left → right inside, right → left touching)           |
| Second finger during a box    | Taps the box’s filter chips (All / Bodies / Faces / Edges)                                                              |
| Two-finger tap                | Undo (the registry’s `edit.undo`, same availability and notice)                                                         |
| Three-finger tap              | Redo                                                                                                                    |
| Three-finger swipe left/right | Undo / Redo                                                                                                             |

A double tap counts when the second finger goes down within 400 ms of the
first lift and 30 px of it (the viewport’s double-click window). Multi-finger
taps: all fingers up within 300 ms (450 ms for three) without moving.

### Pen

- **3D view:** the pen acts like the mouse (tap selects, drag on empty
  canvas boxes, handles drag, hover highlights; barrel button = right button:
  orbit, context menu). Windows pens: **Shift / Ctrl / Alt + drag or hover**
  orbits / pans / zooms (`navigation.ts` `penNavigation`); a modifier tap
  still selects (Shift adds).
- **Sketches (Select, Line, Arc, Circle, Rectangle tools):** a stroke becomes
  geometry when the pen lifts; a tap is a click (Line tool chains, value
  chips). In Select, a pen on geometry still drags it, and a pen held still
  then dragged draws a box. Other tools take pen input like a mouse click.
- **Eraser end** (`button 5`): deletes the curves the stroke touches.
- **Pressure** sets the width of the live stroke; tilt is sampled
  (`PointerSample`) but not used.

### Pen shapes (`platform/input/strokes.ts`, `modules/sketching/penStrokes.ts`)

| Stroke                         | Becomes (through the drawing tool)                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Straight                       | Line; within 8° of horizontal/vertical it is straightened and gets the H/V constraint                     |
| Straight segments with corners | Connected lines (Line tool chain); closed when it ends on its start; corners get the inferred constraints |
| Curved, open                   | Arc through start, middle and end; leaving a line’s end along it (within 20°): tangent arc with `tangent` |
| Round, closed                  | Circle; the centre snaps to points (concentric) from 12 % of the radius                                   |
| Four right-angled sides        | Rectangle with H/V constraints; rotated (more than 8°): the Rectangle tool’s three-point mode             |
| Back and forth (≥ 3 reversals) | Erases the curves it crosses (Settings: Scribble to erase)                                                |

Endpoints are snapped and inferred exactly like mouse clicks (`inference.ts`:
points → coincident, curves → point on curve, midpoints, H/V/perpendicular/
parallel guides, grid), so the constraints are the tools’ own. One stroke is
one session undo step. The Line tool takes lines, connected lines and arcs
(Shapr3D’s automatic Line/Arc); Arc, Circle and Rectangle take their shape;
Select takes every shape. Recognition: Douglas–Peucker corners re-anchored on
fitted sides, a sharp-corner test against circles, Kåsa circle fits, a
scribble test on reversals; tolerances in screen pixels (`unitPerPx`).
Unrecognised strokes leave a reason in the tool pill.

### Which pointer draws in a sketch (Settings › Finger in sketches)

| Setting             | Pen   | One finger                                                          | Two fingers |
| ------------------- | ----- | ------------------------------------------------------------------- | ----------- |
| Automatic (default) | draws | draws until a pen was used on this device, then as “Pen only draws” | navigate    |
| Pen only draws      | draws | navigates; taps and boxes select sketch geometry                    | navigate    |
| Touch draws too     | draws | draws (strokes become shapes too)                                   | navigate    |

A second finger landing while one finger draws hands both fingers to the
navigation (the stroke is dropped). The first pen ever seen sets the
persisted `penSeen` flag and shows a notice.

### Palm rejection (`pointer.ts` `PenPresence`)

While palm rejection is on: a touch starting while the pen touches the
screen, within 600 ms after the pen was last seen (hovering or lifted), or —
once a pen was used — with a contact larger than 60 px is ignored until it
lifts; a pen going down ends any gesture a resting palm started.

### Tablet layout (`html[data-hc-touch]`)

On when touch is the primary input (`deriveInputProfile` in
`@himmelcad/hardware-profile`: coarse primary pointer, or a touch screen
without hover) or by Settings. It enlarges the shared controls
(`--hc-size-control-h` 40 px, menu rows 40 px), top bar, right dock, tool
pill, dimension chips, Items/History rows and the view cube’s edge cells;
shows captions instead of hover tips (Toolbar labels “On hover” → always);
widens the tool column and adds Undo/Redo to it; gives tool handles
finger-sized hit areas and knobs (`scene.ts` `hitScale` 2, `handleScale`
1.5; mouse rendering unchanged). Hover-only affordances are shown on
hover-less devices (Home recents; Measure rows already were).

**Handedness** (Settings › Tools, `html[data-hc-hand="left"]`): right-handed
keeps the tools on the left (the free hand taps them while the pen draws);
left-handed mirrors the tool column (menus open towards the canvas), Items,
the view cube, the right dock and the right panel stack.

### Number keypad (`platform/widgets/NumericKeypad.tsx`)

With the tablet layout (or Settings › Number keypad: Always) a focused value
field gets an on-screen keypad beside the tool column instead of the system
keyboard (`inputmode="none"` while it shows). It types into the field like a
keyboard, so the field’s own rules apply: expression fields
(`data-hc-keypad="expression"`: sketch dimensions, parameters, tool
dimension labels) get `( ) ÷ × − +`, plain numbers (`inputmode="decimal"`)
get ±; unit keys come from `data-hc-keypad-units` (`mm in` or `°` on the
tool labels). ✓ = Enter (apply), × = Escape (revert), “abc” hands the field
back to the system keyboard (parameter names). The display row mirrors the
field, so a covered field is still readable.

### Settings › Touch and pen (persisted preferences)

Tablet layout (Automatic/On/Off), Tools (left/right side), Finger in sketches
(Automatic/Pen only draws/Touch draws too), Pen shapes, Scribble to erase,
Palm rejection, Number keypad (Automatic/Always/Off), Undo/Redo gestures,
Twist to roll, Inertia — all on/automatic by default. The shortcut sheet
(hold Ctrl, `?`) lists the touch and pen gestures.

## Architecture

| Piece                                                | Module (layer)                | Notes                                                                                            |
| ---------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `pointer.ts`: samples, drawing role, pen presence    | input (platform)              | Pure; `installPenTracking` listens window-wide (capture, passive)                                |
| `gestures.ts`: recognizer, inertia                   | input                         | Pure state machine, time injected; `poll` for the long press                                     |
| `strokes.ts`: stroke recognizer                      | input                         | Pure geometry in any unit                                                                        |
| `tabletLayout.ts` / `deviceProbe.ts`                 | input                         | Pure decisions + store; the probe (UI products only) reads media features and the shared package |
| `navigation.ts` `penNavigation`                      | input                         | Data, like the mouse presets                                                                     |
| `preferences.ts`: touch and pen settings             | input                         | `penSeen` survives “Reset to defaults”                                                           |
| `deriveInputProfile`                                 | `@himmelcad/hardware-profile` | Additive, unit-tested in the package; no change for Builder/PhotoLab                             |
| Gesture handling, pen modifiers, glide, handle sizes | viewport (platform)           | `Viewport.tsx`, `scene.ts`, `SelectionBox.tsx`                                                   |
| `ViewportMode.tap` / `boxSelect`, `adoptTouches`     | viewport (`domOverlays.ts`)   | Modes take finger taps/boxes; overlays hand fingers to navigation                                |
| Keypad (`keypad.ts` logic, `NumericKeypad.tsx`)      | widgets (platform)            | Generic: any focused field that declares itself                                                  |
| `penStrokes.ts`, overlay routing                     | sketching (domain)            | Plans strokes as tool inputs; `SketchState.runTool` is the session’s extension point             |
| Settings, layout CSS, keypad mount, notices          | shell-ui (interface), app CSS | `SettingsDialog.tsx`, `LeftDock.tsx`, CSS modules, `assembler.css`                               |

Product-agnostic: nothing here imports Electron; the web product reuses the
input module, the viewport and the keypad as they are (Pointer Events with
`pointerType: 'pen'` are what iPadOS Safari reports for the Apple Pencil;
`touch-action: none` on the canvas and the sketch overlay keeps the browser
from scrolling or zooming). `deviceProbe.ts` and the keypad need a DOM
window only.

## Verification

- Unit: `test/input/gestures.test.ts` (taps, double taps, long press, box with
  a second finger, orbit, pinch/pan/twist dead zone, multi-finger taps,
  swipes, cancel, inertia), `test/input/strokes.test.ts` (fits, every shape,
  non-shapes, recognition rates over 60 seeds per shape incl. small and thin
  shapes), `test/input/pointer.test.ts` (pointer samples, drawing roles,
  palm rejection, preferences, tablet decisions, keypad editing, pen
  modifiers, unchanged mouse bindings), `test/sketch/penStrokes.test.ts`
  (strokes through the real solver: constraints, connections, tangency,
  concentric snap, one undo step, active tool untouched, erase, tool
  restrictions), `packages/@himmelcad/hardware-profile` (`deriveInputProfile`).
  The strokes are synthetic (seeded hand-like wobble, sensor noise, pen-down
  hooks, rounded corners) — not recordings of a device.
- End to end: `test/electron/touchPen.test.ts` in the built app with
  Chromium touch emulation (CDP `Emulation.setTouchEmulationEnabled`),
  fingers as `Input.dispatchTouchEvent`, the pen as `Input.dispatchMouseEvent`
  with `pointerType: 'pen'`: automatic tablet layout, a pen rectangle with 4
  degrees of freedom, the keypad on a line length, mouse clicks still drawing
  lines, Finish, two-/three-finger taps, the long-press menu, left-handed.
- Dev probes (DEV hook, `D:\AgentWork\HimmelCAD-Assembler\shots\block8-touch\b8-*.mjs`,
  results `b8-gestures.json`, `b8-sketch.json`): orbit, pinch (distance ×
  0.57), pan, twist (40° → 28° roll), undo/redo taps and swipes, double tap
  on a face (looks straight down) and on empty canvas (fit), long-press menu,
  second-finger box filter (Faces → 5 faces), palm rejection (no orbit),
  pen + Shift orbit, keypad value 12 applied. Screens `t01`–`t10*.png`
  (1180 × 820, coarse pointer).

- Performance: `bench:interactive` (no code on its path changed) as an
  interleaved A/B against 8a892c9e on the same machine, 6 runs each, while
  other streams loaded the CPU (36–100 %): medians moved ±10–20 % in both
  directions, including pure OCCT time; by per-row minimum one row was > 10 %
  slower (leave the sketch, UI part 5.3 → 5.9 ms; its wall time +3.8 %).
  Evidence: `D:\AgentWork\HimmelCAD-Assembler\shots\block8-touch\bench-interactive-ab-*.md`.

## Limits and open items

- **No real hardware yet:** iPad (Safari, Apple Pencil — through the web
  version), Windows pen tablets (Windows Ink: barrel button mapping, eraser
  `button 5`, palm contact sizes), touch laptops. Timings and thresholds
  (slop 10 px, long press 500 ms, palm 600 ms / 60 px, stroke tolerances)
  are first guesses to tune on devices.
- Strokes are recognised when the pen lifts; Shapr3D’s wiggle to switch
  line ↔ arc while drawing (SK-18) and a live preview of the recognised
  shape are not implemented; no ellipse, spline or slot recognition.
- System gestures (iPadOS three-finger undo, Windows edge swipes) may take
  some gestures first on real devices.
- Twist roll and one-finger orbit: the orbit is not compensated for a
  rolled view (same as the mouse after the cube’s roll arrows).
- Measure/Print panel touch sizes still follow `@media (pointer: coarse)`
  (their own modules), so “Tablet layout: On” on a mouse device does not
  enlarge them; the Section controls (display module) are not mirrored for
  left-handed use.
- Shared `@himmelcad/ui` controls grow through the control-height tokens and
  role-based rules in `assembler.css`, not per component.
- Why a command is disabled is still a hover tip / `title` on the left dock’s
  mode buttons and menu rows; on touch a tap on a disabled button explains
  nothing yet (a tap equivalent for that tip is open).
