/**
 * Advanced sketch mode end to end (real planeGCS solver, real OCCT kernel,
 * the app's stores): a region with a hole drawn with the tools and
 * extruded, the "Add as reference" offer for determined dimensions,
 * reference toggling, label moves as undo steps, text placement/editing,
 * associative projection (source moves → projected geometry follows;
 * source deleted → frozen with a warning) and the geometric re-binding of a
 * profile whose boundary was redrawn completely.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtrudeFeature, Feature, SketchFeature } from '../../renderer/src/model/document.js';
import { useAssemblerStore } from '../../renderer/src/model/store.js';
import { addRectangle } from '../../renderer/src/sketch/builders.js';
import { setSketchDimension } from '../../renderer/src/sketch/featureOps.js';
import { hitTest, infer } from '../../renderer/src/sketch/inference.js';
import { detectRegions } from '../../renderer/src/sketch/regions.js';
import { useSketchStore } from '../../renderer/src/sketch/session.js';
import { setSketchSolverFactory } from '../../renderer/src/sketch/solverProvider.js';
import { segmentStart } from '../../renderer/src/sketch/tools.js';
import { EMPTY_SKETCH, type Vec2 } from '../../renderer/src/sketch/types.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { installNodeFonts } from './nodeFont.js';
import { loadNodeSolver } from './nodeSolver.js';

const store = useAssemblerStore;
const sketch = useSketchStore;
store.getState().attachKernel(createNodeKernelAdapter());
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));
installNodeFonts();

const MM_PER_PX = 0.1;

function session() {
  const s = sketch.getState().session;
  assert.ok(s, 'a sketch session is open');
  return s;
}

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

async function reset(features: Feature[] = []): Promise<void> {
  if (sketch.getState().session) sketch.getState().discard();
  store.getState().loadDocument(features);
  await store.getState().whenSettled();
}

function close(a: number, b: number, tol: number, what = ''): void {
  assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≈ ${b} (±${tol})`);
}

void test('UI path: a rectangle with a circle drawn by the tools extrudes as a plate with a hole', async () => {
  await reset();
  assert.ok(sketch.getState().begin({ plane: 'XY', tool: 'rectangle' }));
  await click([0, 0]);
  await click([30, 20]);
  sketch.getState().setTool('circle');
  await click([15, 10]);
  await click([18, 10]);
  await sketch.getState().finish();
  await store.getState().whenSettled();
  const s = store.getState().features[0] as SketchFeature;
  const ring = detectRegions(s).find((r) => r.holes.length === 1)!;
  store.getState().beginExtrude({ kind: 'sketch', featureId: s.id, regions: [ring.key] });
  store.getState().setDistance(4);
  store.getState().commit();
  await store.getState().whenSettled();
  const body = store.getState().evaluation.bodies[0]!;
  assert.deepEqual(store.getState().evaluation.errors, {});
  assert.equal(body.valid, true);
  close(body.volume, (600 - Math.PI * 9) * 4, 1e-6, 'plate volume');
});

void test('a determined dimension is offered as a reference; references follow and can be toggled', async () => {
  await reset();
  assert.ok(sketch.getState().begin({ plane: 'XY', tool: 'rectangle' }));
  await click([0, 0]);
  await click([30, 20]);
  sketch.getState().setTool('dimension');
  await click([15, 0]); // bottom line
  await click([15, -6]);
  const width = session().sketch.dimensions[0]!;
  assert.ok(await sketch.getState().setDimension(width.id, '30'));
  // The top line has the same length (horizontal/vertical rectangle constraints + width): determined.
  sketch.getState().setTool('dimension');
  await click([15, 20]);
  await click([15, 26]);
  const problem = session().problem;
  assert.ok(problem?.offer, 'the banner offers a way out');
  assert.equal(problem.offer.label, 'Add as reference');
  const past = session().past.length;
  assert.ok(await sketch.getState().acceptOffer());
  let s = session();
  assert.equal(s.problem, null);
  assert.equal(s.past.length, past + 1, 'one undo step');
  const reference = s.sketch.dimensions.find((d) => d.driven)!;
  assert.ok(reference, 'added as a reference dimension');
  close(reference.value, 30, 1e-9);
  // It follows the driving width.
  assert.ok(await sketch.getState().setDimension(width.id, '42'));
  close(session().sketch.dimensions.find((d) => d.id === reference.id)!.value, 42, 1e-6, 'follows');
  // A reference cannot be set.
  assert.equal(await sketch.getState().setDimension(reference.id, '10'), true, 'ignored value');
  close(session().sketch.dimensions.find((d) => d.id === reference.id)!.value, 42, 1e-6);
  // The width can become a reference (the rectangle loses that constraint).
  const dof = session().dof;
  assert.ok(await sketch.getState().toggleReference(width.id));
  s = session();
  assert.equal(s.sketch.dimensions.find((d) => d.id === width.id)!.driven, true);
  assert.equal(s.dof, dof + 1);
  // Moving a label is one undo step and only changes the layout.
  const before = s.past.length;
  assert.ok(await sketch.getState().moveDimensionLabel(width.id, { offset: -12, along: 0.2 }));
  const moved = session().sketch.dimensions.find((d) => d.id === width.id)!;
  assert.equal(moved.offset, -12);
  assert.equal(moved.along, 0.2);
  assert.equal(session().past.length, before + 1);
  sketch.getState().undo();
  await sketch.getState().whenIdle();
  assert.equal(session().sketch.dimensions.find((d) => d.id === width.id)!.along, undefined);
});

void test('text tool: place, edit in place; glyph regions keyed by the text entity', async () => {
  await reset();
  assert.ok(sketch.getState().begin({ plane: 'XY', tool: 'text' }));
  await click([5, 5]);
  sketch.getState().setToolOption({ text: 'Hi', height: 8 });
  assert.ok(await sketch.getState().commitText());
  let s = session();
  const text = s.sketch.entities.find((e) => e.kind === 'text')!;
  assert.ok(text?.kind === 'text');
  assert.equal(text.text, 'Hi');
  assert.equal(text.height, 8);
  const keys = detectRegions(s.sketch).map((r) => r.key);
  assert.equal(keys.length, 3, 'H + the stem and dot of i');
  for (const key of keys) assert.match(key, new RegExp(`^${text.id}\\.\\d+$`));
  // Edit: same entity and anchor, new content.
  sketch.getState().editText(text.id);
  sketch.getState().setToolOption({ text: 'HO', angle: 90 });
  assert.ok(await sketch.getState().commitText());
  s = session();
  const edited = s.sketch.entities.find((e) => e.id === text.id)!;
  assert.ok(edited.kind === 'text' && edited.text === 'HO' && edited.angle === 90);
  assert.equal(edited.anchor, text.anchor);
  assert.equal(detectRegions(s.sketch).length, 2);
});

/** A 10 × 10 × 5 box whose width is dimension d3 of sketch `s1`. */
function boxDocument(): Feature[] {
  const s1: SketchFeature = {
    id: 's1',
    name: 'Sketch 1',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    ...addRectangle(EMPTY_SKETCH, [0, 0], [10, 10], { size: true, position: true }).sketch,
  };
  const x1: ExtrudeFeature = {
    id: 'x1',
    name: 'Extrude 1',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: 's1' },
    distance: 5,
    symmetric: false,
    operation: 'new',
  };
  return [s1, x1];
}

void test('project: a face outline follows its source; a lost source keeps the geometry frozen with a warning', async () => {
  await reset(boxDocument());
  assert.ok(sketch.getState().begin({ plane: 'XY', tool: 'project' }));
  // A sketch on XY (the box's bottom), projecting the box's top face along the normal.
  const bodyId = store.getState().evaluation.bodies[0]!.id;
  assert.equal(
    await sketch.getState().projectItem({ kind: 'face', bodyId, key: 'x1:end:0' }),
    null,
  );
  const s = session();
  assert.equal(s.sketch.projections?.length, 1);
  const lines = s.sketch.entities.filter((e) => e.kind === 'line');
  assert.equal(lines.length, 4);
  assert.ok(
    lines.every((l) => l.construction),
    'construction by default',
  );
  // Projected geometry is fixed for the solver.
  assert.equal(s.dof, 0);
  assert.equal(
    await sketch.getState().projectItem({ kind: 'face', bodyId, key: 'x1:end:0' }),
    'That geometry is already projected into this sketch.',
  );
  // Make it profile geometry (toggle construction) and finish.
  sketch.getState().select(lines.map((l) => l.id));
  await sketch.getState().toggleConstructionOfSelection();
  await sketch.getState().finish();
  await store.getState().whenSettled();
  const s2 = store.getState().features.at(-1) as SketchFeature;
  const profileArea = () =>
    store.getState().evaluation.sketches.find((e) => e.featureId === s2.id)!.profiles[0]!.area;
  close(profileArea(), 100, 1e-6);
  // The source grows: the projection follows on re-evaluation (associative).
  const width = (store.getState().features[0] as SketchFeature).dimensions.find(
    (d) => d.name === 'd3',
  )!;
  assert.equal(await setSketchDimension('s1', width.id, 16), null);
  await store.getState().whenSettled();
  close(profileArea(), 160, 1e-6, 'follows the source');
  const evaluated = store.getState().evaluation.sketches.find((e) => e.featureId === s2.id)!;
  assert.deepEqual(
    evaluated.projections?.map((p) => p.status),
    ['ok'],
  );
  assert.ok(evaluated.projectedEntities, 'moved entities are reported for sketch mode');
  // Opening the sketch adopts the moved geometry (one session step).
  assert.ok(sketch.getState().begin({ featureId: s2.id }));
  await sketch.getState().whenIdle();
  const adopted = session().sketch;
  const xs = adopted.entities
    .filter((e) => e.kind === 'point')
    .map((e) => (e.kind === 'point' ? e.x : 0));
  close(Math.max(...xs), 16, 1e-6, 'adopted');
  await sketch.getState().finish();
  await store.getState().whenSettled();
  // Delete the source extrude: the projection is frozen, the profile stays, a warning names it.
  store.getState().loadDocument(store.getState().features.filter((f) => f.id !== 'x1'));
  await store.getState().whenSettled();
  const frozen = store.getState().evaluation.sketches.find((e) => e.featureId === s2.id)!;
  assert.equal(frozen.projections?.[0]?.status, 'frozen');
  assert.match(store.getState().evaluation.warnings[s2.id] ?? '', /kept as it was/);
  close(profileArea(), 160, 1e-6, 'frozen geometry kept');
});

void test('a profile whose boundary was redrawn completely re-binds by its recorded geometry', async () => {
  // Two rectangles; the extrude uses the first. Its four lines are then deleted and redrawn.
  let data = addRectangle(EMPTY_SKETCH, [0, 0], [20, 10]).sketch;
  const second = addRectangle(data, [30, 0], [40, 10]);
  data = second.sketch;
  const keyA = detectRegions(data).find((r) => r.sample[0] < 25)!.key;
  const s1: SketchFeature = {
    id: 's1',
    name: 'Sketch 1',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    ...data,
  };
  const x1: ExtrudeFeature = {
    id: 'x1',
    name: 'Extrude 1',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: 's1', regions: [keyA] },
    distance: 3,
    symmetric: false,
    operation: 'new',
  };
  await reset([s1, x1]);
  // A session commit records the fingerprints (an unchanged session does not commit: touch it).
  assert.ok(sketch.getState().begin({ featureId: 's1' }));
  const aLines = session()
    .sketch.entities.filter((e) => e.kind === 'line')
    .slice(0, 4)
    .map((e) => e.id);
  sketch.getState().select(aLines);
  await sketch.getState().deleteSelection();
  sketch.getState().setTool('rectangle');
  await click([0, 0]);
  await click([20, 10]);
  await sketch.getState().finish();
  await store.getState().whenSettled();
  // Without memory this would be "Missing reference" (two free profiles, no surviving edge).
  assert.deepEqual(store.getState().evaluation.errors, {});
  assert.match(store.getState().evaluation.warnings.x1 ?? '', /re-bound by geometry/);
  close(store.getState().evaluation.bodies[0]!.volume, 600, 1e-6);
});
