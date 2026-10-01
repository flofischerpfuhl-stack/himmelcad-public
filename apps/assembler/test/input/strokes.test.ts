/**
 * Pen stroke recognizer (`platform/input/strokes.ts`) on synthetic
 * hand-drawn strokes (`strokeFixtures.ts`): lines (with axis snapping),
 * arcs, circles, rectangles (axis-aligned and rotated), open and closed
 * polylines, scribbles, and strokes that must not be recognised.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fitCircle,
  fitLine,
  polylinesTouch,
  recognizeStroke,
  resample,
  type RecognizedStroke,
  type Vec2,
} from '../../renderer/src/platform/input/strokes.js';
import {
  arcStroke,
  circleStroke,
  lineStroke,
  polylineStroke,
  rectangleStroke,
  rotatedRectangleStroke,
  scribbleStroke,
} from './strokeFixtures.js';

const near = (a: number, b: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${what}: ${a} vs ${b}`);

function as<K extends RecognizedStroke['kind']>(
  result: RecognizedStroke,
  kind: K,
): Extract<RecognizedStroke, { kind: K }> {
  assert.equal(
    result.kind,
    kind,
    `recognised as ${result.kind}${'reason' in result ? ` (${result.reason})` : ''}`,
  );
  return result as Extract<RecognizedStroke, { kind: K }>;
}

void test('helpers: resample, line and circle fits', () => {
  const pts: Vec2[] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  const r = resample(pts, 5);
  assert.equal(r.length, 5);
  assert.deepEqual(r[2], [10, 0]);
  const line = fitLine([
    [0, 0],
    [5, 5],
    [10, 10],
  ]);
  near(Math.abs(line.dir[0]), Math.SQRT1_2, 1e-9, 'diagonal');
  near(line.maxDeviation, 0, 1e-9, 'exact');
  const circle = fitCircle(
    Array.from(
      { length: 12 },
      (_, i) => [3 + 5 * Math.cos(i / 2), -2 + 5 * Math.sin(i / 2)] as Vec2,
    ),
  )!;
  near(circle.center[0], 3, 1e-9, 'cx');
  near(circle.center[1], -2, 1e-9, 'cy');
  near(circle.radius, 5, 1e-9, 'r');
  assert.equal(
    fitCircle([
      [0, 0],
      [1, 1],
      [2, 2],
    ]),
    null,
    'collinear',
  );
  assert.ok(
    polylinesTouch(
      [
        [0, 0],
        [10, 10],
      ],
      [
        [0, 10],
        [10, 0],
      ],
      0,
    ),
    'crossing',
  );
  assert.ok(
    !polylinesTouch(
      [
        [0, 0],
        [10, 0],
      ],
      [
        [0, 5],
        [10, 5],
      ],
      2,
    ),
    'apart',
  );
  assert.ok(
    polylinesTouch(
      [
        [0, 0],
        [10, 0],
      ],
      [
        [0, 1.5],
        [10, 1.5],
      ],
      2,
    ),
    'within tolerance',
  );
});

void test('lines: free direction, near-horizontal and near-vertical snap to the axis', () => {
  const free = as(recognizeStroke(lineStroke(100, 100, 300, 220)), 'line');
  assert.equal(free.axis, null);
  near(free.a[0], 100, 6, 'a.x');
  near(free.b[1], 220, 6, 'b.y');
  const h = as(recognizeStroke(lineStroke(100, 100, 300, 112, 11)), 'line');
  assert.equal(h.axis, 'horizontal');
  assert.equal(h.a[1], h.b[1]);
  const v = as(recognizeStroke(lineStroke(200, 50, 190, 300, 12)), 'line');
  assert.equal(v.axis, 'vertical');
  assert.equal(v.a[0], v.b[0]);
});

void test('arcs: quarter, half and a big arc; direction in the sweep sign', () => {
  const quarter = as(recognizeStroke(arcStroke(200, 200, 80, 0, 90)), 'arc');
  near(quarter.radius, 80, 6, 'radius');
  near(Math.abs(quarter.sweep), 90, 10, 'sweep');
  near(quarter.center[0], 200, 6, 'cx');
  const half = as(recognizeStroke(arcStroke(200, 200, 60, 180, 0, 21)), 'arc');
  near(Math.abs(half.sweep), 180, 12, 'half sweep');
  assert.ok(half.sweep < 0, 'clockwise in these coordinates');
  // `through` lies on the arc, halfway.
  near(
    Math.hypot(half.through[0] - half.center[0], half.through[1] - half.center[1]),
    half.radius,
    1e-6,
    'through on arc',
  );
  const big = as(recognizeStroke(arcStroke(300, 300, 100, 20, 280, 22)), 'arc');
  near(Math.abs(big.sweep), 260, 15, 'big sweep');
});

void test('circles, including a small one at a coarse zoom', () => {
  const c = as(recognizeStroke(circleStroke(250, 250, 70)), 'circle');
  near(c.center[0], 250, 5, 'cx');
  near(c.center[1], 250, 5, 'cy');
  near(c.radius, 70, 5, 'r');
  near(
    Math.hypot(c.start[0] - c.center[0], c.start[1] - c.center[1]),
    c.radius,
    1e-6,
    'start on circle',
  );
  // The same stroke in millimetres at 0.2 mm per pixel (a sketch view).
  const mm = circleStroke(250, 250, 30, 31).map((p) => ({ ...p, x: p.x * 0.2, y: p.y * 0.2 }));
  const small = as(recognizeStroke(mm, { unitPerPx: 0.2 }), 'circle');
  near(small.radius, 6, 0.6, 'r mm');
});

void test('rectangles: axis-aligned and rotated', () => {
  const r = as(recognizeStroke(rectangleStroke(100, 100, 300, 220)), 'rectangle');
  assert.equal(r.axisAligned, true);
  assert.equal(r.angle, 0);
  const xs = r.corners.map((p) => p[0]);
  const ys = r.corners.map((p) => p[1]);
  near(Math.min(...xs), 100, 6, 'left');
  near(Math.max(...xs), 300, 6, 'right');
  near(Math.min(...ys), 100, 6, 'top');
  near(Math.max(...ys), 220, 6, 'bottom');
  const rot = as(recognizeStroke(rotatedRectangleStroke(250, 250, 200, 110, 30)), 'rectangle');
  assert.equal(rot.axisAligned, false);
  near(rot.angle, 30, 4, 'angle');
  // Opposite sides are equal (a true rectangle).
  const side = (i: number) =>
    Math.hypot(
      rot.corners[(i + 1) % 4]![0] - rot.corners[i]![0],
      rot.corners[(i + 1) % 4]![1] - rot.corners[i]![1],
    );
  near(side(0), side(2), 1e-6, 'opposite sides');
  near(Math.max(side(0), side(1)), 200, 10, 'long side');
});

void test('polylines: an L, a triangle', () => {
  const l = as(
    recognizeStroke(
      polylineStroke([
        [100, 100],
        [100, 250],
        [260, 250],
      ]),
    ),
    'polyline',
  );
  assert.equal(l.closed, false);
  assert.equal(l.points.length, 3);
  near(l.points[1]![0], 100, 6, 'corner x');
  near(l.points[1]![1], 250, 6, 'corner y');
  const tri = as(
    recognizeStroke(
      polylineStroke(
        [
          [200, 100],
          [300, 270],
          [100, 270],
          [200, 103],
        ],
        41,
      ),
    ),
    'polyline',
  );
  assert.equal(tri.closed, true);
  assert.equal(tri.points.length, 3);
});

void test('scribbles erase; taps, wobbly lines and spirals are not shapes', () => {
  as(recognizeStroke(scribbleStroke(200, 200, 80)), 'scribble');
  as(
    recognizeStroke([
      { x: 0, y: 0 },
      { x: 2, y: 1 },
      { x: 3, y: 2 },
    ]),
    'none',
  );
  // A wave: neither straight nor an arc.
  const wave = Array.from({ length: 80 }, (_, i) => ({ x: i * 4, y: 40 * Math.sin(i / 6) }));
  as(recognizeStroke(wave), 'none');
  // A spiral closes nowhere and is no arc.
  const spiral = Array.from({ length: 120 }, (_, i) => {
    const a = i / 10;
    return { x: 200 + (20 + 6 * a) * Math.cos(a), y: 200 + (20 + 6 * a) * Math.sin(a) };
  });
  assert.notEqual(recognizeStroke(spiral).kind, 'circle');
});

void test('every fixture is recognised as itself across seeds (robustness)', () => {
  const failures: string[] = [];
  for (let seed = 100; seed < 130; seed += 1) {
    const cases: [string, RecognizedStroke['kind']][] = [
      [recognizeStroke(lineStroke(50, 60, 280, 200, seed)).kind, 'line'],
      [recognizeStroke(arcStroke(200, 200, 90, 10, 140, seed)).kind, 'arc'],
      [recognizeStroke(circleStroke(200, 200, 60, seed, seed * 7)).kind, 'circle'],
      [recognizeStroke(rectangleStroke(80, 90, 260, 210, seed)).kind, 'rectangle'],
      [recognizeStroke(scribbleStroke(200, 200, 70, 6, seed)).kind, 'scribble'],
    ];
    for (const [got, want] of cases)
      if (got !== want) failures.push(`seed ${seed}: ${want} → ${got}`);
  }
  assert.deepEqual(failures, []);
});

void test('recognition rate over 60 seeds per shape (thin and small shapes included)', () => {
  const kinds: [
    string,
    RecognizedStroke['kind'],
    (seed: number) => ReturnType<typeof lineStroke>,
    number,
  ][] = [
    [
      'rotated rectangle 10–80°',
      'rectangle',
      (s) => rotatedRectangleStroke(250, 250, 180, 100, 10 + (s % 8) * 10, s),
      1,
    ],
    [
      'L',
      'polyline',
      (s) =>
        polylineStroke(
          [
            [100, 100],
            [100, 250],
            [260, 250],
          ],
          s,
        ),
      1,
    ],
    [
      'Z',
      'polyline',
      (s) =>
        polylineStroke(
          [
            [100, 100],
            [250, 100],
            [100, 250],
            [250, 250],
          ],
          s,
        ),
      1,
    ],
    ['small circle r 25 px', 'circle', (s) => circleStroke(200, 200, 25, s, s), 1],
    ['big circle r 200 px', 'circle', (s) => circleStroke(300, 300, 200, s, s), 1],
    ['shallow arc 40°', 'arc', (s) => arcStroke(200, 400, 300, 250, 290, s), 1],
    [
      'small rectangle 50 × 30 px',
      'rectangle',
      (s) => rectangleStroke(100, 100, 150, 130, s),
      0.95,
    ],
    [
      'thin rectangle 300 × 40 px',
      'rectangle',
      (s) => rectangleStroke(100, 100, 400, 140, s),
      0.85,
    ],
    ['short line 30 px', 'line', (s) => lineStroke(100, 100, 130, 110, s), 1],
    ['four-pass scribble', 'scribble', (s) => scribbleStroke(200, 200, 60, 4, s), 0.95],
  ];
  const report: string[] = [];
  for (const [name, want, make, rate] of kinds) {
    let ok = 0;
    for (let seed = 200; seed < 260; seed += 1)
      if (recognizeStroke(make(seed)).kind === want) ok += 1;
    if (ok / 60 < rate) report.push(`${name}: ${ok}/60 (needs ${Math.ceil(rate * 60)})`);
  }
  assert.deepEqual(report, []);
});
