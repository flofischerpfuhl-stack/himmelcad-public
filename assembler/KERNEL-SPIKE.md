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
  `sketch` (XY/XZ/YZ + offset or a planar face; since the sketch-solver
  merge a constrained sketch whose closed regions are the profiles, see
  `SKETCHING.md`; originally rectangle and circle profiles), `extrude` (distance, both sides, new/join/cut;
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

## Stable references — reference scheme v2

Implemented in `kernel/naming.ts` (pure), `kernel/occt.ts#faceOrigins`
(OCCT history), `kernel/regionRebind.ts`; tests in
`test/kernel/naming.test.ts`, `evaluator.test.ts`, `features.test.ts`,
`references.test.ts` (adversarial cases), `test/model/store.test.ts`.
The naming contract of v1 is unchanged — keys, `A|B` edge keys, `#n`/`~n`
suffixes, aliases, `Missing reference: …` errors — and the demo bracket and
the features part produce exactly the v1 keys (checked against the v1
evaluator on the bench parts); only how a result face finds its key changed.

1. **Generated names** (as v1): `<feature>:start:<p>`/`:end:<p>` caps,
   `:side:<p>:<entityId>` sides (sketch entity of the boundary piece),
   `:round:<i>`/`:chamfer:<i>` blend faces, `:inner:<key>` shell walls,
   `:cut` split faces, `:new` otherwise; a push/pull end face and an offset
   face keep the moved face's key.
2. **Propagation by OCCT history** (new). Booleans (`BRepAlgoAPI_*`,
   non-destructive, `SimplifyResult` as before), fillet/chamfer
   (`BRepFilletAPI_*`) and shell (`BRepOffsetAPI_MakeThickSolid`) run
   through their builders and every result face is named from the
   builder's history before the builder is deleted:
   - **identical** to an input face (`IsSame`, the face was not touched):
     keeps key, aliases and its descriptor (no OCCT query at all);
   - **Modified** from input faces: inherits their keys — several (coplanar
     faces merged by the fuse) → earliest feature's key, the others aliases;
     one input split into several faces → `#n` pieces (centroid order);
   - **Generated** by a generator: fillet/chamfer faces from
     `Generated(edge i)` → `:round:i`/`:chamfer:i`, shell walls from
     `Generated(face)` → `:inner:<key>`;
   - nothing reported → **surface identity** (v1: plane normal + offset,
     cylinder axis + radius + convexity, other kinds centroid + area), then
     the generated name. Revolve/sweep/loft already named from history.
     Rigid motions (move/rotate/mirror/pattern/align) keep every key by
     transforming the descriptors; a translation/rotation relocates the same
     B-rep (instances share geometry and triangulation), detected with
     `IsPartner`.
3. **Edges** are keyed by their two face keys (`A|B`, `~n` if ambiguous).
4. **Resolution**: key/alias first. **Split rule** (new): when several
   pieces carry an unsuffixed key, the piece nearest to the position
   recorded in the reference (face centroid / edge midpoint) keeps it —
   only if every other piece is more than twice as far away — and the
   feature gets a warning (`Face "…" was split into N faces; the piece at
its recorded position keeps the reference`); otherwise it fails with
   `Ambiguous reference: face "…" was split into N faces — re-select the
face`. Without any key match the strict geometric fallback of v1 applies
   (unique candidate, same kind, within 1 % of the body diagonal and ±5 %
   size, warning `re-bound by geometry`), else `Missing reference: …`.
5. **Redrawn sketch profiles** (new, `regionRebind.ts`): a region key that
   no longer exists (a boundary line deleted and redrawn gets a new entity
   id) re-binds to the unique free region bounded by all of the old key's
   entities that still exist, or — when none survive — to the sketch's
   only free region; always with a warning, otherwise `Missing reference:
profile …`. Deterministic: only the document is consulted.
6. **v1 migration**: v1 named coplanar faces of _different_ features
   `<first>#n` with all the others as aliases (e.g. the tops of ten bosses
   on one plate: `boss-0:end:0#1…#10`); v2 names each after its own
   feature (`boss-3:end:0`). A stored `#n` key that now names a single face
   must be confirmed by its recorded position (within 1 % of the diagonal),
   else it takes the geometric fallback — so an old reference never binds a
   different boss silently.

Adversarial cases (`test/kernel/references.test.ts`, real kernel):

| Case                                                                                               | Outcome                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Slot inserted before a sketch-on-face splits the referenced top face; recorded centre on one piece | the piece keeps the reference, warning on the sketch; hole cut where it was                                                                     |
| Same, recorded centre in the slot gap (equidistant)                                                | `Ambiguous reference: face "b:end:0" was split into 2 faces — re-select the face`; downstream extrude reports its missing sketch                |
| Fillet on the top-front edge, then Offset Face of the front face (+2)                              | both resolve by key, no warning; volume = hand calculation                                                                                      |
| Offset Face inserted _before_ the fillet                                                           | the edge keeps its key (top merges with the slab top, alias), no warning                                                                        |
| Pattern count 3 → 5 with a fillet on instance 2 (`body:pat:1`)                                     | resolves by key on the same instance, source untouched; a fillet on instance 3 after count 3 → 2 reports `Missing reference: body "body:pat:2"` |
| Revolve 90° → 120° → 200° with a fillet on an end-cap edge and a sketch on the start cap           | resolve by key (caps from `FirstShape/LastShape`), no warning; at 360° both report `Missing reference` (no caps)                                |
| Rectangle side `l3` deleted and redrawn as `l5`                                                    | extrude re-binds `l1+l2+l3+l4` → `l1+l2+l4+l5` (warning); the fillet on the old `…:side:0:l3` edge re-binds by geometry (warning); same solid   |
| Circle redrawn (`c1` → `c2`), one profile                                                          | re-bound to the only profile (warning); with two circles and no surviving entity: `Missing reference: profile "c1"`                             |
| v1 key `b1:end:0#2` for the second boss top                                                        | geometric re-bind to `b2:end:0` (warning), not the first boss                                                                                   |

Limits:

- The split rule needs a recorded position that still lies on (or clearly
  nearest to) the intended piece; after large parameter edits that move the
  face, a split reference becomes ambiguous rather than guessed.
- Faces OCCT reports neither as modified nor generated (e.g. torus corner
  patches of multi-edge fillets, some offset slab walls) still use surface
  identity or `:new`.
- Region rebind is topological (surviving entity ids), not geometric: a
  profile whose every edge was redrawn is only re-bound when it is the
  single free profile; the references do not store region geometry.
- Split Body, Offset Face and Delete Face booleans are named by history,
  their tool faces by position/role as before.

## Modelling features (2026-09-29)

Added on top of the slice, as real kernel features (`model/features.ts`,
`kernel/features/*`, hooked into `evaluator.ts` through a small
`FeatureKit` — the evaluator stays the owner of body state and reference
resolution). Profiles are read like Extrude's: the detected sketch regions
(`regions` keys, else every region; faces built by
`kernel/sketchGeometry.ts#regionFace`) or a planar body face. Generated faces
are named after the sketch entity of the boundary piece that swept them
(`<feature>:side:<p>:<entityId>`, `~k` for several pieces of one entity; a
face profile uses the edge index), `p` being the region's position in the
reference — the same scheme as Extrude, so v1 files migrate with one rule. A
revolve/pattern axis can be any sketch line by entity id, construction lines
included (`{kind: "sketchLine", featureId, entityId}`); the Revolve tool
defaults to a construction line of the profile's sketch that does not cross
the profile, and sketch lines become pickable axis targets while Revolve or
Pattern runs.

| Feature                                                                | OCCT route                                                                                                                                                   | Naming                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revolve (profile + world/edge/sketch-line axis)                        | `BRepPrimAPI_MakeRevol` per profile, New/Join/Cut via the extrude booleans                                                                                   | from OCCT history: `Generated(edge)` → `:side:<p>:<entityId>`, `FirstShape/LastShape` → `:start/:end`; faces OCCT does not report (planar annuli of a full revolve) fall back to the boundary piece lying on the face's surface |
| Sweep (edge chain, sketch region outline or straight line path)        | `BRepOffsetAPI_MakePipeShell` (corrected Frenet), `MakeSolid`                                                                                                | same scheme (`Generated`, first/last shape)                                                                                                                                                                                     |
| Loft (≥ 2 profiles, smooth or ruled)                                   | `BRepOffsetAPI_ThruSections` with compatibility check                                                                                                        | `GeneratedFace(edge of the first section)`, first/last shape                                                                                                                                                                    |
| Mirror, Pattern (linear/circular), Transform (move/rotate/copy), Align | `gp_Trsf` (`SetMirror/SetRotation/SetTranslation`) + `BRepBuilderAPI_Transform` (rotations/translations relocate the same B-rep; only mirrors copy geometry) | the face descriptors are transformed with the same affine map (`rigid.ts`), so in-place motions keep every key; copies are new bodies (`body:<feature>:<n>`) carrying the source keys                                           |
| Split Body (world plane or planar face)                                | `intersect`/`cut` with a half-space prism                                                                                                                    | inherited from the boolean history (surface identity as fallback); the new cut faces are `<feature>:cut`; the positive side becomes `body:<feature>`                                                                            |
| Offset Face (planar, cylindrical, other smooth faces)                  | `BRepOffsetAPI_MakeThickSolid::MakeThickSolidBySimple` slab, joined (outward) or cut (inward)                                                                | the offset surface keeps the face's key (like push/pull)                                                                                                                                                                        |
| Delete Face (holes; fillets/chamfers between two planar faces)         | hole: fuse a cylinder over the face's axial extent; fillet/chamfer: fuse/cut the corner prism between the face and its extended planar neighbours            | neighbours re-grow on their own surfaces and keep their keys                                                                                                                                                                    |

Measured (same host; Node test `features.test.ts` and the browser worker
via `feature-measure.mjs`): a part with shaft, revolved groove (cut),
lug, circular pattern ×4, mirror copy and split (9 features, 7 bodies,
2 388 triangles) evaluates in Node in 115–157 ms (model 57–81, tessellation
58–76), re-evaluates after the shaft height edit in 117–138 ms; in the
browser worker 230 ms round trip cold (model 106, tessellation 86), then
152–160 ms (model 65–67, tessellation 55–64); a History-card edit of the
revolve angle (one undo step) re-evaluates in 166 ms.

Verified by real-kernel tests (volumes and boxes against hand
calculations, `BRepCheck_Analyzer` validity): full/quarter/negative
revolves, axes from a sketch line and a body edge, groove cut and collar
join, rod/torus/edge-path sweeps (Pappus), ruled frustum and three-section
loft, mirror copy/in place/across a face, linear and circular (full and
partial) patterns, split, rotate+translate+copy, align with gap, hole
enlarge/shrink and planar push by Offset Face, hole/fillet/chamfer removal
by Delete Face. Stable references after an earlier parameter edit: a
fillet on a revolved edge survives the profile-width edit, a fillet after a
transform survives a sketch edit, an Offset Face follows its hole when the
hole moves — all resolved by key, no geometric re-bind.

Limits (with the OCCT reason). The HimmelCAD OCCT build
(`OCCT-BUILD-SPIKE.md`, opt-in `HIMMELCAD_OCCT=himmelcad`) lifts the first
two: Offset Face re-extends inclined neighbours (`BRepOffset_MakeOffset`),
Delete Face uses `BRepAlgoAPI_Defeaturing`; the text below describes the
default `replicad-opencascadejs` build.

- **Offset Face does not re-extend neighbours.** OCCT's per-face offset
  (`BRepOffset_MakeOffset::SetOffsetOnFace`) is excluded from this
  opencascade.js build (`MakeOffset` is dropped from the bindings), so the
  face is thickened into a slab and booleaned: exact for faces whose
  neighbours are perpendicular or tangent-free (walls, caps, holes, bosses);
  a face between inclined neighbours gets a step instead of longer
  neighbours. `MakeThickSolidBySimple` also returns an inside-out solid for
  outward offsets, so the offset surface is built first and thickened back.
- **Delete Face covers holes and fillets/chamfers between two planar
  faces only.** `BRepAlgoAPI_Defeaturing` is not in this build; other faces
  (a planar face of a box, variable fillets, torus corners of multi-edge
  fillets, conical hole bottoms) fail with "Delete Face can remove holes,
  and fillets or chamfers between two planar faces. …".
- **Sweep** keeps the profile where it is (no automatic move to the path
  start or twist/scale laws); sharp path corners may make OCCT self-intersect
  and fail; profiles with holes are rejected.
- **Loft** has no guide curves or start/end tangency; profiles with holes
  are rejected; a single-profile sketch per section.
- Revolve rejects profiles that cross an in-plane axis; helix/elevation is
  not implemented.
- Mirror/Pattern copies are independent bodies; the Delete command on a copy
  deletes the whole Mirror/Pattern step (it is the copy's creating feature).
- The Move/Rotate preview is transformed client-side (instant), the commit
  is re-evaluated by the kernel; the pivot snaps to face centroids, edge
  midpoints and circle centres of the committed geometry.

## Print-part features (2026-09-30)

Tools for printable parts, as real kernel features (`model/printFeatures.ts`,
`model/blendOptions.ts`, `kernel/features/{holes,emboss,draft,ribThicken,blendRules}.ts`)
with Shapr3D-style tools in the generic feature session
(`model/printFeatureTools.ts`), History cards, agent-API schemas
(`api/printSchema.ts`) and Python helpers (`himmelcad.assembler.printing`).

| Feature                                                                                    | OCCT route                                                                                                                                                                                                                                                                           | Naming                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Hole (simple/counterbore/countersink, blind/through all, many per feature)                 | per hole a revolved half section (`revolution`) from 0.05–1 mm above the face; holes that do not touch are cut in **one** boolean with a compound tool, touching ones are fused first                                                                                                | `<id>:wall:<i>`, `:cbore:<i>`, `:cbfloor:<i>`, `:csink:<i>`, `:floor:<i>` (hole `i`), kept on the body through the cut's history |
| Emboss / engrave (planar face)                                                             | profile moved onto the face plane along its normal, extruded out (join) or in (cut) from that plane; all profiles in one boolean (non-touching tools in a compound, since 2026-09-30 — "Interactive latency")                                                                        | `<id>:top:<p>` / `:floor:<p>`, `:side:<p>` (`#n`)                                                                                |
| Emboss / engrave **wrapped** on a cylinder                                                 | the region drawn in the parametric space of a cylindrical surface (replicad `sketchOnFace(…, 'native')`: OCCT p-curves, lines become helices), `u = π + s/R` so the seam is opposite the label; thickened radially with `MakeThickSolidBySimple`                                     | as planar                                                                                                                        |
| Draft (planar, cylindrical, conical faces; neutral plane = a face or a construction plane) | `BRepOffsetAPI_DraftAngle` (**bound in this build**)                                                                                                                                                                                                                                 | drafted faces keep their keys via `ModifiedShape` (its `Modified` list does not report them)                                     |
| Rib from open sketch lines                                                                 | the line extended and swept towards the body into a strip, thickened across the sketch plane, clipped to the body's box, minus the body; the solids touching the line are joined                                                                                                     | `<id>:flank:<k>`, `:edge:<k>`                                                                                                    |
| Thicken faces or profiles                                                                  | `MakeThickSolidBySimple` of the offset surface (`makeOffset`) back towards the face, both signs tried (orientation); several faces thickened one by one and fused                                                                                                                    | `<id>:outer:<i>`, `:inner:<i>`, `:side:<i>`                                                                                      |
| Fillet variable radius; chamfer two distances / distance-angle                             | `BRepFilletAPI_MakeFillet::Add(R1, R2, E)` (linear law); `BRepFilletAPI_MakeChamfer::Add(d1, d2, E, F)` / `AddDA(d, a, E, F)`, F = the adjacent face with the smaller key (`flip`: the other)                                                                                        | as before (`:round:i` / `:chamfer:i`)                                                                                            |
| Edges by rule (face edges, concave, convex)                                                | edge convexity from two `BRepExtrema_DistShapeShape::InnerSolution` classifications at the edge midpoint, ±ε along `n_A − n_B`: both inside = concave, both outside = convex, tangent joins neither; re-evaluated every replay                                                       | rule edges follow the picked edges in the generator order                                                                        |
| Shell outward; printing clearance; per-wall thickness                                      | `MakeThickSolidByJoin` with a positive offset and `GeomAbs_Intersection` joins (sharp outer edges); a clearance shells the body first grown by it (`BRepOffsetAPI_MakeOffsetShape::PerformByJoin`, sharp); thicker walls = Offset Face slabs on the wall's free side after the shell | walls `<id>:outer:<key>` (outward) / `:inner:<key>`; grown faces keep the body keys (by geometry)                                |
| Boolean keep tools                                                                         | unchanged booleans; tool bodies stay                                                                                                                                                                                                                                                 | unchanged                                                                                                                        |

Failing fillets/chamfers are re-tried edge by edge (only after the whole
blend failed, at most 24 edges) and the error names and **outlines the
failing edges in the error colour** (`EvaluationResult.errorRefs`, kept in
the checkpoints; the tool preview and a selected History card show them).
Draft errors point at the face. Hole, emboss and rib errors are plain
sentences ("Counterbore diameter (2 mm) must be larger than the hole (3 mm)",
"The rib does not reach the body from this line; …").

Standard hole sizes are a **table of sizes only** (M2–M10: ISO 273 close/
normal/loose clearance, coarse-thread tap drill, DIN 974-1 counterbore for
ISO 4762 heads with depth = head height + 0.4 mm, ISO 15065 90° countersink)
plus printed fits around a pin of the nominal size (press +0, snug +0.1,
clearance +0.2, loose +0.4 mm — FDM starting points, not a standard; printed
holes typically come out 0.1–0.2 mm small). A hole stores plain diameters,
the preset name and optionally a cosmetic thread label; no thread geometry
is generated. Offset Face offers the same 0.1–0.4 mm clearances as presets
(a negative offset: a hole grows, a peg shrinks), and an outward Shell a
clearance (the cavity is the body grown by the gap on every face, e.g. a
0.2 mm case over a 20 × 10 × 10 block: cavity 20.4 × 10.4 × 10.4, verified
by volume).

Verified by real-kernel tests (`test/kernel/printTools.test.ts`, 12 tests;
store/tool tests `test/model/printFeatureTools.test.ts`, API tests
`test/api/printTools.test.ts`, Python `sdk/python/tests/test_printing.py`
incl. a headless bracket): volumes against hand calculations to 1e-3 mm³
(through, blind, counterbore, countersink frustum; planar emboss/engrave;
wrapped emboss `(θ/2)(R₂² − R₁²)h` with the label's height and angle; draft
`½·h·h·tanα·L`; gusset triangle; outward shell `22·12·11 − 2000`; per-wall
shell; thicken slabs and sleeves; two-distance and distance-angle chamfers;
the single concave edge of an L-bracket `(1 − π/4)r²L`), `BRepCheck_Analyzer`
validity, references after an earlier edit (holes at sketch points and a
fillet on a hole rim survive a plate thickness edit, by key, no re-bind),
Cancel/Done/undo, Save/Open round trip, and the error paths.

Measured on this host (Node 22, warm kernel, last-feature evaluation with a
changed hash; median of 5): 8 counterbored holes 400 ms (model 126 ms — was
236 ms before the compound cut — and meshing the 16 new cylinders plus the
re-meshed top face ~160–210 ms at final quality); planar emboss 42 ms;
wrapped engrave of 4 regions 171 ms; draft of one face 22 ms; concave-edge
fillet rule on an L-bracket 71 ms; rib 79 ms; thicken 17 ms. Previews use
the coarser preview quality.

`bench:kernel` before (d4713fd, a separate worktree) and after, four
alternating runs each on this host while other agents were running
(ranges): demo full eval 112–263 / 122–239 ms, edit #2 69–160 / 91–205 ms,
last-feature edit 22–41 / 25–69 ms; features part 124–166 / 124–145,
94–146 / 94–116, 26–42 / 26–29 ms; 60-feature plate 2725–3680 / 2779–3693,
2670–3130 / 2678–4779, 52.9–53.9 / 52.4–80 ms. The spread is host noise; a
focused re-run of the demo edit #2 (25 edits, median, three alternating
runs) gave 84 / 87, 78 / 83 and 124 / 108 ms before / after: no regression
beyond noise (the unchanged paths only gained an `errorRefs` field and a
cached edge-key lookup).

Limits (with the OCCT reason):

- **Per-face shell thickness** is emulated on the default build (the
  HimmelCAD OCCT build shells in one `MakeThickSolid` with
  `SetOffsetOnFace`, thinner walls included; `OCCT-BUILD-SPIKE.md`):
  `BRepOffset_MakeOffset::SetOffsetOnFace`
  is not reachable (`MakeOffset()` is dropped from the bindings), so a
  thicker wall is an Offset Face slab added after the shell — exact for walls
  whose neighbours are perpendicular (boxes, enclosures); inclined neighbours
  get a step. Thinner-than-shell walls are only possible by making the shell
  thickness the minimum.
- **Wrap** works on the outside of cylinders. Cones, spheres and free-form
  faces are refused ("… wrapping onto cones or free-form faces is not
  supported"); the inside of a hole is refused too. A profile may not reach
  more than half way round from the wrap centre (the seam is opposite).
  Sketch text (Inter, see `SKETCHING.md`) is the usual source: each glyph
  contour is a region `<textId>.<n>` and can be listed in the Emboss
  profile. Wrapped Bézier chains (splines, glyphs) map exactly — the unroll
  is affine in the sketch plane — ellipses are sampled as 64-point
  polylines. Kernel evidence: `test/kernel/embossText.test.ts` (engrave and
  emboss "HC" on a plate, wrap it around a Ø20 cylinder; volumes against
  `area · depth` and `area · ((R ± d)² − R²) / 2R`, valid B-rep).
- **Glyph and spline edges** are split into straight lines and
  tangent-continuous B-spline runs (`sketchGeometry.ts#bezierRuns`). One
  C0 B-spline per glyph contour made booleans crossing its side faces
  (engraving from inside the part, through-cuts, joins starting inside a
  plate) return invalid solids with wrong volumes; the split side faces
  keep their piece name with `#n` suffixes.
- **Planar emboss** needs a sketch parallel to the face; profiles are not
  clipped to the face outline.
- **Draft**: OCCT needs the neutral plane to cut the drafted faces' boundary
  consistently; a face parallel to the neutral plane is refused; angles are
  limited to ±45°. Faces are drafted about their intersection with the
  neutral plane only (no parting line split).
- **Rib**: straight lines only; line ends extend until the body or the
  body's bounding box, so a rib against a non-convex body may fill up to the
  box where nothing stops it (the tool shows the preview before Done).
- **Thicken** of several faces with sharp edges between them leaves a notch
  on the convex side (the simple offset joins no neighbours).
- **Edge rules** classify by point containment around the edge midpoint:
  an edge whose midpoint region is ambiguous (e.g. a knife-edge thinner than
  0.02 mm) belongs to no rule. Rule edges' round faces are numbered in shape
  order, so an edit that adds edges may renumber `:round:i` of rule edges.
- **Variable fillet** is linear per edge chain (OCCT `Law_Linear`). OCCT
  builds some blends that do not fit instead of failing — variable fillets,
  asymmetric chamfers, and (fuzzer finding F1, `ROBUSTNESS.md`) plain
  chamfers/fillets larger than a neighbouring face; every blend result is
  checked with `BRepCheck_Analyzer` and an invalid one is reported as an
  error on the edge (15 → 3 mm on a 10 mm block). Some oversized ones still pass the check (2 → 12 mm on a 10 mm
  block builds a valid but visibly wrong solid) — the preview shows it.

## Incremental evaluation, memory and robustness (2026-09-29)

**Prefix cache** (`kernel/evalCache.ts`). After every feature the replay
state — bodies (OCCT shape + keyed face descriptors), sketches, creation
order, errors/warnings so far — is stored as an immutable checkpoint keyed by
`h(i) = H(h(i-1), canonical JSON of feature i)` (106-bit cyrb53 pair; keys
sorted, so equal content hashes equally). A feature's result depends only on
its own parameters and the state before it, so an evaluation starts from the
deepest checkpoint its document shares with an earlier one: an edit
re-evaluates from the first changed feature, a tool preview
(`features + provisional`) only evaluates the provisional feature (its
checkpoint is not kept), undo/redo to a known document costs nothing. The
result is identical to a full replay (tested on three parts, keys, aliases,
volumes, errors and warnings). Booleans run non-destructively so cached
input shapes are never modified. Checkpoints share unchanged shapes; shapes
are reference-counted across checkpoints and **deleted deterministically**
when the last checkpoint holding them is evicted (LRU, estimated byte budget
256 MiB, at most 1 000 checkpoints; the document just evaluated is never
evicted).

**Deterministic memory** (`kernel/occtArena.ts`, `kernel/occt.ts`). replicad
frees the OCCT object behind a wrapper only when the JS garbage collector
finalizes the wrapper — rarely, since the JS side is tiny — and its
`shape.faces`/`shape.edges` getters leak every raw handle they visit
(keeping whole B-reps alive). The arena wraps the global
`FinalizationRegistry` (installed before replicad loads) and records every
registration made while a feature runs; when the feature ends, everything
not pinned (the bodies' shapes, cached topologies) is deleted. Topology,
history, meshing and property helpers delete their raw handles themselves.
Remaining leaks are inside OCCT/its bindings (measured per call, fresh
process: `BRepAlgoAPI_Fuse` ~40 KB for two boxes and ~260 KB for the demo's
sketch prisms (~650 KB without non-destructive mode), `BRepCheck_Analyzer` ~72 KB per solid /
~16 KB per face, `BRepFilletAPI_MakeFillet` ~9 KB, `BRepPrimAPI_MakePrism`
~3 KB, `BRepBuilderAPI_MakeWire` ~1.4 KB, ~27 B per shape returned by an
explorer). Therefore: previews check validity by closure only, validity is
per new face after the first full check (every mode includes the closure /
manifold test, so full and incremental checks agree on non-manifold edges —
`ROBUSTNESS.md` F4; an invalid body gets a warning on the step that last
changed it), and the adapters **recycle** the
kernel when its wasm heap passes 1 GiB (restart when idle, warm up with the
last document; not in a loop for documents that need a big heap).

**Tessellation** (`kernel/tessellate.ts`, `kernel/faceProps.ts`): per body —
an unchanged body shape reuses its mesh (`Body.meshId` is the same, and the
worker sends the arrays only once per `meshId`) — and per face: OCCT keeps a
face's triangulation on the face, faces shared with an earlier result are
not meshed again, and their extracted arrays, exact boxes (`AddOptimal` per
face, only when a cheap box sticks out), volume contributions (signed volume
to the plane z = 0, `VolumePropertiesGK`) and validity are cached. Only the
new faces go through replicad's C++ extractor (a compound of them); a body
with mostly new faces is extracted in one pass. Quality: `final` (chordal
deflection 0.05 % of the body diagonal, clamped 0.005–0.2 mm, angular
0.15 rad) for committed documents and exports, `preview` (0.2 %, 0.02–0.5 mm,
0.35 rad) during tool previews; the deflection is snapped down to a power of
two so small size changes keep face meshes. Unchanged bodies in a preview
keep their final mesh.

**Robustness** (`kernel/adapter.ts`, `kernel/workerAdapter.ts`,
`chrome/KernelActivity.tsx`):

- Crash/OOM: a worker error or a fatal kernel error (wasm `RuntimeError`,
  `Aborted(…)`, `Cannot enlarge memory`) restarts the worker; the status
  carries a notice ("The CAD kernel stopped unexpectedly (…) and was
  restarted. Your document is unchanged."), the running job is retried once
  on the fresh worker, a second crash fails it readably, more than three
  crashes a minute stop retrying with an error. The document lives in the
  store: nothing is lost. The in-process adapter (headless, tests) reloads
  its kernel the same way.
- Long operations: the running job reports progress between features; after
  2 s the UI shows "Updating model… Fillet 3 (12 of 58)" with a progress bar
  and Cancel. Cancel hard-stops the computation (worker restart, bounded by
  the ~0.4 s reload) and restores the last computed document (the cancelled
  change stays available as Redo) or ends the tool whose preview was running.
- Determinism: the same document gives the same names, keys, aliases and
  rounded geometry in every evaluator, warm or cold (`incremental.test.ts`,
  demo keys pinned), and in the production app's browser worker vs Node
  (`test/electron/kernelDeterminism.test.ts` compares the agent API's face,
  edge and body descriptors as JSON). Meshes may differ between a warm and
  a cold kernel (face triangulations are reused), names and keys do not.

Measurements (Node 22, this host, `pnpm --filter @himmelcad/assembler
bench:kernel`; "before" = the same bench on the pre-change head c0d8ecc;
medians of 5 with parameter values no cache has seen; preview = one drag step
of a push/pull on a body face):

| Part                                                                                                                     | Full eval (ms) before → after | Edit feature #2 | Edit last feature |          Preview |     Triangles |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------: | --------------: | ----------------: | ---------------: | ------------: |
| (a) demo bracket, 7 features, 1 body                                                                                     |                     160 → 120 |     97.7 → 83.4 |   76.1 → **26.2** |   112 → **33.1** |           444 |
| (b) features-branch part, 9 features, 7 bodies                                                                           |                     139 → 119 |       135 → 108 |    123 → **28.4** |   130 → **16.2** | 2 388 → 2 468 |
| (c) synthetic plate, 60 features (40 patterned holes, 14 fillets, a chamfered outline, shell, 10 bosses, a move), 1 body |                 7 215 → 2 665 |   7 436 → 2 600 |  7 375 → **52.4** | 8 199 → **55.4** |        53 196 |

| Part | Tessellation, full (ms) before → after |       Tessellation, last-feature edit | Triangles final / preview quality |
| ---- | -------------------------------------: | ------------------------------------: | --------------------------------: |
| (a)  |                            25.4 → 28.7 |                            15.0 → 9.2 |                         444 / 204 |
| (b)  |                            69.0 → 62.6 |    64.4 → 12.0 (6 of 7 bodies reused) |                     2 468 / 1 236 |
| (c)  |                            1 070 → 790 | 1 187 → 35.9 (3 of ~100 faces meshed) |                   53 196 / 14 236 |

(b)'s final triangle count grew slightly because the deflection is now
snapped down to a power of two. In the production Electron app (browser
worker, agent API `feature.edit` = validate on the preview channel +
commit), a last-feature edit of (c) takes 70–83 ms (median 76 ms,
`kernelDeterminism.test.ts`).

Last-feature edits on the 60-feature plate: **Node 52 ms median (model ~17 ms, tessellation ~36 ms), 76 ms through the app** — the target of
< 50 ms is **not reached**. Where the time goes (`profile: true`, typical):
meshing the new fillet face at final quality ~30 ms (a small torus-like
blend: ~1 900 nodes at 0.15 rad), the fillet itself ~5 ms, topology of the
~100-face result ~8 ms, prefix hashing ~2 ms, the rest < 10 ms. A coarser
angular deflection would reach it but lowers the quality of committed meshes,
which are also what STL/3MF export writes.

Leak session (`bench:kernel -- --leak-only 500`; each of 500 edits of the
demo bracket is a new document, followed by two previews):

| Edit | wasm heap before (MB) | wasm heap after (MB) | kernel caches after (MB, estimated) | median edit before → after (ms) |
| ---: | --------------------: | -------------------: | ----------------------------------: | ------------------------------: |
|    0 |                   100 |                  100 |                                 0.3 |                453 → 407 (cold) |
|  100 |                   496 |                  127 |                                  13 |                         67 → 20 |
|  200 |                   947 |                  239 |                                  25 |                         67 → 23 |
|  300 |                 1 343 |                  413 |                                  38 |                         67 → 27 |
|  400 |                 1 739 |                  496 |                                  51 |                         67 → 32 |
|  500 |                 2 003 |                  595 |                                  55 |                         67 → 36 |

Before: ~3.8 MB per edit (the heap would reach wasm32's 4 GB after ~1 000
edits). After: ~1 MB per edit (3 evaluations), and the _same_ curve with a
16 MB checkpoint budget — so the growth is not our caches but OCCT's own
per-operation leakage (the demo's boolean alone leaks ~260 KB per call).
Recycling at 1 GiB restarts the kernel roughly every 900 such edits.
Not explained: the median edit time creeps from 20 to 36 ms over the
session (more live JS objects/GC; the kernel caches stay bounded).

## Interactive latency (2026-09-30)

The Block-5 demo (dev build, this host) needed ~17 s to place text "HC"
on the lid, ~24 s for the Engrave preview and ~16 s for an M4 counterbore
Hole. Profiled with a new harness before changing anything:
`pnpm --filter @himmelcad/assembler bench:interactive` replays the flows
through the app's stores in Node (in-process kernel and solver) and, with
`-- --browser`, in Chromium against a Vite dev server with the kernel and
solver in their workers (`test/bench/interactiveBench.ts`,
`interactiveBrowser.ts`): (a) enclosure → sketch on the lid top → text
"HC" → Emboss tool → Engrave −1 mm → Done, (a2) an 11-glyph label
"HIMMELCAD 26" (Node), (b) Hole on the enclosure floor → position → M4 →
counterbore → Done, (c) a fillet drag on the demo bracket, (d) dragging a
point of a 60-entity sketch. Per step: wall/response time, main-thread
work (Node: every command's availability, as a toolbar + command-search
render computes it; browser: long tasks), solver, region detection,
kernel split into feature / validity / naming (describe + history) /
tessellation, prefix-cache reuse, and the printability analysis
(informational: it runs in its own worker, 350 ms debounced, only in print
mode, on committed evaluations — never on a step's path). Browser rows are
the response latency: the step's first input (event time stamp, so time
queued behind a blocked main thread counts) to the frame after the last
store change it caused. `ASM_PROFILE=1` prints the top main-thread
functions per browser step.

**Finding: the kernel was not the problem, the UI thread was.** Every
render of the adaptive toolbar and of the command search asks each
profile tool (Extrude, Revolve, Sweep, Loft, Emboss …) for its
availability, which ran `autoProfileOperation` → `pointInsideBody` for
every outline sample of the selected profile/face, each ray-cast against
every triangle of every body with a fresh vector per triangle. With the
enclosure and the glyph outlines that was 0.5–2 s per render, repeated
for every keystroke in the command search: selecting the lid face 2.0 s,
K 2.3 s, Esc out of the sketch 1.1 s, starting Emboss 23.7 s and the Hole
tool 7.7 s of long tasks. The kernel's share of the demo was 0.2–0.3 s
per preview. Fixes (`model/modeling.ts`, `model/featureTools.ts`):

- `pointInsideBody` bins each mesh's triangles once into a grid in the
  plane normal to the fixed parity ray (WeakMap per immutable mesh); a
  query tests one cell's triangles with an allocation-free Möller–Trumbore
  test (same arithmetic). Tested against the brute-force test on a
  lattice through the demo bracket and every mesh vertex.
- `autoProfileOperation` answers repeated questions about the same
  evaluation from a per-evaluation cache.
- `depthInsideBody` (extrude start depth) uses the allocation-free test;
  the sketch overlay computes one view-projection matrix per camera pose
  instead of one per mapped point (glyph outlines map thousands).

Kernel side (`kernel/features/emboss.ts`), measured before changing:
the Emboss boolean of the glyph tool with the lid is ~70–80 % of the
feature (OCCT intersecting the glyphs' B-spline side faces), and a label
paid one fuse per extra glyph over the growing union:

- **Batched tool**: profiles whose tools cannot touch (boxes apart by a
  margin) go into one compound — one boolean for the whole label; only
  overlapping tools are fused (in profile order, as before). Names are the
  per-profile fuse's (pinned: face count + digest of all keys and aliases
  of an 11-glyph label; a touching/separate mix listed exactly).
- **Planar tools start on the face plane** (no lead into the material),
  like an extrude from a sketch on a face: ~30 % less boolean time on
  glyphs, same names and volumes on the face, and a profile hanging over
  the face edge no longer gets a lead-thick skirt (test: exactly area ×
  height). Wrapped tools keep their radial lead.

Not changed, verified instead: text is already a rigid block for the
solver (only its anchor point, 2 DOF; the glyph outline is stored data,
never solver geometry) — placing "HC" solves in 0.2–0.4 ms; region
detection prunes curve pairs by bounding box (1 ms for "HC", 8–16 ms for
11 glyphs); previews reuse the prefix cache (18 of 19 features restored)
and skip validity (checked on commit, per new face); tessellation is per
new face at preview quality; naming costs 2–13 ms (12–90 ms for the
label).

Node, medians of 3 runs, host shared with other agents (± 30 %); ms:

| Step                                   | Before: wall (UI / kernel / feature) | After: wall (UI / kernel / feature) |
| -------------------------------------- | -----------------------------------: | ----------------------------------: |
| (a) select the lid top face            |                1 584 (1 584 / – / –) |                   8.8 (8.7 / – / –) |
| (a) place text "HC" (solved)           |                    1.8 (0.3 / – / –) |                   1.9 (0.3 / – / –) |
| (a) leave the sketch (Esc)             |                  895 (893 / 0.4 / –) |                 7.6 (4.8 / 0.4 / –) |
| (a) select profile + face              |                1 288 (1 288 / – / –) |                 10.7 (10.5 / – / –) |
| (a) Emboss tool, first preview (+1 mm) |            1 805 (1 545 / 321 / 263) |               170 (0.4 / 169 / 113) |
| (a) Engrave preview (−1 mm)            |            1 692 (1 410 / 287 / 230) |               301 (0.4 / 299 / 170) |
| (a) Engrave commit (validity 27 → 23)  |                357 (0.2 / 356 / 231) |               236 (0.2 / 236 / 115) |
| (a2) 11-glyph label, Emboss preview    |        5 662 (3 221 / 2 823 / 2 552) |               900 (0.4 / 900 / 714) |
| (a2) 11-glyph label, Engrave preview   |        6 065 (3 861 / 2 227 / 1 975) |               850 (0.4 / 849 / 683) |
| (a2) 11-glyph label, Engrave commit    |          2 542 (0.3 / 2 541 / 2 118) |           1 322 (0.4 / 1 321 / 890) |
| (b) select the floor face              |                    604 (604 / – / –) |                   1.6 (1.6 / – / –) |
| (b) Hole tool, first preview           |                  591 (554 / 38 / 27) |                  39 (0.7 / 38 / 24) |
| (b) M4 / counterbore preview           |            590 / 581 (553 / 37 / 24) |             36 / 38 (0.4 / 35 / 25) |
| (b) Hole commit (cached tail)          |                                  1.4 |                                 0.9 |
| (c) fillet drag step (×10)             |             21.4 (0.2 / 20.9 / 14.9) |            15.6 (0.2 / 15.1 / 10.8) |
| (d) 60-entity drag step (×30; solver)  |                            1.3 (0.9) |                           1.2 (0.8) |

Browser (Chromium dev build, workers), response latency (UI long tasks),
one warm run each, same session order; ms:

| Step                                        |          Before |        After |
| ------------------------------------------- | --------------: | -----------: |
| (a) select the lid top face                 |   2 005 (2 009) |       25 (0) |
| (a) K: Text tool on the face                |   2 278 (2 261) |      90 (72) |
| (a) place text "HC" (Enter → solved, drawn) |       162 (111) |       64 (0) |
| (a) leave the sketch (Esc)                  |   1 465 (1 126) |      246 (0) |
| (a) select profile + face                   |   1 570 (1 567) |       27 (0) |
| (a) Ctrl+F "Emboss" Enter → first preview   | 24 388 (23 651) |      521 (0) |
| (a) Engrave preview (kernel 302 → 175)      |         332 (0) |      221 (0) |
| (a) Engrave commit (speculative, kernel ~1) |          53 (0) |       74 (0) |
| (b) select the floor face                   |       698 (696) |       19 (0) |
| (b) Ctrl+F "Hole" Enter → first preview     |   7 915 (7 674) |     311 (69) |
| (b) size M4 (menu + option) / counterbore   |    359 / 92 (0) | 353 / 85 (0) |
| (b) Hole commit                             |          49 (0) |       68 (0) |
| (c) fillet drag step (kernel 14 → 13)       |          62 (0) |       30 (0) |
| (d) 60-entity drag step                     |        19.8 (0) |     13.1 (0) |

Targets on this host: text placement < 300 ms — **met** (64 ms from
Enter; the whole face → K → click → type → Enter flow has no step above
120 ms); engrave preview < 500 ms — **met** for "HC" (221 ms browser, 301
ms Node) but **not for long labels** (11 glyphs: 850 ms Node — the OCCT
boolean of many B-spline side faces; halved, not solved); engrave commit
< 1.5 s — **met** (74 ms browser with the worker's speculative commit,
236 ms Node; the 11-glyph label 1.3 s); hole preview < 300 ms and commit
< 1 s — **met** (85 ms / 68 ms; Node 36–39 ms kernel); fillet drag
preview < 150 ms — **met** (30 ms browser, 16 ms Node); 60-entity drag <
30 ms per solve — **met** (13 ms input → frame, 0.8 ms solve). Steps that
start a tool through the command search include typing the command name.

`bench:kernel` (its parts contain no emboss and no main-thread code),
three alternating runs before (159fe7c) / after, host loaded by other
agents: demo full eval 100–174 / 101–145 ms, edit #2 68–197 / 82–146,
last-feature edit 21–46 / 23–36, preview 24–93 / 23–64; 60-feature plate
last-feature edit 51–86 / 55–163, preview 54–56 / 56–137 — ranges
overlap, no regression beyond noise.

Memory: the 500-edit leak session is unchanged (wasm heap 100 → 595 MB,
caches 55 MB). Repeated Emboss previews of the 11-glyph label grow the
heap ~8 MB each (was ~15 MB: one boolean instead of eleven) — OCCT's own
per-boolean leakage on B-spline faces; the adapters' 1 GiB recycling
still applies (~100 label previews per recycle).

Found for the UI lane: right after a click in the viewport, the first click
on the Hole tool's size menu button did not open it. Cause: the click had
opened the hole's value chip, and the menu's mousedown blurred it, which
committed the unchanged value — the size became "custom", the tool pill
re-laid out and the button moved ~240 px before the mouseup. Fixed in the
integration (2026-09-30): a field opened by a click and left untouched
commits nothing (`viewport/DimensionLabel.tsx`); the harness now clicks once
and fails if the menu does not open.

## Open risks

- ~~Full replay per change~~ — solved 2026-09-29 by the prefix cache (see
  above). An edit early in a long history still replays everything after it.
- **Hard cancel = worker restart** (~0.4 s reload); OCCT operations cannot be
  interrupted inside a single-threaded wasm call. A restart drops the prefix
  and mesh caches: the next edit replays the whole document.
- **Packaged Electron is unverified.** Dev Electron loads from the Vite
  server; a packaged `file://` renderer may not allow `fetch()` of the wasm
  or module workers — likely needs a privileged `app://` protocol. The asar
  layout must keep the two LGPL files replaceable.
- **Fillet/shell robustness** is OCCT's (not Parasolid's); failures surface as
  feature errors. Only the demo-level cases are tested.
- **Memory**: our side is deterministic now (arena + reference-counted
  checkpoints); OCCT itself still leaks a little per operation in this wasm
  build (see above) — handled by recycling the kernel at 1 GiB, not fixed.
  The checkpoint budget is an _estimate_ (6 KB per face), not a measurement.
- Kernel-in-browser ≠ final architecture: the Rust feature graph and agent
  API of `PLAN.md` §3/§5 do not exist yet; the feature list lives in the
  TypeScript store.

## What remains for Phase 1 (`PLAN.md` §6)

Save/Reopen (project file with feature list + schema version), 3MF/STL export
(the kernel can tessellate/export; a printer-grade 3MF writer is missing),
the agent command path (same commands via Python/automation), sketch
constraints/solver (`planeGCS` evaluation), ~~prefix-cached evaluation~~ (done), a
packaged-Electron check of the worker/wasm path, and the §7 acceptance parts
(enclosure with lid, bracket with slot, pipe adapter) as end-to-end tests.
