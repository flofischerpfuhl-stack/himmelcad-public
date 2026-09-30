import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeMeshPayload,
  encodeMeshPayload,
  MAX_DECOMPRESSED_MESH_BYTES,
  MeshPayloadTooLargeError,
} from '../../../renderer/src/foundation/document/meshCodec.js';

void test('encode/decode round trip preserves positions, normals and indices exactly', async () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint32Array([0, 1, 2]);
  const encoded = await encodeMeshPayload({ positions, normals, indices });
  assert.equal(typeof encoded, 'string');
  const decoded = await decodeMeshPayload(encoded);
  assert.deepEqual(Array.from(decoded.positions), Array.from(positions));
  assert.deepEqual(Array.from(decoded.normals), Array.from(normals));
  assert.deepEqual(Array.from(decoded.indices), Array.from(indices));
});

void test('round trip of an empty mesh does not throw', async () => {
  const encoded = await encodeMeshPayload({
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
  });
  const decoded = await decodeMeshPayload(encoded);
  assert.equal(decoded.positions.length, 0);
});

void test('a payload that decompresses over the size limit is rejected with MeshPayloadTooLargeError, never a crash', async () => {
  // A large, uniform (so gzip is efficient) mesh whose decompressed size
  // exceeds the limit — the point is that decoding rejects it cleanly
  // rather than allocating/crashing.
  const floatsOverLimit = Math.ceil(MAX_DECOMPRESSED_MESH_BYTES / 4) + 1024;
  const positions = new Float32Array(floatsOverLimit); // all zeros: compresses extremely well
  const encoded = await encodeMeshPayload({
    positions,
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
  });
  await assert.rejects(() => decodeMeshPayload(encoded), MeshPayloadTooLargeError);
});

void test('malformed base64/garbage payload is rejected with a plain Error, not a crash', async () => {
  await assert.rejects(() => decodeMeshPayload('not-valid-base64-gzip'));
});
