/**
 * The UI part of the module contract (assembler/MODULES.md §3): what a
 * module adds to the desktop shell — panels, mode buttons and viewport
 * overlays — declared in its `module.ui.ts` with {@link defineModuleUi} and
 * installed by the desktop composition (`app/uiComposition.ts`). The shell
 * renders what is registered; it never imports a module's panel.
 */
import type { ComponentType } from 'react';

import type { AssemblerState } from '../../foundation/commands/store.js';
import type { Feature } from '../../foundation/document/document.js';
import {
  registerViewportDomOverlay,
  registerViewportMode,
  type ViewportDomOverlay,
  type ViewportMode,
} from '../viewport/domOverlays.js';
import { registerViewportOverlay, type ViewportOverlayProvider } from '../viewport/overlays.js';

export interface PanelProps {
  state: AssemblerState;
  onContextMenu: (x: number, y: number) => void;
}

/**
 * A panel of the shell: `rightStack` panels stack below the right dock in
 * `order` (Parameters above History); `overlay` panels (dialogs, Print mode
 * chrome) float over the viewport and decide their own visibility.
 */
export interface PanelRegistration {
  id: string;
  slot: 'rightStack' | 'overlay';
  order: number;
  /** Whether a rightStack panel is shown; overlays always render (and hide themselves). */
  isOpen?: (state: AssemblerState) => boolean;
  component: ComponentType<PanelProps>;
}

/** Class names of the left dock's mode group, so a module's toggle looks like Section/Isolate/Measure. */
export interface ModeButtonProps {
  className: string | undefined;
  activeClassName: string | undefined;
  stateClassName: string | undefined;
}

/** A toggle in the left dock's mode group. */
export interface ModeButtonRegistration {
  id: string;
  order: number;
  component: ComponentType<ModeButtonProps>;
}

/** Props of a History card's parameter editor (the expanded card body). */
export interface HistoryCardProps {
  feature: Feature;
  state: AssemblerState;
  /** Grid container class of the card body. */
  className: string | undefined;
  /** Class of a full-width grid cell. */
  fullClassName: string | undefined;
}

/** The parameter editor of History cards of these feature kinds. */
export interface HistoryCardRegistration {
  kinds: readonly string[];
  component: ComponentType<HistoryCardProps>;
}

export interface ModuleUi {
  /** Module id, as in `apps/assembler/modules.json`. */
  id: string;
  panels?: readonly PanelRegistration[];
  modeButtons?: readonly ModeButtonRegistration[];
  historyCards?: readonly HistoryCardRegistration[];
  viewportOverlays?: readonly ViewportOverlayProvider[];
  /** React overlays over the canvas with the viewport's host services (`viewport/domOverlays.ts`). */
  viewportDomOverlays?: readonly ViewportDomOverlay[];
  /** What the module tells the viewport while its mode runs (`viewport/domOverlays.ts`). */
  viewportModes?: readonly ViewportMode[];
}

export function defineModuleUi(ui: ModuleUi): ModuleUi {
  return ui;
}

const panels: PanelRegistration[] = [];
const modeButtons: ModeButtonRegistration[] = [];
const historyCards = new Map<string, HistoryCardRegistration>();
const installed = new Set<string>();

/** Registers the modules' UI parts (desktop renderer only), once per module. */
export function installModuleUis(uis: readonly ModuleUi[]): void {
  for (const ui of uis) {
    if (installed.has(ui.id)) continue;
    installed.add(ui.id);
    panels.push(...(ui.panels ?? []));
    modeButtons.push(...(ui.modeButtons ?? []));
    for (const card of ui.historyCards ?? []) {
      for (const kind of card.kinds) {
        if (historyCards.has(kind))
          throw new Error(`History card of "${kind}" is registered twice`);
        historyCards.set(kind, card);
      }
    }
    for (const overlay of ui.viewportOverlays ?? []) registerViewportOverlay(overlay);
    for (const overlay of ui.viewportDomOverlays ?? []) registerViewportDomOverlay(overlay);
    for (const mode of ui.viewportModes ?? []) registerViewportMode(mode);
  }
  panels.sort((a, b) => a.order - b.order);
  modeButtons.sort((a, b) => a.order - b.order);
}

/** Registered panels of one slot, in `order`. */
export function registeredPanels(slot: PanelRegistration['slot']): readonly PanelRegistration[] {
  return panels.filter((panel) => panel.slot === slot);
}

/** Registered mode buttons, in `order`. */
export function registeredModeButtons(): readonly ModeButtonRegistration[] {
  return modeButtons;
}

/** The History-card editor a module registered for `kind`, or `undefined`. */
export function historyCardFor(kind: string): HistoryCardRegistration | undefined {
  return historyCards.get(kind);
}
