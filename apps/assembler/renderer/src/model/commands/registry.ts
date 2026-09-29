/**
 * Central command registry for the HimmelCAD Assembler UI shell.
 *
 * This is the single source of truth for the main menu, the adaptive
 * toolbar, command search, the context menu and keyboard shortcuts (see
 * `shortcuts.ts`) â€” per the interaction research (Â§1, Â§2, Â§7), the same
 * action must be reachable from all of these with identical availability
 * and identical disabled reasons. Nothing outside this file should decide
 * whether a command is enabled.
 */
import type { AssemblerState, SelectionItem } from '../store.js';

/** Read access to the store snapshot and its actions. Commands never mutate `ctx` directly â€” they call its action methods. */
export type CommandContext = AssemblerState;

export type CommandGroup =
  | 'sketch'
  | 'add'
  | 'transform'
  | 'tools'
  | 'modes'
  | 'edit'
  | 'view'
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

export interface Command {
  id: string;
  label: string;
  group: CommandGroup;
  /** Display form of the shortcut, e.g. `'E'`, `'Ctrl+Z'`, `'Ctrl+1'`. */
  shortcut?: string;
  keywords?: string[];
  /** `true` for operations that need a real CAD kernel (booleans, fillet/chamfer, shell, revolve). Always disabled in Phase 0. */
  requiresKernel?: boolean;
  availability: (ctx: CommandContext) => CommandAvailability;
  run: (ctx: CommandContext) => void;
}

const KERNEL_REASON = 'Needs the CAD kernel (Phase 1)';
const SKETCH_SOLVER_REASON = 'Requires the sketch solver (Phase 1)';
const PROJECT_FILES_REASON = 'Project files arrive in Phase 1';

function selected<K extends SelectionItem['kind']>(
  ctx: CommandContext,
  kind: K,
): Array<Extract<SelectionItem, { kind: K }>> {
  return ctx.selection.filter(
    (item): item is Extract<SelectionItem, { kind: K }> => item.kind === kind,
  );
}

const alwaysEnabled: CommandAvailability = { enabled: true };

function kernelDisabled(): CommandAvailability {
  return { enabled: false, reason: KERNEL_REASON };
}

/**
 * The full command set. Order here is the declaration-order tiebreak used
 * by {@link resolveAdaptive} and the disabled tail of
 * {@link searchCommands} â€” keep additions grouped with their siblings.
 */
export const COMMANDS: readonly Command[] = [
  {
    id: 'sketch.rectangle',
    label: 'Rectangle',
    group: 'sketch',
    shortcut: 'R',
    keywords: ['sketch', 'rect', 'box profile', 'draw'],
    availability: (ctx) => {
      const faces = selected(ctx, 'face');
      const recommended = ctx.selection.length === 1 && faces.length === 1;
      return { enabled: true, recommended, priority: recommended ? 70 : 0 };
    },
    run: (ctx) => {
      const faces = selected(ctx, 'face');
      if (ctx.selection.length === 1 && faces.length === 1) {
        const face = faces[0]!;
        ctx.beginSketchRectangle({ bodyId: face.bodyId, side: face.side });
        return;
      }
      ctx.beginSketchRectangle();
    },
  },
  {
    id: 'sketch.line',
    label: 'Line',
    group: 'sketch',
    shortcut: 'L',
    keywords: ['sketch', 'draw', 'segment'],
    availability: () => ({ enabled: false, reason: SKETCH_SOLVER_REASON }),
    run: () => undefined,
  },
  {
    id: 'sketch.circle',
    label: 'Circle',
    group: 'sketch',
    shortcut: 'C',
    keywords: ['sketch', 'draw', 'round'],
    availability: () => ({ enabled: false, reason: SKETCH_SOLVER_REASON }),
    run: () => undefined,
  },
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
      return { enabled: true, recommended: true, priority: 100 };
    },
    run: (ctx) => {
      const faces = selected(ctx, 'face');
      const profiles = selected(ctx, 'sketchProfile');
      if (ctx.selection.length === 1 && faces.length === 1) {
        const face = faces[0]!;
        ctx.beginExtrude({ kind: 'face', bodyId: face.bodyId, side: face.side });
        return;
      }
      if (ctx.selection.length === 1 && profiles.length === 1) {
        ctx.beginExtrude({ kind: 'sketch', featureId: profiles[0]!.featureId });
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
    availability: kernelDisabled,
    run: () => undefined,
  },
  {
    id: 'tools.shell',
    label: 'Shell',
    group: 'tools',
    shortcut: 'H',
    keywords: ['hollow', 'thin wall'],
    requiresKernel: true,
    availability: kernelDisabled,
    run: () => undefined,
  },
  {
    id: 'tools.revolve',
    label: 'Revolve',
    group: 'tools',
    shortcut: 'V',
    keywords: ['lathe', 'rotate profile'],
    requiresKernel: true,
    availability: kernelDisabled,
    run: () => undefined,
  },
  {
    id: 'tools.union',
    label: 'Union',
    group: 'tools',
    shortcut: 'Ctrl+U',
    keywords: ['boolean', 'combine', 'add'],
    requiresKernel: true,
    availability: kernelDisabled,
    run: () => undefined,
  },
  {
    id: 'tools.subtract',
    label: 'Subtract',
    group: 'tools',
    shortcut: 'Ctrl+B',
    keywords: ['boolean', 'cut', 'remove'],
    requiresKernel: true,
    availability: kernelDisabled,
    run: () => undefined,
  },
  {
    id: 'tools.intersect',
    label: 'Intersect',
    group: 'tools',
    shortcut: 'Ctrl+I',
    keywords: ['boolean', 'common'],
    requiresKernel: true,
    availability: kernelDisabled,
    run: () => undefined,
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
      for (const item of ctx.selection) {
        if (item.kind === 'feature' || item.kind === 'sketchProfile') {
          ctx.deleteFeature(item.featureId);
        } else if (item.kind === 'body') {
          const body = ctx.evaluation.bodies.find((b) => b.id === item.bodyId);
          if (body) ctx.deleteFeature(body.createdBy);
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
    keywords: ['view', 'camera', preset],
    availability: (): CommandAvailability => alwaysEnabled,
    run: (ctx: CommandContext) => ctx.requestCamera(preset),
  })),
  {
    id: 'view.zoomToFit',
    label: 'Zoom to fit',
    group: 'view',
    keywords: ['view', 'camera', 'frame all'],
    availability: () => alwaysEnabled,
    run: (ctx) => ctx.requestCamera('fit'),
  },
  {
    id: 'modes.section',
    label: 'Section View',
    group: 'modes',
    keywords: ['clip', 'cutaway'],
    availability: (ctx) => ({ enabled: true, recommended: ctx.viewState.sectionEnabled }),
    run: (ctx) => ctx.setSectionEnabled(!ctx.viewState.sectionEnabled),
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
      const bodies = selected(ctx, 'body');
      return bodies.length > 0
        ? alwaysEnabled
        : { enabled: false, reason: 'Select a body to hide.' };
    },
    run: (ctx) => ctx.hideBodies(selected(ctx, 'body').map((b) => b.bodyId)),
  },
  {
    id: 'edit.showAll',
    label: 'Show all',
    group: 'edit',
    keywords: ['visibility', 'unhide'],
    availability: (ctx) =>
      ctx.hiddenBodyIds.length > 0 ? alwaysEnabled : { enabled: false, reason: 'Nothing hidden.' },
    run: (ctx) => ctx.showAllBodies(),
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
    id: 'file.new',
    label: 'New',
    group: 'file',
    keywords: ['project', 'blank'],
    availability: () => ({ enabled: false, reason: PROJECT_FILES_REASON }),
    run: () => undefined,
  },
  {
    id: 'file.open',
    label: 'Open',
    group: 'file',
    keywords: ['project', 'load'],
    availability: () => ({ enabled: false, reason: PROJECT_FILES_REASON }),
    run: () => undefined,
  },
  {
    id: 'file.save',
    label: 'Save',
    group: 'file',
    keywords: ['project', 'persist'],
    availability: () => ({ enabled: false, reason: PROJECT_FILES_REASON }),
    run: () => undefined,
  },
  {
    id: 'file.export3mf',
    label: 'Export 3MF',
    group: 'file',
    keywords: ['export', 'print', '3mf'],
    availability: () => ({ enabled: false, reason: PROJECT_FILES_REASON }),
    run: () => undefined,
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
 * other document/view state â€” never `ctx.hover` â€” so this ordering is
 * stable across hover changes, as required by the interaction research
 * (Â§2): the adaptive toolbar must not reflow on mouse-over.
 */
export function resolveAdaptive(ctx: CommandContext): Command[] {
  return COMMANDS.map((command) => ({ command, availability: command.availability(ctx) }))
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
    const score = subsequenceScore(query, field);
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
