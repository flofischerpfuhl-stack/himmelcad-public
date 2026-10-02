#!/usr/bin/env node
/**
 * Puts the verified HimmelCAD OCCT module into the local artifact cache on a
 * machine that has none — a CI or Cloudflare Workers Builds machine
 * (deploy/README.md "Automatic deployment"). The module is never stored in git
 * (owner decision 2026-09-30); it is published per version as a release asset
 * (GitLab generic package registry, or any HTTPS location) and checked here
 * against `vendor/occt-wasm/artifacts.sha256` before it is used, exactly as
 * the build itself checks the cache (`apps/assembler/headless/occtModule.ts`).
 *
 *   HIMMELCAD_OCCT_URL='https://gitlab.com/api/v4/projects/<id>/packages/generic/himmelcad-occt-wasm/{version}/{file}' \
 *   HIMMELCAD_OCCT_TOKEN=<read token> node apps/assembler-web/scripts/fetch-occt-module.mjs
 *
 * - `{version}`: `vendor/occt-wasm/package.json` version (e.g. 8.0.1-hc.3); `{file}`:
 *   `himmelcad_occt.js`, `himmelcad_occt.wasm`.
 * - `HIMMELCAD_OCCT_TOKEN` (optional) is sent as `HIMMELCAD_OCCT_TOKEN_HEADER`
 *   (default `PRIVATE-TOKEN`; a GitLab deploy token uses `Deploy-Token`).
 * - Target: `HIMMELCAD_OCCT_DIR`, else `<HIMMELCAD_OCCT_CACHE or the default cache root>/<version>/`
 *   (the same places the build looks in). Files already there with the right hash are kept.
 *
 * Exits non-zero on a missing URL, an HTTP error or a hash mismatch: the build must
 * never fall back to another module silently.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const vendor = join(repo, 'vendor/occt-wasm');
const FILES = ['himmelcad_occt.js', 'himmelcad_occt.wasm'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Expected SHA-256 per file name (`<hex>  dist/<file>` lines), as `occtModule.ts` reads them. */
export function artifactHashes(text) {
  const hashes = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (m) hashes.set(m[2].replace(/\\/g, '/').split('/').pop(), m[1].toLowerCase());
  }
  return hashes;
}

/** The cache directory the build reads (`occtModule.ts`: `occtCacheRoot()` / version). */
export function targetDir(env, version, platform = process.platform) {
  if (env.HIMMELCAD_OCCT_DIR) return resolve(env.HIMMELCAD_OCCT_DIR);
  const root = env.HIMMELCAD_OCCT_CACHE
    ? resolve(env.HIMMELCAD_OCCT_CACHE)
    : platform === 'win32'
      ? 'D:\\AgentWork\\HimmelCAD-Assembler\\occt-wasm'
      : join(os.homedir(), '.cache', 'himmelcad', 'occt-wasm');
  return join(root, version);
}

export const sourceUrl = (template, version, file) =>
  template.replaceAll('{version}', encodeURIComponent(version)).replaceAll('{file}', file);

async function main(env = process.env) {
  const version = JSON.parse(readFileSync(join(vendor, 'package.json'), 'utf8')).version;
  const hashes = artifactHashes(readFileSync(join(vendor, 'artifacts.sha256'), 'utf8'));
  const dir = targetDir(env, version);
  mkdirSync(dir, { recursive: true });
  const missing = FILES.filter((file) => {
    const path = join(dir, file);
    return !existsSync(path) || sha256(readFileSync(path)) !== hashes.get(file);
  });
  if (missing.length === 0) {
    process.stdout.write(`occt-wasm ${version}: verified in ${dir}\n`);
    return;
  }
  const template = env.HIMMELCAD_OCCT_URL;
  if (!template)
    throw new Error(`occt-wasm ${version}: not in ${dir} and HIMMELCAD_OCCT_URL is not set`);
  const headers = env.HIMMELCAD_OCCT_TOKEN
    ? { [env.HIMMELCAD_OCCT_TOKEN_HEADER || 'PRIVATE-TOKEN']: env.HIMMELCAD_OCCT_TOKEN }
    : {};
  for (const file of missing) {
    const expected = hashes.get(file);
    if (!expected) throw new Error(`${file}: no hash in vendor/occt-wasm/artifacts.sha256`);
    const url = sourceUrl(template, version, file);
    const started = Date.now();
    const response = await fetch(url, { headers, redirect: 'follow' });
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status} from ${url.split('?')[0]}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== expected) throw new Error(`${file}: SHA-256 ${actual}, expected ${expected}`);
    const path = join(dir, file);
    writeFileSync(`${path}.part`, bytes);
    rmSync(path, { force: true });
    renameSync(`${path}.part`, path);
    process.stdout.write(
      `occt-wasm ${version}: ${file} ${(bytes.length / 1048576).toFixed(1)} MB verified (${Date.now() - started} ms)\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
