/**
 * The registration contract of an Assembler module (assembler/MODULES.md §3).
 *
 * A module declares what it contributes in its own files and the product
 * composition installs it; adding a command, an API method, a store slice or
 * a panel never edits a central file. Two descriptors per module, because
 * the headless CLI and the tests run without a DOM:
 *
 * - {@link defineAssemblerModule} (`module.ts`): everything that runs
 *   without a UI — commands, agent-API methods and schema parts, store
 *   slice, runtime wiring. Feature kinds register themselves from the
 *   module's `kinds` file (document registry) and `kernel.ts` (evaluator
 *   registry, `geometry-kernel/features/registry.ts`).
 * - `defineModuleUi` (`module.ui.ts`, `platform/widgets/moduleUi.ts`):
 *   panels, mode buttons, viewport overlays, installed only by the desktop
 *   renderer. It lives in the platform layer because it names React
 *   components and viewport types; foundation stays UI-free.
 */
import { registerProjectSection, type ProjectSection } from '../document/projectSections.js';
import type { KernelAdapter } from '../geometry-kernel/adapter.js';
import { registerApiContribution, type ApiContribution } from './api/registry.js';
import { registerDraftTool, type DraftTool, type RegisteredDraft } from './draftTools.js';
import { registerProjectTemplates, type ProjectTemplate } from './projectTemplates.js';
import { registerCommands, type Command } from './registry.js';
import { installStoreSlice, type StoreSliceCreator } from './store.js';

/** A block of commands; blocks of all modules are ordered by `order` (the adaptive-toolbar and search tie-break). */
export interface CommandBlock {
  order: number;
  commands: readonly Command[];
}

/** Services the product hands to a module's {@link AssemblerModule.install}. */
export interface ModuleHost {
  /** The main-thread kernel adapter (a worker in the app, in-process headless). */
  kernel: KernelAdapter;
  /** Whether modules may start Web Workers (desktop and web renderer; not Node). */
  workers: boolean;
}

export interface AssemblerModule {
  /** Module id, as in `apps/assembler/modules.json`. */
  id: string;
  commands?: readonly CommandBlock[];
  /** Agent-API methods (with handlers), schema `$defs` and feature-kind schemas (`api/registry.ts`). */
  api?: ApiContribution;
  /** Interactive tools of the module's feature kinds (`draftTools.ts`), used by the generic feature tool. */
  draftTools?: readonly DraftTool<RegisteredDraft>[];
  /** Home-screen project templates (`projectTemplates.ts`), in order. */
  projectTemplates?: readonly ProjectTemplate[];
  /** State and actions merged into the one application store (`store.ts` `installStoreSlice`). */
  storeSlice?: StoreSliceCreator;
  /**
   * The module's data in the project file besides the features (pins, saved
   * views, display settings …): what Save writes, what Open/New restore and
   * what makes the project unsaved (`document/projectSections.ts`). The file
   * side — field validators and key order — registers in `format.ts`.
   */
  fileFormatFields?: readonly ProjectSection[];
  /**
   * Registration-time hooks into the gate (a modal-session probe, the notice
   * toast): run once by {@link installModules}, in every program that
   * installs the module (app, headless, tests).
   */
  onInstall?: () => void;
  /** Runtime wiring (workers, kernel adapter); runs once per process when the product starts it. */
  install?: (host: ModuleHost) => void;
}

export function defineAssemblerModule(module: AssemblerModule): AssemblerModule {
  return module;
}

const installed = new Set<string>();
const started = new Set<string>();

/**
 * Registers the modules' commands, API parts and store slices, in list
 * order. Idempotent per module id (a product imports the composition once;
 * tests may import it again).
 */
export function installModules(modules: readonly AssemblerModule[]): void {
  for (const module of modules) {
    if (installed.has(module.id)) continue;
    installed.add(module.id);
    for (const block of module.commands ?? [])
      registerCommands(block.order, block.commands, module.id);
    if (module.api) registerApiContribution(module.id, module.api);
    for (const tool of module.draftTools ?? []) registerDraftTool(tool);
    if (module.projectTemplates) registerProjectTemplates(module.id, module.projectTemplates);
    if (module.storeSlice) installStoreSlice(module.id, module.storeSlice);
    for (const section of module.fileFormatFields ?? []) registerProjectSection(section);
    module.onInstall?.();
  }
}

/** Runs the modules' runtime wiring once (desktop renderer, headless CLI). */
export function startModules(modules: readonly AssemblerModule[], host: ModuleHost): void {
  for (const module of modules) {
    if (started.has(module.id) || !module.install) continue;
    started.add(module.id);
    module.install(host);
  }
}
