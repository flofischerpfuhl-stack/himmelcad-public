import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addCircle,
  addPolyline,
  addRectangle,
} from '../../renderer/src/foundation/sketch-solver/builders.js';
import { detectRegions } from '../../renderer/src/foundation/sketch-solver/regions.js';
import {
  EMPTY_SKETCH,
  type SketchData,
} from '../../renderer/src/foundation/sketch-solver/types.js';

function near(actual: number, expected: number, tol = 1e-6): void {
  assert.ok(Math.abs(actual - expected) < tol, `${actual} != ${expected}`);
}

void test('a rectangle is one region keyed by its four lines', () => {
  const s = addRectangle(EMPTY_SKETCH, [0, 0], [10, 5]).sketch;
  const regions = detectRegions(s);
  assert.equal(regions.length, 1);
  assert.equal(regions[0]!.key, 'l1+l2+l3+l4');
  near(regions[0]!.area, 50);
  assert.equal(regions[0]!.holes.length, 0);
});

void test('an L-shaped closed polyline is one non-convex region', () => {
  const s = addPolyline(
    EMPTY_SKETCH,
    [
      [0, 0],
      [40, 0],
      [40, 10],
      [10, 10],
      [10, 30],
      [0, 30],
    ],
    { closed: true },
  ).sketch;
  const [region, ...rest] = detectRegions(s);
  assert.equal(rest.length, 0);
  near(region!.area, 40 * 10 + 10 * 20);
  const [x, y] = region!.sample;
  assert.ok((x < 40 && y < 10) || (x < 10 && y < 30), 'sample lies inside the L');
});

void test('nested loops become holes; the inner disk is its own region', () => {
  let s = addRectangle(EMPTY_SKETCH, [0, 0], [40, 20]).sketch;
  s = addCircle(s, [20, 10], 5).sketch;
  const regions = detectRegions(s);
  assert.equal(regions.length, 2);
  const plate = regions.find((r) => r.key === 'l1+l2+l3+l4')!;
  const disk = regions.find((r) => r.key === 'c1')!;
  assert.equal(plate.holes.length, 1);
  near(plate.area, 800 - Math.PI * 25, 1e-6);
  near(disk.area, Math.PI * 25, 1e-6);
  assert.equal(disk.holes.length, 0);
});

void test('a hole inside a hole-free island: three nesting levels', () => {
  let s = addRectangle(EMPTY_SKETCH, [0, 0], [100, 100]).sketch;
  s = addRectangle(s, [20, 20], [80, 80]).sketch;
  s = addCircle(s, [50, 50], 10).sketch;
  const regions = detectRegions(s);
  assert.equal(regions.length, 3);
  const areas = regions.map((r) => Math.round(r.area * 1000) / 1000).sort((a, b) => a - b);
  assert.deepEqual(areas, [
    Math.round(Math.PI * 100 * 1000) / 1000,
    Math.round((3600 - Math.PI * 100) * 1000) / 1000,
    10000 - 3600,
  ]);
});

void test('intersecting rectangles split into three regions (Shapr3D-style)', () => {
  let s = addRectangle(EMPTY_SKETCH, [0, 0], [20, 10]).sketch;
  s = addRectangle(s, [10, 5], [30, 15]).sketch;
  const regions = detectRegions(s);
  assert.equal(regions.length, 3);
  near(
    regions.reduce((sum, r) => sum + r.area, 0),
    200 + 200 - 50,
  );
  assert.equal(new Set(regions.map((r) => r.key)).size, 3, 'keys are unique');
});

void test('a line across a circle splits it; dangling line ends are ignored', () => {
  let s = addCircle(EMPTY_SKETCH, [0, 0], 10).sketch;
  s = addPolyline(s, [
    [-15, 2],
    [15, 2],
  ]).sketch;
  const regions = detectRegions(s);
  assert.equal(regions.length, 2);
  near(
    regions.reduce((sum, r) => sum + r.area, 0),
    Math.PI * 100,
  );
  const keys = regions.map((r) => r.key);
  assert.equal(new Set(keys).size, 2);
  assert.ok(
    keys.every((k) => k.startsWith('c1+l1@')),
    keys.join(),
  );
});

void test('a T-junction line splits a rectangle into two regions', () => {
  let s = addRectangle(EMPTY_SKETCH, [0, 0], [20, 10]).sketch;
  s = addPolyline(s, [
    [8, 0],
    [8, 10],
  ]).sketch;
  const regions = detectRegions(s);
  assert.equal(regions.length, 2);
  const areas = regions.map((r) => r.area).sort((a, b) => a - b);
  near(areas[0]!, 80);
  near(areas[1]!, 120);
});

void test('open curves and construction geometry never form a region', () => {
  let s = addPolyline(EMPTY_SKETCH, [
    [0, 0],
    [10, 0],
    [10, 10],
  ]).sketch;
  assert.equal(detectRegions(s).length, 0);
  s = addRectangle(EMPTY_SKETCH, [0, 0], [10, 5], { construction: true }).sketch;
  assert.equal(detectRegions(s).length, 0);
});

void test('an arc closed by a line is a D-shaped region', () => {
  const s: SketchData = {
    entities: [
      { id: 'p1', kind: 'point', x: 0, y: 0 },
      { id: 'p2', kind: 'point', x: 10, y: 0 },
      { id: 'p3', kind: 'point', x: -10, y: 0 },
      { id: 'a1', kind: 'arc', center: 'p1', start: 'p2', end: 'p3' },
      { id: 'l1', kind: 'line', a: 'p3', b: 'p2' },
    ],
    constraints: [],
    dimensions: [],
  };
  const [region] = detectRegions(s);
  assert.ok(region);
  near(region.area, (Math.PI * 100) / 2);
  assert.equal(region.key, 'a1+l1');
});

void test('region keys survive dimension-like edits of the geometry', () => {
  const before = addPolyline(
    EMPTY_SKETCH,
    [
      [0, 0],
      [40, 0],
      [40, 10],
      [10, 10],
      [10, 30],
      [0, 30],
    ],
    { closed: true },
  ).sketch;
  const after: SketchData = {
    ...before,
    entities: before.entities.map((e) => (e.kind === 'point' && e.x === 40 ? { ...e, x: 55 } : e)),
  };
  assert.deepEqual(
    detectRegions(before).map((r) => r.key),
    detectRegions(after).map((r) => r.key),
  );
  near(detectRegions(after)[0]!.area, 55 * 10 + 10 * 20);
});
