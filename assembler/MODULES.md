# HimmelCAD Assembler — modules (ADR 0032)

Status: phases A and B of the modular restructure done and integrated
(Block 7, 2026-10-01; plan in [ROADMAP-LATER.md](ROADMAP-LATER.md) §0).
Every domain module is migrated and the allowlist of known violations is
**empty** (157 at the start of phase A, 53 at its end, 0 after phase B).
This file is the design and the working contract for adding or changing a
module. The machine-readable module map is
[`apps/assembler/modules.json`](../apps/assembler/modules.json); the
allowlist
[`apps/assembler/module-allowlist.json`](../apps/assembler/module-allowlist.json)
may only shrink, so it stays empty. `pnpm check:assembler-modules` enforces
both; it also runs in `pnpm lint` and at the start of the Assembler `test`
script.

Decisions not repeated here: ADR 0032 (module architecture, dependencies
point downward, domain modules register themselves, products are
compositions) and ADR 0033 (Assembler is its own product with its own
document authority and dependency graph; shared UI/theme packages stay
shared).

## 1. Package form: folders inside `apps/assembler`, not workspace packages

Assembler modules are **folders with registration files** inside the one
app package, not `packages/@himmelcad/assembler-*` workspace packages.
Reasons, measured against the four builds and the test runner the app has:

| Concern                     | Folders (chosen)                                                                                                                             | Workspace packages                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck / build speed     | One `tsc` program per target as before (renderer, headless, tests, electron); a warm renderer typecheck takes ~13 s.                         | ~20 more `tsc -b` projects with declaration emit and `references`; every package needs `.d.ts` output before its dependants build.                |
| Test runner                 | `tsconfig.test.json` compiles tests and sources into `.build/tests` with relative imports; unchanged apart from the preload (§3).            | Tests would import compiled packages; each package must be built before the test build, or use TS-source `exports` that `node --test` cannot run. |
| Vite (renderer + 4 workers) | `new Worker(new URL('./x.worker.ts', import.meta.url))` and CSS modules work anywhere in a module folder (the print module owns its worker). | Works with TS-source `exports`, but workers inside packages need `optimizeDeps`/`fs.allow` care.                                                  |
| Headless CLI                | `tsc -p tsconfig.headless.json` follows relative imports into the renderer sources and emits runnable JS.                                    | Node cannot run TS-source packages; the CLI would need a bundler or all packages prebuilt.                                                        |
| Electron build              | Unaffected (CommonJS `electron/` has its own program).                                                                                       | Unaffected.                                                                                                                                       |
| Boundary enforcement        | `scripts/check-assembler-modules.mjs` on files, with Builder's import scanner and allowlist discipline.                                      | `check-module-dependencies.mjs` on packages plus `package.json` declarations.                                                                     |

The layout keeps lifting a module into a package later (for example for
`apps/assembler-web`) mechanical: one folder per module, registration files
with fixed names, and the check already forbids every import a package
boundary would forbid. Revisit when a second product needs a composition
that one package cannot serve.

## 2. Layers and modules

Bottom-up. A module may import modules of lower layers; inside foundation,
platform and interface only modules listed **above** it in the same layer;
domain modules never import each other. npm packages are owned too: only
`geometry-kernel` imports `replicad`/`replicad-opencascadejs`, only
`sketch-solver` imports `@salusoft89/planegcs`, foundation imports no React,
Lucide or Electron, only files under `electron/` import Electron.

```text
product     app (desktop renderer)  ·  headless (CLI)  ·  desktop-host (Electron)  ·  web (PWA)
interface   agent-api  <  shell-ui
domain      sketching · modeling · direct-edit · construction · parameters · measure ·
            canvas · display · interop · templates · print · printers (no domain → domain)
platform    input  <  viewport  <  widgets                            (+ @himmelcad/hardware-profile, shared)
foundation  host  <  jobs  <  document  <  sketch-solver  <  geometry-kernel  <  commands
```

| Module          | Layer      | Owns                                                                                                                                                                                                                                                                                                                      | Folder                                      |
| --------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| host            | foundation | The **platform host contract** (`host.ts`: project files, recent projects, recovery, window lifecycle, slicer hand-off, agent transport), the desktop bridge adapter and the plain-browser fallback; `host()`/`installHost()`; products install theirs.                                                                   | `renderer/src/foundation/host`              |
| jobs            | foundation | `SingleJobWorker`: one job at a time, cancel = terminate the worker, progress, inline fallback for tests/headless. Later: budgets, timeouts.                                                                                                                                                                              | `renderer/src/foundation/jobs`              |
| document        | foundation | Value types and references (faces, edges, planes, axes, profiles), the **feature-kind registry** (`featureKinds.ts`), the nine core kinds the evaluator implements (`document.ts`, `coreKinds.ts`), parameters and the formula parser, `.hcasm` format with **registrable migrations**, validation helpers, persistence.  | `renderer/src/foundation/document`          |
| sketch-solver   | foundation | Sketch data model and the `sketch` kind (`sketchFeature.ts`: type, validator, v1→v2 migration), planeGCS (worker + in-process), regions, projections, dimension values, text outlines.                                                                                                                                    | `renderer/src/foundation/sketch-solver`     |
| geometry-kernel | foundation | The only place that imports OCCT: adapter, worker runtime, evaluator with the **per-kind evaluator registry** (`features/registry.ts`), prefix cache, naming, tessellation, STEP/IGES/mesh-solid exchange, mesh writers (STL, 3MF), OCCT module loader (`headless/occtModule.ts`), datum resolution, kernel time budgets. | `renderer/src/foundation/geometry-kernel`   |
| commands        | foundation | The command gate: application store core with **installable slices** (`store.ts`), command registry (`registry.ts`), shortcuts, pick sessions, the module contract (`module.ts`), the agent-API contract kit and **method registry** (`api/`), notices, items (body names/folders), reference meshes, the demo document.  | `renderer/src/foundation/commands`          |
| input           | platform   | Pointer model (mouse/touch/pen samples, drawing roles, pen presence and palm rejection), touch gesture and pen stroke recognizers, tablet layout state and device probe, mouse navigation presets and pen modifiers, the user preferences store, snap switches ([TOUCH.md](TOUCH.md)); later SpaceMouse.                  | `renderer/src/platform/input`               |
| viewport        | platform   | WebGL2 renderer, scene, camera, picking, selection, grid, display-mode rendering, the **overlay host** (`overlays.ts`) and the camera channel (`cameraChannel.ts`).                                                                                                                                                       | `renderer/src/platform/viewport`            |
| widgets         | platform   | The building blocks module UIs share (panel and History-card styles, expression fields with name completion, anchored menus) and the **UI half of the module contract** (`moduleUi.ts`).                                                                                                                                  | `renderer/src/platform/widgets`             |
| sketching       | domain     | **Migrated.** Sketch mode: session, drawing tools, inference, sketch commands, overlay, chrome, History card, sketch agent API.                                                                                                                                                                                           | `renderer/src/modules/sketching`            |
| modeling        | domain     | **Migrated.** Solid features (extrude … thicken, print parts) with kinds, evaluators, tools and tool sessions, History cards, handles, API kind schemas.                                                                                                                                                                  | `renderer/src/modules/modeling`             |
| direct-edit     | domain     | **Migrated.** Offset Face (value modes), Delete Face, Move Edge, Move Face (any direction).                                                                                                                                                                                                                               | `renderer/src/modules/direct-edit`          |
| construction    | domain     | **Migrated.** Construction planes and axes.                                                                                                                                                                                                                                                                               | `renderer/src/modules/construction`         |
| canvas          | domain     | Reference images (Shapr3D canvas, Block 8): the `referenceImage` kind (no geometry), the project's pictures (`images` file field), Add › Image… and Calibrate Image, viewport quads (`ImageBatch`), History card, calibration overlay, `image.*` API.                                                                     | `renderer/src/modules/canvas`               |
| parameters      | domain     | **Migrated.** Parameter edits (plan/commit), the store slice, Parameters panel, parameter API methods.                                                                                                                                                                                                                    | `renderer/src/modules/parameters`           |
| measure         | domain     | **Migrated.** Measure mode, pinned measurements, panel, overlay, measure API.                                                                                                                                                                                                                                             | `renderer/src/modules/measure`              |
| display         | domain     | **Migrated.** Appearance/colour, display-mode and section commands and menus, visibility commands, analysis legend, image export, persisted view display.                                                                                                                                                                 | `renderer/src/modules/display`              |
| interop         | domain     | **Migrated.** Import/export UI and parsers (STEP structure UI, IGES, DXF, STL, 3MF, OBJ), mesh→solid flow, import worker, interop API. OCCT only through the kernel adapter.                                                                                                                                              | `renderer/src/modules/interop`              |
| templates       | domain     | **Migrated.** Home-screen project templates.                                                                                                                                                                                                                                                                              | `renderer/src/modules/templates`            |
| print           | domain     | **Migrated.** Printability analysis, orientation, placement, STL export options, Print mode panel/toggle/overlays, print API, its worker.                                                                                                                                                                                 | `renderer/src/modules/print`                |
| printers        | domain     | **Migrated.** Slicers: store, 3MF hand-off, Slicers… dialog, commands (desktop side `electron/slicer*.ts`); later printer profiles, build volumes, direct send with own safety rules.                                                                                                                                     | `renderer/src/modules/printers`             |
| agent-api       | interface  | `hcasm.agent-api@1` session and dispatch, the composed schema document (`schema.ts`), JSON-RPC framing, feature builders, in-app endpoint bridge.                                                                                                                                                                         | `renderer/src/interface/agent-api`          |
| shell-ui        | interface  | Layout, docks, the panel/mode-button/History-card hosts, History and Items panels, command search, menus, dialogs, project lifecycle UI, workspace state.                                                                                                                                                                 | `renderer/src/interface/shell-ui`           |
| app             | product    | Desktop renderer composition: `composition.ts`, `uiComposition.ts`, `kernelModules.ts`, `kernel.worker.ts`, `main.tsx`, dev tooling.                                                                                                                                                                                      | `renderer/src/app`, `renderer/src/main.tsx` |
| headless        | product    | `assembler-headless`: CLI composition and the kernel thread (`kernelThread.ts`, `threadKernel.ts`, time budget).                                                                                                                                                                                                          | `headless/`                                 |
| web             | product    | `apps/assembler-web`: the PWA composition (same modules, UI parts and workers as `app`), the web host, service worker, update/offline chrome ([WEB.md](WEB.md)).                                                                                                                                                          | `../assembler-web/src`                      |
| desktop-host    | product    | Electron main/preload.                                                                                                                                                                                                                                                                                                    | `electron/`                                 |

Deliberate narrowing of ADR 0032 for Assembler (ADR 0033 allows its own
graph): Builder's command gate sits above the domain modules; in Assembler
the **registries** (commands, API methods, feature kinds, evaluators, store
slices) are foundation so that domain modules can register into them, and
the product composition installs the modules. Domain modules may use
platform modules (their panels draw with widgets, their overlays go to the
viewport host); platform modules never use a domain module. Services that
code below the shell needs from the shell (the notice toast, camera
requests) are sinks the shell installs (`commands/notices.ts`,
`viewport/cameraChannel.ts`).

**Hardware profile.** `@himmelcad/hardware-profile` (shared, foundation in
Builder's map) offers the Electron renderer-fallback controller, Chromium
launch switches, rendering status and the quirk registry — written for a
WebGPU/WebGL2 viewer in an Electron host. Assembler uses it since phase B
for the **GPU tier** of the display module: `modules/display/gpuTier.ts`
describes the viewport's WebGL2 adapter as `ViewerRenderingFacts` (a
SwiftShader/llvmpipe/WARP renderer string = software, fallback adapter),
`gpuProbe.ts` (desktop only, installed by `display/module.ui.ts`) derives
the `RenderingStatus` with `deriveRenderingStatus` and, on a software
rasterizer, starts the session at `standard` render quality unless the user
chose a quality (`Preferences.renderQualityChosen`); the preset is never
stored as a choice. The renderer imports the package only from desktop UI
files (the headless and test programs compile relative imports only; tests
import its types).

Still open (phase C, desktop-host): `deriveChromiumLaunchSwitches` and
`RendererFallbackController` in `electron/main.ts`, the Chromium feature
status over IPC so hardware tiers are confirmed rather than `unknown`, and
`deriveRenderingStatus` in the status strip.

**Proposed addition to the shared package (not implemented; additive, no
change for Builder or PhotoLab):** what Assembler needs most is a
_compute_ budget per machine class for OCCT in WebAssembly, which the
package does not model yet (`computeBudgetScale` in the quirk registry is
the only compute knob; the package and the Rust crate
`himmelcad-hardware-profile` validate it, no consumer applies it). Proposal:

```ts
/** Facts the host knows about the machine (Electron main or renderer). */
export interface ComputeFacts {
  readonly os: HardwareOperatingSystem;
  readonly logicalCores: number; // navigator.hardwareConcurrency / os.cpus()
  readonly deviceMemoryGiB: number | null; // os.totalmem() or navigator.deviceMemory
  readonly wasm64: boolean; // memory64 available
  readonly quirks: readonly HardwareQuirkRule[]; // computeBudgetScale applies
}

export interface ComputeBudget {
  readonly tier: 'low' | 'standard' | 'high';
  /** Upper bound for one WebAssembly heap (OCCT kernel, solver), MiB. */
  readonly wasmHeapMiB: number;
  /** Background workers that may run at once (kernel, import, print, solver). */
  readonly workerSlots: number;
  /** Multiplier for per-job timeouts (kernel evaluation, tessellation). */
  readonly timeoutScale: number;
}

/** Pure policy, unit-tested in the package: facts -> budget. */
export function deriveComputeBudget(facts: ComputeFacts): ComputeBudget;
```

Assembler would read it in `foundation/jobs` (worker slots, job timeouts
for `SingleJobWorker`) and in the kernel worker's module loader (heap
ceiling, clear "model too large for this machine" errors instead of an
out-of-memory abort); Builder can adopt it for its sidecars later. Until
then Assembler's workers keep their fixed sizes.

## 3. Registration contracts

A module never edits a central file to add a feature kind, command, API
method, panel, History card, overlay or runtime wiring. It declares them in
fixed files of its folder; the product compositions install them.

| File in `modules/<id>/` | Declares                                                     | Contract (where)                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kinds.ts`              | Its feature kinds: type + `.hcasm` validator + label + rules | `declare module '…/document/featureKinds.js' { interface FeatureKindMap { hole: HoleFeature } }` and `registerFeatureKind({ kind, module, label, validate, sketchIdsUsedBy?, expressionFields?, signedExpressionFields?, booleanResult? })` (`document/featureKinds.ts`); file migrations with `registerFormatMigration(fromVersion, step)` (`document/format.ts`). |
| `kernel.ts`             | Evaluators of its kinds                                      | `defineKernelModule({ id, featureEvaluators: { hole: applyHole } })` with `(feature, ctx: ReplayContextLike, kit: FeatureKit) => void` (`geometry-kernel/features/registry.ts`). Uses OCCT only through `FeatureKit` and geometry-kernel exports.                                                                                                                   |
| `module.ts`             | Everything that runs without a UI (app, headless CLI, tests) | `defineAssemblerModule({ id, commands: [{ order, commands }], api, storeSlice, onInstall, install })` (`commands/module.ts`).                                                                                                                                                                                                                                       |
| `module.ui.ts(x)`       | Desktop UI parts                                             | `defineModuleUi({ id, panels, modeButtons, historyCards, viewportOverlays })` (`platform/widgets/moduleUi.ts`).                                                                                                                                                                                                                                                     |
| `index.ts`              | Public API for tests and products                            | Plain re-exports.                                                                                                                                                                                                                                                                                                                                                   |

The parts in detail:

- **Command** — `Command` as before (`id, label, group, shortcut, shortcutScope, keywords, requiresKernel, adaptive, availability, run`); shortcuts are part of the command. Blocks from all modules are merged by `order` (`COMMAND_ORDER` in `commands/registry.ts` lists the orders in use), which is the adaptive-toolbar and search tie-break, so the published order stays stable. Ids are unique; a second registration throws.
- **API** — `api: { methods: [{ order, methods: { 'print.analyze': { spec, handler } } }], defs: [{ order, defs }], featureKinds: [{ order, kinds }] }` (`commands/api/registry.ts`, orders in `API_ORDER`). A handler is `(ctx: ApiContext, params, method) => unknown` on the session services (`commands/api/contract.ts`: scoped reads, `write` = kernel-validated commit or transaction staging, `evaluate`, `exportMeshes`, `deliver`, `readFile`, errors …). A module adds host services by augmenting `SessionHostExtensions` (see `modules/print/api.ts`). `test/api/contract.test.ts` keeps the published schema byte-identical with `api/agent-api-v1.schema.json`.
- **Store slice** — `storeSlice: (set, get, core) => ({ … })` plus `declare module '…/commands/store.js' { interface AssemblerStateExtensions extends MySlice {} }`. `core` offers `commitDocument` (one undo step through the tools' commit path), `seedEvaluation`, `evaluateCheck` and `hasKernel` (`StoreCore` in `commands/store.ts`). Document state that belongs in undo snapshots stays in the core.
- **`onInstall`** — registration-time hooks into the gate (the sketch-session probe of pick sessions, the shell's notice and camera sinks); runs wherever the module is installed.
- **`install(host)`** — runtime wiring with `{ kernel, workers }` (workers, kernel adapter); runs only in the desktop renderer (`startModules` in `main.tsx`).
- **UI** — panels in the `rightStack` (below the right dock, ordered, with `isOpen(state)`) or as `overlay` (floating chrome and dialogs that hide themselves); `modeButtons` in the left dock's mode group; `historyCards` (feature kinds → editor of the expanded History card); `viewportOverlays` (`{ id, order, batches(input), subscribe? }` GL batches drawn after the bodies).

Added in phase B (agent A, sketching/construction/templates):

- **Draft tools** (`foundation/commands/draftTools.ts`) —
  `defineAssemblerModule({ draftTools })` with `defineDraftTool({ module,
kinds, createDraft, acceptPick, toFeature, meta, badges?, handles?,
guides?, modifiedBodyIds? })`; the draft types come in through a
  `declare module '…/commands/draftTools.js' { interface DraftToolMap { … } }`
  augmentation. The generic feature tool delegates every registered kind.
- **Datums** (`foundation/geometry-kernel/datums.ts`) — `planeRefFrame`,
  `planeRefPlane`, `constructionAxisLine`, `datumRef`, `referencedDatumIds`;
  every module reads construction planes/axes through these;
  `validateAxisRef` joins `validatePlaneRef` in `document/validation.ts`.
- **Sketch usage** (`foundation/document/sketchUsage.ts`) —
  `consumedSketchIds` (from the kind registry) and
  `derivedSketchId`/`parseDerivedSketchId` (Mirror's sketches).
- **Project templates** — `defineAssemblerModule({ projectTemplates })`,
  `foundation/commands/projectTemplates.ts` (`projectTemplates()`,
  `projectTemplate(id)`); the Home screen lists the registry.
- **Handler-only API contributions** (`ApiContribution.handlers`, removed in
  the integration — see below). `ApiContext` gained `findFeature` and
  `validateStored`.
- **Viewport DOM overlays and modes** (`platform/viewport/domOverlays.ts`) —
  `defineModuleUi({ viewportDomOverlays, viewportModes })`: React overlays
  with a `ViewportDomHost` (host element, pose, camera animation, redraw
  flag, ray/pick/project at a point) and modes (`hiddenFeatureIds`,
  `ownsKeyboard`, `openOnDoubleClick`). Sketching registers both, measure
  its overlay.
- **Live grid step** (`platform/viewport/liveGrid.ts`) — `useLiveGrid`,
  `publishLiveGridStep`.

Added in phase B (agent C, interop/measure/display):

- **`fileFormatFields`** — project-level data besides the features, in two
  halves. File side (`document/format.ts`): `registerProjectFileField({ key,
module, order, validate, include? })` for a top-level field (typed by
  augmenting `ProjectFileFields`; strict validator, a problem rejects the
  whole file) and `registerViewStatePart({ key, module, order })` for a part
  of the lenient `viewState` (typed by augmenting `ProjectViewState` /
  `ProjectSectionView`); `saveProjectFile` writes both in registered order,
  so the bytes stay as before (`test/model/project/fileFields.test.ts`).
  Runtime side (`document/projectSections.ts`): a `ProjectSection` with
  `save()` (fields and view-state parts, merged in section `order`),
  `load(project | null)` and `subscribe(onChange)` (unsaved flag), listed in
  `defineAssemblerModule({ fileFormatFields })`. In use: `referenceMeshes`
  (field order 100) and `items` (300, section 150) in
  `commands/projectFields.ts`; `viewState` itself is core (200); view-state
  parts displayMode 100 / display 110 (display), camera 200 / section 300 /
  grid 500 / panels 600 (the store; section 100 in the project store),
  measurements 400 (measure), savedViews 700 (shell-ui); `images` (field
  order 110, section 140) of the canvas module. The project store
  (`shell-ui/project/projectStore.ts`) only collects and applies sections.
- **`api.handlers`** for interop's and measure's methods (since the
  integration their specs and handlers are `api.methods` blocks).
- **Project persistence** (`document/projectPersistence.ts`) — the open
  project's lifecycle (unsaved flag, open/new/text, `requestOpen` with the
  unsaved-changes dialog) for code below the shell; the shell installs the
  project store's `PROJECT_PERSISTENCE`. Agent-api's app session host and
  interop's dropped `.hcasm` use it.
- **`ModuleUi.install`** (`platform/widgets/moduleUi.ts`) — desktop-only
  wiring that needs the browser, run once by `installModuleUis` (display's
  GPU probe).
- `COMMAND_ORDER.measureTools` (1150) — Pin measurement / Measure points,
  right after the display block they used to end.

Added in phase B (agent B, modeling/direct-edit, and the `store.ts`/`Viewport.tsx` wave):

- **Tool sessions** (`commands/store.ts`) — `ToolSessionMap` (augmentable;
  the core keeps `feature` and `pick`) and `registerToolKind({ kind,
provisional, commit, emptyClickFinishes })`: the core runs the shared
  lifecycle (kernel preview, kernel-checked Done, Cancel), the kind says
  what it previews and commits through a `ToolCommit`. `StoreCore.tools`
  (`endPreview`, `updatePreviewTool`) for the module's slice actions.
  Modeling's Extrude, Fillet/Chamfer, Shell, Boolean and Move/Rotate live in
  `modules/modeling/tools.ts` (sessions + slice).
- **Generic feature tool** (`commands/featureDrafts.ts`) — the dispatcher
  over A's draft-tool registry (`draftTools.ts`); every kind (modelling,
  print-part, direct-edit, construction) is a registered `DraftTool`.
  Optional hooks added by augmentation: `picksSketchLines`,
  `ghostsModifiedBodies`, `acceptEmptyClick`. `featureToolCommand.ts`
  builds a tool's command from its draft.
- **Viewport tool provider** (`platform/viewport/toolViews.ts`,
  `ModuleUi.viewportTools`) — per tool session kind: `view` (body/sketch
  transforms, accents, ghosts, handles, arrow, gizmo, datum highlights,
  sketch-line picking, typed values, value labels), `beginDrag`,
  `applyHandleValue`, `click`. The feature tool's view comes from the
  drafts (`featureToolView.ts`). `section.ts` holds `AxisHandle` and the
  section plane, `commands/viewBounds.ts` the visible bounds.
- **Viewport hooks** (`platform/viewport/viewportHooks.ts`,
  `ModuleUi.viewportClicks`/`viewportDatums`) — clicks while no tool runs
  (Measure › Points, Section › Face, History "Fix…") and extra scene datums
  (the Fix ghost); `setViewportShell` (installed by the shell's UI part)
  hands over camera commands, Select Through, Save View and the pose probe.
  DOM overlays and modes are A's `domOverlays.ts` (sketch overlay, measure
  overlay).
- **Icons** — `ModuleUi.featureIcons`/`commandIcons`; the shell's
  `icons.ts` falls back to them.
- **Smaller contracts** — `geometry-kernel/features/occtApi.ts` (the
  replicad surface for module evaluators), `geometry-kernel/edgeCurves.ts`,
  `document/sketchVisibility.ts` (consumed sketches from the kind
  registry), `document/blendOptions.ts` `PRINT_CLEARANCES`,
  `registry.ts` `registeredCommand`, `COMMAND_ORDER.directEdit` /
  `modelingFeaturesTail` and `API_ORDER.featureKinds.{modeling,
construction, modelingTail, directEdit}` (published orders unchanged).

Added in Block 8 (model stream, branch `asm/b8-model-20261001`):

- **Draft-tool hooks** (`commands/featureDrafts.ts`): `steps(draft)` — input
  steps with a Next button and clickable step badges in the pill (Translate,
  Rotate Around Axis, Align; clicks go to the current step), dispatched by
  `draftSteps`; `namePrefix(draft)` — the History name of the committed step
  when it is not the kind's label (a `primitive` step is "Box 1"), read by
  the store's commit (`draftNamePrefix`).
- **Handle unit `ratio`** (`draftTools.ts`, `viewport/toolViews.ts`): a plain
  number chip without unit or rounding (scale factor, helix turns).
- **Angle snap per handle** (`viewport/scene.ts` `AngleHandleState.snapDeg`):
  an arc handle may snap finer than the gizmo's 15° (the extrude taper: 1°).
- **Pick plans of module commands** (`commands/pickSession.ts`
  `registerPickPlan`, `acceptAnyBody`, `normalizeToBody`): a module registers
  the tool-before-selection plan of its own command (Scale) instead of
  editing the core table.
- `COMMAND_ORDER.primitives` (430) — the Add menu's primitives (modeling),
  between the modelling features and Construct.
- The OCCT build adds `BRepBuilderAPI_GTransform` (`occtExtras.ts`
  `gTransformClass`, detected on its own; `features/occRigid.ts`
  `scaleShape`), and `features/taper.ts` offers `draftFaces` (several faces
  tilted in one `BRepOffsetAPI_DraftAngle`, keys kept through its history)
  to the extrude taper and direct-edit's Move Edge / Move Face.

Settled in the integration (Block 7):

- **API methods are spec + handler, in the owning module.** The
  `ApiContribution.handlers` stop-gap is gone. The core blocks of
  `agent-api/schema.ts` are split where module methods sit between them
  (`API_ORDER.methods`: coreHead 100 · sketchesList 110 (sketching) ·
  datumsList 120 (construction) · coreSelection 130 · parameters 200 ·
  measure 250 · coreFeatures 300 · sketchEdits 310 (sketching) · coreTail
  320 · importStep 330 (interop) · coreProject 340 · print 400 · interop
  500; `$defs`: … coreMid 120 · measure 122 (`MeasureTarget`) · coreSketch
  124 …), so the published schema is byte-identical. What stays core: the
  methods the session implements (document reads, `feature.*`,
  transactions, undo/redo, the STL/3MF/STEP/IGES exports, `project.*`) and
  the shared `$defs` (references, selectors, the sketch data the core
  `sketch` kind uses). `registerApiContribution` checks every name before it
  changes anything; a duplicate throws and leaves the registry as it was.
- **Kernel time budget** (F13, `geometry-kernel/timeout.ts`): a
  `KernelTimeoutError` from any handler — the session's own or a module's —
  is answered as `kernelTimeout` (−32016); module handlers rethrow it rather
  than wrapping it.

Added in Block 8 (touch and pen, [TOUCH.md](TOUCH.md)):

- **Viewport modes take finger input** (`platform/viewport/domOverlays.ts`):
  `ViewportMode.tap(tap)` and `boxSelect(box, additive)` — a navigating
  finger's tap or long-press box while a mode runs (sketch selection);
  `ViewportDomHost.adoptTouches(touches)` hands fingers a DOM overlay had to
  the viewport's gesture navigation.
- **`SketchState.runTool(kind, inputs, options)`** (`modules/sketching/session.ts`):
  runs a fresh drawing tool over tool events (or functions of the sketch at
  that point) without touching the active tool, adopted as one solved edit;
  pen strokes create geometry through it (`penStrokes.ts`).
- **`@himmelcad/hardware-profile` `deriveInputProfile`** (additive): device
  facts → touch primary/secondary/none, minimum target and pick radius; read
  by `platform/input/deviceProbe.ts` (UI products only, like the GPU probe).
- **Value fields declare the touch keypad**: `data-hc-keypad="number|expression"`
  and `data-hc-keypad-units` on inputs (`platform/widgets/NumericKeypad.tsx`);
  plain `inputmode="decimal"` inputs get the number layout.

Added in the navigation block (2026-10-01, [SELECTION-NAVIGATION.md](SELECTION-NAVIGATION.md)):

- **`ViewportMode.drawingPlaneNormal()`** (`platform/viewport/domOverlays.ts`):
  the plane a running mode draws on (sketching: the open sketch); the
  viewport hides the world axis out of it and Adaptive shows it in parallel
  projection. `modeDrawingPlaneNormal()` reads it.
- **Projection policy** (`platform/viewport/projection.ts`, pure) and the
  pivot rules (`platform/viewport/orbitPivot.ts`, pure); camera math in
  `camera.ts` (`withFovAt`, `orbitAbout`, `zoomAtRay`, `pointAtViewDepth`).
- **Id pass depth**: the picking framebuffer has a second colour attachment
  with the packed window depth (`gl.ts` `readPickDepthWindow`); every id
  program writes both outputs.
- **`Command.checked`** (a mode in effect: menus show a check) and
  **`Command.separatorBefore`** (menus draw a separator above it) in
  `commands/registry.ts`; `CommandGroupMenu` renders both.
- Shared `@himmelcad/ui` `Button` marks its size (`data-size`), so a
  product's tablet layout can size small buttons (additive; Builder and
  PhotoLab unchanged).

Compositions (`renderer/src/app`):

- `composition.ts` — the module list; `installModules` at import. Imported
  first by `main.tsx`, `headless/cli.ts` and `test/setup.ts`.
- `uiComposition.ts` — the modules' UI parts (`installModuleUis`); desktop only.
- `kernelModules.ts` — the kernel side: every kind-owning module's
  `kernel.ts` (which imports its `kinds.ts`, so the kernel has the same kind
  definitions as the main thread) and the `sketch` kind. Loaded by
  `kernel.worker.ts` (the app's kernel Web Worker; the name is load-bearing
  for the CSP rules in `electron/main.ts` and `vite.config.ts`), by
  `headless/kernelThread.ts` (the CLI's and the fuzzer's kernel thread,
  started with `execArgv: []` so a parent's `--import` preload does not leak
  in), by `test/setup.ts` (the in-process test kernel) and by
  `test/setupKernel.ts` (`bench:kernel`). `test/kernel/kernelTimeout.test.ts`
  checks that the thread registers the same kinds and evaluators as the app.
- `startModules` (`install(host)`) runs in the desktop renderer only;
  headless and tests reach the kernel through the API context.
- Tests: every test, fuzz and bench script preloads `test/setup.ts` with
  `node --import`, so each test process has the product's registrations.

## 4. Where files are

`modules.json` is authoritative: every file under `renderer/src`,
`headless` and `electron` belongs to exactly one module by longest path
prefix. All domain modules are migrated; `renderer/src` holds only `app`,
`foundation`, `platform`, `modules` (the domain layer) and `interface`, and
the allowlist is empty (`check:assembler-modules`: 0 violations).

## 5. How to move a module (phase B checklist)

1. Read this file, `modules.json` and your module's entries in
   `module-allowlist.json` (`node scripts/check-assembler-modules.mjs --report`).
   Use `modules/parameters`, `modules/print` and `modules/printers` as
   reference implementations.
2. Move files with `node apps/assembler/scripts/move-files.mjs <map.json>`
   (`{ "old/path.ts": "new/path.ts", "old/dir/": "new/dir/" }`, paths relative
   to `apps/assembler`): git-moves them and rewrites every relative import,
   `import()`, `import('…')` type, `declare module` augmentation and
   `new URL(…, import.meta.url)` worker URL in the app, its tests and the
   allowlist. When you move a declaration between files, fix its importers
   with `node apps/assembler/scripts/move-exports.mjs <old> <new> A,B`. Never
   edit import paths by hand.
3. Replace each central edit with a registration (§3): feature-kind union →
   `FeatureKindMap` augmentation + `registerFeatureKind` in `kinds.ts`;
   evaluator switch → `featureEvaluators` in `kernel.ts`; `.hcasm` validator
   branch → the kind's `validate`; entries in `agent-api/schema.ts` → `api`
   blocks with the **same `order`**; `case` in `agent-api/session.ts` → an
   `api` handler on `ApiContext`; commands in a shared list → `commands`
   blocks with the **same `order`**; state/actions in `commands/store.ts` →
   `storeSlice`; JSX in `App.tsx`/`LeftDock.tsx`/`HistoryPanel.tsx` →
   `panels`/`modeButtons`/`historyCards`; GL batches in `Viewport.tsx` →
   `viewportOverlays`; setter calls in `main.tsx` → `install`; toasts and
   camera requests → `notify` (`commands/notices.ts`) and `sendCamera`
   (`viewport/cameraChannel.ts`); another module's feature type →
   `FeatureOf<'kind'>` (`document/featureKinds.ts`), never an import.
4. Add the module to `app/composition.ts` (and `uiComposition.ts`,
   `kernelModules.ts`) — one line each.
5. Remove your legacy path entries from `modules.json` (the module's folder
   entry `renderer/src/modules/<id>/` is already there), then run
   `node scripts/check-assembler-modules.mjs --write-allowlist` and check
   that the allowlist only **lost** entries (`git diff`). On a merge conflict
   in `module-allowlist.json`, take either side and re-run `--write-allowlist`
   — the file is generated and the check verifies it.
6. Keep the published contract and order: `api.describe`/
   `api/agent-api-v1.schema.json` byte-identical (contract test; `pnpm
--filter @himmelcad/assembler api:schema` then prettier must give no
   diff), command order unchanged (block `order`), `.hcasm` files unchanged.
7. Gates per commit: `pnpm --filter @himmelcad/assembler typecheck`, `test`,
   `build`, `pnpm lint`, prettier on changed files; `test:electron` and
   `test:acceptance` when UI or kernel paths moved. Commit in small steps,
   each green.
8. Touch only your agent's files (§6); a hot file you do not own gets a
   note to its owner, not an edit.

## 6. Phase-A result and phase-B work list

Phase A commits (branch `asm/modules-20260930`): module map + check +
allowlist; foundation moves; platform/interface moves; feature-kind and
evaluator registries; commands from registrations; API contract from
registrations; parameters module; print + printers modules with jobs, UI
contract and overlay host; History-card registry; preferences and card
styles below the domain layer. Allowlist: 157 → 53.

Remaining allowlisted violations, grouped so that three agents can work in
parallel without touching the same files (A, B, C). Hot files have exactly
one owner; the owner does the edits the other groups need there, in a
second wave after the parallel moves.

**Agent A — sketching, construction, templates** (≈ 10 600 lines to move)

- Move `sketch/**`, `api/sketchApi.ts`, `api/sketchAdvancedApi.ts`,
  `model/commands/sketchCommands.ts` → `modules/sketching/`;
  `model/construction.ts`, `model/constructionTools.ts`,
  `model/commands/constructCommands.ts`, `kernel/features/construction.ts`,
  `kernel/features/constructionKernel.ts` → `modules/construction/`
  (construction registers its own kinds: move the two construction branches
  out of `model/project/featureFormat.ts` into `modules/construction/kinds.ts`);
  `templates/projectTemplates.ts` → `modules/templates/`.
- Sketch agent-API cases of `interface/agent-api/session.ts`
  (`sketch.*`, `sketches.list`) → `api` handlers (A owns `session.ts`).
- Violations: `sketching → display` (`SketchOverlay.tsx → viewportUi.ts`:
  move the image-export dialog state it reads into display or a widget).
- `modeling → construction` (5) disappear when construction owns its kinds
  and modeling reads construction references through `FeatureOf` and the
  document's reference types (coordinate with B: B edits modeling files).

**Agent A result (branch `asm/modA-20260930`).** sketching, construction and
templates are migrated; their allowlist entries are gone (sketching → display,
modeling → construction ×5; 53 → 47). Left for B's `Viewport.tsx` wave:
`viewport → sketching` ×3 (use the DOM-overlay/mode registry). `session.ts`:
`sketches.list`, `sketch.*` and `datums.list` are module handlers; the
measure/interop/export cases go once C's handlers are merged (registered
handlers already take precedence over the `switch`). Specs of these methods
stay in `schema.ts` (B) until its core blocks are split.

**Agent B — modeling, direct-edit** (≈ 10 200 lines)

- Move the modelling files (`model/features.ts`, `featureTools.ts`,
  `printFeatures.ts`, `printFeatureTools.ts`, `modeling.ts`, `moveGizmo.ts`,
  `modelingKinds.ts`, `model/project/*FeatureFormat.ts`,
  `model/commands/{feature,blend,modeling}Commands.ts`,
  `chrome/{FeatureParams,PrintFeatureParams}.tsx`, `chrome/featureIcons.ts`,
  `api/printSchema.ts`, `kernel/features/{bodyOps,draft,emboss,holes,profileSolids,ribThicken,modelingKernel}.ts`,
  `viewport/{toolAnchors,toolHandles}.ts`) → `modules/modeling/`;
  `model/offsetFaceModes.ts` + Offset/Delete Face (split
  `geometry-kernel/features/faceOps.ts`: `applyOffsetFace`/`applyDeleteFace`
  to direct-edit's `kernel.ts`, `offsetBodyFaces` stays) → `modules/direct-edit/`.
- Owns hot files `foundation/commands/store.ts` (tool sessions extrude/
  blend/shell/boolean/move/feature → a modelling store slice; removes
  `commands → modeling` ×4), `platform/viewport/Viewport.tsx` and
  `scene.ts` (tool handles/anchors → a handle provider in the viewport host;
  removes `viewport → modeling` ×7), `interface/agent-api/schema.ts` and
  `featureKinds.ts` (modelling kind schemas → modeling's `api.featureKinds`
  with order `API_ORDER.featureKinds`).
- `modeling → replicad` ×6: evaluators use OCCT through `FeatureKit` and
  geometry-kernel exports only.
- `geometry-kernel → modeling` (faceOps types), `direct-edit → modeling/measure`.
- Second wave in `Viewport.tsx` for A and C: DOM overlays (sketch overlay,
  measure overlay, dimension labels) as `viewportOverlays`/a DOM-overlay
  slot; removes `viewport → sketching/measure/display` ×9 and
  `viewport → shell-ui` ×4 (Fix ghosts, workspace, preferences reads).

_Result (branch `asm/modB-20260930`, with A and C merged)_: modeling
and direct-edit are migrated (`modules/{modeling,direct-edit}`: kinds,
evaluators via `occtApi.ts`, draft tools, tool sessions + store slice,
commands, API kind schemas, History cards, icons, viewport tools); the
store core and the viewport name no domain module; the allowlist is empty
(53 → 0 with A's and C's work). From C's `schema.ts` note, `INTEROP_METHODS`
is now published by interop's `api.methods` (same block order) and the
construction kind schemas by construction's `api.featureKinds`; left for
the integrator: the five `measure.*` specs still sit at the head of the
core `METHODS_TAIL` block (moving them needs that block split at the same
position) — allowed, not a violation.

**Agent C — interop, measure, display** (≈ 9 800 lines)

- Move `interop/**`, `api/interopApi.ts`, `kernel/stlImport.ts` →
  `modules/interop/`; `model/measure*.ts`, `model/commands/measureCommands.ts`,
  `chrome/MeasurePanel*`, `chrome/measurePlacement.ts`,
  `viewport/MeasureOverlay.tsx`, `api/measureApi.ts` → `modules/measure/`;
  the display files (`chrome/{AnalysisLegend,ColourDialog,DisplayMenu,ExportImageDialog,SectionControls}*`,
  `model/{appearance,viewDisplay,viewportUi}.ts`,
  `model/commands/displayCommands.ts`, `viewport/imageExport.ts`) →
  `modules/display/`.
- Owns hot files `interface/shell-ui/workspace.ts` (colour-dialog and
  image-export state move to display; `notify`/`sendCamera` callers switch
  to the foundation/platform channels) and
  `interface/shell-ui/project/projectStore.ts` (exports → interop/print
  handlers). C writes the measure/interop `api` handlers in its modules;
  A (owner of `session.ts`) deletes the matching `case`s in the second wave.
- Violations: `display → shell-ui` ×3, `display → measure` ×2 (pinned
  measurements through a registry), `display → modeling` ×2,
  `interop → shell-ui` ×3, `commands → display` (`store.ts → viewDisplay.ts`,
  hand to B, owner of `store.ts`), `commands → shell-ui`
  (`store.ts → workspace.ts`, B), `agent-api → shell-ui`
  (`automationStore.ts → projectStore.ts`).
- Interop's runner moves onto `jobs/SingleJobWorker` like print's.

_Result (branch `asm/modC-20260930`)_: interop, measure and display are
migrated (folders `modules/{interop,measure,display}`, registered commands,
API handlers, UI panels, runtime `install`, file sections); `.hcasm` bytes
unchanged. Allowlist 53 → 38 (removed: `agent-api → shell-ui`,
`interop → shell-ui` ×3, `measure → shell-ui`, `display → shell-ui` ×3,
`display → measure` ×2, `display → modeling` ×2, `sketching → display`,
`viewport → display` ×2). Deviations from the list above: `viewportUi.ts`
(section-face prompt, live grid step, image renderer) and `imageExport.ts`
(PNG encoding) moved **down** to `platform/viewport/` instead of into
display (the viewport and the sketch overlay use them); the colour dialog's
bodies and the Export image… flag moved to `modules/display/dialogs.ts`;
the project store's STL/3MF exports moved to `modules/interop/meshExports.ts`
(the File commands stay in the shell's block, order unchanged), its unused
STEP export/STEP+STL import and unit-hint dialog were removed.

Second wave, notes to the owners of the hot files:

- **B (`store.ts`)**: `commands → display` — apply the display parts in
  display's `DISPLAY_PROJECT_SECTION.load` (`modules/display/projectFile.ts`)
  instead of `applyViewState` → `viewDisplayFromProject`; `commands →
shell-ui` — `setSectionAccess` (saved views' section state) can become a
  section-state accessor in the viewport platform or commands.
- **B (`Viewport.tsx`/`scene.ts`)**: `viewport → display` is now only
  `sectionAtFace` (Section › Face pick); `viewport → measure` ×3 is the
  measure overlay, point snapping and the Points tool — both belong in the
  DOM-overlay/pick registration. `platform/viewport/viewGeometry.ts` has
  `visibleBodyBounds` and `sectionPlaneNormal`; `model/modeling.ts`
  `visibleBounds` and `toolAnchors.ts` `sectionNormal` duplicate them and
  can delegate.
- **B (`schema.ts`)**: move `INTEROP_METHODS` (order `API_ORDER.methods.
interop`) into interop's `api.methods` (`modules/interop/interopApi.ts`
  `INTEROP_API`, then drop its `handlers`), and the five `measure.*` specs
  (head of `METHODS_TAIL`) into a measure block ordered between
  `parameters` (200) and `coreTail` (300); `MeasureTarget` needs a def block
  between `EdgeInput` and `SketchShape`. `api:schema` must give no diff.
- **A (`session.ts`)**: the `measure.*`, `import.*`, `interop.formats`,
  `export.dxf` and `mesh.toSolid` cases are dead (module handlers run
  first) and can go, with the `runMeasureQuery`/interop imports;
  `export.step`/`export.iges` stay with the session's `exportBodies`.

Order: the three agents move their files and registrations in parallel
(only their own files, plus one line each in the app compositions and their
own entries in `modules.json`); then B does the `Viewport.tsx`/`store.ts`
wave and A the `session.ts` wave for everyone.

**Integration (Block 7, branch `feat/assembler-phase0-20260929`).**
`asm/modB-20260930` (phase A + agents A, B, C) and agent A's F13 commit
(`2d0ae7c0`, headless kernel in a worker thread with a time budget) are
merged. Done from the second-wave notes: the dead `measure.*`, `import.*`,
`interop.formats`, `export.dxf` and `mesh.toSolid` cases of `session.ts`
are gone; the `measure.*` specs and `MeasureTarget`, `sketches.list`,
`sketch.*`, `datums.list` and `import.step` moved into their modules'
`api.methods` (§3 "Settled in the integration"); the published schema is
byte-identical apart from F13's `kernelTimeout` error code, and the
command list (ids, labels, groups, shortcuts, keywords, adaptive rules,
order) is identical to the pre-restructure build. Allowlist: 0.

Left open (not violations): `startModules` is desktop-only by design.
Since Block 8 (sketch stream) headless `project.save`/`project.open`/
`project.new` save and load the modules' top-level fields through the
project sections (`collectProjectSections().fields`, `loadProjectSections`:
Items, reference meshes, reference-image pictures); the view state stays
app-only.

**Block 8 integration** (four streams merged: web, model, sketch, touch).
The project schema stays 3: every addition is an optional field or a new
kind (README "Files"), no migration. The command list only gained entries
(14 ids; existing ids, labels, groups, shortcuts, keywords, adaptive rules
and order unchanged), the API schema only gained methods, kinds and
optional properties. The kernel-thread registration test names the new
kinds; the web build uses the same compositions (hc.3 wasm, `canvas`).

## 7. Block 8: the web product and the host contract

`apps/assembler-web` is the second renderer product ([WEB.md](WEB.md)). It stays
a folder-module composition, as §1 anticipated, without lifting modules into
packages: its sources import the modules by relative path
(`../../assembler/renderer/src/…`), `modules.json` lists `../assembler-web/src`
under `sourceRoots` and as module `web` (product layer), so the check covers it;
`tsc` reads the modules through the `apps/assembler` project reference
(declarations), Vite bundles them from source. Products may use each other's
files (the web product reuses `app/composition.ts`, `app/uiComposition.ts`,
`app/kernel.worker.ts`), and no product may import Electron (`externalForbidden.product`).

Everything the renderer needs from its environment is the foundation module
`host` (lowest in the layer): code calls `host()` instead of reading
`window.assembler`. Rules for new code:

- A capability that differs between desktop and web goes into `AssemblerHost`
  with a desktop adapter (`desktopHost.ts`), a plain-browser fallback
  (`browserHost.ts`) and the web implementation (`apps/assembler-web/src/host`);
  `null` + `unavailableReason` where a host cannot offer it — never a dead button.
- Only `foundation/host/desktopHost.ts` touches `window.assembler`
  (`document/persistence.ts` keeps its API and delegates).
- A product installs its host before it imports the composition
  (`installHost`, web: `src/installHost.ts` as the first import); stores read
  capabilities when they are created.
