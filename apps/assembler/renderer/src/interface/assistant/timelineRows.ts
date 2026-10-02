/**
 * How the assistant's timeline reads for a product user (pure, tested):
 * a tool call becomes one human line ("Checked printability", "Rendered
 * iso view") instead of its JSON, consecutive tool calls fold into one
 * "N steps" group, and lifecycle noise (usage counters, running/completed
 * turn states) is left out — failures, interruptions, errors and approvals
 * stay visible.
 */
import type { AgentTimelineRow } from '@himmelcad/agent/src/timeline.js';

export type CommandRow = Extract<AgentTimelineRow, { kind: 'command' }>;

export type ToolIcon =
  | 'add'
  | 'edit'
  | 'delete'
  | 'read'
  | 'render'
  | 'print'
  | 'skill'
  | 'api'
  | 'undo'
  | 'file'
  | 'other';

export interface ToolLabel {
  /** What the step did ("Rendered iso view"); present tense while it runs ("Rendering iso view"). */
  text: string;
  icon: ToolIcon;
  state: 'running' | 'done' | 'failed';
  /** The error message of a failed step. */
  error?: string;
}

interface Phrase {
  done: string;
  running: string;
  icon: ToolIcon;
}

const p = (done: string, running: string, icon: ToolIcon): Phrase => ({ done, running, icon });

/** Phrases per agent-API method (`hcasm_call`). */
const METHOD_PHRASES: Record<string, Phrase> = {
  'feature.create': p('Added a step', 'Adding a step', 'add'),
  'feature.edit': p('Changed a step', 'Changing a step', 'edit'),
  'feature.delete': p('Deleted a step', 'Deleting a step', 'delete'),
  'feature.suppress': p('Suppressed a step', 'Suppressing a step', 'edit'),
  'feature.rename': p('Renamed a step', 'Renaming a step', 'edit'),
  'features.list': p('Read the History', 'Reading the History', 'read'),
  'feature.get': p('Read a step', 'Reading a step', 'read'),
  'bodies.list': p('Read the bodies', 'Reading the bodies', 'read'),
  'body.get': p('Read a body', 'Reading a body', 'read'),
  'faces.list': p('Listed faces', 'Listing faces', 'read'),
  'edges.list': p('Listed edges', 'Listing edges', 'read'),
  'sketches.list': p('Listed sketches', 'Listing sketches', 'read'),
  'datums.list': p('Listed planes and axes', 'Listing planes and axes', 'read'),
  'document.get': p('Read the project', 'Reading the project', 'read'),
  'selection.get': p('Read the selection', 'Reading the selection', 'read'),
  'parameters.list': p('Read the parameters', 'Reading the parameters', 'read'),
  'parameter.create': p('Added a parameter', 'Adding a parameter', 'add'),
  'parameter.edit': p('Changed a parameter', 'Changing a parameter', 'edit'),
  'parameter.delete': p('Deleted a parameter', 'Deleting a parameter', 'delete'),
  'print.analyze': p('Checked printability', 'Checking printability', 'print'),
  'print.orientations': p('Ranked print orientations', 'Ranking print orientations', 'print'),
  'print.orient': p('Oriented the part for printing', 'Orienting the part', 'print'),
  'print.placeOnPlate': p('Placed the part on the plate', 'Placing the part on the plate', 'print'),
  'view.render': p('Rendered a view', 'Rendering a view', 'render'),
  'view.inspect': p('Looked at the part from several sides', 'Looking at the part', 'render'),
  'skills.list': p('Looked up skills', 'Looking up skills', 'skill'),
  'skills.read': p('Read a skill', 'Reading a skill', 'skill'),
  'history.undo': p('Undid a step', 'Undoing a step', 'undo'),
  'history.redo': p('Redid a step', 'Redoing a step', 'undo'),
  'transaction.begin': p('Started a group of changes', 'Starting a group of changes', 'edit'),
  'transaction.commit': p('Applied the group of changes', 'Applying the group of changes', 'edit'),
  'transaction.cancel': p('Dropped the group of changes', 'Dropping the group of changes', 'edit'),
  'project.save': p('Saved the project', 'Saving the project', 'file'),
  'project.new': p('Started a new project', 'Starting a new project', 'file'),
  'project.open': p('Opened a project', 'Opening a project', 'file'),
  'api.describe': p('Read the API', 'Reading the API', 'api'),
  'api.hello': p('Connected', 'Connecting', 'api'),
};

const PREFIX_PHRASES: [string, Phrase][] = [
  ['sketch.', p('Edited a sketch', 'Editing a sketch', 'edit')],
  ['measure.', p('Measured', 'Measuring', 'read')],
  ['export.', p('Exported', 'Exporting', 'file')],
  ['import.', p('Imported', 'Importing', 'file')],
  ['image.', p('Changed a reference image', 'Changing a reference image', 'edit')],
];

/** `"hcasm_call · feature.create"`, `"hcasm.view_render · iso"`, `"view_render"` → tool, argument. */
export function parseToolCommand(command: string): { tool: string; arg: string | null } {
  const [head = '', ...rest] = command.split(' · ');
  // Claude names a tool `hcasm_call` (MCP prefix stripped), Codex `hcasm.hcasm_call`.
  const tool = head
    .trim()
    .replace(/^mcp__hcasm__/u, '')
    .replace(/^hcasm\./u, '');
  return { tool: tool || command, arg: rest.length > 0 ? rest.join(' · ').trim() : null };
}

function quoted(value: string): string {
  const short = value.length > 40 ? `${value.slice(0, 39)}…` : value;
  return `“${short}”`;
}

/** The value of `"key": "…"` in a (possibly cut) JSON preview. */
function jsonString(detail: string | undefined, key: string): string | null {
  if (!detail) return null;
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,120})"`, 'u').exec(detail);
  return match ? match[1]!.replace(/\\"/gu, '"') : null;
}

function phraseFor(
  tool: string,
  arg: string | null,
  detail: string | undefined,
): Phrase & { name?: string } {
  if (tool === 'hcasm_call' && arg) {
    const method = arg;
    const phrase =
      METHOD_PHRASES[method] ?? PREFIX_PHRASES.find(([prefix]) => method.startsWith(prefix))?.[1];
    if (method === 'feature.create') {
      const name = jsonString(detail, 'name');
      if (name) return { ...phrase!, done: `Added ${quoted(name)}`, name };
    }
    if (method === 'view.render') {
      const view = jsonString(detail, 'name');
      if (view)
        return {
          ...phrase!,
          done: `Rendered the ${view} view`,
          running: `Rendering the ${view} view`,
        };
    }
    return phrase ?? p(`Called ${method}`, `Calling ${method}`, 'api');
  }
  switch (tool) {
    case 'hcasm_call':
      return p('Called the API', 'Calling the API', 'api');
    case 'view_render':
      return arg
        ? p(`Rendered the ${arg} view`, `Rendering the ${arg} view`, 'render')
        : p('Rendered a view', 'Rendering a view', 'render');
    case 'view_inspect':
      return p('Looked at the part from several sides', 'Looking at the part', 'render');
    case 'skills_list':
      return p('Looked up skills', 'Looking up skills', 'skill');
    case 'skills_read':
      return arg
        ? p(`Read the skill ${quoted(arg)}`, `Reading the skill ${quoted(arg)}`, 'skill')
        : p('Read a skill', 'Reading a skill', 'skill');
    case 'hcasm_methods':
      return arg
        ? p(`Looked up ${arg}`, `Looking up ${arg}`, 'api')
        : p('Looked up the API', 'Looking up the API', 'api');
    default:
      return p(tool, tool, 'other');
  }
}

/** The error message of a failed tool result (`{code, message}` JSON or plain text). */
export function toolError(detail: string | undefined): string {
  if (!detail) return 'The step failed.';
  const message = jsonString(detail, 'message');
  if (message) return message;
  const line = detail.split('\n').find((l) => l.trim()) ?? 'The step failed.';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function toolLabel(row: Pick<CommandRow, 'command' | 'state' | 'detail'>): ToolLabel {
  const { tool, arg } = parseToolCommand(row.command);
  const phrase = phraseFor(tool, arg, row.detail);
  const failed = row.state === 'failed' || (row.state === 'completed' && isErrorResult(row.detail));
  if (failed)
    return { text: phrase.done, icon: phrase.icon, state: 'failed', error: toolError(row.detail) };
  if (row.state === 'completed' || row.state === 'interrupted') {
    return { text: phrase.done, icon: phrase.icon, state: 'done' };
  }
  return { text: `${phrase.running}…`, icon: phrase.icon, state: 'running' };
}

/** A tool result that is an agent-API error (`{"code": …, "message": …}` at the top). */
function isErrorResult(detail: string | undefined): boolean {
  return Boolean(detail && /^\s*\{\s*"code"\s*:\s*"[a-zA-Z]+"\s*,\s*"message"/u.test(detail));
}

/** Lifecycle rows a product user does not need (the timeline keeps failures and interruptions). */
function isNoise(row: AgentTimelineRow): boolean {
  if (row.kind === 'usage') return true;
  if (row.kind === 'state') {
    return ['starting', 'ready', 'running', 'completed', 'awaitingApproval'].includes(row.state);
  }
  return false;
}

/**
 * The rows the timeline shows: noise left out, and every run of two or more
 * consecutive tool calls replaced by its first row (the group anchor);
 * `groups` receives the members of each anchor.
 */
export function foldToolRows(
  rows: readonly AgentTimelineRow[],
  groups: Map<string, CommandRow[]>,
): AgentTimelineRow[] {
  groups.clear();
  const out: AgentTimelineRow[] = [];
  let run: CommandRow[] = [];
  const flush = () => {
    if (run.length === 0) return;
    out.push(run[0]!);
    if (run.length > 1) groups.set(run[0]!.id, run);
    run = [];
  };
  for (const row of rows) {
    if (isNoise(row)) continue;
    if (row.kind === 'command') {
      run.push(row);
      continue;
    }
    flush();
    out.push(row);
  }
  flush();
  return out;
}

/** The summary of a group: "5 steps", the step running now, failures. */
export function groupSummary(members: readonly CommandRow[]): {
  count: number;
  running: ToolLabel | null;
  failed: ToolLabel[];
  last: ToolLabel;
} {
  const labels = members.map(toolLabel);
  return {
    count: members.length,
    running: [...labels].reverse().find((l) => l.state === 'running') ?? null,
    failed: labels.filter((l) => l.state === 'failed'),
    last: labels.at(-1)!,
  };
}
