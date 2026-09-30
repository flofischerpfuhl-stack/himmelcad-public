/**
 * Interactive modelling tools on the real OCCT kernel: fillet/chamfer,
 * shell, circle sketch -> extrude (automatic New/Join/Cut), booleans —
 * preview without touching the document, cancel restores exactly, one undo
 * step per Done, kernel errors surface in the tool without breaking it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { KernelAdapter } from '../../renderer/src/foundation/geometry-kernel/adapter.js';
import type { EvaluationRequest } from '../../renderer/src/foundation/geometry-kernel/types.js';
import { findCommand, resolveAdaptive } from '../../renderer/src/foundation/commands/registry.js';
import {
  type ExtrudeFeature,
  type Feature,
} from '../../renderer/src/foundation/document/document.js';
import { createDemoDocument } from '../../renderer/src/foundation/commands/demoDocument.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import {
  PREVIEW_FEATURE_ID,
  useAssemblerStore,
  type ToolSession,
} from '../../renderer/src/foundation/commands/store.js';
import { addRectangle } from '../../renderer/src/foundation/sketch-solver/builders.js';
import { useSketchStore } from '../../renderer/src/sketch/session.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { EMPTY_SKETCH, type Vec2 } from '../../renderer/src/foundation/sketch-solver/types.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';

const store = useAssemblerStore;
const requests: EvaluationRequest[] = [];

/** Delegating adapter that records every request (to observe preview throttling). */
function recording(inner: KernelAdapter): KernelAdapter {
  return new Proxy(inner, {
    get(target, property) {
      if (property === 'evaluate') {
        return (request: EvaluationRequest) => {
          requests.push(request);
          return target.evaluate(request);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

store.getState().attachKernel(recording(createNodeKernelAdapter()));
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));

function box(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  depth: number,
  z = 0,
): Feature[] {
  const sketch: SketchFeature = {
    id: `${id}-sketch`,
    name: `${id} sketch`,
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: z },
    ...addRectangle(EMPTY_SKETCH, [x, y], [x + width, y + height], { position: true, size: true })
      .sketch,
  };
  const extrude: ExtrudeFeature = {
    id: `${id}-extrude`,
    name: `${id} extrude`,
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketch.id },
    distance: depth,
    symmetric: false,
    operation: 'new',
  };
  return [sketch, extrude];
}

async function load(features: Feature[]) {
  store.getState().loadDocument(features);
  await store.getState().whenSettled();
  assert.deepEqual(store.getState().evaluation.errors, {});
}

function tool<K extends ToolSession['kind']>(kind: K): Extract<ToolSession, { kind: K }> {
  const active = store.getState().activeTool;
  assert.equal(active?.kind, kind);
  return active as Extract<ToolSession, { kind: K }>;
}

function bodyVolume(index = 0): number {
  return store.getState().evaluation.bodies[index]!.volume;
}

function topFace(bodyIndex = 0) {
  const body = store.getState().evaluation.bodies[bodyIndex]!;
  const face = body.faces
    .filter((f) => f.surface === 'plane' && f.normal?.[2] === 1)
    .sort((a, b) => b.centroid[2] - a.centroid[2])[0]!;
  return { bodyId: body.id, faceKey: face.key };
}

/** The demo's upright top-back edge (y = 50, z = 46): 8 mm deep, safe for small blends. */
function uprightTopEdge() {
  const body = store.getState().evaluation.bodies[0]!;
  const edge = body.edges.find(
    (e) =>
      e.curve === 'line' &&
      Math.abs(e.midpoint[2] - 46) < 1e-6 &&
      Math.abs(e.midpoint[1] - 50) < 1e-6,
  )!;
  return { kind: 'edge' as const, bodyId: body.id, edgeKey: edge.key };
}

void test('fillet tool: live preview, document untouched, cancel restores exactly', async () => {
  await load(createDemoDocument());
  const before = store.getState().features;
  const volumeBefore = bodyVolume();
  store.getState().select(uprightTopEdge());
  const selectionBefore = store.getState().selection;

  findCommand('tools.filletChamfer')!.run(store.getState());
  assert.equal(tool('edgeBlend').blend, 'fillet');
  assert.equal(tool('edgeBlend').previewPending, true);
  await store.getState().whenSettled();

  let preview = tool('edgeBlend').previewEvaluation;
  assert.ok(preview, 'first preview arrives without any drag');
  assert.ok(preview.bodies[0]!.faces.some((f) => f.key === `${PREVIEW_FEATURE_ID}:round:0`));
  const r = 1;
  assert.ok(
    Math.abs(preview.bodies[0]!.volume - (volumeBefore - (r * r - (Math.PI * r * r) / 4) * 80)) <
      0.01,
  );

  store.getState().setBlendSize(3);
  await store.getState().whenSettled();
  preview = tool('edgeBlend').previewEvaluation!;
  assert.ok(
    Math.abs(preview.bodies[0]!.volume - (volumeBefore - (9 - (Math.PI * 9) / 4) * 80)) < 0.01,
  );
  assert.equal(store.getState().features, before, 'preview never touches the document');
  assert.equal(store.getState().history.canUndo, false);

  store.getState().cancel();
  assert.equal(store.getState().activeTool, null);
  assert.equal(store.getState().features, before);
  assert.equal(store.getState().selection, selectionBefore);
  assert.equal(store.getState().history.canUndo, false);
  assert.equal(bodyVolume(), volumeBefore);
});

void test('fillet tool: Fillet<->Chamfer toggle; Done is exactly one undo step', async () => {
  await load(createDemoDocument());
  const count = store.getState().features.length;
  const volumeBefore = bodyVolume();
  store.getState().select(uprightTopEdge());
  store.getState().beginEdgeBlend('fillet');
  store.getState().setBlendKind('chamfer');
  store.getState().setBlendSize(2);
  await store.getState().whenSettled();
  const preview = tool('edgeBlend').previewEvaluation!;
  assert.ok(Math.abs(preview.bodies[0]!.volume - (volumeBefore - 0.5 * 2 * 2 * 80)) < 0.01);

  store.getState().commit();
  assert.equal(store.getState().activeTool, null);
  await store.getState().whenSettled();
  const added = store.getState().features.at(-1)!;
  assert.equal(store.getState().features.length, count + 1);
  assert.equal(added.kind, 'chamfer');
  assert.equal(added.kind === 'chamfer' ? added.distance : 0, 2);
  assert.equal(added.name, 'Chamfer 1');
  assert.equal(store.getState().evaluation.errors[added.id], undefined);
  assert.ok(Math.abs(bodyVolume() - (volumeBefore - 160)) < 0.01);

  store.getState().undo();
  assert.equal(store.getState().features.length, count);
  assert.equal(store.getState().history.canUndo, false);
  assert.ok(Math.abs(bodyVolume() - volumeBefore) < 1e-6);
});

void test('fillet tool: an invalid radius keeps the last valid preview, shows the error and blocks Done', async () => {
  await load(createDemoDocument());
  store.getState().select(uprightTopEdge());
  store.getState().beginEdgeBlend('fillet');
  await store.getState().whenSettled();
  const valid = tool('edgeBlend').previewEvaluation;
  assert.ok(valid);

  store.getState().setBlendSize(30); // far larger than the 8 mm upright
  await store.getState().whenSettled();
  const failing = tool('edgeBlend');
  assert.ok(failing.previewError, 'kernel error reported');
  assert.equal(failing.previewEvaluation, valid, 'last valid preview kept');

  const count = store.getState().features.length;
  store.getState().commit();
  assert.equal(store.getState().activeTool?.kind, 'edgeBlend', 'Done is blocked while invalid');
  assert.equal(store.getState().features.length, count);

  store.getState().setBlendSize(2);
  await store.getState().whenSettled();
  assert.equal(tool('edgeBlend').previewError, null);
  assert.notEqual(tool('edgeBlend').previewEvaluation, valid);
  store.getState().cancel();
});

void test('preview requests are throttled: a burst of edits posts at most two evaluations', async () => {
  await load(createDemoDocument());
  store.getState().select(uprightTopEdge());
  store.getState().beginEdgeBlend('fillet');
  await store.getState().whenSettled();
  requests.length = 0;
  for (const size of [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2]) {
    store.getState().setBlendSize(size);
  }
  await store.getState().whenSettled();
  const previews = requests.filter((r) => r.channel === 'preview');
  assert.ok(previews.length <= 2, `posted ${previews.length} previews`);
  const last = previews.at(-1)!.features.at(-1)!;
  assert.equal(last.kind === 'fillet' ? last.radius : 0, 2, 'the newest parameters win');
  const shown = tool('edgeBlend').previewEvaluation!;
  const volume = store.getState().evaluation.bodies[0]!.volume;
  assert.ok(Math.abs(shown.bodies[0]!.volume - (volume - (4 - Math.PI) * 80)) < 0.01);
  store.getState().cancel();
});

void test('shell tool: removes the selected face, walls inward, preview then one undo step', async () => {
  await load(box('a', 0, 0, 40, 30, 20));
  const count = store.getState().features.length;
  store.getState().select({ kind: 'face', ...topFace() });
  findCommand('tools.shell')!.run(store.getState());
  assert.equal(tool('shell').thickness, 1);
  store.getState().setShellThickness(2);
  await store.getState().whenSettled();
  const inner = 36 * 26 * 18;
  const preview = tool('shell').previewEvaluation!;
  assert.ok(Math.abs(preview.bodies[0]!.volume - (40 * 30 * 20 - inner)) < 0.01);
  assert.equal(preview.bodies[0]!.max[2], 20, 'walls grow inwards: outer size unchanged');
  assert.equal(store.getState().features.length, count);

  store.getState().commit();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, count + 1);
  assert.equal(store.getState().features.at(-1)!.kind, 'shell');
  assert.ok(Math.abs(bodyVolume() - (40 * 30 * 20 - inner)) < 0.01);
  store.getState().undo();
  assert.equal(store.getState().features.length, count);
  // The kernel sums per-face volume contributions (cached across edits): equal up to rounding.
  assert.ok(Math.abs(bodyVolume() - 40 * 30 * 20) < 1e-6);
});

/** A plain click at sketch position `pos` (no snapping) for the active sketch tool. */
function click(pos: Vec2): Promise<void> {
  return useSketchStore
    .getState()
    .dispatch({ type: 'click', snap: { pos, hints: [], guides: [] }, hit: null, raw: pos });
}

/** Draws a circle in a new sketch (on a face or the XY plane) and finishes it; returns the sketch id. */
async function circleSketch(
  face: { bodyId: string; faceKey: string } | null,
  c: Vec2,
  r: number,
): Promise<string> {
  assert.ok(
    useSketchStore.getState().begin({ ...(face ? { face } : { plane: 'XY' }), tool: 'circle' }),
  );
  await click(c);
  await click([c[0] + r, c[1]]);
  await useSketchStore.getState().finish();
  await store.getState().whenSettled();
  return store.getState().features.at(-1)!.id;
}

void test('circle tool (sketch mode): centre + radius on a face; Escape layers; finishing selects the profile', async () => {
  await load(box('a', 0, 0, 40, 30, 10));
  store.getState().select({ kind: 'face', ...topFace() });
  findCommand('sketch.circle')!.run(store.getState());
  const session = () => useSketchStore.getState().session!;
  assert.equal(session().plane.kind, 'face');
  assert.equal(session().frame.origin[2], 10);
  assert.equal(session().tool.kind, 'circle');

  await click([20, 15]);
  assert.deepEqual(session().tool.kind === 'circle' && session().tool, {
    kind: 'circle',
    center: { pos: [20, 15], hints: [], guides: [] },
  });
  // First Escape cancels the placed centre and the tool, the second leaves the (empty) sketch.
  assert.ok(useSketchStore.getState().escape());
  assert.equal(session().tool.kind, 'select');
  assert.ok(useSketchStore.getState().escape());
  await useSketchStore.getState().whenIdle();
  assert.equal(useSketchStore.getState().session, null);
  assert.equal(store.getState().features.length, 2, 'an empty sketch adds nothing');

  // A new sketch on XY moves to the first clicked face while it is empty.
  assert.ok(useSketchStore.getState().begin({ tool: 'circle' }));
  assert.equal(session().plane.kind, 'plane');
  assert.ok(useSketchStore.getState().rebaseOnFace(topFace().bodyId, topFace().faceKey));
  await click([20, 15]);
  await click([24, 15]);
  // Undo/Redo act step by step inside the session while it is open.
  assert.equal(store.getState().history.canUndo, true);
  store.getState().undo();
  await useSketchStore.getState().whenIdle();
  assert.equal(session().sketch.entities.length, 0);
  assert.equal(store.getState().features.length, 2, 'the document is untouched');
  store.getState().redo();
  await useSketchStore.getState().whenIdle();
  assert.equal(session().sketch.entities.length, 2);
  await useSketchStore.getState().finish();
  await store.getState().whenSettled();
  const sketch = store.getState().features.at(-1)!;
  assert.equal(sketch.kind, 'sketch');
  if (sketch.kind !== 'sketch') return;
  assert.equal(sketch.plane.kind, 'face');
  const circle = sketch.entities.find((e) => e.kind === 'circle');
  assert.equal(circle?.kind === 'circle' && circle.radius, 4);
  assert.deepEqual(store.getState().selection, [{ kind: 'sketchProfile', featureId: sketch.id }]);
  assert.equal(
    store.getState().evaluation.sketches.find((s) => s.featureId === sketch.id)?.profiles.length,
    1,
  );
  assert.equal(store.getState().history.canUndo, true);
  store.getState().undo();
  assert.equal(store.getState().features.length, 2, 'the whole sketch session is one undo step');
});

void test('circle -> extrude: into the body cuts a hole, outward joins, free-standing makes a new body', async () => {
  await load(box('a', 0, 0, 40, 30, 10));
  const volume = 40 * 30 * 10;
  const sketchId = await circleSketch(topFace(), [20, 15], 3);

  findCommand('tools.extrude')!.run(store.getState());
  assert.equal(tool('extrude').operation, 'cut', 'inside a face: starts as a through-cut');
  assert.equal(tool('extrude').distance, -10);
  store.getState().setDistance(5);
  assert.equal(tool('extrude').operation, 'join', 'out of the face');
  store.getState().setDistance(-10);
  assert.equal(tool('extrude').operation, 'cut', 'into the body');
  await store.getState().whenSettled();
  const hole = tool('extrude').previewEvaluation!.bodies[0]!;
  assert.ok(Math.abs(hole.volume - (volume - Math.PI * 9 * 10)) < 0.01);
  store.getState().commit();
  await store.getState().whenSettled();
  assert.ok(Math.abs(bodyVolume() - (volume - Math.PI * 9 * 10)) < 0.01);
  assert.equal(store.getState().evaluation.bodies.length, 1);
  store.getState().undo();

  // The override locks the operation.
  store.getState().beginExtrude({ kind: 'sketch', featureId: sketchId });
  store.getState().setExtrudeOperation('new');
  store.getState().setDistance(-4);
  assert.equal(tool('extrude').operation, 'new');
  store.getState().cancel();

  // A circle on the XY plane under the body touches its bottom face: +Z goes into it.
  const under = await circleSketch(null, [10, 10], 2);
  store.getState().beginExtrude({ kind: 'sketch', featureId: under });
  store.getState().setDistance(4);
  assert.equal(tool('extrude').operation, 'cut');
  store.getState().setDistance(-4);
  assert.equal(tool('extrude').operation, 'join');
  store.getState().cancel();

  // Free-standing circle away from any body: New.
  const free = await circleSketch(null, [100, 100], 5);
  store.getState().beginExtrude({ kind: 'sketch', featureId: free });
  store.getState().setDistance(8);
  assert.equal(tool('extrude').operation, 'new');
  store.getState().commit();
  await store.getState().whenSettled();
  assert.equal(store.getState().evaluation.bodies.length, 2);
});

void test('boolean tool: first selected body is the target; operation switch; Done is one step; cancel restores', async () => {
  await load([...box('a', 0, 0, 20, 20, 20), ...box('b', 10, 10, 20, 20, 20)]);
  const [a, b] = store.getState().evaluation.bodies;
  const count = store.getState().features.length;
  store.getState().select({ kind: 'body', bodyId: a!.id });
  store.getState().select({ kind: 'body', bodyId: b!.id }, { additive: true });

  findCommand('tools.subtract')!.run(store.getState());
  assert.equal(tool('boolean').targetBodyId, a!.id);
  await store.getState().whenSettled();
  let preview = tool('boolean').previewEvaluation!;
  assert.equal(preview.bodies.length, 1);
  // Overlap: 10 x 10 x 20 = 2000 mm^3.
  assert.ok(Math.abs(preview.bodies[0]!.volume - (8000 - 2000)) < 0.01);

  store.getState().setBooleanOperation('intersect');
  await store.getState().whenSettled();
  preview = tool('boolean').previewEvaluation!;
  assert.ok(Math.abs(preview.bodies[0]!.volume - 2000) < 0.01);

  store.getState().cancel();
  assert.equal(store.getState().evaluation.bodies.length, 2);
  assert.equal(store.getState().features.length, count);

  store.getState().beginBoolean('union');
  store.getState().commit();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, count + 1);
  assert.equal(store.getState().features.at(-1)!.name, 'Union 1');
  assert.equal(store.getState().evaluation.bodies.length, 1);
  assert.ok(Math.abs(bodyVolume() - (16000 - 2000)) < 0.01);
  store.getState().undo();
  assert.equal(store.getState().evaluation.bodies.length, 2);
});

void test('commands: Circle is offered on a planar face (New Sketch is the recommended one); section axis/flip need Section View on', async () => {
  await load(box('a', 0, 0, 40, 30, 10));
  const circle = findCommand('sketch.circle')!;
  assert.equal(circle.availability(store.getState()).enabled, true);
  assert.equal(circle.availability(store.getState()).priority ?? 0, 0);
  store.getState().select({ kind: 'face', ...topFace() });
  assert.ok((circle.availability(store.getState()).priority ?? 0) > 0);
  assert.equal(circle.availability(store.getState()).recommended ?? false, false);
  assert.equal(findCommand('sketch.new')!.availability(store.getState()).recommended, true);
  assert.ok(resolveAdaptive(store.getState()).some((c) => c.id === 'sketch.circle'));
  const flip = findCommand('modes.sectionFlip')!;
  assert.equal(flip.availability(store.getState()).enabled, false);
  store.getState().setSectionEnabled(true);
  assert.equal(flip.availability(store.getState()).enabled, true);
  flip.run(store.getState());
  assert.equal(store.getState().viewState.sectionFlipped, true);
  findCommand('modes.sectionAxisX')!.run(store.getState());
  assert.equal(store.getState().viewState.sectionOffset, 20);
  store.getState().setSectionFlipped(false);
  store.getState().setSectionEnabled(false);
  store.getState().setSectionAxis('Z');
});

void test('section view starts through the centre of the visible model along the chosen axis', async () => {
  await load(createDemoDocument());
  store.getState().setSectionEnabled(true);
  assert.equal(store.getState().viewState.sectionOffset, 23); // z 0..46
  store.getState().setSectionAxis('X');
  assert.equal(store.getState().viewState.sectionOffset, 40); // x 0..80
  store.getState().setSectionAxis('Y');
  assert.equal(store.getState().viewState.sectionOffset, 25); // y 0..50
  store.getState().setSectionOffset(12);
  store.getState().setSectionFlipped(true);
  assert.equal(store.getState().viewState.sectionOffset, 12);
  assert.equal(store.getState().viewState.sectionFlipped, true);
  store.getState().setSectionEnabled(false);
  store.getState().setSectionFlipped(false);
  store.getState().setSectionAxis('Z');
});
