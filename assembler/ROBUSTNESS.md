# HimmelCAD Assembler — robustness

Status: 2026-09-30 (branch `asm/robust-20260930`). Model-based fuzzing of the
agent API, a UI monkey test of the production app, corrupted-file tests, the
native-crash investigation of `kernel/embossText.test.js`, and the fixes they
led to. Everything here is reproducible from the scripts named below.

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
one worker (one process, one fuzzed kernel plus one reference kernel).
Exit code 1 if any invariant broke.

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
- **State-independent ops.** An op is `{op, r: [8 numbers in 0..1]}`; the
  numbers are resolved against the document _when the op runs_ ("the n-th
  body", "a planar face of it", "a size between a and b"). An op with
  nothing to act on is skipped. So every subsequence of a sequence is
  runnable — the precondition for delta debugging — and a sequence is fully
  determined by `sequenceSeed(seed, index)`.
- **Invariants after every step** (ids as used in reproducers):

  | Invariant       | Check                                                                                                                                                                                                                                                                                                            |
  | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `exception`     | No uncaught exception or unhandled rejection; no `internal`/`busy` API error; no non-`ApiError` throw. Refusals (`invalidParams`, `featureFailed`, `sketchConflict`, `conflict`, …) are legitimate.                                                                                                              |
  | `refusalTrace`  | A refused write leaves features and parameters untouched (same array identity).                                                                                                                                                                                                                                  |
  | `uniqueIds`     | Feature ids are unique.                                                                                                                                                                                                                                                                                          |
  | `silentInvalid` | Every body is a valid B-rep, or a feature reports an error or warning — never an invalid body silently.                                                                                                                                                                                                          |
  | `namedErrors`   | Every error is a readable message on an existing feature (not a number, `undefined`, `[object …]`); a step reading a sketch that is gone or later in the history reports an error.                                                                                                                               |
  | `undoRedo`      | After every committed write: undo then redo gives the identical document (features, parameters) and the identical evaluation (errors, warnings, body ids/names/validity, volumes to 9 digits, bounding boxes, sorted face and edge keys).                                                                        |
  | `saveReopen`    | After every change: `project.save` → `loadProjectFile` gives the identical document; the `saveReopen` op additionally reopens (`project.open`) and compares the evaluation with a cold evaluation of the saved document.                                                                                         |
  | `cancelTrace`   | `transaction.cancel` leaves the document exactly as at `begin` (array identity, parameters, revision); a UI edit made meanwhile is the user's and moves the baseline.                                                                                                                                            |
  | `determinism`   | After every change the committed (incremental, cached) evaluation equals a **cold evaluation on a separate, fresh OCCT instance** with empty caches. replicad keeps one global OCCT instance (`setOC`), so the reference instance is swapped in only while the store is settled and the fuzzed kernel is loaded. |
  | `heap`          | The fuzzed kernel's wasm heap stays below 1.5 GB (recycling happens at 384 MB).                                                                                                                                                                                                                                  |
  | `arenaOrder`    | No OCCT object arena was closed out of order (`kernel/occtArena.ts`, see "Native crash").                                                                                                                                                                                                                        |

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

| #   | Invariant       | Minimal sequence (reproducer)                                                                                                                                                   | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                                | Fix                                                                                                                                                                                                                          |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `silentInvalid` | Circle r 3 extruded 16.5 symmetric; chamfer 4.8 on its circular edges (`silentInvalid-s1-q10`, 3 ops). Also: joined L-extrusions, fillet r 3.2 on the top edges (`-q7`, 9 ops). | OCCT's blend builder returns a self-intersecting solid instead of failing when a plain chamfer/fillet does not fit a neighbouring face. The evaluator B-rep-checked only variable fillets and asymmetric chamfers, so the API committed an invalid body without an error.                                                                                                                                                                 | Every blend result is checked (`BRepCheck_Analyzer`) and refused: "Chamfer failed: the distance does not fit the faces next to the edge; try a smaller value" (`kernel/evaluator.ts`).                                       |
| F2  | `silentInvalid` | YZ rectangle at x = 9.5 (z −7.5…6.5), revolve 340° about a Y axis through x = 23 (`-q14`, 2 ops).                                                                               | The axis check only covered axes in the sketch plane. An axis parallel (or oblique) to the plane that passes over the profile sweeps part of the profile back through itself: invalid body, no error.                                                                                                                                                                                                                                     | General criterion: the profile's normal velocity `(p − a) · (n × d)` must not change sign over the profile; else "The profile would revolve through itself (the axis passes over it)…" (`kernel/features/profileSolids.ts`). |
| —   | (safety net)    | —                                                                                                                                                                               | Any other operation that yields an invalid solid would still be silent.                                                                                                                                                                                                                                                                                                                                                                   | The evaluator attaches a warning to the step that last changed an invalid body: "\"Body 1\" is not a valid solid after this step (self-intersecting, open or non-manifold); it may not export or print correctly".           |
| F3  | `determinism`   | Disc r 7 × 4, linear pattern, shell 2.6 (open end), emboss on a copy, polyline, shell 0.7 of the shell's inner face (`determinism-s1-q28`, 9 ops).                              | **OCCT itself**: the same cold evaluation of this document fails in 3 of 24 wasm heap states (a few unrelated `gp_Pnt` allocations before it) — OCCT containers hashed by address make marginal operations (a 0.7 mm wall that barely fits) layout dependent. Not a cache bug: every other perturbation tried (clearing single evaluator caches, shelling a deep copy of the input, one extra validity check) flipped the result as well. | Not fixable in this layer. Documented; the fuzzer classifies such differences as marginal (see Design). Kept as `MARGINAL_REPRODUCERS`. User-visible risk: see "Open risks".                                                 |
| F4  | `determinism`   | Plate, through hole Ø1.4, circle sketched on a side face, cut 5.5 (`determinism-s1-q281`, 5 ops).                                                                               | Body validity depended on how it was evaluated: the incremental check (`faces`/`closure` modes, `kernel/faceProps.ts`) rejects an edge shared by three faces, the full `BRepCheck_Analyzer` accepts it. The same body was "not a valid solid" while editing and valid after a reopen. The closure test also wrongly rejected degenerated edges (blend corners, sphere poles).                                                             | One rule for all modes: full = `BRepCheck_Analyzer` **and** the closure/manifold test; degenerated edges pass. A box with all edges filleted no longer turns invalid after a later edit.                                     |
| F5  | (corruption)    | A `.hcasm` whose extrude `profile` is nested 100 000 levels deep.                                                                                                               | The recursive validators overflowed the stack: `RangeError: Maximum call stack size exceeded` escaped `loadProjectFile` (agent API: a non-API error; app: an unhelpful message).                                                                                                                                                                                                                                                          | `loadProjectFile` measures the nesting depth iteratively first and refuses more than 64 levels with a `ProjectFormatError` (`model/project/format.ts`).                                                                      |
| F6  | `determinism`   | Circle revolved about the X axis beside its XZ plane (a ring), suppress + undo, a cylinder cut through the ring (`determinism-s101-q434`, 6 ops).                               | Same class as F3, in a boolean: after ~430 sequences in one process the cut was a no-op in the incremental evaluation and an invalid, inside-out result (−10 298 mm³) in the cold one; in fresh processes the minimal sequence replays clean 3/3 (both evaluations give the invalid result, with the safety-net warning). None of the 16 perturbed cold runs hit the no-op outcome.                                                       | No product change. Classifier extended (cold evaluation on the fuzzed instance, see Design); kept as `MARGINAL_REPRODUCERS`. The invalid cut result itself is committed with a warning only (open risk).                     |
| H1  | `cancelTrace`   | Transaction begin, a History reorder in the UI, transaction cancel (`cancelTrace-s2-q330`, 7 ops).                                                                              | Harness bug: the user's own reorder during an agent transaction is not the transaction's to undo (a commit would report `conflict`, as designed).                                                                                                                                                                                                                                                                                         | The harness moves the cancel baseline with UI edits; reproducer kept.                                                                                                                                                        |

### Budget runs (Windows host, one worker, other agents active)

| Run         | Code            | Seed | Minutes | Sequences | Steps  | Committed | Refused | Max heap | Kernel loads | Result                             |
| ----------- | --------------- | ---- | ------- | --------- | ------ | --------- | ------- | -------- | ------------ | ---------------------------------- |
| exploratory | before fixes    | 1    | 10      | 16        | 592    | 223       | 87      | 127 MB   | 2            | F1 (2 sequences), F2 (2 sequences) |
| 1           | F1/F2 fixed     | 1    | 20      | 287       | 11 435 | 4 163     | 1 925   | 456 MB   | 8            | F3, F4                             |
| 2           | F3/F4 fixed     | 2    | 20      | 375       | 14 993 | 5 878     | 2 565   | 533 MB   | 13           | H1                                 |
| final A     | + arena, H1     | 101  | 20      | 435       | 17 387 | 6 623     | 3 062   | 533 MB   | 15           | F6 (F3 class, not a product bug)   |
| final B     | + arena, H1     | 202  | 20      | 587       | 23 462 | 8 415     | 4 014   | 758 MB   | 18           | clean                              |
| final C     | + F6 classifier | 303  | 20      | FINAL_C   |        |           |         |          |              |                                    |

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
- **Invalid boolean results are committed with a warning.** Blends (F1)
  and revolves (F2) now refuse results that are not valid solids; extrude
  join/cut and the Boolean feature still commit an invalid result (F6: an
  inside-out ring after a cut) and only warn. Refusing them needs a B-rep
  check per boolean (cost on every edit; coordinate with the kernel
  latency work).
- **Interleaved OCCT users** are detected, not supported (see Native crash).
- **Fuzzer coverage gaps**: no sweep/loft/split/align/offsetFace/draft/rib/
  thicken ops, no sketch text/spline/ellipse ops, no STEP/STL import, no
  exports inside the loop, no concurrent UI tool sessions; the monkey test
  is random, not model-based, and does not check document invariants.
- **Recent files**: a file that fails to open is still added to Open
  Recent (the path is remembered before the renderer parses it).
