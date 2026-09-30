/**
 * The OCCT WebAssembly kernel in-process under Node (headless CLI). Same
 * evaluator as the app's kernel worker; blocking calls are fine here because
 * there is no UI thread to keep responsive. The module (replicad's or the
 * HimmelCAD build) is chosen by `HIMMELCAD_OCCT`, see `occtModule.ts`.
 */
import { InProcessKernelAdapter } from '../renderer/src/kernel/adapter.js';
import { createEvaluator } from '../renderer/src/kernel/evaluator.js';
import { loadOcct } from './occtModule.js';

export function createHeadlessKernel(): InProcessKernelAdapter {
  return new InProcessKernelAdapter(async () => {
    const toStderr = (text: string) => process.stderr.write(`${text}\n`);
    const oc = await loadOcct({ print: toStderr, printErr: toStderr });
    return createEvaluator(oc);
  });
}
