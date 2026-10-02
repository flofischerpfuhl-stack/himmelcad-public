# Checks and clearance — stored requirements, clearance between bodies

Status: implemented 2026-10-02 (Block 9 stream "checks", branch
`asm/b9-checks-20261002`). Owner approval: ForgeCAD recommendations #2
(stored checks) and #4 (collision and clearance between bodies),
[ROADMAP-LATER.md](ROADMAP-LATER.md) §2b; ideas only from
[research/2026-10-01-forgecad/Report.md](research/2026-10-01-forgecad/Report.md)
§4/§6, no code, documentation or API names taken over.

Two capabilities that share the kernel's clearance query:

- **Clearance between bodies** — the exact minimum distance of two solids,
  their closest points, and whether they are apart, touching or overlapping
  (with the shared volume). In Measure (two bodies), in the Printability
  analysis (findings "bodies overlap" / "clearance below X mm") and as a
  check kind.
- **Stored checks** — requirements the document keeps ("Lid ↔ Base
  clearance ≥ 0.3 mm", "printable without errors", "volume 40–60 cm³"),
  evaluated in the background after every rebuild, with a panel, a passive
  status badge, undo/redo, the `.hcasm` field `checks`, the `checks.*` agent
  API and Python helpers.

## Principles

Owner requirement 2026-10-02 (binding): checks and clearance must never get
in the way of a user who models by hand and knows what they are doing.

| Principle                 | What the app does                                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Opt-in only**           | A document has no checks until the user or an agent adds one; there are no default checks and no default thresholds on checks. Clearance and overlap findings appear only inside the Printability analysis (an opt-in mode, `P`) and in Measure when the user measures two bodies — never while modelling.                                                                                                                                    | `test/checks/checks.test.ts` "opt-in" (a new document with overlapping bodies has no checks and no warning; a file without checks writes no field)                                                          |
| **Never blocking**        | A failing check never refuses a commit, never opens a toast or dialog and never takes the focus. Results only update the Checks panel and the badge. The background run stops for edits (tools, drags, evaluations) and resumes afterwards.                                                                                                                                                                                                   | `checks.test.ts` "background runner … passive" (no notice, panel stays closed, no run while a tool is active); `printClearance.test.ts` (findings never notify) |
| **Dismissable**           | Every Printability finding has **Ignore here** (overlaps: **Mark as intended**) — stored in the document (`printIgnored`) per finding, i.e. per body pair or face — and **Don't show this type** — a user preference (`hiddenPrintFindings`). Both are reversible: the panel lists what it leaves out ("n ignored in this document · Show · Restore all", "Overlaps hidden · Show again"), Settings › Checks and analysis › "Show all again". | `printClearance.test.ts` (ignore → restore, hide → show, preference parsing), `checks.test.ts` (`printIgnored` round trip)                                      |
| **Unobtrusive status**    | Settings › Checks and analysis › "Check status in the workspace: Badge / Off". Badge (default): the Checks toggle in the left dock shows a dot and passed/total when the document has checks — grey while out of date, red when one fails, green when all pass. Off: a plain toggle.                                                                                                                                                          | UI (screenshots), `ChecksModeButton.tsx`                                                                                                                        |
| **No latency**            | Checks run after the rebuild, debounced, off the critical path: instant kinds in microseconds, kernel kinds in the kernel worker only once it is idle, print kinds in a printability worker; incremental (unchanged bodies keep their results).                                                                                                                                                                                               | `bench:interactive` rows "f checks" (§ Performance)                                                                                                             |
| **Agents see everything** | The API ignores the UI settings: `checks.run`/`checks.list` return every result, `print.analyze` every finding (ignored ones marked `ignored: true`).                                                                                                                                                                                                                                                                                         | `test/checks/checksApi.test.ts`                                                                                                                                 |

## Where it is in the UI

| Capability                | Entry points                                                                                                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checks panel              | Left dock › **Checks** (mode group, with the status badge), command search "Checks", View menu. Right column between Parameters and History.                                                                                                                                                                   |
| Add a check               | Checks panel **+** (kinds listed with what the current selection gives each, e.g. "Select two bodies"), command "Add check…", and **Measure › Add as check** (the list icon next to a value). The new check opens in the editor with a range around the measured value.                                        |
| Locate a check            | Click a check: its bodies/faces/edges are selected and framed; the closest points (clearance, distance) or the overlap centre are drawn while it is focused.                                                                                                                                                   |
| Edit / delete             | Pencil (range, label, "Evaluate after every change" on/off), bin (click twice). Every edit is one undo step.                                                                                                                                                                                                   |
| Run now / stop            | Panel ↻ (■ stops a running background run), command "Run checks now" (normally not needed: checks run after every rebuild).                                                                                                                                                                                    |
| Clearance in Measure      | Select two bodies with Measure on: title "Clearance" / "Bodies touch" / "Bodies overlap", the minimum distance with its closest points, the overlap volume.                                                                                                                                                    |
| Clearance in Printability | Findings "A and B overlap (… mm³)" (error) and "Clearance A ↔ B 0.12 mm < 0.3 mm" / "A and B touch" (warning); click to select both bodies and frame them; markers drawn (orange gap, pink overlap cross). Thresholds: "Min. clearance" (0.3 mm) and "Check clearance between bodies" in the panel's settings. |
| Ignore / hide findings    | Hover a finding: **Ignore here** / **Mark as intended**, **Don't show this type**; below the list: what is ignored or hidden, with Restore / Show again. Settings › Checks and analysis.                                                                                                                       |

## Clearance between bodies

Kernel: `foundation/geometry-kernel/clearance.ts`, `KernelAdapter.measureClearance(features, { pairs, overlap?, budgetMs? })`
(evaluator, in-process and worker adapters, worker protocol, headless
thread).

- **Distance**: `BRepExtrema_DistShapeShape` (deflection 1e-7) between the
  two solids: exact minimum distance and the closest points. OCCT 8.0.1
  reports distance 0 and `InnerSolution()` when one solid lies (partly)
  inside the other.
- **Touching or overlapping** (distance ≤ 1e-4 mm or an inner solution):
  `BRepAlgoAPI_Common` (non-destructive) and `BRepGProp::VolumePropertiesGK`
  give the shared volume and its centre. ≥ 1e-4 mm³ is an **overlap**, less
  (a shared face or edge) is **contact**. `overlap: false` skips the boolean
  (contact/overlap then only from the distance and inner solution).
- **Bounding-box pre-filter** (`clearancePairs.ts`): the gap between two
  boxes is a lower bound of the bodies' distance, so pairs whose boxes are
  farther apart than the threshold are never sent to the kernel
  (Printability, all-pairs clearance checks, `measure.clearance` with
  `below`).
- **Time budget**: checked between pairs (one OCCT call cannot be
  interrupted); pairs left over come back as `skipped` and are reported
  ("Clearance not checked for n of m close body pairs (time budget)") —
  never silently dropped. Budgets: Measure 5 s per pair, Printability pass
  10 s total in chunks of 4 pairs (Cancel takes effect between chunks), a
  check 5 s, an agent call 60 s (`budgetMs`). On the headless CLI the kernel
  job budget (F13) bounds a single OCCT call as before.
- No OCCT rebuild was needed: the `8.0.1-hc.3` module (and replicad's) has
  `BRepExtrema_DistShapeShape` (with `InnerSolution`), `BRepAlgoAPI_Common`,
  `GProp_GProps` and `BRepGProp`.

Limits: clearance is between bodies only (not between faces of one body —
that is wall thickness); reference meshes are not measured; a pair is
measured in its current position only (no motion — joints are ROADMAP-LATER
§4); a pair that only touches along an edge or a point is contact.

## Stored checks

A stored check is `{ id, kind, name?, params, enabled? }`
(`foundation/document/checks.ts`), document state in the store core
(`AssemblerState.checks`, part of every undo snapshot like `parameters`).

### Kinds

Registered by the module that owns the measurement (`defineAssemblerModule({ checkKinds })`,
`foundation/commands/checks.ts`); the checks module only runs them.

| Kind            | Module  | Parameters                                                                                  | Value                                                                        | Cost    |
| --------------- | ------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------- |
| `distance`      | measure | `a`, `b` (`MeasureTarget`), `min?`, `max?`                                                  | Measure's distance (exact minimum, parallel or centre distance), mm          | kernel  |
| `angle`         | measure | `a`, `b`, `min?`, `max?`                                                                    | angle, deg (parallel: 0)                                                     | kernel  |
| `length`        | measure | `target`, `quantity` (length, diameter, radius, width, depth, height, area), `min?`, `max?` | the size, mm (area mm²)                                                      | instant |
| `clearance`     | measure | `a`+`b` (body ids), or `bodies?` (every pair), `min`                                        | smallest gap, mm; fails on overlap or a gap < `min` (`min` 0: overlaps only) | kernel  |
| `volume`        | measure | `bodies?`, `min?`, `max?`                                                                   | exact B-rep volume, mm³                                                      | instant |
| `mass`          | measure | `bodies?`, `min?`, `max?`                                                                   | volume × material density (appearance, PLA default), g                       | instant |
| `bodyCount`     | checks  | `min?`, `max?`                                                                              | number of bodies                                                             | instant |
| `printable`     | print   | `bodies?`                                                                                   | valid B-rep and watertight mesh (no error findings)                          | worker  |
| `wallThickness` | print   | `bodies?`, `min`                                                                            | thinnest sampled wall, mm                                                    | worker  |
| `buildVolume`   | print   | `bodies?`, `printer` or `size`, `allowRotated?`                                             | every body's box fits                                                        | instant |

A kind declares its JSON schema (published by `checks.kinds`), semantic
problems (`min > max`), a description ("Clearance Lid ↔ Base ≥ 0.3 mm"),
the bodies it depends on (incremental reuse), its cost, the numeric fields
the panel edits and what it takes from the selection. Print kinds use their
own parameters and the analysis defaults (no printer, no clearance), never
the user's panel settings, so a check means the same for every user and
agent.

### Results

`pass` · `fail` · `error` (a referenced body is gone, the kernel failed, the
time budget ran out) · `disabled` · `unsupported` (a kind this build does
not know). In the panel also "not evaluated yet" and "out of date" (the
model changed and the background run has not caught up; shown greyed with
the last value). Each result has the measured value, unit, expected range,
a one-line message and **locations**: body ids, face/edge keys, closest
points (`segment`) or a point (`point`) — what the panel selects and draws
and what agents read.

### Evaluation

`runChecks(checks, env, { previous, onResult, beforeBackgroundCheck })`
(`foundation/commands/checks.ts`):

- cheapest first (instant, kernel, worker), results in the checks' order;
- **incremental**: a check's fingerprint is its kind, parameters and the
  `meshId`s of the bodies it depends on (plus kind-specific inputs such as
  materials); an unchanged fingerprint reuses the previous result;
- cancellable between checks (`env.cancelled()`), never throwing (failures
  are `error` results).

The checks module's runner (`modules/checks/runner.ts`) calls it in the app
250 ms after the evaluation or the check list changed, never while a tool,
a drag or a document evaluation runs (the results turn "out of date"
instead), waits for an idle kernel before each kernel check, and drops a run
that a newer change superseded. Agents call `checks.run`, which evaluates
fresh on the committed or staged document.

### Creating, editing, undo

- Panel **+**: pick a kind; its parameters come from the selection (two
  bodies → `a`/`b`, bodies → `bodies`, nothing → all bodies); numeric fields
  (min/max, minimum gap …) are filled in the editor, empty optional bounds
  are open.
- **Measure › Add as check**: two bodies' distance → `clearance` with `min`
  = the current gap (rounded down to 0.01 mm; an overlap → `min` 0); a
  distance/angle → ±0.05 mm / ±0.5°; a size → `length` ±0.05 mm (area ±1 %);
  volume/mass → ±2 %. The check opens in the editor.
- Every add, edit and delete is **one undo step** (`commitChecks`), refused
  while a tool or a sketch session owns the undo history. The model is not
  re-evaluated by a check edit.

## File format

Both fields are **optional and additive** (the Block 8 rule: no schema
bump, `schemaVersion` stays 3; README "Files"): a file without them loads
unchanged, an older app ignores them (and drops them on its next save).

- `checks`: `[{ id, kind, name?, params, enabled? }]` (at most 500, written
  only when non-empty, after `images`). Strict about structure (a malformed
  entry or a duplicate id rejects the file like any corrupt field), lenient
  about parameters: unknown kinds and unknown parameter keys are **kept and
  round-trip**, reported as `unsupported`/`error`, never a reason to refuse
  the model — so a file from a newer app opens in an older one.
- `printIgnored`: finding ids ignored in this document (at most 5000).

## Agent API and Python

`hcasm.agent-api@1` (schema `apps/assembler/api/agent-api-v1.schema.json`):

| Method              | Kind    | What                                                                                                                         |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `checks.kinds`      | query   | kinds with label, summary, module, cost and parameter schema                                                                 |
| `checks.list`       | query   | stored checks (+ `lastResult` when the app's background result is current)                                                   |
| `checks.add`        | command | one undo step (not in a transaction); evaluates the new check at once                                                        |
| `checks.update`     | command | params (replaced), `name` (`null` clears), `enabled`; evaluates it                                                           |
| `checks.remove`     | command | one undo step                                                                                                                |
| `checks.run`        | query   | evaluates `ids?` (default all) on `scope` committed/staged: `{revision, scope, passed, summary, results}`                    |
| `measure.clearance` | query   | one pair, `bodyIds`, or all pairs (`below` pre-filter): relation, distance, closest points, overlap volume/centre, `skipped` |
| `print.analyze`     | query   | + clearance findings (`settings.checkClearance`, `minClearanceMm`), `ignored: true` on findings the user ignored             |

`checks.*` edits bump the document revision (`expectedRevision` works) and
are undone by `history.undo` like any other edit.

**Contract for the parameter sweep** (stream "params"): `checks.run` with
`scope: "staged"` evaluates the checks against an open transaction's state
(set parameters, run, cancel); in-process code calls
`runChecks(state.checks, env)` with the variant's evaluation and active
features — results have the same shape as `checks.run`'s (`resultJson` in
`modules/checks/api.ts`).

Python (`sdk/python`, `himmelcad.assembler`): `doc.add_check(kind, name=…,
**params)` → `Check`, `doc.checks()`, `doc.run_checks(scope=)` →
`CheckReport` (`passed`, `failed`, `results`, `by_name`), `check.update(…)`,
`check.remove()`, `doc.clearance(a, b)` / `doc.clearances(below=)`; client
methods `checks_kinds/checks_list/check_add/check_update/check_remove/checks_run/measure_clearance`.

## Module contract

`defineAssemblerModule({ checkKinds: [...] })` registers kinds
(`registerCheckKind`; a second registration of a kind throws). A kind
module never imports the checks module; UI flows reach the panel through
`openCheckEditor(checkId)` (a sink the checks module's UI installs) and edit
the list through `addStoredCheck` / `commitStoredChecks`
(`foundation/commands/checks.ts`). See [MODULES.md](MODULES.md) §3.

## Performance

See the Block 9 bench rows (`bench:interactive` "f checks",
`bench:kernel` clearance rows) in the stream report and
[ROBUSTNESS.md](ROBUSTNESS.md); measured on DESKTOP-BNB2PBA (Ryzen 3 PRO
3200G).

## Limits

- Wall thickness and printable checks use the sampled mesh analysis
  (PRINTING.md limits apply).
- Clearance is static (current positions), between whole bodies.
- A check that refers to a face or edge by key follows the naming rules of
  references (stable across edits, `error` when the face is gone); selectors
  (`{bodyId, select: ">Z"}`) re-resolve on every run.
- Check kinds do not run on reference meshes.
- A `distance` between parallel planar faces is Measure's plane-to-plane
  distance: unsigned, and blind to what happens at the faces' ends (A7: the
  side gap reads 0.05 mm while the corners already collide). Collisions are
  what `clearance` is for.

## Evidence

- `test/kernel/clearance.test.ts` — gap 0.3 mm exact, contact, 250 mm³
  overlap with its centre, a body inside another (27 mm³), budget, missing
  body, in-process adapter.
- `test/checks/checks.test.ts` — kind registry, strict/lenient parameters,
  undo/redo, refusal while a tool runs, enclosure + lid clearance fail →
  fix → pass, ranges/sizes/counts/print kinds, incremental reuse, the
  passive background runner, `.hcasm` round trip and corruption.
- `test/checks/checksApi.test.ts` — `checks.*`, transactions and staged
  runs, `measure.clearance`, `measure.get`, `print.analyze` findings with
  `ignored`.
- `test/checks/printClearance.test.ts` — Printability overlap finding,
  ignore/hide reversible and passive, clearance pass budget/cancel, Measure
  two-body clearance and "Add as check".
- `test/acceptance/parts.acceptance.test.ts` A7 — the enclosure template's
  lid seated on the box with two checks ("Lid does not collide": clearance
  ≥ 0, "Lip gap": 0.15–0.3 mm). With the `clearance` parameter at 0.05 both
  fail — the gap is 0.05 mm, and the lip's fixed R1.8 corners cut into the
  opening's R2 corners (0.12 mm³ overlap, also a Printability finding), a
  collision no side-gap measurement shows; at 0.2 both pass; the checks
  survive save → reopen (agent API end to end).
- `sdk/python/tests/test_checks.py` — the Python helpers, and the same
  fail → fix → pass loop against the real headless process.
- Fuzzer ops `checkAdd`, `checkEdit`, `checkRemove`, `checkRun`
  (undo/redo, save/reopen and result invariants).
