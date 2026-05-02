import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';

let child: ChildProcessWithoutNullStreams | null = null;

function sidecarPath(): string {
  // INVARIANT: sidecar path must never be a user-supplied value.
  const isPackaged = process.resourcesPath?.includes('app.asar') ?? false;
  if (isPackaged) {
    return resolve(process.resourcesPath, 'himmelcad-sidecar');
  }
  return resolve(__dirname, '../../..', 'target', 'debug', 'himmelcad-sidecar');
}

export async function startSidecar(): Promise<void> {
  if (child) return;
  try {
    child = spawn(sidecarPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (buf: Buffer) => {
      process.stdout.write(`[sidecar] ${buf.toString()}`);
    });
    child.stderr.on('data', (buf: Buffer) => {
      process.stderr.write(`[sidecar:err] ${buf.toString()}`);
    });
    child.on('exit', (code, signal) => {
      // eslint-disable-next-line no-console
      console.warn(`[sidecar] exited code=${code} signal=${signal ?? 'none'}`);
      child = null;
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[sidecar] failed to spawn — running renderer-only', err);
    child = null;
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
