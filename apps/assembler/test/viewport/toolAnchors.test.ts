import assert from 'node:assert/strict';
import test from 'node:test';

import { findAnchorPixel } from '../../renderer/src/platform/viewport/automation.js';
import { buildScreenRibbon } from '../../renderer/src/platform/viewport/geometry.js';

import {
  handleTip,
  sectionHandle,
  sectionNormal,
  sectionOutline,
} from '../../renderer/src/platform/viewport/section.js';

const BOUNDS = {
  min: [0, 0, 0] as [number, number, number],
  max: [80, 50, 46] as [number, number, number],
};

void test('section outline is bounded to the model extent plus a margin, at the offset', () => {
  const corners = sectionOutline({ axis: 'Z', offset: 23, flipped: false }, BOUNDS);
  const margin = 80 * 0.1;
  for (const c of corners) assert.equal(c[2], 23);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  assert.equal(Math.min(...xs), -margin);
  assert.equal(Math.max(...xs), 80 + margin);
  assert.equal(Math.min(...ys), -margin);
  assert.equal(Math.max(...ys), 50 + margin);
  const x = sectionOutline({ axis: 'X', offset: 40, flipped: true }, BOUNDS);
  for (const c of x) assert.equal(c[0], 40);
});

void test('section normal flips; the handle sits on the plane centre and points to the cut side', () => {
  assert.deepEqual(sectionNormal({ axis: 'Y', offset: 0, flipped: false }), [0, 1, 0]);
  assert.deepEqual(sectionNormal({ axis: 'Y', offset: 0, flipped: true }), [0, -1, 0]);
  const handle = sectionHandle({ axis: 'Z', offset: 23, flipped: true }, BOUNDS);
  assert.deepEqual(handle.base, [40, 25, 23]);
  assert.deepEqual(handle.dir, [0, 0, -1]);
  assert.deepEqual(handle.dragDir, [0, 0, 1], 'dragging up always raises the offset');
  assert.equal(handle.value, 23);
  assert.ok(handleTip(handle)[2] < 23);
});

void test('anchor search picks a pixel deep inside the visible area of the target', () => {
  const width = 40;
  const height = 30;
  const pixels = new Uint8Array(width * height * 4);
  // Target id 7 covers x 10..29, rows (bottom-up) 5..24; id 3 elsewhere in a stripe.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (x >= 10 && x < 30 && y >= 5 && y < 25) pixels[o] = 7;
      else if (x < 5) pixels[o] = 3;
    }
  }
  const anchor = findAnchorPixel({ width, height, pixels }, new Set([7]));
  assert.ok(anchor);
  assert.ok(anchor.x >= 17 && anchor.x <= 22, `x ${anchor.x}`);
  // Top-left origin: bottom-up rows 5..24 are top-down rows 5..24 as well (30 - 1 - y).
  assert.ok(anchor.y >= 12 && anchor.y <= 17, `y ${anchor.y}`);
  assert.equal(findAnchorPixel({ width, height, pixels }, new Set([9])), null);
});

void test('screen ribbons have a constant pixel width and are pulled towards the eye', () => {
  const eye: [number, number, number] = [0, 0, 100];
  const segment = new Float32Array([-10, 0, 0, 10, 0, 0]);
  const perPixel = (distance: number) => distance / 1000;
  const ribbon = buildScreenRibbon(segment, eye, 3, perPixel, 3);
  assert.equal(ribbon.length, 18);
  const ys = [];
  const zs = [];
  for (let i = 0; i < ribbon.length; i += 3) {
    ys.push(ribbon[i + 1]!);
    zs.push(ribbon[i + 2]!);
  }
  const width = Math.max(...ys) - Math.min(...ys);
  assert.ok(Math.abs(width - 3 * (100 / 1000)) < 0.02, `width ${width}`);
  for (const z of zs) assert.ok(z > 0, 'nudged towards the eye');
});
