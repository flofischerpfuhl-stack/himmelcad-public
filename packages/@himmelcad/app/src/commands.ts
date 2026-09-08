import {
  GENERATED_COMMAND_TABLE,
  GENERATED_QUICK_SURFACE_ORDER,
} from './generated/commandTable.js';
import type { SelectionCandidate } from './selection.js';

export const QUICK_SURFACE_ENTRY_CAP = 7;

export type CommandSurface = 'ribbon' | 'contextMenu' | 'quickSurface' | 'console' | 'automation';
export type CommandGroup = 'selection' | 'edit' | 'view' | 'entity-specific';
export type CommandEntityKind = 'point' | 'polyline' | 'mesh' | 'cloud' | 'other';
export type RuntimeCommandId = (typeof GENERATED_COMMAND_TABLE)[number]['id'];

export interface CommandContext {
  readonly hasProject: boolean;
  readonly productId?: string;
  readonly selectedEntityIds: readonly string[];
  readonly selectedEntityKinds: readonly CommandEntityKind[];
  readonly selectedCanonicalEntityKinds?: readonly string[];
  readonly entityKind?: string;
  readonly selectionVisibility?: 'visible' | 'hidden' | 'mixed';
  readonly selectionEditable?: boolean;
  readonly selectionExportable?: boolean;
  readonly clipboardAdmissible?: boolean;
  readonly candidates?: readonly SelectionCandidate[];
}

export interface CommandInvocation {
  readonly id: RuntimeCommandId;
  readonly args: readonly string[];
  readonly source: CommandSurface;
  readonly payload?: unknown;
}

export type CommandExecutor = (invocation: CommandInvocation) => void | Promise<void>;

export interface RuntimeCommandEntry {
  readonly id: RuntimeCommandId;
  readonly label: string;
  readonly kind: 'command' | 'query';
  readonly shortcut: string | null;
  readonly surfaces: Readonly<Record<CommandSurface, boolean>>;
  readonly group: CommandGroup;
  readonly ownerSpec: string;
  readonly products: readonly string[];
  readonly entityKinds: readonly string[] | null;
  readonly allowMultiSelect: boolean;
  readonly productPredicates: Readonly<Record<string, ProductCommandPredicate>> | null;
  readonly isEnabled: (context: CommandContext) => boolean;
}

export interface ProductCommandPredicate {
  readonly selectionExportable: true;
  readonly entityKinds?: readonly string[];
}

const CLOUD = new Set<CommandEntityKind>(['cloud']);

function predicate(name: string): (context: CommandContext) => boolean {
  switch (name) {
    case 'always':
      return () => true;
    case 'hasProject':
      return (context) => context.hasProject;
    case 'hasSelection':
      return (context) => context.selectedEntityIds.length > 0;
    case 'cloudSelection':
      return (context) =>
        context.selectedEntityIds.length > 0 &&
        context.selectedEntityKinds.every((kind) => kind === 'cloud');
    case 'pickCandidates':
      return (context) => (context.candidates?.length ?? 0) > 1;
    case 'clipboardAdmissible':
      return (context) => context.clipboardAdmissible === true;
    case 'singleEditableNonCloud':
      return (context) =>
        context.selectedEntityIds.length === 1 &&
        context.selectionEditable !== false &&
        !CLOUD.has(context.selectedEntityKinds[0] ?? 'other');
    case 'visibleSelection':
      return (context) =>
        context.selectedEntityIds.length > 0 && context.selectionVisibility !== 'hidden';
    case 'hiddenSelection':
      return (context) =>
        context.selectedEntityIds.length > 0 && context.selectionVisibility !== 'visible';
    default:
      throw new Error(`Unknown generated command enablement predicate: ${name}`);
  }
}

export const COMMAND_REGISTRY: readonly RuntimeCommandEntry[] = Object.freeze(
  GENERATED_COMMAND_TABLE.map((row) =>
    Object.freeze({
      id: row.id,
      label: row.label,
      kind: row.kind,
      shortcut: row.shortcut,
      surfaces: row.surfaces,
      group: row.group,
      ownerSpec: row.ownerSpec,
      products: row.products,
      entityKinds: 'entityKinds' in row ? row.entityKinds : null,
      allowMultiSelect: 'allowMultiSelect' in row ? row.allowMultiSelect : true,
      productPredicates:
        'productPredicates' in row
          ? (row.productPredicates as Readonly<Record<string, ProductCommandPredicate>>)
          : null,
      isEnabled: predicate(row.enablement),
    }),
  ),
);

const BY_ID = new Map(COMMAND_REGISTRY.map((entry) => [entry.id, entry]));

export function commandById(id: string): RuntimeCommandEntry | undefined {
  return BY_ID.get(id as RuntimeCommandId);
}

export function commandsForSurface(
  surface: CommandSurface,
  context: CommandContext,
): readonly RuntimeCommandEntry[] {
  const entries = COMMAND_REGISTRY.filter(
    (entry) =>
      entry.surfaces[surface] &&
      commandIsEnabled(entry, context) &&
      (entry.entityKinds === null ||
        (context.selectedCanonicalEntityKinds !== undefined &&
          context.selectedCanonicalEntityKinds.length === context.selectedEntityIds.length &&
          context.selectedCanonicalEntityKinds.every((kind) =>
            entry.entityKinds!.includes(kind),
          ))) &&
      (entry.allowMultiSelect || context.selectedEntityIds.length === 1),
  );
  if (surface !== 'quickSurface') return entries;
  const quickOrder = new Map<string, number>(
    GENERATED_QUICK_SURFACE_ORDER.map((id, index) => [id, index]),
  );
  return entries
    .toSorted(
      (left, right) =>
        (quickOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (quickOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, QUICK_SURFACE_ENTRY_CAP);
}

function commandIsEnabled(entry: RuntimeCommandEntry, context: CommandContext): boolean {
  const productId = context.productId ?? 'builder';
  if (!entry.products.includes(productId) || !entry.isEnabled(context)) return false;
  const productPredicate = entry.productPredicates?.[productId];
  if (!productPredicate) return true;
  if (productPredicate.selectionExportable && context.selectionExportable !== true) return false;
  if (!productPredicate.entityKinds) return true;
  return (
    context.selectedCanonicalEntityKinds !== undefined &&
    context.selectedCanonicalEntityKinds.length === context.selectedEntityIds.length &&
    context.selectedCanonicalEntityKinds.every((kind) =>
      productPredicate.entityKinds!.includes(kind),
    )
  );
}

export function assertRuntimeCommandRegistry(): void {
  const ids = new Set<string>();
  const shortcuts = new Map<string, string>();
  for (const entry of COMMAND_REGISTRY) {
    if (ids.has(entry.id)) throw new Error(`Duplicate runtime command id: ${entry.id}`);
    ids.add(entry.id);
    if (entry.products.length === 0) throw new Error(`Command has no product: ${entry.id}`);
    if (
      !(
        entry.surfaces.ribbon ||
        entry.surfaces.contextMenu ||
        entry.surfaces.quickSurface ||
        entry.surfaces.console
      )
    ) {
      throw new Error(`Command has no visible surface: ${entry.id}`);
    }
    if (!entry.shortcut) continue;
    const key = entry.shortcut.toLowerCase();
    const collision = shortcuts.get(key);
    if (collision)
      throw new Error(`Shortcut collision: ${entry.shortcut} (${collision}, ${entry.id})`);
    shortcuts.set(key, entry.id);
  }
}

assertRuntimeCommandRegistry();

export interface ShortcutEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  preventDefault(): void;
}

export function shortcutForEvent(event: ShortcutEventLike): string {
  const modifiers = [
    event.ctrlKey || event.metaKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
  ].filter(Boolean);
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [...modifiers, key].join('+');
}

export function dispatchRegistryShortcut(
  event: ShortcutEventLike,
  context: CommandContext,
  execute: CommandExecutor,
): boolean {
  const shortcut = shortcutForEvent(event).toLowerCase();
  const entry = COMMAND_REGISTRY.find(
    (candidate) => candidate.shortcut?.toLowerCase() === shortcut,
  );
  if (!entry || !commandIsEnabled(entry, context)) return false;
  event.preventDefault();
  void execute({ id: entry.id, args: [], source: 'ribbon' });
  return true;
}

export function consoleHelpEntries(context?: CommandContext): readonly RuntimeCommandEntry[] {
  return COMMAND_REGISTRY.filter(
    (entry) => entry.surfaces.console && entry.products.includes(context?.productId ?? 'builder'),
  );
}

export function completeConsoleCommand(prefix: string): readonly string[] {
  const normalized = prefix.trim().toLowerCase();
  return consoleHelpEntries()
    .map((entry) => entry.id)
    .filter((id) => id.startsWith(normalized));
}

export async function executeConsoleLine(
  raw: string,
  context: CommandContext,
  execute: CommandExecutor,
): Promise<
  | { readonly kind: 'help'; readonly lines: readonly string[] }
  | { readonly kind: 'executed'; readonly id: RuntimeCommandId }
> {
  const [head = '', ...args] = raw.trim().split(/\s+/);
  if (head.toLowerCase() === 'help') {
    return {
      kind: 'help',
      lines: consoleHelpEntries(context).map(
        (entry) => `${entry.id}${entry.shortcut ? `  ${entry.shortcut}` : ''} — ${entry.label}`,
      ),
    };
  }
  const entry = commandById(head.toLowerCase());
  if (!entry?.surfaces.console) throw new Error(`Unknown command: ${head}`);
  if (!commandIsEnabled(entry, context)) throw new Error(`Command is not available: ${entry.id}`);
  await execute({ id: entry.id, args, source: 'console' });
  return { kind: 'executed', id: entry.id };
}

export async function executeAutomationCommand(
  id: string,
  payload: unknown,
  context: CommandContext,
  execute: CommandExecutor,
): Promise<void> {
  const entry = commandById(id);
  if (!entry?.surfaces.automation) throw new Error(`Automation command is not registered: ${id}`);
  if (!commandIsEnabled(entry, context)) throw new Error(`Automation command is not available: ${id}`);
  await execute({ id: entry.id, args: [], source: 'automation', payload });
}
