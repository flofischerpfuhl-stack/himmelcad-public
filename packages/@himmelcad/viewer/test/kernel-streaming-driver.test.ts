import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeInputManifestHash,
  KernelStreamingDriver,
  validateDecodeArtifactV3,
  type KernelAssetUriResolver,
  type KernelDecodeExecutor,
  type KernelFetch,
  type KernelStreamingTarget,
} from '../src/kernel/KernelStreamingDriver.js';
import type {
  KernelDecodeJob,
  KernelDecodedArtifact,
} from '../src/kernel/KernelDecodeWorkerPool.js';
import type {
  KernelAssetDependency,
  KernelPotreeContentMetadata,
  KernelRasterContentMetadata,
  KernelResidencyTicket,
  KernelResourceCost,
  KernelResolvedAssetBundle,
  KernelStreamingFramePlan,
  KernelStreamingPublish,
  KernelThreeDTilesContentMetadata,
  KernelTileKey,
} from '../src/kernel/WgpuKernelViewer.js';

void test('HCDECODE v3 manifest matches the Rust fixed vector and rejects tamper', async () => {
  const job: KernelDecodeJob = {
    kind: 'gltf',
    metadataJson: '{"slot":"primary","revision":7}',
    primary: Uint8Array.from([0, 1, 2, 255]).buffer,
    bundleManifestJson: '{"schemaVersion":1,"entries":[]}',
    bundle: Uint8Array.from([9, 8, 7]).buffer,
    secondary: new ArrayBuffer(0),
    decodeParametersJson: '{"layout":"fixed"}',
  };
  const hash = await decodeInputManifestHash(job);
  assert.equal(hash, '13a4ab80a1d45e3d7e338f7fb3fe4e530f1f21aded30d2081b645796c1f6da1a');
  const artifact = await mockDecodeArtifact(job);
  assert.doesNotThrow(() => validateDecodeArtifactV3(artifact, hash));
  assert.throws(
    () => validateDecodeArtifactV3(artifact, `${hash.slice(0, 62)}00`),
    /manifest hash mismatch/,
  );
  new Uint8Array(artifact)[8] = 1;
  assert.throws(() => validateDecodeArtifactV3(artifact, hash), /version or length/);
});

void test('streaming driver executes range fetch, decode, upload and eviction lifecycle', async () => {
  const target = new RecordingTarget();
  target.publishUploadedBytes = 4_096;
  const requests: { uri: string; range: string | null }[] = [];
  const fetchBytes: KernelFetch = (uri, init) => {
    requests.push({ uri, range: new Headers(init.headers).get('Range') });
    return Promise.resolve(new Response(new Uint8Array(32), { status: 200 }));
  };
  const driver = streamingDriver(target, fetchBytes);
  const ticket = tileTicket();
  const descriptor = {
    id: 'r',
    parent: null,
    children: [],
    bounds: { kind: 'sphere' as const, center: { x: 1, y: 2, z: 3 }, radius: 10 },
    contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    geometricError: 1,
    refinement: 'add' as const,
    contents: [
      {
        kind: 'potreePoints' as const,
        uri: 'https://example.test/octree.bin',
        byteOffset: 8,
        byteLength: 12,
        primitiveCount: 1,
        contentHash: null,
        decoderParameters: { threeDTiles: { group: 0 } },
      },
    ],
    childPage: null,
    providerMetadata: { class: 'surveyTile', properties: { epoch: 2025.5 } },
  };

  driver.execute(plan({ kind: 'fetchTile', ticket, descriptor }));
  await driver.settled();
  assert.deepEqual(requests, [
    {
      uri: 'https://example.test/octree.bin',
      range: 'bytes=8-19',
    },
  ]);
  assert.equal(target.fetched[0]?.cost.cpuCompressedBytes, 12);

  driver.execute(plan({ kind: 'decodeTile', ticket }));
  await driver.settled();
  assert.equal(target.stagedPotree[0]?.metadata.pointCount, 1);
  assert.equal(target.decoded[0]?.cost.cpuDecodedBytes, 16);

  assert.equal(driver.execute(plan({ kind: 'uploadTile', ticket })), 4_096);
  assert.equal(target.uploaded[0]?.cost.cpuCompressedBytes, 12);
  assert.equal(target.uploaded[0]?.cost.gpuBufferBytes, 36);
  assert.deepEqual(driver.metadataForRenderProxy('stream:scan/r/0'), {
    tile: { class: 'surveyTile', properties: { epoch: 2025.5 } },
    content: { threeDTiles: { group: 0 } },
  });

  driver.detachDataset('scan');
  assert.equal(driver.metadataForRenderProxy('stream:scan/r/0'), null);
  assert.deepEqual(target.removedPotree, []);

  driver.execute(plan({ kind: 'fetchTile', ticket, descriptor }));
  await driver.settled();
  driver.execute(plan({ kind: 'decodeTile', ticket }));
  await driver.settled();
  driver.execute(plan({ kind: 'uploadTile', ticket }));
  assert.notEqual(driver.metadataForRenderProxy('stream:scan/r/0'), null);

  driver.execute(plan({ kind: 'evictTile', key: ticket.key }));
  assert.deepEqual(target.removedPotree, ['scan/r/0']);
  assert.equal(driver.metadataForRenderProxy('stream:scan/r/0'), null);
  driver.dispose();
});

void test('prepared tile content hash is verified before decode residency', async () => {
  const target = new RecordingTarget();
  const driver = streamingDriver(target, () =>
    Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })),
  );
  const ticket = tileTicket();
  driver.execute(
    plan({
      kind: 'fetchTile',
      ticket,
      descriptor: {
        id: 'r',
        parent: null,
        children: [],
        bounds: { kind: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 1 },
        contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        geometricError: 0,
        refinement: 'replace',
        contents: [
          {
            kind: 'potreePoints',
            uri: 'https://example.test/tampered.bin',
            byteOffset: null,
            byteLength: null,
            primitiveCount: 1,
            contentHash: '00'.repeat(32),
            decoderParameters: null,
          },
        ],
        childPage: null,
        providerMetadata: null,
      },
    }),
  );
  await driver.settled();
  assert.equal(target.fetched.length, 0);
  assert.deepEqual(target.failures, [
    'stream content hash mismatch: https://example.test/tampered.bin',
  ]);
  driver.dispose();
});

void test('heterogeneous tile upload crosses the kernel boundary as one atomic transaction', async () => {
  const target = new RecordingTarget();
  target.batchPublishError = new Error('second GPU allocation failed');
  const driver = streamingDriver(target, () =>
    Promise.resolve(new Response(new Uint8Array(32), { status: 200 })),
  );
  const ticket = tileTicket();
  const descriptor = {
    id: 'r',
    parent: null,
    children: [],
    bounds: { kind: 'sphere' as const, center: { x: 0, y: 0, z: 0 }, radius: 10 },
    contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    geometricError: 1,
    refinement: 'add' as const,
    contents: [0, 1].map((index) => ({
      kind: 'potreePoints' as const,
      uri: `https://example.test/${index}.bin`,
      byteOffset: null,
      byteLength: null,
      primitiveCount: 1,
      contentHash: null,
      decoderParameters: null,
    })),
    childPage: null,
    providerMetadata: null,
  };

  driver.execute(plan({ kind: 'fetchTile', ticket, descriptor }));
  await driver.settled();
  driver.execute(plan({ kind: 'decodeTile', ticket }));
  await driver.settled();
  driver.execute(plan({ kind: 'uploadTile', ticket }));

  assert.deepEqual(target.publishedTransactions, [['scan/r/0', 'scan/r/1']]);
  assert.deepEqual(target.discarded, ['scan/r/0', 'scan/r/1']);
  assert.deepEqual(target.failures, ['second GPU allocation failed']);
  assert.equal(target.uploaded.length, 0);
  driver.dispose();
});

void test('failed hierarchy requests are released for a later scheduler retry', async () => {
  const target = new RecordingTarget();
  const fetchBytes: KernelFetch = () => Promise.reject(new Error('offline'));
  const driver = streamingDriver(target, fetchBytes);
  const owner = { datasetId: 'city', tileId: 'r' };
  driver.execute(
    plan({
      kind: 'fetchHierarchyPage',
      request: {
        owner,
        reference: {
          uri: 'https://example.test/nested.json',
          byteOffset: null,
          byteLength: null,
          contentHash: null,
        },
      },
    }),
  );
  await driver.settled();
  assert.deepEqual(target.failedHierarchy, [owner]);
  driver.dispose();
});

void test('tampered immutable hierarchy page is never applied', async () => {
  const target = new RecordingTarget();
  const driver = streamingDriver(target, () =>
    Promise.resolve(new Response(new Uint8Array([1, 2, 3]))),
  );
  const owner = { datasetId: 'dgm', tileId: 'root' };
  driver.execute(
    plan({
      kind: 'fetchHierarchyPage',
      request: {
        owner,
        reference: {
          uri: 'https://example.test/dgm/page-1.json',
          byteOffset: null,
          byteLength: null,
          contentHash: '00'.repeat(32),
        },
      },
    }),
  );
  await driver.settled();
  assert.deepEqual(target.appliedHierarchy, []);
  assert.deepEqual(target.failedHierarchy, [owner]);
  driver.dispose();
});

void test('dataset bootstrap fetches share the live kernel request ceiling', async () => {
  const target = new RecordingTarget();
  const started: string[] = [];
  let finishFirst: ((response: Response) => void) | undefined;
  const driver = streamingDriver(target, (uri) => {
    started.push(uri);
    if (uri.endsWith('/first')) {
      return new Promise<Response>((resolve) => {
        finishFirst = resolve;
      });
    }
    return Promise.resolve(new Response(new Uint8Array([2])));
  });
  driver.setRuntimeLimits({ decoderWorkers: 1, contentRequests: 1 });
  const first = driver.fetchImmutableResource({
    uri: 'https://example.test/first',
    byteOffset: null,
    byteLength: null,
  });
  const second = driver.fetchImmutableResource({
    uri: 'https://example.test/second',
    byteOffset: null,
    byteLength: null,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(started, ['https://example.test/first']);
  assert.equal(driver.diagnostics().activeRequests, 1);
  assert.equal(driver.diagnostics().queuedRequests, 1);
  finishFirst?.(new Response(new Uint8Array([1])));
  assert.deepEqual([...(await first)], [1]);
  assert.deepEqual([...(await second)], [2]);
  assert.deepEqual(started, ['https://example.test/first', 'https://example.test/second']);
  driver.dispose();
});

void test('raster hash-verifies and packs elevation, validity and confidence side-bands', async () => {
  const target = new RecordingTarget();
  const uris: string[] = [];
  const elevationBytes = new Uint8Array(new Float32Array([12]).buffer);
  const validityBytes = new Uint8Array([1]);
  const confidenceBytes = new Uint8Array([204]);
  const driver = streamingDriver(target, (uri) => {
    uris.push(uri);
    const bytes = uri.endsWith('height.raw')
      ? elevationBytes
      : uri.endsWith('validity.bin')
        ? validityBytes
        : uri.endsWith('confidence.bin')
          ? confidenceBytes
        : new Uint8Array([255, 0, 0, 255]);
    return Promise.resolve(new Response(bytes));
  });
  const ticket = { key: { datasetId: 'ortho', tileId: 'r' }, generation: 1 };
  driver.execute(
    plan({
      kind: 'fetchTile',
      ticket,
      descriptor: {
        id: 'r',
        parent: null,
        children: [],
        bounds: { kind: 'sphere', center: { x: 0, y: 0, z: 12 }, radius: 1 },
        contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        geometricError: 0,
        refinement: 'replace',
        childPage: null,
        contents: [
          {
            kind: 'raster',
            uri: 'https://example.test/tiles/color.rgba',
            byteOffset: null,
            byteLength: null,
            primitiveCount: 1,
            contentHash: null,
            decoderParameters: {
              schemaVersion: 1,
              width: 1,
              height: 1,
              mapping: { origin: [0, 0], columnStep: [1, 0], rowStep: [0, -1] },
              topology: { kind: 'pixelSteps' },
              colorEncoding: 'rgba8',
              elevationEncoding: { kind: 'float32LittleEndian' },
              noData: { kind: 'none' },
              elevationReference: {
                uri: 'height.raw',
                byteOffset: null,
                byteLength: null,
                contentHash: await testSha256Hex(elevationBytes),
              },
              validityReference: {
                uri: 'validity.bin',
                byteOffset: null,
                byteLength: null,
                contentHash: await testSha256Hex(validityBytes),
              },
              confidenceReference: {
                uri: 'confidence.bin',
                byteOffset: null,
                byteLength: null,
                contentHash: await testSha256Hex(confidenceBytes),
                encoding: 'unorm8',
              },
              triangleMaskReference: null,
            },
          },
        ],
      },
    }),
  );
  await driver.settled();
  assert.deepEqual(uris, [
    'https://example.test/tiles/color.rgba',
    'https://example.test/tiles/height.raw',
    'https://example.test/tiles/validity.bin',
    'https://example.test/tiles/confidence.bin',
  ]);
  driver.execute(plan({ kind: 'decodeTile', ticket }));
  await driver.settled();
  assert.equal(
    (
      target.stagedRaster[0]?.metadata.contract as
        | { readonly raster?: { readonly depth?: { readonly sampling?: { readonly connectivity?: { readonly kind?: string } } } } }
        | undefined
    )?.raster?.depth?.sampling?.connectivity?.kind,
    'pixelSteps',
  );
  assert.equal(target.stagedRaster[0]?.elevations.byteLength, 6);
  assert.equal(target.stagedRaster[0]?.metadata.elevationPayloadByteLength, 4);
  assert.equal(target.stagedRaster[0]?.metadata.validityPayloadByteLength, 1);
  assert.equal(target.stagedRaster[0]?.metadata.confidencePayloadByteLength, 1);
  assert.equal(target.stagedRaster[0]?.metadata.triangleMaskPayloadByteLength, 0);
  assert.equal(
    (
      target.stagedRaster[0]?.metadata.contract as
        | {
            readonly raster?: {
              readonly depth?: { readonly confidence?: { readonly encoding?: string } | null };
            };
          }
        | undefined
    )?.raster?.depth?.confidence?.encoding,
    'unorm8',
  );
  driver.dispose();
});

void test('tampered raster elevation never becomes fetched residency', async () => {
  const target = new RecordingTarget();
  const driver = streamingDriver(target, (uri) =>
    Promise.resolve(
      new Response(
        uri.endsWith('height.raw')
          ? new Uint8Array(new Float32Array([13]).buffer)
          : new Uint8Array([255, 0, 0, 255]),
      ),
    ),
  );
  const ticket = { key: { datasetId: 'ortho', tileId: 'tampered' }, generation: 1 };
  const descriptor = {
    ...threeDTilesDescriptor('https://example.test/unused'),
    contents: [
      {
        kind: 'raster' as const,
        uri: 'https://example.test/tiles/color.rgba',
        byteOffset: null,
        byteLength: null,
        primitiveCount: 1,
        contentHash: null,
        decoderParameters: {
          schemaVersion: 1,
          width: 1,
          height: 1,
          mapping: { origin: [0, 0], columnStep: [1, 0], rowStep: [0, -1] },
          topology: { kind: 'pixelSteps' },
          colorEncoding: 'rgba8',
          elevationEncoding: { kind: 'float32LittleEndian' },
          noData: { kind: 'none' },
          elevationReference: {
            uri: 'height.raw',
            byteOffset: null,
            byteLength: null,
            contentHash: '00'.repeat(32),
          },
          validityReference: null,
          confidenceReference: null,
          triangleMaskReference: null,
        },
      },
    ],
  };
  driver.execute(plan({ kind: 'fetchTile', ticket, descriptor }));
  await driver.settled();
  assert.equal(target.fetched.length, 0);
  assert.deepEqual(target.failures, [
    'raster elevation hash mismatch: https://example.test/tiles/height.raw',
  ]);
  driver.dispose();
});

void test('3D Tiles dependencies are recursively resolved, deduplicated and retained atomically', async () => {
  const target = new RecordingTarget();
  target.dependencies.set('https://example.test/tiles/root.i3dm', [
    {
      ownerUri: 'https://example.test/tiles/root.i3dm',
      sourceUri: '../models/tree.gltf',
      kind: 'gltfDocument',
    },
  ]);
  target.dependencies.set('https://example.test/models/tree.gltf', [
    {
      ownerUri: 'https://example.test/models/tree.gltf',
      sourceUri: 'mesh.bin?rev=1',
      kind: 'buffer',
    },
    {
      ownerUri: 'https://example.test/models/tree.gltf',
      sourceUri: 'textures/tree.png',
      kind: 'image',
    },
  ]);
  const bodies = new Map<string, Uint8Array>([
    ['https://example.test/tiles/root.i3dm', new Uint8Array([1])],
    ['https://example.test/models/tree.gltf', new Uint8Array([2, 2])],
    ['https://example.test/models/mesh.bin?rev=1', new Uint8Array([3, 3, 3])],
    ['https://example.test/models/textures/tree.png', new Uint8Array([4, 4, 4, 4])],
  ]);
  const requests: string[] = [];
  const driver = streamingDriver(target, (uri) => {
    requests.push(uri);
    const bytes = bodies.get(uri);
    return Promise.resolve(
      bytes ? new Response(Uint8Array.from(bytes).buffer) : new Response(null, { status: 404 }),
    );
  });
  const ticket = { key: { datasetId: 'trees', tileId: 'r' }, generation: 1 };
  driver.execute(
    plan({
      kind: 'fetchTile',
      ticket,
      descriptor: {
        id: 'r',
        parent: null,
        children: [],
        bounds: { kind: 'sphere', center: { x: 0, y: 0, z: 0 }, radius: 10 },
        contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        geometricError: 0,
        refinement: 'replace',
        childPage: null,
        contents: [
          {
            kind: 'threeDTilesContainer',
            uri: 'https://example.test/tiles/root.i3dm',
            byteOffset: null,
            byteLength: null,
            primitiveCount: null,
            contentHash: null,
            decoderParameters: null,
          },
        ],
      },
    }),
  );
  await driver.settled();
  assert.deepEqual(requests, [...bodies.keys()]);
  assert.equal(target.fetched[0]?.cost.cpuCompressedBytes, 10);

  driver.execute(plan({ kind: 'decodeTile', ticket }));
  await driver.settled();
  const staged = target.stagedThreeDTiles[0];
  assert.equal(staged?.metadata.contentUri, 'https://example.test/tiles/root.i3dm');
  assert.equal(staged?.metadata.contentKind, 'threeDTilesContainer');
  assert.equal(staged?.bundle.bytes.byteLength, 9);
  assert.deepEqual(
    staged?.bundle.manifest.entries.map((entry) => ({
      ownerUri: entry.ownerUri,
      sourceUri: entry.sourceUri,
      resolvedUri: entry.resolvedUri,
      kind: entry.kind,
      byteOffset: entry.byteOffset,
      byteLength: entry.byteLength,
    })),
    [
      {
        ownerUri: 'https://example.test/tiles/root.i3dm',
        sourceUri: '../models/tree.gltf',
        resolvedUri: 'https://example.test/models/tree.gltf',
        kind: 'gltfDocument',
        byteOffset: 0,
        byteLength: 2,
      },
      {
        ownerUri: 'https://example.test/models/tree.gltf',
        sourceUri: 'mesh.bin?rev=1',
        resolvedUri: 'https://example.test/models/mesh.bin?rev=1',
        kind: 'buffer',
        byteOffset: 2,
        byteLength: 3,
      },
      {
        ownerUri: 'https://example.test/models/tree.gltf',
        sourceUri: 'textures/tree.png',
        resolvedUri: 'https://example.test/models/textures/tree.png',
        kind: 'image',
        byteOffset: 5,
        byteLength: 4,
      },
    ],
  );
  driver.execute(plan({ kind: 'uploadTile', ticket }));
  assert.equal(target.uploaded[0]?.cost.cpuCompressedBytes, 10);
  driver.dispose();
});

void test('immutable glTF asset graph verifies every declared external resource', async () => {
  const root = 'https://example.test/dgm/tiles/root.gltf';
  const mesh = 'https://example.test/dgm/tiles/root.positions.f32';
  const expected = new Uint8Array([9, 8, 7, 6]);
  const contentHash = await testSha256Hex(expected);
  const parameters = {
    schemaVersion: 1 as const,
    requireComplete: true as const,
    immutableAssets: [{ uri: 'root.positions.f32', contentHash, byteLength: expected.byteLength }],
  };

  const validTarget = new RecordingTarget();
  validTarget.dependencies.set(root, [
    { ownerUri: root, sourceUri: 'root.positions.f32', kind: 'buffer' },
  ]);
  const validDriver = streamingDriver(validTarget, (uri) =>
    Promise.resolve(new Response(uri === mesh ? expected.slice() : new Uint8Array([1]))),
  );
  const ticket = { key: { datasetId: 'dgm', tileId: 'root' }, generation: 1 };
  validDriver.execute(
    plan({
      kind: 'fetchTile',
      ticket,
      descriptor: threeDTilesDescriptor(root, 'gltf', parameters),
    }),
  );
  await validDriver.settled();
  assert.equal(validTarget.failures.length, 0);
  assert.equal(validTarget.fetched.length, 1);
  validDriver.dispose();

  const tamperedTarget = new RecordingTarget();
  tamperedTarget.dependencies.set(root, [
    { ownerUri: root, sourceUri: 'root.positions.f32', kind: 'buffer' },
  ]);
  const tamperedDriver = streamingDriver(tamperedTarget, (uri) =>
    Promise.resolve(
      new Response(uri === mesh ? new Uint8Array([9, 8, 7, 5]) : new Uint8Array([1])),
    ),
  );
  tamperedDriver.execute(
    plan({
      kind: 'fetchTile',
      ticket,
      descriptor: threeDTilesDescriptor(root, 'gltf', parameters),
    }),
  );
  await tamperedDriver.settled();
  assert.equal(tamperedTarget.fetched.length, 0);
  assert.deepEqual(tamperedTarget.failures, [`external asset content hash mismatch: ${mesh}`]);
  tamperedDriver.dispose();
});

void test('one glTF dependency wave uses but never exceeds the live request ceiling', async () => {
  const target = new RecordingTarget();
  const root = 'https://example.test/dgm/tiles/root.gltf';
  target.dependencies.set(
    root,
    Array.from({ length: 4 }, (_, index) => ({
      ownerUri: root,
      sourceUri: `asset-${String(index)}.bin`,
      kind: 'buffer' as const,
    })),
  );
  let active = 0;
  let peak = 0;
  const driver = streamingDriver(target, async (uri) => {
    if (uri === root) return new Response(new Uint8Array([1]));
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return new Response(new Uint8Array([2]));
  });
  driver.setRuntimeLimits({ decoderWorkers: 1, contentRequests: 3 });
  const ticket = { key: { datasetId: 'parallel-dgm', tileId: 'root' }, generation: 1 };
  driver.execute(
    plan({ kind: 'fetchTile', ticket, descriptor: threeDTilesDescriptor(root, 'gltf') }),
  );
  await driver.settled();
  assert.equal(target.fetched.length, 1);
  assert.equal(peak, 3);
  assert.equal(driver.diagnostics().peakRequests, 3);
  driver.dispose();
});

void test('missing recursive 3D Tiles dependency leaves no fetched, staged or published content', async () => {
  const target = new RecordingTarget();
  target.dependencies.set('https://example.test/tiles/root.i3dm', [
    {
      ownerUri: 'https://example.test/tiles/root.i3dm',
      sourceUri: '../models/tree.gltf',
      kind: 'gltfDocument',
    },
  ]);
  target.dependencies.set('https://example.test/models/tree.gltf', [
    {
      ownerUri: 'https://example.test/models/tree.gltf',
      sourceUri: 'missing.bin',
      kind: 'buffer',
    },
  ]);
  const bodies = new Map<string, Uint8Array>([
    ['https://example.test/tiles/root.i3dm', new Uint8Array([1])],
    ['https://example.test/models/tree.gltf', new Uint8Array([2])],
  ]);
  const driver = streamingDriver(target, (uri) => {
    const bytes = bodies.get(uri);
    return Promise.resolve(
      bytes ? new Response(Uint8Array.from(bytes).buffer) : new Response(null, { status: 404 }),
    );
  });
  const ticket = { key: { datasetId: 'trees', tileId: 'missing' }, generation: 1 };
  const descriptor = threeDTilesDescriptor('https://example.test/tiles/root.i3dm');

  driver.execute(plan({ kind: 'fetchTile', ticket, descriptor }));
  await driver.settled();
  driver.execute(plan({ kind: 'decodeTile', ticket }));
  await driver.settled();
  driver.execute(plan({ kind: 'uploadTile', ticket }));

  assert.deepEqual(target.failures, [
    'fetch https://example.test/models/missing.bin failed with HTTP 404',
  ]);
  assert.equal(driver.diagnostics().failedOperations, 1);
  assert.deepEqual(driver.diagnostics().recentFailures, [
    {
      phase: 'fetch',
      tileKey: 'trees\0missing',
      message: 'fetch https://example.test/models/missing.bin failed with HTTP 404',
    },
  ]);
  assert.equal(target.fetched.length, 0);
  assert.equal(target.stagedThreeDTiles.length, 0);
  assert.equal(target.publishedTransactions.length, 0);
  driver.dispose();
});

void test('a newer tile generation aborts a stale external asset graph without publishing it', async () => {
  const target = new RecordingTarget();
  const staleRoot = 'https://example.test/tiles/stale.i3dm';
  const currentRoot = 'https://example.test/tiles/current.glb';
  const externalUri = 'https://example.test/models/stale.bin';
  target.dependencies.set(staleRoot, [
    {
      ownerUri: staleRoot,
      sourceUri: '../models/stale.bin',
      kind: 'buffer',
    },
  ]);
  let externalStartedResolve: (() => void) | undefined;
  const externalStarted = new Promise<void>((resolve) => {
    externalStartedResolve = resolve;
  });
  let externalAborted = false;
  const driver = streamingDriver(target, (uri, init) => {
    if (uri !== externalUri) return Promise.resolve(new Response(new Uint8Array([1])));
    externalStartedResolve?.();
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        'abort',
        () => {
          externalAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  });
  const key = { datasetId: 'trees', tileId: 'generation' };
  const staleTicket = { key, generation: 1 };
  const currentTicket = { key, generation: 2 };

  driver.execute(
    plan({
      kind: 'fetchTile',
      ticket: staleTicket,
      descriptor: threeDTilesDescriptor(staleRoot),
    }),
  );
  await externalStarted;
  driver.execute(
    plan({
      kind: 'fetchTile',
      ticket: currentTicket,
      descriptor: threeDTilesDescriptor(currentRoot, 'gltf'),
    }),
  );
  await driver.settled();

  assert.equal(externalAborted, true);
  assert.deepEqual(
    target.fetched.map(({ ticket }) => ticket.generation),
    [2],
  );
  assert.equal(target.failures.length, 0);
  driver.execute(plan({ kind: 'decodeTile', ticket: staleTicket }));
  await driver.settled();
  assert.equal(target.stagedThreeDTiles.length, 0);
  driver.execute(plan({ kind: 'decodeTile', ticket: currentTicket }));
  await driver.settled();
  assert.equal(target.stagedThreeDTiles.length, 1);
  assert.equal(target.stagedThreeDTiles[0]?.metadata.contentUri, currentRoot);
  driver.dispose();
});

void test('concurrent asset graphs coalesce one URI fetch and retain it for the remaining consumer', async () => {
  const target = new RecordingTarget();
  const firstRoot = 'https://example.test/tiles/first.gltf';
  const secondRoot = 'https://example.test/tiles/second.gltf';
  const sharedUri = 'https://example.test/shared/mesh.bin';
  for (const root of [firstRoot, secondRoot]) {
    target.dependencies.set(root, [
      {
        ownerUri: root,
        sourceUri: '../shared/mesh.bin',
        kind: 'buffer',
      },
    ]);
  }
  let resolveShared: ((response: Response) => void) | undefined;
  let sharedFetches = 0;
  let sharedAborts = 0;
  const driver = streamingDriver(target, (uri, init) => {
    if (uri !== sharedUri) return Promise.resolve(new Response(new Uint8Array([1])));
    sharedFetches += 1;
    return new Promise<Response>((resolve, reject) => {
      resolveShared = resolve;
      init.signal?.addEventListener(
        'abort',
        () => {
          sharedAborts += 1;
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  });
  const firstTicket = { key: { datasetId: 'shared', tileId: 'first' }, generation: 1 };
  const secondTicket = { key: { datasetId: 'shared', tileId: 'second' }, generation: 1 };

  driver.execute(
    plan({
      kind: 'fetchTile',
      ticket: firstTicket,
      descriptor: threeDTilesDescriptor(firstRoot, 'gltf'),
    }),
  );
  driver.execute(
    plan({
      kind: 'fetchTile',
      ticket: secondTicket,
      descriptor: threeDTilesDescriptor(secondRoot, 'gltf'),
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sharedFetches, 1);

  driver.execute(plan({ kind: 'evictTile', key: firstTicket.key }));
  resolveShared?.(new Response(new Uint8Array([7, 8, 9])));
  await driver.settled();

  assert.equal(sharedFetches, 1);
  assert.equal(sharedAborts, 0);
  assert.deepEqual(
    target.fetched.map(({ ticket }) => ticket.key.tileId),
    ['second'],
  );
  assert.equal(target.fetched[0]?.cost.cpuCompressedBytes, 4);
  assert.equal(target.failures.length, 0);
  driver.dispose();
});

void test('conflicting duplicate asset declarations reject the complete graph', async () => {
  const target = new RecordingTarget();
  const root = 'https://example.test/model.gltf';
  target.dependencies.set(root, [
    { ownerUri: root, sourceUri: 'payload.bin', kind: 'buffer' },
    { ownerUri: root, sourceUri: 'payload.bin', kind: 'image' },
  ]);
  const driver = streamingDriver(target, () =>
    Promise.resolve(new Response(new Uint8Array([1]), { status: 200 })),
  );
  const ticket = { key: { datasetId: 'conflict', tileId: 'r' }, generation: 1 };

  driver.execute(
    plan({
      kind: 'fetchTile',
      ticket,
      descriptor: threeDTilesDescriptor(root, 'gltf'),
    }),
  );
  await driver.settled();

  assert.deepEqual(target.failures, ['conflicting duplicate asset dependency']);
  assert.equal(target.fetched.length, 0);
  assert.equal(target.stagedThreeDTiles.length, 0);
  assert.equal(target.publishedTransactions.length, 0);
  driver.dispose();
});

void test('multi-content decode failure discards detached fetch state and succeeds after refetch', async () => {
  const target = new RecordingTarget();
  const executor = new OwnershipDecodeExecutor(2);
  let fetches = 0;
  const driver = streamingDriver(
    target,
    () => {
      fetches += 1;
      return Promise.resolve(new Response(Uint8Array.from([1, 2, 3, 4])));
    },
    undefined,
    undefined,
    executor,
  );
  const ticket = { key: { datasetId: 'transactional', tileId: 'r' }, generation: 1 };
  const descriptor = potreeDescriptorWithContents('transactional', 2);

  driver.execute(plan({ kind: 'fetchTile', ticket, descriptor }));
  await driver.settled();
  driver.execute(plan({ kind: 'decodeTile', ticket }));
  await driver.settled();

  assert.equal(fetches, 2);
  assert.deepEqual(target.failures, ['synthetic worker crash']);
  assert.deepEqual(target.discarded, ['transactional/r/0']);
  assert.equal(driver.diagnostics().retainedFetchedCompressedBytes, 0);
  driver.execute(plan({ kind: 'decodeTile', ticket }));
  await driver.settled();
  assert.equal(executor.calls, 2, 'decode without a refetch must not see detached bytes');

  driver.execute(plan({ kind: 'fetchTile', ticket, descriptor }));
  await driver.settled();
  driver.execute(plan({ kind: 'decodeTile', ticket }));
  await driver.settled();
  assert.equal(fetches, 4);
  assert.equal(executor.calls, 4);
  assert.equal(driver.diagnostics().retainedFetchedCompressedBytes, 0);
  assert.equal(driver.diagnostics().decodedReadyTiles, 1);

  driver.execute(plan({ kind: 'uploadTile', ticket }));
  assert.deepEqual(target.publishedTransactions.at(-1), ['transactional/r/0', 'transactional/r/1']);
  assert.equal(target.uploaded.at(-1)?.cost.cpuCompressedBytes, 8);
  driver.dispose();
});

void test('external asset graph rejects more than 4096 declarations before aggregation', async () => {
  const target = new RecordingTarget();
  const root = 'https://example.test/model.gltf';
  target.dependencies.set(
    root,
    Array.from({ length: 4_097 }, (_, index) => ({
      ownerUri: root,
      sourceUri: `alias-${index}.bin`,
      kind: 'buffer' as const,
    })),
  );
  let externalFetches = 0;
  const driver = streamingDriver(
    target,
    (uri) => {
      if (uri === root) return Promise.resolve(new Response(new Uint8Array([1])));
      externalFetches += 1;
      return Promise.resolve(new Response(new Uint8Array([2])));
    },
    undefined,
    (_ownerUri, _sourceUri) => 'https://example.test/shared.bin',
  );
  const ticket = { key: { datasetId: 'bounded', tileId: 'r' }, generation: 1 };

  driver.execute(
    plan({
      kind: 'fetchTile',
      ticket,
      descriptor: threeDTilesDescriptor(root, 'gltf'),
    }),
  );
  await driver.settled();

  assert.deepEqual(target.failures, ['external asset dependency limit exceeded']);
  assert.equal(externalFetches, 0);
  assert.equal(target.fetched.length, 0);
  assert.equal(target.stagedThreeDTiles.length, 0);
  driver.dispose();
});

void test('kernel policies bound real hierarchy and multi-content HTTP concurrency', async () => {
  const low = await runConcurrencyScenario(1);
  const high = await runConcurrencyScenario(3);

  assert.equal(low.peakRequests, 1);
  assert.equal(high.peakRequests, 3);
  assert.deepEqual(low.final, high.final);
  assert.deepEqual(low.final, { fetchedTiles: 1, hierarchyPages: 1, uploadedTiles: 1 });
});

void test('raising the request limit wakes queued fetches and dispose leaks no permits', async () => {
  const target = new RecordingTarget();
  const pending: Array<() => void> = [];
  let actualActive = 0;
  let actualPeak = 0;
  let aborts = 0;
  const driver = streamingDriver(target, (_uri, init) => {
    actualActive += 1;
    actualPeak = Math.max(actualPeak, actualActive);
    return new Promise<Response>((resolve, reject) => {
      const finish = (): void => {
        actualActive -= 1;
        resolve(new Response(new Uint8Array(32)));
      };
      pending.push(finish);
      init.signal?.addEventListener(
        'abort',
        () => {
          actualActive -= 1;
          aborts += 1;
          reject(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  });
  driver.setRuntimeLimits({ decoderWorkers: 1, contentRequests: 1 });
  driver.execute(
    plan({
      kind: 'fetchTile',
      ticket: { key: { datasetId: 'dynamic', tileId: 'r' }, generation: 1 },
      descriptor: potreeDescriptorWithContents('dynamic', 3),
    }),
  );
  await nextTask();
  assert.deepEqual(driver.diagnostics().limits, { decoderWorkers: 1, contentRequests: 1 });
  assert.equal(driver.diagnostics().activeRequests, 1);
  assert.equal(driver.diagnostics().queuedRequests, 2);
  assert.equal(driver.diagnostics().decodeExecution, 'transferableWebWorkers');
  assert.equal(driver.diagnostics().actualDecodeWorkers, 1);

  driver.setRuntimeLimits({ decoderWorkers: 1, contentRequests: 3 });
  await nextTask();
  assert.equal(actualPeak, 3);
  assert.equal(driver.diagnostics().activeRequests, 3);
  for (const finish of pending.splice(0)) finish();
  await driver.settled();
  assert.equal(driver.diagnostics().activeRequests, 0);
  assert.equal(driver.diagnostics().queuedRequests, 0);

  driver.execute(
    plan({
      kind: 'fetchTile',
      ticket: { key: { datasetId: 'dispose', tileId: 'r' }, generation: 1 },
      descriptor: potreeDescriptorWithContents('dispose', 2),
    }),
  );
  await nextTask();
  driver.setRuntimeLimits({ decoderWorkers: 1, contentRequests: 1 });
  driver.dispose();
  await driver.settled();
  assert.equal(aborts, 2);
  assert.equal(actualActive, 0);
});

void test('decode ceiling remains a Rust claim invariant with real worker capacity', () => {
  const driver = streamingDriver(new RecordingTarget());
  driver.setRuntimeLimits({ decoderWorkers: 1, contentRequests: 4 });
  const ticket = tileTicket();
  assert.throws(
    () =>
      driver.execute({
        render: [],
        renderCount: 0,
        actions: [
          { kind: 'decodeTile', ticket },
          { kind: 'decodeTile', ticket: { ...ticket, generation: 2 } },
        ],
        admission: {},
        eviction: {},
        claimedDecodeMs: 0,
      }),
    /decoder claim ceiling/,
  );
  assert.equal(driver.diagnostics().lastPlanDecodeClaims, 2);
  assert.equal(driver.diagnostics().decodeExecution, 'transferableWebWorkers');
  assert.equal(driver.diagnostics().actualDecodeWorkers, 1);
  driver.dispose();
});

async function runConcurrencyScenario(contentRequests: number): Promise<{
  readonly peakRequests: number;
  readonly final: {
    readonly fetchedTiles: number;
    readonly hierarchyPages: number;
    readonly uploadedTiles: number;
  };
}> {
  const target = new RecordingTarget();
  let active = 0;
  let peak = 0;
  const driver = streamingDriver(target, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return new Response(new Uint8Array(32));
  });
  driver.setRuntimeLimits({ decoderWorkers: 2, contentRequests });
  const ticket = { key: { datasetId: 'bounded', tileId: 'r' }, generation: 1 };
  driver.execute({
    render: [],
    renderCount: 0,
    actions: [
      { kind: 'fetchTile', ticket, descriptor: potreeDescriptorWithContents('bounded', 2) },
      {
        kind: 'fetchHierarchyPage',
        request: {
          owner: { datasetId: 'bounded', tileId: 'hierarchy' },
          reference: {
            uri: 'https://example.test/bounded/hierarchy.bin',
            byteOffset: null,
            byteLength: null,
            contentHash: null,
          },
        },
      },
    ],
    admission: {},
    eviction: {},
    claimedDecodeMs: 0,
  });
  await driver.settled();
  driver.execute(plan({ kind: 'decodeTile', ticket }));
  await driver.settled();
  driver.execute(plan({ kind: 'uploadTile', ticket }));
  const diagnostics = driver.diagnostics();
  assert.equal(active, 0);
  assert.equal(diagnostics.activeRequests, 0);
  assert.equal(diagnostics.queuedRequests, 0);
  assert.equal(diagnostics.peakRequests, peak);
  const final = {
    fetchedTiles: target.fetched.length,
    hierarchyPages: target.appliedHierarchy.length,
    uploadedTiles: target.uploaded.length,
  };
  driver.dispose();
  return { peakRequests: peak, final };
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function streamingDriver(
  target: KernelStreamingTarget,
  fetchBytes?: KernelFetch,
  onStateChange?: () => void,
  resolveAssetUri?: KernelAssetUriResolver,
  decodeExecutor: KernelDecodeExecutor = new ImmediateDecodeExecutor(),
): KernelStreamingDriver {
  return new KernelStreamingDriver(
    target,
    fetchBytes,
    onStateChange,
    resolveAssetUri,
    decodeExecutor,
  );
}

class ImmediateDecodeExecutor implements KernelDecodeExecutor {
  private workers = 1;
  setWorkerCount(workers: number): void {
    this.workers = workers;
  }
  async decode(job: KernelDecodeJob, signal: AbortSignal): Promise<KernelDecodedArtifact> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    return {
      artifact: await mockDecodeArtifact(job),
      primary: job.primary,
      bundle: job.bundle,
      secondary: job.secondary,
      workerDurationMs: 1,
      workerContext: true,
      workerBaselineLinearMemoryBytes: 16 * 1024 * 1024,
      workerLinearMemoryBytes: 16 * 1024 * 1024,
    };
  }
  diagnostics() {
    return {
      requestedDecodeWorkers: this.workers,
      actualDecodeWorkers: this.workers,
      workerRamBudgetBytes: 512 * 1024 * 1024,
      perWorkerReservationBytes: 96 * 1024 * 1024,
      activeDecodes: 0,
      queuedDecodes: 0,
      transferredInputBytes: 0,
      transferredOutputBytes: 0,
      peakTransferBytes: 0,
      completedDecodes: 0,
      failedDecodes: 0,
      canceledDecodes: 0,
      workerDecodeMs: 0,
      mainThreadDispatchMs: 0,
      maximumWorkerBaselineLinearMemoryBytes: 0,
      maximumWorkerLinearMemoryBytes: 0,
    };
  }
  dispose(): void {}
}

class OwnershipDecodeExecutor extends ImmediateDecodeExecutor {
  calls = 0;

  constructor(private readonly crashCall: number) {
    super();
  }

  override async decode(job: KernelDecodeJob, signal: AbortSignal): Promise<KernelDecodedArtifact> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    this.calls += 1;
    const workerJob = structuredClone(job, {
      transfer: [job.primary, job.bundle, job.secondary],
    });
    if (this.calls === this.crashCall) throw new Error('synthetic worker crash');
    const artifact = await mockDecodeArtifact(workerJob);
    return structuredClone(
      {
        artifact,
        primary: workerJob.primary,
        bundle: workerJob.bundle,
        secondary: workerJob.secondary,
        workerDurationMs: 1,
        workerContext: true,
        workerBaselineLinearMemoryBytes: 16 * 1024 * 1024,
        workerLinearMemoryBytes: 16 * 1024 * 1024,
      },
      {
        transfer: [artifact, workerJob.primary, workerJob.bundle, workerJob.secondary],
      },
    );
  }
}

async function mockDecodeArtifact(job: KernelDecodeJob): Promise<ArrayBuffer> {
  const hash = await decodeInputManifestHash(job);
  const artifact = new ArrayBuffer(50);
  const bytes = new Uint8Array(artifact);
  bytes.set(new TextEncoder().encode('HCDECODE'));
  const view = new DataView(artifact);
  view.setUint16(8, 3, true);
  view.setBigUint64(10, 0n, true);
  for (let index = 0; index < 32; index += 1) {
    bytes[18 + index] = Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16);
  }
  return artifact;
}

class RecordingTarget implements KernelStreamingTarget {
  readonly fetched: { ticket: KernelResidencyTicket; cost: KernelResourceCost }[] = [];
  readonly decoded: { ticket: KernelResidencyTicket; cost: KernelResourceCost }[] = [];
  readonly uploaded: { ticket: KernelResidencyTicket; cost: KernelResourceCost }[] = [];
  readonly stagedPotree: { metadata: KernelPotreeContentMetadata; bytes: Uint8Array }[] = [];
  readonly dependencies = new Map<string, readonly KernelAssetDependency[]>();
  readonly stagedThreeDTiles: {
    metadata: KernelThreeDTilesContentMetadata;
    bytes: Uint8Array;
    bundle: KernelResolvedAssetBundle;
  }[] = [];
  readonly removedPotree: string[] = [];
  readonly failedHierarchy: KernelTileKey[] = [];
  readonly appliedHierarchy: KernelTileKey[] = [];
  readonly stagedRaster: {
    metadata: KernelRasterContentMetadata;
    color: Uint8Array;
    elevations: Uint8Array;
  }[] = [];
  readonly publishedTransactions: string[][] = [];
  readonly discarded: string[] = [];
  readonly failures: string[] = [];
  batchPublishError: Error | null = null;
  publishUploadedBytes = 0;

  streamingFetched(ticket: KernelResidencyTicket, cost: KernelResourceCost): void {
    this.fetched.push({ ticket, cost });
  }
  streamingDecoded(ticket: KernelResidencyTicket, cost: KernelResourceCost): void {
    this.decoded.push({ ticket, cost });
  }
  streamingUploaded(ticket: KernelResidencyTicket, cost: KernelResourceCost): void {
    this.uploaded.push({ ticket, cost });
  }
  streamingFailed(_ticket: KernelResidencyTicket, message: string): void {
    this.failures.push(message);
  }
  canonicalStreamBinding(datasetId: string) {
    return {
      key: {
        slot: { entityId: `${datasetId}-entity`, representationSlot: 'streamed-primary' },
        entityRevision: 1,
        entityVersionHash: '11'.repeat(32),
        geometryRef: '22'.repeat(32),
      },
      generation: 1,
    };
  }
  inspect3dTilesDependencies(
    metadata: Pick<KernelThreeDTilesContentMetadata, 'contentUri' | 'contentKind'>,
  ): readonly KernelAssetDependency[] {
    assert.deepEqual(Object.keys(metadata).sort(), ['contentKind', 'contentUri']);
    return this.dependencies.get(metadata.contentUri) ?? [];
  }
  potreeDecodeParameters(): string {
    return '{}';
  }
  stageDecodedStreamingPayload(
    kind:
      | 'gltf'
      | 'threeDTilesContainer'
      | 'potreePoints'
      | 'gaussianSplats'
      | 'raster'
      | 'cadProxy',
    metadataJson: string,
    _artifact: Uint8Array,
    primary: Uint8Array,
    bundleManifestJson: string,
    bundle: Uint8Array,
    secondary: Uint8Array,
  ): KernelResourceCost {
    if (kind === 'potreePoints') {
      this.stagedPotree.push({ metadata: JSON.parse(metadataJson), bytes: primary });
      return { ...zeroCost(), cpuCompressedBytes: primary.byteLength, cpuDecodedBytes: 16 };
    }
    if (kind === 'gltf' || kind === 'threeDTilesContainer') {
      this.stagedThreeDTiles.push({
        metadata: JSON.parse(metadataJson),
        bytes: primary,
        bundle: { manifest: JSON.parse(bundleManifestJson), bytes: bundle },
      });
      return { ...zeroCost(), cpuDecodedBytes: primary.byteLength + bundle.byteLength };
    }
    if (kind === 'raster') {
      this.stagedRaster.push({
        metadata: JSON.parse(metadataJson),
        color: primary,
        elevations: secondary,
      });
      return { ...zeroCost(), cpuDecodedBytes: 68 };
    }
    return zeroCost();
  }
  stage3dTilesContent(
    metadata: KernelThreeDTilesContentMetadata,
    bytes: Uint8Array,
    bundle: KernelResolvedAssetBundle,
  ): KernelResourceCost {
    this.stagedThreeDTiles.push({ metadata, bytes, bundle });
    return { ...zeroCost(), cpuDecodedBytes: bytes.byteLength + bundle.bytes.byteLength };
  }
  publishStaged3dTilesContent(): KernelStreamingPublish {
    return {
      entities: 1,
      proxies: 1,
      generation: 1,
      cost: zeroCost(),
      uploadedBytes: this.publishUploadedBytes,
      streams: [],
    };
  }
  remove3dTilesContent(): boolean {
    return true;
  }
  stagePotreeContent(metadata: KernelPotreeContentMetadata, bytes: Uint8Array): KernelResourceCost {
    this.stagedPotree.push({ metadata, bytes });
    return { ...zeroCost(), cpuCompressedBytes: bytes.byteLength, cpuDecodedBytes: 16 };
  }
  publishStagedPotreeContent(): KernelStreamingPublish {
    return {
      entities: 1,
      proxies: 1,
      generation: 1,
      cost: { ...zeroCost(), cpuCompressedBytes: 12, gpuBufferBytes: 36, points: 1, drawCalls: 1 },
      uploadedBytes: this.publishUploadedBytes,
      streams: [],
    };
  }
  removePotreeContent(streamId: string): boolean {
    this.removedPotree.push(streamId);
    return true;
  }
  stageGaussianSplatContent(): KernelResourceCost {
    return zeroCost();
  }
  publishStagedGaussianSplatContent(): KernelStreamingPublish {
    return {
      entities: 1,
      proxies: 1,
      generation: 1,
      cost: zeroCost(),
      uploadedBytes: this.publishUploadedBytes,
      streams: [],
    };
  }
  removeGaussianSplatContent(): boolean {
    return true;
  }
  stageRasterContent(
    metadata: KernelRasterContentMetadata,
    color: Uint8Array,
    elevations: Uint8Array,
  ): KernelResourceCost {
    this.stagedRaster.push({ metadata, color, elevations });
    return { ...zeroCost(), cpuDecodedBytes: 68 };
  }
  publishStagedRasterContent(): KernelStreamingPublish {
    return {
      entities: 1,
      proxies: 1,
      generation: 1,
      cost: zeroCost(),
      uploadedBytes: this.publishUploadedBytes,
      streams: [],
    };
  }
  publishStagedContents(streamIds: readonly string[]): KernelStreamingPublish {
    this.publishedTransactions.push([...streamIds]);
    if (this.batchPublishError) throw this.batchPublishError;
    const cost =
      this.stagedPotree.length > 0
        ? { ...zeroCost(), cpuCompressedBytes: 12, gpuBufferBytes: 36, points: 1, drawCalls: 1 }
        : zeroCost();
    return {
      entities: 1,
      proxies: 1,
      generation: 1,
      cost,
      uploadedBytes: this.publishUploadedBytes,
      streams: streamIds.map((streamId) => ({
        streamId,
        proxyIds: [`stream:${streamId}`],
      })),
    };
  }
  removeRasterContent(): boolean {
    return true;
  }
  discardStagedContent(streamId: string): boolean {
    this.discarded.push(streamId);
    return true;
  }
  applyHierarchyPage(owner: KernelTileKey): void {
    this.appliedHierarchy.push(owner);
  }
  hierarchyPageFailed(owner: KernelTileKey): void {
    this.failedHierarchy.push(owner);
  }
}

function tileTicket(): KernelResidencyTicket {
  return { key: { datasetId: 'scan', tileId: 'r' }, generation: 1 };
}

function plan(action: KernelStreamingFramePlan['actions'][number]): KernelStreamingFramePlan {
  return {
    render: [],
    renderCount: 0,
    actions: [action],
    admission: {},
    eviction: {},
    claimedDecodeMs: 0,
  };
}

function threeDTilesDescriptor(
  uri: string,
  kind: 'gltf' | 'threeDTilesContainer' = 'threeDTilesContainer',
  decoderParameters: Readonly<Record<string, unknown>> | null = null,
) {
  return {
    id: 'r',
    parent: null,
    children: [],
    bounds: { kind: 'sphere' as const, center: { x: 0, y: 0, z: 0 }, radius: 10 },
    contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    geometricError: 0,
    refinement: 'replace' as const,
    childPage: null,
    contents: [
      {
        kind,
        uri,
        byteOffset: null,
        byteLength: null,
        primitiveCount: null,
        contentHash: null,
        decoderParameters,
      },
    ],
  };
}

async function testSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function potreeDescriptorWithContents(dataset: string, count: number) {
  return {
    id: 'r',
    parent: null,
    children: [],
    bounds: { kind: 'sphere' as const, center: { x: 0, y: 0, z: 0 }, radius: 10 },
    contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    geometricError: 0,
    refinement: 'replace' as const,
    childPage: null,
    contents: Array.from({ length: count }, (_, index) => ({
      kind: 'potreePoints' as const,
      uri: `https://example.test/${dataset}/${index}.bin`,
      byteOffset: null,
      byteLength: null,
      primitiveCount: 1,
      contentHash: null,
      decoderParameters: null,
    })),
  };
}

function zeroCost(): KernelResourceCost {
  return {
    cpuCompressedBytes: 0,
    cpuDecodedBytes: 0,
    gpuBufferBytes: 0,
    gpuTextureBytes: 0,
    stagingBytes: 0,
    points: 0,
    triangles: 0,
    splats: 0,
    drawCalls: 0,
  };
}
