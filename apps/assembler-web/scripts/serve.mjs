#!/usr/bin/env node
/**
 * A small static server for the built site (`dist/`), with the headers of
 * `headers.mjs` and the precompressed `.br`/`.gz` siblings — the reference
 * for what a host must do (deploy/README.md). Used by `pnpm preview` and the
 * e2e tests; not a production server.
 *
 * Usage: node scripts/serve.mjs [--port 5177] [--base /assembler/] [--plain] [--dir dist]
 *   --base   serve the site under a sub-path (the build is relative, any base works)
 *   --plain  no CSP/cache headers and no compression: a minimal host
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIME_TYPES, headersFor } from './headers.mjs';

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function extensionOf(path) {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

/**
 * Starts the server; resolves with `{ url, close }`. `port` 0 picks a free one; `onServe`,
 * if given, is told every file served (`{ path, bytes, encoding }`, bytes on the wire).
 */
export function startServer({ dir, port = 0, base = '/', plain = false, onServe } = {}) {
  const root = resolve(dir ?? join(fileURLToPath(new URL('..', import.meta.url)), 'dist'));
  const prefix = base.endsWith('/') ? base : `${base}/`;
  // A preview build (build-info.json `release`) asks search engines to stay away, as the host must.
  const info = join(root, 'build-info.json');
  const noindex = existsSync(info) && JSON.parse(readFileSync(info, 'utf8')).release !== 'public';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === prefix.slice(0, -1)) {
      // `/assembler` → `/assembler/`: the build's relative URLs need the trailing slash.
      res.writeHead(301, { Location: prefix });
      res.end();
      return;
    }
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404).end('Not found');
      return;
    }
    let path = decodeURIComponent(url.pathname.slice(prefix.length));
    if (path === '' || path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const relative = path.split(sep).join('/');
    const headers = plain
      ? { 'Content-Type': MIME_TYPES[extensionOf(file)] ?? 'application/octet-stream' }
      : headersFor(relative, { noindex });
    let body = file;
    if (!plain) {
      const accept = String(req.headers['accept-encoding'] ?? '');
      headers.Vary = 'Accept-Encoding';
      if (/\bbr\b/.test(accept) && existsSync(`${file}.br`)) {
        body = `${file}.br`;
        headers['Content-Encoding'] = 'br';
      } else if (/\bgzip\b/.test(accept) && existsSync(`${file}.gz`)) {
        body = `${file}.gz`;
        headers['Content-Encoding'] = 'gzip';
      }
    }
    const size = statSync(body).size;
    headers['Content-Length'] = String(size);
    onServe?.({
      path: relative,
      bytes: req.method === 'HEAD' ? 0 : size,
      encoding: headers['Content-Encoding'] ?? null,
    });
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(body).pipe(res);
  });
  return new Promise((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      resolvePromise({
        // 127.0.0.1 is a secure context (service workers, File System Access) like localhost.
        url: `http://127.0.0.1:${actual}${prefix}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const { url } = await startServer({
    dir: option(args, '--dir', undefined),
    port: Number(option(args, '--port', '5177')),
    base: option(args, '--base', '/'),
    plain: args.includes('--plain'),
  });
  process.stdout.write(`assembler-web: serving ${url}\n`);
}
