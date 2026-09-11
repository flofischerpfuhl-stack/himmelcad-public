# R-02e — LandXML units, idle presentation, and progress coalescing (2026-09-11)

## Outcome

All three R-02e product corrections are implemented and exercised in the literal Builder desktop UI.

1. LandXML has an explicit Units selector. A new metric project defaults it to **Metre** from persisted source truth; unresolved or conflicting truth remains **Not set**, and planning then returns the typed refusal `LandXML export requires Units. Choose metre, feet, or US feet.` The accepted DGM plan displayed `Units: Metre`, wrote metric LandXML, and its re-import displayed `source units meter` before committing the TIN.
2. A settled kernel session no longer asks the host for another frame merely because adaptive quality remains below its maximum. The exact post-fix two-second V-01 sample contained zero presented frames; instantaneous process sampling was 0.0% for the Electron GPU process and 0.0% for both renderer processes after focus and a two-second settle.
3. Sidecar progress publication is coalesced centrally per `progressKey` at a 100 ms minimum interval. Phase changes, new/restarted jobs, and terminal progress bypass the interval. The strict New → import → draw → save → close/reopen sequence completed in one Electron process against the 103,713,735-point named LAS without a progress-event lockup.

The required PhotoLab dark visual harness remains **incomplete**, not green: its first R-02e attempt produced 42 captures and then hit the same pre-existing deterministic timeout recorded by V-08 while waiting for `Replace “Sparse Point Cloud”?` at harness line 569. No GPU-device or page error was emitted before the timeout. The executable PhotoLab typecheck, renderer, Electron, and contract suites all pass on the final shared-viewer state. No PhotoLab-owned file was changed.

## Finding → correction → evidence

### 1. Explicit LandXML linear units

- The shared export island now renders a labelled, accessible Units select when the active format is LandXML. Choices are `Not set`, `Metre`, `Feet`, and `US feet`.
- Builder resolves a default only from source declarations. It recognizes LAS WKT and GeoTIFF projected-linear-unit keys for metre, international foot, and US survey foot. Unknown and contradictory declarations remain unset rather than inventing coordinate truth.
- The selected value is sent through canonical export options as the exact LandXML units object and is repeated in the accepted-plan disclosure.
- The registration placement summary also reads canonical `hcad.landxml-import@1.document.units.linearUnit`; this made the round-trip unit visible to the user instead of incorrectly displaying `Not declared`.
- Rust round-trip coverage exports and re-imports `USSurveyFoot`, proving that the writer/reader contract preserves the choice independently of the metric literal replay.

Literal UI and file evidence:

- `.build/r02e/51-landxml-units-default.png`: the older R-02d project has no persisted source units, so the field honestly begins at `Not set`.
- `.build/r02e/52-unit-menu.png`: all four choices are visible.
- `.build/r02e/62-landxml-dgm-plan-metres.png`: the selection-scoped DGM plan is accepted and visibly says `Units: Metre`.
- `.build/r02e/64-landxml-exported.png`: the 1,736,039-byte export completed.
- `/home/oem/Dokumente/r02e-road-dgm.landxml.xml`: its header contains `<Metric linearUnit="meter"/>`.
- `.build/r02e/71-reimport-meter-verified.png`: the import review says `source units meter`.
- `.build/r02e/73-landxml-imported.png`: re-import committed one DGM surface.
- `.build/r02e/75-landxml-default-metre.png`: a fresh saved LAS project automatically defaults LandXML to `Metre` from persisted project/source truth.

The exported DGM came from the reopened boundary-first R-02d project. `Visible` scope initially and correctly refused because the viewing-box entity has no LandXML representation; selecting `DGM surface` and using `Selection` produced the one-output TIN plan with one disclosed metadata loss. No unsupported entity was silently discarded.

### 2. Rest-state frame governor

The previous continuation predicate treated a reduced adaptive-quality tier as unfinished work. Minimum-quality scenes could therefore request another frame forever even after all input, publication, and streaming activity ended. The kernel now continues only for an outstanding pick mapping or surface recreation. Camera motion, refinement timers, streaming transitions, entity mutations, resize, and other actual work already invalidate the host explicitly.

Measurements on the same Linux desktop lane:

| State | V-01 / HUD | Electron process observation |
| --- | --- | --- |
| R-02d baseline | backlog 0, 0.0 M points, p50 39.6 ms / p95 43.6 ms | GPU process about 422% CPU |
| R-02e before the final predicate correction | `.build/r02e/33-hud-settled-desktop.png`: backlog 0, HUD p50 211.3 ms / p95 216.3 ms | cumulative `ps` value about 350% for the GPU process |
| R-02e after correction and two-second settle | `.build/r02e/rest-sample-after.json`: `frames: 0`, `presentedFrameIntervalMs: null`, empty `lastFrames` | repeated instantaneous samples: GPU 0.0%; both renderer processes 0.0% after focus and settle |

The post-fix sample is the canonical idle-safe V-01 result: no frame exists in the sample window, rather than a fabricated low percentile. `.build/r02e/38-hud-focused-idle.png` shows the settled Builder/HUD state; the passive HUD retains its last non-empty historical window after rendering stops, so the JSON sample is the exact two-second ring evidence.

Viewer regressions cover the continuation decision, including a reduced-quality/no-work frame returning false and pending picks/surface recreation returning true. The viewer suite passes 166/166.

### 3. Per-job progress coalescing and strict process chain

`emit_progress` is now the single coalescing boundary before structured `__HC_PROGRESS__` messages reach Electron. Each job key stores its last phase, fraction, and emission time in a bounded 4,096-entry map. Same-phase progress is limited to one event per 100 ms; a phase change, fraction regression for a restarted job, or first terminal fraction is immediate. Internal tracing remains available but does not enter the renderer progress channel.

The focused Rust regression simulates 200 per-batch updates at 5 ms intervals: exactly 10 events are admitted in the first second, the next phase is immediate, and another update two milliseconds later is suppressed.

Strict literal sequence, without an Electron or renderer restart:

1. New created `/home/oem/Dokumente/r02e-strict.hcad` (`03-fresh-project.png`).
2. The named 103,713,735-point LAS was registered and committed (`09-import-registered.png`, `15-import-commit-progress.png`, `16-import-commit-later.png`). The full import took 693.6 s plus a 257.2 s project commit; the UI remained reachable and did not accumulate the R-02d progress flood.
3. Draw published `Line 1` from one picked and one typed vertex (`19-line-first-vertex.png`, `22-line-published-typed.png`).
4. Save reached `All changes stored` (`23-saved.png`).
5. The tool was cancelled, the project was closed, and Recent reopened the same path in the same process (`27-project-closed.png`, `28-recent-after-close.png`, `29-strict-reopened.png`). The point cloud and `Line 1` were restored.

## Boundary-first LandXML replay ledger

| Step | Result | Literal evidence |
| --- | --- | --- |
| Reopen boundary-first road project | Pass; 3 clouds and 3 inline meshes restored | `.build/r02e/45-open-r02d-location.png` |
| Open LandXML export | Pass; Units control visible | `.build/r02e/51-landxml-units-default.png` |
| Supply metre explicitly for legacy project | Pass | `.build/r02e/53-unit-metre-selected.png` |
| Scope exact DGM surface | Pass; unsupported viewing-box entity excluded explicitly | `.build/r02e/58-dgm-selected.png`, `.build/r02e/60-selection-scope.png` |
| Review accepted plan | Pass; one TIN output, `Units: Metre`, one disclosed metadata loss | `.build/r02e/62-landxml-dgm-plan-metres.png` |
| Export | Pass; 1,736,039 bytes | `.build/r02e/64-landxml-exported.png` |
| Re-import review | Pass; `source units meter` | `.build/r02e/71-reimport-meter-verified.png` |
| Re-import commit | Pass; one DGM surface | `.build/r02e/73-landxml-imported.png` |
| Fresh-project default | Pass; persisted metric source truth selects `Metre` automatically | `.build/r02e/75-landxml-default-metre.png` |

## Verification

| Gate | Result |
| --- | --- |
| `pnpm --filter @himmelcad/app test` | Pass, 80/80 (attempt 1) |
| `pnpm --filter @himmelcad/builder test` | Pass, 49/49 on final attempt 2; includes LandXML project-unit and import-provenance regressions |
| `pnpm --filter @himmelcad/ui test` | Pass, 49/49 on attempt 2; attempt 1 exposed an invalid closed-custom-select test expectation, which was corrected |
| `pnpm --filter @himmelcad/viewer test` | Pass, 166/166 on final allowed attempt 3; attempt 1 had no retained auditable exit, attempt 2 passed before the final continuation predicate, attempt 3 verifies the final state |
| `pnpm --filter @himmelcad/builder typecheck` | Pass on final attempt 2 |
| `pnpm --filter @himmelcad/photolab typecheck` | Pass on final attempt 2, including English UI check |
| `pnpm --filter @himmelcad/photolab test` | Pass on final attempt 2: renderer 87, Electron 10, contracts pass |
| theme token lint | Pass |
| `pnpm registry:lint` | Pass, all seven checks |
| `CARGO_TARGET_DIR=target/builder node scripts/run-cargo.mjs check -p himmelcad-sidecar --tests --bins -j 4` | Pass; one pre-existing `adaptive_job_concurrency` dead-code warning |
| focused sidecar progress regression | Pass, 1/1 |
| focused LandXML round-trip regression | Pass, 1/1 |
| focused LAS WKT unit regression | Pass, 1/1 |
| PhotoLab dark visual harness `--no-a11y --no-compare-baselines` | Incomplete/fail on attempt 1 at the pre-existing `Replace “Sparse Point Cloud”?` timeout; 42 captures produced, no GPU-device/page error before timeout; no identical retry spent |
| formatting / whitespace | Prettier pass, `cargo fmt --all --check` pass, `git diff --check` pass |

No gate was run more than three times. No repository or dataset copy was made, no commit was created, and no PhotoLab-owned path was edited.

## Changed surfaces

- `apps/builder/renderer/src/App.tsx`
- `apps/builder/renderer/src/BuilderExportIsland.tsx`
- `apps/builder/renderer/src/BuilderImportRegistrationIsland.tsx`
- `apps/builder/renderer/src/exportDisclosure.ts`
- `apps/builder/renderer/src/importDialogPolicy.ts`
- `apps/builder/test/exportDisclosure.test.ts`
- `apps/builder/test/importDialogPolicy.test.ts`
- `crates/himmelcad-io/src/landxml.rs`
- `crates/himmelcad-io/src/las_import.rs`
- `crates/himmelcad-sidecar/src/main.rs`
- `packages/@himmelcad/ui/src/ExportIsland.tsx`
- `packages/@himmelcad/ui/test/exportIsland.test.tsx`
- `packages/@himmelcad/viewer/src/kernel/KernelViewerSession.ts`
- `packages/@himmelcad/viewer/test/kernel-viewer-session-automation.test.ts`

The untracked `.claude/codex/ref-*` images and `run-grok*.sh` scripts predated this lane and were left untouched.
