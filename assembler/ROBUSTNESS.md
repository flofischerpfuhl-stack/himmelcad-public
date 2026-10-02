# HimmelCAD Assembler — robustness

Status: 2026-09-30 (branch `asm/robust-20260930`, integrated in
`feat/assembler-phase0-20260929`; Block-6 additions: commit check for boolean
results, fuzzer coverage extension, findings F7–F9, see "Block 6"). Model-based
fuzzing of the agent API, a UI monkey test of the production app,
corrupted-file tests, the native-crash investigation of
`kernel/embossText.test.js`, and the fixes they led to. Everything here is
reproducible from the scripts named below.

## Model-based fuzzer (`pnpm --filter @himmelcad/assembler test:fuzz`)

Sources: `apps/assembler/test/fuzz/` — `ops.ts` (operations, generator,
seeded RNG), `harness.ts` (execution and invariants), `shrink.ts` (delta
debugging), `cli.ts` (budget runner), `reproducers.ts` +
`regressions.test.ts` (committed reproducers, part of `pnpm test`).

```text
pnpm --filter @himmelcad/assembler test:fuzz -- --seed 7 --minutes 20
  --steps 40            ops per sequence            --sequences N   stop after N sequences
  --shrink-minutes 5    ddmin budget per finding    --out <dir>     reproducer JSON (default <tmp>/assembler-fuzz)
  --replay <file.json>  run one reproducer          --verbose       log every step
```

Defaults: seed 1 (`ASSEMBLER_FUZZ_SEED`), 3 minutes (`ASSEMBLER_FUZZ_MINUTES`),
one worker (one process, one fuzzed kernel plus one reference kernel), on the
OCCT module `HIMMELCAD_OCCT` selects (the HimmelCAD build by default; before
Block 6 the harness always loaded replicad). Exit code 1 if any invariant
broke.

### Design

- **What runs.** The real stack in one Node process: the app store
  (`model/store.ts`), the canonical `AgentSession` (`hcasm.agent-api@1`,
  headless capabilities — exactly what the headless CLI and Python use), the
  planeGCS solver and the OCCT kernel through `InProcessKernelAdapter`. The
  kernel loader creates a **fresh OCCT instance on every (re)load** and the
  recycle threshold is lowered to 384 MB, so long runs go through the
  kernel restart policy (`kernel/adapter.ts`) for real — runs report the
  number of kernel loads.
- **Operations** (`ops.ts`, 38 kinds, weighted): sketches on planes and on
  body faces (rectangles, circles, polylines), `sketch.addProfile`,
  `setDimension` (values and parameter expressions), `addConstraint`,
  `addDimension`, `deleteItems`; extrude (new/join/cut, symmetric, region
  subsets, `distanceExpression`), push/pull, revolve (world axes, offset
  origins, partial angles), fillet/chamfer (selectors and single edge keys),
  shell (in/out), boolean (union/subtract/intersect, keep tools), linear and
  circular pattern, mirror, hole (simple/counterbore), emboss/engrave,
  move/rotate/copy; parameter create/edit/delete; `feature.edit`, suppress,
  delete, rename; History rollback and reorder through the store (the UI
  path: `setRollback`, `checkMove`/`moveFeature` + `commitDocumentChange`);
  undo/redo; transactions begin/preview/commit/cancel; save → reopen.
  Block 6 added 13 kinds (51 in all): sweep (straight tilted path from the
  sketch origin, or another sketch's region outline), loft (two sketches'
  single regions, smooth/ruled), draft (planar/cylindrical face, neutral
  face or plane), rib (open sketch lines, `openPolyline`), thicken (faces or
  a profile, outside/inside/both, New/Join/Cut), sketch text
  (`sketch.addText`, several strings/angles), construction planes (offset,
  angle, midplane, three points) and sketches on them, extrude extents
  (Through All, To Object face/body, two sides, start offset), and
  STEP/IGES/DXF export → import round trips; `feature.edit` also varies
  draft angles, thicken/rib thickness and sweep/loft operations. Block 8
  (model stream) added 7 kinds (58 in all): primitives (on the grid or a
  planar face, Join/Cut into it), Scale (uniform/per axis, copies),
  Translate, Move Edge, Move Face, helical revolves (≤ 2 turns) and tapered
  extrudes (one side, symmetric, two sides); the integration added 5 more (63):
  two-direction/uniform patterns, split by a sketch profile, reference images
  (insert + calibrate; save/reopen compares the stored pictures), sketch
  patterns in two directions (edited afterwards) and sketch offsets.
- **State-independent ops.** An op is `{op, r: [8 numbers in 0..1]}`; the
  numbers are resolved against the document _when the op runs_ ("the n-th
  body", "a planar face of it", "a size between a and b"). An op with
  nothing to act on is skipped. So every subsequence of a sequence is
  runnable — the precondition for delta debugging — and a sequence is fully
  determined by `sequenceSeed(seed, index)`.
- **Invariants after every step** (ids as used in reproducers):

  | Invariant       | Check                                                                                                                                                                                                                                                                                               |
  | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `exception`     | No uncaught exception or unhandled rejection; no `internal`/`busy` API error; no non-`ApiError` throw. Refusals (`invalidParams`, `featureFailed`, `sketchConflict`, `conflict`, …) are legitimate.                                                                                                 |
  | `refusalTrace`  | A refused write leaves features and parameters untouched (same array identity).                                                                                                                                                                                                                     |
  | `uniqueIds`     | Feature ids are unique.                                                                                                                                                                                                                                                                             |
  | `silentInvalid` | Every body is a valid B-rep, or a feature reports an error or warning — never an invalid body silently.                                                                                                                                                                                             |
  | `namedErrors`   | Every error is a readable message on an existing feature (not a number, `undefined`, `[object …]`); a step reading a sketch that is gone or later in the history reports an error.                                                                                                                  |
  | `undoRedo`      | After every committed write: undo then redo gives the identical document (features, parameters) and the identical evaluation (errors, warnings, body ids/names/validity, volumes to 9 digits, bounding boxes, sorted face and edge keys).                                                           |
  | `saveReopen`    | After every change: `project.save` → `loadProjectFile` gives the identical document; the `saveReopen` op additionally reopens (`project.open`) and compares the evaluation with a cold evaluation of the saved document.                                                                            |
  | `cancelTrace`   | `transaction.cancel` leaves the document exactly as at `begin` (array identity, parameters, revision); a UI edit made meanwhile is the user's and moves the baseline.                                                                                                                               |
  | `determinism`   | After every change the committed (incremental, cached) evaluation equals a **cold evaluation on a separate, fresh OCCT instance** with empty caches (both kernels run in their own worker threads since Block 7, `headless/threadKernel.ts`).                                                       |
  | `heap`          | The fuzzed kernel's wasm heap stays below 1.5 GB (recycling happens at 384 MB).                                                                                                                                                                                                                     |
  | `arenaOrder`    | No OCCT object arena was closed out of order (`kernel/occtArena.ts`, see "Native crash").                                                                                                                                                                                                           |
  | `roundTrip`     | STEP/IGES export → import of valid solids keeps their total volume (1e-3 relative); DXF export → import of a sketch keeps its regions' total area (not for approximated curves or sketches with text, see D1).                                                                                      |
  | `kernelTimeout` | No kernel job (fuzzed write, export, cold evaluation) runs longer than the fuzz budget (20 s, `ASSEMBLER_FUZZ_KERNEL_TIMEOUT_MS`) without progress; a job that does is stopped by the kernel thread and recorded as a finding (F13 class) — reported, written as a reproducer, not failing the run. |

- **Kernel-marginal differences.** OCCT's result for marginal geometry can
  depend on the wasm heap layout (finding F3). When the incremental and the
  cold evaluation differ, the harness re-runs the cold evaluation in up to 16
  other heap states (a few small OCCT allocations before each run), then once
  with a fresh evaluator (empty caches) on the fuzzed kernel's own, long-lived
  OCCT instance. If one of them reproduces the incremental result, two cold
  evaluations of the same document disagree — the difference is the kernel's,
  not a cache bug: it is reported as `MARGINAL` (counted, not failed). A cache
  bug gives the same cold result every time and still fails. (The second
  test was added after F6, so final run A predates it.)
- **Shrinking.** A failing sequence is cut after the failing step, replayed
  (must reproduce the same invariant), then reduced with ddmin (subsets, then
  complements, doubling granularity) within `--shrink-minutes`. The minimal
  sequence is replayed once more and written as JSON with the resolved calls
  (`calls`: `ok feature.create {...}`, `refused … — featureFailed: …`).
- **Regression tests.** Minimal reproducers are committed in
  `test/fuzz/reproducers.ts` (`REPRODUCERS` must replay clean,
  `MARGINAL_REPRODUCERS` must keep every other invariant) and replayed by
  `test/fuzz/regressions.test.ts` in `pnpm test`, together with direct
  assertions of the fixed behaviour and a short deterministic fuzz smoke
  (seed 20260930, 2 × 25 ops).

### Findings

| #   | Invariant       | Minimal sequence (reproducer)                                                                                                                                                                                                                                                                  | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | --- | ----------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| F1  | `silentInvalid` | Circle r 3 extruded 16.5 symmetric; chamfer 4.8 on its circular edges (`silentInvalid-s1-q10`, 3 ops). Also: joined L-extrusions, fillet r 3.2 on the top edges (`-q7`, 9 ops).                                                                                                                | OCCT's blend builder returns a self-intersecting solid instead of failing when a plain chamfer/fillet does not fit a neighbouring face. The evaluator B-rep-checked only variable fillets and asymmetric chamfers, so the API committed an invalid body without an error.                                                                                                                                                                                                       | Every blend result is checked (`BRepCheck_Analyzer`) and refused: "Chamfer failed: the distance does not fit the faces next to the edge; try a smaller value" (`kernel/evaluator.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F2  | `silentInvalid` | YZ rectangle at x = 9.5 (z −7.5…6.5), revolve 340° about a Y axis through x = 23 (`-q14`, 2 ops).                                                                                                                                                                                              | The axis check only covered axes in the sketch plane. An axis parallel (or oblique) to the plane that passes over the profile sweeps part of the profile back through itself: invalid body, no error.                                                                                                                                                                                                                                                                           | General criterion: the profile's normal velocity `(p − a) · (n × d)` must not change sign over the profile; else "The profile would revolve through itself (the axis passes over it)…" (`kernel/features/profileSolids.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| —   | (safety net)    | —                                                                                                                                                                                                                                                                                              | Any other operation that yields an invalid solid would still be silent.                                                                                                                                                                                                                                                                                                                                                                                                         | The evaluator attaches a warning to the step that last changed an invalid body: "\"Body 1\" is not a valid solid after this step (self-intersecting, open or non-manifold); it may not export or print correctly".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| F3  | `determinism`   | Disc r 7 × 4, linear pattern, shell 2.6 (open end), emboss on a copy, polyline, shell 0.7 of the shell's inner face (`determinism-s1-q28`, 9 ops).                                                                                                                                             | **OCCT itself**: the same cold evaluation of this document fails in 3 of 24 wasm heap states (a few unrelated `gp_Pnt` allocations before it) — OCCT containers hashed by address make marginal operations (a 0.7 mm wall that barely fits) layout dependent. Not a cache bug: every other perturbation tried (clearing single evaluator caches, shelling a deep copy of the input, one extra validity check) flipped the result as well.                                       | Not fixable in this layer. Documented; the fuzzer classifies such differences as marginal (see Design). Kept as `MARGINAL_REPRODUCERS`. User-visible risk: see "Open risks".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| F4  | `determinism`   | Plate, through hole Ø1.4, circle sketched on a side face, cut 5.5 (`determinism-s1-q281`, 5 ops).                                                                                                                                                                                              | Body validity depended on how it was evaluated: the incremental check (`faces`/`closure` modes, `kernel/faceProps.ts`) rejects an edge shared by three faces, the full `BRepCheck_Analyzer` accepts it. The same body was "not a valid solid" while editing and valid after a reopen. The closure test also wrongly rejected degenerated edges (blend corners, sphere poles).                                                                                                   | One rule for all modes: full = `BRepCheck_Analyzer` **and** the closure/manifold test; degenerated edges pass. A box with all edges filleted no longer turns invalid after a later edit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| F5  | (corruption)    | A `.hcasm` whose extrude `profile` is nested 100 000 levels deep.                                                                                                                                                                                                                              | The recursive validators overflowed the stack: `RangeError: Maximum call stack size exceeded` escaped `loadProjectFile` (agent API: a non-API error; app: an unhelpful message).                                                                                                                                                                                                                                                                                                | `loadProjectFile` measures the nesting depth iteratively first and refuses more than 64 levels with a `ProjectFormatError` (`model/project/format.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| F6  | `determinism`   | Circle revolved about the X axis beside its XZ plane (a ring), suppress + undo, a cylinder cut through the ring (`determinism-s101-q434`, 6 ops).                                                                                                                                              | Same class as F3, in a boolean: after ~430 sequences in one process the cut was a no-op in the incremental evaluation and an invalid, inside-out result (−10 298 mm³) in the cold one; in fresh processes the minimal sequence replays clean 3/3 (both evaluations give the invalid result, with the safety-net warning). None of the 16 perturbed cold runs hit the no-op outcome.                                                                                             | No product change. Classifier extended (cold evaluation on the fuzzed instance, see Design); kept as `MARGINAL_REPRODUCERS`. The invalid cut result itself is committed with a warning only (open risk).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| H1  | `cancelTrace`   | Transaction begin, a History reorder in the UI, transaction cancel (`cancelTrace-s2-q330`, 7 ops).                                                                                                                                                                                             | Harness bug: the user's own reorder during an agent transaction is not the transaction's to undo (a commit would report `conflict`, as designed).                                                                                                                                                                                                                                                                                                                               | The harness moves the cancel baseline with UI edits; reproducer kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F7  | `exception`     | Plate, its sketch deleted (the extrude now fails with "Missing reference"), `export.step`/`export.iges` of another body (first Block-6 run, seeds 404/505, three sequences; hand test `F7` in `regressions.test.ts`).                                                                          | Exact exports replay the document and refuse it when a step fails — correct — but the API reported that as `internal` ("STEP export failed: Cannot export: Missing reference: sketch "feature-sketch-1"", with an internal id).                                                                                                                                                                                                                                                 | `featureFailed` "STEP export needs every step to evaluate: "Extrude 1" fails: Missing reference: sketch of a deleted step" with a hint (`api/session.ts#exportFailure`, `kernel/evaluator.ts`); also for meshes at a resolution preset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| F8  | `exception`     | Circle r 11 extruded 10, the same sketch cut 17.5 into it, `export.iges` (brep) (`exception-s404-q32`, 4 ops).                                                                                                                                                                                 | The cut removed the whole body and left an **empty** shape (0 mm³, no faces) that every validity check accepted: committed silently; IGES (MSBO) then failed with "OCCT could not convert a body".                                                                                                                                                                                                                                                                              | Every Cut through `combine` (extrude, revolve/sweep/loft/thicken/rib, hole, emboss) refuses an empty result: "Cut: nothing of "Body 1" would remain; make the cut smaller or delete the body instead" (`kernel/evaluator.ts`, `occt.ts#hasFaces`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| F9  | `heap`          | Rectangle + text "HC" (6.5 mm) on XZ, `export.dxf` R12 → `import.dxf` (`heap-s505-q110`, 3 ops).                                                                                                                                                                                               | The R12 writer flattened splines with 64 pieces per knot span: each glyph outline became ~3 900 vertices (515 kB DXF); importing it built a sketch of 7 812 lines — 17.5 s and **1.6 GB** of wasm heap for one evaluation. The same growth in the long-lived reference instance is the likely cause of a `memory access out of bounds` there (s404 run 1, not reproducible after the fix).                                                                                      | Adaptive flattening within max(1 µm, 1e-5 × drawing size) (`interop/dxf.ts#flattenEntity`): 336 vertices, 23 kB, import 0.17 s, heap 100 MB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| F10 | `roundTrip`     | Two boxes touching on their sketch plane, one filleted, IGES (surfaces) export → import (`roundTrip-s505-q133`, 5 ops): 2 827 mm³ → one body of −267 mm³.                                                                                                                                      | The importer sews all loose IGES faces together; faces of two touching bodies closed into one **inside-out** shell. `BRepCheck_Analyzer` and the closure test accept an inside-out closed shell, so the body showed as a valid solid with a negative volume.                                                                                                                                                                                                                    | Validity now also requires a positive volume (`kernel/evaluator.ts#solidVolume`: inside-out and empty shapes are not valid solids), and the IGES import warns "1 imported solid is not valid (inside out): surfaces of touching or overlapping bodies were sewn together; export such parts as IGES solids (MSBO) or STEP". Sewing per body is not possible from a surfaces-only IGES (no grouping); open risk.                                                                                                                                                                                                                                                                                                                                                                                                            |
| F11 | `determinism`   | A tube (thicken of a cylinder face) and a later cut that misses it, after an earlier sketch edit (`determinism-s404-q42`, 37 ops).                                                                                                                                                             | Same class as F3: the same (no-op) cut builds different topology depending on whether its input came from a checkpoint (a planar end face keeps a slit edge twice → closed) or from the same replay (once → open edge). A fresh evaluator reaching the document in the session's order reproduces the session's result; volumes identical.                                                                                                                                      | No product change (OCCT `SimplifyResult`/`UnifySameDomain` result); the classifier also tries "the steps before the last one, then the last one" on a fresh evaluator and records agreement as marginal; kept as `MARGINAL_REPRODUCERS`. Also found with it: final evaluations now run the full check on bodies whose last boolean step was re-evaluated (not only on a first evaluation), so the incremental and cold results agree whenever OCCT built the same topology.                                                                                                                                                                                                                                                                                                                                                |     | F12 | `roundTrip` | Plate with a draft, History rolled back before the draft, IGES export → import (`roundTrip-s707-q24`, 5 ops): 2 400 → 1 984 mm³. | Exact exports (STEP, IGES, meshes at a resolution preset) replayed the **whole** History, while the bodies offered for export, `bodies.list`, the viewport and the display-mesh STL/3MF showed the steps above the rollback bar: a rolled-back export silently contained the rolled-back steps. | Every export uses the steps the viewport shows (`model/store.ts#shownFeatures`: File › Export STEP/IGES, the 3D-print export, `export.*` via the API's active features). Test `F12` (STEP, both modules). |     | F13 | (hang) | Default `test:fuzz` (seed 1), sequence 29, step 24: fillet r 0.7 on the `>Z` edges of a loft between a YZ and an XZ rectangle (`{"edges":[{"bodyId":"body:feature-loft-7","select":">Z"}],"radius":0.7}`; ops 0–24 of `generateSequence(sequenceSeed(1, 29), 40)`). | **OCCT** (`BRepFilletAPI_MakeFillet`) does not return — > 12 min at 100 % of one core, on both modules. The in-process kernel (headless CLI, agent API over stdio, this harness) could not interrupt wasm. | Fixed (Block 7): the headless CLI and the fuzzer run OCCT in a Node worker thread (`headless/threadKernel.ts`, the app's `WorkerKernelAdapter` with a **time budget**: `HIMMELCAD_KERNEL_TIMEOUT_MS`, default 120 s per job without progress; fuzzer 20 s). A job over budget is stopped (thread terminated and restarted), the agent API answers `kernelTimeout` (JSON-RPC −32016, `details.committed: false`, Python `KernelTimeoutError`), the document is unchanged. The fuzzer records it as finding class `kernelTimeout` (shrunk to 4 ops: two sketches, loft, fillet r 0.7, `kernelTimeout-s1-q29`) without failing the run; seed 1 completes (30 sequences, 414 s). Test `F13` in `test/kernel/kernelTimeout.test.ts`. The fillet itself remains an OCCT limit. |     | D1  | `roundTrip` | Rectangle + text "Ag 1", `export.dxf` → `import.dxf` (`roundTrip-s505-q19`, 3 ops): 4 regions / 22.62 mm² → 6 / 23.69 mm². | By design: DXF carries glyph outlines as plain curves; on import the counters of "A" and "g" are regions of their own (sketch text keeps them as holes). The extra 1.06 mm² are the two counters. | No product change; documented (`INTEROP.md`); the invariant skips sketches with text. |
| F14 | `roundTrip`     | Rectangle + text "O-ring" on YZ, revolved 360° about Z, IGES (surfaces) export → import (`roundTrip-s1-q0`, 4 ops; found by the Block 9 parity gate, reproducible on 1454170f; replay `D:\AgentWork\HimmelCAD-Assembler\shots\block9-parity\gates\roundTrip-s1-q0.json`): 14 600 → 15 571 mm³. | Two importer defects (ours) and one OCCT limitation: (1) every closed shell became a solid of its own, so the closed voids of the "g" and "O" came back as solids (the void volume counted twice); (2) faces the sewing left outside any shell were dropped silently (a face is not a `Shape3D`); (3) **OCCT**: a face closed in both directions (the "O"'s two torus-like faces, bounded by seams only) loses its boundary in the IGES exchange and reads back with zero area. | (1) `nestCavities` (`geometry-kernel/igesExchange.ts`): a closed shell inside another (one vertex classified with `BRepExtrema_DistShapeShape.InnerSolution`) becomes an inner, reversed shell of the smallest one around it (even/odd nesting); (2) left-over faces are wrapped in single-face shells, closed ones become solids, open ones surface bodies (warning); (3) faces without area are skipped with the warning "… surfaces have no extent in the IGES file and were skipped …; export such parts as IGES solids (MSBO) or STEP" (MSBO: 14 590 mm³, within 1e-3). The harness accepts this reported loss; hand test `F14` (a cube with a closed void keeps 7 000 mm³ as one body). Open: (3) needs closed faces split before an IGES surfaces export (`ShapeUpgrade_ShapeDivideClosed`, not in the OCCT build). |
| H2  | `exception`     | `sketch.addText` in the harness (first Block-6 run, seeds 404 q50 and 505 q71).                                                                                                                                                                                                                | Harness bug: no font loader installed in the fuzzer process (the app and the headless CLI install one).                                                                                                                                                                                                                                                                                                                                                                         | The harness installs the bundled Inter font like the headless CLI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Budget runs (Windows host, one worker; Block-6 runs: two workers in parallel, no other agents)

| Run         | Code                                                 | Seed     | Minutes   | Sequences | Steps  | Committed | Refused | Max heap | Kernel loads | Result                                                                         |
| ----------- | ---------------------------------------------------- | -------- | --------- | --------- | ------ | --------- | ------- | -------- | ------------ | ------------------------------------------------------------------------------ |
| exploratory | before fixes                                         | 1        | 10        | 16        | 592    | 223       | 87      | 127 MB   | 2            | F1 (2 sequences), F2 (2 sequences)                                             |
| 1           | F1/F2 fixed                                          | 1        | 20        | 287       | 11 435 | 4 163     | 1 925   | 456 MB   | 8            | F3, F4                                                                         |
| 2           | F3/F4 fixed                                          | 2        | 20        | 375       | 14 993 | 5 878     | 2 565   | 533 MB   | 13           | H1                                                                             |
| final A     | + arena, H1                                          | 101      | 20        | 435       | 17 387 | 6 623     | 3 062   | 533 MB   | 15           | F6 (F3 class, not a product bug)                                               |
| final B     | + arena, H1                                          | 202      | 20        | 587       | 23 462 | 8 415     | 4 014   | 758 MB   | 18           | clean                                                                          |
| final C     | + F6 classifier                                      | 303      | 20        | 569       | 22 749 | 8 626     | 3 909   | 894 MB   | 15           | clean                                                                          |
| B6 pre      | merge + commit check (HimmelCAD module from here on) | 404, 505 | (aborted) | —         | —      | —         | —       | —        | —            | F7 (3 sequences), H2                                                           |
| B6 1        | + F7, H2                                             | 404      | 15        | 43        | 1 701  | 645       | 248     | 1 073 MB | 13           | F8; `memory access out of bounds` in the reference instance (F9's heap growth) |
| B6 1        | + F7, H2                                             | 505      | 15        | 129       | 5 136  | 1 856     | 826     | 496 MB   | 23           | D1 (by design), F9                                                             |
| B6 2        | + F8, F9, D1                                         | 404      | 15        | 63        | 2 510  | 988       | 370     | 1 073 MB | 16           | F11 (F3 class, classified)                                                     |
| B6 2        | + F8, F9, D1                                         | 505      | 15        | 168       | 6 679  | 2 331     | 1 070   | 496 MB   | 18           | F10                                                                            |
| B6 3        | + F10, F11                                           | 606      | 15        | 112       | 4 469  | 1 620     | 753     | 496 MB   | 11           | clean                                                                          |
| B6 3        | + F10, F11                                           | 707      | 15        | 70        | 2 780  | 1 052     | 484     | 430 MB   | 5            | F12                                                                            |
| B6 final    | + F12                                                | 808      | 15        | 26        | 1 035  | 407       | 171     | 595 MB   | 5            | clean                                                                          |
| B6 final    | + F12                                                | 909      | 15        | 149       | 5 957  | 1 929     | 904     | 496 MB   | 11           | clean                                                                          |

## Block 6 (integration, 2026-09-30)

**Commit check for boolean results.** Blends (F1) and revolves (F2) already
refused invalid results; a Join/Cut or a Boolean still committed an invalid
solid with only the safety-net warning (F6, and — found while writing the
hand case — two cubes joined along one edge: a non-manifold edge shared by
four faces). Now every commit of a feature whose result is a boolean of
solids (`model/document.ts#isBooleanResult`: the Boolean feature,
Join/Cut/Intersect of extrude, revolve, sweep, loft and thicken, push/pull,
hole, emboss/engrave, rib) is evaluated with `EvaluationRequest.commitCheck`
= the committed feature ids: the body that feature last changed gets the
full check (`BRepCheck_Analyzer` + the closure/manifold test, cached per
shape) and an invalid one becomes the feature's **error** — "Union failed:
the result is not a valid solid (self-intersecting, non-manifold, open or
inside out); nothing was changed. Try other values or references". The
agent API passes the written features (`feature.create`/`edit`, also inside
transactions) and so returns `featureFailed` with `committed: false`; the UI
tools (Extrude/push-pull, Boolean, the feature tools) run the same check
when Done is pressed, before anything is committed — an invalid result keeps
the tool open with the message (Done stays blocked until a parameter
changes), a valid one is committed with that evaluation (no second
evaluation). Previews keep the cheap check. Two related rules came out of the
fuzz runs below: a final (non-preview) evaluation runs the same full check on
every body whose last boolean step was re-evaluated in it (an edit of an
earlier step: the result is flagged with the safety-net warning, as a cold
evaluation would; F11), and a valid solid needs a positive volume (inside-out
shells and empty shapes pass `BRepCheck_Analyzer` and the closure test; F8,
F10).

Evidence (`test/fuzz/regressions.test.ts`, both modules): the F6 reproducer
(no invalid body remains; the cut is refused in the heap states where it
used to be inside out: fresh process, both modules); hand cases — cubes
touching along an edge: Join refused ("Extrude failed: …"), Union refused,
both bodies unchanged (1 000 mm³ each), an overlapping union still commits
(1 750 mm³, valid); the Boolean tool in the store: Done refused, tool open
with the message, features unchanged.

Commit-time cost (HimmelCAD module; `bench:interactive --browser` and
`bench:kernel`, 6 fresh processes each, before = the A/B series, after = the
final code of this block; medians, ms): engrave "HC" commit 216 → 219, label
"HIMMELCAD 26" commit 971 → 965, hole commit 1.6 → 1.7 (Node; validity phase
21 → 21 and 91 → 90: those bodies were freshly built, so the final
evaluation had already run the full check and the commit check reuses it);
browser engrave commit 103 (47–213) → 69 (38–239) — bimodal in both series
(a commit either re-evaluates, ~185 ms kernel, or reuses a checkpoint,
~1 ms), browser hole commit 42.8 → 35.4. Previews unchanged (engrave, hole,
fillet drag, sketch drag within ±6 %, all inside the run-to-run spread).
Where the incremental check had covered only new faces the full check is real
work: committing the bench's preview feature (a cut) on the 60-feature plate
84 → 115 ms (+31 ms; demo bracket and features part ±1 ms), and
`bench:kernel`'s demo-bracket last-feature edit (a re-evaluated cut) 25.4 →
28.8 ms (+3.4 ms, the full check of the re-evaluated boolean); every other
`bench:kernel` median within −3…+4 %.

## Native crash (`kernel/embossText.test.js`)

Reported: one native access violation (0xC0000005) of that test file in a
full `pnpm test` run; it passed alone.

- **Not reproduced**: before any change 20/20 sequential runs and 21/21 runs
  three at a time (while a fuzz run loaded the host) passed; on the final
  code 20/20 sequential runs and the full suite 3 × (493/493 tests each, 84–91 s) passed. No
  `node.exe` crash is recorded in the Windows application event log of this
  host.
- **Concurrent test files sharing a module instance**: no — Node 22's test
  runner runs every file in its own child process; within a file tests run
  one after another.
- **wasm memory growth**: the file peaks at ~250 MB working set / ~350 MB
  private bytes and its wasm heap stays near 100 MB; far from any limit.
- **Use-after-delete of OCCT objects**: inside wasm this is sandboxed and
  surfaces as a `RuntimeError` or wrong geometry, not as a native access
  violation of the Node process. Checked in the emboss code: replicad's
  `translate` consumes (deletes) its input, but `section.face` is not used
  afterwards; raw handles deleted explicitly are never used again.
- **Hardening** (the one in-repo mechanism that could corrupt OCCT state
  across kernel users): OCCT object arenas (`kernel/occtArena.ts`) are a
  global stack. Two asynchronous users of one OCCT instance that interleave
  (A opens, awaits, B opens, A closes) made A's close delete B's objects
  while B still used them. `closeArena(token)` now closes exactly the arena
  `openArena` returned; an out-of-order close releases only its own objects,
  unlinks itself and is counted (`arenaInterleavings()`); the fuzzer fails on
  any (`arenaOrder`). Unit test: `test/kernel/occtArena.test.ts`. Objects
  created by one user while another user's arena is innermost are still
  recorded there — interleaving remains unsupported, it is now detectable.
- **Conclusion**: most likely a Node/V8-level fault under host load
  (three concurrent OCCT processes plus other agents); nothing in the
  application code reproduces it. If it recurs, capture a dump (Windows
  Error Reporting `LocalDumps` for `node.exe`) to see the faulting module.

## UI robustness

- **Monkey** (`pnpm test:monkey`, `test/electron/monkey.test.ts`): the
  production app (`ASSEMBLER_FORCE_PRODUCTION=1`) gets seeded random input
  for `ASSEMBLER_MONKEY_MINUTES` (default 5): clicks anywhere (10 % right
  clicks), clicks on visible controls (buttons, menu items, tabs, inputs),
  shortcut keys and letters, typed values (`1e999`, `NaN`, `1/0`, …),
  drags (left and middle), wheel turns. Monitored: `pageerror` (uncaught
  exceptions and unhandled rejections in the renderer), renderer crash, app
  exit, kernel status ("failed"/"keeps crashing"). Every 40 actions an
  Escape ladder (up to 6 × Esc) must return to idle: no tool session pill,
  no sketch mode, no visible dialog, menu or listbox. Native dialogs are
  stubbed to "cancel" and the slicer hand-off is stubbed; keys that reload,
  quit or open DevTools are not pressed. A report (`monkey-seed<N>.json`,
  last 60 actions) and a screenshot are written to `ASSEMBLER_MONKEY_OUT`.
  Results (production build of this branch):

  | Seed | Minutes | Actions | Esc ladders | Open when a ladder started                                   | Result                           |
  | ---- | ------- | ------- | ----------- | ------------------------------------------------------------ | -------------------------------- |
  | 1    | 5       | 2 647   | 66          | (not recorded in that run)                                   | no errors, always idle after Esc |
  | 2    | 5       | 3 296   | 82          | sketch mode 58, dialog 18, tool session 9, menu 5, listbox 1 | no errors, always idle after Esc |

- **Corrupted files** — unit level (`test/model/project/corruption.test.ts`,
  `pnpm test`): empty, whitespace, truncated (half, one byte), garbled
  bytes, a BOM before garbage, other JSON values, another format, a future
  schema, NaN, ±Infinity (`1e999`), `features` not an array, an unknown
  feature kind, duplicate ids, 100 000-level nesting inside a feature and as
  the whole file → each a readable `ProjectFormatError`; through the agent
  API `invalidParams` with the open document untouched (same arrays, name,
  revision: no partial load). Huge finite numbers (1e6 … `Number.MAX_VALUE`)
  open and fail as named feature errors in bounded time.
  App level (`test/electron/corruptFiles.test.ts`, `test:electron`):
  truncated, garbled, NaN, Infinity, deeply nested and empty files opened
  with Ctrl+O in the production editor each show an error toast, leave the
  open project and its History unchanged and raise no renderer error; a
  corrupt file on the command line starts the app with a visible error.

## Small bugs fixed alongside

- Sketch mode showed "Fully constrained" on entering an existing sketch
  while the constraint analysis was still running (`dof` started at 0). It
  is `null` until the analysis reports; the status reads "Analyzing
  constraints…" (`sketch/session.ts`, `sketch/ui/SketchChrome.tsx`; test in
  `test/sketch/session.test.ts`).
- Project load errors only showed on the Home screen. A failed Open, Open
  Recent, drag and drop or template started from the editor now shows an
  error toast until dismissed (`chrome/NoticeToast.tsx`; covered by
  `test/electron/corruptFiles.test.ts`).
- Block 6: a file that fails to open is no longer added to Open Recent (the
  main process records a path after the renderer confirms the open,
  `recentFiles.confirmOpened`); the in-process kernel adapter's status
  texts were double-encoded UTF-8 ("Restarting CAD kernelâ€¦", now "…");
  the Vite dev server keeps one dependency cache per OCCT module (switching
  `HIMMELCAD_OCCT` reloaded open pages).

## Open risks

- **OCCT heap-layout dependence (F3).** For marginal geometry the same
  document can evaluate differently in two sessions (a shell or fillet that
  just fits may fail after a reopen, or the other way round). Deterministic
  for identical call sequences on a fresh instance, but not across cache
  histories. Mitigation would need OCCT-side determinism (e.g. a build with
  stable container hashing) — relevant to the custom OCCT wasm build lane.
- **Incremental validity** (`faces` mode) still checks only new faces plus
  closure; whole-solid self-intersections between old faces are found by
  the full check only (after a reopen or a first evaluation). The fuzzer's
  determinism check would report such a mismatch; none remained in the
  final budgets.
- **Invalid boolean results** (resolved at commit, Block 6): committing a
  feature whose result is a boolean of solids runs the full check on the
  committed body and refuses an invalid one (see "Block 6"). Residual: an
  edit of an _earlier_ step (a parameter, a sketch dimension, a reorder) that
  makes a later boolean invalid is detected (full check of re-evaluated
  boolean results) but only warns on that later step; booleans inside
  patterns/mirrors are not in the commit-check set.
- **IGES surfaces of touching bodies** (F10): a surfaces-only IGES has no
  body grouping, so the importer sews every loose face together; touching or
  overlapping bodies can close into one wrong solid. It is now flagged
  (invalid, warning); keeping them apart needs IGES solids (MSBO, the
  `brep` export mode) or STEP.
- **IGES surfaces of faces closed in both directions** (F14): a revolved
  circle or letter "O" (torus-like faces bounded by seams only) loses its
  boundary in OCCT's IGES exchange; the import skips such faces with a
  warning. Fix path: split closed faces before an IGES surfaces export
  (`ShapeUpgrade_ShapeDivideClosed`, to be bound in `vendor/occt-wasm`);
  until then MSBO (`brep`) or STEP keep them.
- **Kernel hangs** (F13): an OCCT operation that never returns (a fillet on
  an unusual loft) is bounded on the headless CLI and in the fuzzer by the
  kernel thread's time budget (`kernelTimeout`, kernel restarted). Still
  open: the app's Web Worker kernel has no budget (the user sees progress and
  can Cancel, which restarts the worker), and tests that use the in-process
  adapter (`test/kernel/nodeKernel.ts`) are not bounded.
- **OCCT topology depends on evaluation order** (F11, like F3): the same
  document can show a warning after a reopen and none while editing (or the
  reverse) for marginal booleans.
- **Interleaved OCCT users** are detected, not supported (see Native crash).
- **Fuzzer coverage gaps** (after Block 6; Block 8 added Move Face/Edge,
  Scale, Translate, primitives, helix and taper, the integration profile
  split, grid patterns, images, sketch patterns/offsets): no plane split/align/
  offsetFace/deleteFace ops, no sketch fillet/disconnect/unlink ops, no sketch spline/ellipse ops, no STL/3MF/OBJ import or
  mesh-to-solid, no concurrent UI tool sessions; the monkey test is random,
  not model-based, and does not check document invariants.
- **Large DXF imports**: F9's cause is fixed on the writer side, but a DXF
  from elsewhere with thousands of polyline vertices still becomes thousands
  of sketch lines (the import reports the count; the kernel handled 7 812 in
  17 s / 1.6 GB). A vertex budget or polyline-to-spline fitting on import
  would bound it.
- ~~**Recent files**: a file that fails to open is still added to Open
  Recent.~~ Fixed in Block 6: the main process records a path only after the
  renderer opened it (`recentFiles.confirmOpened`; `test:electron`
  `corruptFiles.test.ts` asserts it for Ctrl+O and a command-line file).
