import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron, chromium } from 'playwright-core';
import {
  resolveChromeExecutable,
  resolveElectronExecutable,
  resolveEsbuildExecutable,
} from '../support/platform-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const viewerRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(viewerRoot, '../../..');
const outputRoot = path.join(repoRoot, 'target/viewer-public-consumer-process');
const bundle = path.join(outputRoot, 'public-process-bundle.js');
const esbuild = resolveEsbuildExecutable(repoRoot);
const electronExecutable = resolveElectronExecutable(repoRoot);
const electronMain = path.join(viewerRoot, 'test/electron/public-process-main.cjs');
const html = path.join(here, 'public-process-host.html');

await mkdir(outputRoot, { recursive: true });
await run(esbuild, [
  path.join(here, 'public-process-main.ts'),
  '--bundle',
  '--format=esm',
  '--target=es2022',
  `--outfile=${bundle}`,
]);

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const file = pathname === '/public-process-bundle.js' ? bundle : html;
  response.writeHead(200, {
    'Content-Type': file.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(await readFile(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
const rootUrl = `http://127.0.0.1:${String(address.port)}`;

const browser = await chromium.launch({
  executablePath: resolveChromeExecutable(),
  headless: true,
  args: ['--disable-gpu'],
});
try {
  const page = await browser.newPage();
  await page.goto(`${rootUrl}/?host=browser`);
  await assertHost(page, 'browser');
} finally {
  await browser.close();
}

const application = await electron.launch({
  executablePath: electronExecutable,
  args: [electronMain, '--no-sandbox'],
  env: { ...process.env, HCAD_PUBLIC_HOST_URL: `${rootUrl}/?host=electron` },
});
try {
  const page = await application.firstWindow();
  await assertHost(page, 'electron');
} finally {
  await application.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(
  JSON.stringify({ browser: 'pass', electron: 'pass', entities: 4, publicFacadeOnly: true }),
);

async function assertHost(page, environment) {
  await page.waitForFunction(() => window.__HCAD_PUBLIC_HOST__?.ready === true);
  const state = await page.evaluate(() => window.__HCAD_PUBLIC_HOST__);
  assert.equal(state.error, null);
  assert.equal(state.environment, environment);
  assert.deepEqual(state.entityIds, [
    'public-point',
    'public-plan-curve',
    'public-extension',
    'public-splat',
  ]);
  assert.equal(
    await page.evaluate(() => window.__HCAD_PUBLIC_HOST__?.dispose?.()),
    true,
    `${environment} host must release its session owner`,
  );
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${String(code)} (${String(signal)})`));
    });
  });
}
