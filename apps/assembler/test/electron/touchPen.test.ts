/**
 * Touch and pen in the built app (assembler/TOUCH.md), without hardware:
 * Chromium's touch emulation (CDP `Emulation.setTouchEmulationEnabled`)
 * turns the window into a coarse-pointer device, fingers are CDP
 * `Input.dispatchTouchEvent`, the pen is `Input.dispatchMouseEvent` with
 * `pointerType: 'pen'`. Checks the automatic tablet layout, pen strokes
 * becoming constrained sketch geometry, the number keypad on a tool value,
 * the undo/redo finger taps, the long-press context menu and the
 * left-handed layout. Real devices (iPad, Windows pen tablets) are not
 * covered by this test.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { _electron as electron, type CDPSession, type Page } from 'playwright-core';
import { closeApp } from './closeApp.js';
import { dismissHome } from './home.js';

const APP_DIR = process.cwd();

type Point = [number, number];

async function touch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  points: Point[],
) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], id) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 0.5 })),
  });
}

async function tap(cdp: CDPSession, points: Point[]): Promise<void> {
  await touch(cdp, 'touchStart', points);
  await new Promise((r) => setTimeout(r, 60));
  await touch(cdp, 'touchEnd', []);
}

async function tapElement(cdp: CDPSession, locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox();
  assert.ok(box, 'the element is on screen');
  await tap(cdp, [[box.x + box.width / 2, box.y + box.height / 2]]);
}

/** A pen stroke through `points` (pressure 0.6); `release: false` keeps the pen down. */
async function pen(cdp: CDPSession, points: Point[]): Promise<void> {
  const [x0, y0] = points[0]!;
  const event = (type: string, x: number, y: number, down: boolean) =>
    cdp.send('Input.dispatchMouseEvent', {
      type: type as 'mouseMoved',
      x,
      y,
      button: 'left',
      buttons: down ? 1 : 0,
      clickCount: 1,
      pointerType: 'pen',
      force: down ? 0.6 : 0,
    });
  await event('mouseMoved', x0, y0, false);
  await event('mousePressed', x0, y0, true);
  for (const [x, y] of points.slice(1)) await event('mouseMoved', x, y, true);
  const [x1, y1] = points[points.length - 1]!;
  await event('mouseReleased', x1, y1, false);
}

/** A hand-drawn rectangle outline (slightly sloppy) through four corners. */
function rectangleStroke([x0, y0]: Point, [x1, y1]: Point): Point[] {
  const corners: Point[] = [
    [x0, y0],
    [x1, y0 + 2],
    [x1 - 1, y1],
    [x0 + 2, y1 - 1],
    [x0, y0 + 3],
  ];
  const out: Point[] = [];
  for (let k = 0; k < 4; k += 1) {
    const a = corners[k]!;
    const b = corners[k + 1]!;
    for (let i = 0; i < 20; i += 1) {
      const t = i / 20;
      out.push([a[0] + (b[0] - a[0]) * t + Math.sin(i) * 0.8, a[1] + (b[1] - a[1]) * t]);
    }
  }
  out.push(corners[4]!);
  return out;
}

async function historySteps(page: Page): Promise<number> {
  const text = (await page.getByLabel('History panel', { exact: true }).textContent()) ?? '';
  const match = /(\d+)\s+steps?/.exec(text);
  return match ? Number(match[1]) : 0;
}

void test('built app: tablet layout, pen sketching, keypad, finger gestures, left-handed', async (t) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'assembler-touch-'));
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
  const cdp = await page.context().newCDPSession(page);

  // A coarse primary pointer: the tablet layout switches on by itself.
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-hc-touch'), null, {
    timeout: 10_000,
  });
  // Hover tips become labels; Undo/Redo sit in the tool column.
  await page.getByRole('button', { name: 'Sketch' }).getByText('Sketch').waitFor();
  assert.ok((await page.getByRole('button', { name: 'Undo' }).count()) >= 2);

  // An empty project, then a new sketch.
  await page.keyboard.press('Control+N');
  await page.waitForTimeout(500);
  const before = await historySteps(page);
  await page.keyboard.press('Control+F');
  await page.keyboard.type('New Sketch');
  await page.keyboard.press('Enter');
  await page.screenshot({
    path: 'D:/AgentWork/HimmelCAD-Assembler/shots/block8-touch/e2e-debug.png',
  });
  const freedom = page.getByText(/Empty sketch|degrees? of freedom/).first();
  await freedom.waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800); // the camera turns to the sketch plane

  // A pen stroke: a rectangle with horizontal/vertical constraints (4 degrees of freedom).
  const host = (await page
    .getByRole('application', { name: '3D modeling viewport' })
    .boundingBox())!;
  const cx = host.x + host.width / 2;
  const cy = host.y + host.height / 2;
  await pen(cdp, rectangleStroke([cx - 160, cy - 60], [cx + 40, cy + 60]));
  await page.getByText('4 degrees of freedom').waitFor({ timeout: 15_000 });

  // A pen tap starts a line; the length chip opens the number keypad; 2, 0, Apply.
  await pen(cdp, [[cx + 120, cy + 100]]);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: cx + 200,
    y: cy + 100,
    pointerType: 'pen',
  });
  const chip = page.getByRole('button', { name: /click to type a value/ }).first();
  await chip.waitFor({ timeout: 10_000 });
  await tapElement(cdp, chip);
  const keypad = page.getByRole('group', { name: 'Number keypad' });
  await keypad.waitFor({ timeout: 10_000 });
  await tapElement(cdp, keypad.getByRole('button', { name: '2', exact: true }));
  await tapElement(cdp, keypad.getByRole('button', { name: '0', exact: true }));
  assert.equal((await keypad.locator('output').textContent())?.trim(), '20');
  await tapElement(cdp, keypad.getByRole('button', { name: 'Apply' }));
  await keypad.waitFor({ state: 'detached', timeout: 10_000 });
  // The 20 mm line was added (its length a dimension): more degrees of freedom than the rectangle's.
  await page.waitForFunction(
    () => {
      const m = /(\d+) degrees of freedom/.exec(document.body.textContent ?? '');
      return m !== null && Number(m[1]) > 4;
    },
    null,
    { timeout: 15_000 },
  );

  // Finish the sketch with a finger: one History step.
  await page.keyboard.press('Escape');
  await tapElement(cdp, page.getByRole('button', { name: 'Finish' }));
  await page.waitForFunction(
    (n) =>
      /(\d+)\s+steps?/.exec(
        document.querySelector('[aria-label="History panel"]')?.textContent ?? '',
      )?.[1] === String(n),
    before + 1,
    { timeout: 15_000 },
  );

  // Two-finger tap = Undo, three-finger tap = Redo (on empty canvas).
  const spot: Point = [host.x + host.width / 2, host.y + 90];
  await tap(cdp, [spot, [spot[0] + 70, spot[1]]]);
  await page.waitForTimeout(400);
  assert.equal(await historySteps(page), before, 'two-finger tap undid the sketch');
  await tap(cdp, [spot, [spot[0] + 60, spot[1]], [spot[0] + 120, spot[1]]]);
  await page.waitForTimeout(400);
  assert.equal(await historySteps(page), before + 1, 'three-finger tap redid it');

  // Long press: the context menu.
  await touch(cdp, 'touchStart', [spot]);
  await page.waitForTimeout(700);
  await touch(cdp, 'touchEnd', []);
  await page.getByRole('menu').first().waitFor({ timeout: 5_000 });
  await page.keyboard.press('Escape');

  // Left-handed: the tool column moves to the right edge.
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.waitFor();
  await settings.getByRole('button', { name: 'Tool side' }).click();
  await page.getByRole('option', { name: 'Right (left-handed)' }).click();
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-hc-hand') === 'left',
  );
  await settings.getByRole('button', { name: 'Done' }).click();
  const search = await page.getByRole('button', { name: 'Open command search' }).boundingBox();
  assert.ok(search && search.x > host.x + host.width / 2, 'tools on the right');

  assert.deepEqual(errors, []);
});
