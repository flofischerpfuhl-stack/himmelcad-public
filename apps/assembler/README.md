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
Circle (`C`) and Rectangle (`R`) take their plane from the first click on
a planar face; Extrude picks New/Join/Cut from face contact (out of a face
joins, into a body cuts, free-standing is new) until the badge overrides it.
Escape order: dimension field, placed circle centre, tool, selection.

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
