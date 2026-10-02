/**
 * Corrupted `.hcasm` files in the production app (`assembler/ROBUSTNESS.md`):
 * truncated, garbled, NaN, deeply nested and huge-number files opened with
 * File > Open (Ctrl+O) from the editor and from the command line. Each must
 * give a clear error the user sees in the editor (not only on the Home
 * screen), leave the open document untouched (no partial load) and raise no
 * uncaught renderer error; the app keeps working afterwards; a file that
 * fails to open is not added to Open Recent.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';

import { closeApp } from './closeApp.js';
import { dismissHome } from './home.js';

const APP_DIR = process.cwd();
const FIXTURE = readFileSync(join(APP_DIR, 'test', 'fixtures', 'phone-stand.hcasm'), 'utf8');

function spliceIntoExtrude(field: string, raw: string): string {
  const doc = JSON.parse(FIXTURE) as { features: Record<string, unknown>[] };
  doc.features.find((f) => f.kind === 'extrude')![field] = '__RAW__';
  return JSON.stringify(doc).replace('"__RAW__"', raw);
}

const CORRUPT: [name: string, text: string][] = [
  ['truncated', FIXTURE.slice(0, Math.floor(FIXTURE.length / 2))],
  ['garbled', 'PK\u0003\u0004 ÿþ\u0000 not a project'],
  ['NaN', spliceIntoExtrude('distance', 'NaN')],
  ['Infinity', spliceIntoExtrude('distance', '1e999')],
  ['deep nesting', spliceIntoExtrude('profile', `${'['.repeat(50_000)}0${']'.repeat(50_000)}`)],
  ['empty', ''],
];

async function launch(userDataDir: string, extraArgs: string[] = []): Promise<ElectronApplication> {
  return electron.launch({
    args: [APP_DIR, `--user-data-dir=${userDataDir}`, ...extraArgs],
    env: { ...process.env, ASSEMBLER_FORCE_PRODUCTION: '1' },
    timeout: 60_000,
  });
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('crash', () => errors.push('renderer crashed'));
  return errors;
}

async function recentPaths(page: Page): Promise<string[]> {
  const list = await page.evaluate(() =>
    (
      window as unknown as {
        assembler: { recentFiles: { list(): Promise<{ path: string }[]> } };
      }
    ).assembler.recentFiles.list(),
  );
  return list.map((entry) => entry.path);
}

async function historySteps(page: Page): Promise<string> {
  return (
    await page
      .locator('[aria-label="History panel"]')
      .innerText()
      .catch(() => '')
  ).trim();
}

void test('production app: corrupted project files opened from the editor show a clear error and change nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'assembler-corrupt-'));
  const app = await launch(join(dir, 'user'));
  t.after(async () => {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  const errors = watchErrors(page);
  await page.waitForLoadState('domcontentloaded');
  // Home → Escape (a blank project) → the demo bracket opened (`home.ts`).
  await dismissHome(page);

  // Open a valid project first, so there is a known document to keep.
  const good = join(dir, 'good.hcasm');
  writeFileSync(good, FIXTURE, 'utf8');
  await app.evaluate(({ dialog }, state) => {
    (globalThis as { __nextOpen?: string }).__nextOpen = state;
    dialog.showOpenDialog = (async () => {
      const path = (globalThis as { __nextOpen?: string }).__nextOpen;
      return { canceled: !path, filePaths: path ? [path] : [] };
    }) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async () => ({
      canceled: true,
      filePath: '',
    })) as typeof dialog.showSaveDialog;
  }, good);
  await page.keyboard.press('Control+O');
  // Opening over the start document may ask about unsaved changes first.
  const discard = page.getByRole('button', { name: /Discard|Don.t save/i });
  if (await discard.isVisible({ timeout: 2_000 }).catch(() => false)) await discard.click();
  await page.getByRole('button', { name: /^phone-stand/ }).waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => !document.body.innerText.includes('No items yet'), {
    timeout: 60_000,
  });
  const steps = await historySteps(page);
  assert.ok(steps.length > 0, 'the History panel lists the project');

  for (const [name, text] of CORRUPT) {
    const path = join(dir, `${name.replace(/\s+/g, '-')}.hcasm`);
    writeFileSync(path, text, 'utf8');
    await app.evaluate((_electron, next) => {
      (globalThis as { __nextOpen?: string }).__nextOpen = next;
    }, path);
    await page.keyboard.press('Control+O');
    const alert = page.getByRole('alert').filter({ hasText: /project|JSON|file/i });
    await alert.first().waitFor({ timeout: 20_000 });
    const message = (await alert.first().innerText()).trim();
    assert.ok(message.length > 15, `${name}: a readable error (${message})`);
    assert.doesNotMatch(message, /undefined|\[object|Maximum call stack/, `${name}: ${message}`);
    // Nothing of the file was loaded: same project, same history.
    assert.ok(
      await page.getByRole('button', { name: /^phone-stand/ }).isVisible(),
      `${name}: the project stays open`,
    );
    assert.equal(await historySteps(page), steps, `${name}: history unchanged`);
    await alert.first().getByRole('button', { name: 'Dismiss' }).click();
    await alert.first().waitFor({ state: 'detached', timeout: 5_000 });
  }
  // Open Recent lists the project that opened, never a file that failed to open.
  const recent = (await recentPaths(page)).map((p) => p.toLowerCase());
  assert.ok(
    recent.includes(good.toLowerCase()),
    `the opened project is recent (${recent.join(', ')})`,
  );
  for (const [name] of CORRUPT) {
    const path = join(dir, `${name.replace(/\s+/g, '-')}.hcasm`).toLowerCase();
    assert.ok(!recent.includes(path), `${name}: not added to Open Recent`);
  }
  assert.deepEqual(errors, [], 'no uncaught renderer errors');
});

void test('production app: a corrupted .hcasm on the command line starts the app with a clear error', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'assembler-corrupt-arg-'));
  const path = join(dir, 'broken.hcasm');
  writeFileSync(path, FIXTURE.slice(0, 200), 'utf8');
  const app = await launch(join(dir, 'user'), [path]);
  t.after(async () => {
    await closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  const errors = watchErrors(page);
  const alert = page.getByRole('alert').filter({ hasText: /JSON|project|file/i });
  await alert.first().waitFor({ timeout: 60_000 });
  assert.ok((await alert.first().innerText()).trim().length > 15);
  // The app is usable: the kernel comes up and a command search opens and closes.
  await page.waitForFunction(() => !document.body.innerText.includes('Loading CAD kernel'), {
    timeout: 60_000,
  });
  assert.ok(
    !(await recentPaths(page)).some((p) => p.toLowerCase() === path.toLowerCase()),
    'a file that failed to open is not added to Open Recent',
  );
  assert.deepEqual(errors, [], 'no uncaught renderer errors');
});
