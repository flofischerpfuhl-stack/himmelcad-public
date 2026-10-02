/**
 * Loopback endpoint between the assistant's MCP server (a child of the
 * agent CLI, `assistantMcpServer.ts`) and the app: `POST /tool` with
 * `{op: "list"}` or `{op: "call", name, arguments}` and a per-turn bearer
 * token. The token names the thread whose turn is running; it is issued when
 * the turn starts and revoked when it ends, so a leftover MCP process cannot
 * reach the project later. Same hardening as Agent Access
 * (`automationServer.ts`): 127.0.0.1 only, no `Origin`, loopback `Host`,
 * bounded bodies, constant-time token comparison.
 *
 * The main process never interprets a call: it hands `{threadId, name,
 * arguments}` to the renderer, whose command layer runs it.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const LOOPBACK = '127.0.0.1';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type ToolForwarder = (request: {
  threadId: string;
  name: string;
  arguments: unknown;
}) => Promise<unknown>;

export class AssistantToolServer {
  #server: Server | null = null;
  #url = '';
  #port = 0;
  readonly #tokens = new Map<string, string>();
  readonly #forward: ToolForwarder;

  constructor(forward: ToolForwarder) {
    this.#forward = forward;
  }

  get url(): string {
    return this.#url;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    const server = createServer((req, res) => void this.#serve(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOOPBACK, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
    this.#url = `http://${LOOPBACK}:${this.#port}/tool`;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#tokens.clear();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  issue(threadId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.#tokens.set(token, threadId);
    return token;
  }

  revoke(token: string): void {
    this.#tokens.delete(token);
  }

  #threadFor(header: string | undefined): string | null {
    if (!header?.startsWith('Bearer ')) return null;
    const given = Buffer.from(header.slice(7).trim());
    for (const [token, threadId] of this.#tokens) {
      const expected = Buffer.from(token);
      if (given.length === expected.length && timingSafeEqual(given, expected)) return threadId;
    }
    return null;
  }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(body));
    };
    const host = req.headers.host ?? '';
    if (
      req.headers.origin !== undefined ||
      (host !== `${LOOPBACK}:${this.#port}` && host !== `localhost:${this.#port}`)
    ) {
      req.resume();
      reply(403, { error: 'Forbidden' });
      return;
    }
    const threadId = this.#threadFor(req.headers.authorization);
    if (!threadId) {
      req.resume();
      reply(401, { error: 'No assistant turn is running for this token.' });
      return;
    }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/tool') {
      req.resume();
      reply(404, { error: 'Only POST /tool is served.' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).byteLength;
      if (size > MAX_BODY_BYTES) {
        reply(413, { error: 'Request too large.' });
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      reply(400, { error: 'Invalid JSON.' });
      return;
    }
    try {
      if (body.op === 'list') {
        reply(200, await this.#forward({ threadId, name: 'tools/list', arguments: {} }));
      } else if (body.op === 'call' && typeof body.name === 'string') {
        reply(
          200,
          await this.#forward({ threadId, name: body.name, arguments: body.arguments ?? {} }),
        );
      } else {
        reply(400, { error: 'Expected {op: "list"} or {op: "call", name, arguments}.' });
      }
    } catch (error) {
      reply(500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
