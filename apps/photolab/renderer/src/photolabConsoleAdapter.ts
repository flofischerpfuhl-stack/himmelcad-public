import {
  commandsForSurface,
  consoleHelpEntries,
  type CommandContext,
  type RuntimeCommandEntry,
} from '@himmelcad/app/commands';

export interface PhotolabConsoleInvocation {
  readonly entry: RuntimeCommandEntry;
  readonly args: readonly string[];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly alias: RuntimeCommandEntry['console']['aliases'][number] | null;
}

export type PhotolabConsoleExecutor = (
  invocation: PhotolabConsoleInvocation,
) => void | Promise<void>;

export type PhotolabConsoleResult =
  | { readonly kind: 'help'; readonly lines: readonly string[] }
  | { readonly kind: 'executed'; readonly id: string };

export function photolabConsoleRows(): readonly RuntimeCommandEntry[] {
  return consoleHelpEntries({
    hasProject: true,
    productId: 'photolab',
    selectedEntityIds: [],
    selectedEntityKinds: [],
  });
}

export function photolabConsoleVocabulary(): readonly string[] {
  return photolabConsoleRows().flatMap((entry) => [
    entry.id,
    ...entry.console.aliases.map((alias) => alias.name),
  ]);
}

export function photolabConsoleHelpLines(): readonly string[] {
  return photolabConsoleRows().map((entry) => {
    const argumentHelp = entry.console.argumentHelp ? ` ${entry.console.argumentHelp}` : '';
    const aliases = entry.console.aliases
      .map(
        (alias) =>
          `${alias.name}${alias.argumentHelp ? ` ${alias.argumentHelp}` : ''}`,
      )
      .join(', ');
    const lifecycle =
      entry.execution.cancelRoute === null
        ? entry.execution.kind
        : `${entry.execution.kind}; cancel: ${entry.execution.cancelRoute}`;
    return `${entry.id}${argumentHelp} — ${entry.label} · ${lifecycle}${aliases ? ` · Aliases: ${aliases}` : ''}`;
  });
}

function resolveConsoleName(rawName: string): {
  readonly entry: RuntimeCommandEntry;
  readonly alias: RuntimeCommandEntry['console']['aliases'][number] | null;
} | null {
  const normalized = rawName.toLowerCase();
  for (const entry of photolabConsoleRows()) {
    if (entry.id.toLowerCase() === normalized) return { entry, alias: null };
    const alias = entry.console.aliases.find(
      (candidate) => candidate.name.toLowerCase() === normalized,
    );
    if (alias) return { entry, alias };
  }
  return null;
}

function parsePayload(raw: string, entry: RuntimeCommandEntry): Readonly<Record<string, unknown>> {
  if (!raw.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${entry.id} expects ${entry.console.argumentHelp || 'a JSON object'}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${entry.id} arguments must be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export async function runPhotolabConsoleCommand(
  raw: string,
  context: CommandContext,
  execute: PhotolabConsoleExecutor,
): Promise<PhotolabConsoleResult> {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === 'help' || trimmed === '?') {
    return { kind: 'help', lines: photolabConsoleHelpLines() };
  }
  const separator = trimmed.search(/\s/u);
  const name = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const rawArguments = separator < 0 ? '' : trimmed.slice(separator).trim();
  const resolved = resolveConsoleName(name);
  if (!resolved) throw new Error(`Unknown command: ${name || '(empty)'}`);

  const available = commandsForSurface('console', context).some(
    (entry) => entry.id === resolved.entry.id,
  );
  if (!available) throw new Error(`Command is not available: ${resolved.entry.id}`);

  const args = rawArguments ? rawArguments.split(/\s+/u) : [];
  const payload = resolved.alias ? {} : parsePayload(rawArguments, resolved.entry);
  await execute({ ...resolved, args, payload });
  return { kind: 'executed', id: resolved.entry.id };
}
