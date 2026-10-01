/**
 * Command registry of the HimmelCAD Assembler UI shell.
 *
 * This is the single source of truth for the main menu, the adaptive
 * toolbar, command search, the context menu and keyboard shortcuts (see
 * `shortcuts.ts`) — per the interaction research (§1, §2, §7), the same
 * action must be reachable from all of these with identical availability
 * and identical disabled reasons. A command decides its own availability;
 * nothing else does.
 *
 * The commands come from the modules (assembler/MODULES.md §3): each
 * module registers blocks of commands with an `order`
 * ({@link registerCommands}, normally through `defineAssemblerModule` and
 * the product composition). {@link COMMANDS} is the merged list, blocks in
 * `order`, which is also the declaration-order tie-break of
 * {@link resolveAdaptive} and {@link searchCommands}. This file holds no
 * domain command; only Undo/Redo belong to the gate itself.
 */
import { notify } from './notices.js';
import { canStartPickSession, nextStep, PICK_PLANS, sessionSelection } from './pickSession.js';
import {
  setPickFinisher,
  useAssemblerStore,
  type AssemblerState,
  type SelectionItem,
} from './store.js';

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
export const KERNEL_FAILED_REASON = 'The CAD kernel failed to load.';

/** The selected items of one kind. */
export function selected<K extends SelectionItem['kind']>(
  ctx: CommandContext,
  kind: K,
): Array<Extract<SelectionItem, { kind: K }>> {
  return ctx.selection.filter(
    (item): item is Extract<SelectionItem, { kind: K }> => item.kind === kind,
  );
}

export const alwaysEnabled: CommandAvailability = { enabled: true };

/** Disabled availability while the kernel is not ready, else `null`. */
export function kernelNotReady(ctx: CommandContext): CommandAvailability | null {
  if (ctx.kernelStatus === 'ready') return null;
  return {
    enabled: false,
    reason: ctx.kernelStatus === 'error' ? KERNEL_FAILED_REASON : KERNEL_LOADING_REASON,
  };
}

// ---- hooks the modules provide ------------------------------------------------------------

/** Whether a modal editing session (a sketch) owns the keyboard and the selection. */
let modalSessionActive: () => boolean = () => false;

/** Sketching installs its session probe: pick sessions never start inside a sketch. */
export function setModalSessionProbe(probe: () => boolean): void {
  modalSessionActive = probe;
}

// ---- the gate's own commands ---------------------------------------------------------------

const GATE_COMMANDS: readonly Command[] = [
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
];

/**
 * Block orders of the published command order. Modules pick their own
 * numbers; these are the ones in use (keep gaps for new blocks).
 */
export const COMMAND_ORDER = {
  sketch: 100,
  modelingTools: 200,
  blendRules: 300,
  modelingFeatures: 400,
  directEdit: 410,
  modelingFeaturesTail: 420,
  /** The Add menu's primitives (modeling). */
  primitives: 430,
  construct: 500,
  booleans: 600,
  transform: 700,
  view: 800,
  workspace: 900,
  print: 1000,
  printers: 1010,
  display: 1100,
  measureTools: 1150,
  section: 1200,
  measure: 1250,
  history: 1300,
  visibility: 1400,
  file: 1500,
  fileInterop: 1600,
  interop: 1700,
  agent: 1800,
} as const;

// ---- registration ---------------------------------------------------------------------------

interface Block {
  order: number;
  sequence: number;
  module: string;
  commands: readonly Command[];
}

const blocks: Block[] = [];
/** Registered commands by id, as the module wrote them (before {@link withPickSession}). */
const registered = new Map<string, { command: Command; module: string }>();
/** The shortcut each command was registered with (custom shortcuts overwrite `Command.shortcut`). */
const defaultShortcuts = new Map<string, string | undefined>();
/** One wrapped instance per command id, so custom shortcuts written onto it survive a re-merge. */
const wrapped = new Map<string, Command>();
const listeners = new Set<() => void>();

/**
 * The full command set of this build, blocks in `order`: tools with a pick
 * plan start before their selection too ({@link withPickSession}). A live
 * list — registrations update it in place.
 */
export const COMMANDS: readonly Command[] = [];

/** Registers a block of commands; ids must be unique across all modules. */
export function registerCommands(
  order: number,
  commands: readonly Command[],
  module: string,
): void {
  for (const command of commands) {
    const existing = registered.get(command.id);
    if (existing) {
      throw new Error(
        `Command "${command.id}" is registered twice (${existing.module}, ${module})`,
      );
    }
  }
  for (const command of commands) {
    registered.set(command.id, { command, module });
    defaultShortcuts.set(command.id, command.shortcut);
  }
  blocks.push({ order, sequence: blocks.length, module, commands });
  blocks.sort((a, b) => a.order - b.order || a.sequence - b.sequence);
  const merged = COMMANDS as Command[];
  merged.length = 0;
  for (const block of blocks) {
    for (const command of block.commands) {
      let instance = wrapped.get(command.id);
      if (!instance) {
        instance = withPickSession(command);
        wrapped.set(command.id, instance);
      }
      merged.push(instance);
    }
  }
  for (const listener of listeners) listener();
}

/** A command as its module registered it (without the pick-session start of {@link COMMANDS}). */
export function registeredCommand(commandId: string): Command | undefined {
  return registered.get(commandId)?.command;
}

/** The shortcut a command was registered with (the default for "Reset"). */
export function registeredShortcut(commandId: string): string | undefined {
  return defaultShortcuts.get(commandId);
}

/** Calls `listener` after every registration (shortcut maps, caches). */
export function onCommandsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

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
      if (own.enabled || ctx.activeTool || modalSessionActive()) return own;
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
  const command = registered.get(session.commandId)?.command;
  store.cancel();
  store.setSelection(sessionSelection(session));
  const ctx = useAssemblerStore.getState();
  if (!command) return;
  const availability = command.availability(ctx);
  if (!availability.enabled) {
    notify(availability.reason ?? 'The tool cannot start.', 'warning');
    return;
  }
  command.run(ctx);
}

setPickFinisher(finishPickSession);
registerCommands(COMMAND_ORDER.history, GATE_COMMANDS, 'commands');

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
