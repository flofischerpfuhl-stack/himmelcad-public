/**
 * What modules and the shell add to the viewport's interaction besides
 * tools (`toolViews.ts`), GL overlays (`overlays.ts`) and DOM overlays and
 * modes (`domOverlays.ts`) — registered through
 * `defineModuleUi({ viewportClicks, viewportDatums })` and, for the shell,
 * `setViewportShell` (assembler/MODULES.md §3). The viewport never imports
 * a domain module or the shell:
 *
 * - **click handlers** take a click while no tool runs, before it selects
 *   (Measure › Points, Section › Face, History "Fix…" picks);
 * - **datum providers** add construction-like guides to the scene (the
 *   History "Fix…" ghost of a missing reference);
 * - the **shell** hands over its viewport-facing state: camera commands,
 *   Select Through, Save View, the notice toast and the live-pose probe.
 */
import type { AssemblerState, SelectionItem } from '../../foundation/commands/store.js';
import type { Body } from '../../foundation/geometry-kernel/types.js';
import type { CameraPose } from './camera.js';
import type { CameraCommand } from './cameraChannel.js';
import type { Vec3 } from './math.js';
import type { PickTarget } from './picking.js';
import type { SceneDatum } from './scene.js';

export interface ViewportClick {
  state: AssemblerState;
  pick: PickTarget | null;
  /** The selection item the click stands for (a double click selects whole bodies). */
  item: SelectionItem | null;
  isDouble: boolean;
  touch: boolean;
  /** Host-relative CSS position of the click. */
  hostPoint: [number, number];
  /** Host-relative CSS position of a world point, or `null` behind the camera. */
  project: (point: Vec3) => [number, number] | null;
  /** The bodies drawn right now (hidden and isolated-away bodies excluded). */
  visibleBodies: () => Body[];
  /** The first body surface point under the pointer that Section View does not cut away. */
  surfacePoint: () => Vec3 | null;
}

export interface ViewportClickHandler {
  id: string;
  /** Asked in this order (lower first). */
  order: number;
  /** `true` if the click was handled (the viewport then does nothing else with it). */
  click(click: ViewportClick): boolean;
}

export interface ViewportDatumProvider {
  id: string;
  /** Extra datums of the current state (drawn like construction planes/axes). */
  datums(state: AssemblerState): SceneDatum[];
  /** Calls `onChange` when the datums changed on their own (not through the store). */
  subscribe?(onChange: () => void): () => void;
}

/** The shell's viewport-facing state. */
export interface ViewportShell {
  /** The pending camera command (applied once per nonce), and its changes. */
  cameraCommand(): { command: CameraCommand; nonce: number } | null;
  subscribeCameraCommand(onChange: () => void): () => void;
  sendCamera(command: CameraCommand): void;
  /** Select Through (overlapping picks always offered); a React hook. */
  useSelectThrough(): boolean;
  selectThrough(): boolean;
  setSelectThrough(on: boolean): void;
  saveCurrentView(): void;
  /** The live camera pose for "Save view" (`null` when the viewport unmounts). */
  setCameraPoseProbe(probe: (() => CameraPose) | null): void;
}

const NO_SHELL: ViewportShell = {
  cameraCommand: () => null,
  subscribeCameraCommand: () => () => undefined,
  sendCamera: () => undefined,
  useSelectThrough: () => false,
  selectThrough: () => false,
  setSelectThrough: () => undefined,
  saveCurrentView: () => undefined,
  setCameraPoseProbe: () => undefined,
};

let shell: ViewportShell = NO_SHELL;
const clickHandlers: ViewportClickHandler[] = [];
const datumProviders: ViewportDatumProvider[] = [];

/** Installed once by the shell (its UI part). */
export function setViewportShell(next: ViewportShell): void {
  shell = next;
}

export function viewportShell(): ViewportShell {
  return shell;
}

export function registerViewportClick(handler: ViewportClickHandler): void {
  if (clickHandlers.some((h) => h.id === handler.id)) {
    throw new Error(`Viewport click handler "${handler.id}" is registered twice`);
  }
  clickHandlers.push(handler);
  clickHandlers.sort((a, b) => a.order - b.order);
}

/** Offers a click (no tool running) to the handlers; `true` if one took it. */
export function offerViewportClick(click: ViewportClick): boolean {
  return clickHandlers.some((h) => h.click(click));
}

export function registerViewportDatums(provider: ViewportDatumProvider): void {
  if (datumProviders.some((p) => p.id === provider.id)) {
    throw new Error(`Viewport datum provider "${provider.id}" is registered twice`);
  }
  datumProviders.push(provider);
}

export function extraViewportDatums(state: AssemblerState): SceneDatum[] {
  return datumProviders.flatMap((p) => p.datums(state));
}

export function subscribeViewportDatums(onChange: () => void): () => void {
  const unsubscribe = datumProviders.map((p) => p.subscribe?.(onChange) ?? (() => undefined));
  return () => unsubscribe.forEach((u) => u());
}
