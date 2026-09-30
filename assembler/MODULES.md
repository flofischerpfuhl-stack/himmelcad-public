# HimmelCAD Assembler — modules (ADR 0032)

Status: phase A of the modular restructure done (Florian, 2026-09-30; plan
in [ROADMAP-LATER.md](ROADMAP-LATER.md) §0). This file is the design and the
working contract for phase B, in which several agents move the remaining
domain modules in parallel. The machine-readable module map is
[`apps/assembler/modules.json`](../apps/assembler/modules.json); the known
violations still to remove are
[`apps/assembler/module-allowlist.json`](../apps/assembler/module-allowlist.json)
(53 at the end of phase A, 157 at its start). `pnpm check:assembler-modules`
enforces both; it also runs in `pnpm lint` and at the start of the
Assembler `test` script.

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
product     app (desktop renderer)  ·  headless (CLI)  ·  desktop-host (Electron)      [later: assembler-web]
interface   agent-api  <  shell-ui
domain      sketching · modeling · direct-edit · construction · parameters · measure ·
            display · interop · templates · print · printers          (no domain → domain)
platform    input  <  viewport  <  widgets                            (+ @himmelcad/hardware-profile, shared)
foundation  jobs  <  document  <  sketch-solver  <  geometry-kernel  <  commands
```

| Module          | Layer      | Owns                                                                                                                                                                                                                                                                                                                     | Folder                                      |
| --------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| jobs            | foundation | `SingleJobWorker`: one job at a time, cancel = terminate the worker, progress, inline fallback for tests/headless. Later: budgets, timeouts.                                                                                                                                                                             | `renderer/src/foundation/jobs`              |
| document        | foundation | Value types and references (faces, edges, planes, axes, profiles), the **feature-kind registry** (`featureKinds.ts`), the nine core kinds the evaluator implements (`document.ts`, `coreKinds.ts`), parameters and the formula parser, `.hcasm` format with **registrable migrations**, validation helpers, persistence. | `renderer/src/foundation/document`          |
| sketch-solver   | foundation | Sketch data model and the `sketch` kind (`sketchFeature.ts`: type, validator, v1→v2 migration), planeGCS (worker + in-process), regions, projections, dimension values, text outlines.                                                                                                                                   | `renderer/src/foundation/sketch-solver`     |
| geometry-kernel | foundation | The only place that imports OCCT: adapter, worker runtime, evaluator with the **per-kind evaluator registry** (`features/registry.ts`), prefix cache, naming, tessellation, STEP/IGES/mesh-solid exchange, mesh writers (STL, 3MF), OCCT module loader (`headless/occtModule.ts`, `headless/nodeKernel.ts`).             | `renderer/src/foundation/geometry-kernel`   |
| commands        | foundation | The command gate: application store core with **installable slices** (`store.ts`), command registry (`registry.ts`), shortcuts, pick sessions, the module contract (`module.ts`), the agent-API contract kit and **method registry** (`api/`), notices, items (body names/folders), reference meshes, the demo document. | `renderer/src/foundation/commands`          |
| input           | platform   | Mouse navigation presets, the user preferences store, snap switches; later touch/pen, SpaceMouse.                                                                                                                                                                                                                        | `renderer/src/platform/input`               |
| viewport        | platform   | WebGL2 renderer, scene, camera, picking, selection, grid, display-mode rendering, the **overlay host** (`overlays.ts`) and the camera channel (`cameraChannel.ts`).                                                                                                                                                      | `renderer/src/platform/viewport`            |
| widgets         | platform   | The building blocks module UIs share (panel and History-card styles, expression fields with name completion, anchored menus) and the **UI half of the module contract** (`moduleUi.ts`).                                                                                                                                 | `renderer/src/platform/widgets`             |
| sketching       | domain     | Sketch mode: session, drawing tools, inference, sketch commands, overlay, chrome, History card, sketch agent API.                                                                                                                                                                                                        | `renderer/src/modules/sketching`            |
| modeling        | domain     | Solid features and their tools, History cards, handles, API schemas (revolve … thicken), later the core extrude/fillet/chamfer/shell/boolean/move tools.                                                                                                                                                                 | `renderer/src/modules/modeling`             |
| direct-edit     | domain     | Offset Face (value modes), Delete Face, move face.                                                                                                                                                                                                                                                                       | `renderer/src/modules/direct-edit`          |
| construction    | domain     | Construction planes and axes.                                                                                                                                                                                                                                                                                            | `renderer/src/modules/construction`         |
| parameters      | domain     | **Migrated.** Parameter edits (plan/commit), the store slice, Parameters panel, parameter API methods.                                                                                                                                                                                                                   | `renderer/src/modules/parameters`           |
| measure         | domain     | Measure mode, pinned measurements, panel, overlay, measure API.                                                                                                                                                                                                                                                          | `renderer/src/modules/measure`              |
| display         | domain     | Appearance/colour, display-mode and section commands and menus, visibility commands, analysis legend, image export, persisted view display.                                                                                                                                                                              | `renderer/src/modules/display`              |
| interop         | domain     | Import/export UI and parsers (STEP structure UI, IGES, DXF, STL, 3MF, OBJ), mesh→solid flow, import worker, interop API. OCCT only through the kernel adapter.                                                                                                                                                           | `renderer/src/modules/interop`              |
| templates       | domain     | Home-screen project templates.                                                                                                                                                                                                                                                                                           | `renderer/src/modules/templates`            |
| print           | domain     | **Migrated.** Printability analysis, orientation, placement, STL export options, Print mode panel/toggle/overlays, print API, its worker.                                                                                                                                                                                | `renderer/src/modules/print`                |
| printers        | domain     | **Migrated.** Slicers: store, 3MF hand-off, Slicers… dialog, commands (desktop side `electron/slicer*.ts`); later printer profiles, build volumes, direct send with own safety rules.                                                                                                                                    | `renderer/src/modules/printers`             |
| agent-api       | interface  | `hcasm.agent-api@1` session and dispatch, the composed schema document (`schema.ts`), JSON-RPC framing, feature builders, in-app endpoint bridge.                                                                                                                                                                        | `renderer/src/interface/agent-api`          |
| shell-ui        | interface  | Layout, docks, the panel/mode-button/History-card hosts, History and Items panels, command search, menus, dialogs, project lifecycle UI, workspace state.                                                                                                                                                                | `renderer/src/interface/shell-ui`           |
| app             | product    | Desktop renderer composition: `composition.ts`, `uiComposition.ts`, `kernelModules.ts`, `kernel.worker.ts`, `main.tsx`, dev tooling.                                                                                                                                                                                     | `renderer/src/app`, `renderer/src/main.tsx` |
| headless        | product    | `assembler-headless` composition.                                                                                                                                                                                                                                                                                        | `headless/cli.ts`                           |
| desktop-host    | product    | Electron main/preload.                                                                                                                                                                                                                                                                                                   | `electron/`                                 |

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
*compute* budget per machine class for OCCT in WebAssembly, which the
package does not model yet (`computeBudgetScale` in the quirk registry is
the only compute knob; the package and the Rust crate
`himmelcad-hardware-profile` validate it, no consumer applies it). Proposal:

```ts
/** Facts the host knows about the machine (Electron main or renderer). */
export interface ComputeFacts {
  readonly os: HardwareOperatingSystem;
  readonly logicalCores: number;          // navigator.hardwareConcurrency / os.cpus()
  readonly deviceMemoryGiB: number | null; // os.totalmem() or navigator.deviceMemory
  readonly wasm64: boolean;                // memory64 available
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

Not built in phase A, planned for phase B with the modules that need them:
`tools` (the generic feature tool's `createDraft`/`draftToFeature` per kind,
now one switch in `model/featureTools.ts`), `fileFormatFields` (project-level
data such as items, pinned measurements, reference meshes, with
`validate/save/load`, now fixed fields in `document/format.ts`), DOM
overlays of the viewport (sketch overlay, dimension labels, measure
overlay, now JSX in `Viewport.tsx`) and a tool-handle provider (now
`viewport/toolHandles.ts` called from `Viewport.tsx`/`scene.ts`).

Compositions (`renderer/src/app`):

- `composition.ts` — the module list; `installModules` at import. Imported
  first by `main.tsx`, `headless/cli.ts` and `test/setup.ts`.
- `uiComposition.ts` — the modules' UI parts (`installModuleUis`); desktop only.
- `kernelModules.ts` — the kind registrations and evaluators; imported by
  `kernel.worker.ts` (the worker entry; the name is load-bearing for the CSP
  rules in `electron/main.ts` and `vite.config.ts`), by the CLI and by the
  tests (`test/kernel/nodeKernel.ts` too).
- Tests: every test, fuzz and bench script preloads `test/setup.ts` with
  `node --import`, so each test process has the product's registrations.

## 4. Where files are

`modules.json` is authoritative: every file under `renderer/src`,
`headless` and `electron` belongs to exactly one module by longest path
prefix, so a file can belong to its target module before it moves. Phase A
moved foundation, platform and interface into their folders and migrated
`parameters`, `print` and `printers` completely. What remains under
`renderer/src/{model,chrome,sketch,interop,templates,viewport,kernel,api}` is
domain code waiting for phase B (§6).

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

Order: the three agents move their files and registrations in parallel
(only their own files, plus one line each in the app compositions and their
own entries in `modules.json`); then B does the `Viewport.tsx`/`store.ts`
wave and A the `session.ts` wave for everyone.
