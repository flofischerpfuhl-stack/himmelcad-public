# HimmelCAD Assembler — modules (ADR 0032)

Status: phase A of the modular restructure (Florian, 2026-09-30; plan in
[ROADMAP-LATER.md](ROADMAP-LATER.md) §0). This file is the design and the
working contract for phase B, in which several agents move the remaining
domain modules in parallel. The machine-readable module map is
[`apps/assembler/modules.json`](../apps/assembler/modules.json); the known
violations still to remove are
[`apps/assembler/module-allowlist.json`](../apps/assembler/module-allowlist.json);
`pnpm check:assembler-modules` enforces both (also part of `pnpm lint` and of
the Assembler `test` script).

Decisions that are not repeated here: ADR 0032 (module architecture,
dependencies point downward, domain modules register themselves, products are
compositions) and ADR 0033 (Assembler is its own product with its own
document authority and dependency graph; shared UI/theme packages stay
shared).

## 1. Package form: folders inside `apps/assembler`, not workspace packages

Assembler modules are **folders with a public entry file** inside the one app
package, not `packages/@himmelcad/assembler-*` workspace packages. Reasons,
measured against the four builds and the test runner the app has:

| Concern                     | Folders (chosen)                                                                                                  | Workspace packages                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck / build speed     | One `tsc` program per target as today (renderer, headless, tests, electron).                                      | ~20 more `tsc -b` projects with declaration emit and `references`; incremental builds need `.d.ts` per package; a cold build was measured at 89 s for today's single program already. |
| Test runner                 | `tsconfig.test.json` compiles tests and sources into `.build/tests` with relative imports; unchanged.             | Tests would import compiled packages; every package needs its own build before the test build, or TS-source `exports` that `node --test` cannot run.                                  |
| Vite (renderer + 4 workers) | `new URL('./x.worker.ts', import.meta.url)` workers and CSS modules keep working with relative paths.             | Works with TS-source `exports`, but workers inside packages need extra `optimizeDeps`/`fs.allow` care.                                                                                |
| Headless CLI                | `tsc -p tsconfig.headless.json` follows relative imports into the renderer sources and emits runnable JS.         | Node cannot run TS-source packages; the CLI would need a bundler or all packages prebuilt.                                                                                            |
| Electron build              | Unaffected (CommonJS `electron/` has its own program).                                                            | Unaffected.                                                                                                                                                                           |
| Boundary enforcement        | `scripts/check-assembler-modules.mjs` on files (same import scanner and allowlist discipline as Builder's check). | `check-module-dependencies.mjs` on packages, plus `package.json` declarations.                                                                                                        |

The layout is chosen so that lifting a module into a package later (for
example for `apps/assembler-web`) is mechanical: every module has one folder,
one public entry (`index.ts`, plus `module.ts` for its registration and
`kernel.ts` for its kernel-worker part), and the check already forbids the
imports a package boundary would forbid. Revisit when `apps/assembler-web`
needs a second composition that a single package cannot serve.

## 2. Layers and modules

Bottom-up. A module may import modules of lower layers; inside foundation,
platform and interface only modules listed **above** it in the same layer;
domain modules never import each other.

```text
product     app (desktop renderer)  ·  headless (CLI)  ·  desktop-host (Electron)     [later: assembler-web]
interface   agent-api  <  shell-ui
domain      sketching · modeling · direct-edit · construction · parameters · measure ·
            display · interop · templates · print · printers          (no domain → domain)
platform    input  <  viewport                                         (+ @himmelcad/hardware-profile, shared)
foundation  jobs  <  document  <  sketch-solver  <  geometry-kernel  <  commands
```

| Module          | Layer      | Owns                                                                                                                                                                                                                                                               | Must not                                                        | Folder                                      |
| --------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------- |
| jobs            | foundation | Background work: single-job worker runners with inline fallback, progress, cancellation (terminate), budgets, timeouts.                                                                                                                                            | Know what a job computes.                                       | `renderer/src/foundation/jobs`              |
| document        | foundation | Value types and references (faces, edges, planes, axes, profiles), the open **feature-kind registry**, the core kinds the evaluator implements, parameters and expressions, `.hcasm` format, per-kind validators and migrations, persistence abstraction.          | Know OCCT, React, a store, or a domain kind.                    | `renderer/src/foundation/document`          |
| sketch-solver   | foundation | Sketch data model and the `sketch` kind, planeGCS (worker and in-process), regions and region memory, projections model, sketch validation and v1→v2 migration, text outlines.                                                                                     | Know the UI or the kernel.                                      | `renderer/src/foundation/sketch-solver`     |
| geometry-kernel | foundation | The only place that knows OCCT: kernel adapter and worker runtime, evaluator with the **per-kind evaluator registry**, prefix cache, naming, tessellation, STEP/IGES/mesh-solid exchange, OCCT module loader (`headless/occtModule.ts`, `headless/nodeKernel.ts`). | Import a domain module; hold UI state.                          | `renderer/src/foundation/geometry-kernel`   |
| commands        | foundation | The command gate: application store core (document state, undo transactions, evaluation orchestration, selection, tool-session state machine, **installable store slices**), command registry, availability, shortcuts, pick sessions, the agent-API contract kit. | Contain a domain command or domain state (they are registered). | `renderer/src/foundation/commands`          |
| input           | platform   | Mouse navigation presets; later touch/pen, SpaceMouse.                                                                                                                                                                                                             | Know commands of a domain.                                      | `renderer/src/platform/input`               |
| viewport        | platform   | WebGL2 renderer, scene, camera, picking, selection boxes, grid, display-mode rendering, the **overlay host**.                                                                                                                                                      | Import a domain module (domains register overlays).             | `renderer/src/platform/viewport`            |
| sketching       | domain     | Sketch mode: session, drawing tools, inference, sketch commands, overlay, chrome, sketch agent API.                                                                                                                                                                | —                                                               | `renderer/src/modules/sketching`            |
| modeling        | domain     | Solid features and their tools, history cards, handles, API schemas: revolve … thicken; later the core kinds extrude/fillet/chamfer/shell/boolean/move.                                                                                                            | —                                                               | `renderer/src/modules/modeling`             |
| direct-edit     | domain     | Offset Face (value modes), Delete Face, move face.                                                                                                                                                                                                                 | —                                                               | `renderer/src/modules/direct-edit`          |
| construction    | domain     | Construction planes and axes.                                                                                                                                                                                                                                      | —                                                               | `renderer/src/modules/construction`         |
| parameters      | domain     | Parameter edits (plan/commit), Parameters panel, parameter API methods.                                                                                                                                                                                            | —                                                               | `renderer/src/modules/parameters`           |
| measure         | domain     | Measure mode, pinned measurements, panel, overlay, measure API.                                                                                                                                                                                                    | —                                                               | `renderer/src/modules/measure`              |
| display         | domain     | Appearance/colour, display-mode and section commands and menus, analysis legend, image export, persisted view display.                                                                                                                                             | —                                                               | `renderer/src/modules/display`              |
| interop         | domain     | Import/export UI and parsers (STEP structure UI, IGES, DXF, STL, 3MF, OBJ), reference meshes, mesh→solid flow, import worker, interop API.                                                                                                                         | Call OCCT directly (goes through the kernel adapter).           | `renderer/src/modules/interop`              |
| templates       | domain     | Home-screen project templates.                                                                                                                                                                                                                                     | —                                                               | `renderer/src/modules/templates`            |
| print           | domain     | Printability analysis, orientation, placement, print exports, Print mode panel/overlay, print API.                                                                                                                                                                 | —                                                               | `renderer/src/modules/print`                |
| printers        | domain     | Slicer registration (renderer view + desktop discovery in `electron/slicer*.ts`); later printer profiles, build volumes, direct send (own safety rules).                                                                                                           | —                                                               | `renderer/src/modules/printers`             |
| agent-api       | interface  | `hcasm.agent-api@1` session and dispatch, the composed schema document, JSON-RPC framing, read-model projections, in-app endpoint bridge.                                                                                                                          | Own capabilities beyond registered methods.                     | `renderer/src/interface/agent-api`          |
| shell-ui        | interface  | Layout, docks, panel host, History and Items panels, command search, menus, dialogs, project lifecycle UI, preferences.                                                                                                                                            | Hard-code a domain panel (domains register panels).             | `renderer/src/interface/shell-ui`           |
| app             | product    | Desktop renderer composition: the module list, startup wiring, the kernel-worker composition, dev tooling.                                                                                                                                                         | Contain logic other than composition.                           | `renderer/src/app`, `renderer/src/main.tsx` |
| headless        | product    | `assembler-headless` composition.                                                                                                                                                                                                                                  | —                                                               | `headless/cli.ts`                           |
| desktop-host    | product    | Electron main/preload.                                                                                                                                                                                                                                             | —                                                               | `electron/`                                 |

Deliberate narrowing of ADR 0032 for Assembler (ADR 0033 allows its own
graph): Builder's command gate sits above the domain modules; in Assembler the
**registries** (`commands`, the feature-kind registry in `document`, the
evaluator registry in `geometry-kernel`) are foundation so that domain
modules can register into them, and the gate's composition happens in the
product. Domain modules may use platform modules (their overlays and tools
draw into the viewport); platform modules never use a domain module.

**Hardware profile.** `@himmelcad/hardware-profile` (shared, foundation in
Builder's map) offers the Electron renderer-fallback controller, Chromium
launch switches, rendering status and the quirk registry — all written for a
WebGPU/WebGL2 viewer in an Electron host. Assembler does not use it yet: its
Electron host sets no GPU switches and has no fallback path, and the package
has nothing for what Assembler needs most (WebAssembly heap and worker
budgets for OCCT, kernel timeouts per machine class). Gap for phase B/C:
adopt `deriveChromiumLaunchSwitches` + `RendererFallbackController` in
`electron/main.ts` and `deriveRenderingStatus` in the status strip; add
compute budgets (wasm heap, worker count) to the shared package rather than
to Assembler, per ADR 0032 §3.

External packages are owned too: only `geometry-kernel` imports `replicad` /
`replicad-opencascadejs`, only `sketch-solver` imports `@salusoft89/planegcs`;
foundation imports no React, Lucide or Electron; only files under `electron/`
import Electron.

## 3. Registration contracts

A domain module never edits a central file to add a feature kind, command,
tool, panel, API method, file-format field, shortcut or viewport overlay. It
declares them in its own `module.ts` (main thread) and, if it evaluates
geometry, `kernel.ts` (kernel worker), and the product composition installs
them. Everything below is exported from `foundation/commands/module.ts`
(contract types) and implemented by the registry named in each row.

```ts
export const parametersModule = defineAssemblerModule({
  id: 'parameters',                    // = the id in modules.json
  featureKinds: [],                    // FeatureKindRegistration[]
  commands: [{ order: 2400, commands: [...] }],
  tools: [],                           // ToolRegistration[]
  panels: [{ id: 'parameters', slot: 'rightStack', order: 10, isOpen, component }],
  apiMethods: { 'parameters.list': { spec, handler }, ... },
  apiDefs: { ... },                    // JSON-schema $defs the methods reference
  fileFormatFields: [],                // FileFormatField[]
  shortcuts: [],                       // extra bindings besides Command.shortcut
  viewportOverlays: [],                // ViewportOverlayRegistration[]
  storeSlice: createParametersSlice,   // installed into the one application store
  install: (host) => { ... },          // runtime wiring: workers, kernel adapter
});
```

| Contract                    | Shape (abridged)                                                                                                                                                                                                                                                                       | Registry (layer)                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------- | ---------------------------------------------- | -------------------- |
| Feature kind — document     | `declare module` augmentation of `FeatureKindMap` (`{ hole: HoleFeature }`), plus `registerFeatureKind({ kind, label, validate(record, path, helpers), migrations?, sketchIdsUsedBy?, expressionFields?, booleanResult? })`.                                                           | `document/featureKinds.ts`                                       |
| Feature kind — evaluator    | `defineKernelModule({ id, featureEvaluators: { hole: applyHole } })` with `(feature, ctx: ReplayContextLike, kit: FeatureKit) => void`, loaded by the kernel-worker composition and by the in-process kernel.                                                                          | `geometry-kernel/features/registry.ts`                           |
| Feature kind — agent API    | `featureKinds: [{ kind, api: { label, summary, params } }]`; appears in `api.describe` under `featureKinds` in registration order.                                                                                                                                                     | `commands/api/registry.ts`, composed by `agent-api`              |
| Feature kind — History card | `featureKinds: [{ kind, historyCard: Component, icon }]`.                                                                                                                                                                                                                              | `shell-ui` (card host)                                           |
| Feature kind — tool         | `tools: [{ kind, createDraft(ctx), draftToFeature(draft, base) }]` for the generic feature tool.                                                                                                                                                                                       | `commands` tool-session host (phase B)                           |
| Command                     | `commands: [{ order, commands: Command[] }]`; `Command` as today (`id, label, group, shortcut, shortcutScope, keywords, requiresKernel, adaptive, availability, run`, optional `pickPlan`). Blocks are merged by `order` (stable), which is the adaptive-toolbar and search tie-break. | `commands/registry.ts`                                           |
| API method                  | `apiMethods: { 'print.analyze': { spec: MethodSpec, handler(ctx: ApiContext, params) } }`, `apiDefs` for `$defs`; `ApiContext` gives `store`, `kernel`, `host`, `write`, `readEvaluation`, `readFeatures`, `deliver`, `allocateFeatureId`, … (the old `InteropContext`).               | `commands/api/registry.ts`, dispatched by `agent-api/session.ts` |
| Panel                       | `panels: [{ id, slot: 'rightStack'                                                                                                                                                                                                                                                     | 'left'                                                           | 'floating' | 'dialog', order, isOpen(state), component }]`. | `shell-ui/panels.ts` |
| File-format field           | `fileFormatFields: [{ key, validate(raw, path), save(state), load(value, state) }]` for project-level data (items, pinned measures, print settings …).                                                                                                                                 | `document/format.ts` (phase B)                                   |
| Viewport overlay            | `viewportOverlays: [{ id, order, component }]` (DOM overlays) and GL batch providers.                                                                                                                                                                                                  | `viewport` overlay host (phase B)                                |
| Store slice                 | `storeSlice: (set, get) => Partial<AssemblerState>` plus a `declare module` augmentation of `AssemblerStateExtensions`; installed once into `useAssemblerStore`.                                                                                                                       | `commands/store.ts`                                              |

Compositions:

- **Desktop renderer** — `renderer/src/app/composition.ts` lists the modules;
  `main.tsx` installs them before rendering.
- **Kernel worker** — `renderer/src/app/kernel.worker.ts` imports the
  geometry-kernel worker runtime and every module's `kernel.ts`; the in-process
  kernel (`headless/nodeKernel.ts`, tests) loads the same kernel composition.
- **Headless CLI** — `headless/cli.ts` installs the same module list (without
  UI parts) and the kernel composition.
- **Tests** — `test/setup.ts` installs the desktop composition; the test
  scripts preload it (`node --import`).

## 4. Where current files go

`modules.json` is authoritative: every file is assigned by path prefix, so a
file can belong to its target module before it moves. Phase A moved
foundation, platform and interface files into their folders and migrated
`parameters` and `print` completely (§6 lists the result). Everything still
under `renderer/src/{model,chrome,sketch,interop,templates,viewport,kernel/features}`
is domain code waiting for phase B.

## 5. How to move a module (phase B checklist)

1. Read this file, `modules.json` and your module's groups in
   `module-allowlist.json` (`node scripts/check-assembler-modules.mjs --report`).
2. Create `renderer/src/modules/<id>/` with `index.ts` (public API other
   modules and tests may import), `module.ts` (`defineAssemblerModule`) and,
   if the module evaluates geometry, `kernel.ts` (`defineKernelModule`).
3. Move files with `node apps/assembler/scripts/move-files.mjs <map.json>`
   (git mv + rewrites every relative import, worker URL and `declare module`
   specifier in the app, its tests and the allowlist). Never move by hand.
4. Replace each central edit with a registration: feature-kind union →
   `FeatureKindMap` augmentation + `registerFeatureKind`; evaluator switch →
   `featureEvaluators`; `.hcasm` validator branch → the kind's `validate`;
   `schema.ts` entries → `apiMethods`/`apiDefs`/`featureKinds[].api`; switch
   case in `session.ts` → `apiMethods` handler on `ApiContext`; commands
   spliced into `registry.ts` → `commands: [{ order, … }]`; state and actions
   in `store.ts` → `storeSlice`; panel in `App.tsx` → `panels`; overlay in
   `Viewport.tsx` → `viewportOverlays`; setter calls in `main.tsx` → `install`.
5. Add the module to `renderer/src/app/composition.ts` (and the kernel
   composition). Keep `order` values so the command order, the schema key
   order and `api.describe` stay identical — `test/api/contract.test.ts`
   compares the schema byte for byte with `api/agent-api-v1.schema.json`.
6. Remove the module's legacy prefixes from `modules.json`, add
   `renderer/src/modules/<id>/`, run `node scripts/check-assembler-modules.mjs
--write-allowlist` and check that the diff **only removes** entries.
7. Gates: `pnpm --filter @himmelcad/assembler typecheck`, `test`, `build`,
   `lint`, prettier on changed files; `test:electron` and `test:acceptance`
   when UI or kernel paths moved.
8. Do not touch another phase-B agent's files (§6 work list); shared
   foundation changes go through the architect.

## 6. Phase-A result and phase-B work list

Filled in at the end of phase A.
