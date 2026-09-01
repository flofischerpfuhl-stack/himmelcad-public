import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resizeViewingBox,
  resizeViewingBoxFace,
  rotateViewingBox,
  viewingBoxAxes,
  viewingBoxClipVolume,
  viewingBoxFromViewport,
} from '../src/kernel/KernelViewingBox.js';

void test('viewing box starts at a zoom-relative size and emits six inward planes', () => {
  const state = viewingBoxFromViewport({
    id: 'tool:viewing-box',
    center: { x: 100, y: 200, z: 20 },
    visibleWidth: 40,
    visibleHeight: 20,
    visibleDepth: 10,
  });
  assert.deepEqual(state.halfExtents, { x: 12, y: 6, z: 3 });
  const volume = viewingBoxClipVolume(state);
  assert.equal(volume.planes.length, 6);
  assert.equal(volume.operation, 'keepInside');
  assert.equal(volume.previewCap, true);
  assert.equal(viewingBoxClipVolume(state, false).previewCap, false);
  assert.ok(volume.planes.every((plane) => signedDistance(plane, state.center) >= 0));
  assert.ok(volume.planes.some((plane) => signedDistance(plane, { x: 113, y: 200, z: 20 }) < 0));
});

void test('rotation changes local axes without changing center or extents', () => {
  const initial = viewingBoxFromViewport({
    center: { x: 0, y: 0, z: 0 },
    visibleWidth: 10,
    visibleHeight: 10,
  });
  const rotated = rotateViewingBox(initial, 'z', Math.PI / 2);
  const [xAxis, yAxis, zAxis] = viewingBoxAxes(rotated);
  assertPointClose(xAxis, { x: 0, y: 1, z: 0 });
  assertPointClose(yAxis, { x: -1, y: 0, z: 0 });
  assertPointClose(zAxis, { x: 0, y: 0, z: 1 });
  assert.deepEqual(rotated.center, initial.center);
  assert.deepEqual(rotated.halfExtents, initial.halfExtents);
});

void test('anchored resize keeps the opposite face fixed', () => {
  const initial = viewingBoxFromViewport({
    center: { x: 0, y: 0, z: 0 },
    visibleWidth: 20,
    visibleHeight: 20,
  });
  const negativeFace = initial.center.x - initial.halfExtents.x;
  const resized = resizeViewingBox(initial, 'x', 4, true);
  assert.equal(resized.halfExtents.x, initial.halfExtents.x + 2);
  assert.equal(resized.center.x - resized.halfExtents.x, negativeFace);
});

void test('face resize can overdrag beyond the opposite face', () => {
  const initial = viewingBoxFromViewport({
    center: { x: 0, y: 0, z: 0 },
    visibleWidth: 20,
    visibleHeight: 20,
  });
  const fixedPositiveFace = initial.center.x + initial.halfExtents.x;
  const resized = resizeViewingBoxFace(initial, 'x', -1, 18, true);
  assert.equal(resized.center.x - resized.halfExtents.x, fixedPositiveFace);
  assert.equal(resized.halfExtents.x, 3);
  assert.equal(resized.center.x, fixedPositiveFace + 3);
});

void test('uniform viewing box uses a calibrated fraction of the smaller visible span', () => {
  const state = viewingBoxFromViewport({
    center: { x: 0, y: 0, z: 0 },
    visibleWidth: 12,
    visibleHeight: 8,
    visibleDepth: 20,
    viewFraction: 0.25,
    uniform: true,
  });
  assert.deepEqual(state.halfExtents, { x: 1, y: 1, z: 1 });
  assert.equal(state.mode, 'resize');
});

function signedDistance(
  plane: {
    readonly normal: { readonly x: number; readonly y: number; readonly z: number };
    readonly distance: number;
  },
  point: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return (
    plane.normal.x * point.x + plane.normal.y * point.y + plane.normal.z * point.z + plane.distance
  );
}

function assertPointClose(
  actual: { readonly x: number; readonly y: number; readonly z: number },
  expected: { readonly x: number; readonly y: number; readonly z: number },
): void {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-12);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-12);
  assert.ok(Math.abs(actual.z - expected.z) < 1e-12);
}
