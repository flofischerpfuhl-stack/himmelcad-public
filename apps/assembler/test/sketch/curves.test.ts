/**
 * Splines, ellipses and text as sketch curves: the spline math, the
 * generalized curve model (intersections, areas), region detection with
 * these curves, their planeGCS mapping (ellipse internals, spline tangents,
 * pattern constraints, reference dimensions) and the OCCT profiles built
 * from them (real kernel).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtrudeFeature, Feature, SketchFeature } from '../../renderer/src/model/document.js';
import {
  addEllipse,
  addPolyline,
  addRectangle,
  addSpline,
  addText,
  withConstraints,
  withDimension,
} from '../../renderer/src/sketch/builders.js';
import {
  areaTerm,
  bezierPoint,
  entityCurve,
  intersectCurves,
  pointAt,
  type Curve2,
} from '../../renderer/src/sketch/geometry.js';
import { detectRegions, loopPolygon } from '../../renderer/src/sketch/regions.js';
import {
  bsplineToBeziers,
  fitSplineBeziers,
  uniformKnots,
} from '../../renderer/src/sketch/spline.js';
import { parseOutline } from '../../renderer/src/sketch/text/outline.js';
import { DEFAULT_SKETCH_FONT, textOutline } from '../../renderer/src/sketch/text/fonts.js';
import {
  EMPTY_SKETCH,
  entityMap,
  pointPos,
  type SketchData,
  type Vec2,
} from '../../renderer/src/sketch/types.js';
import { loadNodeKernel } from '../kernel/nodeKernel.js';
import { installNodeFonts } from './nodeFont.js';
import { loadNodeSolver } from './nodeSolver.js';

installNodeFonts();

function close(a: number, b: number, tol: number, what = ''): void {
  assert.ok(Math.abs(a - b) <= tol, `${what} ${a} â‰ˆ ${b} (Â±${tol})`);
}

function closePoint(a: Vec2, b: Vec2, tol: number, what = ''): void {
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol, `${what} (${a}) â‰ˆ (${b})`);
}

async function solve(sketch: SketchData) {
  return (await loadNodeSolver()).solveSync({ sketch, analyze: true });
}

function sketchFeature(id: string, data: SketchData): SketchFeature {
  return {
    id,
    name: 'Sketch 1',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    ...data,
  };
}

function extrude(
  id: string,
  sketchId: string,
  distance: number,
  regions?: string[],
): ExtrudeFeature {
  return {
    id,
    name: 'Extrude 1',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketchId, ...(regions ? { regions } : {}) },
    distance,
    symmetric: false,
    operation: 'new',
  };
}

// ---- spline math ----------------------------------------------------------------------

void test('control splines decompose into BÃ©zier segments that start/end at the end poles and join C2', () => {
  const poles: Vec2[] = [
    [0, 0],
    [10, 20],
    [30, 20],
    [40, 0],
    [60, -10],
  ];
  assert.deepEqual(uniformKnots(5, 3), [0, 0, 0, 0, 0.5, 1, 1, 1, 1]);
  const segs = bsplineToBeziers(poles, 3);
  assert.equal(segs.length, 2);
  closePoint(segs[0]![0]!, poles[0]!, 1e-12, 'start');
  closePoint(segs[1]![3]!, poles[4]!, 1e-12, 'end');
  closePoint(segs[0]![3]!, segs[1]![0]!, 1e-12, 'joint');
  // C1: equal first derivatives at the joint (equal knot spans).
  const d0: Vec2 = [segs[0]![3]![0] - segs[0]![2]![0], segs[0]![3]![1] - segs[0]![2]![1]];
  const d1: Vec2 = [segs[1]![1]![0] - segs[1]![0]![0], segs[1]![1]![1] - segs[1]![0]![1]];
  closePoint(d0, d1, 1e-9, 'tangent continuity');
  // Four poles of degree 3 are one BÃ©zier segment with the poles as control points.
  const single = bsplineToBeziers(poles.slice(0, 4), 3);
  assert.equal(single.length, 1);
  single[0]!.forEach((p, i) => closePoint(p, poles[i]!, 1e-12));
});

void test('fit splines interpolate their points; handles clamp the end tangents', () => {
  const pts: Vec2[] = [
    [0, 0],
    [10, 8],
    [25, 3],
    [40, 10],
  ];
  const natural = fitSplineBeziers(pts);
  assert.equal(natural.length, 3);
  natural.forEach((seg, i) => {
    closePoint(seg[0]!, pts[i]!, 1e-12);
    closePoint(seg[3]!, pts[i + 1]!, 1e-12);
  });
  const clamped = fitSplineBeziers(pts, [
    [0, 10],
    [40, 0],
  ]);
  closePoint(clamped[0]![1]!, [0, 10], 1e-9, 'start handle is the first control point');
  closePoint(clamped[2]![2]!, [40, 0], 1e-9, 'end handle is the last inner control point');
  // Interior points stay interpolated.
  closePoint(bezierPoint(clamped[1]!, 0), pts[1]!, 1e-12);
});

// ---- curve model ----------------------------------------------------------------------

void test('ellipse and BÃ©zier areas are exact; numeric intersections are refined to the curves', () => {
  const ellipse: Curve2 = {
    kind: 'ellipse',
    c: [5, 2],
    rx: 10,
    ry: 4,
    rot: 0.3,
    a0: 0,
    sweep: Math.PI * 2,
  };
  close(areaTerm(ellipse), Math.PI * 40, 1e-9, 'ellipse area');
  // A unit square as a closed chain of degree-1 segments.
  const square: Curve2 = {
    kind: 'bezier',
    segs: [
      [
        [0, 0],
        [1, 0],
      ],
      [
        [1, 0],
        [1, 1],
      ],
      [
        [1, 1],
        [0, 1],
      ],
      [
        [0, 1],
        [0, 0],
      ],
    ],
  };
  close(areaTerm(square), 1, 1e-12, 'square');
  // Horizontal line through an axis-aligned ellipse xÂ²/100 + yÂ²/16 = 1 at y = 2.
  const e0: Curve2 = {
    kind: 'ellipse',
    c: [0, 0],
    rx: 10,
    ry: 4,
    rot: 0,
    a0: 0,
    sweep: Math.PI * 2,
  };
  const line: Curve2 = { kind: 'line', a: [-20, 2], b: [20, 2] };
  const hits = intersectCurves(line, e0);
  assert.equal(hits.length, 2);
  const x = 10 * Math.sqrt(1 - 4 / 16);
  const xs = hits.map((h) => h.point[0]).sort((a, b) => a - b);
  close(xs[0]!, -x, 1e-9, 'left hit');
  close(xs[1]!, x, 1e-9, 'right hit');
  for (const h of hits) closePoint(pointAt(e0, h.t2), h.point, 1e-9, 'on the ellipse');
});

// ---- regions --------------------------------------------------------------------------

void test('a spline closed by a line is one region with the exact area; keys use entity ids', () => {
  const line = addPolyline(EMPTY_SKETCH, [
    [0, 0],
    [40, 0],
  ]);
  const spline = addSpline(
    line.sketch,
    [
      [40, 0],
      [30, 15],
      [10, 15],
      [0, 0],
    ],
    { endpoints: [line.pointIds[1]!, line.pointIds[0]!], handles: false },
  );
  const regions = detectRegions(spline.sketch);
  assert.equal(regions.length, 1);
  const region = regions[0]!;
  assert.equal(region.key, [line.lineIds[0], spline.entityId].sort().join('+'));
  const map = entityMap(spline.sketch);
  const curve = entityCurve(map, map.get(spline.entityId) as never)!;
  close(
    region.area,
    Math.abs(areaTerm(curve) + 0),
    1e-6,
    'area = spline area term (line on y = 0)',
  );
});

void test('an ellipse is a region of area Ï€ab; a line across splits it into two keyed halves', () => {
  const e = addEllipse(EMPTY_SKETCH, [0, 0], 12, 5, 30);
  const one = detectRegions(e.sketch);
  assert.equal(one.length, 1);
  close(one[0]!.area, Math.PI * 60, 1e-6, 'ellipse area');
  assert.equal(one[0]!.key, e.entityId);
  const cut = addPolyline(e.sketch, [
    [-20, 0],
    [20, 0],
  ]);
  const halves = detectRegions(cut.sketch);
  assert.equal(halves.length, 2);
  close(halves[0]!.area + halves[1]!.area, Math.PI * 60, 1e-6, 'halves');
  assert.notEqual(halves[0]!.key, halves[1]!.key);
});

void test('an elliptical arc closed by a line bounds a half ellipse', () => {
  const arc = addEllipse(EMPTY_SKETCH, [0, 0], 10, 4, 0, { arc: [0, 180] });
  const [, , , s, t] = arc.pointIds;
  const sketch: SketchData = {
    ...arc.sketch,
    entities: [...arc.sketch.entities, { id: 'l1', kind: 'line', a: t!, b: s! }],
  };
  const regions = detectRegions(sketch);
  assert.equal(regions.length, 1);
  close(regions[0]!.area, Math.PI * 20, 1e-6, 'half ellipse');
});

void test('text outlines parse into closed glyph contours; letters with counters get holes', async () => {
  const { outline, missing } = await textOutline(DEFAULT_SKETCH_FONT, 'O8');
  assert.deepEqual(missing, []);
  const contours = parseOutline(outline);
  assert.equal(contours.length, 5, 'O: 2 contours, 8: 3 contours');
  const text = addText(EMPTY_SKETCH, [0, 0], {
    text: 'O8',
    height: 10,
    font: DEFAULT_SKETCH_FONT,
    outline,
  });
  const regions = detectRegions(text.sketch);
  assert.equal(regions.length, 2, 'one region per glyph (counters are holes)');
  assert.deepEqual(regions.map((r) => r.holes.length).sort(), [1, 2], 'O has one counter, 8 two');
  for (const r of regions) assert.match(r.key, new RegExp(`^${text.entityId}\\.\\d+$`));
  // Height is the cap height: the O spans about 10 mm.
  const ys = regions.flatMap((r) => loopPolygon(r.outer).map((p) => p[1]));
  assert.ok(Math.max(...ys) > 9 && Math.max(...ys) < 11.5, `top ${Math.max(...ys)}`);
});

// ---- solver ---------------------------------------------------------------------------

void test('solver: an ellipse has 5 degrees of freedom and follows its axis dimensions', async () => {
  const e = addEllipse(EMPTY_SKETCH, [0, 0], 10, 4, 20);
  const free = await solve(e.sketch);
  assert.equal(free.status, 'ok', free.message ?? '');
  assert.equal(free.dof, 5);
  const [c, m, n] = e.pointIds as [string, string, string];
  let data = withConstraints(e.sketch, [{ kind: 'coincident', refs: [c, 'origin'] }]);
  data = withDimension(data, 'distance', [c, m], 15).sketch;
  data = withDimension(data, 'distance', [c, n], 6).sketch;
  data = withConstraints(data, [{ kind: 'horizontal', refs: [c, m] }]);
  const solved = await solve(data);
  assert.equal(solved.status, 'ok', solved.message ?? '');
  assert.equal(solved.dof, 0);
  const map = entityMap(solved.sketch);
  const pm = pointPos(map, m)!;
  const pn = pointPos(map, n)!;
  close(Math.hypot(...pm), 15, 1e-6, 'major');
  close(Math.hypot(...pn), 6, 1e-6, 'minor');
  close(pm[1], 0, 1e-6, 'major axis horizontal');
  close(pm[0] * pn[0] + pm[1] * pn[1], 0, 1e-6, 'minor stays perpendicular');
});

void test('solver: an elliptical arc keeps its end points on the ellipse; a point can sit on an ellipse', async () => {
  const arc = addEllipse(EMPTY_SKETCH, [0, 0], 10, 4, 0, { arc: [0, 120] });
  const free = await solve(arc.sketch);
  assert.equal(free.status, 'ok', free.message ?? '');
  assert.equal(free.dof, 7);
  const [c, m, n] = arc.pointIds as [string, string, string];
  let data = withDimension(arc.sketch, 'distance', [c, m], 14).sketch;
  data = withDimension(data, 'distance', [c, n], 5).sketch;
  const solved = await solve(data);
  assert.equal(solved.status, 'ok', solved.message ?? '');
  const map = entityMap(solved.sketch);
  const curve = entityCurve(map, map.get(arc.entityId) as never)!;
  assert.equal(curve.kind, 'ellipse');
  if (curve.kind !== 'ellipse') return;
  close(curve.rx, 14, 1e-6);
  close(curve.ry, 5, 1e-6);
  for (const id of [arc.pointIds[3]!, arc.pointIds[4]!]) {
    const p = pointPos(map, id)!;
    const local: Vec2 = [
      (p[0] - curve.c[0]) * Math.cos(-curve.rot) - (p[1] - curve.c[1]) * Math.sin(-curve.rot),
      (p[0] - curve.c[0]) * Math.sin(-curve.rot) + (p[1] - curve.c[1]) * Math.cos(-curve.rot),
    ];
    close((local[0] / 14) ** 2 + (local[1] / 5) ** 2, 1, 1e-6, 'end on ellipse');
  }
});

void test('solver: a spline end tangent to a line keeps its handle on the line', async () => {
  const line = addPolyline(EMPTY_SKETCH, [
    [-20, 0],
    [0, 0],
  ]);
  const spline = addSpline(
    line.sketch,
    [
      [0, 0],
      [15, 10],
      [30, 0],
    ],
    { endpoints: [line.pointIds[1]!, null] },
  );
  const data = withConstraints(spline.sketch, [
    { kind: 'tangent', refs: [line.lineIds[0]!, spline.entityId] },
  ]);
  const solved = await solve(data);
  assert.equal(solved.status, 'ok', solved.message ?? '');
  const map = entityMap(solved.sketch);
  const h = pointPos(map, spline.handleIds[0]!)!;
  const a = pointPos(map, line.pointIds[0]!)!;
  const b = pointPos(map, line.pointIds[1]!)!;
  const cross = (b[0] - a[0]) * (h[1] - a[1]) - (b[1] - a[1]) * (h[0] - a[0]);
  close(cross, 0, 1e-6, 'handle collinear with the line');
  // Control-point spline: the second pole carries the tangent.
  const control = addSpline(
    line.sketch,
    [
      [0, 0],
      [10, 10],
      [20, 10],
      [30, 0],
    ],
    { mode: 'control', endpoints: [line.pointIds[1]!, null] },
  );
  const tangent = withConstraints(control.sketch, [
    { kind: 'tangent', refs: [control.entityId, line.lineIds[0]!] },
  ]);
  const solved2 = await solve(tangent);
  assert.equal(solved2.status, 'ok', solved2.message ?? '');
  const map2 = entityMap(solved2.sketch);
  const p1 = pointPos(map2, control.pointIds[1]!)!;
  const la = pointPos(map2, line.pointIds[0]!)!;
  const lb = pointPos(map2, line.pointIds[1]!)!;
  close(
    (lb[0] - la[0]) * (p1[1] - la[1]) - (lb[1] - la[1]) * (p1[0] - la[0]),
    0,
    1e-6,
    'second pole on the line',
  );
});

void test('solver: translate and rotate (sketch pattern) constraints place copies', async () => {
  const pts: SketchData = {
    entities: [
      { id: 'p1', kind: 'point', x: 1, y: 1 },
      { id: 'p2', kind: 'point', x: 11, y: 1.5 },
      { id: 'pa', kind: 'point', x: 0, y: 0 },
      { id: 'pb', kind: 'point', x: 10, y: 0 },
      { id: 'lab', kind: 'line', a: 'pa', b: 'pb', construction: true },
      { id: 'p3', kind: 'point', x: 5, y: 0 },
      { id: 'p4', kind: 'point', x: 0, y: 4 },
      { id: 'l34', kind: 'line', a: 'p3', b: 'p4' },
      { id: 'l12', kind: 'line', a: 'p1', b: 'p2' },
    ],
    constraints: [
      { id: 'k1', kind: 'translate', refs: ['p1', 'p2', 'pa', 'pb'] },
      { id: 'k2', kind: 'rotate', refs: ['p3', 'p4', 'origin'], value: 90 },
    ],
    dimensions: [],
  };
  const solved = await solve(pts);
  assert.equal(solved.status, 'ok', solved.message ?? '');
  const map = entityMap(solved.sketch);
  const p1 = pointPos(map, 'p1')!;
  const p2 = pointPos(map, 'p2')!;
  const pa = pointPos(map, 'pa')!;
  const pb = pointPos(map, 'pb')!;
  closePoint([p2[0] - p1[0], p2[1] - p1[1]], [pb[0] - pa[0], pb[1] - pa[1]], 1e-6, 'q - p = b - a');
  const p3 = pointPos(map, 'p3')!;
  const p4 = pointPos(map, 'p4')!;
  closePoint(p4, [-p3[1], p3[0]], 1e-6, 'p4 = p3 rotated by 90Â° about the origin');
});

void test('solver: a reference dimension does not constrain and follows the geometry', async () => {
  const rect = addRectangle(EMPTY_SKETCH, [0, 0], [30, 20], { position: true, size: true });
  const diagonal = withDimension(
    rect.sketch,
    'distance',
    [rect.pointIds[0]!, rect.pointIds[2]!],
    Math.hypot(30, 20),
  );
  const redundant = await solve(diagonal.sketch);
  assert.equal(redundant.status, 'overconstrained', 'as a driving dimension it is redundant');
  const reference: SketchData = {
    ...diagonal.sketch,
    dimensions: diagonal.sketch.dimensions.map((d) =>
      d.id === diagonal.dimensionId ? { ...d, driven: true } : d,
    ),
  };
  const ok = await solve(reference);
  assert.equal(ok.status, 'ok', ok.message ?? '');
  assert.equal(ok.dof, 0);
  const shown = ok.sketch.dimensions.find((d) => d.id === diagonal.dimensionId)!;
  close(shown.value, Math.hypot(30, 20), 1e-9, 'driven value is measured');
  // Change the width: the reference follows.
  const width = ok.sketch.dimensions.find((d) => d.name === 'd3')!;
  const wider = await solve({
    ...ok.sketch,
    dimensions: ok.sketch.dimensions.map((d) => (d.id === width.id ? { ...d, value: 40 } : d)),
  });
  assert.equal(wider.status, 'ok', wider.message ?? '');
  close(
    wider.sketch.dimensions.find((d) => d.id === diagonal.dimensionId)!.value,
    Math.hypot(40, 20),
    1e-6,
    'follows',
  );
  // Expressions may not use reference dimensions.
  const usesRef = await solve({
    ...ok.sketch,
    dimensions: ok.sketch.dimensions.map((d) =>
      d.id === width.id ? { ...d, expression: `${shown.name} / 2` } : d,
    ),
  });
  assert.equal(usesRef.status, 'invalid');
});

// ---- kernel ---------------------------------------------------------------------------

async function evaluate(features: Feature[]) {
  const { evaluator } = await loadNodeKernel();
  return evaluator.evaluate(features);
}

void test('kernel: spline-, ellipse- and text-bounded regions extrude into valid solids of the region area', async () => {
  const line = addPolyline(EMPTY_SKETCH, [
    [0, 0],
    [40, 0],
  ]);
  const spline = addSpline(
    line.sketch,
    [
      [40, 0],
      [30, 15],
      [10, 12],
      [0, 0],
    ],
    { endpoints: [line.pointIds[1]!, line.pointIds[0]!] },
  );
  const ellipse = addEllipse(spline.sketch, [70, 10], 12, 6, 25);
  const text = await textOutline(DEFAULT_SKETCH_FONT, 'Hi');
  const withText = addText(ellipse.sketch, [0, 40], {
    text: 'Hi',
    height: 10,
    font: DEFAULT_SKETCH_FONT,
    outline: text.outline,
  });
  const regions = detectRegions(withText.sketch);
  const sketch = sketchFeature('s', withText.sketch);
  const result = await evaluate([sketch, extrude('x', 's', 5)]);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.warnings, {});
  const bodies = result.bodies;
  assert.ok(bodies.length >= 1);
  const volume = bodies.reduce((sum, b) => sum + b.volume, 0);
  const area = regions.reduce((sum, r) => sum + r.area, 0);
  close(volume, area * 5, 1e-3 * area * 5, 'volume = area Ã— distance');
  for (const b of bodies) assert.equal(b.valid, true);
  // The spline side face is named after the spline entity.
  const faces = bodies.flatMap((b) => b.faces.map((f) => f.key));
  assert.ok(
    faces.some((k) => k.endsWith(`:${spline.entityId}`)),
    'spline side face key',
  );
  assert.ok(
    faces.some((k) => k.endsWith(`:${ellipse.entityId}`)),
    'ellipse side face key',
  );
  assert.ok(
    faces.some((k) => new RegExp(`:${withText.entityId}\\.\\d+(#\\d+)?$`).test(k)),
    'glyph side face key',
  );
});
