/**
 * PLAN §7 interactive acceptance in the real production app (`pnpm
 * test:acceptance` builds first): Home screen → template, agent ↔ UI
 * hand-over over the loopback agent endpoint and the History panel, hidden
 * geometry picked with Select Through, the kernel worker killed in the
 * middle of an edit, Save with a Home thumbnail, and the app killed mid
 * session and recovered from the Home screen. Geometry is checked through
 * the agent API (numbers), the interaction through the DOM a user sees.
 * Screenshots: `ASSEMBLER_SHOTS_DIR` (default `D:\AgentWork\HimmelCAD-Assembler\shots`).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';

import { closeApp } from '../electron/closeApp.js';
import { roundedRectArea } from './geometry.js';

const APP_DIR = process.cwd();
const SHOTS_DIR =
  process.env.ASSEMBLER_SHOTS_DIR ?? join('D:', 'AgentWork', 'HimmelCAD-Assembler', 'shots');

type Json = Record<string, unknown>;
interface Status {
  enabled: boolean;
  url: string | null;
  token: string | null;
}

async function launch(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [APP_DIR, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ASSEMBLER_FORCE_PRODUCTION: '1' },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // The kernel is ready once the status strip no longer says it is loading.
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('[role="status"]')).some((el) =>
        /loading cad kernel/i.test(el.textContent ?? ''),
      ),
    null,
    { timeout: 90_000 },
  );
  return { app, page };
}

/** Turns Agent Access on the way a user does (command search) and returns an RPC caller. */
async function agentAccess(page: Page): Promise<(method: string, params?: Json) => Promise<Json>> {
  await page.keyboard.press('Control+f');
  const search = page.getByPlaceholder('Search commands…');
  await search.fill('agent access');
  await page
    .getByRole('option', { name: /Agent Access/ })
    .first()
    .waitFor();
  await search.press('Enter');
  try {
    await page.getByText('Agent access on').waitFor({ timeout: 15_000 });
  } catch (error) {
    await page.screenshot({ path: join(SHOTS_DIR, 'h-electron-debug-agent-access.png') });
    throw error;
  }
  const status = await page.evaluate(() =>
    (
      globalThis as unknown as { assembler: { automation: { status(): Promise<Status> } } }
    ).assembler.automation.status(),
  );
  return async (method, params = {}) => {
    const response = await fetch(status.url!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${status.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: Json; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as Json;
  };
}

const bodiesOf = async (rpc: (m: string, p?: Json) => Promise<Json>) =>
  (await rpc('bodies.list')) as unknown as { name: string; volume: number; valid: boolean }[];

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string) {
  let value = await read();
  for (let i = 0; i < 120 && !ok(value); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  assert.ok(ok(value), `${what}: ${JSON.stringify(value)}`);
  return value;
}

const near = (a: number, b: number, rel = 1e-6) => Math.abs(a - b) <= Math.abs(b) * rel;

void test('E1–E5 in the production app: Home → template, hand-over, Select Through, kernel crash mid-edit, save thumbnail, app killed → recovered', async (t) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'assembler-acceptance-'));
  mkdirSync(SHOTS_DIR, { recursive: true });
  let { app, page } = await launch(userDataDir);
  t.after(async () => {
    await closeApp(app);
    rmSync(userDataDir, { recursive: true, force: true });
  });
  const evidence: Json = {};

  // ---- E1 Home screen on launch → "Enclosure with lid" template --------------------------
  const home = page.locator('[data-home-screen]');
  await home.waitFor({ timeout: 30_000 });
  await page.getByRole('heading', { name: 'Getting started' }).waitFor();
  await page.getByRole('button', { name: /^Enclosure with lid/ }).click();
  await home.waitFor({ state: 'detached', timeout: 90_000 });
  await page
    .locator('[aria-label="History panel"]')
    .getByText('Appearance 2', { exact: true })
    .waitFor({ timeout: 60_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS_DIR, 'h-electron-template.png') });

  const rpc = await agentAccess(page);
  const template = await bodiesOf(rpc);
  const enclosureVolume =
    roundedRectArea(80, 60, 4) * 30 -
    roundedRectArea(76, 56, 2) * 28 +
    4 * Math.PI * 3.5 ** 2 * 24 -
    4 * Math.PI * 1.25 ** 2 * 20;
  assert.deepEqual(
    template.map((b) => [b.name, b.valid]),
    [
      ['Enclosure', true],
      ['Lid', true],
    ],
  );
  assert.ok(near(template[0]!.volume, enclosureVolume), `enclosure ${template[0]!.volume}`);
  const doc0 = await rpc('document.get');
  assert.equal(doc0.canUndo, false, 'the template is a clean starting point');
  evidence.E1 = { bodies: template, features: doc0.featureCount };

  // ---- E2 hand-over: the agent creates, the UI edits a dimension, the agent reads ---------
  await rpc('project.new', { name: 'Hand-over' });
  const sketch = await rpc('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 40, height: 30 }],
    },
  });
  const width = (sketch.shapes as { dimensions: { width: string } }[])[0]!.dimensions.width;
  const extrude = await rpc('feature.create', {
    kind: 'extrude',
    params: {
      profile: { kind: 'sketch', featureId: sketch.featureId },
      distance: 10,
      resultBodyName: 'Plate',
    },
  });
  const bodyId = `body:${String(extrude.featureId)}`;
  const history = page.locator('[aria-label="History panel"]');
  await history.getByText('Sketch 1', { exact: true }).click();
  const widthField = page.getByLabel(new RegExp(`^${width} · `));
  await widthField.fill('60');
  await widthField.press('Enter');
  const handedOver = await waitFor(
    async () => (await rpc('body.get', { bodyId })) as { volume: number },
    (b) => near(b.volume, 60 * 30 * 10),
    'the agent reads the UI edit',
  );
  evidence.E2 = { uiEdit: `${width}: 40 → 60`, agentVolume: handedOver.volume };

  // ---- E3 Select Through: a face behind the visible one, picked in the viewport -----------
  // Frame the plate: select it (agent selection.set), Zoom to selection (Z), deselect.
  await rpc('selection.set', { items: [{ kind: 'body', bodyId }] });
  await page
    .locator('canvas')
    .first()
    .hover({ position: { x: 5, y: 5 } });
  await page.keyboard.press('z');
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+S');
  await page.getByText('Select Through').first().waitFor();
  const centre = await page.evaluate(() => {
    const r = document.querySelector('canvas')!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(centre.x, centre.y);
  const popup = page.getByRole('menu', { name: 'Overlapping items' });
  await popup.waitFor({ timeout: 10_000 });
  const rows = await popup.getByRole('menuitem').allInnerTexts();
  const behind = popup.getByRole('menuitem').filter({ hasText: 'behind' }).first();
  await page.screenshot({ path: join(SHOTS_DIR, 'h-electron-select-through.png') });
  await behind.click();
  const selection = (await rpc('selection.get')) as unknown as { kind: string; faceKey?: string }[];
  const top = (await rpc('faces.list', { bodyId, select: '>Z' })) as unknown as { key: string }[];
  assert.equal(selection.length, 1);
  assert.equal(selection[0]!.kind, 'face');
  assert.notEqual(selection[0]!.faceKey, top[0]!.key, 'not the visible top face');
  await page.keyboard.press('Control+Shift+S');
  await page.keyboard.press('Escape');
  evidence.E3 = { candidates: rows, selected: selection[0]!.faceKey };

  // ---- E4 the kernel worker dies in the middle of an edit --------------------------------
  const kernelWorker = page.workers().find((w) => /kernel\.worker/.test(w.url()));
  assert.ok(
    kernelWorker,
    `kernel worker among ${page
      .workers()
      .map((w) => w.url())
      .join(', ')}`,
  );
  await widthField.fill('70');
  await widthField.press('Enter');
  await kernelWorker.evaluate(() => {
    setTimeout(() => {
      throw new Error('acceptance: kernel worker killed mid-edit');
    }, 0);
  });
  const recovered = await waitFor(
    async () => ({
      doc: (await rpc('document.get')) as { kernel: { status: string } },
      body: (await rpc('body.get', { bodyId })) as { volume: number; valid: boolean },
    }),
    (s) => s.doc.kernel.status === 'ready' && near(s.body.volume, 70 * 30 * 10) && s.body.valid,
    'the restarted kernel evaluates the edit',
  );
  assert.ok(
    page.workers().every((w) => w !== kernelWorker),
    'a fresh kernel worker replaced the dead one',
  );
  evidence.E4 = { volumeAfterRestart: recovered.body.volume, kernel: recovered.doc.kernel };

  // ---- E5a Save (with a Home thumbnail) → Home lists it ------------------------------------
  const projectPath = join(userDataDir, 'hand-over.hcasm');
  await app.evaluate(async ({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath,
    })) as typeof dialog.showSaveDialog;
  }, projectPath);
  await page.keyboard.press('Control+s');
  await waitFor(
    async () => existsSync(projectPath),
    (ok) => ok,
    'saved',
  );
  const savedFile = JSON.parse(readFileSync(projectPath, 'utf8')) as { thumbnail?: string };
  assert.match(savedFile.thumbnail ?? '', /^data:image\/png;base64,/, 'a thumbnail is saved');
  await page.keyboard.press('Control+Shift+H');
  await home.waitFor();
  const thumb = home.locator('img[src^="data:image/png;base64,"]');
  await thumb.first().waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(SHOTS_DIR, 'h-electron-home-recent.png') });
  await page.keyboard.press('Escape');
  await home.waitFor({ state: 'detached' });

  // ---- E5b unsaved edit, then the app is killed; the next start offers recovery -----------
  await widthField.fill('80');
  await widthField.press('Enter');
  await waitFor(
    async () => (await rpc('body.get', { bodyId })) as { volume: number },
    (b) => near(b.volume, 80 * 30 * 10),
    'the unsaved edit',
  );
  const recoveryFile = join(userDataDir, 'assembler-recovery.json');
  await waitFor(
    async () =>
      existsSync(recoveryFile) &&
      (JSON.parse(readFileSync(recoveryFile, 'utf8')) as { text: string }).text.includes(
        '"value": 80',
      ),
    (ok) => ok,
    'the autosave copy with the edit',
  );
  // Kill the app hard: the Electron main process and its whole process tree (renderer, GPU,
  // kernel worker host) — like "End task" or a crash; nothing gets to save or clean up.
  // (`app.process()` is the launcher Playwright started, not necessarily the app's main.)
  const mainPid = await app.evaluate(() => process.pid);
  execFileSync('taskkill', ['/PID', String(mainPid), '/T', '/F'], { stdio: 'ignore' });
  // The single-instance lock is released once the tree is gone; retry the launch until then.
  for (let attempt = 1; ; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      ({ app, page } = await launch(userDataDir));
      break;
    } catch (error) {
      if (attempt >= 5) throw error;
    }
  }
  const home2 = page.locator('[data-home-screen]');
  await home2.waitFor({ timeout: 30_000 });
  await page.getByRole('heading', { name: 'Recover unsaved work?' }).waitFor({ timeout: 20_000 });
  await page.screenshot({ path: join(SHOTS_DIR, 'h-electron-recovery.png') });
  await page.getByRole('button', { name: 'Recover' }).click();
  await home2.waitFor({ state: 'detached' });
  const rpc2 = await agentAccess(page);
  const restored = await waitFor(
    async () => (await bodiesOf(rpc2)).map((b) => ({ ...b })),
    (b) => b.length === 1 && near(b[0]!.volume, 80 * 30 * 10) && b[0]!.valid,
    'the recovered document',
  );
  const doc2 = await rpc2('document.get');
  assert.equal(doc2.featureCount, 2);
  assert.equal(doc2.projectName, 'Hand-over');
  evidence.E5 = {
    savedThumbnailChars: savedFile.thumbnail!.length,
    recoveredVolume: restored[0]!.volume,
    recoveredFeatures: doc2.featureCount,
  };
  t.diagnostic(`electron acceptance: ${JSON.stringify(evidence)}`);
});
