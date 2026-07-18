const assert = require('node:assert/strict');

const { BrowserWindow, app } = require('electron');

app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const reportWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: false,
    },
  });
  reportWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  try {
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4 landscape}body{font:14px sans-serif}</style></head><body><h1>HimmelCAD PhotoLab</h1><p>Isolated processing report PDF smoke.</p></body></html>';
    await reportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    reportWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    const pdf = await reportWindow.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
    assert.ok(pdf.byteLength > 1_000, 'PDF payload must not be empty');
    assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.match(pdf.subarray(-1_024).toString('ascii'), /%%EOF/);
    process.stdout.write(`PhotoLab processing report PDF test passed · ${pdf.byteLength} bytes\n`);
  } finally {
    reportWindow.destroy();
    app.quit();
  }
});
