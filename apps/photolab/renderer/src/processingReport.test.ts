import assert from 'node:assert/strict';
import test from 'node:test';

import { calibrationHeatmapShadePercent, calibrationRadialBinPoints } from './processingReport.js';

test('heatmap shade grows with |correlation| and is bounded', () => {
  const zero = calibrationHeatmapShadePercent(0);
  const half = calibrationHeatmapShadePercent(-0.5);
  const full = calibrationHeatmapShadePercent(1);
  assert.ok(zero < half && half < full, `${zero} < ${half} < ${full}`);
  assert.equal(calibrationHeatmapShadePercent(-1), full);
  assert.equal(calibrationHeatmapShadePercent(4), full);
  assert.equal(calibrationHeatmapShadePercent(Number.NaN), zero);
  assert.ok(zero >= 0 && full <= 100);
});

test('radial bin points map one point per bin onto the profile box', () => {
  const bins = [0, 0.5, 1, 2].map((residual, index) => ({
    radiusStart: index / 4,
    radiusEnd: (index + 1) / 4,
    count: 10,
    meanAbsoluteResidualPixels: residual,
  }));
  const points = calibrationRadialBinPoints(bins, 2, 100, 50).split(' ');
  assert.equal(points.length, 4);
  const [x0, y0] = points[0]!.split(',').map(Number);
  const [x3, y3] = points[3]!.split(',').map(Number);
  assert.equal(x0, 0);
  assert.equal(y0, 50);
  assert.equal(x3, 100);
  assert.equal(y3, 0);
  for (const point of points) {
    const [, y] = point.split(',').map(Number);
    assert.ok(y! >= 0 && y! <= 50);
  }
});

test('radial bin points survive a single bin, an empty list and a zero maximum', () => {
  assert.equal(calibrationRadialBinPoints([], 0), '');
  const single = calibrationRadialBinPoints(
    [{ radiusStart: 0, radiusEnd: 1, count: 1, meanAbsoluteResidualPixels: 3 }],
    0,
    100,
    50,
  );
  assert.equal(single, '50.00,0.00');
});
