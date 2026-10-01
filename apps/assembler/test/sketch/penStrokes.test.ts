/**
 * Pen-first sketching (assembler/TOUCH.md) on the real planeGCS solver:
 * hand-drawn-like strokes (`test/input/strokeFixtures.ts`) become ordinary
 * sketch entities through the drawing tools (`penStrokes.ts` →
 * `SketchState.runTool`), with the tools' point connections and inferred
 * constraints, one session undo step per stroke; scribbles erase; the
 * active tool is untouched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { DEFAULT_SKETCH_SNAPS } from '../../renderer/src/platform/input/snapToggles.js';
import { detectRegions } from '../../renderer/src/foundation/sketch-solver/regions.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import type { SketchData, Vec2 } from '../../renderer/src/foundation/sketch-solver/types.js';
import {
  applyInk,
  planInk,
  type InkContext,
} from '../../renderer/src/modules/sketching/penStrokes.js';
import { useSketchStore } from '../../renderer/src/modules/sketching/session.js';
import type { SketchToolKind } from '../../renderer/src/modules/sketching/tools.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from './nodeSolver.js';
import {
  arcStroke,
  circleStroke,
  lineStroke,
  polylineStroke,
  rectangleStroke,
  rotatedRectangleStroke,
  scribbleStroke,
  type Pt,
} from '../input/strokeFixtures.js';

const store = useAssemblerStore;
const sketch = useSketchStore;
store.getState().attachKernel(createNodeKernelAdapter());
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));

/** The simulated view: 0.1 mm per screen pixel, y up in the sketch plane. */
const MM_PER_PX = 0.1;

function toSketch(points: Pt[]): Vec2[] {
  return points.map((p) => [p.x * MM_PER_PX, -p.y * MM_PER_PX]);
}

function ctx(toolKind: SketchToolKind = 'select'): InkContext {
  return {
    mmPerPx: MM_PER_PX,
    gridStep: null,
    snaps: { ...DEFAULT_SKETCH_SNAPS },
    body: null,
    toolKind,
    penShapes: true,
    scribbleErase: true,
  };
}

function session() {
  const s = sketch.getState().session;
  assert.ok(s, 'a sketch session is open');
  return s;
}

async function draw(points: Pt[]): Promise<string> {
  const s = session();
  const result = await applyInk(planInk(s.sketch, toSketch(points), ctx(s.tool.kind)));
  await sketch.getState().whenIdle();
  return result;
}

function count(data: SketchData, kind: string): number {
  return data.entities.filter((e) => e.kind === kind).length;
}

function constraints(data: SketchData, kind: string): number {
  return data.constraints.filter((c) => c.kind === kind).length;
}

async function fresh(tool: SketchToolKind = 'select'): Promise<void> {
  if (sketch.getState().session) sketch.getState().discard();
  store.getState().loadDocument([]);
  await store.getState().whenSettled();
  assert.ok(sketch.getState().begin({ plane: 'XY', tool }));
}

void test('pen line: straightened, horizontal constraint, one undo step; the active tool stays', async () => {
  await fresh('select');
  assert.equal(await draw(lineStroke(100, 100, 400, 110)), 'created');
  const s = session();
  assert.equal(count(s.sketch, 'line'), 1);
  assert.equal(constraints(s.sketch, 'horizontal'), 1);
  assert.equal(s.past.length, 1, 'one session undo step');
  assert.equal(s.tool.kind, 'select', 'the active tool is untouched');
  assert.equal(s.problem, null);
  // A second stroke from the line's end, downwards: connected (shared point) and vertical.
  assert.equal(await draw(lineStroke(400, 110, 402, 300, 5)), 'created');
  const t = session();
  assert.equal(count(t.sketch, 'line'), 2);
  assert.equal(constraints(t.sketch, 'vertical'), 1);
  assert.equal(
    count(t.sketch, 'point'),
    3,
    'the corner point is shared (coincident by construction)',
  );
  sketch.getState().undo();
  await sketch.getState().whenIdle();
  assert.equal(count(session().sketch, 'line'), 1, 'undo removes the whole stroke');
});

void test('pen circle around the origin is centred on it; scribbling over it erases it', async () => {
  await fresh('line');
  assert.equal(await draw(circleStroke(0, 0, 150)), 'created');
  const s = session();
  const circle = s.sketch.entities.find((e) => e.kind === 'circle');
  assert.ok(circle && circle.kind === 'circle');
  assert.ok(
    s.sketch.constraints.some(
      (c) => c.kind === 'coincident' && c.refs.includes(circle.center) && c.refs.includes('origin'),
    ),
    'the centre snapped to the origin',
  );
  assert.ok(Math.abs(circle.radius - 15) < 1.5, `radius ${circle.radius} mm`);
  assert.equal(await draw(scribbleStroke(150, 0, 60)), 'erased');
  assert.equal(count(session().sketch, 'circle'), 0);
});

void test('pen rectangles: axis-aligned with H/V constraints, rotated without; both closed profiles', async () => {
  await fresh('select');
  assert.equal(await draw(rectangleStroke(100, 100, 400, 300)), 'created');
  let s = session();
  assert.equal(count(s.sketch, 'line'), 4);
  assert.equal(constraints(s.sketch, 'horizontal'), 2);
  assert.equal(constraints(s.sketch, 'vertical'), 2);
  assert.equal(detectRegions(s.sketch).length, 1, 'a closed profile');
  await fresh('rectangle');
  assert.equal(await draw(rotatedRectangleStroke(300, 300, 240, 140, 30)), 'created');
  s = session();
  assert.equal(count(s.sketch, 'line'), 4);
  assert.equal(constraints(s.sketch, 'horizontal') + constraints(s.sketch, 'vertical'), 0);
  assert.equal(detectRegions(s.sketch).length, 1);
});

void test('pen arcs: tangent when leaving a line end along it, a plain arc otherwise', async () => {
  await fresh('line');
  await draw(lineStroke(100, 300, 400, 300));
  // From the line's right end, continuing to the right and curving up (screen y down).
  assert.equal(await draw(arcStroke(400, 200, 100, 90, -60, 3)), 'created');
  let s = session();
  assert.equal(count(s.sketch, 'arc'), 1);
  assert.equal(constraints(s.sketch, 'tangent'), 1, 'tangent continuation');
  // Leaving the line's left end at a right angle: no tangency.
  await fresh('line');
  await draw(lineStroke(100, 300, 400, 300));
  assert.equal(await draw(arcStroke(150, 300, 50, 180, 360, 4)), 'created');
  s = session();
  assert.equal(count(s.sketch, 'arc'), 1);
  assert.equal(constraints(s.sketch, 'tangent'), 0);
});

void test('a closed pen triangle is one closed profile; an L is two connected lines', async () => {
  await fresh('line');
  assert.equal(
    await draw(
      polylineStroke([
        [200, 100],
        [350, 330],
        [60, 330],
        [200, 104],
      ]),
    ),
    'created',
  );
  let s = session();
  assert.equal(count(s.sketch, 'line'), 3);
  assert.equal(detectRegions(s.sketch).length, 1);
  assert.equal(s.past.length, 1, 'one undo step for the whole outline');
  await fresh('line');
  assert.equal(
    await draw(
      polylineStroke([
        [100, 100],
        [100, 300],
        [300, 300],
      ]),
    ),
    'created',
  );
  s = session();
  assert.equal(count(s.sketch, 'line'), 2);
  assert.equal(count(s.sketch, 'point'), 3);
});

void test('tools restrict shapes; unrecognised strokes and switched-off settings leave a notice', async () => {
  await fresh('circle');
  assert.equal(await draw(lineStroke(100, 100, 400, 200)), 'none');
  assert.match(session().notice ?? '', /circle tool takes a circle/);
  assert.equal(session().sketch.entities.length, 0);
  const wave = Array.from({ length: 80 }, (_, i) => ({ x: i * 4, y: 40 * Math.sin(i / 6), t: i }));
  await fresh('select');
  assert.equal(await draw(wave), 'none');
  assert.match(session().notice ?? '', /Not recognised/);
  const off = planInk(session().sketch, toSketch(lineStroke(0, 0, 300, 0)), {
    ...ctx('select'),
    penShapes: false,
  });
  assert.equal(off.kind, 'none');
});
