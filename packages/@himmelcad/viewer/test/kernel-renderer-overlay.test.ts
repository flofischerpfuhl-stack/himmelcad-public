import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cssColorToLinearRgba,
  overlayAnchorSquare,
  overlayDirectionArrow,
  overlayMidpointPixelOffset,
  overlaySupportRoleGeometry,
} from '../src/kernel/KernelRendererOverlay.js';

void test('V-05 anchor squares retain the DOM overlay centre within one pixel', () => {
  const square = overlayAnchorSquare(
    'anchor',
    { x: 10, y: 20, z: 30 },
    cssColorToLinearRgba('#43b9ff'),
    6,
  );
  assert.deepEqual(square.offsets, [
    [-3, -3],
    [3, -3],
    [3, 3],
    [-3, 3],
  ]);
});

void test('V-05 label chips retain the DOM first/last-anchor midpoint within one pixel', () => {
  assert.deepEqual(overlayMidpointPixelOffset([100, 80], [140, 100]), [20, 22]);
});

void test('V-05 explicit support roles produce support-blue point and line payloads', () => {
  const support = cssColorToLinearRgba('#43b9ff');
  const points = [
    { x: 1, y: 2, z: 3 },
    { x: 4, y: 5, z: 6 },
  ];
  const payload = overlaySupportRoleGeometry('definition', 'defining_curve', points, support);
  assert.equal(payload.lines.length, 1);
  assert.equal(payload.quads.length, 2);
  assert.deepEqual(payload.lines[0]?.color, support);
  assert.deepEqual(payload.quads[0]?.color, support);
});

void test('V-05 selected-polyline direction glyph ends at the projected DOM endpoint', () => {
  const glyph = overlayDirectionArrow(
    'selected-line',
    { x: 4, y: 5, z: 6 },
    [100, 100],
    [108, 100],
    cssColorToLinearRgba('#ff9f1c'),
    8,
  );
  for (const arm of glyph) {
    const tipCentre = [
      (arm.offsets[0][0] + arm.offsets[3][0]) / 2,
      (arm.offsets[0][1] + arm.offsets[3][1]) / 2,
    ];
    assert.ok(Math.abs(tipCentre[0]!) <= 1);
    assert.ok(Math.abs(tipCentre[1]!) <= 1);
  }
});
