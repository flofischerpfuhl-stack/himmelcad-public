/**
 * Print mode in the production build (`app://`, strict CSP): the
 * printability worker loads and analyses the demo part, and the slicer IPC
 * lists this host's slicers and refuses anything but a registered slicer id
 * (the renderer can never make the main process start an arbitrary path).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _electron as electron } from 'playwright-core';

import { closeApp } from './closeApp.js';

const APP_DIR = process.cwd();
const SHOTS_DIR =
  process.env.ASSEMBLER_SHOTS_DIR ?? join('D:', 'AgentWork', 'HimmelCAD-Assembler', 'shots');

void test('production build: Print mode analyses in its worker; the slicer IPC accepts registered ids only', async (t) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'assembler-e2e-'));
  const app = await electron.launch({
    args: [APP_DIR, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ASSEMBLER_FORCE_PRODUCTION: '1' },
    timeout: 60_000,
  });
  t.after(async () => {
    await closeApp(app);
    rmSync(userDataDir, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !document.body.innerText.includes('No items yet'), null, {
    timeout: 60_000,
  });

  await page.mouse.move(900, 500);
  await page.keyboard.press('p');
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('[role="region"][aria-label="Printability"]');
      return panel?.textContent?.includes('Up to date') ?? false;
    },
    null,
    { timeout: 60_000 },
  );
  const summary = await page.evaluate(
    () => document.querySelector('[role="region"][aria-label="Printability"]')?.textContent ?? '',
  );
  assert.match(summary, /1 body/);
  assert.match(summary, /Findings/);
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOTS_DIR, 'pr-electron-production.png') });

  const listed = await page.evaluate(() => window.assembler!.slicers.list());
  assert.equal(listed.platform, process.platform);
  assert.ok(Array.isArray(listed.slicers));
  for (const slicer of listed.slicers) {
    assert.equal(slicer.source, 'detected');
    assert.match(slicer.path, /\.exe$/i);
  }
  // Report what this host has (the test must not depend on it).
  t.diagnostic(`detected slicers: ${JSON.stringify(listed.slicers.map((s) => [s.name, s.path]))}`);

  // Unknown ids and paths are refused; nothing is started.
  const bytes = new Uint8Array([80, 75, 3, 4]);
  const byPath = await page.evaluate(
    (data) =>
      window.assembler!.slicers.open('C:\\Windows\\System32\\cmd.exe', new Uint8Array(data), 'x'),
    [...bytes],
  );
  assert.deepEqual(byPath, { ok: false, error: 'This slicer is no longer registered.' });
  const empty = await page.evaluate(() =>
    window.assembler!.slicers.open('detected:bambu', new Uint8Array(0), 'x'),
  );
  assert.equal(empty.ok, false);
});
