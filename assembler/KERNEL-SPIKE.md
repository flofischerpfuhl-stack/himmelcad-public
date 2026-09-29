# Assembler Phase 1 — CAD-kernel spike (OCCT via WebAssembly)

Status: **slice evidence, not a final architecture** (2026-09-29). This spike
answers "can the Assembler UI shell drive a real B-rep kernel, with stable
references, fast enough?" for `PLAN.md` §6 Phase 1 and feeds §8 calibration.
It does not decide the long-term backend variant of `PLAN.md` §3 (FreeCAD
backend vs. selective Rust port); ADR 0033 §3 keeps that decision open.

## Decision taken for the slice

OCCT compiled to WebAssembly (opencascade.js build `replicad-opencascadejs`
1.1.0, OCCT 8.0.1), driven through **replicad 1.1.0** (MIT), running in a
**Web Worker** behind the app-owned `KernelAdapter` interface
(`apps/assembler/renderer/src/kernel/adapter.ts`).

Why, for this slice:

- No native C++ toolchain on the Windows host (no cmake/ninja); a native OCCT
  build is hours of work before the first line of product code.
- One artifact runs in `dev:web`, Electron and Node tests, cross-platform.
- The `.wasm` (and its Emscripten loader chunk) is loaded at runtime and stays a
  separately replaceable unit, as `docs/DEPENDENCY-POLICY.md` requires for LGPL
  (record: `LICENSES/THIRD_PARTY.md` "Conditionally admitted LGPL components",
  including the AGPL-compatibility analysis).
- The `KernelAdapter` boundary keeps the UI independent of it: a native
  OCCT/Rust adapter or a FreeCAD sidecar can replace the worker adapter without
  touching store, viewport or chrome.

### Alternatives considered (why not now)

| Alternative                              | Why not for this slice                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native OCCT via Rust `opencascade-sys`   | Needs cmake/ninja + a full OCCT C++ build per platform (not on this host; hours per build), plus Electron↔Rust IPC that does not exist yet. The likely long-term shape of `PLAN.md` §3 variant 2 — the adapter boundary is designed for it. |
| Python OCP / build123d sidecar           | Adds a CPython + OCP (~hundreds of MB, VTK) runtime to ship and license-audit, a process protocol and packaging per OS. Good agent ergonomics (U5) but a heavier first step; worth re-evaluating for the agent-API comparison in §5.        |
| FreeCAD backend (`PLAN.md` §3 variant 1) | Brings FreeCAD's document/recompute authority, Qt/Coin dependencies and LGPL-2.1+ app code; must be evaluated separately with its own licensing/packaging study. Not needed to prove kernel + references + UI loop.                         |

## What was built

- `kernel/evaluator.ts` — replays the feature list with replicad/OCCT:
  `sketch` (XY/XZ/YZ + offset or a planar face; rectangle and circle
  profiles, data-driven), `extrude` (distance, both sides, new/join/cut;
  planar-face push/pull), `fillet`, `chamfer`, `shell`, `boolean`
  (union/subtract/intersect, tools consumed), `move`, `setAppearance`.
  A failing feature records an error and leaves bodies unchanged; later
  features still evaluate. Output per body: indexed mesh with per-triangle
  face ids and per-face normals (crisp planes, smooth cylinders), edge
  polylines with edge ids, face metadata (surface kind, planar normal,
  area, centroid, adjacency), exact volume, bounding box and
  `BRepCheck_Analyzer` validity.
- `kernel/naming.ts` — stable references (below), pure TypeScript.
- `kernel/adapter.ts` — `KernelAdapter` contract: async jobs, per-channel
  coalescing (`document` before `preview`), revision echo for stale-result
  dropping, soft and hard cancel (hard = worker restart), load status.
  `InProcessKernelAdapter` runs the real kernel in Node tests.
- `kernel/kernel.worker.ts`, `kernel/workerAdapter.ts` — the browser/Electron
  path; streams the wasm with byte progress (`kernelStatus`
  `loading|ready|error` + message + progress in the store, shown in the
  status strip).
- Store (`model/store.ts`): evaluation is now asynchronous. Every document
  change bumps a revision; stale results are discarded; results are cached
  per feature-array identity so undo/redo to a known state is synchronous;
  selection is by naming key and re-mapped/pruned after each evaluation.
  Contract kept: features, transactional undo/redo, preview/commit/cancel
  (extrude preview evaluates `features + provisional` on a separate channel),
  selection/hover. New one-step commands: Fillet/Chamfer on selected edges,
  Shell on selected faces, Union/Subtract/Intersect on selected bodies
  (first selected body is the target); parameters are edited in the History
  panel.
- Viewport: real meshes and edge polylines; faces and edges picked and
  highlighted by naming key with the existing style (orange selection, blue
  hover, ghost pass, face borders, edge ribbons).
- Demo document (bracket): 80×50×6 plate, 80×8×40 upright joined at the back,
  R4 fillet on the inner edge, Ø6 hole sketched on the plate's top face and
  cut through — real B-rep.

## Measurements

Host: Windows 10, Ryzen 3 PRO 3200G, 16 GB, integrated Vega 8; not otherwise
loaded. Node 22.23, Chromium 1243 (Playwright build), Vite dev server on
localhost. Numbers from 3 Node runs and 2 browser runs.

| Metric                                                        | Result                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wasm load, Node (compile + init)                              | 272–279 ms                                                                                                                                                                                             |
| Wasm load, browser worker (23 MB fetch from localhost + init) | 375–383 ms; page-to-ready 1.5–1.8 s in dev mode                                                                                                                                                        |
| Demo evaluation, first (cold JIT)                             | Node 392–403 ms (model 333–342, tessellation 52–69); browser 262 ms model + 42 ms tessellation                                                                                                         |
| Re-evaluation after the plate-width edit (full replay)        | Node 121–129 ms; browser round trip incl. worker transfer 134–137 ms (model 83–84, tessellation 24)                                                                                                    |
| Extrude preview (push/pull 12 mm, full replay + provisional)  | 165 ms round trip in the browser                                                                                                                                                                       |
| Undo to an already evaluated state                            | 0.2–0.3 ms (cache hit, no kernel call)                                                                                                                                                                 |
| Tessellation                                                  | 444 triangles, 10 faces, 24 edges for the demo; 448 triangles after the width edit (chordal 0.05 mm, 0.15 rad)                                                                                         |
| UI thread during kernel load/evaluation                       | No long task (>50 ms) between first kernel status and first result; the three startup long tasks (72/71/271 ms) end before the worker reports status (dev-mode module evaluation + first React render) |
| Bundle added (production build)                               | wasm 22,980,267 B (gzip 7.25 MB, brotli 5.01 MB); loader chunk 60 KB (gzip 23 KB); worker chunk 220 KB (gzip 66 KB); main chunk +9 KB (406.7 → 415.9 KB)                                               |

Geometry validation (hand calculation in `createDemoDocument` and the tests):

| Check                                 | Expected                                                       | Kernel                                |
| ------------------------------------- | -------------------------------------------------------------- | ------------------------------------- |
| Volume, demo                          | 80·50·6 + 80·8·40 + (4² − π·4²/4)·80 − π·3²·6 = 49 705.044 mm³ | 49 705.044 mm³ (< 0.01)               |
| Volume, plate width 100               | 55 705.044 mm³                                                 | 55 705.044 mm³                        |
| Bounding box                          | [0,0,0]–[80,50,46]                                             | exact (< 1e-6)                        |
| Fillet face area                      | π·4·80/2 = 502.65 mm²                                          | matches (< 1e-3)                      |
| Hole face area                        | 2π·3·6 = 113.10 mm²                                            | matches (< 1e-3)                      |
| B-rep validity (`BRepCheck_Analyzer`) | valid                                                          | valid (demo, edits, shell/union case) |

## Stable references — design and limits

Implemented in `kernel/naming.ts`; tests in `test/kernel/naming.test.ts`,
`test/kernel/evaluator.test.ts`, `test/model/store.test.ts`.

1. **Generated names**: faces created by a feature get `<featureId>:<role>`
   keys: `:start:<p>`/`:end:<p>` extrude caps, `:side:<p>:<segment>` side
   faces per profile segment, `:round:<i>`/`:chamfer:<i>` blend face of the
   i-th referenced edge (found as the new face adjacent to both faces of
   that edge), `:inner:<key>` shell offsets. A push/pull end face inherits
   the pushed face's key.
2. **Propagation by surface identity** through every boolean/fillet/shell/
   move: a result face on the same underlying surface as an input face
   (plane normal + offset; cylinder axis + radius + convexity; other kinds
   by centroid + area) inherits its key. Coplanar faces merged by a fuse →
   earliest feature's key wins, others become aliases. A split face gets
   `#n` suffixes.
3. **Edges** are keyed by their two face keys (`A|B`, `~n` if ambiguous).
4. **Resolution**: key/alias first; if nothing carries the key, a strict
   geometric fallback re-binds only to a _unique_ candidate of the same
   kind within 1% of the body diagonal and ±5% area/length, and the feature
   gets a visible warning. Otherwise the feature fails with
   `Missing reference: …` — never a silent re-bind.

Results (tests, real kernel):

- Edit base-plate sketch width 80 → 100 (also 120 in the store test): the
  fillet still resolves by key to the plate-top/upright-front edge, no
  warning; volume and fillet placement match the hand calculation; a face
  selected before the edit stays selected.
- Suppress the upright (Extrude 2) or make it a separate body: the fillet
  reports `Missing reference: edge "…"`, no re-bind, rest of the history
  evaluates.
- Push/pull keeps the moved face's key; chamfer, shell, move and union
  evaluate valid with keyed faces.

Limits (known, not solved by the spike):

- Free-form surfaces (B-spline, torus corners of multi-edge fillets) only keep
  their key while unchanged; a later edit that changes them makes references
  to them fall back to geometry or fail.
- `#n` order of split faces is positional; a reference to one piece of a
  split face picks the nearest piece by centroid.
- Surface identity cannot tell apart two different features that create
  faces on the _same_ surface later on; the earliest-feature rule decides.
- ~~Sketch profiles are addressed by index~~ — superseded 2026-09-29:
  profiles are detected regions with stable keys and side faces are named
  by sketch entity (`<extrude>:side:<p>:<entityId>`); see `SKETCHING.md`.
- OCCT's own history (`BRepAlgoAPI_*::Modified/Generated`) is not used; it is
  available in the bindings and is the next step if surface identity proves
  too weak (e.g. for variable fillets or drafts).

## Open risks

- **Full replay per change.** Each edit/preview re-runs the whole history
  (~120 ms for 7 features). Prefix caching of body states in the worker is
  the obvious next step before long histories.
- **Hard cancel = worker restart** (~0.4 s reload); OCCT operations cannot be
  interrupted inside a single-threaded wasm call.
- **Packaged Electron is unverified.** Dev Electron loads from the Vite
  server; a packaged `file://` renderer may not allow `fetch()` of the wasm
  or module workers — likely needs a privileged `app://` protocol. The asar
  layout must keep the two LGPL files replaceable.
- **Fillet/shell robustness** is OCCT's (not Parasolid's); failures surface as
  feature errors. Only the demo-level cases are tested.
- **Memory**: replicad relies on `FinalizationRegistry` to free OCCT objects;
  long sessions were not profiled.
- Kernel-in-browser ≠ final architecture: the Rust feature graph and agent
  API of `PLAN.md` §3/§5 do not exist yet; the feature list lives in the
  TypeScript store.

## What remains for Phase 1 (`PLAN.md` §6)

Save/Reopen (project file with feature list + schema version), 3MF/STL export
(the kernel can tessellate/export; a printer-grade 3MF writer is missing),
the agent command path (same commands via Python/automation), sketch
constraints/solver (`planeGCS` evaluation), prefix-cached evaluation, a
packaged-Electron check of the worker/wasm path, and the §7 acceptance parts
(enclosure with lid, bracket with slot, pipe adapter) as end-to-end tests.
