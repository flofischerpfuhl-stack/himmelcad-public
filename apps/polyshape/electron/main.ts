import { resolve } from 'node:path';

import { BrowserWindow, app, session } from 'electron';

import { startSidecar, stopSidecar } from './sidecar';

const isDev = !app.isPackaged;

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#181a1d',
    autoHideMenuBar: false,
    show: false,
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  if (isDev) {
    await win.loadURL('http://localhost:5173/');
  } else {
    await win.loadFile(resolve(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
      },
    });
  });

  await startSidecar();
  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('before-quit', () => {
  stopSidecar();
});
