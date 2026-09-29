/**
 * The OCCT WebAssembly kernel in-process under Node (headless CLI). Same
 * evaluator as the app's kernel worker; blocking calls are fine here because
 * there is no UI thread to keep responsive.
 */
import { createRequire } from 'node:module';

import init from 'replicad-opencascadejs';

import { InProcessKernelAdapter } from '../renderer/src/kernel/adapter.js';
import { createEvaluator } from '../renderer/src/kernel/evaluator.js';

export function createHeadlessKernel(): InProcessKernelAdapter {
  return new InProcessKernelAdapter(async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('replicad-opencascadejs/wasm');
    const toStderr = (text: string) => process.stderr.write(`${text}\n`);
    const oc = await init({
      locateFile: () => wasmPath,
      print: toStderr,
      printErr: toStderr,
    } as Parameters<typeof init>[0]);
    return createEvaluator(oc);
  });
}
