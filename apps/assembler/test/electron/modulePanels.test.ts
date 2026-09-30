/**
 * Module panels in the built app (assembler/MODULES.md §3): the Parameters
 * panel is registered by the parameters module (`module.ui.ts`) and hosted
 * by the shell's right stack above History, toggled like before
 * (Ctrl+Alt+P); adding a parameter goes through the module's store slice.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { _electron as electron } from 'playwright-core';
import { closeApp } from './closeApp.js';
import { dismissHome } from './home.js';

const APP_DIR = process.cwd();

void test('built app: the Parameters panel comes from the parameters module', async (t) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'assembler-panels-'));
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
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForLoadState('domcontentloaded');
  await dismissHome(page);

  const parameters = page.getByLabel('Parameters panel', { exact: true });
  const history = page.getByLabel('History panel', { exact: true });
  await history.waitFor();
  assert.equal(await parameters.count(), 0, 'hidden by default');

  await page.keyboard.press('Control+Alt+P');
  await parameters.waitFor();
  const [above, below] = await Promise.all([parameters.boundingBox(), history.boundingBox()]);
  assert.ok(above && below && above.y < below.y, 'Parameters stacks above History');

  // Adding a parameter runs the module's store slice (one undo step).
  await parameters.getByRole('button', { name: 'Add parameter' }).first().click();
  await parameters.getByLabel('New parameter name').fill('wall');
  await parameters.getByLabel('New parameter value').fill('3');
  await parameters.getByRole('button', { name: 'Add', exact: true }).click();
  await parameters.getByLabel('Parameter name (wall)').waitFor({ timeout: 30_000 });

  await page.keyboard.press('Control+Alt+P');
  await parameters.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});
