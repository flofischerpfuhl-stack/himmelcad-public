import assert from 'node:assert/strict';
import test from 'node:test';

import type { PhotolabJob } from '@himmelcad/data';

import {
  buildProcessingReportHtml,
  calibrationHeatmapShadePercent,
  calibrationRadialBinPoints,
} from './processingReport.js';

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

test('processing report renders a tiled memory envelope without claiming degradation', () => {
  const job: PhotolabJob = {
    schemaVersion: 1,
    id: 'alignment-memory-test',
    kind: 'alignPhotos',
    configHash: '0'.repeat(64) as PhotolabJob['configHash'],
    inputHash: '1'.repeat(64) as PhotolabJob['inputHash'],
    state: { kind: 'completed' },
    progress: {
      stage: { kind: 'finalizing', index: 3, stageCount: 4, label: 'Finalize alignment' },
      metrics: { completedUnits: 1, totalUnits: 1, completedBytes: 0 },
    },
    createdAtUnixMs: 1_000,
    startedAtUnixMs: 2_000,
    finishedAtUnixMs: 3_000,
    memory: {
      envelopeBytes: Math.floor(10.3 * 1024 ** 3),
      stages: [
        {
          stage: 'Extract ALIKED',
          peakRssBytes: 8_212_656_000,
          workers: 1,
          parameters: { tileColumns: 2, tileRows: 1, tileOverlapPx: 256 },
        },
        {
          stage: 'Match ALIKED with LightGlue',
          peakRssBytes: 7_180_435_456,
          workers: 1,
          parameters: { keypoints: 24_000, sequentialPairBatches: true },
        },
      ],
      timeFirstChoices: [{ kind: 'extractionTiled', tiles: 2, overlapPx: 256 }],
      degradations: [],
      observations: [],
    },
  };
  const report = buildProcessingReportHtml({
    project: { id: 'project-memory-test', name: 'Memory test', formatVersion: 1 },
    jobs: [job],
    products: [],
    hardware: null,
    accuracy: null,
    processingSets: [],
    captureGroups: [],
    calibrationGroups: [],
    alignmentMerges: [],
    alignmentRuns: [],
    gcpOptimizations: [],
    surveyData: null,
    generatedAt: new Date('2026-09-08T12:00:00.000Z'),
    generatedAtSource: 'Test fixture',
  });

  assert.match(report, /<h2>Memory envelope<\/h2>/);
  assert.match(report, /Envelope<\/dt><dd>10\.30 GiB/);
  assert.match(report, /Extraction tiled: 2 tiles · 256 px overlap/);
  assert.match(report, /No quality degradations recorded/);
  assert.match(report, /Extract ALIKED/);
  assert.match(report, /7\.65 GiB/);
  assert.match(report, /Match ALIKED with LightGlue/);
});
