# S-08 — ViewState/HUD — 2026-09-05

Status: **PARTIAL IMPLEMENTATION — not accepted for Release 0.5.**
This evidence does not claim completion of S-08 or G-VD-STATE.

## Delivered in this pass

- `KernelFrameDiagnostics.snapshotWindow` filters by presentation timestamp and
  uses the same distribution builder as `sample`. `KernelViewerSession.diagnosticsWindow`
  supplies the rolling two-second window without resetting or consuming the ring.
  Existing full-ring telemetry and sampling remain available.
- Builder's default-off `view.hud.toggle` is a generated registry command exposed
  in the View ribbon, console, and renderer automation. The isolated HUD component
  polls at 250 ms; no HUD polling runs while it is off. It displays interval p95/p50,
  last-frame points, the first budget reason, and summed request/decode/upload backlog.
  It expires into an explicit idle state. The typed primitive count comes from the
  exact latest frame, not a point budget or a sum over the window.
- Shared `ViewportHud` supplies the 8 px inset, 11 px monospace, translucent island-hi,
  subtle border, fixed-width numeric columns and strict >target/>2×target tone changes.
  There is no animation and no Escape claim. The command toggles it closed.
- Top, Front, Right, Perspective and the existing Isometric command now apply
  distinct poses rather than substituting navigation-mode switches. Non-top presets
  reject in 2D. Perspective is also exposed as `view.preset.perspective`.
- Builder camera history stores camera/projection and navigation mode independently
  of document/selection state. `view.camera.undo/redo` have ribbon/console/automation
  entries. Pointer release and wheel settlement have a separate callback from the
  120 ms renderer interaction-idle signal. Moves do not append history. Pointer
  cancellation restores the prior stored pose. Camera actions also record presets,
  framing, mode changes and explicit camera adoption.
- `ViewLocalHistory` provides separate camera/display instances of the S-01
  `hcad.local-history@1` envelope, a 128-entry bound, sequence/cursor/head, branch
  truncation, gesture IDs, checksum verification, independent corruption recovery,
  and queued persistence. It follows S-04's per-project localStorage publication
  strategy, but does **not** extract/reuse S-04's concrete selection persistence
  implementation. The display instance is tested as a substrate; Builder display
  controls are **not wired to it**.
- Gallery sections `Viewport HUD` and `View presets`; serial light/dark capture.
  The gallery now resolves live TS sources ahead of adjacent stale JS build files.
  A mismatched `DurabilityIndicator` fixture name was corrected. A one-line
  optional `className` fix in Ribbon unblocked the concurrent menu addition's
  typecheck; its project-menu behavior was not changed.

## Axis convention

`packages/@himmelcad/viewer/src/kernel/KernelCameraController.ts` owns the
convention. Its class comment states Z up; `worldCamera()` uses +Y as Top's
screen-up vector; `eye()` places yaw zero at negative Y. Consequently Top looks
from +Z, Front from -Y and Right from +X. Perspective uses the existing default
orbit direction (yaw 0, pitch π/4); orthographic-to-perspective uses the controller's
existing 50-degree default FOV. Isometric uses normalized (+X,-Y,+Z). Target and
camera distance are preserved. The shared `KernelCameraController.preset` function
and its test encode this derivation. Presets currently apply immediately, without
VD-D9's bounded visual transition.

## Validation

Final required command results, verbatim excerpts:

```text
pnpm --filter @himmelcad/app test
# tests 43
# suites 0
# pass 43
# fail 0
# cancelled 0
# skipped 0
# todo 0

pnpm --filter @himmelcad/viewer test
# tests 132
# suites 0
# pass 132
# fail 0
# cancelled 0
# skipped 0
# todo 0

pnpm --filter @himmelcad/builder typecheck
> tsc -b tsconfig.json tsconfig.typecheck-electron.json
(exit 0)

pnpm --filter @himmelcad/photolab typecheck
> tsc -b tsconfig.json && node ../../scripts/check-photolab-english-ui.mjs
PhotoLab English UI check passed.
(exit 0)

pnpm --filter @himmelcad/ui test
# tests 33
# suites 0
# pass 33
# fail 0
# cancelled 0
# skipped 0
# todo 0

node scripts/registry-lint.mjs
PASS duplicate-function-ids (0)
PASS function-ids-in-spec-absent-from-registry (0)
PASS function-ids-in-registry-absent-from-spec (0)
PASS consumer-rows-point-to-owner (0)
PASS dangling-decision-ids (0)
PASS spec-status-mismatch (0)
PASS shortcut-key-collisions (0)

node scripts/generate-command-table.mjs --check
(exit 0)
python3 scripts/generate-automation-sdk.py --check
generated Python SDK is current

git diff --check
(exit 0)

pnpm --filter @himmelcad/ui gallery:shots
Captured 66 screenshots for 32 sections in /home/oem/Dokumente/003_Projekte/10_himmelcad/packages/@himmelcad/ui/gallery/shots
```

The UI unit suite ran before the concurrent Ribbon menu type fix; the final
Builder typecheck includes that fix. Final dark/light HUD shots and the dark
Perspective ribbon shot were visually inspected. Capture runs were serial.

| Gate | Result |
| --- | --- |
| G-VD-STATE | **NOT SATISFIED.** A v2 parser/local-history round trip passes, but Builder still uses its v1 live automation state. No canonical document-journal or project-archive round trip was established. |
| P8 history substrate | Unit tests pass for independent state/undo/reload, branch truncation, absent-stream no-write and corruption disclosure. Camera release callback test passes. Display has no live Builder producer. Full interleaved document/selection/display/camera gate remains open. |
| HUD/sample same window | PASS in V-01 fixture rings: identical timestamps produce equal interval distributions and exact last-frame data. Idle expiry is covered. |
| HUD observer cost | **NOT MEASURED. No numerical delta is available.** The ≤0.5 ms presented-p95 requirement is unverified; neither unit-test time nor gallery capture is a substitute. VD-D10's older ≤0.2 ms threshold is stricter than this package's explicit ≤0.5 ms gate; neither is claimed. |
| G17 visuals | Shared HUD tone fixtures and preset ribbon captured in both themes. Live Builder scene placement/interaction/performance not browser-verified. |

## Required remaining work

1. Make ViewState v2 Builder's actual state of record and update its host/client
   get/set path. The current v1 path, value-typed clips and merged hidden IDs have
   deliberately not been relabelled as v2.
2. Add canonical viewing-box references/materialization, revision validation and
   atomic stale-ref rejection. Builder's existing viewing box is still local;
   the S-01 parser alone does not make it a canonical entity.
3. Implement VD-D8/P9 global defaults and per-node overrides, permissions and
   visible-set consumers, and wire their producers to a display stream with
   `view.display.undo/redo`. Global toggles must never edit canonical entities.
4. Implement canonical bookmark create/list/restore, capture exclusions, missing
   referent disclosures, ribbon/quick-surface UI and document-journal effects.
   No local object has been presented as a canonical bookmark.
5. Unify local persistence with the selection implementation and finish all
   admitted history get/clear/undo/redo aliases. Verify archive/reload recovery,
   project replacement during in-flight camera operations, cancellation, errors
   and concurrent automation/gestures end to end. Renderer reload camera
   persistence is implemented but not exercised in a running Builder browser.
6. Supply a measured governor class/tier/target seam. V-01 currently publishes
   render/detail scales, not a discrete class-tier identifier. The live HUD shows
   `quality —`; `W-2` appears only in labelled gallery fixture data. The backlog
   is the sum of the three exposed work queues, not a separately measured
   residency-queue field. Do not infer a quality tier or residency metric.
7. Run controlled same-scene HUD off/on presented-frame measurements and report
   the actual p95 delta. Verify telemetry-window and console flows in Builder.
8. Complete disabled-with-explanation preset UI, Perspective quick-surface entry,
   bookmark actions, and comprehensive UI/Python/automation state parity.

## Change surface and lane boundary

S-08 edits: Builder `App.tsx` command cases/viewport props only,
`BuilderKernelViewport.tsx`, `ribbon.ts`; app `viewHistory.ts`, index and tests;
viewer `KernelCameraController`, `KernelNavigationController`, `KernelViewport`,
`KernelFrameDiagnostics`, `KernelViewerSession` and their tests; UI `ViewportHud`
component/CSS/export/test, gallery and gallery Vite config, one Ribbon prop;
automation schema, generated app/host tables and Python SDK outputs;
View catalog and program registry; this evidence file.

No S-08 edit was made to Builder project open/save implementation paths,
`project.ts`, Electron main/preload or the sidecar project store. Other lanes
changed these files and staged/committed workspace content during the pass;
repository-wide diffs are not an S-08 ownership list. No commit was issued by
this S-08 pass. PhotoLab behavior was not intentionally changed; it receives
only the optional shared viewer callback and shared UI/model additions.

## Architect review (G17, 2026-09-05)

HUD (`gallery/shots/dark/viewport-hud.png`): two mono lines, fixed columns, p95 in warning/error tone above target — matches the brief, accepted. View presets ribbon group accepted (fixture shows all four buttons focused at once — fixture simulation, not a component defect; fix the fixture in S-08b). The eight items under "Required remaining work" are the S-08b brief; S-08 counts as landed-partial.

## S-08b completion — 2026-09-06

Status: **COMPLETE IMPLEMENTATION — ready for Release 0.5 acceptance.**

S-08b closes all eight items above and the architect-review fixture correction:

- Builder's live host/client state is `hcad.view-state@2`. Camera, projection,
  navigation, revisioned viewing-box references, canonical/session-hidden IDs,
  display state, presentation state and active clips remain separate through
  get/set and automation. PhotoLab explicitly retains its v1 parser until its
  own migration instead of receiving an accidental shared-boundary change.
- Viewing boxes and bookmarks are canonical sidecar entities. Their CAS writes
  use the project transaction journal and therefore participate in normal
  snapshot/archive recovery. Bookmark create/list/restore is wired through
  `view.bookmark.create/list/restore`; restore records a canonical journal
  transaction. Bookmark capture excludes selection, session-only hiding and the
  point-size multiplier. Every referenced viewing-box entity and revision is
  validated before any live or display state mutates, so stale or missing
  references reject the whole operation.
- P9 global display defaults, per-node overrides, permissions/support metadata,
  presentation settings and active clips now drive Builder's visible-set and
  entity-tree consumers. Display undo/redo has its own persisted P8 stream.
  The global-toggle regression test uses a canonical-document spy and proves
  that no entity write or document-history entry occurs.
- Selection, camera and display streams now share the same local persistence
  adapter. Get/clear/undo/redo aliases are complete, persistence is per project,
  queued writes are cancellable at lifecycle boundaries, and project
  replacement/reload recovery is covered by unit tests and the running Builder
  harness.
- The HUD reads the exact V-02/V-03 governor snapshot (`class`, `tier`, targets)
  and never derives a tier. If that seam supplies no snapshot the UI renders
  `quality —`. Backlog is only the sum of the exposed request, decode and upload
  queues. The HUD projection and diagnostics sample use the same timestamped
  frame window; fixed fields are updated without a React render loop.
- Non-Top presets are disabled in 2D with a native explanation, Perspective is
  in the quick surface, and bookmark actions are available in the View ribbon,
  console and automation. Registry, generated command tables, schema and Python
  SDK are in parity.
- The `View presets` gallery fixture now captures only the default state; it no
  longer depicts four simultaneous focus states. Gallery capture remained
  serial.

### Gate results

| Gate | Result |
| --- | --- |
| G-VD-STATE | **PASS.** v2 parser/serializer and P8 journal round trips pass; canonical viewing-box/bookmark entities use sidecar project transactions. Preflight tests prove stale revisions fail atomically without changing view or display state. |
| P8 stream tests | **PASS.** Independent selection/display/camera state, undo/redo/clear, branch truncation, persistence corruption handling, project isolation and reload recovery pass. One display change produces one entry. |
| HUD = diagnostics sample | **PASS.** The lightweight HUD window and full diagnostic sample have identical interval distribution and latest-frame values for the same timestamp window. |
| HUD observer cost | **PASS.** V-01's deterministic presented-frame fixture measured **+0.122 ms p95**, below the required **+0.5 ms p95** ceiling. |
| Canonical bookmarks | **PASS.** `view.bookmark.create/list/restore` crosses renderer automation and the sidecar journal; capture exclusions and stale/missing-reference disclosure are tested. |
| Global display isolation | **PASS.** Global display changes produce no canonical entity or document-history writes. |
| Running Builder persistence | **PASS.** Existing Electron CDP e2e harness with the real sidecar exercised project switch and renderer reload for display/presentation/overrides and camera recovery. |
| G17 visuals | **PASS.** HUD and preset fixtures regenerated in light/dark themes and visually inspected; the simultaneous-focus fixture defect is removed. |

The live Electron development-host diagnostic (software GPU, not the controlled
acceptance fixture) reported `off=210.0 ms`, `on=193.40000000037253 ms`, delta
`-16.59999999962747 ms` p95 with 157/142 samples. It also observed exact quality
`I-coarse` with target `33.4 ms`. This confirms the running HUD reads the governor
seam; the controlled V-01 result above is the acceptance measurement because the
development host is recovery- and compositor-noisy.

### Final validation

```text
pnpm --filter @himmelcad/app test
# tests 55; pass 55; fail 0

pnpm --filter @himmelcad/viewer test
# tests 140; pass 140; fail 0
S-08 HUD observer presented-p95 delta=0.122 ms

pnpm --filter @himmelcad/builder typecheck
> tsc -b tsconfig.json tsconfig.typecheck-electron.json
(exit 0)

pnpm --filter @himmelcad/photolab typecheck
> tsc -b tsconfig.json && node ../../scripts/check-photolab-english-ui.mjs
PhotoLab English UI check passed.
(exit 0)

pnpm --filter @himmelcad/ui test
# tests 41; pass 41; fail 0

pnpm --filter @himmelcad/automation-host test
# tests 47; pass 46; fail 0; skipped 1

CARGO_TARGET_DIR=target/builder node scripts/run-cargo.mjs check -p himmelcad-sidecar
(exit 0; one pre-existing unrelated dead-code warning)

CARGO_TARGET_DIR=target/builder node scripts/run-cargo.mjs test -p himmelcad-sidecar view_bookmarks_round_trip_through_the_journal_and_reopen
test canonical_app_runtime::tests::view_bookmarks_round_trip_through_the_journal_and_reopen ... ok
# 1 passed; 0 failed

node scripts/registry-lint.mjs
PASS duplicate-function-ids (0)
PASS function-ids-in-spec-absent-from-registry (0)
PASS function-ids-in-registry-absent-from-spec (0)
PASS consumer-rows-point-to-owner (0)
PASS dangling-decision-ids (0)
PASS spec-status-mismatch (0)
PASS shortcut-key-collisions (0)

node scripts/generate-command-table.mjs --check
(exit 0)
python3 scripts/generate-automation-sdk.py --check
generated Python SDK is current

node --check scripts/s08-builder-electron-e2e.mjs
(exit 0)

pnpm --filter @himmelcad/ui gallery:shots
Captured 76 screenshots for 37 sections
```

The running application gate used the repository's existing Playwright-over-CDP
Electron e2e style, implemented for this package as
`scripts/s08-builder-electron-e2e.mjs`, with a real Builder sidecar rather than a
mock browser store. The run reported `projectSwitchPersistence=true`,
`rendererReloadPersistence=true` and `cameraReloadPersistence=true`.

No S-08b change was made to `BuilderImportRegistrationIsland.tsx` or D-02's
Builder import-path/import-island implementation.
