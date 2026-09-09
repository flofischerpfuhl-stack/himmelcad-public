import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  deterministicStrideIndices,
  oracleSampleIndices,
  parsePlyHeader,
  readPlyHeader,
  streamPlySamples,
} from './photolab-ply.mjs';

const SPARSE_HEADER = `ply
format binary_little_endian 1.0
element vertex 16844
property double x
property double y
property double z
property uchar red
property uchar green
property uchar blue
property float reprojection_error
end_header
`;

const DENSE_HEADER = `ply
format binary_little_endian 1.0
element vertex 45772941
property double x
property double y
property double z
property uchar red
property uchar green
property uchar blue
property float confidence
property float nx
property float ny
property float nz
end_header
`;

test('parses the sparse PhotoLab PLY layout', () => {
  const header = parsePlyHeader(SPARSE_HEADER);
  assert.equal(header.vertexCount, 16844);
  assert.equal(header.recordSize, 31);
  assert.deepEqual(
    header.properties.map(({ name, offset }) => [name, offset]),
    [
      ['x', 0],
      ['y', 8],
      ['z', 16],
      ['red', 24],
      ['green', 25],
      ['blue', 26],
      ['reprojection_error', 27],
    ],
  );
});

test('parses the dense PhotoLab PLY layout generically', () => {
  const header = parsePlyHeader(DENSE_HEADER);
  assert.equal(header.vertexCount, 45772941);
  assert.equal(header.recordSize, 43);
  assert.equal(header.properties.find(({ name }) => name === 'confidence').offset, 27);
  assert.equal(header.properties.find(({ name }) => name === 'nz').offset, 39);
});

test('rejects an ASCII PLY', () => {
  assert.throws(
    () =>
      parsePlyHeader(`ply
format ascii 1.0
element vertex 1
property double x
property double y
property double z
end_header
0 0 0
`),
    /Unsupported PLY format: ascii/,
  );
});

test('streams exact samples from a 1,000-point binary PLY', async () => {
  const scratchRoot = path.join(process.cwd(), '.build', 'codex-scratch', 'g1c-oracle');
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(path.join(scratchRoot, 'ply-test-'));
  try {
    const headerText = SPARSE_HEADER.replace('16844', '1000');
    const body = Buffer.alloc(1000 * 31);
    for (let index = 0; index < 1000; index += 1) {
      const offset = index * 31;
      body.writeDoubleLE(index + 0.125, offset);
      body.writeDoubleLE(-index - 0.25, offset + 8);
      body.writeDoubleLE(index * 2 + 0.5, offset + 16);
      body.writeUInt8(index % 256, offset + 24);
      body.writeUInt8((index + 1) % 256, offset + 25);
      body.writeUInt8((index + 2) % 256, offset + 26);
      body.writeFloatLE(index / 10, offset + 27);
    }
    const filePath = path.join(directory, 'synthetic.ply');
    await writeFile(filePath, Buffer.concat([Buffer.from(headerText), body]));
    const header = await readPlyHeader(filePath);
    const indices = oracleSampleIndices(header.vertexCount);
    const samples = await streamPlySamples(filePath, indices, header);
    assert.deepEqual(indices, [0, 125, 250, 500, 750, 875, 999]);
    assert.deepEqual(
      samples.map(({ index, xyz }) => ({ index, xyz })),
      indices.map((index) => ({ index, xyz: [index + 0.125, -index - 0.25, index * 2 + 0.5] })),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sample-index functions are deterministic', () => {
  const expectedOracle = [0, 2, 4, 8, 12, 14, 16];
  const expectedStride = [0, 4, 8, 12, 16];
  for (let iteration = 0; iteration < 10; iteration += 1) {
    assert.deepEqual(oracleSampleIndices(17), expectedOracle);
    assert.deepEqual(deterministicStrideIndices(17, 5), expectedStride);
  }
});
