# HimmelCAD Assembler — agent API and Python access

Status: implemented 2026-09-29 (branch `asm/agentapi-20260929`); constrained
sketches and the modelling-feature kinds added when merging the sketch-solver
and features workstreams (integration branch `feat/assembler-phase0-20260929`).
**Document parameters** ("variables", schema v3) added 2026-09-30 (branch
`asm/params-20260930`). Serves owner
intent **U5** ("as usable by agents as possible, taking their training into
account") and `PLAN.md` §5, under ADR 0024 (one canonical command/query
contract for UI, Python and agents) and ADR 0033 §4. This document records the
contract design, the trust boundary, the benchmark evidence and the limits.

## Document parameters ("variables")

A Shapr3D-like Parameters panel (right dock, `Ctrl+Alt+P`, command search
"Parameters"): named values (`wall = 2 mm`, `hole_d = 5.2`) with a unit
(`mm`/`deg`/unitless), usable from expressions anywhere a numeric field
accepts one. Implementation: `apps/assembler/renderer/src/model/parameters.ts`
(the `Parameter` type, `resolveParameterValues` — topological, cycle-checked,
same small recursive-descent grammar as sketch dimension expressions,
`sketch/expressions.ts`, reused directly), `model/store.ts`
(`upsertParameter`/`renameParameter`/`deleteParameter`/`parameterUsages`),
`chrome/ParametersPanel.tsx` + `chrome/ParamExpressionField.tsx` (the History
card size field, resolved value + formula on hover). Every field that accepts
names (feature size fields, the panel's value fields, sketch dimension fields
in History and in sketch mode) completes them from a styled list
(`chrome/ExpressionSuggestInput.tsx`: ↓/↑, Enter/Tab accept, Esc closes; ARIA
combobox) — not the unstyled native `<datalist>`. Tool pills and viewport value
chips take arithmetic only (`2 * 3`), no names, so they have no list.

- **Where an expression can read a parameter.** Every sketch dimension
  expression (`sketch.setDimension`, `sketch.addDimension`, the sketch tool's
  dimension fields) falls back to a document parameter for a name not found
  among the sketch's own dimensions (`"wall * 2"`, `"d1 + wall"`) —
  `sketch/expressions.ts#resolveDimensionValues` takes the parameter values as
  a second lookup; `sketch/solverProvider.ts` injects the document's current
  parameter values into every solve request (UI tool, headless, agent API)
  from one place, so live dragging, one-shot edits and agent writes never
  diverge. The numeric fields of `extrude` (`distance`), `fillet` (`radius`,
  `radius2`), `chamfer` (`distance`, `distance2`), `shell`, `rib` and
  `thicken` (`thickness`), `hole` (`diameter`) and `draft` (`angle`)
  additionally accept a sibling `<field>Expression` string
  (`distanceExpression`, `diameterExpression`, …; the table is
  `model/parameters.ts` `FEATURE_EXPRESSION_FIELDS`); the plain field always
  holds the last resolved value (kernel input unchanged), the `Expression`
  field is the formula, exactly mirroring `SketchDimension`'s
  `value`/`expression` split. Every such formula must resolve to a positive
  length, except the draft angle (signed, bounded by the feature's own
  range). Not (yet) parameter-aware: nested values such as a hole's blind
  depth or counterbore/countersink sizes and a shell's per-wall thicknesses.
  In the History card every one of these fields is a parameter-aware field
  with name completion (`chrome/PrintFeatureParams.tsx` `ParamField`).
  Python: `doc.create("hole", …, diameterExpression="bolt + 0.2")`.
- **UI refusal equals API refusal.** A Parameters-panel edit is evaluated by
  the kernel before it is committed (`model/store.ts` `checkParameterPlan`);
  when a feature that evaluates cleanly now would fail with the new values,
  the edit is refused with "<feature> would fail: <kernel message>. Nothing
  was changed." — the panel shows the message, exactly like
  `parameter.edit`'s `featureFailed`.
- **Rename cascades.** Renaming a parameter (`parameter.edit {name}` /
  `Parameter.rename` / the panel's name field) rewrites every sketch
  dimension expression and every feature `*Expression` field that names it
  (whole-word text substitution, `renameInExpression`), and every other
  parameter's expression that reads it — one undo step, no numeric value
  changes.
- **Delete refusal.** `parameter.delete` / `Parameter.delete` / the panel's
  delete button refuse (`conflict`, `details.usages`) when a sketch
  dimension, a feature `*Expression` field or another parameter's expression
  still names it; the usage list gives the feature/parameter and field.
- **Cycle detection.** `resolveParameterValues` is topological with a
  `visiting` mark; a cycle (direct or through several parameters) fails the
  whole edit (`invalidParams`, nothing changed) with the parameter name in
  the message, exactly like a sketch dimension cycle.
- **Storage.** `.hcasm` schema v3 (`model/project/format.ts`): a
  `parameters: Parameter[]` array alongside `features`; migration `v2 -> v3`
  adds an empty array. Feature `*Expression` fields are additive optional
  strings on the existing v2 feature shapes (no format bump needed on their
  own). Round-trip and migration tests: `test/model/project/format.test.ts`.
- **A parameter edit is one consistent change** (`model/parameterEdits.ts`,
  2026-09-30 integration fix). Changing a value (directly, or of a parameter
  another one reads) re-solves **every sketch whose driving dimensions read a
  changed value** with the new values (planeGCS, the same solver as every
  other sketch write; region keys kept via `rememberRegions`), re-resolves
  every feature `*Expression` field, and commits parameters + sketches +
  features as **one undo step** (`{features, parameters}` snapshots). It is
  all-or-nothing: a sketch the solver cannot satisfy (over-constrained, no
  solution, a dimension turning non-positive) or a size expression no longer
  giving a positive length refuses the whole edit with the sketch/feature
  named — nothing changes. The plan is computed asynchronously against a
  document snapshot and only committed if the document is still that
  snapshot (`applyParameterPlan`; the panel re-plans, the API answers
  `conflict`). Rolled-back sketches are re-solved too and the History
  rollback bar stays. Cancelling the kernel computation afterwards restores
  features and parameters together. Tests: `test/model/parameterEdits.test.ts`
  (UI/store path), `test/api/session.test.ts` (API),
  `sdk/python/tests/test_assembler.py` (Python against the headless app).
- **Undo and the incremental cache.** The re-resolved plain numeric fields and
  re-solved sketches are new feature objects only where something changed, so
  the feature-array-identity result cache (`KERNEL-SPIKE.md`) re-evaluates
  exactly the affected features.
- **Agent API.** `parameters.list` (query), `parameter.create`,
  `parameter.edit` (name/unit/value/expression, any subset — still one undo
  step; `value` alone replaces a formula, `expression: null` removes it),
  `parameter.delete` (`api/schema.ts`, `api/session.ts`). Results report
  `resolvedSketchIds`, `changedFeatureIds` and the evaluation (`errors`,
  `bodies`); a sketch conflict answers `sketchConflict` with
  `details.conflicts`, a feature that newly fails in the kernel
  `featureFailed`. Parameters are not staged in transactions
  (`transactionState` inside one). `feature.create`/
  `feature.edit` accept `<field>Expression` for extrude/fillet/chamfer/shell,
  resolved against the document's current parameters before the kernel sees
  the feature (`api/featureKinds.ts#resolveExpressionField`).
- **Python.** `doc.param("wall", 2)` creates or edits by name (one call
  either way); `doc.param("wall")` reads without changing it
  (`NotFoundError` if absent); `doc.parameters` lists them.
  `Parameter.set/.rename/.delete`. `doc.extrude(profile, expression="wall * 2")`
  and the matching `fillet`/`chamfer`/`shell` keyword reach the `*Expression`
  fields (`sdk/python/src/himmelcad/assembler/modeling.py`). Tests:
  `sdk/python/tests/test_assembler.py`
  (`test_param_creates_then_edits_by_name_and_feeds_a_feature_expression`,
  `test_document_parameters_drive_a_sketch_dimension_and_an_extrude` — the
  latter against the real headless process).

## Measurement and display

- **Measure queries** (`api/measureApi.ts`, 2026-09-30) return the Measure
  panel's numbers computed by the same code (`model/measure.ts`) from the
  kernel's exact B-rep data: `measure.distance {a, b}` — exact minimum
  distance and closest points from the kernel (`KernelAdapter.measureDistance`,
  `BRepExtrema_DistShapeShape`); `measure.angle {a, b}` — planar faces /
  straight edges (parallel items: `angle: 0`, `parallel: true`, `distance`);
  `measure.area {faces}` — exact face areas (selectors may match several);
  `measure.volume {bodyIds?}` — volume, surface area, box and mass (density
  of the body material from its appearance step, PLA otherwise); `measure.get
{items}` — everything the panel shows for 1..n items. Targets are
  `MeasureTarget`: `{kind: "body", bodyId}`, `{kind: "face", face:
FaceInput}`, `{kind: "edge", edge: EdgeInput}`, `{kind: "point", point:
[x, y, z]}`. Values carry units (mm, mm², mm³, deg, g). While History is
  rolled back they measure the steps above the bar (like the viewport).
  Python: `doc.distance(a, b)`, `doc.angle(a, b)`, `doc.area(*faces)`,
  `doc.volume(*bodies)`, `doc.measure(*items)` with `Body`/`Face`/`Edge`
  objects or `(x, y, z)` points. Tests: `test/api/session.test.ts`
  (`measure.*`), `sdk/python/tests/test_assembler.py`.
- **Display modes, view toggles, section view, pins and image export are
  UI-only by design.** Display mode (`Alt+1…7`), edges/hidden edges/grid/
  axes, render quality, camera, section plane, Measure pins and PNG export
  change how the user's window looks, not the model: they live in view
  state/preferences (`ViewState`, `usePreferences`, not the undo-tracked
  document), differ per window, and would make an agent fight the user for
  the screen. An agent's legitimate needs are covered by document commands
  (a body's `material` for "Visualized" and mass is part of its
  `setAppearance` step via `feature.create`), by the measure queries above
  (exact numbers instead of a picture), and by exports (`export.stl/3mf/
step`). The headless process has no renderer at all, so screenshot or view
  commands would work in only one of the two transports — contrary to the
  one-contract rule (ADR 0024). Automated UI checks use the DEV hook
  (`window.__assembler`, `README.md`), which is not an agent API.

## Shape

```text
 UI tools / history panel ──┐                ┌── Python: himmelcad.assembler (Document / AssemblerClient)
                            │                │        │ StdioTransport        │ LoopbackTransport
                            │                │        ▼                       ▼
                            │                │  assembler-headless     Electron main: loopback endpoint
                            │                │  (JSON-RPC over stdio)  (off by default, bearer token)
                            │                │        │                       │ IPC (body only)
                            ▼                ▼        ▼                       ▼
                     model/store.ts  ◄──  renderer/src/api/session.ts  (AgentSession: hcasm.agent-api@1)
                  (commitFeatures, undo/redo,        │ validates, resolves references, stages transactions
                   loadDocument, select)             ▼
                                              kernel adapter (OCCT: worker in the app, in-process headless)
```

- **One command layer, two transports.** `AgentSession`
  (`apps/assembler/renderer/src/api/session.ts`) executes every method. The
  headless CLI and the in-app endpoint only frame JSON-RPC around it, so their
  semantics cannot diverge.
- **One commit path.** Every state change ends in a store action the UI uses:
  `commitDocumentChange` is the UI tools' own `commitFeatures` (one undo
  step), plus `undo`/`redo`, `loadDocument`, `select`. Agents therefore share
  the user's undo stack, dirty tracking, recovery and viewport. Tests assert
  that agent commands produce the same history and undo steps as the UI tools
  (`test/api/session.test.ts`), and the Electron test undoes an agent edit with
  the app's own Ctrl+Z.
- **Why `renderer/src/api/` and not a new package.** The layer depends directly
  on the store, the feature document, the kernel adapter and the `.hcasm`
  validator, which all live in the app. The headless CLI compiles the same
  sources (`tsconfig.headless.json`), so there is no second copy. When the
  planned Rust document core lands, the contract (the JSON Schema), not this
  TypeScript location, is what must survive.

## Contract `hcasm.agent-api@1`

Source of truth: `apps/assembler/renderer/src/api/schema.ts`; checked-in copy
`apps/assembler/api/agent-api-v1.schema.json` (a test fails if they differ;
regenerate with `pnpm --filter @himmelcad/assembler api:schema`).
`api.describe` returns it at runtime. JSON Schema 2020-12 subset, validated by a
small in-repo validator (no new dependency).

| Group        | Methods                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meta         | `api.hello` (version, capabilities, feature kinds), `api.describe`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Queries      | `document.get`, `features.list`, `feature.get`, `bodies.list`, `body.get`, `faces.list`, `edges.list`, `sketches.list`, `selection.get`                                                                                                                                                                                                                                                                                                                                                  |
| Features     | `feature.create {kind, params}`, `feature.edit`, `feature.delete`, `feature.suppress`, `feature.rename`                                                                                                                                                                                                                                                                                                                                                                                  |
| Sketches     | `sketch.addProfile` (dimensioned rectangle/circle), `sketch.addPolyline`, `sketch.addArc`, `sketch.addConstraint`, `sketch.addDimension`, `sketch.setDimension`, `sketch.deleteItems`; advanced (2026-09-30, same builders as the sketch tools): `sketch.addSpline`, `sketch.addEllipse`, `sketch.addSlot`, `sketch.addPolygon`, `sketch.addText`, `sketch.mirror`, `sketch.pattern`, `sketch.roundCorner`, `sketch.project` (associative), `sketch.setReference` (reference dimensions) |
| Transactions | `transaction.begin`, `transaction.preview`, `transaction.commit`, `transaction.cancel`                                                                                                                                                                                                                                                                                                                                                                                                   |
| History      | `history.undo`, `history.redo`                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Files        | `export.stl` (`format` binary/ascii, `resolution`), `export.3mf` (`resolution`), `export.step`, `export.meshStats`, `import.step`, `project.new`, `project.open`, `project.save`                                                                                                                                                                                                                                                                                                         |
| 3D printing  | `print.analyze` (query), `print.orientations` (query), `print.placeOnPlate`, `print.orient` (one transform step each) — see `assembler/PRINTING.md`                                                                                                                                                                                                                                                                                                                                      |
| Parameters   | `parameters.list` (query), `parameter.create`, `parameter.edit`, `parameter.delete` — see "Document parameters" above                                                                                                                                                                                                                                                                                                                                                                    |
| Measure      | `measure.get`, `measure.distance`, `measure.angle`, `measure.area`, `measure.volume` (queries) — see "Measurement and display" below                                                                                                                                                                                                                                                                                                                                                     |
| View         | `selection.set` (not undoable)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Design rules:

- **Feature params are the stored feature fields.** `feature.create` takes
  exactly what a `.hcasm` file stores for that kind (minus
  `id`/`name`/`kind`/`suppressed`), so `features.list` output round-trips into
  `feature.create`/`feature.edit`, and agents build real history features —
  never meshes.
- **Constrained sketches.** A `sketch` stores `entities` (points, lines,
  circles, arcs in the sketch's `(u, v)` mm, always the last solved state),
  `constraints` and driving `dimensions` (`assembler/SKETCHING.md`). Every
  sketch write — `feature.create`/`feature.edit` of a sketch and each
  `sketch.*` command — re-solves the whole sketch with the same planeGCS
  solver the UI uses (in-process in the headless CLI, the solver worker in the
  app) before the kernel validates it. A conflicting or redundant constraint,
  a dimension that collapses geometry or an invalid expression fails with
  `sketchConflict` (`details.conflicting` / `details.redundant` name the ids)
  and nothing changes. Results report the remaining degrees of freedom
  (`dof`) and the detected `regions` (profiles) with their stable keys and
  boundary entity ids; extrudes/revolves/sweeps/lofts reference
  `profile: {kind: "sketch", featureId, regions?: [key]}`. Convenience:
  `sketch.addProfile` (and the input shorthand `profiles: [shape]` of
  `feature.create sketch`) adds a rectangle/circle **fully dimensioned** —
  position from the origin and size — and returns the dimension names by role
  (`{x, y, width, height}` / `{cx, cy, diameter}`), so an agent edits a width
  with `sketch.setDimension {dimension: "d3", value: 90}` (the History panel's
  dimension edit). `sketch.addPolyline` constrains axis-aligned segments
  horizontal/vertical (what the UI line tool infers); `construction: true`
  lines never bound a profile and serve as revolve axes
  (`axis: {kind: "sketchLine", featureId, entityId}`). Dimension expressions
  use the other dimensions' names (`"d4 / 2"`).
- **New feature kinds plug in by schema.** Adding a kind means one entry in
  `FEATURE_KIND_SCHEMAS` (params schema, label) and, if it has reference
  fields that accept selectors, one case in `featureKinds.ts#normalise`. Until
  then the kind is still accepted: `{bodyId, key}` references get their
  signatures filled generically and the feature is validated by the
  `.hcasm` validator, which every persisted kind must extend anyway. Python
  reaches any kind immediately with `doc.create(kind, **params)`.
- **References are stable names.** Faces and edges are addressed by the
  kernel's naming keys (`{bodyId, key}`, `kernel/naming.ts`); the server adds
  the geometric signature exactly as the UI does on a click. `{bodyId,
select}` expands a CadQuery-style selector server-side: `+Z`/`-Y` (facing /
  along), `|Z` (parallel), `#Z` (perpendicular), `>Z`/`<Z` (extreme along an
  axis, ties kept), `%PLANE`, `%CYLINDER`, `%LINE`, `%CIRCLE`, combined with
  `and`. Queries return readable names ("Extrude 1 end · plane +Z at 0, 0, 6 ·
  2400 mm²", "Circle Ø6 at 20, 0, 6") next to normals, centroids, areas,
  midpoints, lengths, radii and adjacency (`edgeKeys`/`faceKeys`).
- **Validate before commit.** A write is evaluated on the kernel's preview
  channel first; if a feature it creates or edits fails, nothing is committed
  (`featureFailed` with the kernel message and a hint). Downstream breakage of
  an edit is reported in the result's `errors`, like in the UI.
- **Transactions.** `transaction.begin` stages following writes on a private
  copy of the feature list; queries default to the staged state (`scope`
  selects `committed`/`staged`). `commit` is exactly one undo step; `cancel`
  never touched the store (tested: same array identity, no store
  notification, same revision). A commit fails with `conflict` if the user
  changed the document since `begin` — no silent merge.
- **Revisions.** `document.get` reports a revision that changes with every
  committed feature-list change (including undo/redo and UI edits); writes
  accept `expectedRevision` (optimistic concurrency, `conflict` on mismatch).
- **Structured errors.** `invalidRequest`, `methodNotFound`, `invalidParams`,
  `notFound`, `referenceNotFound`, `featureFailed`, `conflict`, `busy`,
  `sketchConflict`, `transactionState`, `permissionDenied`, `confirmationRequired`,
  `unsupported`, `cancelled`, `internal` — each with `message`, and where
  predictable a `hint` and `details` (e.g. the 12 most similar face/edge keys
  with names for an unknown reference, the existing ids for an unknown body,
  the method family for an unknown method). JSON-RPC carries them in
  `error.data`.
- **Units.** Millimetres, Z up; sketch `(u, v)` on `XY`/`XZ`/`YZ` are world
  axes, and a sketch on an axis-aligned face uses the parallel plane's axes.
- **Serialisation.** A session executes requests strictly in order. In the
  app, writes are rejected with `busy` while a UI tool session is active.

## Transports

**Headless** — `apps/assembler/bin/assembler-headless.mjs` (build:
`pnpm --filter @himmelcad/assembler build:headless`, also part of `build`).
JSON-RPC 2.0, one request object per line on stdin, one response per line on
stdout (stdout is protocol-only; OCCT/Emscripten output goes to stderr; a
UTF-8 BOM is tolerated). Notifications (no `id`) get no response; batches are
rejected (use transactions). `--print-schema` / `--write-schema <file>` emit the
contract. Kernel start ≈ 1 s; runs with the invoking user's rights, no network
listener, file paths relative to the working directory.

**In the app — "Agent Access (Local)"** (`file.agentAccess` in the command
registry / command search). `electron/automationServer.ts`,
`electron/automationIpc.ts`, `renderer/src/api/app/automationStore.ts`,
`chrome/AgentAccessIndicator.tsx`.

## Trust boundary (ADR 0024 applied)

| Rule                             | Implementation                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Off by default, visible when on  | Nothing listens until the user runs the command; a persistent indicator (address, request count, last method, Copy connection, Turn off) is shown while on; closing the window or Turn off closes the socket.                                     |
| Local only                       | Binds `127.0.0.1`, ephemeral port. The Python `LoopbackTransport` refuses non-loopback URLs.                                                                                                                                                      |
| Per-session credential           | 256-bit random bearer token, regenerated on every start, kept in memory, compared in constant time; a stale token is refused after a restart (tested).                                                                                            |
| No browser/CSRF/DNS rebinding    | Requests with an `Origin` header are refused; `Host` must be the loopback address; only `POST /rpc`; body ≤ 96 MB.                                                                                                                                |
| No harness gets store authority  | The main process forwards bodies only; the renderer's `AgentSession` validates and commits through the store's actions.                                                                                                                           |
| Capabilities                     | App sessions: `document.read`, `document.write`, `view.write` — **no filesystem**: `path` params are `permissionDenied`; exports come back as base64 and the client writes them; imports/opens send data. Headless: plus `filesystem.read/write`. |
| Destructive commands need a user | `project.new`/`project.open` in the app return `confirmationRequired` if unsaved work would be lost (the project's dirty flag); agents cannot bypass it.                                                                                          |
| Concurrency                      | Serialized per session; `busy` while a UI tool runs; `conflict` on `expectedRevision` mismatch or when the user edited during an open transaction.                                                                                                |

Not (yet) implemented from ADR 0024: bulk-data leases (exports are inline
base64 up to 64 MB; meshes are not exposed as arrays), a durable command
journal beyond the undo stack, per-grant approval UI (the whole session is
granted when the user turns access on), and a generated async client.

## Python

`sdk/python/src/himmelcad/assembler/` (hand-maintained; the Builder generator
`scripts/generate-automation-sdk.py` does not cover this contract and its
`--check` ignores extra files; `tests/test_assembler.py` pins the method table
and error codes to the checked-in schema instead).

```python
from himmelcad.assembler import Document

with Document.headless() as doc:              # or Document.connect_app('{"url": ..., "token": ...}')
    s = doc.sketch("XY")
    s.rect(80, 50)                            # feature.create sketch (dimensioned: s.dimensions[0])
    plate = doc.extrude(s, 6)                 # feature.create extrude -> Body
    doc.fillet(plate.edges("|Z"), 3)          # feature.create fillet (explicit edge keys)
    holes = doc.sketch(plate.face(">Z"))
    holes.circle(d=6, center=(20, 0))         # feature.create sketch (on the face)
    holes.circle(d=6, center=(-20, 0))        # sketch.addProfile
    doc.cut(holes, 6)                         # extrude, operation cut, into the face's body
    s.edit_profile(0, width=90)               # sketch.setDimension d3: the early change re-evaluates the history
    assert plate.valid and plate.bbox.size == (90.0, 50.0, 6.0)
    doc.export_3mf("plate.3mf"); doc.save("plate.hcasm")

    turned = doc.sketch("XZ")
    turned.polyline([(5, 0), (15, 0), (15, 4), (9, 4), (9, 10), (5, 10)])  # sketch.addPolyline
    axis = turned.line((0, -2), (0, 12), construction=True)                  # centre line
    doc.revolve(turned, axis)                                                # feature.create revolve

    report = doc.printability(material="PETG", minHoleMm=2)   # print.analyze (query)
    assert report.printable, report.findings_of("thinWall")
    doc.place_on_plate(plate.face("+X"))                      # print.placeOnPlate: one transform step
    doc.orient(plate)                                         # print.orient rank 1 (least overhang, then lowest)
    doc.export_stl("plate.stl", ascii=True, resolution="fine")  # export.stl with options
```

- Every modelling call is exactly one canonical command (`doc.log`,
  `doc.commands`); the exceptions say so: the macro `Sketch.slot` is three
  shape commands, `Sketch.edit_profile` one `sketch.setDimension` per changed
  dimension, and a first `polyline`/`line` also creates the sketch feature. Selections (`FaceSet`/`EdgeSet`) filter client-side with
  CadQuery-flavoured helpers (`max("Z")`, `lines()`, `of_face(face)`,
  `filter(curve="circle")`, `.one()` raising with the candidates' names).
- Errors are `HimmelcadError` subclasses (`ReferenceNotFoundError`,
  `FeatureFailedError`, `SketchConflictError`, `ConflictError`, …) with `raw_code`, `hint`,
  `candidates`.
- No `bpy` emulation (PLAN §5): familiarity comes from CadQuery/build123d
  vocabulary (sketch → extrude → fillet with selectors), which maps 1:1 onto
  the history model and stays editable in the UI.

## Benchmark (evidence for PLAN §5)

Scripts: `apps/assembler/bench/tasks.py` (five parts), `run_bench.py` (runner).
Run from the repository root after `build:headless`:
`python apps/assembler/bench/run_bench.py --out <dir>` (default
`D:\AgentWork\HimmelCAD-Asm-agentapi\bench`: `.3mf`, `.stl`, `.hcasm`,
`results.json`). Every volume is checked against a hand calculation (exact
B-rep; tolerance 1e-4, the clip 1e-3 because its opening is integrated
numerically), every bbox to 1e-3 mm. "Reopen" = a fresh headless process opens
the saved `.hcasm` (strict format validation, full re-evaluation, same volumes,
no feature errors). "Edit + undo" = a size dimension of an early sketch is changed
with `sketch.setDimension` (the whole later history must still evaluate and the
bbox must follow) and then undone. The Electron test (`test/electron/agentAccess.test.ts`)
additionally opens all five files in the **production app** through Agent
access (the schema-1 `.hcasm` files of the first run are checked in as
`apps/assembler/test/fixtures/`, so this also exercises the v1 → v2 migration in
the app; `ASSEMBLER_BENCH_DIR` points it at a fresh run), checks the History panel lists
them, changes a size dimension of the first sketch and reverts it with the
app's Ctrl+Z.

Measured 2026-09-29 on the Windows host DESKTOP-BNB2PBA (Ryzen 3 PRO 3200G), tasks run sequentially; other agent sessions were active on the host, so times are indicative only:

| Task               | Commands (queries) | Valid | BBox | Volume mm³ (expected)                | 3MF / STL bytes | Reopen | Edit + undo | In app | Time s |
| ------------------ | ------------------ | ----- | ---- | ------------------------------------ | --------------- | ------ | ----------- | ------ | ------ |
| enclosure-with-lid | 11 (5)             | yes   | ok   | 13367.6 (13367.6); 10702.3 (10702.3) | 163286 / 70084  | yes    | yes         | yes    | 4.1    |
| bracket-with-slot  | 14 (5)             | yes   | ok   | 20429.0 (20429.0)                    | 150395 / 65084  | yes    | yes         | yes    | 4.0    |
| pipe-adapter       | 11 (5)             | yes   | ok   | 5814.0 (5814.0)                      | 197289 / 84084  | yes    | yes         | yes    | 3.1    |
| phone-stand        | 11 (3)             | yes   | ok   | 91143.7 (91143.7)                    | 25957 / 11084   | yes    | yes         | yes    | 3.1    |
| cable-clip         | 13 (4)             | yes   | ok   | 1337.6 (1337.6)                      | 162909 / 69684  | yes    | yes         | yes    | 5.2    |

Commands include `project.new`; time includes two kernel starts (modelling
process and the fresh reopen process, ≈ 1 s each) and the exports.

Re-run 2026-09-29 on the merged sketch-solver + features + agent-API head
(same host, same scripts except the edit, now `sketch.setDimension`; the sketch
shapes are now constrained, fully dimensioned sketches and every sketch write is
solved by planeGCS; outputs in `D:\AgentWork\HimmelCAD-Assembler\bench-integration`).
Same command counts, volumes and file sizes as before (identical geometry);
times are indicative only (other agent sessions were active on the host):

| Task               | Commands (queries) | Valid | BBox | Volume mm³ (expected)                | 3MF / STL bytes | Reopen | Edit + undo | Time s |
| ------------------ | ------------------ | ----- | ---- | ------------------------------------ | --------------- | ------ | ----------- | ------ |
| enclosure-with-lid | 11 (5)             | yes   | ok   | 13367.6 (13367.6); 10702.3 (10702.3) | 163286 / 70084  | yes    | yes         | 4.73   |
| bracket-with-slot  | 14 (5)             | yes   | ok   | 20429.0 (20429.0)                    | 150395 / 65084  | yes    | yes         | 6.44   |
| pipe-adapter       | 11 (5)             | yes   | ok   | 5814.0 (5814.0)                      | 197289 / 84084  | yes    | yes         | 3.42   |
| phone-stand        | 11 (3)             | yes   | ok   | 91143.7 (91143.7)                    | 25957 / 11084   | yes    | yes         | 3.42   |
| cable-clip         | 13 (4)             | yes   | ok   | 1337.6 (1337.6)                      | 162909 / 69684  | yes    | yes         | 4.59   |

The "In app" column of the first run was re-checked by `test:electron` on the
merged head (the five schema-1 files open, migrate, evaluate and stay editable
in the production app). The tasks still model the pipe adapter as stacked
extrusions and the phone stand's rest upright, so the numbers stay comparable;
both are now expressible with a revolve and a sketch polyline.

Re-run 2026-09-30 after the perf, selection and packaging merges (same host
and scripts; outputs in `D:\AgentWork\HimmelCAD-Assembler\bench-j`; "In app" =
`agentAccess.test.ts` with `ASSEMBLER_BENCH_DIR` on these schema-2 files).
Same command counts and volumes; the pipe adapter's and cable clip's STL/3MF
are larger because the kernel now tessellates per face (curved faces get their
own density); times indicative only:

| Task               | Commands (queries) | Valid | BBox | Volume mm³ (expected)                | 3MF / STL bytes | Reopen | Edit + undo | In app | Time s |
| ------------------ | ------------------ | ----- | ---- | ------------------------------------ | --------------- | ------ | ----------- | ------ | ------ |
| enclosure-with-lid | 11 (5)             | yes   | ok   | 13367.6 (13367.6); 10702.3 (10702.3) | 163297 / 70084  | yes    | yes         | yes    | 3.25   |
| bracket-with-slot  | 14 (5)             | yes   | ok   | 20429.0 (20429.0)                    | 150395 / 65084  | yes    | yes         | yes    | 3.29   |
| pipe-adapter       | 11 (5)             | yes   | ok   | 5814.0 (5814.0)                      | 232793 / 101984 | yes    | yes         | yes    | 2.67   |
| phone-stand        | 11 (3)             | yes   | ok   | 91143.7 (91143.7)                    | 25957 / 11084   | yes    | yes         | yes    | 2.85   |
| cable-clip         | 13 (4)             | yes   | ok   | 1337.6 (1337.6)                      | 166747 / 71284  | yes    | yes         | yes    | 3.14   |

Repair rounds (the scripts were written by the implementing agent against the
API, then run): 3 of 5 passed first time; 2 needed one fix each, both in the
script, not the API. Phone stand: `.one()` failed because the lip front and
the base front are coplanar and merge into one face — the error listed both
candidate names ("Extrude 2 side · plane -Y at 40, 50, 48.5", "Extrude 1 side
· plane -Y at 40, 0, 10"), which made the fix (`face("-Y and <Y")`) immediate.
Cable clip: the hand-calculated bbox ignored that the opening trims the ring
top (max y is √(7² − 2.5²), not 7).

### Comparison: build123d on the same five parts (2026-09-30)

PLAN §5 asks for a comparison against FreeCAD-Python and build123d on the
same tasks. **FreeCAD**: not installed on the measuring host (checked;
`docs/DEPENDENCY-POLICY.md` says not to install it for this) — not measured.
**build123d** (Apache-2.0, MIT-compatible with this repository's license but
not shipped as a dependency — installed only into a throwaway venv,
`D:\AgentWork\HimmelCAD-Assembler\venv-b123d`, `pip install build123d`,
version 0.13.0) was measured: `apps/assembler/bench/build123d_tasks.py` models
the same five parts, `run_bench_build123d.py` checks them and exports
STL/STEP to `D:\AgentWork\HimmelCAD-Assembler\bench-b123d`.

**Not a token count.** Neither script was actually run through an LLM to
measure prompt/completion tokens for this comparison; **characters of code
are used as an explicit, cruder proxy** (a real token count needs an actual
model run, which PLAN §5's own token-budget framing (owner intent U8) treats
as a separate, measured exercise, not something to guess at here).

**Not the same construction steps, deliberately.** build123d exposes direct
`Box`/`Cylinder` primitives and boolean `+`/`-`; the Assembler agent API has
no "add a box" command by design (every solid comes from a sketch + a
modelling feature, so it stays a real, editable parametric history — see
"Feature params are the stored feature fields" above). Matching the
**parts** (bbox, volume) rather than mirroring the Assembler script's exact
steps is the fair comparison; a build123d script that used its own sketch

- extrude idioms throughout would look more similar in shape but not
  meaningfully shorter.

| Task                | build123d valid | bbox | volume mm³ (expected) | code lines / chars | Assembler code lines / chars |
| ------------------- | --------------- | ---- | --------------------- | ------------------ | ---------------------------- |
| enclosure-with-lid¹ | yes             | ok   | 13367.6 (13367.6)     | 9 / 518            | 25 / 1152                    |
| bracket-with-slot   | yes             | ok   | 20429.0 (20429.0)     | 23 / 1237          | 34 / 1478                    |
| pipe-adapter        | yes             | ok   | 5814.0 (5814.0)       | 19 / 1033          | 33 / 1452                    |
| phone-stand         | yes             | ok   | 91143.7 (91143.7)     | 24 / 1281          | 27 / 1389                    |
| cable-clip          | yes             | ok   | 1352.7 (1337.6, 1.1%) | 36 / 1649          | 41 / 1511                    |

¹ The build123d script models only the enclosure body, not the paired lid
(dropped for time); its line/char count is therefore **not comparable** to
the Assembler column for this row alone (which builds both bodies). The
other four rows model the same bodies both ways.

Every build123d body reports `is_valid` true, matches the expected bounding
box, and matches the hand-calculated volume within 1e-4 relative tolerance
except cable-clip (1.1%, box-based tab/notch/hole modelling rather than the
Assembler script's exact construction — both are legitimate models of the
same nominal part; the discrepancy is a modelling difference, not an error in
either tool). STL and STEP export succeeded for all five
(`export_stl`/`export_step`, checked-in results:
`D:\AgentWork\HimmelCAD-Assembler\bench-b123d\results.json`).

**Manual editability afterwards, in a GUI: build123d — no; Assembler —
yes.** A build123d script is a plain CadQuery-style Python program with no
associated document, feature tree or GUI; the only way to "edit" the result
is to edit the Python and re-run it (there is no viewer/editor shipped with
build123d itself — CQ-editor or a Jupyter view are separate, optional
tools and still show a mesh, not an editable parametric history). Every
Assembler script in this benchmark produces a normal `.hcasm` history that
opens, stays selectable/editable (dimensions, distances, radii) and
re-evaluates in the desktop app, which is exactly owner intent U5's "stays
editable" condition (`assembler/OWNER-INTENT.md` U5, U8) — this is the
qualitative result PLAN §5 is actually after, not just the code-size numbers.

**A real footgun found while writing the build123d scripts, worth recording
for the comparison's own sake:** `fillet()`/`chamfer()` return a _new_ solid;
an edge object captured from the solid _before_ an earlier fillet/chamfer,
then reused afterwards, silently resolves against the pre-operation solid
(`Shape.topo_parent`) and drops that earlier operation — `phone_stand()`
in `build123d_tasks.py` hit this (a first attempt silently lost the "back"
fillet) and needed edges re-queried from the post-fillet solid. The
Assembler agent API's face/edge references are stable named keys
(`kernel/naming.ts`) that survive every later feature exactly so an agent
does not have to reason about _which_ intermediate solid a captured
reference actually belongs to.

What the benchmark does **not** show: an actual token count per part
(character counts are the proxy used above, explicitly not the same thing),
FreeCAD-Python (not installed, not measured), agents other than the
implementing one, and slicer checks of the 3MF/STL files.

## Limits and open risks

- **Parameters.** Name completion ranks prefix matches before substring
  matches (no fuzzy matching). Parameters are not staged in transactions.
  Only extrude/fillet/chamfer/shell size fields and sketch dimensions accept
  parameter names (hole, draft, rib, thicken, second radius/distance and
  tool pills take numbers/arithmetic). Renaming/deleting a parameter only scans
  sketch dimensions and feature `*Expression` fields for usage — a
  parameter referenced solely from a currently-open sketch-tool session's
  unsaved draft (not yet committed) is not seen by the usage scan.
- **Sketch API granularity.** Commands add whole shapes, polylines, arcs,
  single constraints and dimensions; there is no drag, trim or offset command
  (the UI has them) and no reference (driven) dimension — dimensioning an
  already determined length fails with `sketchConflict` (redundant). Region
  keys are entity-id based: deleting and redrawing a boundary gives a new key.
  The kernel re-binds a feature referencing the old key by the region's
  unchanged edges (or to the sketch's only remaining profile) and reports a
  warning; otherwise it reports `Missing reference: profile …`
  (`KERNEL-SPIKE.md` "Reference scheme v2").
  An under-constrained sketch moves where the solver prefers when a dimension
  changes (like the UI); lock or dimension what must stay.
- **Modelling kinds** (revolve, sweep, loft, mirror, pattern, split,
  transform, align, offsetFace, deleteFace) have closed schemas and selector
  resolution for their face/edge fields; Python has `doc.revolve` and reaches
  the others with `doc.create(kind, **params)`. Automatic New/Join/Cut (the UI
  tools' default) is not applied by the API: `operation` defaults to `new`.
- **Print-part kinds** (hole, emboss, draft, rib, thicken) and the optional
  fillet/chamfer/shell/boolean params (`radius2`, `rules`, `mode`/`distance2`/
  `angle`/`flip`, `direction`/`clearance`/`faceThickness`, `keepTools`) have closed
  schemas (`api/printSchema.ts`); selectors resolve in `face`, `faces`,
  `rules[].face`, `faceThickness[].face` and `source.faces`. Python:
  `doc.hole` (metric size + ISO or printed fit, counterbore/countersink,
  sketch points, cosmetic thread), `emboss`/`engrave`, `draft`, `rib`,
  `thicken`, `fillet_variable`, `fillet_by_rule`, `chamfer_two_distances`,
  `chamfer_distance_angle`, `shell_walls`, `boolean(…, keep_tools=True)`.
  Hole presets are resolved client-side (the stored feature holds plain
  diameters). A fillet the kernel cannot build fails with `featureFailed`;
  `details.failures[].refs.edgeKeys` lists the edges that fail on their own
  (`KERNEL-SPIKE.md` "Print-part features").
- **Reference resolution while editing mid-history** uses the current
  (final) evaluation to fill signatures of _changed_ reference fields; keys
  are what bind, signatures are only the fallback, but a signature taken from
  a later state is less useful for re-binding.
- **Unsaved-work detection in the app** is the project store's dirty flag,
  tracked from startup: feature changes (undo back to the saved list is clean
  again), Items names/folders, saved views and reference meshes.
- **In the app, `project.open`/`project.new`/`project.save` go through the
  project store** (`api/app/automationStore.ts` `appSessionHost`), like the
  File menu: an agent open restores Items, saved views, view state and
  reference meshes and leaves the project clean (no file path: Save asks
  where); an agent save returns the complete file, so it never drops the
  user's non-feature data. Headless sessions work on the features alone.
- **Agent `project.open` in the app** does not refit the camera (a saved
  camera preset in the file is applied).
- **Kernel busy**: API validation evaluations use the kernel's preview
  channel; a user dragging a tool preview supersedes them (retried up to 20
  times, then `busy`).
- **Python generator test**: `sdk/python/tests/test_generation.py` fails on
  this integration head independently of this work
  (`crates/himmelcad-core/src/canonical_document.rs` moved to
  `himmelcad-document` in 96ed326; the generator pins still point at it).
