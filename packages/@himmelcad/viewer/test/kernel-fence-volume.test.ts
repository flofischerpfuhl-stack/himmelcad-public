import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertFenceVolume,
  fencePrismFromPolygon,
  fencePolygonArea,
  fenceVolumeContains,
  fenceVolumeFromCamera,
  type KernelWorldCamera,
} from '../src/kernel/index.js';

const polygon = [
  { x: -1, y: -1, z: 0 },
  { x: 1, y: -1, z: 0 },
  { x: 1, y: 1, z: 0 },
  { x: -1, y: 1, z: 0 },
] as const;

void test('PC-D5 perspective fence is projection-true at multiple depths', () => {
  const camera: KernelWorldCamera = {
    eye: { x: 0, y: 0, z: 10 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    projection: {
      kind: 'perspective',
      verticalFovRadians: Math.PI / 3,
      aspect: 1,
      near: 0.01,
      far: 1_000,
    },
  };
  const volume = fenceVolumeFromCamera(camera, polygon);
  assert.equal(volume.kind, 'frustum');
  assertFenceVolume(volume);
  assert.equal(fenceVolumeContains(volume, [0.9, 0, 0]), true);
  assert.equal(fenceVolumeContains(volume, [0.9, 0, -10]), true);
  assert.equal(fenceVolumeContains(volume, [1.8, 0, -10]), true);
  assert.equal(fenceVolumeContains(volume, [2.1, 0, -10]), false);
  assert.equal(fenceVolumeContains(volume, [0.6, 0, 5]), false);
  assert.equal(fenceVolumeContains(volume, [0.4, 0, 5]), true);
});

void test('PC-D5 orthographic fence is an infinite view-direction prism', () => {
  const camera: KernelWorldCamera = {
    eye: { x: 0, y: 0, z: 10 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    projection: { kind: 'orthographic', verticalSpan: 10, aspect: 1, near: 0.01, far: 1_000 },
  };
  const volume = fenceVolumeFromCamera(camera, polygon);
  assert.equal(volume.kind, 'prism');
  assert.equal(fenceVolumeContains(volume, [0.9, 0.9, -100]), true);
  assert.equal(fenceVolumeContains(volume, [1.1, 0, 100]), false);
  assert.equal(fencePolygonArea(volume.polygon), 4);
});

void test('PC-D5 typed polygon produces a camera-free prism', () => {
  const volume = fencePrismFromPolygon(polygon);
  assertFenceVolume(volume);
  assert.equal(fenceVolumeContains(volume, [0.75, 0.25, 50]), true);
  assert.equal(fenceVolumeContains(volume, [1.25, 0.25, 50]), false);
});

void test('PC-D5 prism membership follows an oblique extrusion direction', () => {
  const volume = {
    kind: 'prism',
    polygon: polygon.map(({ x, y, z }) => [x, y, z] as const),
    direction: [1, 0, 1],
  } as const;
  assertFenceVolume(volume);
  assert.equal(fenceVolumeContains(volume, [5.5, 0, 5]), true);
  assert.equal(fenceVolumeContains(volume, [3.5, 0, 5]), false);
});

void test('PC-D5 box membership respects typed extents', () => {
  const box = {
    kind: 'box',
    center: [1, 2, 3],
    halfExtents: [2, 1, 0.5],
    rotation: [0, 0, 0, 1],
  } as const;
  assertFenceVolume(box);
  assert.equal(fenceVolumeContains(box, [3, 3, 3.5]), true);
  assert.equal(fenceVolumeContains(box, [3.01, 3, 3.5]), false);

  const halfTurn = Math.SQRT1_2;
  const rotated = { ...box, rotation: [0, 0, halfTurn, halfTurn] as const };
  assertFenceVolume(rotated);
  assert.equal(fenceVolumeContains(rotated, [1, 4, 3]), true);
  assert.equal(fenceVolumeContains(rotated, [3, 2, 3]), false);
});
