/**
 * The Home screen covers the window when the app starts without a file
 * (`shell-ui/HomeScreen.tsx`). Escape closes it onto a blank project — the
 * start document is blank, never the sample (owner, Block 9). Tests that
 * work on the demo bracket then open it the way a user opens a file:
 * dropped onto the window as a `.hcasm` (`openDemo`).
 */
import type { Page } from 'playwright-core';

import { createDemoDocument } from '../../renderer/src/foundation/commands/demoDocument.js';
import { saveProjectFile } from '../../renderer/src/foundation/document/format.js';

export async function dismissHome(page: Page, options: { demo?: boolean } = {}): Promise<void> {
  const home = page.locator('[data-home-screen]');
  await home.waitFor({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await home.waitFor({ state: 'detached', timeout: 10_000 });
  if (options.demo === false) return;
  await openDemo(page);
}

/** The demo bracket as a project file. */
export function demoProjectText(): string {
  return saveProjectFile({
    projectName: 'Bracket',
    features: createDemoDocument(),
    appVersion: 'electron-test',
    createdAt: '2026-10-02T00:00:00.000Z',
    modifiedAt: '2026-10-02T00:00:00.000Z',
  });
}

/** Drops the demo bracket onto the window (File drop opens a `.hcasm`) and waits until it is listed. */
export async function openDemo(page: Page): Promise<void> {
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'Bracket.hcasm', { type: 'application/json' }));
    for (const type of ['dragenter', 'dragover', 'drop']) {
      window.dispatchEvent(
        new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    }
  }, demoProjectText());
  await page.waitForFunction(() => !document.body.innerText.includes('No items yet'), null, {
    timeout: 60_000,
  });
}
