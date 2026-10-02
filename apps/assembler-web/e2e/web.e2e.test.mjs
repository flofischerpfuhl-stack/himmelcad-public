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
 * 6. Navigation: orbiting over a bore pivots inside it (orthographic, perspective,
 *    adaptive), chosen in the Display popover's projection row.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import { startServer } from '../scripts/serve.mjs';
import {
  SHOTS_DIR,
  agentAccess,
  canvasCentre,
  checkViewCube,
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
  await checkViewCube(page, 'chromium');
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

  // Block 9: renders and skills work in the browser too (the GPU renderer of the page's
  // viewport); the embedded assistant needs local CLIs, so its dock button is hidden.
  const render = await rpc('view.render', { view: 'iso', width: 320, height: 240 });
  assert.equal(render.mediaType, 'image/png');
  assert.equal(render.renderer, 'gpu');
  assert.ok((await rpc('skills.list')).skills.some((s) => s.id === 'printable-part'));
  assert.equal(await page.getByRole('button', { name: 'Assistant', exact: true }).count(), 0);

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
  // `{}` while the file is still empty (the picker created it; the write lands on close) —
  // or while a save in place swaps the file (Chromium briefly reports it as not found).
  const readOpfs = () =>
    page.evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory();
        const file = await (await root.getFileHandle('Plate.hcasm')).getFile();
        const text = await file.text();
        return text ? JSON.parse(text) : {};
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return {};
        throw error;
      }
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

void test('update: a new deployment installs in the background and waits for Reload', async (t) => {
  // A copy of the site, so the "deployment" can change under the running app.
  const site = mkdtempSync(join(tmpdir(), 'assembler-web-update-'));
  cpSync(fileURLToPath(new URL('../dist', import.meta.url)), site, { recursive: true });
  const server = await startServer({ dir: site });
  const browser = await launch();
  t.after(async () => {
    await browser.close();
    await server.close();
    rmSync(site, { recursive: true, force: true });
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = watchErrors(page);
  const version = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = (event) => resolve(event.data.version);
          navigator.serviceWorker.controller.postMessage({ type: 'VERSION' }, [channel.port2]);
        }),
    );
  await page.goto(server.url);
  await waitForModel(page);
  await offlineReady(page);
  const before = await version();

  // Deploy: a changed index.html and a service worker with a new version.
  const swPath = join(site, 'sw.js');
  writeFileSync(swPath, readFileSync(swPath, 'utf8').replace(before, `${before.slice(0, 12)}next`));
  const indexPath = join(site, 'index.html');
  writeFileSync(indexPath, `${readFileSync(indexPath, 'utf8')}<!-- next deployment -->\n`);
  // Their precompressed copies would still be the old deployment.
  for (const stale of [swPath, indexPath]) {
    rmSync(`${stale}.br`, { force: true });
    rmSync(`${stale}.gz`, { force: true });
  }
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());

  const reload = page.getByRole('button', { name: 'Reload' });
  await reload.waitFor({ timeout: 120_000 });
  await page.getByText('A new version of Assembler is ready.').waitFor();
  assert.equal(await version(), before, 'the running app keeps its version until Reload');
  await shot(page, 'w7-update-ready');
  await Promise.all([page.waitForEvent('load'), reload.click()]);
  await waitForModel(page);
  assert.equal(await version(), `${before.slice(0, 12)}next`);
  assert.equal(
    await page.evaluate(async () =>
      (await (await fetch('index.html')).text()).includes('next deployment'),
    ),
    true,
    'the new deployment is what the service worker serves',
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
    // The top bar's menus never run under the view cube (phone width: the cube moves below).
    const underCube = await page.evaluate(() => {
      const cube = document.querySelector('[aria-label^="View cube"]').getBoundingClientRect();
      return Array.from(document.querySelectorAll('nav[aria-label="Main menu"] button'))
        .map((b) => ({ label: b.textContent, r: b.getBoundingClientRect() }))
        .filter(({ r }) => r.right > cube.left && r.left < cube.right && r.bottom > cube.top - 34)
        .map(({ label }) => label);
    });
    assert.deepEqual(underCube, [], `${name}: menus under the view cube`);
    const scroll = await page.evaluate(() => ({
      x: document.scrollingElement.scrollWidth - innerWidth,
      y: document.scrollingElement.scrollHeight - innerHeight,
    }));
    assert.deepEqual(scroll, { x: 0, y: 0 }, `${name}: the page itself never scrolls`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

void test('navigation: the orbit pivot sits inside a bore; projection row in the Display popover', async (t) => {
  const server = await startServer();
  const browser = await launch();
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ).newPage();
  const errors = watchErrors(page);
  await page.goto(server.url);
  await page.locator('[data-home-screen]').waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: /^Blank/ }).click();
  await page.locator('[data-home-screen]').waitFor({ state: 'detached' });
  const rpc = await agentAccess(page);
  await waitFor(
    () => rpc('document.get'),
    (d) => d.kernel.status === 'ready',
    'kernel ready',
  );
  // A 40 × 40 × 10 plate centred on the origin with a Ø5 through bore in its middle.
  const plate = await rpc('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY' },
      profiles: [{ kind: 'rectangle', x: -20, y: -20, width: 40, height: 40 }],
    },
  });
  const body = await rpc('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: plate.featureId }, distance: 10 },
  });
  const bodyId = `body:${body.featureId}`;
  const bore = await rpc('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'face', face: { bodyId, select: '>Z' } },
      profiles: [{ kind: 'circle', cx: 0, cy: 0, radius: 2.5 }],
    },
  });
  await rpc('feature.create', {
    kind: 'extrude',
    params: {
      profile: { kind: 'sketch', featureId: bore.featureId },
      distance: -10,
      operation: 'cut',
      targetBodyId: bodyId,
    },
  });
  const [solid] = await waitFor(
    () => rpc('bodies.list'),
    (list) =>
      list.length === 1 && list[0].valid && Math.abs(list[0].volume - (16000 - 62.5 * Math.PI)) < 1,
    'the plate with its bore',
  );
  assert.ok(solid);

  // Orthographic is the default; the Display popover offers the three modes in one row.
  await page.locator('button[aria-label^="Display:"]').click();
  const row = page.getByRole('radiogroup', { name: 'Projection' });
  assert.equal(
    await row.getByRole('radio', { name: 'Orthographic' }).getAttribute('aria-checked'),
    'true',
  );
  await shot(page, 'w7-display-projection-row');
  await page.keyboard.press('Escape');

  /** Top view, fitted: the bore is in the middle of the canvas. Orbits from there; reads the dot. */
  const orbitOverBore = async (name) => {
    await page.keyboard.press('Control+4');
    await page.waitForTimeout(500);
    await runCommand(page, 'Zoom to fit');
    await page.waitForTimeout(800);
    const c = await canvasCentre(page);
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    await page.mouse.move(x, y);
    await page.waitForTimeout(150);
    await page.mouse.down({ button: 'right' });
    for (let i = 1; i <= 10; i += 1) await page.mouse.move(x + i * 6, y + i * 2);
    await page.waitForTimeout(150);
    const dot = await page.evaluate(() => {
      const el = document.querySelector('[data-pivot]');
      return el
        ? {
            point: el.getAttribute('data-pivot').split(',').map(Number),
            rule: el.getAttribute('data-pivot-rule'),
          }
        : null;
    });
    await shot(page, `w7-pivot-${name}`);
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(200);
    assert.ok(dot, `${name}: the pivot dot shows while orbiting`);
    assert.equal(
      await page.locator('[data-pivot]').count(),
      0,
      `${name}: the dot goes with the orbit`,
    );
    const [px, py, pz] = dot.point;
    assert.ok(Math.hypot(px, py) < 2.5, `${name}: inside the bore (x, y = ${px}, ${py})`);
    return { rule: dot.rule, z: pz };
  };

  // Orthographic: nothing under the cursor (it looks through the bore) → the rim's depth.
  const ortho = await orbitOverBore('orthographic');
  assert.equal(ortho.rule, 'near');
  assert.ok(Math.abs(ortho.z - 10) < 0.2, `orthographic: at the rim depth (z = ${ortho.z})`);

  // Perspective (chosen in the popover): the bore's wall is seen too, the pivot sits in the bore.
  await page.locator('button[aria-label^="Display:"]').click();
  await row.getByRole('radio', { name: 'Perspective' }).click();
  await page.keyboard.press('Escape');
  const persp = await orbitOverBore('perspective');
  assert.ok(persp.z > 0 && persp.z <= 10.05, `perspective: inside the bore (z = ${persp.z})`);

  // Adaptive: the Top view is a standard view → parallel again → the rim depth exactly.
  await page.locator('button[aria-label^="Display:"]').click();
  await row.getByRole('radio', { name: 'Adaptive' }).click();
  await page.keyboard.press('Escape');
  const adaptive = await orbitOverBore('adaptive');
  assert.ok(Math.abs(adaptive.z - 10) < 0.2, `adaptive top view is parallel (z = ${adaptive.z})`);
  assert.deepEqual(errors, []);
});

void test('navigation: over a bore much wider than the 64 px window the pivot finds the nearest rim', async (t) => {
  const server = await startServer();
  const browser = await launch();
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 800 } })
  ).newPage();
  const errors = watchErrors(page);
  await page.goto(server.url);
  await page.locator('[data-home-screen]').waitFor({ timeout: 120_000 });
  // Block 9: Escape on the Home screen leaves a blank project, never the sample bracket.
  await page.keyboard.press('Escape');
  await page.locator('[data-home-screen]').waitFor({ state: 'detached' });
  const rpc = await agentAccess(page);
  await waitFor(
    () => rpc('document.get'),
    (d) => d.kernel.status === 'ready',
    'kernel ready',
  );
  const start = await rpc('document.get');
  assert.equal(start.projectName, 'Untitled', 'a blank project');
  assert.equal((await rpc('features.list')).length, 0, 'no sample features');
  assert.ok(await page.getByText('No items yet').isVisible());
  // A 40 × 40 × 10 plate with a Ø30 through bore: fitted, the bore is ~450 px wide on screen.
  const plate = await rpc('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY' },
      profiles: [{ kind: 'rectangle', x: -20, y: -20, width: 40, height: 40 }],
    },
  });
  const body = await rpc('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: plate.featureId }, distance: 10 },
  });
  const bodyId = `body:${body.featureId}`;
  const bore = await rpc('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'face', face: { bodyId, select: '>Z' } },
      profiles: [{ kind: 'circle', cx: 0, cy: 0, radius: 15 }],
    },
  });
  await rpc('feature.create', {
    kind: 'extrude',
    params: {
      profile: { kind: 'sketch', featureId: bore.featureId },
      distance: -10,
      operation: 'cut',
      targetBodyId: bodyId,
    },
  });
  await waitFor(
    () => rpc('bodies.list'),
    (list) =>
      list.length === 1 && list[0].valid && Math.abs(list[0].volume - (16000 - 2250 * Math.PI)) < 1,
    'the plate with its wide bore',
  );
  await page.keyboard.press('Control+4');
  await page.waitForTimeout(500);
  await runCommand(page, 'Zoom to fit');
  await page.waitForTimeout(800);
  // How wide the bore is on screen: project two rim points.
  const c = await canvasCentre(page);
  const x = Math.round(c.x);
  const y = Math.round(c.y);
  const span = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    return canvas ? canvas.getBoundingClientRect().height : 0;
  });
  assert.ok(span > 300, 'a tall enough viewport');
  await page.mouse.move(x, y);
  await page.waitForTimeout(150);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 10; i += 1) await page.mouse.move(x + i * 6, y + i * 2);
  await page.waitForTimeout(150);
  const dot = await page.evaluate(() => {
    const el = document.querySelector('[data-pivot]');
    return el
      ? {
          point: el.getAttribute('data-pivot').split(',').map(Number),
          rule: el.getAttribute('data-pivot-rule'),
        }
      : null;
  });
  await shot(page, 'b9-pivot-wide-bore');
  await page.mouse.up({ button: 'right' });
  assert.ok(dot, 'the pivot dot shows while orbiting');
  assert.equal(dot.rule, 'nearest', 'the window is empty: the coarse map finds the rim');
  const [px, py, pz] = dot.point;
  assert.ok(Math.hypot(px, py) < 15, `inside the bore (x, y = ${px}, ${py})`);
  assert.ok(Math.abs(pz - 10) < 0.3, `at the rim depth, not the model centre (z = ${pz})`);
  assert.deepEqual(errors, []);
});
