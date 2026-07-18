import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const viewerRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(viewerRoot, '../../..');
const outputRoot = path.join(repoRoot, 'target/viewer-kernel-e2e');
const wasmRoot = path.join(outputRoot, 'wasm');
const decodeWasmRoot = path.join(outputRoot, 'decode-wasm');
const screenshots = path.join(outputRoot, 'screenshots');
const preparedTexturedFixtureRoot = path.join(outputRoot, 'prepared-textured-fixture');
const cargo = '/home/oem/.cargo/bin/cargo';
const bindgen = '/home/oem/.cargo/bin/wasm-bindgen';
const esbuild = path.join(repoRoot, 'node_modules/.pnpm/node_modules/.bin/esbuild');
const forceWebGl2 = process.env.HCAD_WEBGL2 === '1' || process.argv.includes('--webgl2');
const forceWebGpu = process.argv.includes('--webgpu');
const realData = process.argv.includes('--real');
let backendLabel = `${forceWebGl2 ? 'webgl2' : forceWebGpu ? 'webgpu' : 'automatic'}${realData ? '-real' : ''}`;
const realFixtureFiles = new Set([
  'TextureCoordinateTest.glb',
  'tileset.json',
  'buildings.b3dm',
  'instances.i3dm',
  'external-tileset.json',
  'external-instances.i3dm',
  'box.glb',
  'batch-table-hierarchy.b3dm',
  'point-cloud-per-point-properties.pnts',
]);

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const checksumInput = Buffer.concat([typeBytes, data]);
  let crc = 0xffff_ffff;
  for (const byte of checksumInput) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb8_8320 & -(crc & 1));
    }
  }
  const chunk = Buffer.allocUnsafe(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE((crc ^ 0xffff_ffff) >>> 0, 8 + data.byteLength);
  return chunk;
}

function checkerPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.from([
    0, 255, 210, 40, 255, 40, 110, 255, 255, 0, 40, 110, 255, 255, 255, 210, 40, 255,
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function screenshotPixel(png, x, y) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let width = 0;
  let height = 0;
  let channels = 0;
  const compressed = [];
  for (let offset = 8; offset < png.byteLength; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'browser screenshot must use 8-bit PNG samples');
      assert.equal(data[12], 0, 'browser screenshot must not be interlaced');
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      assert(channels !== 0, `unsupported browser screenshot PNG color type ${String(data[9])}`);
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  assert(x >= 0 && x < width && y >= 0 && y < height);
  const encoded = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const decoded = Buffer.alloc(stride * height);
  const paeth = (left, up, upperLeft) => {
    const prediction = left + up - upperLeft;
    const leftDistance = Math.abs(prediction - left);
    const upDistance = Math.abs(prediction - up);
    const upperLeftDistance = Math.abs(prediction - upperLeft);
    return leftDistance <= upDistance && leftDistance <= upperLeftDistance
      ? left
      : upDistance <= upperLeftDistance
        ? up
        : upperLeft;
  };
  for (let row = 0; row < height; row += 1) {
    const filter = encoded[row * (stride + 1)];
    for (let column = 0; column < stride; column += 1) {
      const source = encoded[row * (stride + 1) + 1 + column];
      const outputIndex = row * stride + column;
      const left = column >= channels ? decoded[outputIndex - channels] : 0;
      const up = row > 0 ? decoded[outputIndex - stride] : 0;
      const upperLeft =
        row > 0 && column >= channels ? decoded[outputIndex - stride - channels] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : filter === 4
                  ? paeth(left, up, upperLeft)
                  : Number.NaN;
      assert(
        Number.isFinite(predictor),
        `unsupported browser screenshot PNG filter ${String(filter)}`,
      );
      decoded[outputIndex] = (source + predictor) & 0xff;
    }
  }
  const offset = y * stride + x * channels;
  return [
    decoded[offset],
    decoded[offset + 1],
    decoded[offset + 2],
    channels === 4 ? decoded[offset + 3] : 255,
  ];
}

function externalJsonGltfFixtures() {
  const mesh = new Uint8Array(68);
  const view = new DataView(mesh.buffer);
  [-1, 0, -1, 1, 0, -1, 0, 0, 1].forEach((value, index) => view.setFloat32(index * 4, value, true));
  [0, 0, 1, 0, 0.5, 1].forEach((value, index) => view.setFloat32(36 + index * 4, value, true));
  [0, 1, 2].forEach((value, index) => view.setUint16(60 + index * 2, value, true));
  const image = checkerPng();
  const schema = Buffer.from(
    JSON.stringify({
      id: 'external-browser-schema',
      classes: { surface: { properties: {} } },
    }),
  );
  const document = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0', generator: 'HimmelCAD external-resource browser gate' },
      extensionsUsed: ['EXT_structural_metadata'],
      extensions: { EXT_structural_metadata: { schemaUri: 'metadata.schema.json' } },
      buffers: [{ uri: 'mesh.bin', byteLength: mesh.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
        { buffer: 0, byteOffset: 36, byteLength: 24, target: 34962 },
        { buffer: 0, byteOffset: 60, byteLength: 6, target: 34963 },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [-1, 0, -1],
          max: [1, 0, 1],
        },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2', min: [0, 0], max: [1, 1] },
        { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
      images: [{ uri: 'checker.png', mimeType: 'image/png' }],
      samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
      textures: [{ sampler: 0, source: 0 }],
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorTexture: { index: 0, texCoord: 0 },
            metallicFactor: 0,
            roughnessFactor: 1,
          },
          doubleSided: true,
        },
      ],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0, TEXCOORD_0: 1 },
              indices: 2,
              material: 0,
              mode: 4,
            },
          ],
        },
      ],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    }),
  );
  return new Map([
    ['/fixtures/external-json/model.gltf', { bytes: document, contentType: 'model/gltf+json' }],
    ['/fixtures/external-json/mesh.bin', { bytes: mesh, contentType: 'application/octet-stream' }],
    ['/fixtures/external-json/checker.png', { bytes: image, contentType: 'image/png' }],
    [
      '/fixtures/external-json/metadata.schema.json',
      { bytes: schema, contentType: 'application/json' },
    ],
  ]);
}

const virtualFixtureFiles = externalJsonGltfFixtures();

await mkdir(wasmRoot, { recursive: true });
await mkdir(decodeWasmRoot, { recursive: true });
await mkdir(screenshots, { recursive: true });
if (realData) {
  await run('node', [path.join(repoRoot, 'scripts/fetch-viewer-real-fixtures.mjs')]);
  await run(cargo, [
    'run',
    '-p',
    'himmelcad-sidecar',
    '--example',
    'prepared_textured_mesh_fixture',
    '--',
    preparedTexturedFixtureRoot,
  ]);
}
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
  path.join(here, 'main.ts'),
  '--bundle',
  '--format=esm',
  '--target=es2022',
  '--external:/wasm/*',
  `--outfile=${path.join(outputRoot, 'bundle.js')}`,
]);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const virtualFixture = realData ? virtualFixtureFiles.get(pathname) : undefined;
    if (virtualFixture !== undefined) {
      response.writeHead(200, {
        'Content-Type': virtualFixture.contentType,
        'Cache-Control': 'no-store',
      });
      response.end(virtualFixture.bytes);
      return;
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
                : realData &&
                    pathname.startsWith('/fixtures/') &&
                    realFixtureFiles.has(path.basename(pathname))
                  ? path.join(repoRoot, 'target/viewer-real-fixtures', path.basename(pathname))
                  : realData && pathname.startsWith('/fixtures/prepared-textured/')
                    ? path.join(
                        preparedTexturedFixtureRoot,
                        pathname.slice('/fixtures/prepared-textured/'.length),
                      )
                    : null;
    if (file === null || !(await isFile(file))) {
      response.writeHead(404).end('not found');
      return;
    }
    const contentType = file.endsWith('.wasm')
      ? 'application/wasm'
      : file.endsWith('.glb')
        ? 'model/gltf-binary'
        : file.endsWith('.gltf')
          ? 'model/gltf+json'
          : file.endsWith('.png')
            ? 'image/png'
            : file.endsWith('.js')
              ? 'text/javascript; charset=utf-8'
              : 'text/html; charset=utf-8';
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    response.end(await readFile(file));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: process.env.HCAD_HEADLESS === '1' || !process.env.DISPLAY,
  // Chromium's headless Vulkan surface is unavailable on some otherwise fully
  // accelerated Linux hosts. Let Dawn select the real adapter instead of
  // forcing a backend; the captured capability report records what was used.
  args: forceWebGl2 ? ['--disable-webgpu'] : ['--enable-unsafe-webgpu'],
});

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  const browserErrors = [];
  const browserMessages = [];
  page.on('console', (message) => {
    browserMessages.push(`${message.type()}: ${message.text()}`);
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.stack ?? error.message));
  const query = new URLSearchParams();
  if (forceWebGl2) query.set('backend', 'webgl2');
  if (forceWebGpu) query.set('backend', 'webgpu');
  if (realData) query.set('real', '1');
  const backendQuery = query.size === 0 ? '' : `?${query.toString()}`;
  await page.goto(`http://127.0.0.1:${String(address.port)}/${backendQuery}`, {
    waitUntil: 'load',
  });
  try {
    await page.waitForFunction(
      () => window.__HCAD_E2E__?.ready || window.__HCAD_E2E__?.error,
      null,
      {
        timeout: forceWebGl2 ? 30_000 : 120_000,
      },
    );
  } catch (error) {
    const timedOutState = await page.evaluate(() => window.__HCAD_E2E__);
    console.error(JSON.stringify({ timedOutState, browserMessages }, null, 2));
    throw error;
  }
  const state = await page.evaluate(() => window.__HCAD_E2E__);
  assert(state);
  assert.equal(state.error, null, [state.error, ...browserMessages].filter(Boolean).join('\n'));
  assert.equal(state.ready, true);
  // Real mode adds nine entities: one glTF, two shared external i3dm owners,
  // two transformed tiles, two external JSON glTFs and two legacy-metadata fixtures.
  // The canonical zoo also includes one immutable entity-reference block plus
  // the planar and pinhole oriented-image contracts.
  assert.equal(state.entityCount, realData ? 39 : 30);
  assert(
    state.proxyCount >= 24,
    `expected mixed inline and provider render proxies, received ${String(state.proxyCount)}`,
  );
  if (forceWebGl2) assert.equal(state.capabilities?.backend, 'webGl2');
  else if (forceWebGpu) assert.equal(state.capabilities?.backend, 'webGpu');
  else {
    assert(['webGl2', 'webGpu'].includes(state.capabilities?.backend));
    assert.notEqual(
      state.capabilities?.backend === 'webGpu' && state.capabilities?.deviceKind === 'cpu',
      true,
      'automatic backend must not select unreliable fallback-adapter WebGPU',
    );
  }
  backendLabel = `${state.capabilities?.backend === 'webGl2' ? 'webgl2' : 'webgpu'}${realData ? '-real' : ''}`;
  assert.equal(state.frameDurationsMs.length, 30);
  assert(state.frameDurationsMs.every(Number.isFinite));
  const timestampSupported = state.capabilities?.features?.includes('timestampQueries') === true;
  assert.equal(state.gpuFrameTiming?.supported, timestampSupported);
  if (timestampSupported) {
    assert(
      state.gpuFrameTiming.completedSamples > 0 && state.gpuFrameTiming.latestGpuMs > 0,
      `supported GPU timestamps must complete asynchronously: ${JSON.stringify(state.gpuFrameTiming)}`,
    );
    assert.equal(state.pickFrameTiming?.before?.failedReadbacks, 0);
    assert.equal(state.pickFrameTiming?.after?.failedReadbacks, 0);
    assert.equal(state.pickFrameTiming?.after?.pendingReadbacks, 0);
    assert(
      state.pickFrameTiming.after.completedSamples >= state.pickFrameTiming.before.completedSamples,
      `pick must collect completed timing maps before its own readback: ${JSON.stringify(state.pickFrameTiming)}`,
    );
    if (state.pickFrameTiming.before.pendingReadbacks > 0) {
      assert(
        state.pickFrameTiming.after.pendingReadbacks <
          state.pickFrameTiming.before.pendingReadbacks,
        `pick must drain pending timing maps: ${JSON.stringify(state.pickFrameTiming)}`,
      );
    }
  } else {
    assert.equal(state.gpuFrameTiming?.latestGpuMs, null);
    assert.equal(state.gpuFrameTiming?.completedSamples, 0);
  }
  assert(state.hardwarePolicy && state.hardwarePolicy.resources.gpuBufferBytes > 0);
  assert.equal(state.calibration?.completedSamples, state.calibration?.totalSamples);
  assert(state.calibration?.calibration?.uploadGibPerSecond > 0);
  assert.equal(state.tilesMetadata?.schemaUri, 'https://example.test/metadata/city.schema.json');
  assert.equal(state.tilesMetadata?.tileset?.properties?.epoch, 2025.5);
  assert.equal(state.tilesMetadata?.groups?.[0]?.properties?.name, 'survey');
  assert.equal(state.gltfFeatureMetadata?.resolved?.featureSets?.[0]?.resolved?.id, 1);
  assert.equal(
    state.gltfFeatureMetadata?.resolved?.featureSets?.[0]?.propertyTableDefinition?.class,
    'building',
  );
  assert.deepEqual(state.gltfFeatureMetadata?.resolved?.featureSets?.[0]?.propertyRow, {
    height: 27.25,
    name: 'tower',
  });
  assert.equal(state.gltfFeatureMetadata?.resolved?.featureSets?.[1]?.binding?.kind, 'texture');
  assert.equal(state.gltfFeatureMetadata?.resolved?.featureSets?.[1]?.resolved?.id, 1);
  assert.deepEqual(state.gltfFeatureMetadata?.resolved?.featureSets?.[1]?.propertyRow, {
    height: 27.25,
    name: 'tower',
  });
  assert.deepEqual(
    state.gltfFeatureMetadata?.resolved?.propertyAttributes?.[0]?.sourceVertexIndices,
    [0, 1, 2],
  );
  assert.deepEqual(
    state.gltfFeatureMetadata?.resolved?.propertyAttributes?.[0]?.properties?.temperature
      ?.vertexValues,
    [21, 41, 61],
  );
  assert.equal(
    state.gltfFeatureMetadata?.resolved?.propertyAttributes?.[0]?.properties?.temperature?.value,
    21,
  );
  assert.equal(
    state.gltfFeatureMetadata?.resolved?.propertyAttributes?.[0]?.properties?.classification?.value,
    'ground',
  );
  assert.equal(
    state.gltfFeatureMetadata?.resolved?.propertyTextures?.[0]?.properties?.surfaceCode?.value,
    3,
  );
  assert.deepEqual(
    state.gltfFeatureMetadata?.resolved?.propertyTextures?.[0]?.properties?.flags?.value,
    [true, true],
  );
  assert.equal(
    state.gltfFeatureMetadata?.resolved?.structuralMetadata?.schema?.id,
    'browser-feature-test',
  );
  assert.equal(
    state.gltfFeatureMetadata?.evicted,
    true,
    'feature metadata must share atomic proxy eviction',
  );
  assert(state.syntheticPointMetadata, 'synthetic pnts must round-trip one actual GPU point pick');
  const syntheticPoint = state.syntheticPointMetadata.metadata.providers.legacy;
  assert.equal(syntheticPoint?.provider, 'pnts');
  assert.equal(syntheticPoint?.source.kind, 'point');
  assert.equal(syntheticPoint?.source.pointIndex, 0);
  assert.equal(syntheticPoint?.featureId, 0);
  assert.deepEqual(syntheticPoint?.directRow, { name: 'synthetic-point' });
  assert.deepEqual(syntheticPoint?.resolvedRow, syntheticPoint?.directRow);
  assert(Array.isArray(state.pick?.candidates) && state.pick.candidates.length > 0);
  assert.equal(
    state.originRebase?.generationStable,
    true,
    'origin-only rebase must retain RenderWorld generation',
  );
  assert(state.streamDecodeRebuild, 'stream decode rebuild diagnostics must be captured');
  assert(state.presentationBindings, 'resolved presentation bindings must be exercised');
  assert.equal(state.presentationBindings.invalidAreaTextureRejectedAtomically, true);
  assert.equal(state.presentationBindings.invalidStrokeRejectedAtomically, true);
  assert.equal(state.presentationBindings.decodeCountersStable, true);
  assert.equal(state.presentationBindings.proxyIdentityStable, true);
  assert.deepEqual(state.presentationBindings.materialTextureResidency, {
    allocations: 5,
    retainedAllocations: 5,
    owners: 5,
    stagedOwners: 0,
    gpuTextureBytes: 80,
    decodedSources: 0,
    factoryCalls: 5,
  });
  assert.deepEqual(
    state.presentationBindings.canonicalMaterials.map((batch) => batch.sourceMaterialSlot),
    [3, 7],
  );
  assert(
    state.presentationBindings.canonicalMaterials.every(
      (batch) => batch.declaredTextureCoordinates && batch.usesSourceTexture,
    ),
    'canonical material batches must retain authored UV and source-texture bindings',
  );
  assert.deepEqual(
    state.presentationBindings.canonicalMaterials.map(
      (batch) => batch.sourceMaterialDoubleSided,
    ),
    [false, true],
  );
  assert.deepEqual(
    state.presentationBindings.canonicalMaterials.map((batch) => batch.sourcePbrTextureFlags),
    [0, 15],
  );
  assert(
    Math.abs(state.presentationBindings.canonicalMaterials[1].sourcePbr.metallic - 0.7) < 1e-6,
  );
  assert(
    Math.abs(state.presentationBindings.canonicalMaterials[1].sourcePbr.roughness - 0.55) < 1e-6,
  );
  assert.equal(state.presentationBindings.canonicalMaterials[1].sourcePbrUvRows.length, 10);
  assert.deepEqual(
    [0, 2, 4, 6, 8].map(
      (row) => state.presentationBindings.canonicalMaterials[1].sourcePbrUvRows[row][3],
    ),
    [0, 0, 0, 7, 0],
  );
  assert.equal(state.canonicalDocument?.generation, 3);
  assert.equal(state.canonicalDocument?.journalEntries, 3);
  assert.equal(state.canonicalDocument?.restoredName, state.canonicalDocument?.replayedName);
  assert(
    state.presentationBindings.hatchAfterLiveStyle.some(
      (batch) => batch.kind === 'cadFill' && batch.hatchEnabled && batch.fillVisible,
    ),
    'live area style changes must preserve a resolved hatch',
  );
  assert(
    state.presentationBindings.none.some((batch) => batch.kind === 'cadFill' && !batch.fillVisible),
    'fill none must suppress fill fragments',
  );
  assert(
    state.presentationBindings.strokeLineType.some(
      (batch) =>
        batch.kind === 'cadStroke' &&
        batch.strokeVisible &&
        batch.strokeWidthOverride === 7 &&
        batch.lineTypeComponents === 4,
    ),
    'live stroke line type must resolve independently on the CAD boundary batch',
  );
  assert(
    state.presentationBindings.strokeNone.some(
      (batch) => batch.kind === 'cadStroke' && !batch.strokeVisible,
    ),
    'stroke none must hide the boundary without removing its batch',
  );
  assert(
    state.presentationBindings.textureOverride.every(
      (batch) => batch.declaredTextureCoordinates && !batch.usesSourceTexture,
    ),
    'mapped raster batches must bind the selected presentation texture',
  );
  assert(
    state.presentationBindings.textureRestored.every((batch) => batch.usesSourceTexture),
    'leaving texture fill must restore immutable source textures',
  );
  assert.equal(state.authoritativeClipCap?.compiled, true);
  assert.equal(state.authoritativeClipCap?.clippedVolumeId, 'authoritative-streamed-cap-box');
  assert.equal(state.authoritativeClipCap?.planeIndex, 0);
  assert.equal(state.authoritativeOpenTin?.segments, 2);
  assert.equal(state.authoritativeOpenTin?.regions, 0);
  assert.equal(state.authoritativeOpenTin?.sourceParts, 2);
  assertWorldClose(
    state.authoritativeOpenTin?.projectBounds.minimum,
    { x: 6378138.125, y: 5400004.25, z: 513.25 },
    1e-9,
  );
  assertWorldClose(
    state.authoritativeOpenTin?.projectBounds.maximum,
    { x: 6378138.125, y: 5400012.25, z: 516.75 },
    1e-9,
  );
  assert.deepEqual(
    state.streamDecodeRebuild.after,
    state.streamDecodeRebuild.before,
    'entity transactions, style, origin, clip and section mutations must not invoke provider decoders',
  );
  assert(state.alignmentPreview, 'partitioned Civil alignment preview must be built');
  assert.equal(state.alignmentPreview.initial.generation, 0);
  assert.equal(state.alignmentPreview.initial.partitionCount, 3);
  assert.equal(state.alignmentPreview.initial.changedPartitions.length, 3);
  assert.equal(state.alignmentPreview.initial.workload.partitions, 3);
  assert(state.alignmentPreview.initial.changedProxyIds.length >= 3);
  assert(state.decodeWorker, 'real transferable decode-worker proof must complete');
  assert.equal(state.decodeWorker.workerContext, true);
  assert.equal(state.decodeWorker.eventLoopTickedBeforeCompletion, true);
  assert.equal(state.decodeWorker.artifactMagic, 'HCDECODE');
  assert(state.decodeWorker.artifactBytes > 0);
  assert(state.decodeWorker.inputBytes > 1_000_000);
  assert(state.decodeWorker.diagnostics.actualDecodeWorkers >= 1);
  assert(state.decodeWorker.diagnostics.actualDecodeWorkers <= 2);
  assert(state.decodeWorker.diagnostics.maximumWorkerBaselineLinearMemoryBytes > 0);
  assert(
    state.decodeWorker.diagnostics.maximumWorkerLinearMemoryBytes >=
      state.decodeWorker.diagnostics.maximumWorkerBaselineLinearMemoryBytes,
  );
  assert(state.decodeWorker.diagnostics.perWorkerReservationBytes >= 256 * 1024 * 1024);
  assert(
    state.pick.candidates.length < 40,
    'Tab stack must not expose one entry per covered pixel',
  );
  const cadSnaps = state.pick.candidates.filter(
    (candidate) => candidate.address.entityId === 'clothoid',
  );
  assert(
    cadSnaps.some((candidate) => candidate.snapKind === 'edge'),
    JSON.stringify(state.pick.candidates),
  );
  assert(
    cadSnaps
      .filter((candidate) => candidate.snapKind === 'midpoint')
      .every((candidate) => candidate.address.primitiveId >= 2 ** 32),
    'clothoid midpoints must come from semantic authored/evaluated snaps, never render segments',
  );
  assert(
    cadSnaps
      .filter((candidate) => candidate.snapKind === 'vertex')
      .every((candidate) => candidate.address.primitiveId >= 2 ** 32),
    'clothoid vertices must come from semantic authored/evaluated snaps, never render segments',
  );
  const exactPoint = state.exactPointPick?.candidates.find(
    (candidate) => candidate.address.entityId === 'survey-point' && candidate.snapKind === 'point',
  );
  assert(exactPoint, JSON.stringify(state.exactPointPick));
  assert.equal(exactPoint.address.primitiveId, 0);
  assert.equal(exactPoint.worldPosition.x, 6378137.125);
  assert.equal(exactPoint.worldPosition.y, 5400000.25);
  assert.equal(exactPoint.worldPosition.z, 516.75);
  const panoramaMarker = state.panoramaMarkerPick?.candidates.find(
    (candidate) =>
      candidate.address.entityId === 'scan-panorama' &&
      candidate.snapKind === 'point' &&
      candidate.address.primitiveId === 0,
  );
  assert(
    panoramaMarker,
    `panorama must be an exact station marker in the main view: ${JSON.stringify(state.panoramaMarkerPick)}`,
  );
  assertWorldClose(
    panoramaMarker.worldPosition,
    { x: 6_378_155.125, y: 5_399_990.25, z: 516.75 },
    1e-7,
  );
  assert(
    state.panoramaMarkerPick.candidates
      .filter((candidate) => candidate.address.entityId === 'scan-panorama')
      .every((candidate) => candidate.snapKind === 'point'),
    'panorama depth must not appear as an implicit main-view surface',
  );
  const panoramaMeasurement = state.panoramaDepthMeasurement;
  assert(panoramaMeasurement, 'panorama depth measurement must resolve through the shared kernel');
  assert.equal(panoramaMeasurement.entityId, 'scan-panorama');
  assert.equal(panoramaMeasurement.column, 3);
  assert.equal(panoramaMeasurement.row, 1);
  assert.equal(panoramaMeasurement.depth, 3);
  assert(Math.abs(panoramaMeasurement.confidence - 26 / 255) < 1e-12);
  const longitude = ((3.5 / 8) - 0.5) * Math.PI * 2;
  const latitude = ((1.5 / 4) - 0.5) * Math.PI;
  assertWorldClose(
    panoramaMeasurement.sourcePosition,
    {
      x: 6_378_155.125 + Math.cos(latitude) * Math.sin(longitude) * 3,
      y: 5_399_990.25 + Math.sin(latitude) * 3,
      z: 516.75 + Math.cos(latitude) * Math.cos(longitude) * 3,
    },
    1e-7,
  );
  const centerHit = state.pick.candidates.find(
    (candidate) =>
      candidate.address.entityId === 'open-surface' &&
      candidate.snapKind === 'surface' &&
      candidate.address.primitiveId === 1,
  );
  assert(
    centerHit,
    `center pixel must resolve the exact source mesh face: ${JSON.stringify(state.pick.candidates)}`,
  );
  assert(centerHit.pixelDistance < 1e-4, 'exact mesh ray hit must project back onto the cursor');
  const centerLocalX = centerHit.worldPosition.x - 6_378_137.125;
  const centerLocalY = centerHit.worldPosition.y - 5_400_000.25;
  const expectedSurfaceZ = 512.75 + 0.5 * (centerLocalX + 3) + 0.25 * (centerLocalY - 4);
  assert(centerLocalX >= -3 && centerLocalX <= 5 && centerLocalY >= 4 && centerLocalY <= 12);
  assert(
    Math.abs(centerHit.worldPosition.z - expectedSurfaceZ) < 1e-7,
    `mesh BVH hit must lie on authoritative source triangle: ${JSON.stringify(centerHit)}`,
  );
  const rebasedCenterHit = state.originRebase?.pick?.candidates?.find(
    (candidate) =>
      candidate.address.entityId === centerHit.address.entityId &&
      candidate.snapKind === centerHit.snapKind &&
      candidate.address.primitiveId === centerHit.address.primitiveId,
  );
  assert(rebasedCenterHit, 'origin-rebased frame must preserve the center hit');
  assert.equal(rebasedCenterHit.address.entityId, centerHit.address.entityId);
  assert(Math.abs(rebasedCenterHit.worldPosition.x - centerHit.worldPosition.x) < 0.002);
  assert(Math.abs(rebasedCenterHit.worldPosition.y - centerHit.worldPosition.y) < 0.002);
  assert(Math.abs(rebasedCenterHit.worldPosition.z - centerHit.worldPosition.z) < 0.002);

  const materializedParcelHit = state.materializedParcelPick?.candidates?.find(
    (candidate) =>
      candidate.address.entityId === 'materialized-xyz-parcel' &&
      candidate.snapKind === 'vertex' &&
      worldClose(candidate.worldPosition, { x: 6_378_193.125, y: 5_399_997.25, z: 518.75 }, 1e-7),
  );
  assert(
    materializedParcelHit,
    `materialized parcel XYZ must remain exact: ${JSON.stringify(state.materializedParcelPick)}`,
  );
  const materializedSurveyHit = state.materializedSurveyPick?.candidates?.find(
    (candidate) =>
      candidate.address.entityId === 'materialized-xyz-parcel' &&
      candidate.snapKind === 'vertex' &&
      worldClose(candidate.worldPosition, { x: 6_378_181.125, y: 5_399_997.25, z: 518.75 }, 1e-7),
  );
  assert(
    materializedSurveyHit,
    `surveyed XYZ road vertex must remain authoritative: ${JSON.stringify(state.materializedSurveyPick)}`,
  );
  const materializedAreaHit = state.materializedAreaPick?.candidates?.find(
    (candidate) =>
      candidate.address.entityId === 'mixed-height-area' &&
      candidate.snapKind === 'vertex' &&
      worldClose(candidate.worldPosition, { x: 6_378_135.125, y: 5_399_992.25, z: 513.5 }, 1e-7),
  );
  assert(
    materializedAreaHit,
    `materialized area revision must drive exact picking: ${JSON.stringify(state.materializedAreaPick)}`,
  );
  const conicMidpointHit = state.conicPick?.candidates?.find(
    (candidate) =>
      candidate.address.entityId === 'rational-conic-arc' &&
      candidate.snapKind === 'midpoint' &&
      worldClose(
        candidate.worldPosition,
        { x: 6_378_109.125, y: 5_399_992.916666667, z: 514.75 },
        1e-7,
      ),
  );
  assert(
    conicMidpointHit,
    `rational conic midpoint must remain analytic: ${JSON.stringify(state.conicPick)}`,
  );
  assert.deepEqual(state.mixedHeightLifecycle, {
    orbitRejected: true,
    planProxyCount: 2,
    materializedRevision: 2,
    sourceStillMissingZ: true,
  });
  const extensionHit = state.extensionPick?.candidates?.find(
    (candidate) =>
      candidate.address.entityId === 'namespaced-extension' &&
      candidate.snapKind === 'surface' &&
      worldClose(candidate.worldPosition, { x: 6_378_112.125, y: 5_400_010.25, z: 517.75 }, 1e-7),
  );
  assert(
    extensionHit,
    `namespaced extension must retain its payload while using the evaluated mesh for exact picking: ${JSON.stringify(state.extensionPick)}`,
  );
  if (realData) {
    assert(state.realGlb, 'checksum-pinned upstream glTF fixture must be resident');
    assert.equal(state.realGlb.publish.cost.triangles, 10);
    assert.equal(
      state.realGlb.publish.cost.gpuTextureBytes,
      0,
      'tile-local cost must exclude globally cached immutable textures',
    );
    assert(
      state.realGlb.publish.uploadedBytes > state.realGlb.publish.cost.gpuBufferBytes,
      'first textured GLB publication must report the shared texture upload',
    );
    const realHit = state.realGlb.pick.candidates.find(
      (candidate) =>
        candidate.address.entityId === 'khronos-texture-coordinate-test' &&
        candidate.snapKind === 'surface',
    );
    assert(
      realHit,
      `upstream textured GLB must return an exact source face: ${JSON.stringify(state.realGlb.pick)}`,
    );
    assert(
      state.realTiles,
      'checksum-pinned upstream transformed 3D Tiles fixture must be resident',
    );
    assert.equal(state.realTiles.rootPublish.cost.triangles, 120);
    assert.equal(state.realTiles.instancePublish.cost.triangles, 300);
    assert.equal(state.realTiles.instancePublish.cost.drawCalls, 1);
    assert(
      state.realTiles.instancePublish.cost.gpuBufferBytes < 10_000,
      `shared i3dm model must not duplicate GPU geometry per instance: ${JSON.stringify(state.realTiles.instancePublish)}`,
    );
    const transformedHit = state.realTiles.rootPick.candidates.find(
      (candidate) =>
        candidate.address.entityId === 'cesium-transformed-buildings' &&
        candidate.snapKind === 'surface',
    );
    assert(
      transformedHit,
      `georeferenced b3dm must return an exact transformed source face: ${JSON.stringify(state.realTiles.rootPick)}`,
    );
    const instanceHit = state.realTiles.instancePick.candidates.find(
      (candidate) =>
        candidate.address.entityId === 'cesium-transformed-instances' &&
        candidate.snapKind === 'surface',
    );
    assert(
      instanceHit,
      `georeferenced i3dm must return an exact transformed instance face: ${JSON.stringify(state.realTiles.instancePick)}`,
    );
    assert.equal(state.realTiles.instanceMetadata?.instance?.index, 12);
    assert.equal(state.realTiles.instanceMetadata?.instance?.featureId, 12);
    assert.equal(state.realTiles.instanceMetadata?.instance?.batchLength, 25);
    assert(
      state.realLegacyMetadata,
      'checksum-pinned hierarchy and pnts metadata fixtures must be resident',
    );
    const hierarchy = state.realLegacyMetadata.hierarchyMetadata.providers.legacy;
    assert.equal(hierarchy?.provider, 'b3dm');
    assert.equal(hierarchy?.source.kind, 'triangle');
    assert(Number.isSafeInteger(hierarchy?.featureId));
    assert(hierarchy?.directRow && typeof hierarchy.directRow === 'object');
    assert(hierarchy?.resolvedRow && Object.keys(hierarchy.resolvedRow).length > 0);
    assert(hierarchy?.hierarchy, 'b3dm hierarchy provenance must be retained at the exact pick');
    assert.equal(typeof hierarchy.hierarchy.exactInstance.className, 'string');
    assert(hierarchy.hierarchy.ancestors.length > 0);
    const point = state.realLegacyMetadata.pointMetadata.providers.legacy;
    assert.equal(point?.provider, 'pnts');
    assert.equal(point?.source.kind, 'point');
    assert.equal(point?.featureId, point?.source.pointIndex);
    assert(point?.directRow && Object.keys(point.directRow).length > 0);
    assert.deepEqual(point?.resolvedRow, point?.directRow);
    assert.equal(point?.hierarchy, null);
    assert.equal(state.realLegacyMetadata.pointMetadata.barycentric, null);
    assert(state.realExternal, 'checksum-pinned external-i3dm fixture must be resident');
    assert.equal(state.realExternal.dependencyCount, 1);
    assert.equal(state.realExternal.bundleBytes, 3284);
    assert.equal(state.realExternal.publish.cost.cpuCompressedBytes, 504);
    assert.equal(
      state.realExternal.publish.cost.cpuCompressedBytes + state.realExternal.bundleBytes,
      3788,
      'external i3dm transport bytes must include the tile plus its separately shared bundle',
    );
    assert.equal(state.realExternal.publish.cost.triangles, 300);
    assert.equal(state.realExternal.publish.cost.drawCalls, 1);
    assert.equal(state.realExternal.sharedGpuModels.allocations, 1);
    assert(state.realExternal.sharedGpuModels.owners >= 2);
    assert(state.realExternal.sharedGpuModels.gpuBufferBytes > 0);
    assert(
      state.realExternal.publish.cost.gpuBufferBytes < 10_000,
      `external i3dm must retain one shared model upload: ${JSON.stringify(state.realExternal.publish)}`,
    );
    const externalHit = state.realExternal.pick.candidates.find(
      (candidate) =>
        candidate.address.entityId === 'cesium-external-instances' &&
        candidate.snapKind === 'surface',
    );
    assert(
      externalHit,
      `external i3dm must return an exact source face: ${JSON.stringify(state.realExternal.pick)}`,
    );
    assert(state.realExternalJson, 'external JSON glTF fixture must be resident');
    assert.deepEqual(
      state.realExternalJson.dependencies.map(({ ownerUri, sourceUri, kind }) => ({
        ownerUri,
        sourceUri,
        kind,
      })),
      [
        { ownerUri: '/fixtures/external-json/model.gltf', sourceUri: 'mesh.bin', kind: 'buffer' },
        { ownerUri: '/fixtures/external-json/model.gltf', sourceUri: 'checker.png', kind: 'image' },
        {
          ownerUri: '/fixtures/external-json/model.gltf',
          sourceUri: 'metadata.schema.json',
          kind: 'schema',
        },
      ],
    );
    assert.equal(
      state.realExternalJson.publish.cost.cpuCompressedBytes,
      state.realExternalJson.primaryBytes,
      'tile-local external JSON glTF residency must exclude globally shared bundle bytes',
    );
    assert(
      state.realExternalJson.primaryBytes + state.realExternalJson.bundleBytes >
        state.realExternalJson.primaryBytes,
      'external JSON glTF transport must include its separately packed resource bundle',
    );
    assert.equal(state.realExternalJson.publish.cost.triangles, 1);
    assert.equal(state.realExternalJson.publish.cost.gpuTextureBytes, 0);
    assert(
      state.realExternalJson.publish.uploadedBytes >
        state.realExternalJson.publish.cost.gpuBufferBytes,
      'first external textured glTF publication must report its shared texture upload',
    );
    assert.equal(
      state.realExternalJson.structuralMetadata?.schema?.id,
      'external-browser-schema',
      `external structural-metadata schema must survive materialization: ${JSON.stringify(state.realExternalJson.structuralMetadata)}`,
    );
    const externalJsonHit = state.realExternalJson.pick.candidates.find(
      (candidate) =>
        candidate.address.entityId === 'external-json-textured-triangle' &&
        candidate.snapKind === 'surface' &&
        worldClose(
          candidate.worldPosition,
          {
            x: 6_378_093.125,
            y: 5_400_024.25,
            z: 518.75,
          },
          1e-7,
        ),
    );
    assert(
      externalJsonHit,
      `external JSON glTF must return its exact source face: ${JSON.stringify(state.realExternalJson.pick)}`,
    );
    assert(state.preparedTexturedMesh, 'sidecar-produced prepared textured mesh must be resident');
    assert.deepEqual(
      state.preparedTexturedMesh.dependencies.map(({ ownerUri, sourceUri, kind }) => ({
        ownerUri,
        sourceUri,
        kind,
      })),
      [
        {
          ownerUri: '/fixtures/prepared-textured/tiles/r.gltf',
          sourceUri: 'r.positions.f32',
          kind: 'buffer',
        },
        {
          ownerUri: '/fixtures/prepared-textured/tiles/r.gltf',
          sourceUri: 'r.indices.u32',
          kind: 'buffer',
        },
        {
          ownerUri: '/fixtures/prepared-textured/tiles/r.gltf',
          sourceUri: 'r.texcoords.f32',
          kind: 'buffer',
        },
        {
          ownerUri: '/fixtures/prepared-textured/tiles/r.gltf',
          sourceUri: '../texture.png',
          kind: 'image',
        },
      ],
    );
    assert.equal(state.preparedTexturedMesh.publish.cost.triangles, 2);
    assert.equal(state.preparedTexturedMesh.publish.cost.drawCalls, 2);
    assert.equal(state.preparedTexturedMesh.publish.cost.gpuTextureBytes, 0);
    assert(
      state.preparedTexturedMesh.publish.uploadedBytes >
        state.preparedTexturedMesh.publish.cost.gpuBufferBytes,
      'prepared textured mesh must upload its shared immutable atlas',
    );
    assert(
      state.preparedTexturedMesh.bundleBytes > 0 && state.preparedTexturedMesh.primaryBytes > 0,
      'prepared textured mesh must transport its glTF and immutable resource bundle',
    );
    const preparedTexturedHit = state.preparedTexturedMesh.pick.candidates.find(
      (candidate) =>
        candidate.address.entityId === 'prepared-textured-mesh' &&
        candidate.address.datasetId === 'prepared-textured-mesh' &&
        candidate.address.tileId === 'r' &&
        candidate.snapKind === 'surface' &&
        candidate.address.primitiveId !== null &&
        worldClose(
          candidate.worldPosition,
          {
            x: 6_378_084.625,
            y: 5_400_038.25,
            z: 520.75,
          },
          0.02,
        ),
    );
    assert(
      preparedTexturedHit,
      `prepared textured mesh must return an exact source face: ${JSON.stringify(state.preparedTexturedMesh.pick)}`,
    );
  } else {
    assert.equal(state.realGlb, null);
    assert.equal(state.realTiles, null);
    assert.equal(state.realExternal, null);
    assert.equal(state.realExternalJson, null);
    assert.equal(state.preparedTexturedMesh, null);
  }

  const providerFixtures = state.providerFixtures;
  assert(providerFixtures, 'provider fixture validation must complete');
  assert(state.atomicPublish, 'kernel multi-content publication must complete');
  assert.equal(state.atomicPublish.cost.triangles, 2);
  assert.equal(state.atomicPublish.cost.drawCalls, 2);
  assert(state.crossProviderReplacement, 'cross-provider replacement must complete');
  assert.equal(state.crossProviderReplacement.toMesh.cost.triangles, 1);
  assert.equal(state.crossProviderReplacement.toPotree.cost.points, 1);
  assert.equal(providerFixtures.potree.stage.cpuCompressedBytes, 35);
  assert.equal(providerFixtures.potree.publish.cost.points, 1);
  const potreeProxyId = providerFixtures.potree.publish.streams[0]?.proxyIds[0];
  assert(potreeProxyId, 'canonical Potree publication must return its derived proxy identity');
  const potreeHit = providerFixtures.potree.pick.candidates.find(
    (candidate) =>
      candidate.address.entityId === 'fixture-potree-point' &&
      candidate.address.renderProxyId === potreeProxyId &&
      candidate.address.datasetId === 'fixture-potree' &&
      candidate.address.tileId === 'r' &&
      candidate.address.primitiveId === 0 &&
      candidate.snapKind === 'point',
  );
  assert(potreeHit, 'targeted Potree pick must retain the provider primitive address');
  assertWorldClose(potreeHit.worldPosition, providerFixtures.potree.expectedWorldPosition, 1e-7);
  assert.equal(providerFixtures.potree.metadata.sourcePrimitiveId, 0);
  assert.equal(providerFixtures.potree.metadata.barycentric, null);
  assert.equal(providerFixtures.potree.metadata.providers.gltf, null);
  assert.equal(providerFixtures.potree.metadata.providers.legacy, null);
  assert.equal(providerFixtures.potree.metadata.providers.potree.provider, 'potree');
  const civil = providerFixtures.potree.metadata.providers.potree.metadata;
  assert.equal(civil.datasetId, 'fixture-potree');
  assert.equal(civil.tileId, 'r');
  assert.equal(civil.pointIndex, 0);
  assertWorldClose(civil.worldPosition, providerFixtures.potree.expectedProviderPosition, 1e-7);
  assert.equal(civil.intensity, 32_768);
  assert.equal(civil.classification, 6);
  assert.equal(civil.returnNumber, 2);
  assert.equal(civil.numberOfReturns, 4);
  assert.equal(civil.pointSourceId, 513);
  // Exact color encoded by the pinned PotreeConverter BROTLI Morton/RGB fixture.
  assert.deepEqual(civil.sourceColor, [255, 128, 1, 255]);

  assert.equal(providerFixtures.raster.stage.cpuCompressedBytes, 32);
  assert.equal(providerFixtures.raster.publish.cost.triangles, 6);
  const rasterProxyId = providerFixtures.raster.publish.streams[0]?.proxyIds[0];
  assert(rasterProxyId, 'canonical raster publication must return its derived proxy identity');
  const rasterLowHit = providerFixtures.raster.lowPick.candidates.find(
    (candidate) =>
      candidate.address.entityId === 'fixture-pixel-steps' &&
      candidate.address.renderProxyId === rasterProxyId &&
      candidate.address.datasetId === 'fixture-elevation-raster' &&
      candidate.address.tileId === 'r' &&
      (candidate.address.primitiveId === 0 || candidate.address.primitiveId === 1) &&
      candidate.snapKind === 'rasterSample' &&
      worldClose(candidate.worldPosition, providerFixtures.raster.expectedLowSample, 1e-7),
  );
  assert(rasterLowHit, 'first PixelSteps sample must resolve through primitive 0/1');
  const rasterHighHit = providerFixtures.raster.highPick.candidates.find(
    (candidate) =>
      candidate.address.entityId === 'fixture-pixel-steps' &&
      (candidate.address.primitiveId === 2 || candidate.address.primitiveId === 3) &&
      candidate.snapKind === 'rasterSample' &&
      worldClose(candidate.worldPosition, providerFixtures.raster.expectedHighSample, 1e-7),
  );
  assert(rasterHighHit, 'adjacent PixelSteps sample must resolve through primitive 2/3');
  assert.equal(
    rasterHighHit.worldPosition.z - rasterLowHit.worldPosition.z,
    10,
    'adjacent PixelSteps cells must retain their discontinuous source elevations',
  );
  assert.equal(
    providerFixtures.raster.noDataPick.candidates.some(
      (candidate) => candidate.address.entityId === 'fixture-pixel-steps',
    ),
    false,
    'numeric NoData pixel must not create a pickable raster primitive',
  );

  assert.equal(providerFixtures.surfaceRaster.stage.cpuCompressedBytes, 100);
  assert.equal(providerFixtures.surfaceRaster.publish.cost.triangles, 8);
  assert.equal(providerFixtures.surfaceRaster.publish.cost.gpuTextureBytes, 64);
  const surfaceProxyId = providerFixtures.surfaceRaster.publish.streams[0]?.proxyIds[0];
  assert(surfaceProxyId, 'surface raster publication must return its stable proxy identity');
  const surfaceHit = providerFixtures.surfaceRaster.pick.candidates.find(
    (candidate) =>
      candidate.address.entityId === 'fixture-orthomosaic-surface' &&
      candidate.address.renderProxyId === surfaceProxyId &&
      candidate.address.datasetId === 'fixture-orthomosaic-surface' &&
      candidate.address.tileId === 'r' &&
      worldClose(candidate.worldPosition, providerFixtures.surfaceRaster.expectedSample, 1e-7),
  );
  assert(
    surfaceHit,
    `independent orthomosaic/DEM grids must pick the exact source support surface: ${JSON.stringify(providerFixtures.surfaceRaster.pick)}`,
  );
  assert.equal(providerFixtures.surfaceRaster.unload.removed, true);
  assert(providerFixtures.surfaceRaster.unload.batchesBefore > 0);
  assert.equal(providerFixtures.surfaceRaster.unload.batchesAfter, 0);
  assert.equal(
    providerFixtures.surfaceRaster.unload.pickAfter.candidates.some(
      (candidate) => candidate.address.entityId === 'fixture-orthomosaic-surface',
    ),
    false,
    'combined texture/support residency must disappear atomically on unload',
  );

  assert(providerFixtures.gaussian.stage.cpuCompressedBytes > 0);
  assert.equal(providerFixtures.gaussian.stage.cpuDecodedBytes, 300);
  assert.equal(providerFixtures.gaussian.publish.cost.splats, 3);
  const weightedSplatOit = state.capabilities.features.includes('weightedBlendedOit');
  assert.equal(
    providerFixtures.gaussian.publish.cost.cpuDecodedBytes,
    weightedSplatOit ? 168 : 348,
  );
  if (weightedSplatOit) {
    assert.deepEqual(providerFixtures.gaussian.positiveSideOrder, []);
    assert.deepEqual(providerFixtures.gaussian.negativeSideOrder, []);
  } else {
    assert.deepEqual(providerFixtures.gaussian.positiveSideOrder, [[0, 1, 2]]);
    assert.deepEqual(providerFixtures.gaussian.negativeSideOrder, [[2, 1, 0]]);
  }
  const gaussianProxyId = providerFixtures.gaussian.publish.streams[0]?.proxyIds[0];
  assert(gaussianProxyId, 'canonical Gaussian publication must return its derived proxy identity');
  const gaussianMeanHit = providerFixtures.gaussian.meanPick.candidates.find(
    (candidate) =>
      candidate.address.entityId === 'fixture-gaussian-mean' &&
      candidate.address.renderProxyId === gaussianProxyId &&
      candidate.address.datasetId === 'fixture-gaussian-splat' &&
      candidate.address.tileId === 'r' &&
      candidate.address.primitiveId === 1 &&
      candidate.snapKind === 'point',
  );
  assert(
    gaussianMeanHit,
    `Gaussian mean pick must retain its source primitive address: ${JSON.stringify(providerFixtures.gaussian.meanPick)}`,
  );
  assertWorldClose(gaussianMeanHit.worldPosition, providerFixtures.gaussian.expectedMean, 1e-7);
  const gaussianCoverageHit = providerFixtures.gaussian.coveragePick.candidates.find(
    (candidate) =>
      candidate.address.entityId === 'fixture-gaussian-mean' &&
      candidate.address.renderProxyId === gaussianProxyId &&
      candidate.address.primitiveId === 1 &&
      candidate.snapKind === 'surface',
  );
  assert(gaussianCoverageHit, 'offset cursor must resolve the same Gaussian primitive coverage');
  assertWorldClose(
    gaussianCoverageHit.worldPosition,
    providerFixtures.gaussian.expectedCoverage,
    1e-7,
  );
  assert.equal(browserErrors.length, 0, browserErrors.join('\n'));

  if (realData) {
    await page.evaluate(() => window.__HCAD_FOCUS_REAL__?.());
    await page.waitForTimeout(100);
    await page.screenshot({
      path: path.join(screenshots, `real-textured-glb-${backendLabel}.png`),
    });
    await page.evaluate(() => window.__HCAD_RESET_CAMERA__?.());
    await page.evaluate(() => window.__HCAD_FOCUS_REAL_TILES__?.());
    await page.waitForTimeout(100);
    await page.screenshot({
      path: path.join(screenshots, `real-transformed-tiles-${backendLabel}.png`),
    });
    await page.evaluate(() => window.__HCAD_RESET_CAMERA__?.());
    await page.evaluate(() => window.__HCAD_FOCUS_REAL_EXTERNAL__?.());
    await page.waitForTimeout(100);
    await page.screenshot({
      path: path.join(screenshots, `real-external-i3dm-${backendLabel}.png`),
    });
    await page.evaluate(() => window.__HCAD_RESET_CAMERA__?.());
    await page.evaluate(() => window.__HCAD_FOCUS_REAL_EXTERNAL_JSON__?.());
    await page.waitForTimeout(100);
    const externalJsonScreenshot = await page.screenshot({
      path: path.join(screenshots, `real-external-json-gltf-${backendLabel}.png`),
    });
    const externalJsonYellow = screenshotPixel(externalJsonScreenshot, 550, 270);
    const externalJsonBlue = screenshotPixel(externalJsonScreenshot, 730, 270);
    assert(
      externalJsonYellow[0] >= 200 &&
        externalJsonYellow[1] >= 100 &&
        externalJsonYellow[2] < 80 &&
        externalJsonBlue[2] >= 200 &&
        externalJsonBlue[0] < 80,
      `external JSON glTF texture must preserve its yellow/blue texels on ${backendLabel}: ${JSON.stringify({ externalJsonYellow, externalJsonBlue })}`,
    );
    await page.evaluate(() => window.__HCAD_RESET_CAMERA__?.());
    await page.evaluate(() => window.__HCAD_FOCUS_PREPARED_TEXTURED__?.());
    await page.waitForTimeout(100);
    const preparedTexturedScreenshot = await page.screenshot({
      path: path.join(screenshots, `prepared-textured-mesh-${backendLabel}.png`),
    });
    const preparedYellow = screenshotPixel(preparedTexturedScreenshot, 550, 360);
    const preparedBlue = screenshotPixel(preparedTexturedScreenshot, 730, 360);
    assert(
      preparedYellow[0] >= 200 &&
        preparedYellow[1] >= 100 &&
        preparedYellow[2] < 100 &&
        preparedBlue[2] >= 180 &&
        preparedBlue[0] < 100,
      `prepared textured mesh must preserve its generated atlas on ${backendLabel}: ${JSON.stringify({ preparedYellow, preparedBlue })}`,
    );
    await page.evaluate(() => window.__HCAD_RESET_CAMERA__?.());
  }

  await page.evaluate(() => window.__HCAD_FOCUS_ALIGNMENT_PREVIEW__?.());
  await page.waitForTimeout(100);
  const alignmentBefore = await page.screenshot({
    path: path.join(screenshots, `alignment-preview-${backendLabel}-before.png`),
  });
  const alignmentUpdate = await page.evaluate(() => window.__HCAD_UPDATE_ALIGNMENT_PREVIEW__?.());
  assert(alignmentUpdate, 'alignment preview update hook must return its committed revision');
  assert.equal(alignmentUpdate.updated?.generation, 1);
  assert.equal(alignmentUpdate.updated?.parentIdentity, alignmentUpdate.initial.identity);
  assert.equal(alignmentUpdate.updated?.changedPartitions.length, 1);
  assert.equal(alignmentUpdate.updated?.workload.partitions, 1);
  assert(alignmentUpdate.updated?.changedProxyIds.length >= 1);
  assert.equal(alignmentUpdate.staleRejected, true);
  assert.equal(alignmentUpdate.staleGenerationStable, true);
  await page.waitForTimeout(100);
  const alignmentAfter = await page.screenshot({
    path: path.join(screenshots, `alignment-preview-${backendLabel}-after.png`),
  });
  assert.notDeepEqual(
    alignmentAfter,
    alignmentBefore,
    'localized width-band edit must visibly replace the changed alignment partition',
  );
  assert.equal(await page.evaluate(() => window.__HCAD_REMOVE_ALIGNMENT_PREVIEW__?.()), true);
  await page.waitForTimeout(100);
  const alignmentRemoved = await page.screenshot({
    path: path.join(screenshots, `alignment-preview-${backendLabel}-removed.png`),
  });
  assert.notDeepEqual(
    alignmentRemoved,
    alignmentAfter,
    'retiring the alignment preview must remove all transient corridor batches',
  );
  await page.evaluate(() => window.__HCAD_RESET_CAMERA__?.());

  const profileReference = await page.screenshot({
    path: path.join(screenshots, `local-profile-${backendLabel}-reference-3d.png`),
  });
  const localProfile = await page.evaluate(() => window.__HCAD_FOCUS_LOCAL_PROFILE__?.());
  assert(localProfile, 'local profile hook must publish its controller endpoint');
  assert.equal(localProfile.projection, 'orthographic');
  assert.equal(localProfile.restoredExact, null);
  assert(Math.abs(localProfile.centerCoordinate.x - localProfile.target.x) < 1e-9);
  assert(Math.abs(localProfile.centerCoordinate.y - localProfile.target.y) < 1e-9);
  assert(Math.abs(localProfile.centerCoordinate.z - localProfile.target.z) < 1e-9);
  const inverseRootTwo = Math.SQRT1_2;
  const cornerOffset = {
    x: localProfile.cornerCoordinate.x - localProfile.target.x,
    y: localProfile.cornerCoordinate.y - localProfile.target.y,
    z: localProfile.cornerCoordinate.z - localProfile.target.z,
  };
  assert(
    Math.abs(cornerOffset.x * inverseRootTwo - cornerOffset.y * inverseRootTwo) < 1e-8,
    `local cursor fallback must remain in the authored profile plane: ${JSON.stringify(localProfile)}`,
  );
  assert(
    Math.abs(cornerOffset.z) > 1,
    'local profile cursor coordinates must use the authored up axis',
  );
  await page.waitForTimeout(100);
  const profileScreenshot = await page.screenshot({
    path: path.join(screenshots, `local-profile-${backendLabel}-orthographic.png`),
  });
  assert.notDeepEqual(
    profileScreenshot,
    profileReference,
    'arbitrary local orthographic profile view must alter the presented frame',
  );
  const localProfileDepth = await page.evaluate(() =>
    window.__HCAD_APPLY_LOCAL_PROFILE_DEPTH__?.(),
  );
  assert.deepEqual(localProfileDepth, {
    planeCount: 2,
    previewCap: false,
    previewBatchCount: 0,
  });
  await page.waitForTimeout(100);
  const profileDepthScreenshot = await page.screenshot({
    path: path.join(screenshots, `local-profile-${backendLabel}-depth-slab.png`),
  });
  assert.notDeepEqual(
    profileDepthScreenshot,
    profileScreenshot,
    'asymmetric local profile depth must visibly crop the shared entity view',
  );
  await page.evaluate(() => window.__HCAD_CLEAR_LOCAL_PROFILE_DEPTH__?.());
  const localProfileExit = await page.evaluate(() => window.__HCAD_EXIT_LOCAL_PROFILE__?.());
  assert.equal(localProfileExit?.restoredExact, true);
  await page.waitForTimeout(100);
  const profileExitScreenshot = await page.screenshot({
    path: path.join(screenshots, `local-profile-${backendLabel}-restored-3d.png`),
  });
  assert.notDeepEqual(
    profileExitScreenshot,
    profileScreenshot,
    'leaving a local profile view must present the captured 3D camera again',
  );
  const userViewpoint = await page.evaluate(() => window.__HCAD_FOCUS_USER_VIEWPOINT__?.());
  assert.equal(userViewpoint?.projection, 'perspective');
  assert.equal(userViewpoint?.targetExact, true);
  assert(userViewpoint?.eyeError < 1e-8, JSON.stringify(userViewpoint));
  assert(Math.abs(userViewpoint.verticalFovRadians - Math.PI / 2.8) < 1e-12);
  await page.waitForTimeout(100);
  const userViewpointScreenshot = await page.screenshot({
    path: path.join(screenshots, `user-perspective-viewpoint-${backendLabel}.png`),
  });
  assert.notDeepEqual(
    userViewpointScreenshot,
    profileExitScreenshot,
    'user-authored perspective standpoint must alter the presented 3D frame',
  );
  await page.evaluate(() => window.__HCAD_RESET_CAMERA__?.());

  const exaggerated = await page.evaluate(() => window.__HCAD_FOCUS_VERTICAL_EXAGGERATION__?.());
  assert(exaggerated, 'vertical exaggeration hook must publish its exact-pick validation');
  assert.equal(exaggerated.factor, 4);
  assert.equal(exaggerated.datum, exaggerated.sourceTarget.z - 3);
  assert.equal(exaggerated.presentedTarget.z, exaggerated.datum + 12);
  const exaggeratedHit = exaggerated.pick.candidates.find(
    (candidate) =>
      candidate.address.entityId === 'open-surface' && candidate.snapKind === 'surface',
  );
  assert(
    exaggeratedHit,
    `vertically exaggerated mesh must retain an exact source hit: ${JSON.stringify(exaggerated.pick)}`,
  );
  assert(
    Math.abs(exaggeratedHit.worldPosition.z - exaggerated.sourceTarget.z) < 1e-7,
    `vertical exaggeration must never leak display Z into authoritative picking: ${JSON.stringify(exaggeratedHit)}`,
  );
  assert.notEqual(exaggeratedHit.worldPosition.z, exaggerated.presentedTarget.z);
  assert(exaggeratedHit.pixelDistance < 1e-4);
  await page.waitForTimeout(100);
  const exaggeratedScreenshot = await page.screenshot({
    path: path.join(screenshots, `vertical-exaggeration-${backendLabel}.png`),
  });
  assert.notDeepEqual(
    exaggeratedScreenshot,
    userViewpointScreenshot,
    'vertical exaggeration must visibly alter the source surface presentation',
  );
  const exaggeratedClippedPick = await page.evaluate(() =>
    window.__HCAD_APPLY_VERTICAL_EXAGGERATION_CLIP__?.(),
  );
  const exaggeratedClippedHit = exaggeratedClippedPick?.candidates.find(
    (candidate) =>
      candidate.address.entityId === 'open-surface' && candidate.snapKind === 'surface',
  );
  assert(
    exaggeratedClippedHit,
    `source-space clip plane must retain the source Z=datum+3 center despite display Z=datum+12: ${JSON.stringify(exaggeratedClippedPick)}`,
  );
  assert(Math.abs(exaggeratedClippedHit.worldPosition.z - exaggerated.sourceTarget.z) < 1e-7);
  await page.waitForTimeout(100);
  const exaggeratedClippedScreenshot = await page.screenshot({
    path: path.join(screenshots, `vertical-exaggeration-${backendLabel}-source-clipped.png`),
  });
  assert.notDeepEqual(
    exaggeratedClippedScreenshot,
    exaggeratedScreenshot,
    'source-space height clip must visibly crop the exaggerated surface without shifting its semantics',
  );
  await page.evaluate(() => window.__HCAD_CLEAR_VERTICAL_EXAGGERATION__?.());

  const streamedExaggerated = await page.evaluate(() =>
    window.__HCAD_FOCUS_STREAMED_EXAGGERATION__?.(),
  );
  assert(streamedExaggerated, 'streamed exaggeration hook must publish its selection proof');
  assert.equal(streamedExaggerated.decodeCountersStable, true);
  assert.equal(
    streamedExaggerated.identityPlan.render.some((key) => key.datasetId === 'fixture-potree'),
    false,
    'source bounds must be outside a camera aimed exclusively at the exaggerated height',
  );
  assert.equal(
    streamedExaggerated.exaggeratedPlan.render.some((key) => key.datasetId === 'fixture-potree'),
    true,
    `presentation-aware hierarchy selection must retain the exaggerated Potree tile: ${JSON.stringify(streamedExaggerated)}`,
  );
  const streamedExaggeratedHit = streamedExaggerated.pick.candidates.find(
    (candidate) =>
      candidate.address.entityId === 'fixture-potree-point' && candidate.snapKind === 'point',
  );
  assert(
    streamedExaggeratedHit,
    `selected exaggerated Potree tile must remain exactly pickable: ${JSON.stringify(streamedExaggerated.pick)}`,
  );
  assert(
    Math.abs(streamedExaggeratedHit.worldPosition.z - streamedExaggerated.sourcePoint.z) < 1e-9,
  );
  assert.notEqual(streamedExaggeratedHit.worldPosition.z, streamedExaggerated.presentedPoint.z);
  await page.waitForTimeout(100);
  await page.screenshot({
    path: path.join(screenshots, `streamed-vertical-exaggeration-${backendLabel}.png`),
  });
  await page.evaluate(() => window.__HCAD_CLEAR_STREAMED_EXAGGERATION__?.());

  const streamedMove = await page.evaluate(() => window.__HCAD_FOCUS_STREAMED_MOVE_PREVIEW__?.());
  assert(streamedMove, 'streamed move-preview hook must publish target-LOD diagnostics');
  assert.equal(
    streamedMove.primaryPlan.render.some((key) => key.datasetId === 'fixture-potree'),
    false,
    'target-only move-preview tiles must never leak into canonical source visibility',
  );
  assert(
    streamedMove.targetTiles.some(
      (key) => key.datasetId === 'fixture-potree' && key.tileId === 'r',
    ),
    `translated ghost must retain its independent target tile: ${JSON.stringify(streamedMove)}`,
  );
  assert.equal(streamedMove.staleRejectedAtomically, true);
  assert.equal(streamedMove.targetPoint.x - streamedMove.sourcePoint.x, streamedMove.translation.x);
  assert.equal(streamedMove.targetPoint.y - streamedMove.sourcePoint.y, streamedMove.translation.y);
  assert.equal(streamedMove.targetPoint.z - streamedMove.sourcePoint.z, streamedMove.translation.z);
  const committedMoveHit = streamedMove.targetPick.candidates.find(
    (candidate) =>
      candidate.address.entityId === 'fixture-potree-point' && candidate.snapKind === 'point',
  );
  assert(
    committedMoveHit,
    `committed resident Potree placement must remain exactly pickable: ${JSON.stringify(streamedMove.targetPick)}`,
  );
  assert(Math.abs(committedMoveHit.worldPosition.x - streamedMove.targetPoint.x) < 1e-9);
  assert(Math.abs(committedMoveHit.worldPosition.y - streamedMove.targetPoint.y) < 1e-9);
  assert(Math.abs(committedMoveHit.worldPosition.z - streamedMove.targetPoint.z) < 1e-9);
  assert.equal(
    streamedMove.targetPlan.render.some((key) => key.datasetId === 'fixture-potree'),
    true,
    `committed canonical placement must select the resident Potree tile at its target: ${JSON.stringify(streamedMove)}`,
  );
  assert.deepEqual(
    [
      streamedMove.committedRevision,
      streamedMove.undoRevision,
      streamedMove.redoRevision,
      streamedMove.restoredRevision,
    ],
    [2, 3, 4, 5],
    'transform, undo, redo and restoring undo must remain monotone canonical revisions',
  );
  assert(
    streamedMove.generations.every(
      (generation, index, values) => index === 0 || generation > values[index - 1],
    ),
    `every command must advance exact slot CAS generation: ${JSON.stringify(streamedMove.generations)}`,
  );
  assert.equal(streamedMove.previewConsumed, true);
  assert.equal(streamedMove.decodeCountersStable, true);
  assert.equal(streamedMove.proxyCountStable, true);
  assert.equal(streamedMove.journalEntries, 4);
  assert.equal(streamedMove.canUndo, false);
  assert.equal(streamedMove.canRedo, true);

  const unclipped = await page.screenshot({
    path: path.join(screenshots, `entity-zoo-${backendLabel}-unclipped.png`),
  });
  const clipPreview = await page.evaluate(() => window.__HCAD_APPLY_CLIP__?.());
  assert(
    clipPreview.batchCount > 0,
    'previewCap must generate at least one exact closed-solid cap batch',
  );
  assert.deepEqual(
    clipPreview.materialSlots,
    [0, 3, 7],
    `previewCap must preserve generated and layered canonical material slots: ${JSON.stringify(clipPreview)}`,
  );
  await page.waitForTimeout(100);
  const clipped = await page.screenshot({
    path: path.join(screenshots, `entity-zoo-${backendLabel}-clipped.png`),
  });
  assert.notDeepEqual(clipped, unclipped, 'clip volume must alter the presented frame');
  const removeClipPreview = await page.evaluate(() => window.__HCAD_APPLY_REMOVE_CLIP__?.());
  assert(removeClipPreview.batchCount > 0, 'removeInside must generate exact opening cap batches');
  assert.deepEqual(removeClipPreview.materialSlots, [0, 3, 7]);
  await page.waitForTimeout(100);
  const opened = await page.screenshot({
    path: path.join(screenshots, `entity-zoo-${backendLabel}-opened.png`),
  });
  assert.notDeepEqual(opened, unclipped, 'removeInside volume must alter the presented frame');
  assert.notDeepEqual(
    opened,
    clipped,
    'keepInside and removeInside must present different retained geometry',
  );
  await page.evaluate(() => window.__HCAD_CLEAR_CLIP__?.());

  process.stdout.write(
    `${JSON.stringify(
      {
        capabilities: state.capabilities,
        calibratedPolicy: state.hardwarePolicy,
        calibration: state.calibration,
        gpuFrameTiming: state.gpuFrameTiming,
        streamDecodeRebuild: state.streamDecodeRebuild,
        decodeWorker: state.decodeWorker,
        entities: state.entityCount,
        proxies: state.proxyCount,
        generation: state.generation,
        pickCandidates: state.pick.candidates.length,
        centerHit,
        providerPicks: {
          potreeHit,
          rasterLowHit,
          rasterHighHit,
          gaussianMeanHit,
          gaussianCoverageHit,
        },
        maximumCpuSubmitMs: Math.max(...state.frameDurationsMs),
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`screenshots: ${screenshots}\n`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function worldClose(actual, expected, tolerance) {
  return (
    Math.abs(actual.x - expected.x) <= tolerance &&
    Math.abs(actual.y - expected.y) <= tolerance &&
    Math.abs(actual.z - expected.z) <= tolerance
  );
}

function assertWorldClose(actual, expected, tolerance) {
  assert(
    worldClose(actual, expected, tolerance),
    `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${String(code)} (${signal ?? 'no signal'})`));
    });
  });
}
