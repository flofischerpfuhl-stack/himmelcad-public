/**
 * Display, section and measurement commands (display modes Alt+1…7, edge /
 * hidden-edge / grid / axes toggles, render quality, Export image…, section
 * from a face, section only, look at section, Measure points / pin), spliced
 * into `registry.ts`'s `COMMANDS` so the display menu, View menu, command
 * search, shortcuts and the shortcut sheet all read the same entries.
 */
import { DISPLAY_MODE_ENTRIES, activeDisplayEntry } from '../../viewport/displayModes.js';
import { sectionNormal } from '../../viewport/toolAnchors.js';
import { displayBodyName, useItemsStore } from '../items.js';
import { currentRefs } from '../measure.js';
import { useMeasureStore } from '../measureStore.js';
import { usePreferences } from '../preferences.js';
import {
  findFace,
  isPlanarFace,
  useAssemblerStore,
  type AssemblerState,
} from '../../foundation/commands/store.js';
import { sectionPlaneFromFace } from '../viewDisplay.js';
import { useViewportUi } from '../viewportUi.js';
import { useWorkspaceStore } from '../workspace.js';
import type { Command, CommandAvailability } from '../../foundation/commands/registry.js';

const enabled: CommandAvailability = { enabled: true };

function toggleLabel(on: boolean, what: string): string {
  return `${on ? 'Hide' : 'Show'} ${what}`;
}

/** The single selected planar face, if any. */
function selectedPlanarFace(ctx: AssemblerState) {
  const face = ctx.selection.length === 1 ? ctx.selection[0] : undefined;
  if (face?.kind !== 'face') return null;
  return isPlanarFace(ctx.evaluation, face.bodyId, face.faceKey) ? face : null;
}

/** Puts the section plane on a planar face (and turns Section View on). */
export function sectionAtFace(ctx: AssemblerState, bodyId: string, faceKey: string): boolean {
  const body = ctx.evaluation.bodies.find((b) => b.id === bodyId);
  const face = body ? findFace(body, faceKey) : undefined;
  if (!body || !face) return false;
  const name = displayBodyName(body, useItemsStore.getState());
  const placed = sectionPlaneFromFace(body, face, `Face of ${name}`);
  if (!placed) return false;
  if (!ctx.viewState.sectionEnabled) ctx.setSectionEnabled(true);
  ctx.setSectionPlane(placed.plane);
  ctx.setSectionOffset(placed.offset);
  return true;
}

/** Camera normal to the section plane, looking at the cut faces. */
export function lookAtSection(ctx: AssemblerState): void {
  const view = ctx.viewState;
  const normal = sectionNormal({
    axis: view.sectionAxis,
    offset: view.sectionOffset,
    flipped: view.sectionFlipped,
    plane: view.sectionPlane,
  });
  useWorkspaceStore.getState().sendCamera({ kind: 'lookAlong', direction: [...normal] });
}

const sectionOn = (ctx: AssemblerState): CommandAvailability =>
  ctx.viewState.sectionEnabled
    ? enabled
    : { enabled: false, reason: 'Turn Section View on first.' };

export const DISPLAY_COMMANDS: readonly Command[] = [
  ...DISPLAY_MODE_ENTRIES.map(
    (entry): Command => ({
      id: `display.${entry.id}`,
      label: entry.label,
      group: 'display',
      shortcut: entry.shortcut,
      keywords: ['display mode', 'render', 'shading', entry.hint.toLowerCase()].filter(Boolean),
      adaptive: false,
      availability: (ctx) => ({
        enabled: true,
        recommended:
          activeDisplayEntry(ctx.viewState.displayMode, ctx.viewState.edgesVisible) === entry.id,
      }),
      run: (ctx) => {
        ctx.setDisplayMode(entry.mode);
        if (entry.edges !== undefined) ctx.setViewToggle('edgesVisible', entry.edges);
      },
    }),
  ),
  {
    id: 'display.edges',
    get label() {
      return toggleLabel(currentView().edgesVisible, 'edges');
    },
    group: 'display',
    keywords: ['edges', 'lines', 'outline', 'display'],
    adaptive: false,
    availability: (ctx) =>
      ctx.viewState.displayMode === 'wireframe'
        ? { enabled: false, reason: 'Wireframe always shows edges.' }
        : { enabled: true, recommended: ctx.viewState.edgesVisible },
    run: (ctx) => ctx.setViewToggle('edgesVisible', !ctx.viewState.edgesVisible),
  },
  {
    id: 'display.hiddenEdges',
    get label() {
      return toggleLabel(currentView().hiddenEdgesVisible, 'hidden edges');
    },
    group: 'display',
    shortcut: 'Alt+H',
    keywords: ['hidden lines', 'dashed', 'occluded edges', 'display'],
    adaptive: false,
    availability: (ctx) =>
      ctx.viewState.displayMode === 'xray' || ctx.viewState.displayMode === 'wireframe'
        ? { enabled: false, reason: 'X-Ray and Wireframe show every edge already.' }
        : { enabled: true, recommended: ctx.viewState.hiddenEdgesVisible },
    run: (ctx) => ctx.setViewToggle('hiddenEdgesVisible', !ctx.viewState.hiddenEdgesVisible),
  },
  {
    id: 'display.grid',
    get label() {
      return toggleLabel(currentView().gridVisible, 'grid');
    },
    group: 'display',
    shortcut: 'Alt+G',
    keywords: ['grid', 'floor', 'plane', 'display'],
    adaptive: false,
    availability: (ctx) => ({ enabled: true, recommended: ctx.viewState.gridVisible }),
    run: (ctx) => ctx.setGridVisible(!ctx.viewState.gridVisible),
  },
  {
    id: 'display.axes',
    get label() {
      return toggleLabel(currentView().axesVisible, 'axes');
    },
    group: 'display',
    keywords: ['axes', 'origin', 'xyz', 'display'],
    adaptive: false,
    availability: (ctx) => ({ enabled: true, recommended: ctx.viewState.axesVisible }),
    run: (ctx) => ctx.setViewToggle('axesVisible', !ctx.viewState.axesVisible),
  },
  {
    id: 'display.quality',
    get label() {
      return usePreferences.getState().renderQuality === 'high'
        ? 'Standard quality rendering'
        : 'High quality rendering';
    },
    group: 'display',
    keywords: ['ambient occlusion', 'shadow', 'performance', 'quality', 'gpu'],
    adaptive: false,
    availability: () => ({
      enabled: true,
      recommended: usePreferences.getState().renderQuality === 'high',
    }),
    run: () => {
      const prefs = usePreferences.getState();
      prefs.setPreference('renderQuality', prefs.renderQuality === 'high' ? 'standard' : 'high');
    },
  },
  {
    id: 'file.exportImage',
    label: 'Export image…',
    group: 'file',
    shortcut: 'Ctrl+Shift+E',
    keywords: ['screenshot', 'png', 'render', 'picture', 'snapshot', 'image'],
    adaptive: false,
    availability: () => enabled,
    run: () => useViewportUi.getState().setExportImageOpen(true),
  },
  {
    id: 'modes.sectionAtFace',
    label: 'Section at face',
    group: 'modes',
    keywords: ['section', 'clip', 'cut', 'plane', 'face', 'cross section'],
    availability: (ctx) =>
      selectedPlanarFace(ctx)
        ? { enabled: true, priority: 4 }
        : { enabled: false, reason: 'Select one planar face.' },
    run: (ctx) => {
      const face = selectedPlanarFace(ctx);
      if (face) sectionAtFace(ctx, face.bodyId, face.faceKey);
    },
  },
  {
    id: 'modes.sectionOnly',
    get label() {
      return currentView().sectionOnly ? 'Show bodies in section' : 'Section only (2D)';
    },
    group: 'modes',
    keywords: ['section', '2d', 'cut only', 'profile', 'cross section'],
    adaptive: false,
    availability: sectionOn,
    run: (ctx) => {
      const next = !ctx.viewState.sectionOnly;
      ctx.setViewToggle('sectionOnly', next);
      if (next) lookAtSection(ctx);
    },
  },
  {
    id: 'view.lookAtSection',
    label: 'Look at section',
    group: 'view',
    keywords: ['normal to section', 'section', 'face on', 'plane'],
    adaptive: false,
    availability: sectionOn,
    run: (ctx) => lookAtSection(ctx),
  },
  {
    id: 'modes.measurePin',
    label: 'Pin measurement',
    group: 'modes',
    keywords: ['measure', 'keep', 'dimension', 'pin'],
    adaptive: false,
    availability: (ctx) => {
      if (!ctx.viewState.measureEnabled)
        return { enabled: false, reason: 'Turn Measure on first.' };
      return currentRefs(ctx.selection, useMeasureStore.getState().points).length > 0
        ? enabled
        : { enabled: false, reason: 'Select something to measure, or pick points.' };
    },
    run: (ctx) => {
      const measure = useMeasureStore.getState();
      measure.pin(currentRefs(ctx.selection, measure.points));
    },
  },
  {
    id: 'modes.measurePoints',
    label: 'Measure points',
    group: 'modes',
    keywords: ['point to point', 'distance', 'measure', 'vertex', 'centre'],
    adaptive: false,
    availability: () => ({ enabled: true, recommended: useMeasureStore.getState().pointMode }),
    run: (ctx) => {
      const measure = useMeasureStore.getState();
      if (!ctx.viewState.measureEnabled) ctx.setMeasureEnabled(true);
      measure.setPointMode(!measure.pointMode);
    },
  },
];

function currentView(): AssemblerState['viewState'] {
  return useAssemblerStore.getState().viewState;
}
