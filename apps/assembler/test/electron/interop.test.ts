/**
 * Import/export in the packaged app (production build, `app://` protocol and
 * its CSP): files dropped on the window go through the import worker (3MF,
 * OBJ, DXF) and the kernel worker (STEP, Mesh to Solid) exactly as for a
 * user — no dev hook. Needs a prior `pnpm build` (see `pnpm test:electron`).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _electron as electron, type Page } from 'playwright-core';

import { closeApp } from './closeApp.js';
import { dismissHome } from './home.js';

const APP_DIR = process.cwd();
const FIXTURES = join(APP_DIR, 'test', 'fixtures', 'interop');
const SHOTS_DIR =
  process.env.ASSEMBLER_SHOTS_DIR ?? join('D:', 'AgentWork', 'HimmelCAD-Assembler', 'shots');

/** Drops files on the window the way the OS does (a DataTransfer with File objects). */
async function dropFiles(page: Page, names: string[]): Promise<void> {
  const files = names.map((name) => ({
    name,
    b64: readFileSync(join(FIXTURES, name)).toString('base64'),
  }));
  await page.evaluate((list) => {
    const dt = new DataTransfer();
    for (const f of list) {
      const bin = atob(f.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name));
    }
    for (const type of ['dragenter', 'dragover', 'drop']) {
      window.dispatchEvent(
        new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    }
  }, files);
}

async function kernelReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const status = Array.from(document.querySelectorAll('[role="status"]')).find((el) =>
        /kernel/i.test(el.textContent ?? ''),
      );
      return !status || !/loading/i.test(status.textContent ?? '');
    },
    { timeout: 60_000 },
  );
}

void test('packaged app: STEP assembly, 3MF, DXF and Mesh to Solid by drag & drop', async (t) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'assembler-interop-'));
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
  await kernelReady(page);
  const items = page.getByLabel('Items panel');
  const history = page.getByLabel('History panel');

  // STEP assembly → one History step, nested Items folders with the part names.
  await dropFiles(page, ['robot-assembly.step']);
  await items.getByText('Arm (2)', { exact: true }).waitFor({ timeout: 60_000 });
  for (const name of ['Robot', 'Arm', 'Base plate', 'Link', 'Pin']) {
    assert.ok(
      await items.getByText(name, { exact: true }).first().isVisible(),
      `Items shows ${name}`,
    );
  }
  assert.ok(await history.getByText('Import 1', { exact: true }).isVisible());
  await page.screenshot({ path: join(SHOTS_DIR, 'io-electron-step.png') });

  // 3MF through the import worker (runs under the packaged CSP).
  await dropFiles(page, ['parts.3mf']);
  await items.getByText('Wedge', { exact: true }).waitFor({ timeout: 30_000 });
  assert.ok(
    await items.getByText('parts', { exact: true }).isVisible(),
    '3MF objects are filed in a folder',
  );

  // DXF → placement dialog → one sketch step.
  await dropFiles(page, ['plate.dxf']);
  await page.getByRole('button', { name: 'Import as sketch' }).click();
  await history.getByText('Sketch 1', { exact: true }).waitFor({ timeout: 30_000 });
  const report = page.getByRole('button', { name: 'OK' });
  if (await report.isVisible().catch(() => false)) await report.click();

  // STL → reference mesh → Mesh to Solid from the adaptive toolbar.
  await dropFiles(page, ['l-bracket.stl']);
  await items.getByText('l-bracket', { exact: true }).first().waitFor({ timeout: 30_000 });
  await page
    .getByRole('button', { name: /Convert Mesh to Solid/ })
    .first()
    .click();
  await history.getByText('Mesh to Solid 1', { exact: true }).waitFor({ timeout: 60_000 });
  await page.screenshot({ path: join(SHOTS_DIR, 'io-electron-mesh-solid.png') });
  assert.deepEqual(errors, []);
});
