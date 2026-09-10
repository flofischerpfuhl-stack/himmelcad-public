import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { readGltfPositionSamples } from './photolab-gltf.mjs';

const SCRATCH_ROOT = path.resolve('.build/codex-scratch/g1c-mesh');

function glb(document, binary) {
  const source = Buffer.from(JSON.stringify(document));
  const jsonLength = Math.ceil(source.length / 4) * 4;
  const binaryLength = Math.ceil(binary.length / 4) * 4;
  const result = Buffer.alloc(12 + 8 + jsonLength + 8 + binaryLength);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonLength, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  result.fill(0x20, 20, 20 + jsonLength);
  source.copy(result, 20);
  const binaryHeader = 20 + jsonLength;
  result.writeUInt32LE(binaryLength, binaryHeader);
  result.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(result, binaryHeader + 8);
  return result;
}

async function temporaryDirectory() {
  await mkdir(SCRATCH_ROOT, { recursive: true });
  return mkdtemp(path.join(SCRATCH_ROOT, 'gltf-'));
}

async function cleanup(directory) {
  await rm(directory, { recursive: true, force: true });
  await rm(SCRATCH_ROOT, { recursive: false }).catch(() => {});
}

test('reads a strided external FLOAT VEC3 accessor and composes tile and node transforms', async () => {
  const directory = await temporaryDirectory();
  try {
    const binary = Buffer.alloc(52);
    [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ].forEach((point, index) => {
      point.forEach((value, axis) => binary.writeFloatLE(value, 8 + index * 16 + axis * 4));
    });
    await writeFile(path.join(directory, 'positions.bin'), binary);
    await writeFile(
      path.join(directory, 'tile.gltf'),
      JSON.stringify({
        asset: { version: '2.0' },
        buffers: [{ uri: 'positions.bin', byteLength: binary.length }],
        bufferViews: [{ buffer: 0, byteOffset: 4, byteLength: 48, byteStride: 16 }],
        accessors: [{ bufferView: 0, byteOffset: 4, componentType: 5126, count: 3, type: 'VEC3' }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        nodes: [
          { translation: [1, 0, 0], children: [1] },
          { scale: [2, 3, 4], mesh: 0 },
        ],
        scenes: [{ nodes: [0] }],
        scene: 0,
      }),
    );
    const result = await readGltfPositionSamples(path.join(directory, 'tile.gltf'), {
      tileTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1],
    });
    assert.deepEqual(
      result.samples.map((sample) => sample.xyz),
      [
        [13, 26, 42],
        [19, 35, 54],
        [25, 44, 66],
      ],
    );
    assert.equal(result.transform.node_index, 1);
  } finally {
    await cleanup(directory);
  }
});

test('reads POSITION samples from a GLB binary chunk', async () => {
  const directory = await temporaryDirectory();
  try {
    const binary = Buffer.alloc(36);
    [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach((value, index) => binary.writeFloatLE(value, index * 4));
    const document = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: binary.length }],
      bufferViews: [{ buffer: 0, byteLength: binary.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1], mesh: 0 }],
      scenes: [{ nodes: [0] }],
    };
    const filePath = path.join(directory, 'tile.glb');
    await writeFile(filePath, glb(document, binary));
    const result = await readGltfPositionSamples(filePath);
    assert.deepEqual(
      result.samples.map((sample) => sample.xyz),
      [
        [6, 8, 10],
        [9, 11, 13],
        [12, 14, 16],
      ],
    );
  } finally {
    await cleanup(directory);
  }
});

test('rejects a POSITION accessor that is not FLOAT VEC3', async () => {
  const directory = await temporaryDirectory();
  try {
    const document = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 18 }],
      bufferViews: [{ buffer: 0, byteLength: 18 }],
      accessors: [{ bufferView: 0, componentType: 5123, count: 3, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    };
    const filePath = path.join(directory, 'tile.glb');
    await writeFile(filePath, glb(document, Buffer.alloc(18)));
    await assert.rejects(
      readGltfPositionSamples(filePath),
      /must use componentType FLOAT and type VEC3/u,
    );
  } finally {
    await cleanup(directory);
  }
});
