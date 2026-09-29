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
- `pnpm build` — renderer (Vite) + Electron main/preload (`tsc`).
- `pnpm typecheck` — renderer and main-process TypeScript projects.
- `pnpm test` — Node test runner; kernel tests load the real OCCT wasm in
  Node (once per test file).

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
clicked sketch region extrudes just that profile. Escape order: dimension
field, tool, selection.

## Sketch mode

Constrained sketches solved by FreeCAD's planeGCS (WebAssembly, own worker;
LGPL record in `LICENSES/THIRD_PARTY.md`). Line `L`, Arc `A`, Circle `C`,
Rectangle `R`, Polygon `G` start a sketch (on XY, or on the selected planar
face; the first click on a face moves an empty new sketch there); Trim `T`,
Offset `O`, Dimension `D`, Construction `Q` and the constraints (Shift +
letter) work inside it. Double-click a sketch (viewport, Items, History) to
edit it. Snapping and inferred horizontal/vertical/perpendicular/parallel/
midpoint/point-on constraints while drawing; typed values add dimensions;
dimensions accept expressions (`d1 / 2`). Blue = under-constrained, green =
fully constrained; conflicting edits are rejected with a red banner and the
last valid sketch is kept. Dragging moves unconstrained geometry through the
solver. Esc cancels the tool, then leaves the sketch; the session undoes step
by step and becomes one document undo step. Profiles are the detected closed
regions (holes and intersections included), referenced by stable keys.
Project files are schema 2; schema 1 files migrate on load. Details and
limits: `assembler/SKETCHING.md`.

## Dev automation hook (DEV only)

`pnpm dev:web` / `pnpm dev` builds expose `window.__assembler` for cheap,
calibration-free screen recordings and UI smoke scripts (Playwright). It is
installed from `renderer/src/devtools/automationHook.ts` behind
`import.meta.env.DEV`, is absent from production builds and is **not part
of the product contract** (agents use the command registry / the future
automation API). Screen positions are CSS pixels relative to the page
viewport, directly usable with `page.mouse`.

| Member                            | Returns                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `store`                           | The zustand store (`getState()`, actions).                                                                                              |
| `project([x, y, z])`              | `{ x, y }` of a world point (mm), or `null` behind the camera.                                                                          |
| `faceAnchor({ bodyId, faceKey })` | A visible, unoccluded pixel of the face, found in the picking id buffer (largest clearance to other ids), or `null` if hidden/occluded. |
| `edgeAnchor({ bodyId, edgeKey })` | Same for an edge (its pick ribbon).                                                                                                     |
| `handleAnchor(kind)`              | Same for a drag handle: `'extrude' \| 'blend' \| 'shell' \| 'section'`.                                                                 |
| `bodies()`                        | Displayed bodies (the active tool's preview if any): `id`, `name`, `volume`, `min`, `max`.                                              |
| `faces(bodyId)` / `edges(bodyId)` | Stable references (`faceKey`/`edgeKey`) with readable names (`"Extrude 1 end · plane +Z at …"`, `"Circle Ø6 at …"`) plus geometry.      |
| `waitForKernelIdle()`             | Resolves when no document/preview evaluation is outstanding and that state has been drawn (so anchors are current).                     |
| `sketchToScreen([u, v], id?)`     | Page pixel of sketch coordinates in the open sketch session (or in the evaluated sketch `id`), `null` if not visible.                   |
| `sketchSession()`                 | Open session summary: feature id, tool, DOF, problem message, constraint kinds, dimensions (`id`, `name`, `kind`, `value`), selection.  |
| `dimensionChip(name)`             | Centre of the value chip of dimension `name` (e.g. `"d1"`), or `null`.                                                                  |
| `waitForSketchIdle()`             | Resolves when no sketch edit/drag solve is pending, the document settled and the frame is drawn.                                        |
| `sketchStore`                     | The sketch-mode zustand store (`begin`, `dispatch`, `setTool`, …).                                                                      |

Example (see `D:\AgentWork\HimmelCAD-Assembler\shots\tool-shots.mjs` on the
Windows host for a full script):

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
