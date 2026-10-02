/**
 * The installed-app side of the web build in Chromium (assembler/WEB.md §4),
 * against the built site (`scripts/serve.mjs`) or, with `ASM_WEB_URL`, a
 * deployed one:
 *
 * 1. Installable: no installability errors (`Page.getInstallabilityErrors`),
 *    no manifest errors, icons/screenshots as declared, favicons, and the
 *    preview build's noindex (robots meta, `X-Robots-Tag`, `robots.txt`).
 * 2. Installed: the app is installed through the DevTools protocol
 *    (`PWA.install`); files launched with it (`PWA.launchFilesInApp`, the
 *    "Open with" path) arrive through `launchQueue`: an STL is imported, a
 *    project opens. The shortcuts' `?action=` start URLs.
 * 3. Share target: a multipart POST to `./share-target` (what the share sheet
 *    sends) is answered by the service worker and the file imported.
 *
 * A persistent profile (installation needs one) under the temp folder.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright-core';

import { startServer } from '../scripts/serve.mjs';
import { DEMO_PROJECT, chromiumPath, shot, waitFor, watchErrors } from './helpers.mjs';

const REMOTE = process.env.ASM_WEB_URL ?? null;

/** An ASCII STL of a 40 mm cube (12 facets; smaller ones raise the inches question). */
function cubeStl(name) {
  const v = (x, y, z) => `vertex ${x * 40} ${y * 40} ${z * 40}`;
  const quads = [
    [
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
      [0, 0, 1],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
      [0, -1, 0],
    ],
    [
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 1],
      [0, 1, 0],
      [-1, 0, 0],
    ],
    [
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
      [1, 0, 0],
    ],
  ];
  const facets = quads.flatMap(([a, b, c, d, n]) =>
    [
      [a, b, c],
      [a, c, d],
    ].map(
      (tri) =>
        `facet normal ${n.join(' ')}\nouter loop\n${tri.map((p) => v(...p)).join('\n')}\nendloop\nendfacet`,
    ),
  );
  return `solid ${name}\n${facets.join('\n')}\nendsolid ${name}\n`;
}

async function site(t) {
  if (REMOTE) return REMOTE.endsWith('/') ? REMOTE : `${REMOTE}/`;
  const server = await startServer();
  t.after(() => server.close());
  return server.url;
}

async function profile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'assembler-web-pwa-'));
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: chromiumPath(),
    args: ['--enable-unsafe-swiftshader'],
    viewport: { width: 1280, height: 800 },
  });
  t.after(async () => {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { context, dir, page: context.pages()[0] ?? (await context.newPage()) };
}

/** The app is up and its service worker controls the page (precache done). */
async function appReady(page) {
  await page.locator('[data-home-screen]').waitFor({ timeout: 180_000 });
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, {
    timeout: 180_000,
  });
}

const itemsText = (page) => page.evaluate(() => document.body.innerText);

void test('installable: manifest, icons, screenshots, favicons, noindex preview', async (t) => {
  const url = await site(t);
  const { context, page } = await profile(t);
  const errors = watchErrors(page);
  const response = await page.goto(url);
  await appReady(page);
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  assert.deepEqual(installabilityErrors, [], 'Chromium installability');
  const manifest = await cdp.send('Page.getAppManifest');
  assert.deepEqual(manifest.errors, [], 'manifest parse errors');

  const m = JSON.parse(manifest.data);
  assert.equal(m.short_name, 'Assembler');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
  assert.ok(m.icons.some((i) => (i.purpose ?? 'any') === 'any' && i.sizes === '192x192'));
  assert.deepEqual(m.launch_handler.client_mode, ['focus-existing', 'auto']);
  assert.equal(m.share_target.method, 'POST');
  assert.deepEqual(m.file_handlers.flatMap((h) => Object.values(h.accept).flat()).sort(), [
    '.3mf',
    '.hcasm',
    '.step',
    '.stl',
    '.stp',
  ]);
  // Every declared image exists with the declared size (PNG IHDR).
  const base = new URL(manifest.url);
  const images = [...m.icons, ...m.screenshots, ...m.shortcuts.flatMap((s) => s.icons)];
  for (const image of images) {
    const size = await page.evaluate(async (src) => {
      const r = await fetch(src);
      const bytes = new DataView(await r.arrayBuffer());
      return {
        status: r.status,
        type: r.headers.get('Content-Type'),
        size: `${bytes.getUint32(16)}x${bytes.getUint32(20)}`,
      };
    }, new URL(image.src, base).href);
    assert.equal(size.status, 200, image.src);
    assert.match(size.type, /^image\/png/, image.src);
    assert.equal(size.size, image.sizes, image.src);
  }
  assert.deepEqual(
    m.screenshots.map((s) => s.form_factor).sort(),
    ['narrow', 'wide'],
    'richer install UI needs both form factors',
  );

  for (const [path, type] of [
    ['icons/favicon.svg', /^image\/svg\+xml/],
    ['favicon.ico', /^image\/(x-icon|vnd\.microsoft\.icon)/],
    ['icons/apple-touch-icon.png', /^image\/png/],
  ]) {
    const r = await page.request.get(new URL(path, url).href);
    assert.equal(r.status(), 200, path);
    assert.match(r.headers()['content-type'], type, path);
  }

  // Preview build: noindex three ways (deploy/README.md "Going public").
  assert.equal(
    await page.locator('meta[name="robots"]').getAttribute('content'),
    'noindex, nofollow',
  );
  assert.equal(response.headers()['x-robots-tag'], 'noindex, nofollow');
  const robots = await page.request.get(new URL('robots.txt', url).href);
  assert.match(await robots.text(), /^Disallow: \/$/m);
  await page.locator('[data-preview-badge]').waitFor();
  await shot(page, 'r1-home-preview-badge');
  assert.deepEqual(errors, []);
});

void test('installed: files launched with the app are imported or opened; shortcuts', async (t) => {
  const url = await site(t);
  const { context, page, dir } = await profile(t);
  const errors = watchErrors(page);
  await page.goto(url);
  await appReady(page);
  const browserCdp = await context.browser()?.newBrowserCDPSession();
  const cdp = browserCdp ?? (await context.newCDPSession(page));
  const manifestId = new URL(url).href;
  await cdp.send('PWA.install', { manifestId, installUrlOrBundleUrl: url });
  const state = await cdp.send('PWA.getOsAppState', { manifestId });
  assert.equal(state.fileHandlers.length, 2, 'file handlers registered with the OS');

  // An STL "opened with" the app: launch_handler focus-existing hands it to the running window.
  const stl = join(dir, 'launched-cube.stl');
  writeFileSync(stl, cubeStl('launched-cube'));
  await cdp.send('PWA.launchFilesInApp', { manifestId, files: [stl] });
  await waitFor(
    () => itemsText(page),
    (text) => text.includes('launched-cube') && !text.includes('Could not import'),
    'launched STL imported',
  );
  await shot(page, 'r2-launched-stl');

  // A project file opens (unsaved changes: the import above made the project dirty).
  const project = join(dir, 'Launched bracket.hcasm');
  writeFileSync(project, DEMO_PROJECT);
  await cdp.send('PWA.launchFilesInApp', { manifestId, files: [project] });
  const discard = page.getByRole('button', { name: /Don.t save|Discard/ });
  await discard.waitFor({ timeout: 30_000 }).catch(() => undefined);
  if (await discard.isVisible()) await discard.click();
  await waitFor(
    () => itemsText(page),
    (text) => text.includes('1 body · 3 sketches') && !text.includes('launched-cube'),
    'launched project opened',
  );
  await shot(page, 'r2-launched-project');

  // Shortcuts: `?action=new` starts on an empty project without Home; the query is dropped.
  await page.goto(new URL('?action=new', url).href);
  await page.waitForFunction(() => !location.search, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('[data-home-screen]').count(), 0, 'no Home after "New project"');
  await page.goto(new URL('?action=home', url).href);
  await page.locator('[data-home-screen]').waitFor({ timeout: 60_000 });
  assert.deepEqual(
    errors.filter((e) => !/beforeunload/i.test(e)),
    [],
  );
});

void test('share target: a shared STL is taken by the service worker and imported', async (t) => {
  const url = await site(t);
  const { page } = await profile(t);
  const errors = watchErrors(page);
  await page.goto(url);
  await appReady(page);
  // What the share sheet sends: a multipart POST navigation to the manifest's action. Started
  // from a blank page: the app's own CSP (`form-action 'none'`) forbids forms in the app, and
  // the share sheet's navigation comes from the browser, not from a page of the app.
  await page.goto('about:blank');
  await page.evaluate(
    ([text, action]) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.enctype = 'multipart/form-data';
      form.action = action;
      const input = document.createElement('input');
      input.type = 'file';
      input.name = 'files';
      const files = new DataTransfer();
      files.items.add(new File([text], 'shared-cube.stl', { type: 'model/stl' }));
      input.files = files.files;
      form.append(input);
      document.body.append(form);
      form.submit();
    },
    [cubeStl('shared-cube'), new URL('share-target', url).href],
  );
  await page.waitForURL((u) => u.href.startsWith(url) && !u.search, { timeout: 120_000 });
  await waitFor(
    () => itemsText(page),
    (text) => text.includes('shared-cube') && !text.includes('Could not import'),
    'shared STL imported',
  );
  assert.equal(
    await page.evaluate(async () => (await caches.keys()).includes('hc-shared-files')),
    false,
    'the share cache is emptied',
  );
  await shot(page, 'r3-shared-stl');
  assert.deepEqual(errors, []);
});
