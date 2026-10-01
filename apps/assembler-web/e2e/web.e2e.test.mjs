/**
 * End-to-end tests of the web build (`pnpm test:e2e` builds first): the
 * static site from `dist/`, served by `scripts/serve.mjs` with the headers a
 * host must send, driven in Chromium by playwright-core.
 *
 * 1. First load: strict document CSP (eval blocked), kernel and model ready,
 *    the service worker precaches the app ("works offline" notice); first
 *    and warm load measured (time, bytes on the wire) → `web-load.json` in
 *    the shots folder.
 * 2. Offline: the server is gone and the browser offline; a reload still
 *    starts the app, the kernel and the sketch solver (both wasm modules
 *    from the cache).
 * 3. Sketch → extrude through the UI; Save/Open round trip through the
 *    fallback path (download + upload, as in Safari/Firefox); STL export.
 * 4. File System Access path (Chromium): save in place, recent projects
 *    across a reload — the native pickers are replaced by handles from the
 *    origin-private file system, everything after the picker is real.
 * 5. Layout at tablet and phone sizes, with touch input enabled.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright-core';

import { startServer } from '../scripts/serve.mjs';
import {
  SHOTS_DIR,
  agentAccess,
  canvasCentre,
  chromiumPath,
  runCommand,
  shot,
  sketchAndExtrude,
  waitFor,
  waitForModel,
  watchErrors,
} from './helpers.mjs';

const launch = () =>
  chromium.launch({ executablePath: chromiumPath(), args: ['--enable-unsafe-swiftshader'] });

/** Bytes the server sent, by phase. */
function traffic() {
  let bytes = 0;
  let files = 0;
  return {
    onServe: (served) => {
      bytes += served.bytes;
      files += 1;
    },
    take: () => {
      const out = { bytes, files };
      bytes = 0;
      files = 0;
      return out;
    },
  };
}

const offlineReady = (page) =>
  page.getByText('Assembler now works offline').waitFor({ timeout: 180_000 });

void test('first load: strict CSP, kernel ready, service worker precache; first vs warm load', async (t) => {
  const wire = traffic();
  const server = await startServer({ onServe: wire.onServe });
  const browser = await launch();
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = watchErrors(page);

  const started = Date.now();
  await page.goto(server.url);
  await waitForModel(page);
  const firstReadyMs = Date.now() - started;
  const firstPageTraffic = wire.take();
  await shot(page, 'w1-first-load-ready');

  // The document's policy: no eval, no wasm compilation on the main thread.
  const csp = await page.evaluate(async () => ({
    header: (await fetch(location.href)).headers.get('content-security-policy'),
    meta: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
  }));
  for (const policy of [csp.header, csp.meta]) {
    assert.ok(policy, 'the document has a CSP');
    assert.doesNotMatch(policy, /unsafe-eval|wasm-unsafe-eval/);
    assert.match(policy, /default-src 'self'/);
  }
  // `page.evaluate` runs with Chromium's eval bypass; a string timer runs later, under the page's CSP.
  const evalRan = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let violated = false;
        document.addEventListener('securitypolicyviolation', () => (violated = true), {
          once: true,
        });
        try {
          setTimeout('window.__hcEvalRan = true', 0);
        } catch {
          // blocked synchronously
        }
        setTimeout(() => resolve({ ran: window.__hcEvalRan === true, violated }), 200);
      }),
  );
  assert.deepEqual(evalRan, { ran: false, violated: true }, 'string eval is blocked in the page');

  // The kernel worker runs under its own policy (it needs eval for the Emscripten glue).
  const workers = page.workers().map((w) => w.url());
  assert.ok(
    workers.some((url) => /kernel\.worker-/.test(url)),
    `kernel worker in ${workers.join(', ')}`,
  );

  await offlineReady(page);
  const precacheTraffic = wire.take();
  await shot(page, 'w1-offline-ready');
  const controlled = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    const cache = await caches.open(keys.find((k) => k.startsWith('hc-assembler-')));
    const urls = (await cache.keys()).map((r) => new URL(r.url).pathname);
    return {
      controller: navigator.serviceWorker.controller !== null,
      caches: keys,
      wasm: urls.filter((u) => u.endsWith('.wasm')).length,
      files: urls.length,
    };
  });
  assert.equal(controlled.controller, true, 'the first install claims the page');
  assert.equal(controlled.caches.length, 1);
  assert.equal(controlled.wasm, 2, 'OCCT and planeGCS are precached');

  // Warm load: everything from the service worker.
  const warmStarted = Date.now();
  await page.reload();
  await waitForModel(page);
  const warmReadyMs = Date.now() - warmStarted;
  const warmTraffic = wire.take();
  assert.ok(warmTraffic.bytes < 200_000, `warm load fetched ${warmTraffic.bytes} bytes`);

  const buildInfo = JSON.parse(
    readFileSync(new URL('../dist/build-info.json', import.meta.url), 'utf8'),
  );
  const report = {
    measuredAt: new Date().toISOString(),
    host: 'localhost static server (scripts/serve.mjs), brotli precompressed, no network throttling',
    build: {
      version: buildInfo.version,
      occtModule: buildInfo.occtModule,
      precache: buildInfo.precache,
    },
    firstLoad: { msToModel: firstReadyMs, ...firstPageTraffic },
    serviceWorkerPrecache: precacheTraffic,
    warmLoad: { msToModel: warmReadyMs, ...warmTraffic },
    cache: controlled,
  };
  writeFileSync(join(SHOTS_DIR, 'web-load.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`web load: ${JSON.stringify(report)}\n`);
  // The only console errors are the CSP reports of the eval probe above.
  assert.deepEqual(
    errors.filter((e) => !/Evaluating a string as JavaScript violates/.test(e)),
    [],
  );
});

void test('offline: reload without server and network starts the app, kernel and solver', async (t) => {
  let server = await startServer();
  const browser = await launch();
  t.after(async () => {
    await browser.close();
    await server?.close();
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(server.url);
  await waitForModel(page);
  await offlineReady(page);
  const url = server.url;
  await server.close();
  server = null;
  await context.setOffline(true);
  const errors = watchErrors(page);

  await page.reload();
  await waitForModel(page);
  assert.equal(page.url(), url);
  // Chromium's offline emulation does not reach `navigator.onLine` of a reloaded document;
  // toggling it fires the `offline` event the badge listens to, as a real network loss does.
  await context.setOffline(false);
  await context.setOffline(true);
  await page.locator('[data-offline-badge]').waitFor();
  assert.equal(await page.evaluate(() => navigator.onLine), false);

  // planeGCS from the cache: a circle solves (A, A, B as in the desktop production test).
  const centre = await canvasCentre(page);
  await page.keyboard.press('c');
  await page.waitForSelector('[data-sketch-status]');
  await page.waitForTimeout(500);
  for (const p of [centre, centre, { x: centre.x + 40, y: centre.y }]) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(300);
  }
  await page.waitForFunction(
    () =>
      /degrees of freedom|Fully constrained/.test(
        document.querySelector('[data-sketch-status]')?.textContent ?? '',
      ) || !!document.querySelector('[data-sketch-problem]'),
    null,
    { timeout: 30_000 },
  );
  const problem = await page.evaluate(
    () => document.querySelector('[data-sketch-problem]')?.textContent ?? null,
  );
  assert.equal(problem, null, `sketch solver offline: ${problem}`);
  await shot(page, 'w2-offline-sketch');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForTimeout(500);
  await shot(page, 'w2-offline-tablet');
  assert.deepEqual(errors, []);
});

void test('sketch → extrude in the UI; save/open round trip via download/upload; STL export', async (t) => {
  const server = await startServer();
  const browser = await launch();
  const downloads = mkdtempSync(join(tmpdir(), 'assembler-web-e2e-'));
  t.after(async () => {
    await browser.close();
    await server.close();
    rmSync(downloads, { recursive: true, force: true });
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  // Safari/Firefox have no File System Access pickers: the host falls back to download/upload.
  await context.addInitScript(() => {
    delete window.showOpenFilePicker;
    delete window.showSaveFilePicker;
    delete Window.prototype.showOpenFilePicker;
    delete Window.prototype.showSaveFilePicker;
  });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(server.url);
  await page.locator('[data-home-screen]').waitFor({ timeout: 120_000 });
  // Without the pickers there is no recent list; the Home screen says why.
  await page.getByText(/cannot reopen files on its own/).waitFor();
  await page.getByRole('button', { name: /^Blank/ }).click();
  await page.locator('[data-home-screen]').waitFor({ state: 'detached' });
  const rpc = await agentAccess(page);
  await waitFor(
    () => rpc('document.get'),
    (d) => d.kernel.status === 'ready',
    'kernel ready',
  );

  await sketchAndExtrude(page, 12);
  const bodies = await waitFor(
    () => rpc('bodies.list'),
    (list) => list.length === 1 && list[0].valid && list[0].volume > 0,
    'one extruded body',
  );
  const features = (await rpc('features.list')).map((f) => f.kind);
  assert.deepEqual(features, ['sketch', 'extrude']);
  await shot(page, 'w3-sketch-extrude');

  // Save: a download of the .hcasm (Ctrl+S).
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.keyboard.press('Control+s'),
  ]);
  assert.match(download.suggestedFilename(), /\.hcasm$/);
  const saved = join(downloads, download.suggestedFilename());
  await download.saveAs(saved);
  const project = JSON.parse(readFileSync(saved, 'utf8'));
  assert.equal(project.format, 'himmelcad-assembler');
  assert.deepEqual(
    project.features.map((f) => f.kind),
    ['sketch', 'extrude'],
  );

  // A different document, then Open (Ctrl+O) → the file chooser → the saved file.
  await rpc('project.new', { name: 'Other' });
  await waitFor(
    () => rpc('bodies.list'),
    (list) => list.length === 0,
    'blank document',
  );
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.keyboard.press('Control+o'),
  ]);
  await chooser.setFiles(saved);
  const reopened = await waitFor(
    () => rpc('bodies.list'),
    (list) => list.length === 1,
    'the saved body is back',
  );
  assert.ok(Math.abs(reopened[0].volume - bodies[0].volume) < 1e-6 * bodies[0].volume);

  // STL export: a download of a binary STL with the body's triangles.
  const [stl] = await Promise.all([
    page.waitForEvent('download'),
    runCommand(page, 'Export STL (All Bodies)'),
  ]);
  assert.match(stl.suggestedFilename(), /\.stl$/i);
  const stlPath = join(downloads, stl.suggestedFilename());
  await stl.saveAs(stlPath);
  const bytes = readFileSync(stlPath);
  const triangles = bytes.readUInt32LE(80);
  assert.ok(triangles >= 12, `STL triangles: ${triangles}`);
  assert.equal(bytes.length, 84 + triangles * 50, 'binary STL size');
  await shot(page, 'w3-after-export');
  assert.deepEqual(errors, []);
});

void test('File System Access (Chromium): save in place and reopen from Recent projects', async (t) => {
  const server = await startServer();
  const browser = await launch();
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // The native pickers cannot be driven headlessly: they return handles of the
  // origin-private file system instead, which are real FileSystemFileHandles.
  await context.addInitScript(() => {
    const handle = async (name) =>
      (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
    window.__pickerCalls = [];
    window.showSaveFilePicker = async (options) => {
      window.__pickerCalls.push(['save', options?.suggestedName ?? null]);
      return handle(options?.suggestedName ?? 'export.bin');
    };
    window.showOpenFilePicker = async () => {
      window.__pickerCalls.push(['open', null]);
      return [await handle('Plate.hcasm')];
    };
  });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(server.url);
  await page.locator('[data-home-screen]').waitFor({ timeout: 120_000 });
  await page.getByText('Projects you open or save appear here').waitFor();
  await page.getByRole('button', { name: /^Blank/ }).click();
  const rpc = await agentAccess(page);
  await waitFor(
    () => rpc('document.get'),
    (d) => d.kernel.status === 'ready',
    'kernel ready',
  );
  await rpc('project.new', { name: 'Plate' });
  await rpc('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 40, height: 30 }],
    },
  });
  const sketchId = (await rpc('features.list'))[0].id;
  await rpc('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: sketchId }, distance: 10 },
  });

  // First Save: the save picker; the file is written through the handle.
  await page.keyboard.press('Control+s');
  await waitFor(
    () => page.evaluate(() => window.__pickerCalls.length),
    (n) => n === 1,
    'one save picker',
  );
  // `{}` while the file is still empty (the picker created it; the write lands on close).
  const readOpfs = () =>
    page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle('Plate.hcasm')).getFile();
      const text = await file.text();
      return text ? JSON.parse(text) : {};
    });
  const first = await waitFor(
    readOpfs,
    (p) => p.features?.length === 2,
    'written through the handle',
  );
  assert.equal(first.projectName, 'Plate');

  // Second Save after an edit: in place, no picker.
  await rpc('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY', offset: 10 },
      profiles: [{ kind: 'circle', cx: 20, cy: 15, radius: 5 }],
    },
  });
  await page.keyboard.press('Control+s');
  await waitFor(readOpfs, (p) => p.features?.length === 3, 'saved in place');
  assert.equal(await page.evaluate(() => window.__pickerCalls.length), 1, 'no second picker');

  // A reload, then the project from Recent projects on the Home screen.
  await page.reload();
  const home = page.locator('[data-home-screen]');
  await home.waitFor({ timeout: 120_000 });
  // The card's name is the file name without the extension (the icon button is "Remove …").
  const recent = home.getByRole('button', { name: /^Plate/ }).first();
  await recent.waitFor({ timeout: 20_000 });
  // Saved work is no recovery case: no "Recover unsaved changes?" offer after the reload.
  assert.equal(await home.getByRole('button', { name: 'Recover' }).count(), 0);
  await shot(page, 'w4-home-recent');
  await recent.click();
  await home.waitFor({ state: 'detached', timeout: 60_000 });
  const reopenRpc = await agentAccess(page);
  const reopened = await waitFor(
    () => reopenRpc('features.list'),
    (list) => list.length === 3,
    'reopened from the recent list',
  );
  assert.deepEqual(
    reopened.map((f) => f.kind),
    ['sketch', 'extrude', 'sketch'],
  );
  assert.deepEqual(errors, []);
});

void test('layout: tablet and phone sizes with touch', async (t) => {
  const server = await startServer();
  const browser = await launch();
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  for (const [name, viewport] of [
    ['tablet-landscape', { width: 1180, height: 820 }],
    ['tablet-portrait', { width: 820, height: 1180 }],
    ['phone', { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({ viewport, hasTouch: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = watchErrors(page);
    await page.goto(server.url);
    await page.locator('[data-home-screen]').waitFor({ timeout: 120_000 });
    await page.waitForTimeout(300);
    await shot(page, `w5-${name}-home`);
    await waitForModel(page, { items: viewport.width >= 700 });
    await page.waitForTimeout(1500);
    await shot(page, `w5-${name}`);
    // The viewport takes touch: a tap lands on the canvas, not on page chrome.
    const centre = await canvasCentre(page);
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null,
      centre,
    );
    assert.equal(hit, 'CANVAS', `${name}: the centre of the screen is the model`);
    const scroll = await page.evaluate(() => ({
      x: document.scrollingElement.scrollWidth - innerWidth,
      y: document.scrollingElement.scrollHeight - innerHeight,
    }));
    assert.deepEqual(scroll, { x: 0, y: 0 }, `${name}: the page itself never scrolls`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
