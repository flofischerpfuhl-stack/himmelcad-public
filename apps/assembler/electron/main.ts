import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserWindow, app } from 'electron';

import { ASSEMBLER_PRODUCT_NAME, createMainWindowOptions } from './windowOptions';

const isDev = !app.isPackaged;
const RENDERER_URL = isDev
  ? 'http://localhost:5175/'
  : pathToFileURL(resolve(__dirname, '../renderer/index.html')).href;

app.setName(ASSEMBLER_PRODUCT_NAME);

let mainWindow: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  const win = new BrowserWindow(createMainWindowOptions(__dirname));
  mainWindow = win;

  // Secure defaults: no window.open()-spawned windows, no in-place navigation
  // away from the packaged renderer or the dev server.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-redirect', (event) => event.preventDefault());

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  await win.loadURL(RENDERER_URL);
}

void app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) void createWindow();
});
