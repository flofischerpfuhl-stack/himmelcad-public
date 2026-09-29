# HimmelCAD Assembler — agent API and Python access

Status: implemented 2026-09-29 (branch `asm/agentapi-20260929`). Serves owner
intent **U5** ("as usable by agents as possible, taking their training into
account") and `PLAN.md` §5, under ADR 0024 (one canonical command/query
contract for UI, Python and agents) and ADR 0033 §4. This document records the
contract design, the trust boundary, the benchmark evidence and the limits.

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

| Group        | Methods                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Meta         | `api.hello` (version, capabilities, feature kinds), `api.describe`                                                                      |
| Queries      | `document.get`, `features.list`, `feature.get`, `bodies.list`, `body.get`, `faces.list`, `edges.list`, `sketches.list`, `selection.get` |
| Features     | `feature.create {kind, params}`, `feature.edit`, `feature.delete`, `feature.suppress`, `feature.rename`                                 |
| Sketches     | `sketch.addProfile`, `sketch.editProfile`, `sketch.removeProfile` (profile parameters are the dimensions)                               |
| Transactions | `transaction.begin`, `transaction.preview`, `transaction.commit`, `transaction.cancel`                                                  |
| History      | `history.undo`, `history.redo`                                                                                                          |
| Files        | `export.stl`, `export.3mf`, `export.step`, `import.step`, `project.new`, `project.open`, `project.save`                                 |
| View         | `selection.set` (not undoable)                                                                                                          |

Design rules:

- **Feature params are the stored feature fields.** `feature.create` takes
  exactly what a `.hcasm` file stores for that kind (minus
  `id`/`name`/`kind`/`suppressed`), so `features.list` output round-trips into
  `feature.create`/`feature.edit`, and agents build real history features —
  never meshes.
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
  `transactionState`, `permissionDenied`, `confirmationRequired`,
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
| Destructive commands need a user | `project.new`/`project.open` in the app return `confirmationRequired` if unsaved work would be lost (project dirty flag, or any undoable change since the last load); agents cannot bypass it.                                                    |
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
    s.rect(80, 50)                            # feature.create sketch
    plate = doc.extrude(s, 6)                 # feature.create extrude -> Body
    doc.fillet(plate.edges("|Z"), 3)          # feature.create fillet (explicit edge keys)
    holes = doc.sketch(plate.face(">Z"))
    holes.circle(d=6, center=(20, 0))         # feature.create sketch (on the face)
    holes.circle(d=6, center=(-20, 0))        # sketch.addProfile
    doc.cut(holes, 6)                         # extrude, operation cut, into the face's body
    s.edit_profile(0, width=90)               # sketch.editProfile: the early change re-evaluates the history
    assert plate.valid and plate.bbox.size == (90.0, 50.0, 6.0)
    doc.export_3mf("plate.3mf"); doc.save("plate.hcasm")
```

- Every modelling call is exactly one canonical command (`doc.log`,
  `doc.commands`); the one macro, `Sketch.slot`, is three profile commands and
  says so. Selections (`FaceSet`/`EdgeSet`) filter client-side with
  CadQuery-flavoured helpers (`max("Z")`, `lines()`, `of_face(face)`,
  `filter(curve="circle")`, `.one()` raising with the candidates' names).
- Errors are `HimmelcadError` subclasses (`ReferenceNotFoundError`,
  `FeatureFailedError`, `ConflictError`, …) with `raw_code`, `hint`,
  `candidates`.
- No `bpy` emulation (PLAN §5): familiarity comes from CadQuery/build123d
  vocabulary (sketch → extrude → fillet with selectors), which maps 1:1 onto
  the history model and stays editable in the UI.

## Benchmark (evidence for PLAN §5)

Scripts: `apps/assembler/bench/tasks.py` (five parts), `run_bench.py` (runner).
Run from the repository root after `build:headless`:
`python apps/assembler/bench/run_bench.py` (outputs to
`D:\AgentWork\HimmelCAD-Asm-agentapi\bench`: `.3mf`, `.stl`, `.hcasm`,
`results.json`). Every volume is checked against a hand calculation (exact
B-rep; tolerance 1e-4, the clip 1e-3 because its opening is integrated
numerically), every bbox to 1e-3 mm. "Reopen" = a fresh headless process opens
the saved `.hcasm` (strict format validation, full re-evaluation, same volumes,
no feature errors). "Edit + undo" = a dimension of an early sketch is changed
with `feature.edit` (the whole later history must still evaluate and the bbox
must follow) and then undone. The Electron test (`test/electron/agentAccess.test.ts`)
additionally opens all five files in the **production app** through Agent
access, checks the History panel lists them, edits the first sketch and
reverts it with the app's Ctrl+Z.

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

Repair rounds (the scripts were written by the implementing agent against the
API, then run): 3 of 5 passed first time; 2 needed one fix each, both in the
script, not the API. Phone stand: `.one()` failed because the lip front and
the base front are coplanar and merge into one face — the error listed both
candidate names ("Extrude 2 side · plane -Y at 40, 50, 48.5", "Extrude 1 side
· plane -Y at 40, 0, 10"), which made the fix (`face("-Y and <Y")`) immediate.
Cable clip: the hand-calculated bbox ignored that the opening trims the ring
top (max y is √(7² − 2.5²), not 7).

What the benchmark does **not** show: token cost per part and comparison with
FreeCAD-Python/build123d on the same tasks (PLAN §5 asks for both; not
measured here), agents other than the implementing one, and slicer checks of
the 3MF files.

## Limits and open risks

- **Sketches are rectangles and circles.** No lines, arcs, constraints or
  dimensions as separate entities; a profile's parameters are its dimensions.
  An inclined phone rest or a true stadium profile is not expressible (the
  slot is a fused rectangle + circles). The parallel sketch-solver workstream
  will change `SketchFeature`: its `FEATURE_KIND_SCHEMAS.sketch` entry
  (closed schema) and the `sketch.*Profile` commands must follow at merge. The
  contract test that validates every demo feature against its kind schema is
  the tripwire.
- **Revolve/sweep/loft/pattern** come from the parallel features workstream;
  they are reachable generically (`feature.create {kind}` / `doc.create`) as
  soon as they are persisted kinds; schemas and Python helpers are one entry
  each.
- **Reference resolution while editing mid-history** uses the current
  (final) evaluation to fill signatures of _changed_ reference fields; keys
  are what bind, signatures are only the fallback, but a signature taken from
  a later state is less useful for re-binding.
- **Unsaved-work detection in the app** is conservative (any undoable change
  counts) because the project store's dirty flag only starts tracking after
  the first file action (`projectStore.ensureSubscription`) — a pre-existing
  gap worth fixing in the project store.
- **Feature ids** come from the store's shared counter
  (`feature-<kind>-<n>`); `loadDocument` does not reseed it, so after opening
  a file with high ids the UI path could in principle collide (the API path
  skips taken ids).
- **Agent `project.open` in the app** does not refit the camera.
- **Kernel busy**: API validation evaluations use the kernel's preview
  channel; a user dragging a tool preview supersedes them (retried up to 20
  times, then `busy`).
- **Python generator test**: `sdk/python/tests/test_generation.py` fails on
  this integration head independently of this work
  (`crates/himmelcad-core/src/canonical_document.rs` moved to
  `himmelcad-document` in 96ed326; the generator pins still point at it).
