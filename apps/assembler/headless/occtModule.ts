/**
 * Which OCCT WebAssembly module the Node side (headless CLI, tests, bench)
 * loads. Same loader contract for both (Emscripten MODULARIZE factory +
 * `locateFile` for the `.wasm`):
 *
 * - `replicad` (default): npm `replicad-opencascadejs` 1.1.0.
 * - `himmelcad`: the HimmelCAD build of the same toolchain with extra OCCT
 *   classes (`vendor/occt-wasm/dist/himmelcad_occt.{js,wasm}`, built by
 *   `vendor/occt-wasm/build.sh`; not committed).
 *
 * Selected with `HIMMELCAD_OCCT=replicad|himmelcad`; `HIMMELCAD_OCCT_DIR`
 * overrides the directory of the HimmelCAD build. The app's Vite build reads
 * the same variable (`vite.config.ts`).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type initType from 'replicad-opencascadejs';

export type OcctInit = typeof initType;
export type OpenCascadeModule = Awaited<ReturnType<OcctInit>>;
export type OcctModuleId = 'replicad' | 'himmelcad';

export function selectedOcctModule(env: NodeJS.ProcessEnv = process.env): OcctModuleId {
  const value = (env.HIMMELCAD_OCCT ?? '').trim().toLowerCase();
  if (value === '' || value === 'replicad') return 'replicad';
  if (value === 'himmelcad') return 'himmelcad';
  throw new Error(`HIMMELCAD_OCCT must be "replicad" or "himmelcad", not "${value}"`);
}

/** `vendor/occt-wasm/dist` of this repository (searched upwards from this file). */
function himmelcadDistDir(env: NodeJS.ProcessEnv): string {
  if (env.HIMMELCAD_OCCT_DIR) return path.resolve(env.HIMMELCAD_OCCT_DIR);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'vendor', 'occt-wasm', 'dist');
    if (existsSync(path.join(dir, 'vendor', 'occt-wasm'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('vendor/occt-wasm not found above ' + import.meta.url);
    dir = parent;
  }
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
  const dir = himmelcadDistDir(env);
  const files = {
    glue: path.join(dir, 'himmelcad_occt.js'),
    wasm: path.join(dir, 'himmelcad_occt.wasm'),
  };
  for (const file of Object.values(files)) {
    if (!existsSync(file)) {
      throw new Error(
        `HIMMELCAD_OCCT=himmelcad but ${file} is missing; build it with vendor/occt-wasm/build.sh`,
      );
    }
  }
  return files;
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
