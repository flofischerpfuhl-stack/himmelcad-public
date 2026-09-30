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
 * - {@link defineModuleUi} (`module.ui.ts`): panels, viewport overlays and
 *   History cards, installed only by the desktop renderer.
 *
 * Contract types only reference foundation types; UI components are typed
 * structurally ({@link UiComponent}) so this file needs no React.
 */
import type { KernelAdapter } from '../geometry-kernel/adapter.js';
import { registerApiContribution, type ApiContribution } from './api/registry.js';
import { registerCommands, type Command } from './registry.js';
import { installStoreSlice, type AssemblerState, type StoreSliceCreator } from './store.js';

/** A block of commands; blocks of all modules are ordered by `order` (the adaptive-toolbar and search tie-break). */
export interface CommandBlock {
  order: number;
  commands: readonly Command[];
}

/** Services the product hands to a module's {@link AssemblerModule.install}. */
export interface ModuleHost {
  /** The main-thread kernel adapter (a worker in the app, in-process headless). */
  kernel?: KernelAdapter;
  /** Creates a module worker by entry name (`new Worker(new URL(...))` lives in the product). */
  createWorker?: (name: string) => Worker;
}

export interface AssemblerModule {
  /** Module id, as in `apps/assembler/modules.json`. */
  id: string;
  commands?: readonly CommandBlock[];
  /** Agent-API methods (with handlers), schema `$defs` and feature-kind schemas (`api/registry.ts`). */
  api?: ApiContribution;
  /** State and actions merged into the one application store (`store.ts` `installStoreSlice`). */
  storeSlice?: StoreSliceCreator;
  /**
   * Registration-time hooks into the gate (a modal-session probe, the notice
   * toast): run once by {@link installModules}, in every program that
   * installs the module (app, headless, tests).
   */
  onInstall?: () => void;
  /** Runtime wiring (workers, kernel adapter); runs once per process when the product starts it. */
  install?: (host: ModuleHost) => void;
}

/** A React-compatible component, typed structurally (foundation stays React-free). */
export type UiComponent<P> = (props: P) => unknown;

export interface PanelProps {
  state: AssemblerState;
  onContextMenu: (x: number, y: number) => void;
}

/**
 * A panel of the shell: `rightStack` panels stack below the right dock in
 * `order` (Parameters above History); `overlay` panels float over the
 * viewport and decide their own visibility.
 */
export interface PanelRegistration {
  id: string;
  slot: 'rightStack' | 'overlay';
  order: number;
  /** Whether the panel is shown (rightStack panels); overlays render always. */
  isOpen?: (state: AssemblerState) => boolean;
  component: UiComponent<PanelProps>;
}

export interface ModuleUi {
  id: string;
  panels?: readonly PanelRegistration[];
}

export function defineAssemblerModule(module: AssemblerModule): AssemblerModule {
  return module;
}

export function defineModuleUi(ui: ModuleUi): ModuleUi {
  return ui;
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
    if (module.storeSlice) installStoreSlice(module.id, module.storeSlice);
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

const panels: PanelRegistration[] = [];
const installedUi = new Set<string>();

/** Registers the modules' UI parts (desktop renderer only). */
export function installModuleUis(uis: readonly ModuleUi[]): void {
  for (const ui of uis) {
    if (installedUi.has(ui.id)) continue;
    installedUi.add(ui.id);
    panels.push(...(ui.panels ?? []));
  }
  panels.sort((a, b) => a.order - b.order);
}

/** Registered panels of one slot, in `order`. */
export function registeredPanels(slot: PanelRegistration['slot']): readonly PanelRegistration[] {
  return panels.filter((panel) => panel.slot === slot);
}
