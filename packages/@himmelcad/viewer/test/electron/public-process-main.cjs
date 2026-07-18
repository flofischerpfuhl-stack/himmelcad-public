const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await window.loadURL(process.env.HCAD_PUBLIC_HOST_URL);
});

app.on('window-all-closed', () => app.quit());
