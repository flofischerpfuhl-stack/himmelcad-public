import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import {
  AHN4_POINT_COUNT,
  OCTREE_NODE_COUNT,
  POINT_STRIDE_BYTES,
  SOURCE_BOUNDS,
  createSyntheticPotree,
  parseSingleRange,
} from './synthetic-potree.mjs';
import {
  LOGICAL_MESH_TRIANGLES,
  LOGICAL_SPLATS,
  MESH_TILE_COUNT,
  SPLAT_TILE_COUNT,
  createSyntheticMixed,
} from './synthetic-mixed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const viewerRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(viewerRoot, '../../..');
const outputRoot = path.join(repoRoot, 'target/viewer-scale-synthetic');
const wasmRoot = path.join(outputRoot, 'wasm');
const decodeWasmRoot = path.join(outputRoot, 'decode-wasm');
const screenshots = path.join(outputRoot, 'screenshots');
const cargo = '/home/oem/.cargo/bin/cargo';
const bindgen = '/home/oem/.cargo/bin/wasm-bindgen';
const esbuild = path.join(repoRoot, 'node_modules/.pnpm/node_modules/.bin/esbuild');
const forceWebGl2 = process.env.HCAD_WEBGL2 === '1' || process.argv.includes('--webgl2');
const chromeAngleBackend = process.env.HCAD_CHROME_ANGLE ?? '';
assert(['', 'gl', 'vulkan'].includes(chromeAngleBackend), 'HCAD_CHROME_ANGLE must be gl or vulkan');

const synthetic = createSyntheticPotree();
const mixed = createSyntheticMixed(SOURCE_BOUNDS);
assert.equal(synthetic.nodes.length, OCTREE_NODE_COUNT);
assert.equal(synthetic.logicalPoints, AHN4_POINT_COUNT);
assert.equal(synthetic.initialHierarchy.byteLength, 73 * 22);
assert.equal(synthetic.hierarchyPages.length, 64);
assert.equal(
  synthetic.hierarchyPages.reduce((count, page) => count + page.bytes.byteLength / 22, 0),
  37_440,
);
assert.equal(synthetic.virtualOctreeBytes, AHN4_POINT_COUNT * POINT_STRIDE_BYTES);
assert.deepEqual(synthetic.metadataDocument.boundingBox, SOURCE_BOUNDS);
assert.equal(synthetic.metadataDocument.projection, 'EPSG:7415');
assert.equal(synthetic.nodes.filter((node) => node.pointCount === 31_668).length, 32_766);
assert.equal(synthetic.nodes.filter((node) => node.pointCount === 31_667).length, 4_683);
const rootNode = synthetic.nodes[0];
assert(rootNode);
const rootPayload = synthetic.payloadForRange(rootNode.byteOffset, rootNode.byteLength);
const repeatedRootPayload = synthetic.payloadForRange(rootNode.byteOffset, rootNode.byteLength);
assert.equal(rootPayload.byteLength, rootNode.byteLength);
assert.equal(uniquePositionCount(rootPayload), rootNode.pointCount);
assert.deepEqual(rootPayload, repeatedRootPayload);
assert.equal(LOGICAL_MESH_TRIANGLES, 4_194_304);
assert.equal(LOGICAL_SPLATS, 2_000_000);
assert.equal(MESH_TILE_COUNT, 512);
assert.equal(SPLAT_TILE_COUNT, 200);
assert(mixed.meshManifest.byteLength > 0);
assert(mixed.splatManifest.byteLength > 0);

await mkdir(wasmRoot, { recursive: true });
await mkdir(decodeWasmRoot, { recursive: true });
await mkdir(screenshots, { recursive: true });
await run(cargo, [
  'build',
  '-p',
  'himmelcad-wasm',
  '-p',
  'himmelcad-decode-wasm',
  '--target',
  'wasm32-unknown-unknown',
  '--release',
]);
await run(bindgen, [
  path.join(repoRoot, 'target/wasm32-unknown-unknown/release/himmelcad_wasm.wasm'),
  '--out-dir',
  wasmRoot,
  '--target',
  'web',
  '--no-typescript',
]);
await run(bindgen, [
  path.join(repoRoot, 'target/wasm32-unknown-unknown/release/himmelcad_decode_wasm.wasm'),
  '--out-dir',
  decodeWasmRoot,
  '--target',
  'web',
  '--no-typescript',
]);
await run(esbuild, [
  path.join(viewerRoot, 'src/kernel/KernelDecodeWorker.ts'),
  '--bundle',
  '--format=esm',
  '--target=es2022',
  `--outfile=${path.join(outputRoot, 'decode-worker.js')}`,
]);
await run(esbuild, [
  path.join(here, 'scale-main.ts'),
  '--bundle',
  '--format=esm',
  '--target=es2022',
  '--external:/wasm/*',
  `--outfile=${path.join(outputRoot, 'bundle.js')}`,
]);

const requestCounts = new Map();
let rangeRequests = 0;
let requestedBytes = 0;
let hierarchyRangeRequests = 0;
let hierarchyPageRangeRequests = 0;
let preparedContentRequests = 0;
let meshContentRequests = 0;
let splatContentRequests = 0;
let preparedRequestedBytes = 0;
const requestedHierarchyPages = new Set();
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/favicon.ico') return void response.writeHead(204).end();
    if (pathname === '/scale/metadata.json') {
      return void send(response, 200, synthetic.metadata, 'application/json');
    }
    if (pathname === '/scale/hierarchy.bin') {
      const range = parseSingleRange(request.headers.range);
      const isInitial = range.start === 0 && range.length === synthetic.initialHierarchy.byteLength;
      const page = isInitial ? null : synthetic.hierarchyPageForRange(range.start, range.length);
      if (!isInitial && page === null)
        throw new RangeError(`unknown hierarchy range ${String(request.headers.range)}`);
      const bytes = isInitial ? synthetic.initialHierarchy : page.bytes;
      hierarchyRangeRequests += 1;
      if (page !== null) {
        hierarchyPageRangeRequests += 1;
        requestedHierarchyPages.add(page.rootId);
      }
      response.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': bytes.byteLength,
        'Content-Range': `bytes ${String(range.start)}-${String(range.end)}/${String(synthetic.hierarchy.byteLength)}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      return void response.end(bytes);
    }
    if (pathname === '/scale/octree.bin') {
      const range = parseSingleRange(request.headers.range);
      const node = synthetic.nodeForRange(range.start, range.length);
      if (node === null)
        throw new RangeError(`unknown virtual octree range ${String(request.headers.range)}`);
      const payload = synthetic.payloadForRange(range.start, range.length);
      rangeRequests += 1;
      requestedBytes += payload.byteLength;
      requestCounts.set(node.id, (requestCounts.get(node.id) ?? 0) + 1);
      response.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': payload.byteLength,
        'Content-Range': `bytes ${String(range.start)}-${String(range.end)}/${String(synthetic.virtualOctreeBytes)}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });
      return void response.end(payload);
    }
    if (pathname === '/scale/mixed/mesh/manifest.json') {
      return void send(response, 200, mixed.meshManifest, 'application/json');
    }
    if (pathname === '/scale/mixed/splat/manifest.json') {
      return void send(response, 200, mixed.splatManifest, 'application/json');
    }
    const meshMatch = /^\/scale\/mixed\/mesh\/(\d+)\.glb$/.exec(pathname);
    if (meshMatch !== null) {
      const payload = mixed.meshPayload(Number(meshMatch[1]));
      preparedContentRequests += 1;
      meshContentRequests += 1;
      preparedRequestedBytes += payload.byteLength;
      return void send(response, 200, payload, 'model/gltf-binary');
    }
    const splatMatch = /^\/scale\/mixed\/splat\/(\d+)\.ply$/.exec(pathname);
    if (splatMatch !== null) {
      const payload = mixed.splatPayload(Number(splatMatch[1]));
      preparedContentRequests += 1;
      splatContentRequests += 1;
      preparedRequestedBytes += payload.byteLength;
      return void send(response, 200, payload, 'application/octet-stream');
    }
    if (pathname === '/scale/stats.json') {
      const requestedNodeIds = [...requestCounts.keys()].sort();
      const stats = {
        rangeRequests,
        requestedBytes,
        uniqueNodes: requestedNodeIds.length,
        duplicateNodeRequests: [...requestCounts.values()].reduce(
          (total, count) => total + Math.max(0, count - 1),
          0,
        ),
        requestedNodeIds,
        hierarchyRangeRequests,
        hierarchyPageRangeRequests,
        uniqueHierarchyPages: requestedHierarchyPages.size,
        preparedContentRequests,
        meshContentRequests,
        splatContentRequests,
        preparedRequestedBytes,
      };
      return void send(
        response,
        200,
        new TextEncoder().encode(JSON.stringify(stats)),
        'application/json',
      );
    }
    const file =
      pathname === '/'
        ? path.join(here, 'index.html')
        : pathname === '/bundle.js'
          ? path.join(outputRoot, 'bundle.js')
          : pathname === '/decode-worker.js'
            ? path.join(outputRoot, 'decode-worker.js')
            : pathname.startsWith('/decode-wasm/')
              ? path.join(decodeWasmRoot, pathname.slice('/decode-wasm/'.length))
              : pathname.startsWith('/wasm/')
                ? path.join(wasmRoot, pathname.slice('/wasm/'.length))
                : null;
    if (file === null || !(await isFile(file)))
      return void response.writeHead(404).end('not found');
    const bytes = await readFile(file);
    const contentType = file.endsWith('.wasm')
      ? 'application/wasm'
      : file.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : 'text/html; charset=utf-8';
    send(response, 200, bytes, contentType);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(error));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
const chromeArgs = forceWebGl2 ? ['--disable-webgpu'] : ['--enable-unsafe-webgpu'];
if (chromeAngleBackend !== '') {
  chromeArgs.push('--use-gl=angle', `--use-angle=${chromeAngleBackend}`);
}
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: process.env.HCAD_HEADLESS === '1' || !process.env.DISPLAY,
  args: chromeArgs,
});

try {
  const performanceProfile = process.env.HCAD_SCALE_PROFILE ?? '';
  assert(
    ['', 'low', 'mainstream', 'high'].includes(performanceProfile),
    'HCAD_SCALE_PROFILE must be low, mainstream or high',
  );
  const viewport =
    performanceProfile === 'low'
      ? { width: 1920, height: 1080 }
      : performanceProfile === 'mainstream'
        ? { width: 2560, height: 1440 }
        : performanceProfile === 'high'
          ? { width: 3840, height: 2160 }
          : { width: 1280, height: 720 };
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const browserGraphics = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (gl === null) return { webgl2: false, vendor: null, renderer: null };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      webgl2: true,
      vendor: debug === null ? null : String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)),
      renderer: debug === null ? null : String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)),
    };
  });
  if (
    performanceProfile &&
    (!browserGraphics.webgl2 ||
      /swiftshader|llvmpipe|software rasterizer/i.test(
        `${browserGraphics.vendor ?? ''} ${browserGraphics.renderer ?? ''}`,
      ))
  ) {
    throw new Error(
      `${performanceProfile} hardware profile refused browser software rendering: ${JSON.stringify(browserGraphics)}`,
    );
  }
  const browserErrors = [];
  const browserMessages = [];
  page.on('console', (message) => {
    browserMessages.push(`${message.type()}: ${message.text()}`);
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.stack ?? error.message));
  const query = new URLSearchParams();
  if (forceWebGl2) query.set('backend', 'webgl2');
  if (performanceProfile) query.set('profile', performanceProfile);
  query.set('width', String(viewport.width));
  query.set('height', String(viewport.height));
  await page.goto(`http://127.0.0.1:${String(address.port)}/?${query.toString()}`, {
    waitUntil: 'load',
  });
  try {
    await page.waitForFunction(
      () => window.__HCAD_SCALE__?.ready || window.__HCAD_SCALE__?.error,
      null,
      {
        timeout:
          performanceProfile === ''
            ? 240_000
            : performanceProfile === 'low'
              ? 360_000
              : performanceProfile === 'mainstream'
                ? 600_000
                : 900_000,
      },
    );
  } catch (error) {
    const timedOutState = await page.evaluate(() => window.__HCAD_SCALE__);
    console.error(JSON.stringify({ timedOutState, browserMessages }, null, 2));
    throw error;
  }
  const state = await page.evaluate(() => window.__HCAD_SCALE__);
  assert(state);
  if (state.error !== null) {
    console.error(JSON.stringify({ failedScaleState: state, browserMessages }, null, 2));
  }
  assert.equal(state.error, null, [state.error, ...browserMessages].filter(Boolean).join('\n'));
  assert.equal(state.ready, true);
  assert.equal(state.hierarchy.logicalPoints, AHN4_POINT_COUNT);
  assert.equal(state.hierarchy.logicalTriangles, LOGICAL_MESH_TRIANGLES);
  assert.equal(state.hierarchy.logicalSplats, LOGICAL_SPLATS);
  assert.equal(state.hierarchy.nodeCount, OCTREE_NODE_COUNT);
  assert.deepEqual(state.hierarchy.bounds, SOURCE_BOUNDS);
  assert.equal(state.hierarchy.projection, 'EPSG:7415');
  assert(state.maximumPlanTiles <= state.maximumTraversedNodes);
  assert(state.actionCounts.fetchTile > 0);
  assert(state.actionCounts.decodeTile > 0);
  assert(state.actionCounts.uploadTile > 0);
  assert(state.actionCounts.fetchHierarchyPage > 0);
  assert(state.actionCounts.evictTile > 0);
  assert(state.reenteredTiles.length > 0);
  assert(state.driverDiagnostics.peakRequests <= state.runtimeLimits.contentRequests);
  assert(state.driverDiagnostics.actualDecodeWorkers <= state.runtimeLimits.decoderWorkers);
  assert(state.frameTelemetry.peakPoints <= state.residentPointCeiling);
  if (performanceProfile) {
    assert.equal(state.performanceProfile, performanceProfile);
    assert.equal(state.profilePeaksReached, true);
    assert(state.profileMinimum);
    assert(state.frameTelemetry.peakPoints >= state.profileMinimum.points);
    assert(state.frameTelemetry.peakTriangles >= state.profileMinimum.triangles);
    assert(state.frameTelemetry.peakSplats >= state.profileMinimum.splats);
    assert(state.textureCache.gpuTextureBytes >= state.profileMinimum.textureBytes);
    assert(state.frameTelemetry.peakDrawCalls >= state.profileMinimum.drawCalls);
    assert(state.hardwarePolicy);
    assert(state.calibration);
    assert(state.hardwarePolicy.resources.points >= state.residentPointCeiling);
    assert(state.hardwarePolicy.resources.triangles >= state.profileMinimum.triangles);
    assert(state.hardwarePolicy.resources.splats >= state.profileMinimum.splats);
    assert(state.viewport);
  } else {
    assert.equal(state.residentPointCeiling, 220_000);
  }
  assert(state.frameTelemetry.peakResidentGpuBytes < state.hierarchy.virtualOctreeBytes);
  const contentActions = state.actionCounts.fetchTile + state.actionCounts.fetchHierarchyPage;
  const serverStartedRequests =
    state.serverStats.rangeRequests +
    state.serverStats.hierarchyPageRangeRequests +
    state.serverStats.preparedContentRequests;
  assert.equal(
    state.driverDiagnostics.startedRequests + state.driverDiagnostics.cancelledBeforeStartRequests,
    contentActions,
  );
  assert(serverStartedRequests <= state.driverDiagnostics.startedRequests);
  assert(
    state.driverDiagnostics.startedRequests - serverStartedRequests <=
      state.driverDiagnostics.abortedAfterStartRequests,
  );
  assert(state.serverStats.uniqueNodes < OCTREE_NODE_COUNT);
  assert(state.serverStats.duplicateNodeRequests > 0);
  assert(state.serverStats.hierarchyPageRangeRequests > 0);
  assert.equal(state.serverStats.hierarchyPageRangeRequests, state.actionCounts.fetchHierarchyPage);
  if (performanceProfile) {
    assert(
      state.serverStats.meshContentRequests >= Math.ceil(state.profileMinimum.triangles / 8_192),
    );
    assert(
      state.serverStats.splatContentRequests >= Math.ceil(state.profileMinimum.splats / 10_000),
    );
    assert(state.serverStats.preparedRequestedBytes > 0);
  }
  assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
  const profileSuffix = performanceProfile ? `-${performanceProfile}` : '';
  await page.screenshot({
    path: path.join(
      screenshots,
      `ahn4-scale-synthetic-${forceWebGl2 ? 'webgl2' : 'webgpu'}${profileSuffix}.png`,
    ),
  });
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(`browser graphics: ${JSON.stringify(browserGraphics)}\n`);
  process.stdout.write(`screenshot: ${screenshots}\n`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function send(response, status, bytes, contentType) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': bytes.byteLength,
    'Cache-Control': 'no-store',
  });
  response.end(bytes);
}

function uniquePositionCount(payload) {
  const positions = new Set();
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let offset = 0; offset < payload.byteLength; offset += POINT_STRIDE_BYTES) {
    positions.add(
      `${view.getInt32(offset, true)}/${view.getInt32(offset + 4, true)}/${view.getInt32(offset + 8, true)}`,
    );
  }
  return positions.size;
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} exited with ${String(code)}${signal ? ` (${signal})` : ''}`));
    });
  });
}
