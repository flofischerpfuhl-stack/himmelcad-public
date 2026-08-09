import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
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

export class SidecarRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'SidecarRpcError';
  }
}

let child: ChildProcessWithoutNullStreams | null = null;
let nextId = 1;
let stdoutBuffer = '';
const pending = new Map<number, PendingCall>();
const stderrListeners = new Set<(line: string) => void>();
const automationApprovalSecret = randomBytes(32);
const automationHostSession = randomBytes(24).toString('hex');

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
  const userGridRoot = resolve(app.getPath('userData'), 'proj-grids');
  mkdirSync(userGridRoot, { recursive: true });
  if (!app.isPackaged) {
    return { ...process.env, HIMMELCAD_USER_PROJ_GRID_ROOT: userGridRoot };
  }
  const platform = process.platform === 'win32' ? 'win32-x64' : 'linux-x64';
  const executable = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);
  const geoRoot = resolve(process.resourcesPath, 'workers', 'geo');
  const hasBundledGeoRuntime = existsSync(geoRoot);
  const dedodeRoot = resolve(process.resourcesPath, 'vendor', 'dedode', platform);
  const dedodeSitePackages = resolve(dedodeRoot, 'python', 'lib', 'python3.12', 'site-packages');
  const libraryPath = [
    hasBundledGeoRuntime ? resolve(geoRoot, 'lib') : undefined,
    resolve(dedodeRoot, 'python', 'lib'),
    resolve(dedodeSitePackages, 'onnxruntime', 'capi'),
    resolve(dedodeSitePackages, 'numpy.libs'),
    resolve(dedodeSitePackages, 'pillow.libs'),
    process.env.LD_LIBRARY_PATH,
  ]
    .filter((value): value is string => Boolean(value))
    .join(':');
  const windowsPath = [
    hasBundledGeoRuntime ? resolve(geoRoot, 'bin') : undefined,
    resolve(dedodeRoot, 'python'),
    resolve(dedodeRoot, 'python', 'DLLs'),
    resolve(dedodeRoot, 'python', 'Lib', 'site-packages', 'onnxruntime', 'capi'),
    process.env.PATH,
  ]
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
    HIMMELCAD_DEDODE_ONNX_ROOT: resolve(dedodeRoot, 'models'),
    HIMMELCAD_DEDODE_WORKER: resolve(dedodeRoot, 'dedode_onnx_worker.py'),
    HIMMELCAD_DEDODE_PYTHON:
      process.env.HIMMELCAD_DEDODE_PYTHON ??
      (process.platform === 'win32'
        ? resolve(dedodeRoot, 'python', 'python.exe')
        : resolve(dedodeRoot, 'python', 'bin', 'python3')),
    HIMMELCAD_DEDODE_PYTHON_VERSION: '3.12.13',
    ...(existsSync(resolve(dedodeRoot, 'python'))
      ? { PYTHONHOME: resolve(dedodeRoot, 'python') }
      : {}),
    PROJ_NETWORK: 'OFF',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
    HIMMELCAD_USER_PROJ_GRID_ROOT: userGridRoot,
    HIMMELCAD_AUTOMATION_APPROVAL_SECRET: automationApprovalSecret.toString('hex'),
    HIMMELCAD_AUTOMATION_HOST_SESSION: automationHostSession,
    ...(hasBundledGeoRuntime
      ? {
          HIMMELCAD_GDAL_ROOT: geoRoot,
          HIMMELCAD_PROJ_ROOT: geoRoot,
          PROJ_DATA: resolve(geoRoot, 'share', 'proj'),
          GDAL_DATA: resolve(geoRoot, 'share', 'gdal'),
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

/** Product-host-only grant issuer. Never expose this through preload or a
 * renderer/harness IPC method. */
export function issueAutomationConfirmationGrant(
  planHash: string,
  lifetimeMilliseconds = 30_000,
): string {
  if (!isSha256(planHash)) {
    throw new Error('automation confirmation plan hash is invalid');
  }
  const expiresAt = Date.now() + Math.max(1_000, Math.min(60_000, lifetimeMilliseconds));
  const grantId = randomBytes(32).toString('hex');
  const signed = `v1:${automationHostSession}:${String(expiresAt)}:${grantId}:${planHash}`;
  const signature = createHmac('sha256', automationApprovalSecret).update(signed).digest('hex');
  return `${signed}:${signature}`;
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function handleResponse(line: string): void {
  let response: {
    id?: number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };
  try {
    response = JSON.parse(line) as typeof response;
  } catch {
    return;
  }
  if (response.id == null) return;
  const call = pending.get(response.id);
  if (!call) return;
  pending.delete(response.id);
  if (response.error) {
    call.reject(
      new SidecarRpcError(response.error.code, response.error.message, response.error.data),
    );
  } else call.resolve(response.result);
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
