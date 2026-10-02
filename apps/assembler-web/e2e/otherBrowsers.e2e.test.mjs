/**
 * Smoke test of the web build in Firefox and WebKit (the engine of Safari
 * and every iPad browser) — only with builds already installed on this host
 * (`ms-playwright/firefox-*`, `webkit-*`; nothing is downloaded), skipped
 * otherwise. These engines have no File System Access pickers, so they run
 * the upload/download host. Checked: the app starts, the kernel loads and
 * evaluates the start document, the sketch solver solves, the service worker
 * installs, and a sketch → extrude through the in-page agent API works.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { firefox, webkit } from 'playwright-core';

import { startServer } from '../scripts/serve.mjs';
import {
  agentAccess,
  checkViewCube,
  canvasCentre,
  shot,
  waitFor,
  waitForModel,
  watchErrors,
} from './helpers.mjs';

function installed(prefix, relative) {
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (process.platform !== 'win32' || !existsSync(root)) return undefined;
  const dirs = readdirSync(root)
    .filter((name) => name.startsWith(`${prefix}-`))
    .sort()
    .reverse();
  for (const dir of dirs) {
    const candidate = join(root, dir, ...relative);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const ENGINES = [
  ['firefox', firefox, process.env.ASM_FIREFOX ?? installed('firefox', ['firefox', 'firefox.exe'])],
  ['webkit', webkit, process.env.ASM_WEBKIT ?? installed('webkit', ['Playwright.exe'])],
];

for (const [name, engine, executablePath] of ENGINES) {
  void test(
    `${name}: start, kernel, solver, service worker, agent sketch → extrude`,
    {
      skip: executablePath ? false : `no local ${name} build`,
    },
    async (t) => {
      // `ASM_WEB_URL`: the deployed site instead of the local build.
      const server = process.env.ASM_WEB_URL
        ? { url: process.env.ASM_WEB_URL, close: async () => undefined }
        : await startServer();
      const browser = await engine.launch({ executablePath });
      t.after(async () => {
        await browser.close();
        await server.close();
      });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors = watchErrors(page);
      await page.goto(server.url);
      // No File System Access here: the Home screen says why there is no recent list.
      await page.locator('[data-home-screen]').waitFor({ timeout: 120_000 });
      await page.getByText(/cannot reopen files on its own/).waitFor();
      await waitForModel(page, { timeout: 180_000 });
      await shot(page, `w6-${name}-ready`);
      // The orientation cube: drawn as a cube, hit-tested where drawn, face/corner/edge clicks orient.
      await checkViewCube(page, name);

      // The agent first, on a clean document (a dirty one would make project.new refuse).
      const rpc = await agentAccess(page);
      await rpc('project.new', { name: 'Smoke' });
      const sketch = await rpc('feature.create', {
        kind: 'sketch',
        params: {
          plane: { kind: 'plane', plane: 'XY', offset: 0 },
          profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 40, height: 30 }],
        },
      });
      await rpc('feature.create', {
        kind: 'extrude',
        params: { profile: { kind: 'sketch', featureId: sketch.featureId }, distance: 10 },
      });
      const bodies = await waitFor(
        () => rpc('bodies.list'),
        (list) => list.length === 1 && list[0].valid,
        'extruded body',
      );
      assert.ok(Math.abs(bodies[0].volume - 12_000) < 1e-6 * 12_000, `volume ${bodies[0].volume}`);
      await page.waitForTimeout(500);
      await shot(page, `w6-${name}-extrude`);

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
        { timeout: 60_000 },
      );
      assert.equal(
        await page.evaluate(
          () => document.querySelector('[data-sketch-problem]')?.textContent ?? null,
        ),
        null,
      );
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      const sw = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return 'unsupported';
        const registration = await navigator.serviceWorker.getRegistration();
        return registration ? 'registered' : 'none';
      });
      await shot(page, `w6-${name}-sketch`);
      process.stdout.write(`${name}: service worker ${sw}\n`);
      assert.deepEqual(errors, []);
    },
  );
}
