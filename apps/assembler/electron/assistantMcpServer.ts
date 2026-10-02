/**
 * The assistant's MCP server (stdio), started by the agent CLI from the
 * per-turn config the host writes (`assistantHost.ts`), run with Electron's
 * own Node (`ELECTRON_RUN_AS_NODE=1`), so users need no separate Node
 * install. It only frames MCP: `tools/list` and `tools/call` are forwarded to
 * the app's loopback endpoint (`assistantTools.ts`, `HCASM_TOOL_URL` +
 * `HCASM_TOOL_TOKEN`), where the renderer answers them through the canonical
 * command layer (`renderer/src/interface/assistant/tools.ts`).
 *
 * Standalone script: no Electron import, no dependency.
 */
import { createInterface } from 'node:readline';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const url = process.env.HCASM_TOOL_URL ?? '';
const token = process.env.HCASM_TOOL_TOKEN ?? '';
/** A call that waits for the user's approval may take this long. */
const CALL_TIMEOUT_MS = 6 * 60_000;

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function forward(body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const value = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(value.error ?? `HTTP ${response.status}`));
    return value;
  } finally {
    clearTimeout(timer);
  }
}

async function handle(message: Record<string, unknown>): Promise<void> {
  const id = message.id;
  if (id === undefined) return; // notifications
  const params = (message.params ?? {}) as Record<string, unknown>;
  try {
    switch (message.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        write({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'hcasm', version: '1.0.0' },
          },
        });
        return;
      }
      case 'ping':
        write({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        write({ jsonrpc: '2.0', id, result: await forward({ op: 'list' }) });
        return;
      case 'tools/call':
        write({
          jsonrpc: '2.0',
          id,
          result: await forward({
            op: 'call',
            name: params.name,
            arguments: params.arguments ?? {},
          }),
        });
        return;
      default:
        write({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${String(message.method)}` },
        });
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (message.method === 'tools/call') {
      write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
    } else {
      write({ jsonrpc: '2.0', id, error: { code: -32603, message: text } });
    }
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
    void handle(message as Record<string, unknown>);
  }
});
lines.on('close', () => process.exit(0));
