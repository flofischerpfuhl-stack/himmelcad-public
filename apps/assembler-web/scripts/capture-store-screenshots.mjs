#!/usr/bin/env node
/**
 * The web app manifest's `screenshots` (richer install dialog in Chromium):
 * `public/screenshots/wide.png` (1280×800, desktop) and `narrow.png`
 * (820×1180, tablet portrait with touch), taken from the built site with the
 * demo bracket open. Run after `pnpm build`, then build again so the files ship:
 *
 *   node scripts/capture-store-screenshots.mjs
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import { chromiumPath, waitForModel } from '../e2e/helpers.mjs';
import { startServer } from './serve.mjs';

const out = fileURLToPath(new URL('../public/screenshots/', import.meta.url));
mkdirSync(out, { recursive: true });

const server = await startServer();
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ['--enable-unsafe-swiftshader'],
});
try {
  for (const [name, viewport, touch] of [
    ['wide', { width: 1280, height: 800 }, false],
    ['narrow', { width: 820, height: 1180 }, true],
  ]) {
    const context = await browser.newContext({ viewport, hasTouch: touch, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(server.url);
    await waitForModel(page, { timeout: 180_000, items: !touch || viewport.width >= 700 });
    // The first-install notice is not part of the product shot.
    const notice = page.getByText(/now works offline/);
    await notice.waitFor({ timeout: 60_000 }).catch(() => undefined);
    if (await notice.isVisible()) await notice.locator('xpath=..').getByRole('button').click();
    if (touch) {
      // Portrait: step back so the whole bracket shows beside the panels.
      const box = await page.locator('canvas').boundingBox();
      await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.6);
      for (let i = 0; i < 2; i += 1) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(150);
      }
      // No hover highlight in the shot.
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.98);
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}${name}.png` });
    process.stdout.write(`${out}${name}.png\n`);
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
