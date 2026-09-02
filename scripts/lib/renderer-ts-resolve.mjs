/**
 * Resolve hook for the `node --experimental-strip-types --test` runners.
 *
 * Renderer sources are compiled by Vite/`tsc`, so they import siblings with the
 * TypeScript-mandated `./module.js` specifier while only `./module.ts` exists on
 * disk. Node's ESM resolver takes those specifiers literally and fails with
 * ERR_MODULE_NOT_FOUND. This hook rewrites a relative `.js` specifier to the
 * neighbouring `.ts`/`.tsx` file only when the `.js` file genuinely does not
 * exist, so real JavaScript siblings keep winning and nothing is shadowed.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const RELATIVE = /^\.{1,2}\//;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (RELATIVE.test(specifier) && specifier.endsWith('.js') && context.parentURL) {
      const candidate = new URL(specifier, context.parentURL);
      if (candidate.protocol === 'file:' && !existsSync(fileURLToPath(candidate))) {
        for (const extension of ['.ts', '.tsx']) {
          const typescript = new URL(
            specifier.slice(0, -'.js'.length) + extension,
            context.parentURL,
          );
          if (existsSync(fileURLToPath(typescript))) {
            return nextResolve(typescript.href, context);
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
