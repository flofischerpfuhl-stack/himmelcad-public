import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { app } from 'electron';

export interface SidecarRequest {
  method: string;
  params?: unknown;
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

let child: ChildProcessWithoutNullStreams | null = null;
let nextId = 1;
const pending = new Map<number, PendingCall>();
let stdoutBuffer = '';

const STDERR_RING_LIMIT = 200;
const stderrRing: string[] = [];
const stderrListeners = new Set<(line: string) => void>();

export function getRecentStderr(): string[] {
  return stderrRing.slice();
}

export function onSidecarStderr(cb: (line: string) => void): () => void {
  stderrListeners.add(cb);
  return () => stderrListeners.delete(cb);
}

function sidecarPath(): string {
  // INVARIANT: sidecar path must never be a user-supplied value.
  if (app.isPackaged) {
    return resolve(
      process.resourcesPath,
      process.platform === 'win32' ? 'himmelcad-sidecar.exe' : 'himmelcad-sidecar',
    );
  }
  // Compiled path: apps/builder/dist/electron/sidecar.js → up 4 to repo root.
  return resolve(__dirname, '..', '..', '..', '..', 'target', 'debug', 'himmelcad-sidecar');
}

export function startSidecar(): Promise<void> {
  return new Promise((resolveStart) => {
    if (child) {
      resolveStart();
      return;
    }
    const path = sidecarPath();
    if (!existsSync(path)) {
      // eslint-disable-next-line no-console
      console.warn(`[sidecar] binary not found at ${path} — running renderer-only`);
      resolveStart();
      return;
    }
    try {
      const proc = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      proc.stdout.on('data', (buf: Buffer) => {
        stdoutBuffer += buf.toString();
        let nl: number;
        while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, nl).trim();
          stdoutBuffer = stdoutBuffer.slice(nl + 1);
          if (line) handleResponse(line);
        }
      });
      let stderrLineBuffer = '';
      proc.stderr.on('data', (buf: Buffer) => {
        const chunk = buf.toString();
        process.stderr.write(`[sidecar:err] ${chunk}`);
        stderrLineBuffer += chunk;
        let nl: number;
        while ((nl = stderrLineBuffer.indexOf('\n')) >= 0) {
          const line = stderrLineBuffer.slice(0, nl).replace(/\r$/, '');
          stderrLineBuffer = stderrLineBuffer.slice(nl + 1);
          if (line) pushStderrLine(line);
        }
      });
      proc.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.warn('[sidecar] spawn error', err);
        rejectAll(new Error(`sidecar spawn error: ${err.message}`));
        child = null;
      });
      proc.on('exit', (code, signal) => {
        // eslint-disable-next-line no-console
        console.warn(`[sidecar] exited code=${code} signal=${signal ?? 'none'}`);
        rejectAll(new Error(`sidecar exited (code=${code}, signal=${signal ?? 'none'})`));
        child = null;
      });
      child = proc;
      // eslint-disable-next-line no-console
      console.log(`[sidecar] started pid=${proc.pid} path=${path}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[sidecar] failed to spawn — running renderer-only', err);
      child = null;
    }
    resolveStart();
  });
}

export function isSidecarRunning(): boolean {
  return child !== null;
}

export function callSidecar<T = unknown>(request: SidecarRequest): Promise<T> {
  return new Promise((res, rej) => {
    if (!child) {
      rej(new Error('sidecar not running'));
      return;
    }
    const id = nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method: request.method,
      params: request.params ?? null,
    };
    pending.set(id, { resolve: res as (r: unknown) => void, reject: rej });
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (e) {
      pending.delete(id);
      rej(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

function handleResponse(line: string): void {
  let parsed: { id?: number; result?: unknown; error?: { code: number; message: string } };
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[sidecar] non-JSON line', line, err);
    return;
  }
  if (parsed.id == null) return;
  const cb = pending.get(parsed.id);
  if (!cb) return;
  pending.delete(parsed.id);
  if (parsed.error) {
    cb.reject(new Error(`[${parsed.error.code}] ${parsed.error.message}`));
  } else {
    cb.resolve(parsed.result);
  }
}

function rejectAll(err: Error): void {
  for (const cb of pending.values()) cb.reject(err);
  pending.clear();
}

function pushStderrLine(line: string): void {
  stderrRing.push(line);
  while (stderrRing.length > STDERR_RING_LIMIT) stderrRing.shift();
  for (const cb of stderrListeners) {
    try {
      cb(line);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[sidecar] stderr listener threw', err);
    }
  }
}

export function stopSidecar(): void {
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* noop */
  }
  child = null;
}
