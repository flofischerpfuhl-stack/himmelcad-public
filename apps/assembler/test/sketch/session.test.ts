/**
 * Sketch mode end to end on the real planeGCS solver and the real OCCT
 * kernel: drawing with inferred constraints, dimensioning, over-constraint
 * rejection, dragging, finishing as one undo step, extruding a profile and
 * a later dimension change that the extrude follows.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtrudeFeature } from '../../renderer/src/foundation/document/document.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { setSketchDimension } from '../../renderer/src/modules/sketching/featureOps.js';
import { hitTest, infer } from '../../renderer/src/modules/sketching/inference.js';
import { detectRegions } from '../../renderer/src/foundation/sketch-solver/regions.js';
import { useSketchStore } from '../../renderer/src/modules/sketching/session.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { segmentStart } from '../../renderer/src/modules/sketching/tools.js';
import {
  entityMap,
  pointPos,
  type Vec2,
} from '../../renderer/src/foundation/sketch-solver/types.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from './nodeSolver.js';

const store = useAssemblerStore;
const sketch = useSketchStore;
store.getState().attachKernel(createNodeKernelAdapter());
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));

/** Millimetres per pixel of the simulated view (thresholds: 10 px snap = 1 mm). */
const MM_PER_PX = 0.1;

function session() {
  const s = sketch.getState().session;
  assert.ok(s, 'a sketch session is open');
  return s;
}

/** A user click at `raw` with the same snapping/inference the overlay applies. */
async function click(raw: Vec2): Promise<void> {
  const s = session();
  const from = segmentStart(s.sketch, s.tool);
  const snap = infer(s.sketch, raw, {
    mmPerPx: MM_PER_PX,
    ...(from ? { from } : {}),
    gridStep: null,
  });
  await sketch
    .getState()
    .dispatch({ type: 'click', snap, hit: hitTest(s.sketch, raw, MM_PER_PX), raw });
}

async function reset(): Promise<void> {
  if (sketch.getState().session) sketch.getState().discard();
  store.getState().loadDocument([]);
  await store.getState().whenSettled();
}

/** Draws an L (40 x 30, 10 wide legs) with slightly sloppy clicks; returns nothing, leaves the session open. */
async function drawL(): Promise<void> {
  assert.ok(sketch.getState().begin({ plane: 'XY', tool: 'line' }));
  await click([0, 0]);
  await click([40.2, 0.1]); // horizontal inferred
  await click([40.1, 10]); // vertical inferred (aligned with the previous point)
  await click([10, 10.1]); // horizontal
  await click([10.05, 30]); // vertical
  await click([0.1, 30.1]); // horizontal
  await click([0.02, 0.03]); // snaps to the start point: closes the loop and ends the chain
}

void test('line tool: an L-shaped polyline with inferred horizontal/vertical constraints closes itself', async () => {
  await reset();
  await drawL();
  const s = session();
  assert.equal(s.problem, null);
  const lines = s.sketch.entities.filter((e) => e.kind === 'line');
  assert.equal(lines.length, 6);
  assert.equal(
    s.sketch.entities.filter((e) => e.kind === 'point').length,
    6,
    'consecutive segments share points',
  );
  const kinds = s.sketch.constraints.map((c) => c.kind).sort();
  // The first click snapped to the sketch origin: that point is coincident with it.
  assert.deepEqual(kinds, [
    'coincident',
    'horizontal',
    'horizontal',
    'horizontal',
    'vertical',
    'vertical',
    'vertical',
  ]);
  assert.equal(
    s.tool.kind === 'line' && s.tool.lastPointId,
    null,
    'the chain ended at the start point',
  );
  const regions = detectRegions(s.sketch);
  assert.equal(regions.length, 1);
  // Inferred constraints made the sloppy clicks exact.
  assert.ok(Math.abs(regions[0]!.area - (40 * 10 + 10 * 20)) < 5, `area ${regions[0]!.area}`);
  assert.equal(s.dof, 4, 'anchored at the origin; four lengths remain free (under-constrained)');
  assert.equal(s.past.length, 6, 'one session undo step per segment');
});

void test('dimension tool + value chip, over-constraint rejection keeps the last valid sketch', async () => {
  await reset();
  await drawL();
  const bottom = session().sketch.entities.find((e) => e.kind === 'line')!;
  sketch.getState().setTool('dimension');
  const map = entityMap(session().sketch);
  const mid = (id: string): Vec2 => {
    const l = map.get(id)!;
    assert.equal(l.kind, 'line');
    const a = pointPos(map, l.kind === 'line' ? l.a : '')!;
    const b = pointPos(map, l.kind === 'line' ? l.b : '')!;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  await click(mid(bottom.id)); // pick the bottom line
  await click([20, -8]); // place the label below it
  let s = session();
  assert.equal(s.sketch.dimensions.length, 1);
  const dimension = s.sketch.dimensions[0]!;
  assert.equal(dimension.kind, 'distance');
  assert.equal(dimension.name, 'd1');
  assert.equal(s.editDimensionId, dimension.id, 'the value chip opens');
  assert.ok(await sketch.getState().setDimension(dimension.id, '50'));
  s = session();
  assert.ok(Math.abs(detectRegions(s.sketch)[0]!.area - (50 * 10 + 10 * 20)) < 5);

  // The same length dimensioned twice is redundant: rejected, the last valid sketch stays.
  const before = s.sketch;
  await click(mid(bottom.id));
  await click([20, -16]);
  s = session();
  assert.equal(s.sketch, before);
  assert.match(s.problem?.message ?? '', /^Over-constrained — already determined/);

  // Invalid expressions are rejected too.
  assert.equal(await sketch.getState().setDimension(dimension.id, 'd7 * 2'), false);
  assert.match(session().problem?.message ?? '', /unknown name "d7"/);
  assert.equal(session().sketch, before);
});

void test('over-constrained edits are rejected with a clear message; the last valid state stays', async () => {
  await reset();
  await drawL();
  const lines = session().sketch.entities.filter((e) => e.kind === 'line');
  const bottom = lines[0]!; // (0,0)-(40,0)
  const top = lines[2]!; // (40,10)-(10,10)
  // Dimension both (40 and 30), then make them equal: a conflict.
  sketch.getState().setTool('dimension');
  await click([20, 0]);
  await click([20, -8]);
  await click([25, 10]);
  await click([25, 18]);
  const [d1, d2] = session().sketch.dimensions;
  assert.ok(d1 && Math.abs(d1.value - 40) < 0.5 && d2 && Math.abs(d2.value - 30) < 0.5);
  sketch.getState().setTool('select');
  const valid = session().sketch;
  sketch.getState().select([bottom.id, top.id]);
  assert.equal(
    await sketch.getState().applyConstraint('equal'),
    null,
    'equal is applicable to two lines',
  );
  const s = session();
  assert.equal(s.sketch, valid, 'the last valid sketch is kept');
  assert.ok(s.problem, 'a problem is reported');
  assert.match(s.problem.message, /^Over-constrained — these constraints conflict/);
  assert.ok(
    s.problem.ids.includes(d1.id) && s.problem.ids.includes(d2.id),
    `both lengths are highlighted: ${s.problem.ids.join()}`,
  );
  assert.ok(sketch.getState().escape(), 'Escape first dismisses the problem');
  assert.equal(session().problem, null);
});

void test('dragging an under-constrained point moves it through the solver; locked points stay', async () => {
  await reset();
  await drawL();
  const corner = session().sketch.entities.find(
    (e) => e.kind === 'point' && Math.abs(e.x - 40) < 1 && Math.abs(e.y - 10) < 1,
  )!;
  sketch.getState().beginDrag([corner.id]);
  sketch.getState().drag([[55, 12]]);
  sketch.getState().drag([[60, 15]]);
  await sketch.getState().endDrag();
  let moved = entityMap(session().sketch).get(corner.id)!;
  assert.ok(
    moved.kind === 'point' && Math.abs(moved.x - 60) < 1e-3 && Math.abs(moved.y - 15) < 1e-3,
  );
  // Horizontal/vertical constraints held: the neighbours followed.
  const rectangular = session().sketch.entities.filter(
    (e) => e.kind === 'point' && Math.abs(e.x - 60) < 1e-3,
  );
  assert.equal(rectangular.length, 2);

  sketch.getState().select([corner.id]);
  await sketch.getState().applyConstraint('fixed');
  sketch.getState().beginDrag([corner.id]);
  sketch.getState().drag([[80, 40]]);
  await sketch.getState().endDrag();
  moved = entityMap(session().sketch).get(corner.id)!;
  assert.ok(
    moved.kind === 'point' && Math.abs(moved.x - 60) < 1e-6,
    'a locked point does not move',
  );
});

void test('sketch -> extrude; a later dimension change re-evaluates the extrude (one undo step each)', async () => {
  await reset();
  await drawL();
  // Dimension the bottom length (d1) before leaving.
  const bottom = session().sketch.entities.find((e) => e.kind === 'line')!;
  sketch.getState().select([bottom.id]);
  sketch.getState().setTool('dimension');
  const map = entityMap(session().sketch);
  const b = map.get(bottom.id)!;
  const a: Vec2 = b.kind === 'line' ? pointPos(map, b.a)! : [0, 0];
  const c: Vec2 = b.kind === 'line' ? pointPos(map, b.b)! : [0, 0];
  await click([(a[0] + c[0]) / 2, (a[1] + c[1]) / 2]);
  await click([20, -8]);
  const dimensionId = session().sketch.dimensions[0]!.id;
  assert.ok(await sketch.getState().setDimension(dimensionId, '40'));
  await sketch.getState().finish();
  await store.getState().whenSettled();
  assert.equal(sketch.getState().session, null);
  const sketchFeature = store.getState().features.at(-1) as SketchFeature;
  assert.equal(sketchFeature.kind, 'sketch');
  assert.equal(store.getState().features.length, 1, 'the whole session is one feature');

  store.getState().beginExtrude({ kind: 'sketch', featureId: sketchFeature.id });
  store.getState().setDistance(5);
  store.getState().commit();
  await store.getState().whenSettled();
  const extrude = store.getState().features.at(-1) as ExtrudeFeature;
  assert.equal(extrude.kind, 'extrude');
  const volume = () => store.getState().evaluation.bodies[0]!.volume;
  assert.deepEqual(store.getState().evaluation.errors, {});
  assert.ok(Math.abs(volume() - (40 * 10 + 10 * 20) * 5) < 0.5, `volume ${volume()}`);

  // Change the dimension from the History panel path: re-solve, commit, re-evaluate.
  const count = store.getState().features.length;
  assert.equal(await setSketchDimension(sketchFeature.id, dimensionId, '70'), null);
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, count);
  assert.deepEqual(store.getState().evaluation.errors, {}, 'the extrude still finds its profile');
  assert.ok(Math.abs(volume() - (70 * 10 + 10 * 20) * 5) < 0.5, `volume ${volume()}`);
  const edited = store.getState().features.find((f) => f.id === sketchFeature.id) as SketchFeature;
  assert.equal(edited.dimensions[0]!.value, 70);

  // Expressions and invalid values.
  assert.match(
    (await setSketchDimension(sketchFeature.id, dimensionId, 'd9 + 1')) ?? '',
    /unknown name/,
  );
  assert.equal(await setSketchDimension(sketchFeature.id, dimensionId, '35 * 2 + 10'), null);
  await store.getState().whenSettled();
  assert.ok(Math.abs(volume() - (80 * 10 + 10 * 20) * 5) < 0.5);

  store.getState().undo();
  await store.getState().whenSettled();
  assert.ok(
    Math.abs(volume() - (70 * 10 + 10 * 20) * 5) < 0.5,
    'a dimension edit is one undo step',
  );
});

void test('editing an existing sketch: changes commit as one undo step; unchanged sessions add none', async () => {
  await reset();
  await drawL();
  await sketch.getState().finish();
  await store.getState().whenSettled();
  const id = store.getState().features[0]!.id;
  assert.equal(store.getState().history.canUndo, true);

  assert.ok(sketch.getState().begin({ featureId: id }));
  assert.equal(session().tool.kind, 'select');
  await sketch.getState().finish();
  assert.equal(store.getState().features.length, 1);

  const before = store.getState().features;
  assert.ok(sketch.getState().begin({ featureId: id }));
  sketch.getState().setTool('circle');
  await click([5, 20]);
  await click([7, 20]);
  await sketch.getState().finish();
  await store.getState().whenSettled();
  const edited = store.getState().features[0] as SketchFeature;
  assert.equal(edited.entities.filter((e) => e.kind === 'circle').length, 1);
  // The circle inside the L is a hole of the L region plus its own disk region.
  assert.equal(store.getState().evaluation.sketches[0]!.profiles.length, 2);
  store.getState().undo();
  assert.equal(store.getState().features, before);
});

void test('re-entering a sketch: the constraint state is unknown until the analysis reports (never "fully constrained" early)', async () => {
  await reset();
  await drawL();
  await sketch.getState().finish();
  await store.getState().whenSettled();
  const id = store.getState().features[0]!.id;

  assert.ok(sketch.getState().begin({ featureId: id }));
  // Synchronously after entry the asynchronous analysis has not reported yet.
  assert.equal(session().dof, null, 'no analysis result yet');
  await sketch.getState().whenIdle();
  assert.equal(session().dof, 4, 'the L keeps four free lengths');
  await sketch.getState().finish();

  // A new, empty sketch needs no analysis.
  assert.ok(sketch.getState().begin({ plane: 'XY', tool: 'line' }));
  assert.equal(session().dof, 0);
  sketch.getState().discard();
});
