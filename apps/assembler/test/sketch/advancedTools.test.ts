/**
 * The advanced sketch tools through their pure reducers, solved by the
 * real planeGCS solver: Spline, Slot (straight/arc), Ellipse (full/arc),
 * inscribed/circumscribed Polygon, Mirror, Pattern (linear/circular),
 * Fillet/Chamfer corners and Trim of ellipses/splines — geometry, degrees
 * of freedom, detected regions and how copies follow their originals.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { addCircle, addRectangle } from '../../renderer/src/sketch/builders.js';
import { trimAt } from '../../renderer/src/sketch/edits.js';
import type { Inference, SketchHit } from '../../renderer/src/sketch/inference.js';
import { detectRegions } from '../../renderer/src/sketch/regions.js';
import {
  initialTool,
  reduceTool,
  toolPreview,
  type SketchTool,
  type SketchToolKind,
  type ToolEvent,
  type ValueField,
} from '../../renderer/src/sketch/tools.js';
import {
  EMPTY_SKETCH,
  entityMap,
  pointPos,
  type SketchData,
  type Vec2,
} from '../../renderer/src/sketch/types.js';
import { loadNodeSolver } from './nodeSolver.js';

function close(a: number, b: number, tol: number, what = ''): void {
  assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≈ ${b} (±${tol})`);
}

function snap(pos: Vec2, extra: Partial<Inference> = {}): Inference {
  return { pos, hints: [], guides: [], ...extra };
}

/** Drives a tool with events; every edit is solved (like the session) and must succeed. */
class Drive {
  sketch: SketchData;
  tool: SketchTool;
  notices: string[] = [];
  constructor(kind: SketchToolKind, sketch: SketchData = EMPTY_SKETCH, selection: string[] = []) {
    this.sketch = sketch;
    this.tool = initialTool(kind, selection);
  }
  async send(event: ToolEvent): Promise<void> {
    const step = reduceTool(this.sketch, this.tool, event, { construction: false });
    if (step.notice) this.notices.push(step.notice);
    if (step.edit) {
      const result = (await loadNodeSolver()).solveSync({ sketch: step.edit.sketch });
      assert.equal(
        result.status,
        'ok',
        `${result.message ?? ''} ${result.conflicting} ${result.redundant}`,
      );
      this.sketch = result.sketch;
    }
    this.tool = step.tool;
  }
  click(pos: Vec2, hit: SketchHit | null = null, extra: Partial<Inference> = {}): Promise<void> {
    return this.send({ type: 'click', snap: snap(pos, extra), hit, raw: pos });
  }
  value(field: ValueField, value: number, at: Vec2 = [0, 0]): Promise<void> {
    return this.send({ type: 'value', field, value, snap: snap(at) });
  }
  finish(): Promise<void> {
    return this.send({ type: 'finish' });
  }
  async dof(): Promise<number> {
    const result = (await loadNodeSolver()).solveSync({ sketch: this.sketch });
    assert.equal(result.status, 'ok');
    return result.dof;
  }
}

async function solveWith(
  sketch: SketchData,
  dimensionName: string,
  value: number,
): Promise<SketchData> {
  const result = (await loadNodeSolver()).solveSync({
    sketch: {
      ...sketch,
      dimensions: sketch.dimensions.map((d) => (d.name === dimensionName ? { ...d, value } : d)),
    },
  });
  assert.equal(result.status, 'ok', result.message ?? '');
  return result.sketch;
}

void test('spline tool: fit points with tangent handles; Enter finishes; closing on the first point makes a region', async () => {
  const d = new Drive('spline');
  await d.click([0, 0]);
  await d.click([10, 8]);
  await d.click([25, 2]);
  const preview = toolPreview(d.sketch, d.tool, snap([35, 10]), null);
  assert.ok(preview.curves.length >= 1 && preview.curves[0]!.length > 10, 'rubber-band spline');
  await d.finish();
  const spline = d.sketch.entities.find((e) => e.kind === 'spline');
  assert.ok(spline?.kind === 'spline');
  assert.equal(spline.mode, 'fit');
  assert.equal(spline.points.length, 3);
  assert.equal(spline.handles?.filter(Boolean).length, 2);
  assert.equal(await d.dof(), 10, '3 fit points + 2 handles');
  // Closed control-point spline.
  const c = new Drive('spline');
  c.tool = { ...c.tool, mode: 'control' } as SketchTool;
  await c.click([0, 0]);
  await c.click([20, 0]);
  await c.click([20, 20]);
  await c.click([0, 20]);
  await c.click([0.02, 0.01]); // the first point again: closes
  const closed = c.sketch.entities.find((e) => e.kind === 'spline');
  assert.ok(closed?.kind === 'spline');
  assert.equal(closed.points[0], closed.points[closed.points.length - 1]);
  assert.equal(detectRegions(c.sketch).length, 1);
});

void test('straight slot: 5 degrees of freedom, region area = length × width + disc; typed width dimension', async () => {
  const d = new Drive('slot');
  await d.click([0, 0]);
  await d.value('length', 30, [10, 0]);
  await d.value('width', 8);
  const regions = detectRegions(d.sketch);
  assert.equal(regions.length, 1);
  close(regions[0]!.area, 30 * 8 + Math.PI * 16, 1e-6, 'slot area');
  assert.deepEqual(
    d.sketch.dimensions.map((x) => [x.kind, Math.round(x.value * 1000) / 1000]),
    [
      ['distance', 30],
      ['diameter', 8],
    ],
  );
  // Centre distance and width are driven by the two dimensions; position and angle stay free.
  assert.equal(await d.dof(), 3);
  const wider = await solveWith(d.sketch, 'd2', 12);
  close(detectRegions(wider)[0]!.area, 30 * 12 + Math.PI * 36, 1e-4, 'follows the width');
});

void test('arc slot: 6 degrees of freedom; region is an annular sector with round ends', async () => {
  const d = new Drive('slot');
  d.tool = { ...d.tool, mode: 'arc' } as SketchTool;
  await d.click([0, 0]); // centre
  await d.click([20, 0]); // start
  await d.click([0, 20]); // end: a quarter turn, counter-clockwise
  await d.value('width', 4);
  const regions = detectRegions(d.sketch);
  assert.equal(regions.length, 1);
  const expected = (Math.PI / 2) * 20 * 4 + Math.PI * 4;
  close(regions[0]!.area, expected, 1e-4, 'arc slot area');
  assert.equal(await d.dof(), 5, 'width dimensioned: 6 - 1');
});

void test('ellipse tool: centre, first axis, second axis (and arc ends); ellipse is 5 DOF', async () => {
  const d = new Drive('ellipse');
  await d.click([0, 0]);
  await d.click([12, 0]);
  await d.click([3, 5]); // 5 from the major axis
  const e = d.sketch.entities.find((x) => x.kind === 'ellipse');
  assert.ok(e);
  close(detectRegions(d.sketch)[0]!.area, Math.PI * 12 * 5, 1e-6, 'ellipse area');
  assert.equal(await d.dof(), 5);
  // A second axis longer than the first is refused with a reason.
  const bad = new Drive('ellipse');
  await bad.click([0, 0]);
  await bad.click([5, 0]);
  await bad.click([0, 9]);
  assert.equal(bad.sketch.entities.length, 0);
  assert.match(bad.notices.join(), /longer than the first/);
  // Elliptical arc: two more clicks.
  const a = new Drive('ellipse');
  a.tool = { ...a.tool, mode: 'arc' } as SketchTool;
  await a.click([0, 0]);
  await a.click([10, 0]);
  await a.value('minor', 4);
  await a.click([10, 0.1]);
  await a.click([-10, 0.1]);
  const arc = a.sketch.entities.find((x) => x.kind === 'ellipticArc');
  assert.ok(arc, 'elliptical arc');
  assert.equal(await a.dof(), 6, 'arc 7 DOF, the typed second radius is a dimension');
});

void test('polygon: circumscribed hexagon has its edges tangent to the circle; both variants have 4 DOF', async () => {
  const outer = new Drive('polygon');
  outer.tool = { ...outer.tool, inscribed: false } as SketchTool;
  await outer.click([0, 0]);
  await outer.click([10, 0]); // edge midpoint: apothem 10
  const area = detectRegions(outer.sketch)[0]!.area;
  close(area, 2 * Math.sqrt(3) * 100, 1e-6, 'hexagon with apothem 10');
  assert.equal(await outer.dof(), 4);
  const inner = new Drive('polygon');
  await inner.click([0, 0]);
  await inner.click([10, 0]); // vertex: circumradius 10
  close(detectRegions(inner.sketch)[0]!.area, ((3 * Math.sqrt(3)) / 2) * 100, 1e-6, 'inscribed');
  assert.equal(await inner.dof(), 4);
});

void test('mirror: copies are symmetric about the line and follow the original', async () => {
  const rect = addRectangle(EMPTY_SKETCH, [5, 0], [15, 10], { size: true, position: true });
  const axis: SketchData = {
    ...rect.sketch,
    entities: [
      ...rect.sketch.entities,
      { id: 'pa', kind: 'point', x: 0, y: -5 },
      { id: 'pb', kind: 'point', x: 0, y: 20 },
      { id: 'lax', kind: 'line', a: 'pa', b: 'pb', construction: true },
    ],
    constraints: [
      ...rect.sketch.constraints,
      { id: 'kv', kind: 'vertical', refs: ['lax'] },
      { id: 'ko', kind: 'pointOnObject', refs: ['origin', 'lax'] },
    ],
  };
  const d = new Drive('mirror', axis, rect.lineIds);
  assert.equal(
    d.tool.kind === 'mirror' && d.tool.step,
    'axis',
    'starts on the axis step with a selection',
  );
  await d.click([0, 5], { kind: 'curve', id: 'lax' });
  const regions = detectRegions(d.sketch);
  assert.equal(regions.length, 2);
  const samples = regions.map((r) => r.sample[0]).sort((a, b) => a - b);
  assert.ok(samples[0]! < 0 && samples[1]! > 0, 'one each side');
  // The copy follows a width change of the original.
  const wider = await solveWith(d.sketch, 'd3', 20);
  const areas = detectRegions(wider).map((r) => Math.round(r.area));
  assert.deepEqual(areas, [200, 200]);
});

void test('linear pattern: count and spacing; the spacing dimension drives every copy', async () => {
  const c = addCircle(EMPTY_SKETCH, [0, 0], 2, { size: true, position: true });
  const d = new Drive('pattern', c.sketch, [c.circleId]);
  await d.value('count', 4);
  await d.value('spacing', 10, [30, 0.2]); // direction to the right
  const circles = d.sketch.entities.filter((e) => e.kind === 'circle');
  assert.equal(circles.length, 4);
  assert.equal(await d.dof(), 0, 'copies are fully determined');
  const spacing = d.sketch.dimensions.find((x) => x.value === 10)!;
  const moved = await solveWith(d.sketch, spacing.name, 15);
  const map = entityMap(moved);
  const xs = moved.entities
    .filter((e) => e.kind === 'circle')
    .map((e) => (e.kind === 'circle' ? pointPos(map, e.center)![0] : 0))
    .sort((a, b) => a - b);
  xs.forEach((x, i) => close(x, i * 15, 1e-6, `copy ${i}`));
});

void test('circular pattern: six copies around a centre, rotated by 60°', async () => {
  const c = addCircle(EMPTY_SKETCH, [20, 0], 3, { size: true, position: true });
  const d = new Drive('pattern', c.sketch, [c.circleId]);
  d.tool = { ...d.tool, mode: 'circular', count: 6 } as SketchTool;
  await d.click([0, 0], null, { pointId: 'origin' });
  const map = entityMap(d.sketch);
  const angles = d.sketch.entities
    .filter((e) => e.kind === 'circle')
    .map((e) => {
      const p = e.kind === 'circle' ? pointPos(map, e.center)! : [0, 0];
      return Math.round((Math.atan2(p[1]!, p[0]!) * 180) / Math.PI);
    })
    .sort((a, b) => a - b);
  assert.deepEqual(angles, [-120, -60, 0, 60, 120, 180]);
  assert.equal(await d.dof(), 0);
});

void test('fillet and chamfer a fully constrained rectangle corner: still fully constrained, exact areas', async () => {
  const rect = addRectangle(EMPTY_SKETCH, [0, 0], [30, 20], { size: true, position: true });
  const corner = rect.pointIds[2]!; // (30, 20)
  const f = new Drive('corner', rect.sketch);
  await f.click([30, 20], { kind: 'point', id: corner });
  await f.value('size', 5);
  close(detectRegions(f.sketch)[0]!.area, 600 - (25 - (Math.PI * 25) / 4), 1e-6, 'fillet area');
  assert.equal(await f.dof(), 0);
  assert.ok(f.sketch.dimensions.some((d) => d.kind === 'radius' && d.value === 5));
  // The virtual corner keeps its position (dimensions to it survive).
  const vp = pointPos(entityMap(f.sketch), corner)!;
  close(vp[0], 30, 1e-9);
  close(vp[1], 20, 1e-9);
  const c = new Drive('corner', rect.sketch);
  c.tool = { ...c.tool, mode: 'chamfer' } as SketchTool;
  await c.click([30, 20], { kind: 'point', id: corner });
  await c.value('size', 4);
  close(detectRegions(c.sketch)[0]!.area, 600 - 8, 1e-6, 'chamfer area');
  assert.equal(await c.dof(), 0);
  // Too large for the corner: refused with a reason.
  const big = new Drive('corner', rect.sketch);
  await big.click([30, 20], { kind: 'point', id: corner });
  await big.value('size', 40);
  assert.match(big.notices.join(), /Too large/);
});

void test('trim: an ellipse cut by a line becomes an elliptical arc; a spline splits into control-point pieces', async () => {
  const ellipse: SketchData = {
    entities: [
      { id: 'c', kind: 'point', x: 0, y: 0 },
      { id: 'm', kind: 'point', x: 10, y: 0 },
      { id: 'n', kind: 'point', x: 0, y: 5 },
      { id: 'e1', kind: 'ellipse', center: 'c', major: 'm', minor: 'n' },
      { id: 'a', kind: 'point', x: -20, y: 0 },
      { id: 'b', kind: 'point', x: 20, y: 0 },
      { id: 'l1', kind: 'line', a: 'a', b: 'b' },
    ],
    constraints: [],
    dimensions: [],
  };
  const trimmed = trimAt(ellipse, 'e1', [0, -5]);
  assert.ok(trimmed);
  const arc = trimmed.sketch.entities.find((e) => e.id === 'e1');
  assert.equal(arc?.kind, 'ellipticArc');
  const solved = (await loadNodeSolver()).solveSync({ sketch: trimmed.sketch });
  assert.equal(solved.status, 'ok', solved.message ?? '');
  const regions = detectRegions(solved.sketch);
  assert.equal(regions.length, 1, 'upper half closed by the line');
  close(regions[0]!.area, Math.PI * 25, 1e-4);
  // Spline crossing a line twice: trimming the middle leaves two control-point splines.
  const spline: SketchData = {
    entities: [
      { id: 'p1', kind: 'point', x: 0, y: -5 },
      { id: 'p2', kind: 'point', x: 10, y: 10 },
      { id: 'p3', kind: 'point', x: 20, y: -5 },
      { id: 's1', kind: 'spline', mode: 'fit', points: ['p1', 'p2', 'p3'] },
      { id: 'q1', kind: 'point', x: -5, y: 0 },
      { id: 'q2', kind: 'point', x: 25, y: 0 },
      { id: 'l2', kind: 'line', a: 'q1', b: 'q2' },
    ],
    constraints: [],
    dimensions: [],
  };
  const cut = trimAt(spline, 's1', [10, 10]);
  assert.ok(cut);
  const pieces = cut.sketch.entities.filter((e) => e.kind === 'spline');
  assert.equal(pieces.length, 2);
  for (const p of pieces) assert.equal(p.kind === 'spline' && p.mode, 'control');
  const cutSolved = (await loadNodeSolver()).solveSync({ sketch: cut.sketch });
  assert.equal(cutSolved.status, 'ok', cutSolved.message ?? '');
});
