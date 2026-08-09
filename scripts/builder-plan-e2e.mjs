import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import {
  browserHeadless,
  resolveChromeExecutable,
} from '../packages/@himmelcad/viewer/test/support/platform-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');
const rendererRoot = path.join(repositoryRoot, 'apps/builder/dist/renderer');

assert(
  (await stat(path.join(rendererRoot, 'index.html'))).isFile(),
  'Build Builder before UI smoke',
);

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.wasm', 'application/wasm'],
  ['.woff2', 'font/woff2'],
]);

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(rendererRoot, requested);
    if (!file.startsWith(`${rendererRoot}${path.sep}`) && file !== rendererRoot) {
      response.writeHead(403).end('forbidden');
      return;
    }
    const data = await readFile(file);
    response.writeHead(200, {
      'Content-Type': contentTypes.get(path.extname(file)) ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(data);
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');

const browser = await chromium.launch({
  executablePath: resolveChromeExecutable(),
  headless: browserHeadless(),
  args: ['--disable-webgpu'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const planErrors = [];
  let collectPlanErrors = false;
  page.on('pageerror', (error) => {
    if (collectPlanErrors) planErrors.push(error.stack ?? error.message);
  });
  page.on('console', (message) => {
    if (collectPlanErrors && message.type() === 'error') planErrors.push(message.text());
  });

  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Output', exact: true }).click();
  await page.getByRole('button', { name: 'Plan', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Plan editor' });
  await dialog.waitFor({ timeout: 20_000 });
  collectPlanErrors = true;

  const canvas = dialog.locator('.excalidraw canvas').first();
  await canvas.waitFor({ state: 'visible', timeout: 30_000 });
  const box = await canvas.boundingBox();
  assert(box, 'Excalidraw canvas has no visible bounds');

  await page.keyboard.press('r');
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.61, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  const status = dialog.locator('footer').last();
  await assertStatus(status, /1 elements/);
  await dialog.locator('button[title="Undo"]').click();
  await assertStatus(status, /0 elements/);
  await dialog.locator('button[title="Redo"]').click();
  await assertStatus(status, /1 elements/);

  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await dialog.getByText('Sheet 2', { exact: true }).waitFor();
  await assertStatus(status, /0 elements/);
  await dialog.getByText('Sheet 1', { exact: true }).click();
  await assertStatus(status, /1 elements/);

  await dialog.getByRole('button', { name: 'Library', exact: true }).click();
  await dialog.getByRole('button', { name: /ISO drawing frame/ }).click();
  await assertStatus(status, /[2-9][0-9]* elements/);

  await dialog.getByRole('button', { name: 'Sheets', exact: true }).click();
  await dialog.getByText('Sheet 2', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await dialog.getByText('Sheet 2 copy', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByText('Sheet 2', { exact: true }).waitFor();
  await dialog.getByText('Sheet 2 copy', { exact: true }).waitFor({ state: 'detached' });

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save .hcplan', exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  assert(downloadPath, 'Browser did not materialize .hcplan download');
  const saved = JSON.parse(await readFile(downloadPath, 'utf8'));
  assert.equal(saved.formatVersion, 2);
  assert.equal(saved.sheets.length, 2);
  assert.match(saved.contentHash, /^fnv1a64:[a-f0-9]{16}$/);

  assert.deepEqual(planErrors, [], `Plan UI browser errors:\n${planErrors.join('\n')}`);
  console.log(
    JSON.stringify({
      ok: true,
      sourceForkCanvas: true,
      nativeUndoRedo: true,
      sheetIsolation: true,
      multiSheetRoundtrip: true,
      sheets: saved.sheets.length,
    }),
  );
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function assertStatus(locator, expression) {
  await locator.waitFor({ state: 'visible' });
  await locator.page().waitForFunction(
    ({ selector, source, flags }) => {
      const element = document.querySelector(selector);
      return element ? new RegExp(source, flags).test(element.textContent ?? '') : false;
    },
    {
      selector: await locator.evaluate((element) => {
        element.dataset.planE2eStatus = 'true';
        return '[data-plan-e2e-status="true"]';
      }),
      source: expression.source,
      flags: expression.flags,
    },
    { timeout: 10_000 },
  );
}
