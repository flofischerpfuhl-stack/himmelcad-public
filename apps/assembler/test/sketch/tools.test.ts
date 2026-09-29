/**
 * Pure sketch tool logic: the tool reducer (rectangle, circle, polygon, arc,
 * tangent arc), inference/snapping, trim, offset and constraint planning.
 * The solver-backed session is covered by `session.test.ts`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { planConstraint } from '../../renderer/src/sketch/constraintRules.js';
import { deleteItems, offsetChain, tangentArc, trimAt } from '../../renderer/src/sketch/edits.js';
import { infer } from '../../renderer/src/sketch/inference.js';
import { addCircle, addPolyline, addRectangle } from '../../renderer/src/sketch/builders.js';
import { detectRegions } from '../../renderer/src/sketch/regions.js';
import {
  initialTool,
  reduceTool,
  type SketchTool,
  type ToolEvent,
} from '../../renderer/src/sketch/tools.js';
import {
  EMPTY_SKETCH,
  entityMap,
  radiusOf,
  type SketchData,
  type Vec2,
} from '../../renderer/src/sketch/types.js';

const ctx = { construction: false };

function click(pos: Vec2, extra: Partial<Extract<ToolEvent, { type: 'click' }>> = {}): ToolEvent {
  return { type: 'click', snap: { pos, hints: [], guides: [] }, hit: null, raw: pos, ...extra };
}

/** Runs events through the reducer, adopting every edit (no solver). */
function run(
  sketch: SketchData,
  tool: SketchTool,
  events: ToolEvent[],
): { sketch: SketchData; tool: SketchTool } {
  let s = sketch;
  let t = tool;
  for (const event of events) {
    const step = reduceTool(s, t, event, ctx);
    if (step.edit) s = step.edit.sketch;
    t = step.tool;
  }
  return { sketch: s, tool: t };
}

void test('rectangle tool: two corners make four lines with two horizontal and two vertical constraints', () => {
  const { sketch, tool } = run(EMPTY_SKETCH, initialTool('rectangle'), [
    click([10, 5]),
    click([-10, -5]),
  ]);
  assert.equal(sketch.entities.filter((e) => e.kind === 'line').length, 4);
  assert.deepEqual(sketch.constraints.map((c) => c.kind).sort(), [
    'horizontal',
    'horizontal',
    'vertical',
    'vertical',
  ]);
  assert.equal(detectRegions(sketch)[0]!.area, 200);
  assert.equal(tool.kind === 'rectangle' && tool.first, null);
});

void test('rectangle tool: centre mode and typed width/height add dimensions', () => {
  let tool = { ...initialTool('rectangle'), mode: 'center' } as SketchTool;
  let step = reduceTool(EMPTY_SKETCH, tool, click([0, 0]), ctx);
  tool = step.tool;
  step = reduceTool(
    EMPTY_SKETCH,
    tool,
    { type: 'value', field: 'width', value: 30, snap: { pos: [5, 5], hints: [], guides: [] } },
    ctx,
  );
  assert.equal(step.edit, undefined, 'waits for the height');
  step = reduceTool(
    EMPTY_SKETCH,
    step.tool,
    { type: 'value', field: 'height', value: 20, snap: { pos: [5, 5], hints: [], guides: [] } },
    ctx,
  );
  const sketch = step.edit!.sketch;
  assert.deepEqual(
    sketch.dimensions.map((d) => [d.kind, d.value]),
    [
      ['distance', 30],
      ['distance', 20],
    ],
  );
  assert.ok(
    sketch.constraints.some((c) => c.kind === 'midpoint'),
    'centre point on the construction diagonal',
  );
  assert.equal(detectRegions(sketch)[0]!.area, 600);
});

void test('circle tool: typed diameter adds a diameter dimension', () => {
  let step = reduceTool(EMPTY_SKETCH, initialTool('circle'), click([3, 4]), ctx);
  step = reduceTool(
    EMPTY_SKETCH,
    step.tool,
    { type: 'value', field: 'diameter', value: 12, snap: { pos: [9, 4], hints: [], guides: [] } },
    ctx,
  );
  const sketch = step.edit!.sketch;
  const circle = sketch.entities.find((e) => e.kind === 'circle');
  assert.equal(circle?.kind === 'circle' && circle.radius, 6);
  assert.deepEqual(
    sketch.dimensions.map((d) => [d.kind, d.value]),
    [['diameter', 12]],
  );
});

void test('polygon tool: a regular hexagon with a construction circle, point-on-circle and equal constraints', () => {
  const { sketch } = run(EMPTY_SKETCH, initialTool('polygon'), [click([0, 0]), click([10, 0])]);
  assert.equal(sketch.entities.filter((e) => e.kind === 'line').length, 6);
  const circle = sketch.entities.find((e) => e.kind === 'circle');
  assert.equal(circle?.construction, true);
  assert.equal(sketch.constraints.filter((c) => c.kind === 'pointOnObject').length, 6);
  assert.equal(sketch.constraints.filter((c) => c.kind === 'equal').length, 5);
  const area = detectRegions(sketch)[0]!.area;
  assert.ok(Math.abs(area - ((3 * Math.sqrt(3)) / 2) * 100) < 1e-6);
});

void test('line tool: typed length adds a distance dimension along the cursor direction', () => {
  let tool = reduceTool(EMPTY_SKETCH, initialTool('line'), click([0, 0]), ctx).tool;
  const step = reduceTool(
    EMPTY_SKETCH,
    tool,
    { type: 'value', field: 'length', value: 25, snap: { pos: [3, 4], hints: [], guides: [] } },
    ctx,
  );
  const sketch = step.edit!.sketch;
  const end = sketch.entities.filter((e) => e.kind === 'point')[1]!;
  assert.ok(end.kind === 'point' && Math.abs(end.x - 15) < 1e-9 && Math.abs(end.y - 20) < 1e-9);
  assert.deepEqual(
    sketch.dimensions.map((d) => d.value),
    [25],
  );
  tool = step.tool;
  assert.equal(
    tool.kind === 'line' && tool.lastPointId,
    end.id,
    'the chain continues from the end',
  );
});

void test('arc tool: three points, and a tangent continuation from a line end', () => {
  const three = run(EMPTY_SKETCH, initialTool('arc'), [
    click([10, 0]),
    click([-10, 0]),
    click([0, 10]),
  ]);
  const map = entityMap(three.sketch);
  const arc = three.sketch.entities.find((e) => e.kind === 'arc')!;
  assert.ok(arc.kind === 'arc' && Math.abs(radiusOf(map, arc) - 10) < 1e-9);

  const line = addPolyline(EMPTY_SKETCH, [
    [0, 0],
    [10, 0],
  ]).sketch; // p1 -> p2
  let tool = reduceTool(
    line,
    initialTool('arc'),
    click([10, 0], { snap: { pos: [10, 0], pointId: 'p2', hints: [], guides: [] } }),
    ctx,
  ).tool;
  assert.ok(
    tool.kind === 'arc' && tool.tangent?.lineId === 'l1',
    'starting at a line end continues tangentially',
  );
  const step = reduceTool(line, tool, click([10, 20]), ctx);
  tool = step.tool;
  const tangentSketch = step.edit!.sketch;
  assert.ok(tangentSketch.constraints.some((c) => c.kind === 'tangent'));
  const centre = tangentArc([10, 0], [1, 0], [10, 20])!;
  assert.deepEqual(centre, { center: [10, 10], ccw: true });
});

void test('inference: endpoint snap, horizontal/vertical, perpendicular to the previous line, midpoint, grid', () => {
  const s = addPolyline(EMPTY_SKETCH, [
    [0, 0],
    [20, 0],
  ]).sketch;
  const px = 0.1;
  assert.equal(infer(s, [20.3, 0.4], { mmPerPx: px }).pointId, 'p2');
  assert.equal(infer(s, [10.2, 0.3], { mmPerPx: px }).midpointOf, 'l1');
  const h = infer(s, [35, 0.5], { mmPerPx: px, from: { pos: [20, 0], pointId: 'p2' } });
  assert.equal(h.horizontal, true);
  assert.deepEqual(h.pos, [35, 0]);
  const perp = infer(s, [20.5, 15], {
    mmPerPx: px,
    from: { pos: [20, 0], pointId: 'p2', lineId: 'l1' },
  });
  assert.equal(
    perp.vertical,
    true,
    'vertical wins over perpendicular for an axis-aligned previous line',
  );
  const tilted = addPolyline(EMPTY_SKETCH, [
    [0, 0],
    [10, 10],
  ]).sketch;
  const p2 = infer(tilted, [10.3 - 10, 10 + 10.2], {
    mmPerPx: px,
    from: { pos: [10, 10], pointId: 'p2', lineId: 'l1' },
  });
  assert.equal(p2.perpendicularTo, 'l1');
  const grid = infer(EMPTY_SKETCH, [12.4, 7.6], { mmPerPx: 0.01, gridStep: 5 });
  assert.deepEqual(grid.pos, [10, 10]);
  const origin = infer(EMPTY_SKETCH, [0.2, -0.3], { mmPerPx: px });
  assert.equal(origin.pointId, 'origin');
});

void test('trim: removes the middle piece of a crossed line and the arc of a circle between two cuts', () => {
  let s = addPolyline(EMPTY_SKETCH, [
    [0, 0],
    [30, 0],
  ]).sketch;
  s = addPolyline(s, [
    [10, -5],
    [10, 5],
  ]).sketch;
  s = addPolyline(s, [
    [20, -5],
    [20, 5],
  ]).sketch;
  const trimmed = trimAt(s, 'l1', [15, 0])!.sketch;
  const lines = trimmed.entities.filter((e) => e.kind === 'line');
  assert.equal(lines.length, 4, 'the long line became two pieces');
  const map = entityMap(trimmed);
  const pieces = lines
    .filter((l) => l.kind === 'line' && (l.id === 'l1' || !['l2', 'l3'].includes(l.id)))
    .map((l) =>
      l.kind === 'line'
        ? [map.get(l.a), map.get(l.b)].map((p) => (p?.kind === 'point' ? p.x : NaN))
        : [],
    );
  assert.deepEqual(
    pieces.map((p) => p.sort((a, b) => a - b)),
    [
      [0, 10],
      [20, 30],
    ],
  );

  let c = addCircle(EMPTY_SKETCH, [0, 0], 10).sketch;
  c = addPolyline(c, [
    [-20, 0],
    [20, 0],
  ]).sketch;
  const arc = trimAt(c, 'c1', [0, 10])!.sketch;
  const e = arc.entities.find((x) => x.id === 'c1');
  assert.equal(e?.kind, 'arc', 'the circle became an arc keeping its id');
  assert.equal(detectRegions(arc).length, 1, 'a half disk remains');
  // Trimming a curve without intersections deletes it.
  assert.equal(
    trimAt(addCircle(EMPTY_SKETCH, [0, 0], 3).sketch, 'c1', [3, 0])!.sketch.entities.length,
    0,
  );
});

void test('offset: a closed rectangle chain offsets outwards with mitred corners', () => {
  const s = addRectangle(EMPTY_SKETCH, [0, 0], [20, 10]).sketch;
  // Right of the counter-clockwise bottom line = outside.
  const edit = offsetChain(s, 'l1', -2)!;
  const regions = detectRegions(edit.sketch);
  const areas = regions.map((r) => Math.round(r.area)).sort((a, b) => a - b);
  assert.deepEqual(areas, [24 * 14 - 200, 200]);
  assert.equal(edit.select?.length, 4);
  const circle = offsetChain(addCircle(EMPTY_SKETCH, [0, 0], 5).sketch, 'c1', 2)!;
  const created = circle.sketch.entities.find((e) => e.kind === 'circle' && e.id !== 'c1');
  assert.equal(created?.kind === 'circle' && created.radius, 3, 'left of a circle is inside');
});

void test('constraint planning follows the selection; delete removes dependent constraints', () => {
  const s = addRectangle(EMPTY_SKETCH, [0, 0], [20, 10]).sketch;
  assert.equal(planConstraint(s, 'parallel', ['l1']).ok, false);
  const plan = planConstraint(s, 'equal', ['l1', 'l2']);
  assert.ok(plan.ok);
  assert.deepEqual(plan.ok && plan.constraints, [{ kind: 'equal', refs: ['l1', 'l2'] }]);
  const lock = planConstraint(s, 'fixed', ['l1', 'l2']);
  assert.ok(lock.ok && lock.constraints.length === 3, 'shared corner locked once');
  const reason = planConstraint(s, 'coincident', ['l1']);
  assert.equal(reason.ok ? '' : reason.reason, 'Select two points.');
  const deleted = deleteItems(s, ['l1']);
  assert.equal(deleted.entities.filter((e) => e.kind === 'line').length, 3);
  assert.equal(deleted.constraints.length, 3, 'the horizontal constraint of l1 went with it');
  assert.equal(deleted.entities.filter((e) => e.kind === 'point').length, 4, 'shared points stay');
});
