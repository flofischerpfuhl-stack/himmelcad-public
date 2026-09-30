/**
 * The Home screen covers the model when the app starts without a file
 * (`chrome/HomeScreen.tsx`). Tests that work on the start document close it
 * the way a user does — Escape — and wait until it is gone.
 */
import type { Page } from 'playwright-core';

export async function dismissHome(page: Page): Promise<void> {
  const home = page.locator('[data-home-screen]');
  await home.waitFor({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await home.waitFor({ state: 'detached', timeout: 10_000 });
}
