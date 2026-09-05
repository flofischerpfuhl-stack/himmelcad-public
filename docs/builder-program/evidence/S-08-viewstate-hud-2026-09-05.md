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
