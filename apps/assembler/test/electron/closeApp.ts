/**
 * Ends an Electron app under test. A test that edited the model leaves the
 * project dirty, and a normal window close then (correctly) waits for the
 * "Unsaved changes" dialog (`electron/fileApi.ts` `attachCloseGuard`), which
 * nobody answers — so tests discard their work by exiting the app directly.
 * The close guard itself is checked in `production.test.ts`.
 */
import type { ElectronApplication } from 'playwright-core';

export async function closeApp(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.exit(0), 0);
    })
    .catch(() => undefined);
  await app.close().catch(() => undefined);
}
