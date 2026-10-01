/**
 * HTTP response headers of the web build, per file: the single source for
 * the local server (`serve.mjs`, used by the e2e tests and `pnpm preview`),
 * the generated `_headers` file (Netlify / Cloudflare Pages syntax) and the
 * hosting documentation (`deploy/README.md`).
 */
import { DOCUMENT_CSP, DOCUMENT_CSP_HEADER, WORKER_CSP, isWorkerCspFile } from './csp.mjs';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.sha256': 'text/plain; charset=utf-8',
};

/** Headers every response gets. No COOP/COEP isolation is needed: nothing uses SharedArrayBuffer. */
export const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

function extensionOf(path) {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Headers for the build file at `path` (relative to the build root, posix).
 * Content-hashed files under `assets/` are immutable; the entry points
 * (`index.html`, `sw.js`, the manifest, icons, license texts) revalidate,
 * so a new deployment is seen at once.
 */
export function headersFor(path) {
  const ext = extensionOf(path);
  const headers = { ...COMMON_HEADERS };
  headers['Content-Type'] = MIME_TYPES[ext] ?? 'application/octet-stream';
  headers['Cache-Control'] = path.startsWith('assets/') ? IMMUTABLE : REVALIDATE;
  if (ext === '.html') headers['Content-Security-Policy'] = DOCUMENT_CSP_HEADER;
  else if (ext === '.js')
    headers['Content-Security-Policy'] = isWorkerCspFile(path) ? WORKER_CSP : DOCUMENT_CSP;
  if (path === 'sw.js') headers['Service-Worker-Allowed'] = './';
  return headers;
}

/** A `_headers` file (Netlify, Cloudflare Pages) with the same rules, for `base` (e.g. `/`). */
export function netlifyHeaders(base = '/') {
  const lines = [];
  const block = (pattern, headers) => {
    lines.push(`${base}${pattern}`);
    for (const [name, value] of Object.entries(headers)) lines.push(`  ${name}: ${value}`);
    lines.push('');
  };
  block('*', COMMON_HEADERS);
  block('', { 'Cache-Control': REVALIDATE, 'Content-Security-Policy': DOCUMENT_CSP_HEADER });
  block('index.html', {
    'Cache-Control': REVALIDATE,
    'Content-Security-Policy': DOCUMENT_CSP_HEADER,
  });
  block('sw.js', { 'Cache-Control': REVALIDATE, 'Content-Security-Policy': DOCUMENT_CSP });
  // No CSP on `assets/*` as a whole: these hosts join every matching rule's values, and two
  // policies on a worker would intersect to the strict one and stop the kernel.
  block('assets/*', { 'Cache-Control': IMMUTABLE });
  for (const prefix of [
    'kernel.worker-',
    'solver.worker-',
    'himmelcad_occt-',
    'replicad_single-',
    'planegcs-',
  ]) {
    block(`assets/${prefix}*`, { 'Content-Security-Policy': WORKER_CSP });
  }
  block('assets/*.wasm', { 'Content-Type': 'application/wasm' });
  block('manifest.webmanifest', { 'Content-Type': 'application/manifest+json; charset=utf-8' });
  return `${lines.join('\n')}`;
}
