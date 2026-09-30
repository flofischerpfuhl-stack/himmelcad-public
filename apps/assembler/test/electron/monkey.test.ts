/**
 * UI robustness smoke ("monkey"), `assembler/ROBUSTNESS.md`: seeded random
 * clicks, drags, wheel turns and keys against the production app for a
 * bounded time (`ASSEMBLER_MONKEY_MINUTES`, default 5; seed
 * `ASSEMBLER_MONKEY_SEED`, default 1). Monitored throughout: uncaught
 * renderer errors (`pageerror`), renderer crashes, the kernel status.
 * Every 40 actions an Escape ladder (up to 6 x Esc) must return the app to
 * idle: no tool session, no sketch mode, no open dialog, menu or popover.
 *
 * Native dialogs are stubbed to "cancel", slicer hand-off is stubbed, and
 * keys that reload, quit or open DevTools are not pressed (they end the
 * session by design, not by a bug). Run: `pnpm test:monkey` (after `pnpm build`).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _electron as electron, type Page } from 'playwright-core';

import { closeApp } from './closeApp.js';
import { dismissHome } from './home.js';

const APP_DIR = process.cwd();
const MINUTES = Number(process.env.ASSEMBLER_MONKEY_MINUTES ?? 5);
const SEED = Number(process.env.ASSEMBLER_MONKEY_SEED ?? 1);
const OUT_DIR = process.env.ASSEMBLER_MONKEY_OUT ?? join(tmpdir(), 'assembler-monkey');

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
const KEYS = [
  'Escape',
  'Escape',
  'Enter',
  'Delete',
  'Backspace',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'Shift+?',
  'Control+z',
  'Control+y',
  'Control+Shift+z',
  'Control+a',
  'Control+c',
  'Control+v',
  'Control+d',
  'Control+f',
  'Control+o',
  'Control+s',
  'Control+Shift+s',
  'Control+n',
  'Control+e',
  'Control+Alt+s',
  'Control+Alt+h',
  'Control+Alt+p',
  'Alt+1',
  'Alt+2',
  'Alt+3',
  'Alt+4',
  'Alt+5',
  'Alt+6',
  'Alt+7',
  'F2',
];

/** Visible, enabled controls the monkey may click (never window/app lifecycle controls). */
async function controls(page: Page): Promise<{ x: number; y: number; label: string }[]> {
  return page.evaluate(() => {
    const deny = /quit|exit|close window|reload|devtools/i;
    const out: { x: number; y: number; label: string }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      'button, [role="button"], [role="menuitem"], [role="tab"], [role="option"], input, select, textarea, [role="switch"], [role="checkbox"], li[tabindex]',
    )) {
      const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 60);
      if (deny.test(label)) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      if (el.closest('a[href^="http"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0) continue;
      if (r.top > innerHeight || r.left > innerWidth) continue;
      out.push({
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        label: `${el.tagName}:${label}`,
      });
    }
    return out;
  });
}

/** Everything that is not "idle" after the Escape ladder. */
async function busyState(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const busy: string[] = [];
    if (document.querySelector('[aria-label="Cancel tool"]')) busy.push('tool session');
    if (document.querySelector('[data-sketch-status]')) busy.push('sketch mode');
    for (const el of document.querySelectorAll(
      '[role="dialog"], [role="menu"], [role="listbox"], dialog[open], [aria-modal="true"]',
    )) {
      if (visible(el)) {
        busy.push(
          `${el.getAttribute('role') ?? el.tagName}: ${el.getAttribute('aria-label') ?? (el.textContent ?? '').slice(0, 60)}`,
        );
      }
    }
    return busy;
  });
}

void test(`monkey: ${MINUTES} min of random input keeps the production app error-free and Esc returns to idle`, async (t) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'assembler-monkey-'));
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
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}\n${error.stack ?? ''}`));
  page.on('crash', () => errors.push('renderer crashed'));
  let closed = false;
  app.on('close', () => (closed = true));
  await page.waitForLoadState('domcontentloaded');
  // Native dialogs answer "cancel"; the slicer hand-off never starts a program.
  await app.evaluate(({ dialog, ipcMain }) => {
    dialog.showOpenDialog = (async () => ({
      canceled: true,
      filePaths: [],
    })) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async () => ({
      canceled: true,
      filePath: '',
    })) as typeof dialog.showSaveDialog;
    dialog.showMessageBox = (async () => ({
      response: 0,
      checkboxChecked: false,
    })) as typeof dialog.showMessageBox;
    ipcMain.removeHandler('assembler:slicers:open');
    ipcMain.handle('assembler:slicers:open', () => ({
      ok: false,
      error: 'Disabled in the monkey test.',
    }));
  });
  await page.waitForFunction(() => !document.body.innerText.includes('Loading CAD kernel'), {
    timeout: 60_000,
  });
  await dismissHome(page);

  const next = rng(SEED);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const log: string[] = [];
  const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const deadline = Date.now() + MINUTES * 60_000;
  let actions = 0;
  let ladders = 0;
  const stuck: string[] = [];
  const failures = (): string[] => [...errors, ...stuck, ...(closed ? ['the app closed'] : [])];

  while (Date.now() < deadline && failures().length === 0) {
    const roll = next();
    try {
      if (roll < 0.3) {
        const x = Math.floor(next() * size.w);
        const y = Math.floor(next() * size.h);
        log.push(`click ${x},${y}`);
        await page.mouse.click(x, y, { button: next() < 0.1 ? 'right' : 'left' });
      } else if (roll < 0.55) {
        const list = await controls(page);
        if (list.length > 0) {
          const c = pick(list);
          log.push(`control ${c.label}`);
          await page.mouse.click(c.x, c.y);
        }
      } else if (roll < 0.8) {
        const key = next() < 0.35 ? pick(LETTERS) : pick(KEYS);
        log.push(`key ${key}`);
        await page.keyboard.press(key);
      } else if (roll < 0.9) {
        const x = Math.floor(next() * size.w);
        const y = Math.floor(next() * size.h);
        const dx = Math.floor((next() - 0.5) * 300);
        const dy = Math.floor((next() - 0.5) * 300);
        log.push(`drag ${x},${y} +${dx},${dy}`);
        await page.mouse.move(x, y);
        await page.mouse.down({ button: next() < 0.2 ? 'middle' : 'left' });
        await page.mouse.move(x + dx, y + dy, { steps: 4 });
        await page.mouse.up({ button: 'left' }).catch(() => undefined);
        await page.mouse.up({ button: 'middle' }).catch(() => undefined);
      } else if (roll < 0.95) {
        log.push('wheel');
        await page.mouse.move(Math.floor(next() * size.w), Math.floor(next() * size.h));
        await page.mouse.wheel(0, Math.floor((next() - 0.5) * 800));
      } else {
        const text =
          next() < 0.5
            ? String(Math.floor(next() * 200) - 50)
            : pick(['abc', '1/0', '1e999', 'NaN', '-', '2*3', 'wall']);
        log.push(`type ${text}`);
        await page.keyboard.type(text);
      }
    } catch (error) {
      if (closed) break;
      // A control that disappeared between listing and clicking is not a finding.
      log.push(
        `(action failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`,
      );
    }
    actions += 1;
    await page.waitForTimeout(20 + Math.floor(next() * 60));
    if (actions % 40 === 0 && !closed) {
      ladders += 1;
      let busy: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        busy = await busyState(page);
        if (busy.length === 0) break;
      }
      if (busy.length > 0) {
        stuck.push(`not idle after 6 x Esc (action ${actions}): ${busy.join('; ')}`);
      }
      const kernel = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll('[role="status"], [role="alert"]'))
            .map((el) => el.textContent ?? '')
            .find((text) => /kernel (failed|keeps crashing)/i.test(text)) ?? null,
      );
      if (kernel) stuck.push(`kernel: ${kernel}`);
    }
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    seed: SEED,
    minutes: MINUTES,
    actions,
    escapeLadders: ladders,
    failures: failures(),
    lastActions: log.slice(-60),
  };
  writeFileSync(
    join(OUT_DIR, `monkey-seed${SEED}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  t.diagnostic(
    `monkey: ${actions} actions, ${ladders} Escape ladders, report ${join(OUT_DIR, `monkey-seed${SEED}.json`)}`,
  );
  if (!closed)
    await page.screenshot({ path: join(OUT_DIR, `monkey-seed${SEED}.png`) }).catch(() => undefined);
  assert.deepEqual(
    failures(),
    [],
    `failures after ${actions} actions; last: ${log.slice(-15).join(' | ')}`,
  );
});
