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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _electron as electron } from 'playwright-core';

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
    await app.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  });

  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  // The renderer loaded from `app://assembler/index.html`, not a dev server
  // or `file://` — this is the thing being verified.
  const url = window.url();
  assert.match(url, /^app:\/\/assembler\//, `renderer URL is ${url}`);

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

  // Kernel-ready only means the worker/wasm loaded; the initial document
  // (the demo bracket) still evaluates asynchronously afterwards. Wait for
  // the Items panel to list it before asserting the app "renders" and
  // before the screenshot, or the shot would show an empty "No items yet"
  // viewport despite a ready kernel.
  await window.waitForFunction(() => !document.body.innerText.includes('No items yet'), {
    timeout: 20_000,
  });

  mkdirSync(SHOTS_DIR, { recursive: true });
  await window.screenshot({ path: join(SHOTS_DIR, 'f-electron-production-ready.png') });

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
});
