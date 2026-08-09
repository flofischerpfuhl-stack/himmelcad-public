#!/usr/bin/env node

/* global document, process, window */
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Electron/Playwright and product manifests cross untyped process boundaries in this standalone E2E gate. */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { _electron as electron } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const args = parseArguments(process.argv.slice(2));
if (process.platform === 'linux' && process.env.HIMMELCAD_PRODUCT_VIEWER_XVFB !== '1') {
  const child = spawnSync('xvfb-run', ['-a', process.execPath, ...process.argv.slice(1)], {
    cwd: root,
    env: { ...process.env, HIMMELCAD_PRODUCT_VIEWER_XVFB: '1' },
    stdio: 'inherit',
  });
  process.exit(child.status ?? 1);
}

const projectA = resolve(args.projectA);
const projectB = resolve(args.projectB);
const output = resolve(args.output ?? '.build/product-viewer-e2e');
await mkdir(output, { recursive: true });
const require = createRequire(import.meta.url);
const executablePath = require('../apps/photolab/node_modules/electron');
const stderr = [];
const pageErrors = [];
const failedRequests = [];
const abortedRequests = [];
let application;
try {
  application = await electron.launch({
    executablePath,
    args: [
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      resolve(root, 'apps/photolab'),
    ],
    cwd: root,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: resolve(output, 'config'),
      HIMMELCAD_UI_PROJECT_PATH: projectA,
      HIMMELCAD_UI_CAPTURE_PATH: resolve(output, 'automatic.png'),
      HIMMELCAD_UI_CAPTURE_BUILT: '1',
      HIMMELCAD_UI_CAPTURE_DELAY_MS: '60000',
    },
    timeout: 30_000,
  });
  application.on('console', (message) => {
    if (message.type() === 'error') stderr.push(message.text());
  });
  const page = await application.firstWindow({ timeout: 30_000 });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    if (request.url().startsWith('hcad-product:')) {
      const failure = `${request.url()}: ${request.failure()?.errorText ?? 'unknown failure'}`;
      if (request.failure()?.errorText === 'net::ERR_ABORTED') abortedRequests.push(failure);
      else failedRequests.push(failure);
    }
  });

  const first = await auditOpenProject(page, resolve(output, 'project-a.png'), 'project A');
  await application.evaluate(({ dialog }, nextProject) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nextProject] });
  }, projectB);
  await page.getByRole('button', { name: 'Open', exact: true }).click({ force: true });
  await page.waitForFunction(
    () => document.body.innerText.includes('Product Viewer Switch Regression'),
    null,
    { timeout: 180_000 },
  );
  await page
    .getByRole('dialog', { name: 'Opening project' })
    .waitFor({ state: 'detached', timeout: 180_000 });
  const second = await auditOpenProject(page, resolve(output, 'project-b.png'), 'project B');
  if (first.splatMarker === second.splatMarker || second.splatMarker !== 'switch-project') {
    throw new Error(
      `Project switch reused stale product content: ${String(first.splatMarker)} -> ${String(second.splatMarker)}`,
    );
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  const reloaded = await auditOpenProject(
    page,
    resolve(output, 'project-b-reloaded.png'),
    'project B after renderer reload',
  );
  if (reloaded.splatMarker !== 'switch-project') {
    throw new Error('Renderer remount did not retain the active project product namespace');
  }
  if (pageErrors.length > 0) throw new Error(`Renderer errors: ${pageErrors.join(' | ')}`);
  if (failedRequests.length > 0)
    throw new Error(`Product requests failed: ${failedRequests.join(' | ')}`);
  const report = {
    schemaVersion: 1,
    projectA,
    projectB,
    first,
    second,
    reloaded,
    pageErrors,
    failedRequests,
    abortedRequests,
    electronErrors: stderr.filter((line) => !line.includes('DevTools listening')),
  };
  const reportPath = resolve(output, 'result.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`PhotoLab product viewer E2E passed · ${reportPath}\n`);
} finally {
  await application?.close().catch(() => undefined);
}

async function auditOpenProject(page, screenshotPath, label) {
  await page.waitForFunction(
    () =>
      document.body.innerText.includes('Gaussian Splat') &&
      document.body.innerText.includes('Core ready'),
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(2_000);
  const consoleTab = page.getByRole('tab', { name: 'Console', exact: true });
  await consoleTab.click({ force: true });
  const loadedLabels = [
    'Sparse Point Cloud loaded',
    'Dense Point Cloud loaded',
    'DEM Pyramid loaded',
    'Orthomosaic Pyramid loaded',
    'Mesh loaded',
    'Gaussian Splat loaded',
  ];
  await page.waitForFunction(
    () => !document.body.innerText.includes('Preparing the visible layer…'),
    null,
    { timeout: 60_000 },
  );
  const visibleText = await page.locator('body').innerText();
  if (
    visibleText.includes('Product could not be loaded') ||
    visibleText.includes('Failed to fetch')
  ) {
    throw new Error('The application console contains a product loading failure');
  }
  const protocol = await inspectProductProtocol(page);
  protocol.visibleLoadMessages = loadedLabels.filter((entry) => visibleText.includes(entry));
  await page.getByRole('tab', { name: 'Images', exact: true }).last().click({ force: true });
  await page.waitForTimeout(500);
  const imageText = await page.locator('body').innerText();
  if (imageText.includes('Depth product could not be loaded')) {
    throw new Error('The Images workspace could not load the depth product');
  }
  await page.getByRole('tab', { name: 'View', exact: true }).click({ force: true });
  // The viewer may still be streaming large point products. Invoking the optional
  // framing action here makes the protocol regression gate depend on GPU timing.
  await page.waitForTimeout(500);
  await mkdir(dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath });
  process.stdout.write(`${label} product UI and protocol audit passed\n`);
  return protocol;
}

async function inspectProductProtocol(page) {
  return page.evaluate(async () => {
    const productUrl = (relativePath) =>
      `hcad-product://project/${relativePath
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/')}`;
    const firstProductAssets = (kind, manifestUrl, manifest) => {
      const base = new URL('.', manifestUrl);
      if (kind === 'sparse' || kind === 'dense') {
        return [new URL('hierarchy.bin', base).toString(), new URL('octree.bin', base).toString()];
      }
      if (kind === 'depth') {
        const tile = manifest.depthImages?.[0]?.tiles?.[0];
        return tile ? [new URL(tile.relativePath, base).toString()] : [];
      }
      if (kind === 'dem' || kind === 'orthomosaic') {
        const rasterBase = new URL('../', manifestUrl);
        const level = manifest.levels?.[0];
        const layer = level?.viewLayers?.[0];
        return layer
          ? [
              new URL(
                layer.urlTemplate
                  .replaceAll('{level}', String(level.level))
                  .replaceAll('{z}', String(level.level))
                  .replaceAll('{x}', '0')
                  .replaceAll('{y}', '0'),
                rasterBase,
              ).toString(),
            ]
          : [];
      }
      if (kind === 'mesh') {
        const tile = manifest.tiles?.find((candidate) => candidate.id === manifest.rootTileId);
        return tile
          ? [tile.positionUrl, tile.indexUrl, tile.bvh?.url]
              .filter(Boolean)
              .map((relative) => new URL(relative, base).toString())
          : [];
      }
      if (kind === 'gaussianSplat') {
        const tile = manifest.tiles?.find((candidate) => candidate.id === manifest.rootTileId);
        return tile?.dataUrl ? [new URL(tile.dataUrl, base).toString()] : [];
      }
      return [];
    };
    const products = await window.himmelcad.sidecar.call('photolab.products.list');
    const requiredKinds = [
      'sparse',
      'dense',
      'depth',
      'dem',
      'orthomosaic',
      'mesh',
      'gaussianSplat',
    ];
    for (const kind of requiredKinds) {
      if (!products.some((product) => product.kind === kind)) {
        throw new Error(`Missing published product kind: ${kind}`);
      }
    }
    const observations = [];
    let splatMarker = null;
    for (const product of products) {
      const url = productUrl(product.relativePath);
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`${product.kind} manifest returned ${response.status}`);
      const cacheControl = response.headers.get('cache-control');
      const cors = response.headers.get('access-control-allow-origin');
      if (cacheControl !== 'private, no-store') {
        throw new Error(`${product.kind} has unsafe cache policy ${String(cacheControl)}`);
      }
      if (cors !== '*') throw new Error(`${product.kind} has no product-protocol CORS header`);
      const manifest = await response.json();
      const assets = firstProductAssets(product.kind, url, manifest);
      for (const asset of assets) {
        const assetResponse = await fetch(asset, {
          cache: 'force-cache',
          headers: { Range: 'bytes=0-31' },
        });
        if (assetResponse.status !== 206) {
          throw new Error(
            `${product.kind} asset did not honor byte range: ${assetResponse.status}`,
          );
        }
        await assetResponse.arrayBuffer();
      }
      if (product.kind === 'gaussianSplat') splatMarker = manifest.testProjectMarker ?? null;
      observations.push({
        kind: product.kind,
        format: product.format,
        manifestStatus: response.status,
        assetCount: assets.length,
        cacheControl,
        cors,
      });
    }
    return { products: observations, splatMarker };
  });
}

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--project-a' || value === '--project-b' || value === '--output') {
      const next = values[++index];
      if (!next) throw new Error(`${value} requires a path`);
      parsed[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!parsed.projectA || !parsed.projectB) {
    throw new Error('--project-a and --project-b are required');
  }
  return parsed;
}
