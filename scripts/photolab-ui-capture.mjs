import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { chromium } from 'playwright-core';

process.env.HIMMELCAD_PHOTOLAB_CLEAN_BOOT = '1';

const endpoint = process.env.HIMMELCAD_PHOTOLAB_CDP ?? 'http://127.0.0.1:9223';
const output = resolve(process.argv[2] ?? '.build/photolab-ui/scene.png');
const gcpOutput = resolve(dirname(output), 'gcp-properties.png');
const imageOutput = resolve(dirname(output), 'image-navigation.png');
const gcpImagesOutput = resolve(dirname(output), 'gcp-images.png');
const browser = await chromium.connectOverCDP(endpoint);
try {
  const context = browser.contexts()[0];
  const page = context
    ?.pages()
    .find((candidate) => candidate.url().startsWith('http://localhost:5174'));
  if (!page) throw new Error('PhotoLab renderer page is not available over CDP');
  await page.waitForFunction(
    () => document.body.innerText.includes('Camera layer updated · 135/135 rectangles'),
    undefined,
    { timeout: 20_000 },
  );
  const workspace = page.getByRole('tablist', { name: 'Workspace' });
  await workspace.getByRole('tab', { name: 'Images' }).click();
  const firstImage = page.getByText(/^DJI_.*JPG$/, { exact: true }).first();
  await firstImage.click();
  const selectedImageRow = page
    .locator('div[class*="rowSelected"]')
    .filter({ has: page.locator('span[title="CameraImage"]') })
    .first();
  const selectedBeforeArrow = await selectedImageRow.textContent();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  const selectedAfterArrow = await selectedImageRow.textContent();
  if (selectedBeforeArrow === selectedAfterArrow)
    throw new Error('ArrowRight did not advance to the next image');
  const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
  await zoomIn.waitFor({ timeout: 5_000 });
  const zoomValue = zoomIn.locator('xpath=preceding-sibling::code[1]');
  const zoomBefore = await zoomValue.textContent();
  await zoomIn.click();
  const zoomAfterButton = await zoomValue.textContent();
  if (zoomBefore === zoomAfterButton) throw new Error('Image zoom button did not change the scale');
  const imageFrame = page.locator('div[class*="imageFrame"]').first();
  const transformBeforeWheel = await imageFrame.evaluate((element) => element.style.transform);
  const host = page.locator('div[class*="frameHost"]').first();
  const box = await host.boundingBox();
  if (!box) throw new Error('Image pan/zoom host is not visible');
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4);
  await page.mouse.wheel(0, -240);
  const transformAfterWheel = await imageFrame.evaluate((element) => element.style.transform);
  if (transformBeforeWheel === transformAfterWheel)
    throw new Error('Cursor-based image wheel zoom did not update the transform');
  await page.screenshot({ path: imageOutput, fullPage: false });
  await workspace.getByRole('tab', { name: 'View' }).click();
  await page.waitForTimeout(500);
  const frame = page.getByRole('button', { name: /Frame (all|selection)/ });
  await frame.click();
  await page.waitForTimeout(500);
  const diagnostics = await page.evaluate(() => ({
    cameraAccepted: document.body.innerText.includes('Camera layer updated · 135/135 rectangles'),
    cameraRejected: document.body.innerText.includes('Camera layer updated · 0/135 rectangles'),
    canvases: [...document.querySelectorAll('canvas')].map((canvas) => ({
      width: canvas.width,
      height: canvas.height,
      visible:
        canvas.getBoundingClientRect().width > 0 && canvas.getBoundingClientRect().height > 0,
    })),
  }));
  if (!diagnostics.cameraAccepted || diagnostics.cameraRejected) {
    throw new Error(`Camera layer validation failed: ${JSON.stringify(diagnostics)}`);
  }
  await mkdir(dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: false });
  const imageLabels = page.getByText(/^DJI_.*JPG$/, { exact: true });
  await imageLabels.nth(0).click();
  await imageLabels.nth(1).click({ modifiers: ['Control'] });
  await imageLabels.nth(3).click({ modifiers: ['Shift'] });
  const selectionCount = page.getByText('Count', { exact: true }).locator('..').locator('strong');
  await selectionCount.waitFor({ timeout: 5_000 });
  const rangeSelectionCount = await selectionCount.textContent();
  if (rangeSelectionCount !== '3')
    throw new Error(`Ctrl/Shift image selection expected 3, got ${rangeSelectionCount}`);
  const tree = page.getByRole('tree');
  await tree.focus();
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(100);
  const selectAllCount = await selectionCount.textContent();
  if (selectAllCount !== '135')
    throw new Error(`Tree-level Ctrl+A expected 135 images, got ${selectAllCount}`);
  const firstGcp = page
    .getByRole('tree')
    .getByText(/^gcp\S+$/, { exact: true })
    .first();
  await firstGcp.click();
  await page.getByText('Easting (X)', { exact: true }).waitFor({ timeout: 5_000 });
  await page.screenshot({ path: gcpOutput, fullPage: false });
  await firstGcp.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Images containing this GCP', exact: true }).click();
  await page.getByText('Images with this GCP', { exact: true }).waitFor({ timeout: 5_000 });
  const relatedImages = page.getByLabel(/^Images containing /).last();
  const relatedImageCount = await relatedImages.getByRole('button').count();
  if (relatedImageCount > 0) {
    const predictedMarker = page.getByRole('button', { name: /, Predicted$/ }).first();
    await predictedMarker.waitFor({ timeout: 5_000 });
  }
  await page.screenshot({ path: gcpImagesOutput, fullPage: false });
  process.stdout.write(
    `${JSON.stringify(
      {
        output,
        gcpOutput,
        gcpImagesOutput,
        imageOutput,
        zoomBefore,
        zoomAfterButton,
        selectedBeforeArrow,
        selectedAfterArrow,
        rangeSelectionCount,
        selectAllCount,
        relatedImageCount,
        wheelTransformChanged: transformBeforeWheel !== transformAfterWheel,
        ...diagnostics,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser.close();
}
