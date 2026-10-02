/**
 * Production-mode smoke test: builds are assumed already produced by
 * `pnpm build` (this file does not build — see `pnpm test:electron`).
 * Launches the packaged Electron app (`dist/electron/main.js`) with
 * `ASSEMBLER_FORCE_PRODUCTION=1` so `main.ts` takes the `app://` protocol +
 * `dist/renderer` code path it would take from a real installer build
 * (`electron/main.ts`'s comment on `ASSEMBLER_FORCE_PRODUCTION`) — the open
 * risk flagged in `assembler/KERNEL-SPIKE.md` ("Packaged Electron is
 * unverified"). Not part of `pnpm test` (needs a prior `pnpm build`, a
 * playwright-core-launchable Electron, and can take tens of seconds for the
 * kernel to load) — run explicitly via `pnpm test:electron`. Deliberately
 * does not rely on the dev-only `window.__assembler` automation hook (it is
 * stripped from production builds by `import.meta.env.DEV`); kernel
 * readiness is read from the real status-strip DOM the user sees.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _electron as electron } from 'playwright-core';

import { closeApp } from './closeApp.js';
import { dismissHome, openDemo } from './home.js';

// Run via `pnpm --filter @himmelcad/assembler test:electron` (cwd =
// `apps/assembler`, where `dist/electron/main.js` and `package.json`'s
// `main` live) — not resolved relative to this compiled test file, which
// lives under `.build/tests/...` and has no `dist/` next to it.
const APP_DIR = process.cwd();
const SHOTS_DIR =
  process.env.ASSEMBLER_SHOTS_DIR ?? join('D:', 'AgentWork', 'HimmelCAD-Assembler', 'shots');

void test('production build: kernel reaches ready, the demo part renders, Save/Reopen round-trips through IPC', async (t) => {
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

  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  // The renderer loaded from `app://assembler/index.html`, not a dev server
  // or `file://` — this is the thing being verified.
  const url = window.url();
  assert.match(url, /^app:\/\/assembler\//, `renderer URL is ${url}`);

  // `electron/main.ts`'s CSP narrowing: the main document's own CSP header
  // must not grant `'unsafe-eval'` (only the kernel Web Worker and the LGPL
  // Emscripten glue chunk it loads get that, via their own response CSP —
  // see `cspFor`/`WORKER_CSP` in `main.ts`). Re-fetch the already-loaded
  // document from inside the page (same `app://` origin, same protocol
  // handler response) instead of racing a `response` event listener against
  // the initial navigation.
  const documentCsp = await window.evaluate(async (href) => {
    const response = await fetch(href);
    return response.headers.get('content-security-policy');
  }, url);
  assert.ok(documentCsp, 'main document response carried a Content-Security-Policy header');
  assert.doesNotMatch(
    documentCsp ?? '',
    /unsafe-eval/,
    `main document CSP must not grant 'unsafe-eval': ${documentCsp}`,
  );

  // `eval`/`new Function` must actually be blocked in the main renderer by
  // that CSP, not just absent from the header text. `page.evaluate()` goes
  // through CDP `Runtime.evaluate`, which Playwright/Chromium deliberately
  // run with `allowUnsafeEvalBlockedByCSP: true` (devtools-console
  // ergonomics) — it would "succeed" even under a strict CSP and prove
  // nothing. `webContents.executeJavaScript` from the main process does not
  // get that bypass, so it actually exercises the page's CSP.
  const evalResult = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no BrowserWindow open in main process');
    try {
      await win.webContents.executeJavaScript("new Function('return 1')()");
      return { threw: false, message: null };
    } catch (error) {
      return { threw: true, message: error instanceof Error ? error.message : String(error) };
    }
  });
  assert.ok(
    evalResult.threw,
    `eval must be blocked by CSP in the main renderer, but new Function() ran: ${JSON.stringify(evalResult)}`,
  );

  // While the kernel loads or on error, `StatusStrip` renders a
  // `role="status"` element whose text starts with the kernel message
  // ("Loading CAD kernel…" / "CAD kernel failed to load: …" / "CAD kernel
  // ready"); once ready (and nothing selected) it renders nothing. Fail
  // loudly on "failed" instead of only timing out, so a CSP/loader
  // regression is diagnosable from the assertion message, not a bare
  // timeout.
  await window.waitForFunction(
    () => {
      const status = Array.from(document.querySelectorAll('[role="status"]')).find((el) =>
        /kernel/i.test(el.textContent ?? ''),
      );
      return !status || !/loading/i.test(status.textContent ?? '');
    },
    { timeout: 45_000 },
  );
  const failedStatus = await window.evaluate(() => {
    const status = Array.from(document.querySelectorAll('[role="status"]')).find((el) =>
      /kernel failed/i.test(el.textContent ?? ''),
    );
    return status?.textContent ?? null;
  });
  assert.equal(failedStatus, null, `kernel failed to load in the packaged app: ${failedStatus}`);

  // The demo bracket is a real B-rep body once the kernel is ready; a
  // WebGL2 canvas is mounted and has drawn to it.
  const canvasCount = await window.evaluate(() => document.querySelectorAll('canvas').length);
  assert.ok(canvasCount > 0, 'the viewport canvas is mounted');

  // Started without a file: the Home screen is up; Escape closes it onto a blank project
  // (Block 9: never the sample), then the demo bracket is opened by dropping it onto the
  // window; `dismissHome` waits until the Items panel lists it.
  await dismissHome(window, { demo: false });
  const blank = await window.evaluate(() => document.body.innerText.includes('No items yet'));
  assert.ok(blank, 'Escape on the Home screen leaves a blank project');
  await openDemo(window);

  mkdirSync(SHOTS_DIR, { recursive: true });
  await window.screenshot({ path: join(SHOTS_DIR, 'f-electron-production-ready.png') });

  // The sketch-solver worker (planeGCS wasm + embind glue) must load under
  // the packaged app:// CSP: draw a circle in sketch mode and wait for the
  // solver's status instead of the "solver not available" problem banner.
  // Clicks: the first may move the new sketch onto the clicked face; a
  // zero-radius click is ignored, so A, A, B always yields one circle.
  const centre = await window.evaluate(() => {
    const r = document.querySelector('canvas')!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await window.keyboard.press('c');
  await window.waitForSelector('[data-sketch-status]');
  await window.waitForTimeout(500);
  for (const p of [centre, centre, { x: centre.x + 40, y: centre.y }]) {
    await window.mouse.click(p.x, p.y);
    await window.waitForTimeout(300);
  }
  await window.waitForFunction(
    () => {
      const text = document.querySelector('[data-sketch-status]')?.textContent ?? '';
      return (
        /degrees of freedom|Fully constrained/.test(text) ||
        !!document.querySelector('[data-sketch-problem]')
      );
    },
    { timeout: 20_000 },
  );
  const sketchProblem = await window.evaluate(
    () => document.querySelector('[data-sketch-problem]')?.textContent ?? null,
  );
  assert.equal(sketchProblem, null, `sketch solver failed in the packaged app: ${sketchProblem}`);
  await window.screenshot({ path: join(SHOTS_DIR, 'f-electron-production-sketch.png') });
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  await window.waitForFunction(() => !document.querySelector('[data-sketch-status]'));

  // Native dialogs cannot be driven headlessly; stub them in the main
  // process (the same `electron.dialog` singleton `fileApi.ts` calls) to
  // return a fixed temp path, then exercise Save and Open exactly as the
  // renderer's File menu would — real IPC, real atomic write + backup
  // rotation, real `app://`-loaded renderer.
  const projectPath = join(userDataDir, 'roundtrip.hcasm');
  await app.evaluate(async ({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath,
    })) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [filePath],
    })) as typeof dialog.showOpenDialog;
  }, projectPath);

  const projectText = JSON.stringify({
    format: 'himmelcad-assembler',
    schemaVersion: 1,
    appVersion: 'e2e-test',
    units: 'mm',
    projectName: 'Round Trip',
    features: [],
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
  });

  const saved = await window.evaluate(async (text) => {
    const w = globalThis as unknown as {
      assembler: {
        project: {
          saveDialog(name: string): Promise<{ path: string } | null>;
          save(path: string, text: string): Promise<void>;
        };
      };
    };
    const chosen = await w.assembler.project.saveDialog('roundtrip.hcasm');
    if (!chosen) throw new Error('save dialog stub returned no path');
    await w.assembler.project.save(chosen.path, text);
    return chosen.path;
  }, projectText);
  assert.equal(saved, projectPath);

  const reopenedText = await window.evaluate(async () => {
    const w = globalThis as unknown as {
      assembler: { project: { openDialog(): Promise<{ path: string; text: string } | null> } };
    };
    const opened = await w.assembler.project.openDialog();
    if (!opened) throw new Error('open dialog stub returned nothing');
    return opened.text;
  });
  assert.equal(reopenedText, projectText);

  // Close guard: the sketch above made the project dirty, so closing the window
  // asks first (in-app dialog, not a native one); Discard lets it close.
  const closed = new Promise<void>((resolve) => app.once('close', () => resolve()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  const discard = window.getByRole('button', { name: 'Discard changes' });
  await discard.waitFor({ timeout: 10_000 });
  await window.screenshot({ path: join(SHOTS_DIR, 'f-electron-production-close-guard.png') });
  // The window (and the app) closes during the click itself.
  await discard.click({ noWaitAfter: true }).catch(() => undefined);
  await closed;
});

void test('production build: a .hcasm on the command line (file association) opens on launch', async (t) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'assembler-open-arg-'));
  const fixture = join(APP_DIR, 'test', 'fixtures', 'phone-stand.hcasm');
  const app = await electron.launch({
    args: [APP_DIR, `--user-data-dir=${userDataDir}`, fixture],
    env: { ...process.env, ASSEMBLER_FORCE_PRODUCTION: '1' },
    timeout: 60_000,
  });
  t.after(async () => {
    await closeApp(app);
    rmSync(userDataDir, { recursive: true, force: true });
  });
  const window = await app.firstWindow();
  // The project name in the top bar, and its last History step, once evaluated.
  await window.getByRole('button', { name: /^phone-stand/ }).waitFor({ timeout: 60_000 });
  const lastStep = (
    JSON.parse(readFileSync(fixture, 'utf8')) as { features: { name: string }[] }
  ).features.at(-1)!.name;
  await window
    .locator('[aria-label="History panel"]')
    .getByText(lastStep, { exact: true })
    .first()
    .waitFor({ timeout: 60_000 });
  await window.waitForFunction(() => !document.body.innerText.includes('No items yet'), {
    timeout: 60_000,
  });
  const recent = await window.evaluate(() =>
    (
      globalThis as unknown as {
        assembler: { recentFiles: { list(): Promise<{ path: string }[]> } };
      }
    ).assembler.recentFiles.list(),
  );
  assert.deepEqual(
    recent.map((r) => r.path),
    [fixture],
    'a file opened from the command line is remembered in Open Recent',
  );
  mkdirSync(SHOTS_DIR, { recursive: true });
  await window.screenshot({ path: join(SHOTS_DIR, 'f-electron-open-argument.png') });
});
