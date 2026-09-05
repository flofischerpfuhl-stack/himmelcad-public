import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const galleryDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(galleryDir, '..');
const workspaceDir = resolve(galleryDir, '../../../..');
const shotsDir = resolve(galleryDir, 'shots');
const chrome = '/usr/bin/google-chrome';
const port = 4179;
const baseUrl = `http://127.0.0.1:${port}`;
const chromeProfile = await mkdtemp(resolve(tmpdir(), 'himmelcad-ui-gallery-'));
const captureLock = resolve(galleryDir, '.gallery-shots.lock');
const builderRequire = createRequire(resolve(workspaceDir, 'apps/builder/package.json'));
const { chromium } = builderRequire('playwright-core');
const vitePackage = builderRequire.resolve('vite/package.json');
const viteBin = resolve(dirname(vitePackage), 'bin/vite.js');

let preview;
let ownsCaptureLock = false;
try {
  try {
    await mkdir(captureLock);
    ownsCaptureLock = true;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('Another gallery:shots run is already using the shared capture outputs.');
    }
    throw error;
  }
  await run(process.execPath, [viteBin, 'build', galleryDir], packageDir);
  preview = spawn(
    process.execPath,
    [viteBin, 'preview', galleryDir, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: packageDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let previewErrors = '';
  preview.stderr.on('data', (chunk) => {
    previewErrors += String(chunk);
  });
  await waitForServer(previewErrors);

  const manifestHtml = await dumpDom(`${baseUrl}/?theme=dark`);
  const sections = [...manifestHtml.matchAll(/data-gallery-section="([^"]+)"/g)].map(
    (match) => match[1],
  );
  const uniqueSections = [...new Set(sections)];
  if (uniqueSections.length === 0) throw new Error('Gallery rendered no component sections.');

  await mkdir(shotsDir, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await capture(`${baseUrl}/?theme=${theme}`, resolve(shotsDir, `${theme}.png`));
    const themeDir = resolve(shotsDir, theme);
    await mkdir(themeDir, { recursive: true });
    for (const section of uniqueSections) {
      await capture(
        `${baseUrl}/?theme=${theme}&section=${encodeURIComponent(section)}`,
        resolve(themeDir, `${section}.png`),
      );
    }
    await verifyButtonHoverDiff(theme);
    await verifyDialogCancelContrast(theme);
    await verifyJobsRespondContrast(theme);
    await verifyViewportChromeContrast(theme);
  }
  process.stdout.write(
    `Captured ${2 + uniqueSections.length * 2} screenshots for ${uniqueSections.length} sections in ${shotsDir}\n`,
  );
} finally {
  preview?.kill('SIGTERM');
  await rm(chromeProfile, { recursive: true, force: true });
  if (ownsCaptureLock) {
    await rm(resolve(galleryDir, 'dist'), { recursive: true, force: true });
    await rm(captureLock, { recursive: true, force: true });
  }
}

async function waitForServer(errorOutput) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (preview?.exitCode != null) throw new Error(`Vite preview exited early.\n${errorOutput}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for Vite preview.\n${errorOutput}`);
}

async function dumpDom(url) {
  const { stdout } = await execFileAsync(
    chrome,
    chromeArgs(['--window-size=1280,600', '--dump-dom', url]),
    {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  return stdout;
}

async function capture(url, outputPath) {
  const html = await dumpDom(url);
  const match = html.match(/data-capture-height="(\d+)"/);
  if (!match) throw new Error(`Gallery did not report a capture height for ${url}`);
  const height = Math.min(16_000, Math.max(300, Number(match[1])));
  await execFileAsync(
    chrome,
    chromeArgs([
      '--hide-scrollbars',
      `--window-size=1280,${height}`,
      `--screenshot=${outputPath}`,
      url,
    ]),
    { timeout: 30_000 },
  );
}

async function verifyButtonHoverDiff(theme) {
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${baseUrl}/?theme=${theme}&section=button`);
    await page.evaluate(() => document.fonts.ready);
    const defaultRow = await page
      .locator('[data-gallery-row="primary-default"] .gallerySample')
      .screenshot();
    const hoverRow = await page
      .locator('[data-gallery-row="primary-hover"] .gallerySample')
      .screenshot();
    if (defaultRow.equals(hoverRow)) {
      throw new Error(`Button default and hover rows are pixel-identical in the ${theme} theme.`);
    }
  } finally {
    await browser.close();
  }
}

async function verifyDialogCancelContrast(theme) {
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${baseUrl}/?theme=${theme}&section=dialog`);
    await page.evaluate(() => document.fonts.ready);
    const rows = page.locator('[data-gallery-section="dialog"] [data-gallery-row]');
    for (let index = 0; index < (await rows.count()); index += 1) {
      const row = rows.nth(index);
      const rowName = await row.getAttribute('data-gallery-row');
      const cancel = row.getByRole('button', { name: 'Cancel', exact: true });
      const buttonBox = await cancel.boundingBox();
      const textBox = await cancel.locator('span').boundingBox();
      if (!buttonBox || !textBox) {
        throw new Error(`Could not locate Dialog Cancel pixels in ${theme}/${rowName}.`);
      }
      const screenshot = await cancel.screenshot();
      const bitmap = await decodePng(page, screenshot);
      const fill = sampleFill(bitmap);
      const text = sampleText(
        bitmap,
        {
          x: textBox.x - buttonBox.x,
          y: textBox.y - buttonBox.y,
          width: textBox.width,
          height: textBox.height,
        },
        fill,
      );
      const ratio = contrastRatio(text, fill);
      if (ratio < 4.5) {
        throw new Error(
          `Dialog Cancel contrast is ${ratio.toFixed(2)}:1 in ${theme}/${rowName}; expected at least 4.5:1.`,
        );
      }
    }
  } finally {
    await browser.close();
  }
}

async function verifyJobsRespondContrast(theme) {
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${baseUrl}/?theme=${theme}&section=jobs-surfaces`);
    await page.evaluate(() => document.fonts.ready);
    const respond = page
      .locator('[data-gallery-row="island"]')
      .getByRole('button', { name: 'Respond', exact: true });
    await verifyElementTextContrast(
      respond,
      respond.locator('span'),
      4.5,
      `Jobs Respond in ${theme}`,
    );
  } finally {
    await browser.close();
  }
}

async function verifyViewportChromeContrast(theme) {
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${baseUrl}/?theme=${theme}&section=viewport-chrome`);
    await page.evaluate(() => document.fonts.ready);
    const activeText = page.locator('[data-gallery-contrast-text="viewport-active"]');
    await verifyElementTextContrast(
      activeText.locator('..'),
      activeText,
      4.5,
      `Viewport active segment in ${theme}`,
    );
    const axisText = page.locator('[data-gallery-contrast-text="axis-chip"]');
    await verifyElementTextContrast(
      page.locator('[data-gallery-contrast-surface="axis-chip"]'),
      axisText,
      4.5,
      `Viewport axis chip in ${theme}`,
    );
  } finally {
    await browser.close();
  }
}

async function verifyElementTextContrast(element, textElement, minimum, description) {
  const elementBox = await element.boundingBox();
  const textBox = await textElement.boundingBox();
  if (!elementBox || !textBox) throw new Error(`Could not locate pixels for ${description}.`);
  const screenshot = await element.screenshot();
  const page = element.page();
  const bitmap = await decodePng(page, screenshot);
  const fill = sampleFill(bitmap);
  const text = sampleText(
    bitmap,
    {
      x: textBox.x - elementBox.x,
      y: textBox.y - elementBox.y,
      width: textBox.width,
      height: textBox.height,
    },
    fill,
  );
  const ratio = contrastRatio(text, fill);
  if (ratio < minimum) {
    throw new Error(
      `${description} contrast is ${ratio.toFixed(2)}:1; expected at least ${minimum}:1.`,
    );
  }
}

async function decodePng(page, png) {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create a canvas context for screenshot analysis.');
    context.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: [...context.getImageData(0, 0, canvas.width, canvas.height).data],
    };
  }, png.toString('base64'));
}

function sampleFill(bitmap) {
  const counts = new Map();
  for (let y = 2; y < Math.min(6, bitmap.height - 2); y += 1) {
    for (let x = 8; x < bitmap.width - 8; x += 1) {
      const color = pixelAt(bitmap, x, y);
      const key = color.join(',');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const entry = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (!entry) throw new Error('Could not sample the control fill colour.');
  return entry[0].split(',').map(Number);
}

function sampleText(bitmap, textBox, fill) {
  let text = fill;
  let greatestContrast = 1;
  const left = Math.max(0, Math.floor(textBox.x));
  const top = Math.max(0, Math.floor(textBox.y));
  const right = Math.min(bitmap.width, Math.ceil(textBox.x + textBox.width));
  const bottom = Math.min(bitmap.height, Math.ceil(textBox.y + textBox.height));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const candidate = pixelAt(bitmap, x, y);
      const ratio = contrastRatio(candidate, fill);
      if (ratio > greatestContrast) {
        greatestContrast = ratio;
        text = candidate;
      }
    }
  }
  return text;
}

function pixelAt(bitmap, x, y) {
  const offset = (y * bitmap.width + x) * 4;
  return bitmap.pixels.slice(offset, offset + 3);
}

function contrastRatio(left, right) {
  const light = Math.max(relativeLuminance(left), relativeLuminance(right));
  const dark = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (light + 0.05) / (dark + 0.05);
}

function relativeLuminance(color) {
  const [red, green, blue] = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function chromeArgs(extra) {
  return [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--force-device-scale-factor=1',
    '--virtual-time-budget=1200',
    `--user-data-dir=${chromeProfile}`,
    ...extra,
  ];
}

async function run(command, args, cwd) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}
