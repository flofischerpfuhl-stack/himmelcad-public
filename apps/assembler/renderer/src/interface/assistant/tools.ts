/**
 * The assistant's tools (assembler/AGENT-ASSISTANT.md "Tools"): what a
 * Claude/Codex/OpenCode CLI can call while it works on the open project,
 * exposed to it over MCP (`electron/assistantMcpServer.ts` in the app,
 * `assembler-headless --mcp` for external CLIs and the benchmark).
 *
 * The tools are the existing contract, not a second API: `hcasm_call` runs
 * one `hcasm.agent-api@1` method on an {@link AgentSession} (the same
 * validation, kernel checks, undo steps and errors as every other client),
 * `view_render`/`view_inspect` are `view.render`/`view.inspect` with the
 * PNGs as MCP image content, `skills_*` are `skills.list`/`skills.read`, and
 * `hcasm_methods` pages through the published schema. Destructive calls go
 * through the host's approval gate first (the app asks the user; there is no
 * tool an agent could use to answer it).
 */
import type { Json } from '../../foundation/commands/api/contract.js';
import { ApiError, toErrorPayload } from '../../foundation/commands/api/errors.js';
import {
  API_DEFS,
  API_FEATURE_KINDS,
  API_METHODS,
} from '../../foundation/commands/api/registry.js';
import type { JsonSchema } from '../../foundation/commands/api/validate.js';

/** Runs one method of the contract (an `AgentSession`). */
export interface MethodRunner {
  handle(method: string, params: unknown): Promise<unknown>;
}

export interface ApprovalRequest {
  method: string;
  title: string;
  detail: string;
}

export interface ToolHost {
  session: MethodRunner;
  /**
   * The destructive-step gate: `null` = allowed without asking, else a
   * request for the user. Absent (headless): nothing needs approval here,
   * the external CLI's own permission prompts apply.
   */
  classify?: (method: string, params: Json) => ApprovalRequest | null;
  approve?: (request: ApprovalRequest) => Promise<boolean>;
  /** Called after a method ran (the app counts the turn's steps). */
  onMethod?: (method: string, params: Json, result: unknown) => void;
  /** Called with every image a tool returns (the app shows thumbnails in the transcript). */
  onImage?: (image: { mediaType: string; data: string; label: string }) => void;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

/** Tool results are cut here (characters of JSON text). */
export const MAX_TOOL_TEXT = 48 * 1024;
/** Base64 payloads longer than this are left out of text results. */
const MAX_INLINE_DATA = 2048;

const VIEW_RENDER_PASSTHROUGH: JsonSchema = {
  type: 'object',
  description:
    'Parameters of view.render (all optional): view ("iso"|"front"|"back"|"left"|"right"|"top"|"bottom" or {azimuth, elevation}), projection, width, height, bodyIds (isolate), highlight {bodyIds, faces, edges}, tint, section {axis, offset, flip}, displayMode, overlay ["printFindings"], background. hcasm_methods {method: "view.render"} has the full schema.',
};

export const ASSISTANT_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'hcasm_call',
    description:
      'Call one method of the HimmelCAD Assembler agent API (hcasm.agent-api@1) on the open project: queries (document.get, features.list, bodies.list, faces.list, edges.list, print.analyze, measure.*), modeling writes (feature.create/edit/delete, sketch.*, parameter.*), transactions, history.undo/redo. Units mm, Z up. Every write is one editable History step; the whole assistant turn is one undo step for the user. Returns the method result as JSON or an error {code, message, hint, details}. Look parameters up with hcasm_methods first.',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          minLength: 1,
          description: 'Method name, e.g. "feature.create".',
        },
        params: { type: 'object', description: 'The method parameters (see hcasm_methods).' },
      },
      required: ['method'],
      additionalProperties: false,
    },
  },
  {
    name: 'hcasm_methods',
    description:
      'Look up the agent API: without arguments a compact index of all methods; {method} the parameter schema and result of one method; {kind} the parameters of a feature kind for feature.create (sketch, extrude, fillet, shell, hole, …); {def} one shared schema definition (FaceInput, SketchShape, …).',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', minLength: 1 },
        kind: { type: 'string', minLength: 1 },
        def: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'view_render',
    description:
      "Render the model to an image you can look at (default: iso view, orthographic, shaded with edges, 768x576). Use it after building to check shape, openings and placement; isolate, highlight or section to look closer; overlay ['printFindings'] colours printability problems. Never moves the user's camera.",
    inputSchema: VIEW_RENDER_PASSTHROUGH,
  },
  {
    name: 'view_inspect',
    description:
      'Look at the part from several standard views at once (default iso, front, top, right) plus a JSON manifest of bodies (bounding boxes, volumes, validity) and feature errors; overlay ["printFindings"] adds the printability findings.',
    inputSchema: {
      type: 'object',
      description:
        'Parameters of view.inspect (all optional): views, size, bodyIds, section, displayMode, overlay, printSettings, background.',
    },
  },
  {
    name: 'skills_list',
    description:
      'List the assistant skills (workflows with acceptance rules): built-in ones such as "printable-part", "fix-printability", "parametric-part", "api-quickstart", and the project’s own. Optional {query} filters.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, cursor: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
  },
  {
    name: 'skills_read',
    description: 'Read one skill by id (paged: continue with offset = nextOffset).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 }, offset: { type: 'integer', minimum: 0 } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

function text(value: unknown): McpContent {
  let body = typeof value === 'string' ? value : JSON.stringify(value, omitLargeData, 1);
  if (body.length > MAX_TOOL_TEXT) {
    body = `${body.slice(0, MAX_TOOL_TEXT)}\n… (result shortened to ${MAX_TOOL_TEXT} characters; ask for less, e.g. one body or a selector)`;
  }
  return { type: 'text', text: body };
}

function omitLargeData(key: string, value: unknown): unknown {
  if (key === 'data' && typeof value === 'string' && value.length > MAX_INLINE_DATA) {
    return `<${Math.round((value.length * 3) / 4)} bytes of base64 omitted>`;
  }
  return value;
}

function errorResult(error: unknown): McpToolResult {
  return { content: [text(toErrorPayload(error))], isError: true };
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The methods index of `hcasm_methods` (one line per method, grouped by prefix). */
export function methodIndex(): string {
  const groups = new Map<string, string[]>();
  for (const [name, spec] of Object.entries(API_METHODS)) {
    const group = name.split('.')[0]!;
    const summary = spec.summary.split(/(?<=\.)\s/u)[0]!.slice(0, 140);
    const lines = groups.get(group) ?? [];
    lines.push(`- ${name} (${spec.kind}): ${summary}`);
    groups.set(group, lines);
  }
  return [
    'hcasm.agent-api@1 methods (call with hcasm_call {method, params}; details: hcasm_methods {method}).',
    `Feature kinds for feature.create: ${Object.keys(API_FEATURE_KINDS).join(', ')}.`,
    '',
    ...[...groups.entries()].flatMap(([group, lines]) => [`${group}:`, ...lines]),
  ].join('\n');
}

function describeMethods(args: Json): McpToolResult {
  if (typeof args.method === 'string') {
    const spec = API_METHODS[args.method];
    if (!spec) {
      throw new ApiError('methodNotFound', `Unknown method "${args.method}"`, {
        details: {
          candidates: Object.keys(API_METHODS).filter((m) =>
            m.startsWith(args.method!.toString().split('.')[0]!),
          ),
        },
      });
    }
    return { content: [text({ method: args.method, ...spec, refs: refsOf(spec.params) })] };
  }
  if (typeof args.kind === 'string') {
    const kind = API_FEATURE_KINDS[args.kind];
    if (!kind) {
      throw new ApiError('notFound', `Unknown feature kind "${args.kind}"`, {
        details: { candidates: Object.keys(API_FEATURE_KINDS) },
      });
    }
    return { content: [text({ kind: args.kind, ...kind, refs: refsOf(kind.params) })] };
  }
  if (typeof args.def === 'string') {
    const def = API_DEFS[args.def];
    if (!def) {
      throw new ApiError('notFound', `Unknown definition "${args.def}"`, {
        details: { candidates: Object.keys(API_DEFS) },
      });
    }
    return { content: [text({ def: args.def, schema: def, refs: refsOf(def) })] };
  }
  return { content: [text(methodIndex())] };
}

/** `$defs` names a schema refers to (look them up with `{def}`). */
function refsOf(schema: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value)) {
      if (typeof value.$ref === 'string') found.add(value.$ref.replace('#/$defs/', ''));
      Object.values(value).forEach(visit);
    }
  };
  visit(schema);
  return [...found];
}

async function run(host: ToolHost, method: string, params: Json): Promise<unknown> {
  const request = host.classify?.(method, params) ?? null;
  if (request) {
    const approved = host.approve ? await host.approve(request) : false;
    if (!approved) {
      throw new ApiError('permissionDenied', `The user did not approve: ${request.title}`, {
        hint: 'Continue without this step, or ask the user what to do instead.',
      });
    }
  }
  const result = await host.session.handle(method, params);
  host.onMethod?.(method, params, result);
  return result;
}

/** The PNGs of a `view.render` (one) or `view.inspect` (`images`) result as MCP image content. */
function imagesOf(result: unknown): McpContent[] {
  const images: McpContent[] = [];
  const add = (value: Json) => {
    if (value.mediaType === 'image/png' && typeof value.data === 'string') {
      images.push({ type: 'image', data: value.data, mimeType: 'image/png' });
    }
  };
  if (isRecord(result)) {
    add(result);
    if (Array.isArray(result.images)) {
      for (const image of result.images) if (isRecord(image)) add(image);
    }
  }
  return images;
}

/** Runs one MCP tool call; never throws (errors are `isError` results the agent can read). */
export async function callAssistantTool(
  host: ToolHost,
  name: string,
  rawArgs: unknown,
): Promise<McpToolResult> {
  const args = isRecord(rawArgs) ? rawArgs : {};
  try {
    switch (name) {
      case 'hcasm_call': {
        if (typeof args.method !== 'string' || !args.method) {
          throw new ApiError('invalidParams', 'hcasm_call needs {method, params}');
        }
        const params = isRecord(args.params) ? args.params : {};
        const result = await run(host, args.method, params);
        const images =
          args.method === 'view.render' || args.method === 'view.inspect' ? imagesOf(result) : [];
        for (const image of images) {
          if (image.type === 'image')
            host.onImage?.({ mediaType: image.mimeType, data: image.data, label: args.method });
        }
        return { content: [text(result ?? null), ...images] };
      }
      case 'hcasm_methods':
        return describeMethods(args);
      case 'view_render':
      case 'view_inspect': {
        const method = name === 'view_render' ? 'view.render' : 'view.inspect';
        const result = await run(host, method, args);
        const images = imagesOf(result);
        for (const image of images) {
          if (image.type === 'image')
            host.onImage?.({ mediaType: image.mimeType, data: image.data, label: method });
        }
        return { content: [...images, text(result)] };
      }
      case 'skills_list':
        return { content: [text(await run(host, 'skills.list', args))] };
      case 'skills_read': {
        const page = (await run(host, 'skills.read', args)) as Json;
        const header = `Skill ${String(page.id)} (${String(page.scope)}, v${String(page.version)}), characters ${String(page.offset)}–${Number(page.offset) + String(page.text).length} of ${String(page.total)}${page.nextOffset !== null ? ` — continue with offset ${String(page.nextOffset)}` : ''}`;
        return { content: [text(`${header}\n\n${String(page.text)}`)] };
      }
      default:
        throw new ApiError('methodNotFound', `Unknown tool "${name}"`, {
          details: { candidates: ASSISTANT_TOOLS.map((t) => t.name) },
        });
    }
  } catch (error) {
    return errorResult(error);
  }
}

// ---- MCP stdio framing (headless `--mcp`) -------------------------------------------------

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * Handles one MCP JSON-RPC message (`initialize`, `tools/list`,
 * `tools/call`, `ping`); returns the response, or `null` for notifications.
 */
export async function handleMcpMessage(
  host: ToolHost,
  message: unknown,
  serverInfo: { name: string; version: string },
): Promise<Json | null> {
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  }
  const id = message.id;
  if (id === undefined) return null; // notifications (initialized, cancelled)
  const params = isRecord(message.params) ? message.params : {};
  switch (message.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions:
            'HimmelCAD Assembler: model printable parts as an editable History through hcasm_call; read skills with skills_list/skills_read; look at results with view_render.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: ASSISTANT_TOOLS } };
    case 'tools/call': {
      const result = await callAssistantTool(host, String(params.name ?? ''), params.arguments);
      return { jsonrpc: '2.0', id, result };
    }
    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      };
  }
}
