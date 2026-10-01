/**
 * Selection, navigation and workspace commands (Select Through, deselect,
 * zoom to selection, look at face, projection, saved views, Items/History
 * helpers, settings, shortcut overlay), spliced into `registry.ts`'s
 * `COMMANDS` so menus, command search, the context menu, shortcuts and the
 * shortcut overlay all read the same entries.
 */
import {
  isPlanarFace,
  useAssemblerStore,
  type AssemblerState,
  type SelectionItem,
} from '../../foundation/commands/store.js';
import { usePreferences } from '../../platform/input/preferences.js';
import { viewDirection } from '../../platform/viewport/camera.js';
import {
  MAX_SAVED_VIEWS,
  currentCameraPose,
  nearestOrthoDirection,
  useWorkspaceStore,
} from './workspace.js';
import { useDisplayDialogs } from '../../modules/display/dialogs.js';
import {
  bodyRowKey,
  datumRowKey,
  imageRowKey,
  meshRowKey,
  sketchRowKey,
  useItemsStore,
} from '../../foundation/commands/items.js';
import type { Command, CommandAvailability } from '../../foundation/commands/registry.js';

const enabled: CommandAvailability = { enabled: true };

function selectedBodyIds(ctx: AssemblerState): string[] {
  return ctx.selection
    .filter((s): s is Extract<SelectionItem, { kind: 'body' }> => s.kind === 'body')
    .map((s) => s.bodyId);
}

/** Row key of the Items entry that owns a selection item, or `null` (a reference-image step has one). */
export function itemsRowKeyFor(
  item: SelectionItem,
  features: readonly { id: string; kind: string }[] = [],
): string | null {
  switch (item.kind) {
    case 'body':
    case 'face':
    case 'edge':
      return bodyRowKey(item.bodyId);
    case 'sketchProfile':
    case 'sketchCurve':
      return sketchRowKey(item.featureId);
    case 'mesh':
      return meshRowKey(item.meshId);
    case 'datum':
      return datumRowKey(item.featureId);
    case 'feature':
      return features.some((f) => f.id === item.featureId && f.kind === 'referenceImage')
        ? imageRowKey(item.featureId)
        : null;
  }
}

export const WORKSPACE_COMMANDS: readonly Command[] = [
  {
    id: 'select.through',
    label: 'Select Through',
    group: 'edit',
    shortcut: 'Ctrl+Shift+S',
    keywords: ['occluded', 'hidden', 'behind', 'inside', 'x-ray', 'pick'],
    adaptive: false,
    availability: () => ({
      enabled: true,
      recommended: useWorkspaceStore.getState().selectThrough,
    }),
    run: () => {
      const ws = useWorkspaceStore.getState();
      ws.setSelectThrough(!ws.selectThrough);
    },
  },
  {
    id: 'edit.deselect',
    label: 'Deselect all',
    group: 'edit',
    shortcut: 'Ctrl+Shift+A',
    keywords: ['clear selection', 'unselect', 'none'],
    adaptive: false,
    availability: (ctx) =>
      ctx.selection.length > 0 ? enabled : { enabled: false, reason: 'Nothing selected.' },
    run: (ctx) => ctx.clearSelection(),
  },
  {
    id: 'edit.revealInItems',
    label: 'Reveal in Items',
    group: 'edit',
    keywords: ['find', 'locate', 'items panel', 'tree'],
    adaptive: false,
    availability: (ctx) => {
      const key = ctx.selection[0] ? itemsRowKeyFor(ctx.selection[0], ctx.features) : null;
      return key ? enabled : { enabled: false, reason: 'Select a body, face, edge or sketch.' };
    },
    run: (ctx) => {
      const key = ctx.selection[0] ? itemsRowKeyFor(ctx.selection[0], ctx.features) : null;
      if (!key) return;
      if (!ctx.panels.items) ctx.setPanelVisible('items', true);
      useWorkspaceStore.getState().revealInItems(key);
    },
  },
  {
    id: 'edit.renameBody',
    label: 'Rename',
    group: 'edit',
    keywords: ['name', 'label', 'body name'],
    adaptive: false,
    availability: (ctx) => {
      const bodies = selectedBodyIds(ctx);
      return bodies.length === 1 && ctx.selection.length === 1
        ? enabled
        : { enabled: false, reason: 'Select one body to rename.' };
    },
    run: (ctx) => {
      const bodyId = selectedBodyIds(ctx)[0];
      if (!bodyId) return;
      if (!ctx.panels.items) ctx.setPanelVisible('items', true);
      useWorkspaceStore.getState().renameInItems(bodyRowKey(bodyId));
    },
  },
  {
    id: 'edit.bodyColour',
    label: 'Colour…',
    group: 'edit',
    keywords: ['color', 'appearance', 'material', 'paint', 'filament'],
    adaptive: false,
    availability: (ctx) => {
      if (ctx.kernelStatus !== 'ready') {
        return { enabled: false, reason: 'The CAD kernel is still loading.' };
      }
      return colourTargets(ctx).length > 0
        ? enabled
        : { enabled: false, reason: 'Select a body (or its faces/edges).' };
    },
    run: (ctx) => useDisplayDialogs.getState().setColourDialog(colourTargets(ctx)),
  },
  {
    id: 'edit.invertVisibility',
    label: 'Invert visibility',
    group: 'edit',
    keywords: ['hide', 'show', 'swap', 'visibility'],
    adaptive: false,
    availability: (ctx) =>
      ctx.evaluation.bodies.length > 0
        ? enabled
        : { enabled: false, reason: 'No bodies in the document.' },
    run: (ctx) => {
      const hidden = new Set(ctx.hiddenBodyIds);
      const all = ctx.evaluation.bodies.map((b) => b.id);
      ctx.showBodies(all.filter((id) => hidden.has(id)));
      ctx.hideBodies(all.filter((id) => !hidden.has(id)));
    },
  },
  {
    id: 'edit.newFolder',
    label: 'New folder',
    group: 'edit',
    keywords: ['group', 'organize', 'items'],
    adaptive: false,
    availability: () => enabled,
    run: (ctx) => {
      const keys = ctx.selection
        .map((item) => itemsRowKeyFor(item, ctx.features))
        .filter((k): k is string => k !== null)
        .filter((k, i, all) => all.indexOf(k) === i);
      useItemsStore.getState().createFolder({ keys });
      if (!ctx.panels.items) ctx.setPanelVisible('items', true);
    },
  },
  {
    id: 'view.zoomToSelection',
    label: 'Zoom to selection',
    group: 'view',
    shortcut: 'Z',
    keywords: ['frame', 'focus', 'fit selection', 'zoom to'],
    availability: (ctx) =>
      ctx.selection.length > 0 ? enabled : { enabled: false, reason: 'Nothing selected.' },
    run: () => useWorkspaceStore.getState().sendCamera({ kind: 'fitSelection' }),
  },
  {
    id: 'view.lookAt',
    label: 'Look at face',
    group: 'view',
    shortcut: 'Space',
    keywords: ['normal to', 'face on', 'align view', 'perpendicular'],
    availability: (ctx) => {
      const faces = ctx.selection.filter((s) => s.kind === 'face');
      const face = faces[0];
      if (faces.length !== 1 || face?.kind !== 'face') {
        return { enabled: false, reason: 'Hover or select one planar face.' };
      }
      return isPlanarFace(ctx.evaluation, face.bodyId, face.faceKey)
        ? { enabled: true, priority: 5 }
        : { enabled: false, reason: 'Only planar faces can be viewed face-on.' };
    },
    run: (ctx) => {
      const face = ctx.selection.find((s) => s.kind === 'face');
      if (face?.kind !== 'face') return;
      useWorkspaceStore
        .getState()
        .sendCamera({ kind: 'lookAtFace', bodyId: face.bodyId, faceKey: face.faceKey });
    },
  },
  {
    id: 'view.nearestOrtho',
    label: 'Nearest ortho view',
    group: 'view',
    keywords: ['orthogonal', 'snap view', 'closest view', 'align view', 'square'],
    adaptive: false,
    availability: () =>
      currentCameraPose() ? enabled : { enabled: false, reason: 'The 3D view is not available.' },
    run: () => {
      const pose = currentCameraPose();
      if (!pose) return;
      useWorkspaceStore
        .getState()
        .sendCamera({ kind: 'direction', direction: nearestOrthoDirection(viewDirection(pose)) });
    },
  },
  {
    id: 'view.projection',
    // Names the projection it switches to (menus show no toggle state).
    get label() {
      return usePreferences.getState().projection === 'orthographic'
        ? 'Perspective view'
        : 'Orthographic view';
    },
    group: 'view',
    keywords: ['perspective', 'parallel', 'projection', 'camera', 'fov'],
    adaptive: false,
    availability: () => ({
      enabled: true,
      recommended: usePreferences.getState().projection === 'orthographic',
    }),
    run: () => {
      const prefs = usePreferences.getState();
      prefs.setPreference(
        'projection',
        prefs.projection === 'orthographic' ? 'perspective' : 'orthographic',
      );
    },
  },
  {
    id: 'view.saveView',
    // Shows how many of the 8 slots are used; a saved view also keeps the section state.
    get label() {
      return `Save view (${useWorkspaceStore.getState().savedViews.length}/${MAX_SAVED_VIEWS})`;
    },
    group: 'view',
    keywords: ['camera', 'bookmark', 'saved views', 'store view'],
    adaptive: false,
    availability: () =>
      useWorkspaceStore.getState().savedViews.length < MAX_SAVED_VIEWS
        ? enabled
        : { enabled: false, reason: `Up to ${MAX_SAVED_VIEWS} views can be saved.` },
    run: () => {
      useWorkspaceStore.getState().saveCurrentView();
    },
  },
  {
    id: 'view.parameters',
    get label() {
      return useAssemblerStore.getState().panels.parameters ? 'Hide parameters' : 'Parameters';
    },
    group: 'view',
    shortcut: 'Ctrl+Alt+P',
    keywords: ['variables', 'expressions', 'wall', 'shapr3d'],
    adaptive: false,
    availability: () => ({
      enabled: true,
      recommended: useAssemblerStore.getState().panels.parameters,
    }),
    run: (ctx) => ctx.togglePanel('parameters'),
  },
  {
    id: 'view.settings',
    label: 'Settings…',
    group: 'view',
    shortcut: 'Ctrl+,',
    keywords: ['preferences', 'options', 'units', 'theme', 'navigation', 'hotkeys'],
    adaptive: false,
    availability: () => enabled,
    run: () => useWorkspaceStore.getState().setSettingsOpen(true),
  },
  {
    id: 'view.shortcuts',
    label: 'Keyboard shortcuts',
    group: 'view',
    shortcut: '?',
    keywords: ['help', 'hotkeys', 'cheat sheet', 'keys'],
    adaptive: false,
    availability: () => enabled,
    run: () => useWorkspaceStore.getState().setShortcutOverlay(true),
  },
];

/** Body ids a colour command applies to (selected bodies, or the bodies of selected faces/edges). */
export function colourTargets(ctx: AssemblerState): string[] {
  const ids = new Set(selectedBodyIds(ctx));
  for (const item of ctx.selection) {
    if (item.kind === 'face' || item.kind === 'edge') ids.add(item.bodyId);
  }
  return [...ids];
}
