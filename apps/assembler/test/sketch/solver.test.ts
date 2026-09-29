import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addCircle,
  addPolyline,
  addRectangle,
  withConstraints,
  withDimension,
} from '../../renderer/src/sketch/builders.js';
import type { SolveResult } from '../../renderer/src/sketch/solverTypes.js';
import {
  EMPTY_SKETCH,
  entityMap,
  ORIGIN_ID,
  pointPos,
  radiusOf,
  type SketchConstraint,
  type SketchData,
  type SketchEntity,
  type Vec2,
} from '../../renderer/src/sketch/types.js';
import { loadNodeSolver } from './nodeSolver.js';

const TOL = 1e-6;

async function solve(
  sketch: SketchData,
  extra: { drag?: { pointId: string; target: Vec2 }[]; analyze?: boolean } = {},
): Promise<SolveResult> {
  const solver = await loadNodeSolver();
  return solver.solve({ sketch, ...extra });
}

function pos(sketch: SketchData, id: string): Vec2 {
  const p = pointPos(entityMap(sketch), id);
  assert.ok(p, `point ${id}`);
  return p;
}

function line(sketch: SketchData, id: string): { a: Vec2; b: Vec2; d: Vec2; length: number } {
  const e = entityMap(sketch).get(id);
  assert.ok(e?.kind === 'line');
  const a = pos(sketch, e.a);
  const b = pos(sketch, e.b);
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  return { a, b, d, length: Math.hypot(d[0], d[1]) };
}

function radius(sketch: SketchData, id: string): number {
  const map = entityMap(sketch);
  const e = map.get(id);
  assert.ok(e?.kind === 'circle' || e?.kind === 'arc');
  return radiusOf(map, e);
}

function twoLines(): SketchData {
  let s = addPolyline(EMPTY_SKETCH, [
    [0, 0],
    [10, 1],
  ]).sketch;
  s = addPolyline(s, [
    [2, 5],
    [9, 9],
  ]).sketch;
  return s; // l1: p1-p2, l2: p3-p4
}

function constrain(sketch: SketchData, kind: SketchConstraint['kind'], refs: string[]): SketchData {
  return withConstraints(sketch, [{ kind, refs }]);
}

function arcSketch(): SketchData {
  const entities: SketchEntity[] = [
    { id: 'p1', kind: 'point', x: 0, y: 0 },
    { id: 'p2', kind: 'point', x: 10, y: 0 },
    { id: 'p3', kind: 'point', x: 0, y: 10 },
    { id: 'a1', kind: 'arc', center: 'p1', start: 'p2', end: 'p3' },
  ];
  return { entities, constraints: [], dimensions: [] };
}

void test('degrees of freedom of free geometry: point 2, line 4, circle 3, arc 5', async () => {
  const point: SketchData = {
    ...EMPTY_SKETCH,
    entities: [{ id: 'p1', kind: 'point', x: 1, y: 2 }],
  };
  assert.equal((await solve(point)).dof, 2);
  const l = addPolyline(EMPTY_SKETCH, [
    [0, 0],
    [5, 5],
  ]).sketch;
  assert.equal((await solve(l)).dof, 4);
  assert.equal((await solve(addCircle(EMPTY_SKETCH, [0, 0], 3).sketch)).dof, 3);
  assert.equal((await solve(arcSketch())).dof, 5);
});

void test('coincident joins two points (DOF 8 -> 6)', async () => {
  const s = constrain(twoLines(), 'coincident', ['p2', 'p3']);
  const r = await solve(s);
  assert.equal(r.status, 'ok');
  assert.equal(r.dof, 6);
  const [a, b] = [pos(r.sketch, 'p2'), pos(r.sketch, 'p3')];
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < TOL);
});

void test('horizontal and vertical (line and point pair forms)', async () => {
  let r = await solve(constrain(twoLines(), 'horizontal', ['l1']));
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(line(r.sketch, 'l1').d[1]) < TOL);
  assert.equal(r.dof, 7);
  r = await solve(constrain(twoLines(), 'vertical', ['l2']));
  assert.ok(Math.abs(line(r.sketch, 'l2').d[0]) < TOL);
  r = await solve(constrain(twoLines(), 'vertical', ['p1', 'p3']));
  assert.ok(Math.abs(pos(r.sketch, 'p1')[0] - pos(r.sketch, 'p3')[0]) < TOL);
  r = await solve(constrain(twoLines(), 'horizontal', ['p2', 'p4']));
  assert.ok(Math.abs(pos(r.sketch, 'p2')[1] - pos(r.sketch, 'p4')[1]) < TOL);
});

void test('parallel and perpendicular lines', async () => {
  let r = await solve(constrain(twoLines(), 'parallel', ['l1', 'l2']));
  assert.equal(r.status, 'ok');
  let a = line(r.sketch, 'l1').d;
  let b = line(r.sketch, 'l2').d;
  assert.ok(Math.abs(a[0] * b[1] - a[1] * b[0]) < TOL);
  assert.equal(r.dof, 7);
  r = await solve(constrain(twoLines(), 'perpendicular', ['l1', 'l2']));
  a = line(r.sketch, 'l1').d;
  b = line(r.sketch, 'l2').d;
  assert.ok(Math.abs(a[0] * b[0] + a[1] * b[1]) < TOL);
});

void test('tangent: line-circle, line-arc and circle-circle', async () => {
  let s = addPolyline(EMPTY_SKETCH, [
    [-10, 6],
    [10, 5],
  ]).sketch;
  s = addCircle(s, [0, 0], 3).sketch; // p3 centre, c1
  let r = await solve(constrain(s, 'tangent', ['l1', 'c1']));
  assert.equal(r.status, 'ok');
  const l = line(r.sketch, 'l1');
  const c = pos(r.sketch, 'p3');
  const distance = Math.abs((c[0] - l.a[0]) * l.d[1] - (c[1] - l.a[1]) * l.d[0]) / l.length;
  assert.ok(Math.abs(distance - radius(r.sketch, 'c1')) < 1e-5);

  const arc = arcSketch();
  const withLine = addPolyline(arc, [
    [12, -5],
    [12, 5],
  ]).sketch;
  r = await solve(constrain(withLine, 'tangent', ['l1', 'a1']));
  assert.equal(r.status, 'ok');
  const la = line(r.sketch, 'l1');
  const ca = pos(r.sketch, 'p1');
  const da = Math.abs((ca[0] - la.a[0]) * la.d[1] - (ca[1] - la.a[1]) * la.d[0]) / la.length;
  assert.ok(Math.abs(da - radius(r.sketch, 'a1')) < 1e-5);

  let cc = addCircle(EMPTY_SKETCH, [0, 0], 3).sketch;
  cc = addCircle(cc, [7, 1], 2).sketch;
  r = await solve(constrain(cc, 'tangent', ['c1', 'c2']));
  assert.equal(r.status, 'ok');
  const centreDistance = Math.hypot(
    pos(r.sketch, 'p1')[0] - pos(r.sketch, 'p2')[0],
    pos(r.sketch, 'p1')[1] - pos(r.sketch, 'p2')[1],
  );
  assert.ok(Math.abs(centreDistance - (radius(r.sketch, 'c1') + radius(r.sketch, 'c2'))) < 1e-5);
});

void test('equal: line lengths and circle radii', async () => {
  let r = await solve(constrain(twoLines(), 'equal', ['l1', 'l2']));
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(line(r.sketch, 'l1').length - line(r.sketch, 'l2').length) < 1e-6);
  let cc = addCircle(EMPTY_SKETCH, [0, 0], 3).sketch;
  cc = addCircle(cc, [10, 0], 5).sketch;
  r = await solve(constrain(cc, 'equal', ['c1', 'c2']));
  assert.ok(Math.abs(radius(r.sketch, 'c1') - radius(r.sketch, 'c2')) < 1e-6);
});

void test('fixed: a locked point does not move when dragged; DOF drops by 2', async () => {
  const s = constrain(twoLines(), 'fixed', ['p1']);
  const r = await solve(s, { drag: [{ pointId: 'p1', target: [50, 50] }] });
  assert.equal(r.status, 'ok');
  assert.deepEqual(pos(r.sketch, 'p1'), [0, 0]);
  assert.equal((await solve(s)).dof, 6);
});

void test('midpoint, symmetric, concentric and point-on-object', async () => {
  let s = twoLines();
  let r = await solve(constrain(s, 'midpoint', ['p3', 'l1']));
  assert.equal(r.status, 'ok');
  const l = line(r.sketch, 'l1');
  const m = pos(r.sketch, 'p3');
  assert.ok(Math.hypot(m[0] - (l.a[0] + l.b[0]) / 2, m[1] - (l.a[1] + l.b[1]) / 2) < 1e-6);

  // p1 and p2 symmetric about line l2.
  r = await solve(constrain(s, 'symmetric', ['p1', 'p2', 'l2']));
  assert.equal(r.status, 'ok');
  const axis = line(r.sketch, 'l2');
  const p = pos(r.sketch, 'p1');
  const q = pos(r.sketch, 'p2');
  const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const pq: Vec2 = [q[0] - p[0], q[1] - p[1]];
  assert.ok(
    Math.abs(pq[0] * axis.d[0] + pq[1] * axis.d[1]) < 1e-5,
    'pq is perpendicular to the axis',
  );
  assert.ok(Math.abs((mid[0] - axis.a[0]) * axis.d[1] - (mid[1] - axis.a[1]) * axis.d[0]) < 1e-5);

  let cc = addCircle(EMPTY_SKETCH, [0, 0], 3).sketch;
  cc = addCircle(cc, [4, 2], 6).sketch;
  r = await solve(constrain(cc, 'concentric', ['c1', 'c2']));
  assert.equal(r.status, 'ok');
  assert.ok(
    Math.hypot(
      pos(r.sketch, 'p1')[0] - pos(r.sketch, 'p2')[0],
      pos(r.sketch, 'p1')[1] - pos(r.sketch, 'p2')[1],
    ) < 1e-6,
  );

  s = addCircle(twoLines(), [0, 0], 4).sketch; // p5, c1
  r = await solve(constrain(s, 'pointOnObject', ['p4', 'c1']));
  assert.equal(r.status, 'ok');
  const c = pos(r.sketch, 'p5');
  const p4 = pos(r.sketch, 'p4');
  assert.ok(Math.abs(Math.hypot(p4[0] - c[0], p4[1] - c[1]) - radius(r.sketch, 'c1')) < 1e-6);
  r = await solve(constrain(twoLines(), 'pointOnObject', ['p3', 'l1']));
  const l1 = line(r.sketch, 'l1');
  const p3 = pos(r.sketch, 'p3');
  assert.ok(Math.abs((p3[0] - l1.a[0]) * l1.d[1] - (p3[1] - l1.a[1]) * l1.d[0]) < 1e-6);
});

void test('dimensions: length, horizontal/vertical distance, radius, diameter, angle', async () => {
  let s = addRectangle(EMPTY_SKETCH, [0, 0], [10, 5]).sketch;
  s = withDimension(s, 'distance', ['l1'], 30).sketch;
  s = withDimension(s, 'verticalDistance', ['l2'], 12).sketch;
  s = withDimension(s, 'horizontalDistance', [ORIGIN_ID, 'p1'], 4).sketch;
  s = withDimension(s, 'verticalDistance', [ORIGIN_ID, 'p1'], 0).sketch;
  let r = await solve(s, { analyze: true });
  assert.equal(r.status, 'ok');
  assert.equal(r.dof, 0);
  assert.deepEqual(
    pos(r.sketch, 'p1').map((v) => Math.round(v * 1e6) / 1e6),
    [4, 0],
  );
  assert.deepEqual(
    pos(r.sketch, 'p3').map((v) => Math.round(v * 1e6) / 1e6),
    [34, 12],
  );
  assert.equal(r.determined?.length, r.sketch.entities.length);

  // Change a dimension value: the geometry follows.
  const changed: SketchData = {
    ...r.sketch,
    dimensions: r.sketch.dimensions.map((d) => (d.name === 'd1' ? { ...d, value: 50 } : d)),
  };
  r = await solve(changed);
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(line(r.sketch, 'l1').length - 50) < 1e-6);
  assert.ok(Math.abs(pos(r.sketch, 'p1')[0] - 4) < 1e-6, 'the dimensioned corner stays');

  let c = addCircle(EMPTY_SKETCH, [0, 0], 3).sketch;
  c = withDimension(c, 'diameter', ['c1'], 20).sketch;
  r = await solve(c);
  assert.ok(Math.abs(radius(r.sketch, 'c1') - 10) < 1e-6);
  let a = arcSketch();
  a = withDimension(a, 'radius', ['a1'], 25).sketch;
  r = await solve(a);
  assert.ok(Math.abs(radius(r.sketch, 'a1') - 25) < 1e-6);

  let ang = constrain(twoLines(), 'horizontal', ['l1']);
  ang = withDimension(ang, 'angle', ['l1', 'l2'], 30).sketch;
  r = await solve(ang);
  assert.equal(r.status, 'ok');
  const d1 = line(r.sketch, 'l1').d;
  const d2 = line(r.sketch, 'l2').d;
  const deg =
    (Math.acos((d1[0] * d2[0] + d1[1] * d2[1]) / (Math.hypot(...d1) * Math.hypot(...d2))) * 180) /
    Math.PI;
  assert.ok(Math.abs(deg - 30) < 1e-6);
});

void test('expressions: a dimension can reference another by name', async () => {
  let s = addRectangle(EMPTY_SKETCH, [0, 0], [10, 5]).sketch;
  s = withDimension(s, 'distance', ['l1'], 40).sketch;
  s = withDimension(s, 'distance', ['l2'], 1, { expression: 'd1 / 4 + 2' }).sketch;
  const r = await solve(s);
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(line(r.sketch, 'l2').length - 12) < 1e-6);
  assert.equal(r.sketch.dimensions[1]!.value, 12);
  const bad = {
    ...s,
    dimensions: s.dimensions.map((d, i) => (i === 1 ? { ...d, expression: 'd9 * 2' } : d)),
  };
  const invalid = await solve(bad);
  assert.equal(invalid.status, 'invalid');
  assert.match(invalid.message ?? '', /unknown name "d9"/);
});

void test('conflict detection: two different widths of a rectangle', async () => {
  let s = addRectangle(EMPTY_SKETCH, [0, 0], [10, 5]).sketch;
  s = withDimension(s, 'distance', ['l1'], 20).sketch;
  s = withDimension(s, 'distance', ['l3'], 30).sketch;
  const r = await solve(s);
  assert.equal(r.status, 'overconstrained');
  assert.ok(r.conflicting.includes('m1') && r.conflicting.includes('m2'), r.conflicting.join());
  assert.equal(r.sketch, s, 'the input is returned unchanged');
});

void test('redundancy detection: the same width twice', async () => {
  let s = addRectangle(EMPTY_SKETCH, [0, 0], [10, 5]).sketch;
  s = withDimension(s, 'distance', ['l1'], 20).sketch;
  s = withDimension(s, 'distance', ['l3'], 20).sketch;
  const r = await solve(s);
  assert.equal(r.status, 'overconstrained');
  assert.deepEqual(r.redundant, ['m2']);
  assert.deepEqual(r.conflicting, []);
});

void test('a constraint that collapses geometry fails instead of producing a zero-length line', async () => {
  const s = constrain(constrain(twoLines(), 'horizontal', ['l1']), 'vertical', ['l1']);
  const r = await solve(s);
  assert.equal(r.status, 'failed');
});

void test('under-constrained DOF and per-entity analysis', async () => {
  let s = addRectangle(EMPTY_SKETCH, [0, 0], [10, 5]).sketch;
  s = withDimension(s, 'horizontalDistance', [ORIGIN_ID, 'p1'], 0).sketch;
  s = withDimension(s, 'verticalDistance', [ORIGIN_ID, 'p1'], 0).sketch;
  s = withDimension(s, 'distance', ['l1'], 10).sketch;
  const r = await solve(s, { analyze: true });
  assert.equal(r.status, 'ok');
  assert.equal(r.dof, 1, 'only the height is free');
  const determined = new Set(r.determined);
  assert.ok(determined.has('p1') && determined.has('p2') && determined.has('l1'));
  assert.ok(!determined.has('p3') && !determined.has('p4') && !determined.has('l3'));
});

void test('dragging an under-constrained point moves it through the solver', async () => {
  let s = addRectangle(EMPTY_SKETCH, [0, 0], [10, 5]).sketch;
  s = withDimension(s, 'distance', ['l1'], 10).sketch;
  const r = await solve(s, { drag: [{ pointId: 'p3', target: [30, 20] }] });
  assert.equal(r.status, 'ok');
  assert.ok(
    Math.abs(pos(r.sketch, 'p3')[0] - 30) < 1e-4 && Math.abs(pos(r.sketch, 'p3')[1] - 20) < 1e-4,
  );
  assert.ok(Math.abs(line(r.sketch, 'l1').length - 10) < 1e-6, 'the width dimension holds');
  assert.ok(Math.abs(line(r.sketch, 'l1').d[1]) < 1e-6, 'horizontal holds');
});

void test('solve time for a 40-line sketch stays small', async () => {
  const points: Vec2[] = [];
  for (let i = 0; i < 40; i += 1) {
    const a = (i / 40) * Math.PI * 2;
    points.push([Math.cos(a) * 50, Math.sin(a) * 50]);
  }
  let s = addPolyline(EMPTY_SKETCH, points, { closed: true }).sketch;
  s = withConstraints(
    s,
    Array.from({ length: 39 }, (_, i) => ({
      kind: 'equal' as const,
      refs: [`l${i + 1}`, `l${i + 2}`],
    })),
  );
  const r = await solve(s);
  assert.equal(r.status, 'ok');
  assert.ok(r.ms < 250, `solve took ${r.ms.toFixed(1)} ms`);
});
