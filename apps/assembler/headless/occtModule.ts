/**
 * Which OCCT WebAssembly module the Node side (headless CLI, tests, bench)
 * and the app build (`vite.config.ts`) use. Same loader contract for both
 * (Emscripten MODULARIZE factory + `locateFile` for the `.wasm`):
 *
 * - `replicad`: npm `replicad-opencascadejs` 1.1.0.
 * - `himmelcad`: the HimmelCAD build of the same toolchain with extra OCCT
 *   classes (`vendor/occt-wasm`, built by `vendor/occt-wasm/build.sh`).
 *
 * Selected with `HIMMELCAD_OCCT=replicad|himmelcad`; unset means
 * {@link DEFAULT_OCCT_MODULE}. `HIMMELCAD_OCCT=replicad` stays an explicit
 * opt-out once the default is switched.
 *
 * The HimmelCAD module is never stored in git. Its files live in a local
 * artifact cache outside the repository (owner decision 2026-09-30):
 *
 * 1. `HIMMELCAD_OCCT_DIR` — a directory holding `himmelcad_occt.{js,wasm}`;
 * 2. else `<cache root>/<version>` with the version of
 *    `vendor/occt-wasm/package.json` and the cache root
 *    `HIMMELCAD_OCCT_CACHE`, else `D:\AgentWork\HimmelCAD-Assembler\occt-wasm`
 *    on Windows, `~/.cache/himmelcad/occt-wasm` elsewhere.
 *
 * Both files are checked against `vendor/occt-wasm/artifacts.sha256` before
 * use. A missing directory, a missing file or a wrong hash fails loudly
 * ({@link OcctModuleError}) — never a silent fallback to the other module.
 *
 * Kept free of relative imports: `vite.config.ts` imports this file.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type initType from 'replicad-opencascadejs';

export type OcctInit = typeof initType;
export type OpenCascadeModule = Awaited<ReturnType<OcctInit>>;
export type OcctModuleId = 'replicad' | 'himmelcad';

/**
 * The module used when `HIMMELCAD_OCCT` is unset. Switching the default is
 * this one line (plus `artifacts.sha256`/cache on every machine and CI); see
 * `assembler/OCCT-BUILD-SPIKE.md` "Switching the default".
 */
export const DEFAULT_OCCT_MODULE: OcctModuleId = 'replicad';

/** The files the loader needs; both are hash-checked. */
export const HIMMELCAD_OCCT_FILES = ['himmelcad_occt.js', 'himmelcad_occt.wasm'] as const;

export class OcctModuleError extends Error {
  constructor(detail: string) {
    super(
      `custom OCCT module missing or wrong hash — run vendor/occt-wasm/build.sh or set HIMMELCAD_OCCT_DIR (${detail})`,
    );
    this.name = 'OcctModuleError';
  }
}

export function selectedOcctModule(env: NodeJS.ProcessEnv = process.env): OcctModuleId {
  const value = (env.HIMMELCAD_OCCT ?? '').trim().toLowerCase();
  if (value === '') return DEFAULT_OCCT_MODULE;
  if (value === 'replicad' || value === 'himmelcad') return value;
  throw new Error(`HIMMELCAD_OCCT must be "replicad" or "himmelcad", not "${value}"`);
}

/** `vendor/occt-wasm` of this repository, searched upwards from `from`. */
export function occtVendorDir(from: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, 'vendor', 'occt-wasm');
    if (existsSync(path.join(candidate, 'artifacts.sha256'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`vendor/occt-wasm not found above ${from}`);
    dir = parent;
  }
}

/** Version of the recipe (`vendor/occt-wasm/package.json`), the cache sub-directory. */
export function himmelcadOcctVersion(vendorDir: string): string {
  const pkg = JSON.parse(readFileSync(path.join(vendorDir, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error(`${path.join(vendorDir, 'package.json')}: no version`);
  }
  return pkg.version;
}

/** Root of the local artifact cache (one sub-directory per version). */
export function occtCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.HIMMELCAD_OCCT_CACHE) return path.resolve(env.HIMMELCAD_OCCT_CACHE);
  return platform === 'win32'
    ? 'D:\\AgentWork\\HimmelCAD-Assembler\\occt-wasm'
    : path.join(os.homedir(), '.cache', 'himmelcad', 'occt-wasm');
}

/** Expected SHA-256 per file name from `artifacts.sha256` (`<hex>  dist/<file>` lines). */
export function readArtifactHashes(file: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (m) hashes.set(path.posix.basename(m[2]!.replace(/\\/g, '/')), m[1]!.toLowerCase());
  }
  return hashes;
}

export interface ResolvedHimmelcadOcct {
  dir: string;
  glue: string;
  wasm: string;
  version: string;
  /** Where the directory came from. */
  source: 'HIMMELCAD_OCCT_DIR' | 'cache';
}

/**
 * Finds and verifies the HimmelCAD module. Throws {@link OcctModuleError}
 * when the directory or a file is missing or a hash differs.
 */
export function resolveHimmelcadOcct(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    vendorDir?: string;
  } = {},
): ResolvedHimmelcadOcct {
  const env = options.env ?? process.env;
  const vendorDir = options.vendorDir ?? occtVendorDir();
  const version = himmelcadOcctVersion(vendorDir);
  const fromEnv = (env.HIMMELCAD_OCCT_DIR ?? '').trim();
  const dir = fromEnv
    ? path.resolve(fromEnv)
    : path.join(occtCacheRoot(env, options.platform), version);
  const source = fromEnv ? 'HIMMELCAD_OCCT_DIR' : 'cache';
  if (!existsSync(dir)) {
    throw new OcctModuleError(`${dir} does not exist (${source}, version ${version})`);
  }
  const expected = readArtifactHashes(path.join(vendorDir, 'artifacts.sha256'));
  for (const name of HIMMELCAD_OCCT_FILES) {
    const file = path.join(dir, name);
    if (!existsSync(file)) throw new OcctModuleError(`${file} is missing`);
    const want = expected.get(name);
    if (!want) throw new OcctModuleError(`artifacts.sha256 has no entry for ${name}`);
    const got = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (got !== want) {
      throw new OcctModuleError(
        `${file} has SHA-256 ${got}, expected ${want} (version ${version})`,
      );
    }
  }
  return {
    dir,
    glue: path.join(dir, HIMMELCAD_OCCT_FILES[0]),
    wasm: path.join(dir, HIMMELCAD_OCCT_FILES[1]),
    version,
    source,
  };
}

export function occtModuleFiles(
  id: OcctModuleId = selectedOcctModule(),
  env: NodeJS.ProcessEnv = process.env,
): { glue: string; wasm: string } {
  if (id === 'replicad') {
    const require = createRequire(import.meta.url);
    const wasm = require.resolve('replicad-opencascadejs/wasm');
    return { glue: path.join(path.dirname(wasm), 'replicad_single.js'), wasm };
  }
  const { glue, wasm } = resolveHimmelcadOcct({ env });
  return { glue, wasm };
}

/** Loads and instantiates the selected OCCT module. */
export async function loadOcct(
  options: { print?: (text: string) => void; printErr?: (text: string) => void } = {},
  id: OcctModuleId = selectedOcctModule(),
): Promise<OpenCascadeModule> {
  const files = occtModuleFiles(id);
  const init: OcctInit =
    id === 'replicad'
      ? (await import('replicad-opencascadejs')).default
      : ((await import(pathToFileURL(files.glue).href)) as { default: OcctInit }).default;
  return init({ locateFile: () => files.wasm, ...options } as Parameters<OcctInit>[0]);
}
