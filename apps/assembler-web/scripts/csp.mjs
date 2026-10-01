/**
 * Content-Security-Policy of the web build, in one place for the build
 * (`<meta>` in index.html), the service worker (headers on cached
 * responses), the local static server (`serve.mjs`) and the hosting
 * documentation (`deploy/README.md`). Mirrors the desktop split in
 * `apps/assembler/electron/main.ts`:
 *
 * - The document never evaluates strings or instantiates WebAssembly: no
 *   `unsafe-eval`, no `wasm-unsafe-eval`.
 * - Only the CAD-kernel and sketch-solver workers and the LGPL Emscripten
 *   glue chunks they import get `'unsafe-eval' 'wasm-unsafe-eval'` (the
 *   glue builds embind invokers with `new Function`). A dedicated worker
 *   takes the policy of its own script response, not the document's, so
 *   the relaxation stays inside the workers.
 *
 * Every source is `'self'`: no third-party request is possible.
 */

/** Document policy. `frame-ancestors` only works as a header; the `<meta>` copy omits it. */
export const DOCUMENT_CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

export const DOCUMENT_CSP = DOCUMENT_CSP_DIRECTIVES.join('; ');

/** The document policy as a response header (adds `frame-ancestors`, which `<meta>` ignores). */
export const DOCUMENT_CSP_HEADER = `${DOCUMENT_CSP}; frame-ancestors 'none'`;

export const WORKER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * Output files that need {@link WORKER_CSP}: the kernel and solver workers
 * and the LGPL glue chunks they load (matched by file-name prefix, so
 * content hashes need no list update). Same list as `electron/main.ts`.
 */
export const WORKER_CSP_FILE_PREFIXES = [
  'kernel.worker-',
  'replicad_single-',
  'himmelcad_occt-',
  'solver.worker-',
  'planegcs-',
];

/** `true` if the URL path or file name `name` is served with {@link WORKER_CSP}. */
export function isWorkerCspFile(name) {
  const base = String(name).replace(/\\/g, '/').split('/').pop() ?? '';
  return base.endsWith('.js') && WORKER_CSP_FILE_PREFIXES.some((prefix) => base.startsWith(prefix));
}
