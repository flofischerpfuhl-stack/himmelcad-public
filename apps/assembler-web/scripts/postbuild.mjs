#!/usr/bin/env node
/**
 * Completes `vite build` output in `dist/` into the deployable site:
 *
 * 1. licence texts (the desktop app's `renderer/public/licenses`), the web
 *    source offer and, for a build with the HimmelCAD OCCT module, the
 *    module's build recipe (`vendor/occt-wasm`) under `licenses/source/`
 *    (LGPL: modified library, source offered from the same place);
 * 2. `sw.js` from `sw/sw.js` with the precache list (every file, SHA-256 of
 *    the `.wasm` modules) and a version derived from the content;
 * 3. `build-info.json` (version, OCCT module, sizes) and `_headers`
 *    (Netlify / Cloudflare Pages);
 * 4. precompressed `.br` and `.gz` siblings for hosts that serve them
 *    (nginx `brotli_static`/`gzip_static`, Caddy `precompressed`).
 *
 * Usage: node scripts/postbuild.mjs [--no-compress]
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';

import { DOCUMENT_CSP, DOCUMENT_CSP_HEADER, WORKER_CSP, WORKER_CSP_FILE_PREFIXES } from './csp.mjs';
import { netlifyHeaders } from './headers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repoRoot = resolve(appDir, '../..');
const toPosix = (path) => path.split(sep).join('/');

/** Files never precached: the worker itself, compressed siblings, host config, store listing images. */
export function isPrecached(path) {
  return !(
    path === 'sw.js' ||
    path === '_headers' ||
    path === '.assetsignore' ||
    path === 'robots.txt' ||
    path.startsWith('screenshots/') ||
    path.endsWith('.br') ||
    path.endsWith('.gz') ||
    path.endsWith('.map')
  );
}

/** Text and wasm files worth precompressing. */
export function isCompressible(path) {
  return /\.(html|js|mjs|css|json|webmanifest|wasm|svg|txt|md|ttf)$/i.test(path);
}

export function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(toPosix(relative(root, path)));
    }
  };
  visit(root);
  return files.sort();
}

function copyTree(from, to, skip = () => false) {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (skip(entry.name)) continue;
    if (entry.isDirectory()) copyTree(source, target, skip);
    else {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Cloudflare Workers static assets: largest file per asset (25 MiB). */
export const CLOUDFLARE_ASSET_LIMIT = 25 * 1024 * 1024;

/** The OCCT module (either build): served precompressed by `deploy/worker.mjs`, never uploaded raw. */
const OCCT_WASM = /^assets\/(himmelcad_occt|replicad_single)-[^/]*\.wasm$/;

/**
 * Whether Cloudflare (`wrangler.jsonc`) uploads `path`: not the `.br`/`.gz` siblings
 * (Cloudflare compresses on its own) except the OCCT module's, and not the raw OCCT module
 * (25.3 MB today, close to the per-asset limit): `deploy/worker.mjs` answers its URL with the
 * brotli (or gzip) sibling and `Content-Encoding`. Mirrored by the generated `.assetsignore`.
 */
export function isCloudflareUpload(path) {
  if (path === '.assetsignore') return false;
  const sibling = /\.(br|gz)$/.exec(path);
  if (sibling) return OCCT_WASM.test(path.slice(0, -sibling[0].length));
  return !OCCT_WASM.test(path);
}

/** `.assetsignore` (gitignore syntax, read by wrangler) with the rules of {@link isCloudflareUpload}. */
export const ASSETS_IGNORE = `# Cloudflare Workers static assets (wrangler.jsonc): files not uploaded.
# Compressed siblings: Cloudflare compresses on its own; the OCCT module's are kept for deploy/worker.mjs.
*.br
*.gz
!assets/himmelcad_occt-*.wasm.br
!assets/himmelcad_occt-*.wasm.gz
!assets/replicad_single-*.wasm.br
!assets/replicad_single-*.wasm.gz
# The raw OCCT module (25 MiB per-asset limit): deploy/worker.mjs serves the siblings.
assets/himmelcad_occt-*.wasm
assets/replicad_single-*.wasm
`;

/** Fails when a file Cloudflare would upload exceeds its per-asset limit (or the worker would lack a sibling). */
export function checkCloudflareUploads(dist, files) {
  const uploads = files.filter(isCloudflareUpload);
  for (const path of uploads) {
    const size = statSync(join(dist, path)).size;
    if (size > CLOUDFLARE_ASSET_LIMIT)
      throw new Error(`${path}: ${size} bytes, over Cloudflare's 25 MiB per-asset limit`);
  }
  for (const path of files.filter((p) => OCCT_WASM.test(p))) {
    if (!uploads.includes(`${path}.br`) || !uploads.includes(`${path}.gz`))
      throw new Error(`${path}: no .br/.gz sibling for deploy/worker.mjs`);
  }
  return uploads;
}

/**
 * `robots.txt`: a preview release keeps crawlers out (with `X-Robots-Tag` and the robots
 * `<meta>`); the public release allows them (deploy/README.md "Going public").
 */
export const robotsTxt = (publicRelease) =>
  publicRelease
    ? 'User-agent: *\nAllow: /\n'
    : '# Himmel:CAD Assembler preview: not announced yet.\nUser-agent: *\nDisallow: /\n';

/** Precache entries (relative URLs) and the build version (hash of every file's hash). */
export function precacheManifest(dist, files) {
  const entries = [];
  const version = createHash('sha256');
  for (const path of files.filter(isPrecached)) {
    const hash = sha256(readFileSync(join(dist, path)));
    version.update(`${path}\0${hash}\n`);
    entries.push(path.endsWith('.wasm') ? { url: path, sha256: hash } : { url: path });
  }
  return { entries, version: version.digest('hex').slice(0, 16) };
}

function writeLicenses(dist, occtModule) {
  copyTree(join(repoRoot, 'apps/assembler/renderer/public/licenses'), join(dist, 'licenses'));
  copyFileSync(join(appDir, 'licenses/SOURCE-OFFER.txt'), join(dist, 'licenses/SOURCE-OFFER.txt'));
  if (occtModule === 'himmelcad') {
    copyTree(
      join(repoRoot, 'vendor/occt-wasm'),
      join(dist, 'licenses/source/occt-wasm'),
      (name) => name === 'dist' || name === 'node_modules' || name.startsWith('.'),
    );
  }
}

function compress(dist, files) {
  let saved = 0;
  for (const path of files.filter(isCompressible)) {
    const file = join(dist, path);
    const bytes = readFileSync(file);
    if (bytes.length < 1024) continue;
    const isWasm = path.endsWith('.wasm');
    const br = brotliCompressSync(bytes, {
      params: {
        [zlib.BROTLI_PARAM_QUALITY]: isWasm ? 9 : 11,
        [zlib.BROTLI_PARAM_SIZE_HINT]: bytes.length,
        [zlib.BROTLI_PARAM_MODE]: isWasm ? zlib.BROTLI_MODE_GENERIC : zlib.BROTLI_MODE_TEXT,
      },
    });
    const gz = gzipSync(bytes, { level: 9 });
    // Only where it pays: a host would otherwise serve a larger "compressed" file.
    if (br.length < bytes.length * 0.95) {
      writeFileSync(`${file}.br`, br);
      saved += bytes.length - br.length;
    }
    if (gz.length < bytes.length * 0.95) writeFileSync(`${file}.gz`, gz);
  }
  return saved;
}

function main() {
  const dist = join(appDir, 'dist');
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`${dist}: run vite build first`);
  const assets = readdirSync(join(dist, 'assets'));
  const occtModule = assets.some((name) => /^himmelcad_occt-.*\.wasm$/.test(name))
    ? 'himmelcad'
    : assets.some((name) => /^replicad_single-.*\.wasm$/.test(name))
      ? 'replicad'
      : null;
  if (!occtModule) throw new Error('no OCCT .wasm in dist/assets');
  for (const prefix of ['kernel.worker-', 'solver.worker-', 'planegcs-']) {
    if (!assets.some((name) => name.startsWith(prefix)))
      throw new Error(`dist/assets has no ${prefix}* file: the worker CSP would not match`);
  }

  const publicRelease = process.env.HIMMELCAD_WEB_PUBLIC === '1';
  writeLicenses(dist, occtModule);
  writeFileSync(join(dist, 'robots.txt'), robotsTxt(publicRelease));
  writeFileSync(join(dist, '.assetsignore'), ASSETS_IGNORE);
  const files = listFiles(dist).filter((path) => !path.endsWith('.br') && !path.endsWith('.gz'));
  const { entries, version } = precacheManifest(dist, files);
  const bytes = entries.reduce((sum, entry) => sum + statSync(join(dist, entry.url)).size, 0);
  const csp = {
    document: DOCUMENT_CSP,
    documentHeader: DOCUMENT_CSP_HEADER,
    worker: WORKER_CSP,
    workerPrefixes: WORKER_CSP_FILE_PREFIXES,
  };
  const template = readFileSync(join(appDir, 'sw/sw.js'), 'utf8');
  const sw = template
    .replace("'__HC_VERSION__'", JSON.stringify(version))
    .replace('__HC_PRECACHE__', JSON.stringify(entries))
    .replace('__HC_CSP__', JSON.stringify(csp));
  if (sw.includes('__HC_')) throw new Error('sw.js: a placeholder was not replaced');
  writeFileSync(join(dist, 'sw.js'), sw);
  writeFileSync(
    join(dist, '_headers'),
    netlifyHeaders(process.env.HIMMELCAD_WEB_BASE ?? '/', { noindex: !publicRelease }),
  );

  const wasm = entries
    .filter((entry) => entry.url.endsWith('.wasm'))
    .map((entry) => ({
      file: entry.url,
      bytes: statSync(join(dist, entry.url)).size,
      sha256: entry.sha256,
    }));
  writeFileSync(
    join(dist, 'build-info.json'),
    `${JSON.stringify(
      {
        product: 'himmelcad-assembler-web',
        version,
        // `preview`: noindex + "Preview" badge; read by the local server and deploy/worker.mjs.
        release: publicRelease ? 'public' : 'preview',
        builtAt: new Date().toISOString(),
        occtModule,
        precache: { files: entries.length, bytes },
        wasm,
      },
      null,
      2,
    )}\n`,
  );

  const noCompress = process.argv.includes('--no-compress');
  const compressed = noCompress ? 0 : compress(dist, listFiles(dist));
  // Cloudflare (wrangler.jsonc) needs the OCCT siblings; without compression there are none.
  const uploads = noCompress ? null : checkCloudflareUploads(dist, listFiles(dist));
  const mb = (n) => (n / 1048576).toFixed(1);
  process.stdout.write(
    `assembler-web: version ${version} (${publicRelease ? 'public' : 'preview'}), OCCT ${occtModule}, ${entries.length} files / ${mb(bytes)} MB precached` +
      `${compressed ? `, brotli saves ${mb(compressed)} MB` : ''}` +
      `${uploads ? `, Cloudflare uploads ${uploads.length} files` : ''}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
