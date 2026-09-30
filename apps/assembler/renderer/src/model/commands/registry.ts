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
import { INTEROP_COMMANDS } from '../../interop/interopCommands.js';
import { useInteropStore } from '../../interop/interopStore.js';
import { PRINT_COMMANDS } from '../../print/printCommands.js';
import { DISPLAY_COMMANDS } from './displayCommands.js';
import { useProjectStore } from '../project/projectStore.js';
import { BLEND_RULE_COMMANDS } from './blendCommands.js';
import { FEATURE_COMMANDS } from './featureCommands.js';
import { isPlanarFace, makeFaceRef, type AssemblerState, type SelectionItem } from '../store.js';
import { SKETCH_COMMANDS } from './sketchCommands.js';
import { useWorkspaceStore } from '../workspace.js';
import { WORKSPACE_COMMANDS } from './workspaceCommands.js';

/** Read access to the store snapshot and its actions. Commands never mutate `ctx` directly — they call its action methods. */
export type CommandContext = AssemblerState;

export type CommandGroup =
  | 'sketch'
  | 'add'
  | 'transform'
  | 'tools'
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
export const COMMANDS: readonly Command[] = [
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
    keywords: ['move', 'rotate', 'translate', 'transform', 'gizmo', 'mv'],
    availability: (ctx) => {
      const bodies = selected(ctx, 'body');
      if (ctx.selection.length !== 1 || bodies.length !== 1) {
        return { enabled: false, reason: 'Select exactly one body to move or rotate.' };
      }
      return { enabled: true, recommended: true, priority: 90 };
    },
    run: (ctx) => {
      const bodies = selected(ctx, 'body');
      if (ctx.selection.length === 1 && bodies.length === 1) {
        ctx.beginMove(bodies[0]!.bodyId);
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
        if (item.kind === 'feature' || item.kind === 'sketchProfile') {
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
    label: 'Export STEP…',
    group: 'file',
    keywords: ['export', 'step', 'cad', 'assembly', 'ap214', 'ap242'],
    requiresKernel: true,
    availability: (ctx) => {
      const notReady = kernelNotReady(ctx);
      if (notReady) return notReady;
      return ctx.evaluation.bodies.length > 0
        ? alwaysEnabled
        : { enabled: false, reason: 'No bodies to export.' };
    },
    // Options dialog (assembly/flat/per body, AP214/AP242, units, visible only): `interop/`.
    run: () => useInteropStore.getState().setStepExportOpen(true),
  },
  {
    id: 'file.importStep',
    label: 'Import STEP…',
    group: 'file',
    keywords: ['import', 'step', 'cad', 'assembly'],
    requiresKernel: true,
    availability: (ctx) => kernelNotReady(ctx) ?? alwaysEnabled,
    // Keeps the product structure (Items folders, names, colours): `interop/interopStore.ts`.
    run: () => void useInteropStore.getState().openImport('step'),
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
    run: () => void useInteropStore.getState().openImport('stl'),
  },
  ...INTEROP_COMMANDS,
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

function toResultAvailability(availability: CommandAvailability): CommandAvailability {
  if (availability.reason === undefined) {
    const { reason: _reason, ...rest } = availability;
    return rest;
  }
  return availability;
}

/**
 * Ordered list of enabled commands for the current selection, recommended
 * command first (face/sketch profile -> Extrude, body -> Move/Rotate),
 * then by descending `priority`, then by declaration order in
 * {@link COMMANDS}. Availability only ever reads `ctx.selection` and
 * other document/view state — never `ctx.hover` — so this ordering is
 * stable across hover changes, as required by the interaction research
 * (§2): the adaptive toolbar must not reflow on mouse-over.
 */
export function resolveAdaptive(ctx: CommandContext): Command[] {
  return COMMANDS.filter((command) => command.adaptive !== false)
    .map((command) => ({ command, availability: command.availability(ctx) }))
    .filter((entry) => entry.availability.enabled)
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

function subsequenceScore(query: string, text: string): number | null {
  const haystack = text.toLowerCase();
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
  const prefixBonus = haystack.startsWith(query) ? 50 : 0;
  return 100 * density + prefixBonus - firstMatchIndex;
}

function fuzzyScore(query: string, command: Command): number | null {
  const fields = [command.label, ...(command.keywords ?? []), command.shortcut ?? ''];
  let best: number | null = null;
  for (const field of fields) {
    if (!field) continue;
    let score = subsequenceScore(query, field);
    // The command's own name beats an equally good keyword of another command ("hole" -> Hole, not Circle).
    if (score !== null && field === command.label) score += 0.5;
    if (score !== null && (best === null || score > best)) best = score;
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
 * Fuzzy subsequence search over label/keywords/shortcut ("ext" -> Extrude,
 * "mv" -> Move/Rotate). Empty query returns `ctx.recentCommandIds` first
 * (in recency order), then the remaining commands in declaration order.
 * Disabled commands are included, always ranked after enabled commands
 * for a non-empty query, each with its `reason`.
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

  const scored = COMMANDS.map((command) => ({
    command,
    score: fuzzyScore(trimmed, command),
  })).filter((entry): entry is { command: Command; score: number } => entry.score !== null);

  scored.sort((a, b) => {
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
