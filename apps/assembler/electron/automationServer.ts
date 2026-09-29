/**
 * Opt-in local automation endpoint of the desktop app (ADR 0024 trust
 * boundary, `assembler/AGENT-API.md`).
 *
 * - **Off by default.** Nothing listens until the user turns "Agent access"
 *   on in the UI; turning it off (or closing the window) closes the socket.
 * - **Loopback only.** Binds `127.0.0.1` on an ephemeral port.
 * - **Per-session bearer token.** 256 random bits, regenerated on every
 *   start, held only in memory and shown to the user to hand to an agent.
 *   Compared in constant time.
 * - **No browser access.** Requests carrying an `Origin` header are refused
 *   (a web page cannot drive the app via CSRF), and the `Host` header must
 *   name the loopback address (DNS-rebinding defence).
 * - **Narrow surface.** Only `POST /rpc` with one JSON-RPC 2.0 request of at
 *   most {@link MAX_BODY_BYTES}; the body is handed to the renderer's
 *   canonical command layer, which has no filesystem capability.
 *
 * Pure Node (`node:http`), so it is unit-tested without Electron.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const MAX_BODY_BYTES = 96 * 1024 * 1024;
const LOOPBACK = '127.0.0.1';

export interface AutomationEndpointInfo {
  url: string;
  port: number;
  token: string;
}

/** Handles one JSON-RPC request body; returns the response body (`null` for a notification). */
export type AutomationRequestHandler = (body: string) => Promise<string | null>;

export class AutomationServer {
  private server: Server | null = null;
  private info: AutomationEndpointInfo | null = null;
  private readonly handler: AutomationRequestHandler;
  private readonly onActivity: (() => void) | undefined;

  constructor(handler: AutomationRequestHandler, onActivity?: () => void) {
    this.handler = handler;
    this.onActivity = onActivity;
  }

  get running(): boolean {
    return this.server !== null;
  }

  get endpoint(): AutomationEndpointInfo | null {
    return this.info;
  }

  async start(): Promise<AutomationEndpointInfo> {
    if (this.info) return this.info;
    const token = randomBytes(32).toString('base64url');
    const server = createServer((req, res) => {
      void this.serve(req, res, token);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOOPBACK, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;
    this.server = server;
    this.info = { url: `http://${LOOPBACK}:${port}/rpc`, port, token };
    return this.info;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.info = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async serve(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    const reply = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(text);
    };
    const refuse = (status: number, code: string, message: string) =>
      reply(status, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32003, message, data: { code, message } },
      });

    const port = this.info?.port;
    if (req.headers.origin !== undefined) {
      refuse(403, 'permissionDenied', 'Browser-originated requests are not accepted');
      req.resume();
      return;
    }
    const host = req.headers.host ?? '';
    if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) {
      refuse(403, 'permissionDenied', 'Host header must name the loopback endpoint');
      req.resume();
      return;
    }
    if (!checkToken(req.headers.authorization, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      refuse(401, 'permissionDenied', 'Missing or wrong bearer token');
      req.resume();
      return;
    }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/rpc') {
      refuse(404, 'methodNotFound', 'Only POST /rpc is served');
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += (chunk as Buffer).byteLength;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        break;
      }
      chunks.push(chunk as Buffer);
    }
    if (tooLarge) {
      refuse(413, 'invalidRequest', `Request body exceeds ${MAX_BODY_BYTES} bytes`);
      return;
    }
    this.onActivity?.();
    try {
      const response = await this.handler(Buffer.concat(chunks).toString('utf8'));
      if (response === null) {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply(500, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message, data: { code: 'internal', message } },
      });
    }
  }
}

function checkToken(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length).trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
