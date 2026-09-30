/**
 * Shapr3D parity round 2 through the app's stores (real kernel and solver):
 * tool before selection (UI-16), Construct tools (MOD-30), History Fix…
 * (HIS-07) and the isolate filter (HIS-04), Extrude options (MOD-01/02),
 * Move/Rotate on faces and sketch profiles with an oriented gizmo (MOD-16),
 * Mirror of sketches (MOD-21), 3D snaps (SK-19), continuing the previous
 * sketch (SK-02), ends-then-bulge arcs (SK-04), three-point rectangles
 * (SK-07) and the First/Last-selected constraint rule (CON-04).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  opsAffine,
  transformOps,
} from '../../renderer/src/foundation/geometry-kernel/features/rigid.js';
import { continuableSketchId } from '../../renderer/src/model/commands/sketchCommands.js';
import { findCommand } from '../../renderer/src/foundation/commands/registry.js';
import { datumRef, type ConstructionPlaneFeature } from '../../renderer/src/model/construction.js';
import { createConstructionDraft } from '../../renderer/src/model/constructionTools.js';
import {
  createDemoDocument,
  type ExtrudeFeature,
  type Feature,
  type SketchFeature,
} from '../../renderer/src/foundation/document/document.js';
import { createDraft, draftMeta, draftToFeature } from '../../renderer/src/model/featureTools.js';
import {
  applyFixPick,
  missingReferences,
  startFix,
  useFixStore,
} from '../../renderer/src/interface/shell-ui/fixReference.js';
import {
  historyFilterItems,
  relevantFeatureIds,
} from '../../renderer/src/interface/shell-ui/historyTools.js';
import { gizmoOps, gizmoTransformFields } from '../../renderer/src/model/moveGizmo.js';
import { usePreferences } from '../../renderer/src/interface/shell-ui/preferences.js';
import { loadProjectFile, saveProjectFile } from '../../renderer/src/foundation/document/format.js';
import {
  makeFaceRef,
  moveSketchResult,
  useAssemblerStore,
  type MoveTool,
} from '../../renderer/src/foundation/commands/store.js';
import { bodySnapTargets } from '../../renderer/src/sketch/bodySnaps.js';
import { addRectangle, addPolyline } from '../../renderer/src/foundation/sketch-solver/builders.js';
import { infer } from '../../renderer/src/sketch/inference.js';
import { translateSketchRegion } from '../../renderer/src/foundation/sketch-solver/moveRegion.js';
import { detectRegions } from '../../renderer/src/foundation/sketch-solver/regions.js';
import { useSketchStore } from '../../renderer/src/sketch/session.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { initialTool, reduceTool } from '../../renderer/src/sketch/tools.js';
import {
  EMPTY_SKETCH,
  entityMap,
  pointPos,
  type Vec2,
} from '../../renderer/src/foundation/sketch-solver/types.js';
import { frameForPlane } from '../../renderer/src/foundation/document/document.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';

const store = useAssemblerStore;
store.getState().attachKernel(createNodeKernelAdapter());
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));

async function load(features: Feature[]): Promise<void> {
  store.getState().loadDocument(features);
  await store.getState().whenSettled();
}

function run(id: string): void {
  const command = findCommand(id);
  assert.ok(command, id);
  const availability = command.availability(store.getState());
  assert.ok(availability.enabled, `${id}: ${availability.reason ?? ''}`);
  command.run(store.getState());
}

function rectSketch(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  offset = 0,
): SketchFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset },
    ...addRectangle(EMPTY_SKETCH, [x, y], [x + w, y + h], { position: true, size: true }).sketch,
  };
}

function extrude(id: string, sketchId: string, distance: number): ExtrudeFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketchId },
    distance,
    symmetric: false,
    operation: 'new',
  };
}

const twoBoxes = (): Feature[] => [
  rectSketch('feature-sketch-1', 0, 0, 10, 10),
  extrude('feature-extrude-2', 'feature-sketch-1', 10),
  rectSketch('feature-sketch-3', 5, 0, 10, 10),
  extrude('feature-extrude-4', 'feature-sketch-3', 10),
];

// ---- UI-16: tool before selection ---------------------------------------------------------

void test('Extrude without a selection asks for the profile, then starts on it', async () => {
  await load(twoBoxes().slice(0, 1));
  store.getState().clearSelection();
  run('tools.extrude');
  let tool = store.getState().activeTool;
  assert.equal(tool?.kind, 'pick');
  // A body is not a profile: the pill explains, the step stays.
  const body = { kind: 'body' as const, bodyId: 'body:none' };
  store.getState().updatePickSession((s) => ({ ...s }));
  tool = store.getState().activeTool;
  assert.equal(tool?.kind, 'pick');
  const { addPick } = await import('../../renderer/src/foundation/commands/pickSession.js');
  store
    .getState()
    .updatePickSession((s) => addPick(s, body, { evaluation: store.getState().evaluation }));
  tool = store.getState().activeTool;
  assert.ok(tool?.kind === 'pick' && /sketch profile or a planar face/.test(tool.problem ?? ''));
  // The profile: the session finishes by itself and Extrude runs on it.
  store
    .getState()
    .updatePickSession((s) =>
      addPick(
        s,
        { kind: 'sketchProfile', featureId: 'feature-sketch-1' },
        { evaluation: store.getState().evaluation },
      ),
    );
  tool = store.getState().activeTool;
  assert.equal(tool?.kind, 'extrude');
  assert.ok(tool?.kind === 'extrude' && tool.profile.kind === 'sketch');
  store.getState().cancel();
});

void test('Union before selection: target, tools, Swap, then the boolean starts with those roles', async () => {
  await load(twoBoxes());
  const { addPick } = await import('../../renderer/src/foundation/commands/pickSession.js');
  store.getState().clearSelection();
  run('tools.union');
  const bodies = store.getState().evaluation.bodies.map((b) => b.id);
  assert.equal(bodies.length, 2);
  const [a, b] = bodies as [string, string];
  const face = (bodyId: string) => ({
    kind: 'face' as const,
    bodyId,
    faceKey: store.getState().evaluation.bodies.find((x) => x.id === bodyId)!.faces[0]!.key,
  });
  // A face stands for its body.
  store
    .getState()
    .updatePickSession((s) => addPick(s, face(a), { evaluation: store.getState().evaluation }));
  store
    .getState()
    .updatePickSession((s) => addPick(s, face(b), { evaluation: store.getState().evaluation }));
  let tool = store.getState().activeTool;
  assert.ok(tool?.kind === 'pick');
  assert.deepEqual(tool.picks, [[{ kind: 'body', bodyId: a }], [{ kind: 'body', bodyId: b }]]);
  const { swapPicks } = await import('../../renderer/src/foundation/commands/pickSession.js');
  store.getState().updatePickSession(swapPicks);
  tool = store.getState().activeTool;
  assert.ok(tool?.kind === 'pick');
  assert.deepEqual(tool.picks[0], [{ kind: 'body', bodyId: b }]);
  // Next (Done/Enter) on the last step starts the boolean.
  store.getState().commit();
  tool = store.getState().activeTool;
  assert.equal(tool?.kind, 'boolean');
  assert.ok(tool?.kind === 'boolean' && tool.targetBodyId === b && tool.toolBodyIds[0] === a);
  store.getState().cancel();
});

// ---- MOD-30: Construct ------------------------------------------------------------------------

void test('Construct › Offset Plane asks for a face, previews, commits one step; a sketch goes on it', async () => {
  await load(twoBoxes().slice(0, 2));
  const state = store.getState();
  const draft = createConstructionDraft('constructionPlane', 'offset', [], state.evaluation);
  assert.match(draftMeta(draft).prompt, /planar face or a construction plane/);
  assert.equal(draftToFeature(draft, { id: 'x', name: 'x' }), null);
  const body = state.evaluation.bodies[0]!;
  const top = body.faces.find((f) => f.normal?.[2] === 1)!;
  store.getState().setSelection([{ kind: 'face', bodyId: body.id, faceKey: top.key }]);
  run('construct.planeOffset');
  const tool = store.getState().activeTool;
  assert.ok(tool?.kind === 'feature' && tool.draft.kind === 'constructionPlane');
  const steps = store.getState().features.length;
  store.getState().commit();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, steps + 1);
  const plane = store.getState().features.at(-1) as ConstructionPlaneFeature;
  assert.equal(plane.kind, 'constructionPlane');
  const datum = store.getState().evaluation.datums?.find((d) => d.featureId === plane.id);
  assert.ok(datum, 'the plane is evaluated');
  assert.ok(Math.abs(datum.frame.origin[2] - 20) < 1e-9, 'offset 10 above the top face');
  // A selected plane: New Sketch goes on it.
  store.getState().setSelection([{ kind: 'datum', featureId: plane.id }]);
  run('sketch.new');
  const session = useSketchStore.getState().session;
  assert.equal(session?.plane.kind, 'construction');
  useSketchStore.getState().discard();
  // One undo step removes the plane.
  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, steps);
});

void test('Mirror takes sketches and a construction plane from the selection', async () => {
  await load([
    rectSketch('feature-sketch-1', 2, 0, 6, 4),
    {
      id: 'feature-constructionPlane-2',
      name: 'Plane 1',
      suppressed: false,
      kind: 'constructionPlane',
      definition: { kind: 'offset', base: { kind: 'plane', plane: 'YZ', offset: 0 }, distance: 0 },
    } as ConstructionPlaneFeature,
  ]);
  store.getState().setSelection([
    { kind: 'sketchProfile', featureId: 'feature-sketch-1' },
    { kind: 'datum', featureId: 'feature-constructionPlane-2' },
  ]);
  const start = createDraft('mirror', store.getState());
  assert.ok(start.ok);
  assert.ok(start.draft.kind === 'mirror');
  assert.deepEqual(start.draft.sketchIds, ['feature-sketch-1']);
  assert.equal(start.draft.plane.kind, 'construction');
});

// ---- HIS-07 Fix… / HIS-04 isolate filter ----------------------------------------------------

void test('Fix…: the ghost of a deleted construction plane is drawn where the plane was shown', async () => {
  await load(twoBoxes().slice(0, 2));
  const box = store.getState().evaluation.bodies[0]!;
  const top = box.faces.find((f) => f.normal?.[2] === 1)!;
  const plane: ConstructionPlaneFeature = {
    id: 'feature-constructionPlane-3',
    name: 'Plane 1',
    suppressed: false,
    kind: 'constructionPlane',
    definition: {
      kind: 'offset',
      base: { kind: 'face', face: makeFaceRef(store.getState().evaluation, box.id, top.key)! },
      distance: 10,
    },
  };
  await load([...twoBoxes().slice(0, 2), plane]);
  const datum = store.getState().evaluation.datums!.find((d) => d.featureId === plane.id)!;
  // Drawn over the top face's centre, 10 above it; the frame origin is (0, 0, 20).
  assert.deepEqual(datum.center, [5, 5, 20]);
  assert.deepEqual(datum.frame.origin, [0, 0, 20]);
  const ref = datumRef(store.getState().evaluation, plane.id);
  assert.ok(ref?.kind === 'construction' && 'frame' in ref);
  assert.deepEqual(ref.shown, { center: [5, 5, 20], size: datum.size });
  const sketch: SketchFeature = { ...rectSketch('feature-sketch-4', 2, 2, 3, 3), plane: ref };
  await load([...twoBoxes().slice(0, 2), plane, sketch]);
  store.getState().deleteFeature(plane.id);
  await store.getState().whenSettled();
  const [missing] = missingReferences(
    store.getState().features.find((f) => f.id === sketch.id)!,
    store.getState().evaluation,
    store.getState().features,
  );
  assert.ok(missing?.ghost?.kind === 'plane');
  assert.deepEqual(missing.ghost.center, [5, 5, 20], 'where it was shown, not the frame origin');
  assert.equal(missing.ghost.size, datum.size);
  assert.equal(
    store.getState().evaluation.errors[sketch.id],
    'Missing reference: construction plane of a deleted step',
  );
  // A Fix session belongs to this document: another document (even one reusing the step id)
  // or losing the step ends it.
  assert.equal(startFix(sketch.id), null);
  assert.ok(useFixStore.getState().session);
  await load([...twoBoxes().slice(0, 2), { ...sketch, name: 'Other document' }]);
  assert.equal(useFixStore.getState().session, null, 'a loaded document ends the session');
  await load([...twoBoxes().slice(0, 2), plane, sketch]);
  store.getState().deleteFeature(plane.id);
  await store.getState().whenSettled();
  assert.equal(startFix(sketch.id), null);
  store.getState().deleteFeature(sketch.id);
  assert.equal(useFixStore.getState().session, null, 'deleting the step ends the session');
  store.getState().undo();
  await store.getState().whenSettled();
  // The saved reference keeps where it was shown.
  const text = saveProjectFile({
    projectName: 'x',
    features: store.getState().features,
    appVersion: 'test',
    createdAt: '2026-09-30T00:00:00.000Z',
  });
  assert.deepEqual(loadProjectFile(text).features, store.getState().features);
});

void test('Fix…: a deleted construction plane is outlined; a picked face replaces it (one undo step)', async () => {
  const plane: ConstructionPlaneFeature = {
    id: 'feature-constructionPlane-3',
    name: 'Plane 1',
    suppressed: false,
    kind: 'constructionPlane',
    definition: { kind: 'offset', base: { kind: 'plane', plane: 'XY', offset: 0 }, distance: 10 },
  };
  const sketch: SketchFeature = {
    ...rectSketch('feature-sketch-4', 2, 2, 3, 3),
    plane: {
      kind: 'construction',
      featureId: plane.id,
      frame: frameForPlane('XY', 10),
    },
  };
  await load([
    ...twoBoxes().slice(0, 2),
    plane,
    sketch,
    extrude('feature-extrude-5', sketch.id, 2),
  ]);
  assert.deepEqual(store.getState().evaluation.errors, {});
  // Delete the plane: the sketch (and so the extrude) loses its reference.
  store.getState().deleteFeature(plane.id);
  await store.getState().whenSettled();
  assert.match(
    store.getState().evaluation.errors[sketch.id] ?? '',
    /Missing reference: construction plane/,
  );
  const missing = missingReferences(
    store.getState().features.find((f) => f.id === sketch.id)!,
    store.getState().evaluation,
    store.getState().features,
  );
  assert.equal(missing.length, 1);
  assert.deepEqual(missing[0]!.path, ['plane']);
  assert.equal(missing[0]!.ghost?.kind, 'plane', 'the last known plane is shown');
  assert.equal(startFix(sketch.id), null);
  assert.ok(useFixStore.getState().session);
  // A wrong pick explains; the top face (z = 10) fixes it.
  assert.equal(await applyFixPick({ kind: 'body', bodyId: 'body:feature-extrude-2' }), false);
  assert.match(useFixStore.getState().session?.problem ?? '', /plane or a planar face/);
  const body = store.getState().evaluation.bodies.find((b) => b.id === 'body:feature-extrude-2')!;
  const top = body.faces.find((f) => f.normal?.[2] === 1)!;
  const before = store.getState().features;
  assert.equal(await applyFixPick({ kind: 'face', bodyId: body.id, faceKey: top.key }), true);
  await store.getState().whenSettled();
  assert.equal(useFixStore.getState().session, null, 'nothing else is missing: the session ends');
  assert.deepEqual(store.getState().evaluation.errors, {});
  const fixed = store.getState().features.find((f) => f.id === sketch.id) as SketchFeature;
  assert.equal(fixed.plane.kind, 'face');
  store.getState().undo();
  assert.equal(store.getState().features, before);
});

void test('History filter: nothing selected + Isolate → the isolated bodies’ steps', async () => {
  await load(twoBoxes());
  assert.deepEqual(historyFilterItems([], ['body:feature-extrude-4']), [
    { kind: 'body', bodyId: 'body:feature-extrude-4' },
  ]);
  const items = historyFilterItems([], ['body:feature-extrude-4']);
  const ids = relevantFeatureIds(store.getState().features, store.getState().evaluation, items);
  assert.ok(ids.has('feature-extrude-4') && ids.has('feature-sketch-3'));
  assert.ok(!ids.has('feature-extrude-2'));
  // A selection wins over the isolated set.
  assert.deepEqual(historyFilterItems([{ kind: 'feature', featureId: 'x' }], ['b']), [
    { kind: 'feature', featureId: 'x' },
  ]);
});

// ---- MOD-01/02 in the tool --------------------------------------------------------------------

void test('Extrude tool: Through All, two sides and Intersect reach the committed step', async () => {
  await load([...twoBoxes().slice(0, 2), rectSketch('feature-sketch-5', 2, 2, 3, 3, 20)]);
  store.getState().beginExtrude({ kind: 'sketch', featureId: 'feature-sketch-5' });
  store.getState().setDistance(-5);
  store.getState().setExtrudeOperation('cut');
  store.getState().setExtrudeOptions({ extent: 'throughAll' });
  await store.getState().whenSettled();
  const tool = store.getState().activeTool;
  assert.ok(
    tool?.kind === 'extrude' && tool.previewError === null,
    `${tool?.kind === 'extrude' ? tool.previewError : ''}`,
  );
  store.getState().commit();
  await store.getState().whenSettled();
  const feature = store.getState().features.at(-1) as ExtrudeFeature;
  assert.deepEqual(feature.extent, { kind: 'throughAll' });
  const body = store.getState().evaluation.bodies[0]!;
  assert.ok(Math.abs(body.volume - (1000 - 90)) < 1e-6, `volume ${body.volume}`);
  // Two sides + Intersect.
  await load([...twoBoxes().slice(0, 2), rectSketch('feature-sketch-5', 2, 2, 3, 3, 5)]);
  store.getState().beginExtrude({ kind: 'sketch', featureId: 'feature-sketch-5' });
  store.getState().setDistance(2);
  store.getState().setExtrudeOperation('intersect');
  store.getState().setExtrudeOptions({ sides: 'two', distance2: 3 });
  await store.getState().whenSettled();
  store.getState().commit();
  await store.getState().whenSettled();
  const second = store.getState().features.at(-1) as ExtrudeFeature;
  assert.equal(second.operation, 'intersect');
  assert.equal(second.distance2, 3);
  assert.ok(Math.abs(store.getState().evaluation.bodies[0]!.volume - 45) < 1e-6);
});

// ---- MOD-16: Move/Rotate --------------------------------------------------------------------

void test('Move/Rotate: rotations about an oriented gizmo become the same world transform', () => {
  const s = Math.SQRT1_2;
  const state = {
    delta: { dx: 1, dy: 2, dz: 3 },
    rotation: { rx: 30, ry: 0, rz: 45 },
    pivot: [1, 1, 1] as [number, number, number],
    axes: [
      [s, s, 0],
      [-s, s, 0],
      [0, 0, 1],
    ] as [[number, number, number], [number, number, number], [number, number, number]],
  };
  const expected = opsAffine(gizmoOps(state));
  const actual = opsAffine(transformOps(gizmoTransformFields(state)));
  expected.m.forEach((v, i) => assert.ok(Math.abs(v - actual.m[i]!) < 1e-9));
  expected.t.forEach((v, i) => assert.ok(Math.abs(v - actual.t[i]!) < 1e-9));
});

void test('Move/Rotate on a face moves it along its normal (Offset Face); an edge explains why not', async () => {
  await load(twoBoxes().slice(0, 2));
  const body = store.getState().evaluation.bodies[0]!;
  const side = body.faces.find((f) => f.normal?.[0] === 1)!;
  store.getState().setSelection([{ kind: 'face', bodyId: body.id, faceKey: side.key }]);
  run('transform.moveRotate');
  const tool = store.getState().activeTool;
  assert.ok(tool?.kind === 'feature' && tool.draft.kind === 'offsetFace' && tool.draft.viaMove);
  assert.equal(draftMeta(tool.draft).label, 'Move Face');
  store.getState().cancel();
  store.getState().setSelection([{ kind: 'edge', bodyId: body.id, edgeKey: body.edges[0]!.key }]);
  const availability = findCommand('transform.moveRotate')!.availability(store.getState());
  assert.equal(availability.enabled, false);
  assert.match(availability.reason ?? '', /Edges cannot be moved/);
});

void test('Move Profile: a sketch region moves in its plane; position dimensions follow; a lock refuses', async () => {
  const sketch = rectSketch('feature-sketch-1', 0, 0, 10, 5);
  const key = detectRegions(sketch)[0]!.key;
  const moved = translateSketchRegion(sketch, key, 3, 4);
  assert.ok(moved.ok);
  const map = entityMap(moved.sketch);
  const corner = moved.sketch.entities.find(
    (e) => e.kind === 'point' && pointPos(map, e.id)?.[0] === 3,
  );
  assert.ok(corner, 'the corner moved to x = 3');
  const position = moved.sketch.dimensions.filter((d) => d.refs.includes('origin'));
  assert.ok(position.some((d) => Math.abs(d.value - 3) < 1e-9 || Math.abs(d.value - 4) < 1e-9));
  const locked = {
    ...sketch,
    constraints: [
      ...sketch.constraints,
      { id: 'kx', kind: 'fixed' as const, refs: [sketch.entities[0]!.id] },
    ],
  };
  const refused = translateSketchRegion(locked, key, 1, 0);
  assert.ok(!refused.ok && /locked/.test(refused.reason));
  // Through the store: rotation is refused with the reason, a translation commits.
  await load([sketch]);
  assert.ok(store.getState().beginMoveSketch('feature-sketch-1', key));
  store.getState().setRotation(0, 0, 15);
  const tool = store.getState().activeTool as MoveTool;
  const result = moveSketchResult(store.getState().features, tool);
  assert.ok(!result.ok && /do not rotate/.test(result.reason));
  store.getState().setRotation(0, 0, 0);
  store.getState().setDelta(0, 2, 0);
  store.getState().commit();
  await store.getState().whenSettled();
  const after = store.getState().features[0] as SketchFeature;
  const ys = after.entities.filter((e) => e.kind === 'point').map((e) => (e as { y: number }).y);
  assert.equal(Math.min(...ys), 2);
});

// ---- SK-19: 3D snaps ------------------------------------------------------------------------

void test('3D snaps: body vertices, edge midpoints and hole centres; far edges only in orthographic view', async () => {
  await load(createDemoDocument());
  const bodies = store.getState().evaluation.bodies;
  const frame = frameForPlane('XY', 6);
  const persp = bodySnapTargets(bodies, frame, { orthographic: false });
  assert.equal(persp.farEdges.length, 0);
  assert.ok(
    persp.points.some(
      (p) => p.kind === 'circleCenter' && Math.hypot(p.pos[0] - 40, p.pos[1] - 20) < 1e-3,
    ),
  );
  assert.ok(
    persp.points.some(
      (p) => p.kind === 'vertex' && Math.hypot(p.pos[0] - 80, p.pos[1] - 50) < 1e-3,
    ),
  );
  const ortho = bodySnapTargets(bodies, frame, { orthographic: true });
  assert.ok(ortho.farEdges.length > 0);
  // The hole centre wins near the cursor, with its hint; turning the snap off drops it.
  const near = infer(EMPTY_SKETCH, [40.3, 20.2], { mmPerPx: 0.1, body: persp });
  assert.deepEqual(near.hints, ['circleCenter']);
  assert.deepEqual(near.pos, [40, 20]);
  const off = infer(EMPTY_SKETCH, [40.3, 20.2], {
    mmPerPx: 0.1,
    body: persp,
    snaps: { bodyPoints: false },
  });
  assert.notDeepEqual(off.hints, ['circleCenter']);
});

// ---- SK-02 / SK-04 / SK-07 / CON-04 ------------------------------------------------------------

void test('Continuing on the same plane right after a sketch edits it; after another step, not', async () => {
  await load([rectSketch('feature-sketch-1', 0, 0, 10, 5)]);
  store.getState().clearSelection();
  assert.equal(continuableSketchId(store.getState()), 'feature-sketch-1');
  await load([
    rectSketch('feature-sketch-1', 0, 0, 10, 5),
    extrude('feature-extrude-2', 'feature-sketch-1', 3),
  ]);
  assert.equal(continuableSketchId(store.getState()), null);
});

void test('Arc: ends, then bulge (the height follows the pointer); 3 points stays a mode', () => {
  const ctx = { construction: false };
  const click = (sketch: typeof EMPTY_SKETCH, tool: ReturnType<typeof initialTool>, p: Vec2) =>
    reduceTool(
      sketch,
      tool,
      { type: 'click', snap: { pos: p, hints: [], guides: [] }, hit: null, raw: p },
      ctx,
    );
  let step = click(EMPTY_SKETCH, initialTool('arc'), [0, 0]);
  step = click(EMPTY_SKETCH, step.tool, [10, 0]);
  // The pointer beside the chord's middle, 3 mm up: an arc 3 mm high (not through the pointer).
  step = click(EMPTY_SKETCH, step.tool, [7, 3]);
  assert.ok(step.edit);
  const arc = step.edit.sketch.entities.find((e) => e.kind === 'arc');
  assert.ok(arc && arc.kind === 'arc');
  const map = entityMap(step.edit.sketch);
  const c = pointPos(map, arc.center)!;
  const r = Math.hypot(c[0], c[1]);
  assert.ok(Math.abs(r - (100 / 24 + 1.5)) < 1e-9, `radius ${r}`);
  // Three points: start, a point on the arc, end.
  const three = { ...initialTool('arc'), mode: 'threePoint' } as ReturnType<typeof initialTool>;
  let s3 = click(EMPTY_SKETCH, three, [0, 0]);
  s3 = click(EMPTY_SKETCH, s3.tool, [7, 3]);
  s3 = click(EMPTY_SKETCH, s3.tool, [10, 0]);
  assert.ok(s3.edit);
  const arc3 = s3.edit.sketch.entities.find((e) => e.kind === 'arc');
  const map3 = entityMap(s3.edit.sketch);
  const c3 = arc3 && arc3.kind === 'arc' ? pointPos(map3, arc3.center)! : null;
  assert.ok(c3 && Math.abs(Math.hypot(7 - c3[0], 3 - c3[1]) - Math.hypot(c3[0], c3[1])) < 1e-9);
});

void test('Rectangle by three points: a rotated rectangle with right angles, no H/V', () => {
  const ctx = { construction: false };
  const click = (sketch: typeof EMPTY_SKETCH, tool: ReturnType<typeof initialTool>, p: Vec2) =>
    reduceTool(
      sketch,
      tool,
      { type: 'click', snap: { pos: p, hints: [], guides: [] }, hit: null, raw: p },
      ctx,
    );
  const tool = { ...initialTool('rectangle'), mode: 'threePoint' } as ReturnType<
    typeof initialTool
  >;
  let step = click(EMPTY_SKETCH, tool, [0, 0]);
  step = click(EMPTY_SKETCH, step.tool, [8, 6]);
  step = click(EMPTY_SKETCH, step.tool, [-3, 4]);
  assert.ok(step.edit);
  const lines = step.edit.sketch.entities.filter((e) => e.kind === 'line');
  assert.equal(lines.length, 4);
  const kinds = step.edit.sketch.constraints.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['parallel', 'parallel', 'perpendicular']);
  const regions = detectRegions(step.edit.sketch);
  assert.equal(regions.length, 1);
  assert.ok(Math.abs(regions[0]!.area - 50) < 1e-6, `area ${regions[0]!.area}`);
});

void test('Constraints keep the first (or last) selected item in place', async () => {
  const lines = addPolyline(
    EMPTY_SKETCH,
    [
      [0, 0],
      [10, 1],
    ],
    {},
  );
  const both = addPolyline(
    lines.sketch,
    [
      [0, 5],
      [10, 9],
    ],
    {},
  );
  const [first] = lines.lineIds;
  const [second] = both.lineIds;
  const sketch: SketchFeature = {
    id: 'feature-sketch-1',
    name: 'Sketch 1',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    ...both.sketch,
  };
  const endOf = (s: typeof EMPTY_SKETCH, lineId: string) => {
    const map = entityMap(s);
    const line = map.get(lineId);
    return line?.kind === 'line' ? [pointPos(map, line.a)!, pointPos(map, line.b)!] : null;
  };
  for (const keep of ['first', 'last'] as const) {
    await load([sketch]);
    usePreferences.getState().setPreference('constraintKeep', keep);
    assert.ok(useSketchStore.getState().begin({ featureId: sketch.id }));
    useSketchStore.getState().select([first!, second!]);
    assert.equal(await useSketchStore.getState().applyConstraint('parallel'), null);
    await useSketchStore.getState().whenIdle();
    const solved = useSketchStore.getState().session!.sketch;
    const kept = keep === 'first' ? first! : second!;
    const original = endOf(sketch, kept)!;
    const now = endOf(solved, kept)!;
    original.forEach((p, i) =>
      assert.ok(Math.hypot(p[0] - now[i]![0], p[1] - now[i]![1]) < 1e-6, `${keep} kept`),
    );
    assert.ok(!solved.constraints.some((c) => c.kind === 'fixed'), 'the pin is not kept');
    useSketchStore.getState().discard();
  }
  usePreferences.getState().setPreference('constraintKeep', 'first');
});

// ---- Agent API --------------------------------------------------------------------------------

void test('Agent API: construction plane + sketch on it, extrude extents, mirrored sketch, datums.list', async () => {
  const { AgentSession, HEADLESS_CAPABILITIES } =
    await import('../../renderer/src/interface/agent-api/session.js');
  const kernel = createNodeKernelAdapter();
  store.getState().attachKernel(kernel);
  await load([]);
  const session = new AgentSession({
    store,
    kernel,
    host: { server: 'headless', capabilities: HEADLESS_CAPABILITIES },
  });
  type Json = Record<string, unknown>;
  const call = async <T = Json>(method: string, params: Json = {}) =>
    (await session.handle(method, params)) as T;
  const base = await call('feature.create', {
    kind: 'sketch',
    params: { plane: 'XY', profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 20, height: 20 }] },
  });
  await call('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: base.featureId }, distance: 10 },
  });
  const plane = await call('feature.create', {
    kind: 'constructionPlane',
    params: {
      definition: { kind: 'offset', base: { kind: 'plane', plane: 'XY' }, distance: 30 },
    },
  });
  const datums = await call<Json[]>('datums.list');
  assert.equal(datums.length, 1);
  assert.equal(datums[0]!.kind, 'plane');
  // The server fills the reference's frame from the evaluated datum.
  const onPlane = await call('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'construction', featureId: plane.featureId },
      profiles: [{ kind: 'circle', cx: 10, cy: 10, radius: 3 }],
    },
  });
  // Extrude down from z = 30 through the block: a through hole.
  await call('feature.create', {
    kind: 'extrude',
    params: {
      profile: { kind: 'sketch', featureId: onPlane.featureId },
      distance: -1,
      operation: 'cut',
      extent: { kind: 'throughAll' },
    },
  });
  const bodies = await call<Json[]>('bodies.list');
  assert.equal(bodies.length, 1);
  assert.ok(Math.abs((bodies[0]!.volume as number) - (4000 - Math.PI * 9 * 10)) < 0.05);
  // Mirror the base sketch across YZ: its profiles are a sketch of their own.
  const mirror = await call('feature.create', {
    kind: 'mirror',
    params: { sketchIds: [base.featureId], plane: 'YZ' },
  });
  const sketches = await call<Json[]>('sketches.list');
  const mirrored = sketches.find((s) => s.derivedFrom === mirror.featureId);
  assert.ok(mirrored, 'the mirrored sketch is listed');
  assert.equal(mirrored.featureId, `${mirror.featureId as string}:sketch:0`);
  // Bad construction reference: a clear error.
  await assert.rejects(
    call('feature.create', {
      kind: 'sketch',
      params: { plane: { kind: 'construction', featureId: 'nope' } },
    }),
    /not an evaluated construction plane/,
  );
});
