import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignEdgeKeys,
  assignFaceKeys,
  resolveEdgeRef,
  resolveFaceRef,
  reverseGeom,
  sameSurface,
  type FaceGeom,
  type KeyedFace,
} from '../../renderer/src/kernel/naming.js';
import type { Vec3 } from '../../renderer/src/model/document.js';

function plane(normal: Vec3, offset: number, centroid: Vec3, area = 100): FaceGeom {
  return { surface: 'plane', id: { type: 'plane', normal, offset }, normal, centroid, area };
}

const order = new Map([
  ['f1', 0],
  ['f2', 1],
  ['f3', 2],
]);

void test('surface identity: same plane matches, opposite side does not; a cut tool face is reversed', () => {
  const a = plane([0, 0, 1], 6, [0, 0, 6]);
  const b = plane([0, 0, 1], 6 + 1e-6, [10, 0, 6]);
  const c = plane([0, 0, -1], -6, [0, 0, 6]);
  assert.equal(sameSurface(a.id, b.id), true);
  assert.equal(sameSurface(a.id, c.id), false);
  assert.equal(sameSurface(reverseGeom(c).id, a.id), true);
});

void test('merged coplanar faces take the earliest feature key and keep the other as alias', () => {
  const inputs: KeyedFace[] = [
    { ...plane([0, -1, 0], 0, [40, 0, 3]), key: 'f2:side:0:0', aliases: [] },
    { ...plane([0, -1, 0], 0, [40, 0, 26]), key: 'f1:side:0:0', aliases: [] },
  ];
  const keys = assignFaceKeys([plane([0, -1, 0], 0, [40, 0, 20])], inputs, order, () => 'x:new');
  assert.deepEqual(keys, [{ key: 'f1:side:0:0', aliases: ['f2:side:0:0'] }]);
});

void test('a split face gets #n suffixes in centroid order; new faces use the namer', () => {
  const inputs: KeyedFace[] = [
    { ...plane([0, 0, 1], 6, [40, 25, 6]), key: 'f1:end:0', aliases: [] },
  ];
  const result = [
    plane([0, 0, 1], 6, [60, 25, 6]),
    plane([0, 0, 1], 6, [20, 25, 6]),
    plane([1, 0, 0], 50, [50, 25, 3]),
  ];
  const keys = assignFaceKeys(result, inputs, order, (i) => `f3:new:${i}`);
  assert.deepEqual(
    keys.map((k) => k.key),
    ['f1:end:0#2', 'f1:end:0#1', 'f3:new:2'],
  );
});

void test('resolution: key first, then a strict geometric fallback, else Missing reference', () => {
  const faces = [
    {
      key: 'f1:end:0',
      aliases: [],
      surface: 'plane' as const,
      normal: [0, 0, 1] as Vec3,
      centroid: [40, 25, 6] as Vec3,
      area: 4000,
    },
    {
      key: 'f2:end:0',
      aliases: ['f1:side:0:1'],
      surface: 'plane' as const,
      normal: [1, 0, 0] as Vec3,
      centroid: [80, 25, 3] as Vec3,
      area: 300,
    },
  ];
  const sig = (centroid: Vec3, area: number, normal: Vec3) => ({
    surface: 'plane' as const,
    normal,
    centroid,
    area,
    adjacentFaces: 4,
  });
  assert.deepEqual(
    resolveFaceRef({ key: 'f1:end:0', signature: sig([0, 0, 0], 1, [0, 0, 1]) }, faces, 100),
    {
      ok: true,
      index: 0,
      rebound: false,
    },
  );
  // Alias match.
  assert.deepEqual(
    resolveFaceRef({ key: 'f1:side:0:1', signature: sig([0, 0, 0], 1, [1, 0, 0]) }, faces, 100),
    {
      ok: true,
      index: 1,
      rebound: false,
    },
  );
  // Unknown key, geometry within 1% of the diagonal and 5% area: re-bound, flagged.
  assert.deepEqual(
    resolveFaceRef({ key: 'gone', signature: sig([40.5, 25, 6], 4050, [0, 0, 1]) }, faces, 100),
    {
      ok: true,
      index: 0,
      rebound: true,
    },
  );
  // Unknown key, geometry moved too far: missing, never a silent re-bind.
  const missing = resolveFaceRef(
    { key: 'gone', signature: sig([45, 25, 6], 4000, [0, 0, 1]) },
    faces,
    100,
  );
  assert.equal(missing.ok, false);
});

void test('edge keys come from the two face keys; resolution matches either order and aliases', () => {
  const faces = [
    {
      key: 'a',
      aliases: [],
      surface: 'plane' as const,
      normal: [0, 0, 1] as Vec3,
      centroid: [0, 0, 0] as Vec3,
      area: 1,
    },
    {
      key: 'b',
      aliases: ['b-old'],
      surface: 'plane' as const,
      normal: [0, 1, 0] as Vec3,
      centroid: [0, 0, 0] as Vec3,
      area: 1,
    },
  ];
  const edges = [
    {
      faceIndices: [1, 0],
      curve: 'line' as const,
      midpoint: [0, 0, 0] as Vec3,
      length: 10,
      direction: [1, 0, 0] as Vec3,
    },
  ];
  assert.deepEqual(assignEdgeKeys(edges, ['a', 'b']), ['a|b']);
  const signature = {
    curve: 'line' as const,
    midpoint: [0, 0, 0] as Vec3,
    length: 10,
    direction: [1, 0, 0] as Vec3,
  };
  assert.equal(resolveEdgeRef({ key: 'b-old|a', signature }, edges, faces, 100).ok, true);
  const gone = resolveEdgeRef(
    { key: 'a|c', signature: { ...signature, midpoint: [50, 0, 0] } },
    edges,
    faces,
    100,
  );
  assert.equal(gone.ok, false);
  if (!gone.ok) assert.match(gone.message, /^Missing reference: edge/);
});
