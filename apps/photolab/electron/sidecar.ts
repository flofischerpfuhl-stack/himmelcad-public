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
  reject: (error: Error) => void;
}

let child: ChildProcessWithoutNullStreams | null = null;
let nextId = 1;
let stdoutBuffer = '';
const pending = new Map<number, PendingCall>();
const stderrListeners = new Set<(line: string) => void>();

function sidecarPath(): string {
  if (app.isPackaged) {
    return resolve(
      process.resourcesPath,
      process.platform === 'win32' ? 'himmelcad-sidecar.exe' : 'himmelcad-sidecar',
    );
  }
  return resolve(__dirname, '..', '..', '..', '..', 'target', 'debug', 'himmelcad-sidecar');
}

function sidecarEnvironment(): NodeJS.ProcessEnv {
  if (!app.isPackaged) return process.env;
  const platform = process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
  const executable = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);
  const geoRoot = resolve(process.resourcesPath, 'workers', 'geo');
  const hasBundledGeoRuntime = existsSync(geoRoot);
  const dedodeRoot = resolve(process.resourcesPath, 'vendor', 'dedode', platform);
  const libraryPath = [
    hasBundledGeoRuntime ? resolve(geoRoot, 'lib') : undefined,
    resolve(dedodeRoot, 'python', 'lib'),
    process.env.LD_LIBRARY_PATH,
  ]
    .filter((value): value is string => Boolean(value))
    .join(':');
  const windowsPath = [hasBundledGeoRuntime ? resolve(geoRoot, 'bin') : undefined, process.env.PATH]
    .filter((value): value is string => Boolean(value))
    .join(';');
  return {
    ...process.env,
    HIMMELCAD_WORKSPACE_ROOT: process.resourcesPath,
    HIMMELCAD_COLMAP_EXECUTABLE: resolve(
      process.resourcesPath,
      'vendor',
      'colmap',
      platform,
      'bin',
      executable('colmap'),
    ),
    HIMMELCAD_COLMAP_MODEL_ROOT: resolve(
      process.resourcesPath,
      'vendor',
      'photolab-models',
      'colmap-4.1.0',
    ),
    HIMMELCAD_POTREE_CONVERTER: resolve(
      process.resourcesPath,
      'vendor',
      'potreeconverter',
      platform,
      executable('PotreeConverter'),
    ),
    HIMMELCAD_BRUSH_EXECUTABLE: resolve(
      process.resourcesPath,
      'vendor',
      'brush',
      platform,
      executable('brush_app'),
    ),
    HIMMELCAD_DEDODE_ROOT: dedodeRoot,
    HIMMELCAD_DEDODE_WORKER: resolve(process.resourcesPath, 'workers', 'dedode_worker.py'),
    HIMMELCAD_DEDODE_PYTHON:
      process.env.HIMMELCAD_DEDODE_PYTHON ??
      resolve(dedodeRoot, 'python', 'bin', process.platform === 'win32' ? 'python.exe' : 'python3'),
    ...(existsSync(resolve(dedodeRoot, 'python'))
      ? { PYTHONHOME: resolve(dedodeRoot, 'python') }
      : {}),
    PROJ_NETWORK: 'OFF',
    ...(hasBundledGeoRuntime
      ? {
          HIMMELCAD_GDAL_ROOT: geoRoot,
          HIMMELCAD_PROJ_ROOT: geoRoot,
          GDAL_DRIVER_PATH: resolve(geoRoot, 'lib', 'gdalplugins'),
        }
      : {}),
    ...(process.platform === 'win32' ? { PATH: windowsPath } : { LD_LIBRARY_PATH: libraryPath }),
  };
}

export function onSidecarStderr(cb: (line: string) => void): () => void {
  stderrListeners.add(cb);
  return () => stderrListeners.delete(cb);
}

export function startSidecar(): void {
  if (child) return;
  const path = sidecarPath();
  if (!existsSync(path)) {
    console.warn(`[sidecar] binary not found at ${path}`);
    return;
  }
  const process_ = spawn(path, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: sidecarEnvironment(),
    windowsHide: true,
  });
  process_.stdout.on('data', (buffer: Buffer) => {
    stdoutBuffer += buffer.toString();
    let newline: number;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) handleResponse(line);
    }
  });
  let stderrBuffer = '';
  process_.stderr.on('data', (buffer: Buffer) => {
    const chunk = buffer.toString();
    process.stderr.write(`[sidecar:err] ${chunk}`);
    stderrBuffer += chunk;
    let newline: number;
    while ((newline = stderrBuffer.indexOf('\n')) >= 0) {
      const line = stderrBuffer.slice(0, newline).replace(/\r$/, '');
      stderrBuffer = stderrBuffer.slice(newline + 1);
      if (line) for (const listener of stderrListeners) listener(line);
    }
  });
  process_.on('exit', (code, signal) => {
    rejectAll(new Error(`sidecar exited (code=${String(code)}, signal=${signal ?? 'none'})`));
    child = null;
  });
  process_.on('error', (error) => {
    rejectAll(error);
    child = null;
  });
  child = process_;
}

export function isSidecarRunning(): boolean {
  return child !== null;
}

export function callSidecar<T = unknown>(request: SidecarRequest): Promise<T> {
  return new Promise((resolveCall, rejectCall) => {
    if (!child) {
      rejectCall(new Error('sidecar not running'));
      return;
    }
    const id = nextId++;
    pending.set(id, {
      resolve: resolveCall as (result: unknown) => void,
      reject: rejectCall,
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method: request.method, params: request.params ?? null })}\n`,
    );
  });
}

function handleResponse(line: string): void {
  let response: { id?: number; result?: unknown; error?: { code: number; message: string } };
  try {
    response = JSON.parse(line) as typeof response;
  } catch {
    return;
  }
  if (response.id == null) return;
  const call = pending.get(response.id);
  if (!call) return;
  pending.delete(response.id);
  if (response.error) call.reject(new Error(`[${response.error.code}] ${response.error.message}`));
  else call.resolve(response.result);
}

function rejectAll(error: Error): void {
  for (const call of pending.values()) call.reject(error);
  pending.clear();
}

export function stopSidecar(): void {
  if (!child) return;
  child.kill('SIGTERM');
  child = null;
}
