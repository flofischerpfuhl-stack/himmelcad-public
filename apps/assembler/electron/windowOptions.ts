import { resolve } from 'node:path';

import type { BrowserWindowConstructorOptions } from 'electron';

/** Product name as used in the OS window title and app identity. */
export const ASSEMBLER_PRODUCT_NAME = 'Himmel:CAD Assembler';

/**
 * Pure builder for the main window's constructor options, kept free of any
 * runtime `electron` import so it can be unit-tested with plain Node without
 * launching Electron. Security posture (contextIsolation/sandbox on,
 * nodeIntegration off) is asserted by `test/windowOptions.test.ts`.
 */
export function createMainWindowOptions(electronDir: string): BrowserWindowConstructorOptions {
  return {
    title: ASSEMBLER_PRODUCT_NAME,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    // Matches @himmelcad/theme's --hc-bg-void; avoids a white flash before the
    // renderer paints its own dark background.
    backgroundColor: '#101114',
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolve(electronDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}
