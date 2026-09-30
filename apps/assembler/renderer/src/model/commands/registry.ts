/**
 * Central command registry for the HimmelCAD Assembler UI shell.
 *
 * This is the single source of truth for the main menu, the adaptive
 * toolbar, command search, the context menu and keyboard shortcuts (see
 * `shortcuts.ts`) — per the interaction research (§1, §2, §7), the same
 * action must be reachable from all of these with identical availability
 * and identical disabled reasons. Nothing outside this file should decide
 * whether a command is enabled.
 */
import { useAutomationStore } from '../../api/app/automationStore.js';
import { PRINT_COMMANDS } from '../../print/printCommands.js';
import { DISPLAY_COMMANDS } from './displayCommands.js';
import { useProjectStore } from '../project/projectStore.js';
import { BLEND_RULE_COMMANDS } from './blendCommands.js';
import { CONSTRUCT_COMMANDS } from './constructCommands.js';
import { FEATURE_COMMANDS } from './featureCommands.js';
import { createDraft } from '../featureTools.js';
import { canStartPickSession, nextStep, PICK_PLANS, sessionSelection } from '../pickSession.js';
import {
  isPlanarFace,
  makeFaceRef,
  setPickFinisher,
  useAssemblerStore,
  type AssemblerState,
  type SelectionItem,
} from '../store.js';
import { SKETCH_COMMANDS } from './sketchCommands.js';
import { useSketchStore } from '../../sketch/session.js';
import { useWorkspaceStore } from '../workspace.js';
import { WORKSPACE_COMMANDS } from './workspaceCommands.js';

/** Read access to the store snapshot and its actions. Commands never mutate `ctx` directly — they call its action methods. */
export type CommandContext = AssemblerState;

export type CommandGroup =
  | 'sketch'
  | 'add'
  | 'transform'
  | 'tools'
  | 'construct'
  | 'modes'
  | 'edit'
  | 'view'
  | 'display'
  | 'file';

export interface CommandAvailability {
  enabled: boolean;
  /** Why the command is disabled. Only meaningful when `enabled` is `false`. */
  reason?: string;
  /** Whether the adaptive toolbar should surface this command first for the current selection. */
  recommended?: boolean;
  /** Higher sorts first among `recommended` (or among enabled) commands. Defaults to `0`. */
  priority?: number;
}

/** Keyboard context a shortcut is resolved in (see `Command.shortcutScope`). */
export type ShortcutScope = 'sketch' | 'model';

export interface Command {
  id: string;
  label: string;
  group: CommandGroup;
  /** Display form of the shortcut, e.g. `'E'`, `'Ctrl+Z'`, `'Ctrl+1'`. */
  shortcut?: string;
  /**
   * Where the shortcut resolves: `'sketch'` only while a sketch is open,
   * `'model'` only outside sketch mode; absent = everywhere. Two commands
   * may share a key only in disjoint scopes (e.g. `P`: Project in a
   * sketch, Printability in the model).
   */
  shortcutScope?: ShortcutScope;
  keywords?: string[];
  /**
   * `true` for operations that create B-rep features (booleans,
   * fillet/chamfer, shell, revolve): disabled until the CAD kernel is ready.
   */
  requiresKernel?: boolean;
  /**
   * `false` keeps a global command (settings, projection, Select Through …)
   * out of the adaptive toolbar and the selection context menu; it stays in
   * menus, search and shortcuts. Default `true`.
   */
  adaptive?: boolean;
  availability: (ctx: CommandContext) => CommandAvailability;
  run: (ctx: CommandContext) => void;
}

export const KERNEL_LOADING_REASON = 'The CAD kernel is still loading.';
const KERNEL_FAILED_REASON = 'The CAD kernel failed to load.';
function sectionOnly(ctx: CommandContext): CommandAvailability {
  return ctx.viewState.sectionEnabled
    ? alwaysEnabled
    : { enabled: false, reason: 'Turn Section View on first.' };
}

function selected<K extends SelectionItem['kind']>(
  ctx: CommandContext,
  kind: K,
): Array<Extract<SelectionItem, { kind: K }>> {
  return ctx.selection.filter(
    (item): item is Extract<SelectionItem, { kind: K }> => item.kind === kind,
  );
}

const alwaysEnabled: CommandAvailability = { enabled: true };

/** Disabled availability while the kernel is not ready, else `null`. */
function kernelNotReady(ctx: CommandContext): CommandAvailability | null {
  if (ctx.kernelStatus === 'ready') return null;
  return {
    enabled: false,
    reason: ctx.kernelStatus === 'error' ? KERNEL_FAILED_REASON : KERNEL_LOADING_REASON,
  };
}

/** Selected edges if they all belong to one body, else `null`. */
function edgesOfOneBody(ctx: CommandContext) {
  const edges = selected(ctx, 'edge');
  if (edges.length === 0 || edges.length !== ctx.selection.length) return null;
  return edges.every((e) => e.bodyId === edges[0]!.bodyId) ? edges : null;
}

function facesOfOneBody(ctx: CommandContext) {
  const faces = selected(ctx, 'face');
  if (faces.length === 0 || faces.length !== ctx.selection.length) return null;
  return faces.every((f) => f.bodyId === faces[0]!.bodyId) ? faces : null;
}

function booleanAvailability(ctx: CommandContext): CommandAvailability {
  const notReady = kernelNotReady(ctx);
  if (notReady) return notReady;
  const bodies = selected(ctx, 'body');
  if (bodies.length < 2 || bodies.length !== ctx.selection.length) {
    return {
      enabled: false,
      reason: 'Select two or more bodies; the first one selected is kept.',
    };
  }
  return { enabled: true, recommended: true, priority: 60 };
}

/**
 * The full command set. Order here is the declaration-order tiebreak used
 * by {@link resolveAdaptive} and the disabled tail of
 * {@link searchCommands} — keep additions grouped with their siblings.
 */
const RAW_COMMANDS: readonly Command[] = [
  ...SKETCH_COMMANDS,
  {
    id: 'tools.extrude',
    label: 'Extrude',
    group: 'tools',
    shortcut: 'E',
    keywords: ['push', 'pull', 'solidify'],
    availability: (ctx) => {
      const faces = selected(ctx, 'face');
      const profiles = selected(ctx, 'sketchProfile');
      const singleFace = ctx.selection.length === 1 && faces.length === 1;
      const singleProfile = ctx.selection.length === 1 && profiles.length === 1;
      if (!singleFace && !singleProfile) {
        return { enabled: false, reason: 'Select a sketch profile or a body face to extrude.' };
      }
      const notReady = kernelNotReady(ctx);
      if (notReady) return notReady;
      if (singleFace && !isPlanarFace(ctx.evaluation, faces[0]!.bodyId, faces[0]!.faceKey)) {
        return { enabled: false, reason: 'Only planar faces can be extruded.' };
      }
      return { enabled: true, recommended: true, priority: 100 };
    },
    run: (ctx) => {
      const faces = selected(ctx, 'face');
      const profiles = selected(ctx, 'sketchProfile');
      if (ctx.selection.length === 1 && faces.length === 1) {
        const face = faces[0]!;
        const ref = makeFaceRef(ctx.evaluation, face.bodyId, face.faceKey);
        if (ref) ctx.beginExtrude({ kind: 'face', face: ref });
        return;
      }
      if (ctx.selection.length === 1 && profiles.length === 1) {
        const { featureId, regionKey } = profiles[0]!;
        ctx.beginExtrude({
          kind: 'sketch',
          featureId,
          ...(regionKey ? { regions: [regionKey] } : {}),
        });
      }
    },
  },
  {
    id: 'tools.filletChamfer',
    label: 'Fillet/Chamfer',
    group: 'tools',
    shortcut: 'F',
    keywords: ['round', 'bevel', 'edge'],
    requiresKernel: true,
    availability: (ctx) => {
      const notReady = kernelNotReady(ctx);
      if (notReady) return notReady;
      if (!edgesOfOneBody(ctx)) {
        return { enabled: false, reason: 'Select one or more edges of one body.' };
      }
      return { enabled: true, recommended: true, priority: 100 };
    },
    run: (ctx) => ctx.beginEdgeBlend('fillet'),
  },
  {
    id: 'tools.chamfer',
    label: 'Chamfer',
    group: 'tools',
    keywords: ['bevel', 'edge', 'fillet'],
    requiresKernel: true,
    availability: (ctx) => {
      const notReady = kernelNotReady(ctx);
      if (notReady) return notReady;
      if (!edgesOfOneBody(ctx)) {
        return { enabled: false, reason: 'Select one or more edges of one body.' };
      }
      return { enabled: true, recommended: true, priority: 90 };
    },
    run: (ctx) => ctx.beginEdgeBlend('chamfer'),
  },
  {
    id: 'tools.shell',
    label: 'Shell',
    group: 'tools',
    shortcut: 'H',
    keywords: ['hollow', 'thin wall'],
    requiresKernel: true,
    availability: (ctx) => {
      const notReady = kernelNotReady(ctx);
      if (notReady) return notReady;
      if (!facesOfOneBody(ctx)) {
        return { enabled: false, reason: 'Select the faces of one body to open.' };
      }
      return { enabled: true, priority: 50 };
    },
    run: (ctx) => ctx.beginShell(),
  },
  ...BLEND_RULE_COMMANDS,
  ...FEATURE_COMMANDS,
  ...CONSTRUCT_COMMANDS,
  {
    id: 'tools.union',
    label: 'Union',
    group: 'tools',
    shortcut: 'Ctrl+U',
    keywords: ['boolean', 'combine', 'add'],
    requiresKernel: true,
    availability: booleanAvailability,
    run: (ctx) => ctx.beginBoolean('union'),
  },
  {
    id: 'tools.subtract',
    label: 'Subtract',
    group: 'tools',
    shortcut: 'Ctrl+B',
    keywords: ['boolean', 'cut', 'remove'],
    requiresKernel: true,
    availability: booleanAvailability,
    run: (ctx) => ctx.beginBoolean('subtract'),
  },
  {
    id: 'tools.intersect',
    label: 'Intersect',
    group: 'tools',
    shortcut: 'Ctrl+I',
    keywords: ['boolean', 'common'],
    requiresKernel: true,
    availability: booleanAvailability,
    run: (ctx) => ctx.beginBoolean('intersect'),
  },
  {
    id: 'transform.moveRotate',
    label: 'Move/Rotate',
    group: 'transform',
    shortcut: 'M',
    keywords: [
      'move',
      'rotate',
      'translate',
      'transform',
      'gizmo',
      'mv',
      'move face',
      'move profile',
    ],
    availability: (ctx) => {
      // Shapr3D Move/Rotate takes sketch regions, edges, faces and bodies (modelling research §4).
      if (ctx.selection.length !== 1) {
        return {
          enabled: false,
          reason: 'Select one body, face or sketch profile to move or rotate.',
        };
      }
      const item = ctx.selection[0]!;
      if (item.kind === 'body') return { enabled: true, recommended: true, priority: 90 };
      if (item.kind === 'sketchProfile') return { enabled: true, priority: 60 };
      if (item.kind === 'face') {
        const notReady = kernelNotReady(ctx);
        if (notReady) return notReady;
        // A face moves along its normal (Offset Face); Offset Face stays the recommended entry.
        return { enabled: true, priority: 70 };
      }
      if (item.kind === 'edge') {
        return {
          enabled: false,
          reason:
            'Edges cannot be moved on their own with this kernel build (it lacks face replacement); move a face next to the edge, or the body.',
        };
      }
      return {
        enabled: false,
        reason: 'Select one body, face or sketch profile to move or rotate.',
      };
    },
    run: (ctx) => {
      if (ctx.selection.length !== 1) return;
      const item = ctx.selection[0]!;
      if (item.kind === 'body') ctx.beginMove(item.bodyId);
      else if (item.kind === 'sketchProfile') ctx.beginMoveSketch(item.featureId, item.regionKey);
      else if (item.kind === 'face') {
        const start = createDraft('offsetFace', ctx);
        if (start.ok && start.draft.kind === 'offsetFace') {
          ctx.beginFeatureTool({ ...start.draft, distance: 0, viaMove: true });
        }
      }
    },
  },
  {
    id: 'transform.delete',
    label: 'Delete',
    group: 'transform',
    shortcut: 'Del',
    keywords: ['remove', 'erase'],
    availability: (ctx) =>
      ctx.selection.length > 0 ? alwaysEnabled : { enabled: false, reason: 'Nothing selected.' },
    run: (ctx) => {
      // Deleting faces removes them from the body and heals it (Delete Face tool).
      if (ctx.selection.every((item) => item.kind === 'face')) {
        const deleteFace = FEATURE_COMMANDS.find((c) => c.id === 'tools.deleteFace');
        if (deleteFace?.availability(ctx).enabled) deleteFace.run(ctx);
        return;
      }
      for (const item of ctx.selection) {
        if (item.kind === 'feature' || item.kind === 'sketchProfile' || item.kind === 'datum') {
          ctx.deleteFeature(item.featureId);
        } else if (item.kind === 'body') {
          const body = ctx.evaluation.bodies.find((b) => b.id === item.bodyId);
          if (body) ctx.deleteFeature(body.createdBy);
        } else if (item.kind === 'mesh') {
          // An imported STL reference mesh is not a step: it is removed from the project.
          ctx.removeReferenceMesh(item.meshId);
        }
      }
      ctx.clearSelection();
    },
  },
  ...(
    [
      ['view.front', 'Front', 'front', 'Ctrl+2'],
      ['view.back', 'Back', 'back', 'Ctrl+3'],
      ['view.top', 'Top', 'top', 'Ctrl+4'],
      ['view.bottom', 'Bottom', 'bottom', 'Ctrl+5'],
      ['view.right', 'Right', 'right', 'Ctrl+6'],
      ['view.left', 'Left', 'left', 'Ctrl+7'],
      ['view.iso', 'Iso (reset)', 'iso', 'Ctrl+1'],
    ] as const
  ).map(([id, label, preset, shortcut]) => ({
    id,
    label,
    group: 'view' as const,
    shortcut,
    keywords: ['view', 'camera', preset, ...(preset === 'iso' ? ['home', 'reset'] : [])],
    availability: (): CommandAvailability => alwaysEnabled,
    run: (ctx: CommandContext) => {
      // Ctrl+1 is Shapr3D's "Reset": the isometric home view, fitted.
      if (preset === 'iso') useWorkspaceStore.getState().sendCamera({ kind: 'home' });
      else ctx.requestCamera(preset);
    },
  })),
  {
    id: 'view.zoomToFit',
    label: 'Zoom to fit',
    group: 'view',
    keywords: ['view', 'camera', 'frame all'],
    availability: () => alwaysEnabled,
    run: (ctx) => ctx.requestCamera('fit'),
  },
  ...WORKSPACE_COMMANDS,
  ...PRINT_COMMANDS,
  ...DISPLAY_COMMANDS,
  {
    id: 'modes.section',
    label: 'Section View',
    group: 'modes',
    keywords: ['clip', 'cutaway'],
    availability: (ctx) => ({ enabled: true, recommended: ctx.viewState.sectionEnabled }),
    run: (ctx) => ctx.setSectionEnabled(!ctx.viewState.sectionEnabled),
  },
  ...(['X', 'Y', 'Z'] as const).map(
    (axis): Command => ({
      id: `modes.sectionAxis${axis}`,
      label: `Section along ${axis}`,
      group: 'modes',
      keywords: ['section', 'clip', 'axis', 'plane', axis.toLowerCase()],
      availability: sectionOnly,
      run: (ctx) => ctx.setSectionAxis(axis),
    }),
  ),
  {
    id: 'modes.sectionFlip',
    label: 'Flip section',
    group: 'modes',
    keywords: ['section', 'clip', 'reverse', 'other side'],
    availability: sectionOnly,
    run: (ctx) => ctx.setSectionFlipped(!ctx.viewState.sectionFlipped),
  },
  {
    id: 'modes.isolate',
    label: 'Isolate',
    group: 'modes',
    keywords: ['focus', 'hide others'],
    availability: (ctx) => {
      const active = ctx.isolatedBodyIds !== null;
      const bodies = selected(ctx, 'body');
      if (active || bodies.length > 0) return { enabled: true, recommended: active };
      return { enabled: false, reason: 'Select a body to isolate.' };
    },
    run: (ctx) => {
      if (ctx.isolatedBodyIds !== null) {
        ctx.setIsolatedBodyIds(null);
        return;
      }
      const bodies = selected(ctx, 'body');
      if (bodies.length > 0) ctx.setIsolatedBodyIds(bodies.map((b) => b.bodyId));
    },
  },
  {
    id: 'modes.measure',
    label: 'Measure',
    group: 'modes',
    keywords: ['distance', 'dimension'],
    availability: (ctx) => ({ enabled: true, recommended: ctx.viewState.measureEnabled }),
    run: (ctx) => ctx.setMeasureEnabled(!ctx.viewState.measureEnabled),
  },
  {
    id: 'edit.undo',
    label: 'Undo',
    group: 'edit',
    shortcut: 'Ctrl+Z',
    keywords: ['history back'],
    availability: (ctx) =>
      ctx.history.canUndo ? alwaysEnabled : { enabled: false, reason: 'Nothing to undo.' },
    run: (ctx) => ctx.undo(),
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    group: 'edit',
    shortcut: 'Ctrl+Shift+Z',
    keywords: ['history forward'],
    availability: (ctx) =>
      ctx.history.canRedo ? alwaysEnabled : { enabled: false, reason: 'Nothing to redo.' },
    run: (ctx) => ctx.redo(),
  },
  {
    id: 'edit.hide',
    label: 'Hide',
    group: 'edit',
    keywords: ['visibility', 'invisible'],
    availability: (ctx) => {
      const count = selected(ctx, 'body').length + selected(ctx, 'mesh').length;
      return count > 0 ? alwaysEnabled : { enabled: false, reason: 'Select a body to hide.' };
    },
    run: (ctx) => {
      ctx.hideBodies(selected(ctx, 'body').map((b) => b.bodyId));
      for (const mesh of selected(ctx, 'mesh')) ctx.setReferenceMeshHidden(mesh.meshId, true);
    },
  },
  {
    id: 'edit.showAll',
    label: 'Show all',
    group: 'edit',
    keywords: ['visibility', 'unhide'],
    availability: (ctx) =>
      ctx.hiddenBodyIds.length > 0 || ctx.referenceMeshes.some((m) => m.hidden)
        ? alwaysEnabled
        : { enabled: false, reason: 'Nothing hidden.' },
    run: (ctx) => {
      ctx.showAllBodies();
      for (const mesh of ctx.referenceMeshes) {
        if (mesh.hidden) ctx.setReferenceMeshHidden(mesh.id, false);
      }
    },
  },
  {
    id: 'edit.selectAllBodies',
    label: 'Select all bodies',
    group: 'edit',
    shortcut: 'Ctrl+A',
    keywords: ['selection'],
    availability: (ctx) =>
      ctx.evaluation.bodies.length > 0
        ? alwaysEnabled
        : { enabled: false, reason: 'No bodies in the document.' },
    run: (ctx) => {
      ctx.evaluation.bodies.forEach((body, index) => {
        ctx.select({ kind: 'body', bodyId: body.id }, { additive: index > 0 });
      });
    },
  },
  {
    id: 'file.home',
    label: 'Home',
    group: 'file',
    shortcut: 'Ctrl+Shift+H',
    keywords: ['start', 'dashboard', 'recent', 'templates', 'welcome', 'projects'],
    adaptive: false,
    availability: () => alwaysEnabled,
    run: () => {
      const workspace = useWorkspaceStore.getState();
      workspace.setHomeOpen(!workspace.homeOpen);
    },
  },
  {
    id: 'file.new',
    label: 'New',
    group: 'file',
    shortcut: 'Ctrl+N',
    keywords: ['project', 'blank'],
    availability: () => alwaysEnabled,
    run: () => useProjectStore.getState().requestNew(),
  },
  {
    id: 'file.open',
    label: 'Open…',
    group: 'file',
    shortcut: 'Ctrl+O',
    keywords: ['project', 'load'],
    availability: () => alwaysEnabled,
    run: () => useProjectStore.getState().requestOpen(),
  },
  {
    id: 'file.save',
    label: 'Save',
    group: 'file',
    shortcut: 'Ctrl+S',
    keywords: ['project', 'persist'],
    availability: () => alwaysEnabled,
    run: () => void useProjectStore.getState().save(),
  },
  {
    id: 'file.saveAs',
    label: 'Save As…',
    group: 'file',
    // Ctrl+Shift+S is Select Through (Shapr3D mapping).
    shortcut: 'Ctrl+Shift+Alt+S',
    keywords: ['project', 'persist', 'copy'],
    availability: () => alwaysEnabled,
    run: () => void useProjectStore.getState().saveAs(),
  },
  {
    id: 'file.exportStlAll',
    label: 'Export STL (All Bodies)',
    group: 'file',
    keywords: ['export', 'print', 'stl'],
    availability: (ctx) =>
      ctx.evaluation.bodies.length > 0
        ? alwaysEnabled
        : { enabled: false, reason: 'No bodies to export.' },
    run: () => void useProjectStore.getState().exportStlAll(),
  },
  {
    id: 'file.exportStlBody',
    label: 'Export STL (Selected Body)',
    group: 'file',
    keywords: ['export', 'print', 'stl', 'body'],
    availability: (ctx) => {
      const bodies = selected(ctx, 'body');
      return bodies.length === 1 && ctx.selection.length === 1
        ? alwaysEnabled
        : { enabled: false, reason: 'Select exactly one body.' };
    },
    run: (ctx) => {
      const bodies = selected(ctx, 'body');
      if (bodies.length === 1) void useProjectStore.getState().exportStlBody(bodies[0]!.bodyId);
    },
  },
  {
    id: 'file.export3mf',
    label: 'Export 3MF',
    group: 'file',
    keywords: ['export', 'print', '3mf'],
    availability: (ctx) =>
      ctx.evaluation.bodies.length > 0
        ? alwaysEnabled
        : { enabled: false, reason: 'No bodies to export.' },
    run: () => void useProjectStore.getState().export3mf(),
  },
  {
    id: 'file.exportStep',
    label: 'Export STEP',
    group: 'file',
    keywords: ['export', 'step', 'cad'],
    requiresKernel: true,
    availability: (ctx) => {
      const notReady = kernelNotReady(ctx);
      if (notReady) return notReady;
      return ctx.evaluation.bodies.length > 0
        ? alwaysEnabled
        : { enabled: false, reason: 'No bodies to export.' };
    },
    run: () => void useProjectStore.getState().exportStep(),
  },
  {
    id: 'file.importStep',
    label: 'Import STEP…',
    group: 'file',
    keywords: ['import', 'step', 'cad'],
    requiresKernel: true,
    availability: (ctx) => kernelNotReady(ctx) ?? alwaysEnabled,
    run: () => void useProjectStore.getState().importStep(),
  },
  {
    id: 'file.importStl',
    label: 'Import STL…',
    group: 'file',
    keywords: ['import', 'stl', 'mesh', 'scan', 'reference'],
    // Never a kernel input (`apps/assembler/README.md` "STL import"): the
    // reference mesh is stored and rendered outside OCCT entirely, so this
    // works even while the kernel is still loading or unavailable.
    availability: () => alwaysEnabled,
    run: () => void useProjectStore.getState().importStl(),
  },
  {
    id: 'file.agentAccess',
    label: 'Agent Access (Local)',
    group: 'file',
    keywords: ['agent', 'automation', 'python', 'api', 'ai', 'script', 'endpoint'],
    availability: () => {
      const automation = useAutomationStore.getState();
      if (!automation.available) {
        return { enabled: false, reason: 'Only available in the desktop app.' };
      }
      return { enabled: true, recommended: automation.enabled };
    },
    run: () => {
      const automation = useAutomationStore.getState();
      void automation.setEnabled(!automation.enabled);
    },
  },
];

// ---- tool before selection (UI-16) --------------------------------------------------------

/**
 * A command with a pick plan (`pickSession.ts`) is also available when its
 * selection is missing (empty, or only part of what it needs): running it
 * then opens a pick session that asks for the references step by step.
 * When the selection already fits, the command behaves exactly as before.
 */
function withPickSession(command: Command): Command {
  if (!PICK_PLANS[command.id]) return command;
  return {
    ...command,
    availability: (ctx) => {
      const own = command.availability(ctx);
      // Not while a tool runs or a sketch is open (its keys belong to the sketch).
      if (own.enabled || ctx.activeTool || useSketchStore.getState().session) return own;
      if (command.id !== 'transform.moveRotate') {
        const notReady = kernelNotReady(ctx);
        if (notReady) return notReady;
      }
      if (!canStartPickSession(command.id, ctx.selection, { evaluation: ctx.evaluation })) {
        return own;
      }
      // Not recommended: it asks for its references (the adaptive bar lists actions for the selection).
      return { enabled: true, priority: 20 };
    },
    run: (ctx) => {
      if (command.availability(ctx).enabled) command.run(ctx);
      else ctx.beginPickSession(command.id);
    },
  };
}

/**
 * Finishes the running pick session (the store's Done/Enter): the next step,
 * or — every reference picked — the command itself, started from exactly
 * those references as its selection.
 */
function finishPickSession(): void {
  const store = useAssemblerStore.getState();
  const tool = store.activeTool;
  if (tool?.kind !== 'pick') return;
  const { kind: _kind, phase: _phase, ...session } = tool;
  const { session: next, done } = nextStep(session);
  if (!done) {
    store.updatePickSession(() => next);
    return;
  }
  const command = RAW_COMMANDS.find((c) => c.id === session.commandId);
  store.cancel();
  store.setSelection(sessionSelection(session));
  const ctx = useAssemblerStore.getState();
  if (!command) return;
  const availability = command.availability(ctx);
  if (!availability.enabled) {
    useWorkspaceStore.getState().notify(availability.reason ?? 'The tool cannot start.', 'warning');
    return;
  }
  command.run(ctx);
}

/**
 * The full command set: tools with a pick plan start before their selection too
 * ({@link withPickSession}).
 */
export const COMMANDS: readonly Command[] = RAW_COMMANDS.map(withPickSession);

setPickFinisher(finishPickSession);

function toResultAvailability(availability: CommandAvailability): CommandAvailability {
  if (availability.reason === undefined) {
    const { reason: _reason, ...rest } = availability;
    return rest;
  }
  return availability;
}

/**
 * Whether the selection changes what `command` offers: it is disabled, or
 * differently recommended, without a selection. Commands that behave the
 * same with and without a selection (New, Open, view presets, Measure …)
 * are not actions _for the selection_ and stay out of the adaptive bar and
 * its "More" list (Shapr3D: "More" lists further valid actions for the
 * selection — interaction research §2).
 */
function selectionScoped(
  command: Command,
  availability: CommandAvailability,
  ctx: CommandContext,
): boolean {
  if (ctx.selection.length === 0) return true;
  const without = command.availability({ ...ctx, selection: [] });
  if (!without.enabled) return true;
  return (
    (without.recommended ?? false) !== (availability.recommended ?? false) ||
    (without.priority ?? 0) !== (availability.priority ?? 0)
  );
}

/**
 * Ordered list of enabled commands for the current selection, recommended
 * command first (face -> Offset Face, sketch profile -> Extrude, body ->
 * Move/Rotate, …), then by descending `priority`, then by declaration order
 * in {@link COMMANDS}. Only selection-scoped commands are listed (see
 * {@link selectionScoped}). Availability only ever reads `ctx.selection`
 * and other document/view state — never `ctx.hover` — so this ordering is
 * stable across hover changes, as required by the interaction research
 * (§2): the adaptive toolbar must not reflow on mouse-over.
 */
export function resolveAdaptive(ctx: CommandContext): Command[] {
  return COMMANDS.filter((command) => command.adaptive !== false)
    .map((command) => ({ command, availability: command.availability(ctx) }))
    .filter(
      (entry) =>
        entry.availability.enabled && selectionScoped(entry.command, entry.availability, ctx),
    )
    .sort((a, b) => {
      const aRecommended = a.availability.recommended ? 1 : 0;
      const bRecommended = b.availability.recommended ? 1 : 0;
      if (aRecommended !== bRecommended) return bRecommended - aRecommended;
      const aPriority = a.availability.priority ?? 0;
      const bPriority = b.availability.priority ?? 0;
      if (aPriority !== bPriority) return bPriority - aPriority;
      return COMMANDS.indexOf(a.command) - COMMANDS.indexOf(b.command);
    })
    .map((entry) => entry.command);
}

export interface CommandSearchResult {
  command: Command;
  enabled: boolean;
  reason?: string;
  score: number;
}

/** Match quality tiers of {@link matchScore}; a higher tier always ranks first. */
export const MATCH_TIER = {
  /** The whole text, or the command's shortcut ("e" -> Extrude). */
  exact: 5,
  /** The text starts with the query ("ext" -> Extrude). */
  prefix: 4,
  /** A later word starts with the query ("rot" -> Move/Rotate). */
  wordPrefix: 3,
  /** Consecutive prefixes of words in order ("p3" -> Pattern 3D, "nsxy" -> New Sketch on XY). */
  abbreviation: 2,
  /** Letters in order anywhere ("mv" -> Move). */
  subsequence: 1,
} as const;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * Whether `query` splits into non-empty prefixes of `ws[i..]` taken in order
 * (words may be skipped). Returns the number of skipped words (lower is
 * better) or `null`.
 */
function abbreviationSkips(query: string, ws: readonly string[]): number | null {
  const memo = new Map<string, number | null>();
  const go = (q: number, w: number): number | null => {
    if (q === query.length) return 0;
    if (w >= ws.length) return null;
    const key = `${q}:${w}`;
    if (memo.has(key)) return memo.get(key)!;
    let best: number | null = null;
    const word = ws[w]!;
    // Use a prefix of this word …
    for (let len = Math.min(word.length, query.length - q); len >= 1; len -= 1) {
      if (word.slice(0, len) !== query.slice(q, q + len)) continue;
      const rest = go(q + len, w + 1);
      if (rest !== null && (best === null || rest < best)) best = rest;
    }
    // … or skip it.
    const skipped = go(q, w + 1);
    if (skipped !== null && (best === null || skipped + 1 < best)) best = skipped + 1;
    memo.set(key, best);
    return best;
  };
  return go(0, 0);
}

function subsequenceScore(query: string, haystack: string): number | null {
  let cursor = 0;
  let firstMatchIndex = -1;
  let lastMatchIndex = -1;
  for (const ch of query) {
    const found = haystack.indexOf(ch, cursor);
    if (found === -1) return null;
    if (firstMatchIndex === -1) firstMatchIndex = found;
    lastMatchIndex = found;
    cursor = found + 1;
  }
  const span = lastMatchIndex - firstMatchIndex + 1;
  const density = query.length / Math.max(span, query.length);
  return 100 * density - firstMatchIndex;
}

/**
 * Score of `query` (lower-case, trimmed) against one text: `tier * 1000 +
 * within-tier score`, or `null` for no match. Tiers per {@link MATCH_TIER}.
 * Shapr3D's command search accepts shortened fuzzy input such as "p3" or
 * "snu" (interaction research §6); word-initial abbreviations cover these,
 * plain subsequences are the weakest fallback.
 */
export function matchScore(query: string, text: string): number | null {
  const haystack = text.toLowerCase();
  if (!query || !haystack) return null;
  if (haystack === query) return MATCH_TIER.exact * 1000;
  if (haystack.startsWith(query)) return MATCH_TIER.prefix * 1000 + 100 - haystack.length;
  const ws = words(haystack);
  const wordIndex = ws.findIndex((w, i) => i > 0 && w.startsWith(query));
  if (wordIndex > 0) return MATCH_TIER.wordPrefix * 1000 + 100 - wordIndex * 10 - haystack.length;
  const compact = query.replace(/[^a-z0-9]+/g, '');
  const skips = compact ? abbreviationSkips(compact, ws) : null;
  if (skips !== null) return MATCH_TIER.abbreviation * 1000 + 100 - skips * 10 - ws.length;
  const sub = subsequenceScore(query, haystack);
  return sub === null ? null : MATCH_TIER.subsequence * 1000 + sub;
}

function fuzzyScore(query: string, command: Command): number | null {
  let best: number | null = null;
  const consider = (score: number | null) => {
    if (score !== null && (best === null || score > best)) best = score;
  };
  // The command's own name beats an equally good keyword ("hole" -> Hole, not Circle).
  consider(
    matchScore(query, command.label) === null ? null : matchScore(query, command.label)! + 1,
  );
  for (const keyword of command.keywords ?? []) {
    const score = matchScore(query, keyword);
    // A keyword never reaches the exact tier of a label.
    consider(score === null ? null : Math.min(score, MATCH_TIER.prefix * 1000 + 99) - 50);
  }
  if (command.shortcut && command.shortcut.toLowerCase() === query) {
    consider(MATCH_TIER.exact * 1000 - 10);
  }
  return best;
}

function toSearchResult(
  command: Command,
  availability: CommandAvailability,
  score: number,
): CommandSearchResult {
  const cleaned = toResultAvailability(availability);
  return {
    command,
    enabled: cleaned.enabled,
    score,
    ...(cleaned.reason !== undefined ? { reason: cleaned.reason } : {}),
  };
}

/**
 * Fuzzy search over label/keywords/shortcut ("ext" -> Extrude, "mv" ->
 * Move/Rotate, "p3" -> Pattern 3D). Empty query returns
 * `ctx.recentCommandIds` first (in recency order), then the remaining
 * commands in declaration order.
 *
 * Ranking: match tier first ({@link MATCH_TIER}: a typed name always beats a
 * scattered-letter match), then enabled before disabled, then score. With a
 * selection the list is filtered to the actions valid for it, as in
 * Shapr3D (interaction research §6); a disabled command stays listed —
 * with its reason — only when its name matches strongly (prefix or word),
 * so typing a tool's name still explains what it needs.
 */
export function searchCommands(query: string, ctx: CommandContext): CommandSearchResult[] {
  const trimmed = query.trim().toLowerCase();
  const availabilityByCommandId = new Map(COMMANDS.map((c) => [c.id, c.availability(ctx)]));

  if (trimmed === '') {
    const recentSet = new Set(ctx.recentCommandIds);
    const recentOrdered = ctx.recentCommandIds
      .map((id) => COMMANDS.find((c) => c.id === id))
      .filter((c): c is Command => c !== undefined);
    const rest = COMMANDS.filter((c) => !recentSet.has(c.id));
    return [...recentOrdered, ...rest].map((command) =>
      toSearchResult(command, availabilityByCommandId.get(command.id)!, 0),
    );
  }

  const hasSelection = ctx.selection.length > 0;
  const scored = COMMANDS.map((command) => ({
    command,
    score: fuzzyScore(trimmed, command),
  }))
    .filter((entry): entry is { command: Command; score: number } => entry.score !== null)
    .filter(
      (entry) =>
        !hasSelection ||
        availabilityByCommandId.get(entry.command.id)!.enabled ||
        entry.score >= MATCH_TIER.wordPrefix * 1000 - 50,
    );

  const tierOf = (score: number) => Math.floor((score + 50) / 1000);
  scored.sort((a, b) => {
    const tier = tierOf(b.score) - tierOf(a.score);
    if (tier !== 0) return tier;
    const aEnabled = availabilityByCommandId.get(a.command.id)!.enabled;
    const bEnabled = availabilityByCommandId.get(b.command.id)!.enabled;
    if (aEnabled !== bEnabled) return aEnabled ? -1 : 1;
    return b.score - a.score;
  });

  return scored.map(({ command, score }) =>
    toSearchResult(command, availabilityByCommandId.get(command.id)!, score),
  );
}

export function findCommand(id: string): Command | undefined {
  return COMMANDS.find((c) => c.id === id);
}
