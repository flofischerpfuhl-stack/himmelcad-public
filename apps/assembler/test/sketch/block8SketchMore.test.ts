/**
 * Block 8 sketching, further rows: Disconnect (CON-02), unlinking projected
 * geometry (SK-15) and sizing circles by radius or diameter (SK-05) — on
 * the real solver and, for the API, the real kernel.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import {
  evaluateConstantExpression,
  isPlainNumber,
  parseDimensionExpression,
} from '../../renderer/src/foundation/document/expressions.js';
import { resolveDimensionValues } from '../../renderer/src/foundation/sketch-solver/dimensionValues.js';
import { parseExpression } from '../../renderer/src/platform/viewport/expr.js';
import { evaluateExpression } from '../../renderer/src/platform/widgets/expression.js';
import { objText } from '../../renderer/src/foundation/geometry-kernel/objExport.js';
import { parseObj } from '../../renderer/src/modules/interop/objImport.js';
import { addRectangle } from '../../renderer/src/foundation/sketch-solver/builders.js';
import {
  addProjection,
  projectionOf,
  unlinkProjections,
} from '../../renderer/src/foundation/sketch-solver/projection.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import {
  EMPTY_SKETCH,
  type SketchData,
  type SketchLine,
  type Vec2,
} from '../../renderer/src/foundation/sketch-solver/types.js';
import { validateSketchData } from '../../renderer/src/foundation/sketch-solver/validation.js';
import {
  AgentSession,
  HEADLESS_CAPABILITIES,
} from '../../renderer/src/interface/agent-api/session.js';
import type { Inference } from '../../renderer/src/modules/sketching/inference.js';
import { disconnectPoints } from '../../renderer/src/modules/sketching/operations.js';
import { useSketchPreferences } from '../../renderer/src/modules/sketching/sketchPreferences.js';
import {
  initialTool,
  reduceTool,
  toolPreview,
} from '../../renderer/src/modules/sketching/tools.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from './nodeSolver.js';

type Json = Record<string, unknown>;

const store = useAssemblerStore;
const kernel = createNodeKernelAdapter();
store.getState().attachKernel(kernel);
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));
const session = new AgentSession({
  store,
  kernel,
  host: { server: 'headless', capabilities: HEADLESS_CAPABILITIES },
});

async function call<T = Json>(method: string, params: Json = {}): Promise<T> {
  return (await session.handle(method, params)) as T;
}

async function solve(sketch: SketchData): Promise<{ sketch: SketchData; dof: number }> {
  const result = (await loadNodeSolver()).solveSync({ sketch });
  assert.equal(result.status, 'ok', result.message ?? '');
  return { sketch: result.sketch, dof: result.dof };
}

function snap(pos: Vec2): Inference {
  return { pos, hints: [], guides: [] };
}

void test('Disconnect (CON-02): the curves at a shared corner get their own points; constraints stay with the first', async () => {
  const rect = addRectangle(EMPTY_SKETCH, [0, 0], [20, 10], { position: false, size: false });
  const base = await solve(rect.sketch);
  const lines = base.sketch.entities.filter((e): e is SketchLine => e.kind === 'line');
  const corner = lines[0]!.a;
  const users = lines.filter((l) => l.a === corner || l.b === corner);
  assert.equal(users.length, 2);
  const edit = disconnectPoints(base.sketch, [corner]);
  assert.ok(!('reason' in edit), 'reason' in edit ? edit.reason : '');
  assert.equal(validateSketchData(edit.sketch as never), null);
  const after = edit.sketch.entities.filter((e): e is SketchLine => e.kind === 'line');
  const stillShared = after.filter((l) => l.a === corner || l.b === corner);
  assert.equal(stillShared.length, 1, 'only the first curve keeps the corner');
  assert.equal(edit.select?.length, 2, 'the corner and the new point are selected');
  const solved = await solve(edit.sketch);
  assert.equal(solved.dof, base.dof + 2, 'the new point adds two degrees of freedom');
  // Nothing connected: a reason, no edit.
  const lonely = disconnectPoints(edit.sketch, [edit.select![1]!]);
  assert.ok('reason' in lonely);
  assert.match(lonely.reason, /where curves meet/);
});

void test('Disconnect (CON-02): a selected coincident constraint is removed', async () => {
  const b = addRectangle(EMPTY_SKETCH, [0, 0], [10, 10], { position: false, size: false }).sketch;
  const free = {
    ...b,
    entities: [...b.entities, { id: 'p90', kind: 'point' as const, x: 0, y: 0 }],
  };
  const corner = (b.entities.find((e) => e.kind === 'line') as SketchLine).a;
  const tied: SketchData = {
    ...free,
    constraints: [...free.constraints, { id: 'k90', kind: 'coincident', refs: ['p90', corner] }],
  };
  const edit = disconnectPoints(tied, ['k90']);
  assert.ok(!('reason' in edit));
  assert.ok(!edit.sketch.constraints.some((c) => c.id === 'k90'));
});

void test('unlink (SK-15): projected geometry becomes free, editable sketch geometry', async () => {
  const projected = addProjection(
    EMPTY_SKETCH,
    {
      kind: 'edge',
      ref: {
        bodyId: 'b1',
        key: 'e1',
        signature: { curve: 'line', midpoint: [0, 0, 0], length: 10 },
      },
    } as never,
    [{ kind: 'line', a: [0, 0], b: [10, 0] }],
    false,
  )!;
  const line = projected.sketch.projections![0]!.entities[0]!;
  const fixed = await solve(projected.sketch);
  assert.equal(fixed.dof, 0, 'linked geometry is fixed');
  const point = (projected.sketch.entities.find((e) => e.id === line) as SketchLine).a;
  assert.equal(projectionOf(projected.sketch, point)?.id, projected.sketch.projections![0]!.id);
  assert.equal(unlinkProjections(projected.sketch, ['nothing']), null);
  const edit = unlinkProjections(projected.sketch, [point])!;
  assert.deepEqual(edit.sketch.projections, []);
  assert.deepEqual(edit.select, [line]);
  assert.ok(
    edit.sketch.entities.some((e) => e.id === line),
    'the geometry stays',
  );
  const free = await solve(edit.sketch);
  assert.equal(free.dof, 4, 'two free end points');
});

void test('unlink (SK-15) and disconnect through the agent API: one undo step each', async () => {
  store.getState().loadDocument([], { projectName: 'Unlink' });
  await store.getState().whenSettled();
  const base = await call<{ featureId: string }>('feature.create', {
    kind: 'sketch',
    params: { plane: 'XY' },
  });
  await call('sketch.addProfile', {
    featureId: base.featureId,
    profile: { kind: 'rectangle', x: 0, y: 0, width: 12, height: 8 },
  });
  const box = await call<{ featureId: string }>('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: base.featureId }, distance: 5 },
  });
  const target = await call<{ featureId: string }>('feature.create', {
    kind: 'sketch',
    params: { plane: { kind: 'plane', plane: 'XY', offset: 10 } },
  });
  const bodyId = store.getState().evaluation.bodies[0]!.id;
  const projected = await call<{ entityIds: string[]; projectionId: string }>('sketch.project', {
    featureId: target.featureId,
    face: { bodyId, key: `${box.featureId}:end:0` },
    construction: false,
  });
  const unlinked = await call<{ unlinked: string[]; entityIds: string[] }>(
    'sketch.unlinkProjection',
    {
      featureId: target.featureId,
      ids: [projected.entityIds[0]!],
    },
  );
  assert.deepEqual(unlinked.unlinked, [projected.projectionId]);
  assert.equal(unlinked.entityIds.length, 4);
  const sketch = () =>
    store.getState().features.find((f) => f.id === target.featureId) as SketchFeature;
  assert.equal(sketch().projections?.length ?? 0, 0);
  // No longer associative: the source changes, the unlinked outline stays.
  await call('sketch.setDimension', { featureId: base.featureId, dimension: 'd3', value: 20 });
  const area = store.getState().evaluation.sketches.find((s) => s.featureId === target.featureId)!
    .profiles[0]!.area;
  assert.ok(Math.abs(area - 96) < 1e-6, `area ${area}`);

  const lines = sketch().entities.filter((e): e is SketchLine => e.kind === 'line');
  const points = () => sketch().entities.filter((e) => e.kind === 'point').length;
  const before = points();
  const disconnected = await call<{ createdIds: string[] }>('sketch.disconnect', {
    featureId: target.featureId,
    ids: [lines[0]!.a],
  });
  assert.equal(disconnected.createdIds.length, 1);
  assert.equal(points(), before + 1);
  store.getState().undo();
  assert.equal(points(), before, 'undo restores the shared corner');
});

void test('circle size (SK-05): the circle chip and the Dimension tool follow the radius/diameter preference', () => {
  const tool = { ...initialTool('circle'), center: snap([0, 0]) } as ReturnType<typeof initialTool>;
  const diameter = toolPreview(EMPTY_SKETCH, tool, snap([5, 0]), null, { construction: false });
  assert.equal(diameter.chips[0]?.field, 'diameter');
  assert.equal(diameter.chips[0]?.value, 10);
  const radius = toolPreview(EMPTY_SKETCH, tool, snap([5, 0]), null, {
    construction: false,
    circleDimension: 'radius',
  });
  assert.deepEqual([radius.chips[0]?.field, radius.chips[0]?.value], ['radius', 5]);
  const typed = reduceTool(
    EMPTY_SKETCH,
    tool,
    { type: 'value', field: 'radius', value: 4, snap: snap([4, 0]) },
    {
      construction: false,
      circleDimension: 'radius',
    },
  );
  const dimension = typed.edit!.sketch.dimensions[0]!;
  assert.deepEqual([dimension.kind, dimension.value], ['radius', 4]);
  // The Dimension tool on a circle.
  const circleId = typed.edit!.sketch.entities.find((e) => e.kind === 'circle')!.id;
  const withoutDimension = { ...typed.edit!.sketch, dimensions: [] };
  const dim = reduceTool(
    withoutDimension,
    initialTool('dimension'),
    { type: 'click', snap: snap([4, 0]), hit: { kind: 'curve', id: circleId }, raw: [6, 0] },
    { construction: false, circleDimension: 'radius' },
  );
  assert.equal(dim.edit?.sketch.dimensions[0]?.kind, 'radius');
  // The preference persists for the session (headless: no storage).
  useSketchPreferences.getState().setCircleDimension('radius');
  assert.equal(useSketchPreferences.getState().circleDimension, 'radius');
  useSketchPreferences.getState().setCircleDimension('diameter');
});

void test('units inside expressions (CON-08): each term converts to mm / degrees', () => {
  const close = (a: number | null, b: number) =>
    assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  close(evaluateConstantExpression('10 mm + 1 in'), 35.4);
  close(evaluateConstantExpression('2.5cm'), 25);
  close(evaluateConstantExpression('2 m - 1 ft'), 2000 - 304.8);
  close(evaluateConstantExpression('1" + 1\''), 25.4 + 304.8);
  close(evaluateConstantExpression('(1 in + 1 in) / 2'), 25.4);
  close(evaluateConstantExpression('90° - 1 rad'), 90 - 180 / Math.PI);
  close(evaluateConstantExpression('1,5 cm'), 15);
  assert.equal(evaluateConstantExpression('2 meters'), null, 'unknown unit words stay errors');
  assert.equal(evaluateConstantExpression('wall + 1 in'), null, 'names need a lookup');
  const parsed = parseDimensionExpression('wall + 1 in')!;
  assert.deepEqual(parsed.refs, ['wall']);
  close(
    parsed.evaluate((n) => (n === 'wall' ? 2 : null)),
    27.4,
  );
  assert.equal(isPlainNumber('1 in'), false);
  // The UI fields accept them too.
  close(evaluateExpression('1 in + 2'), 27.4);
  close(parseExpression('10 mm + 1 in'), 35.4);
  assert.equal(parseExpression('abc'), null);
  // A sketch dimension written with units.
  const values = resolveDimensionValues([
    { id: 'm1', name: 'd1', kind: 'distance', refs: ['l1'], value: 1, expression: '1 in + 5 mm' },
  ]);
  assert.ok(values.ok);
  close(values.values.get('m1')!, 30.4);
});

void test('OBJ export (IMP-07): one object per body, shared vertices with normals; the importer reads it back', async () => {
  store.getState().loadDocument([], { projectName: 'Obj' });
  await store.getState().whenSettled();
  const sketch = await call<{ featureId: string }>('feature.create', {
    kind: 'sketch',
    params: { plane: 'XY' },
  });
  await call('sketch.addProfile', {
    featureId: sketch.featureId,
    profile: { kind: 'rectangle', x: 0, y: 0, width: 10, height: 20 },
  });
  await call('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: sketch.featureId }, distance: 5 },
  });
  const exported = await call<{ data: string; mediaType: string; triangles: number }>('export.obj');
  assert.equal(exported.mediaType, 'model/obj');
  const text = Buffer.from(exported.data, 'base64').toString('utf8');
  assert.match(text, /^# HimmelCAD Assembler\n# Units: millimetres\no Body 1\n/);
  assert.equal((text.match(/^f /gm) ?? []).length, exported.triangles);
  const back = parseObj(text, 'export.obj');
  assert.equal(back.objects.length, 1);
  assert.equal(back.objects[0]!.mesh.triangleCount, exported.triangles);
  assert.deepEqual(
    back.objects[0]!.mesh.min.map((v) => Math.round(v)),
    [0, 0, 0],
  );
  assert.deepEqual(
    back.objects[0]!.mesh.max.map((v) => Math.round(v)),
    [10, 20, 5],
  );
  // Two bodies: global 1-based indices continue across objects.
  const mesh = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    triangleFaces: new Uint32Array([0]),
  };
  const two = objText([
    { name: 'A', mesh },
    { name: 'B\nline', mesh },
  ]);
  assert.match(
    two,
    /o A\n[\s\S]*f 1\/\/1 2\/\/2 3\/\/3\no B line\n[\s\S]*f 4\/\/4 5\/\/5 6\/\/6\n$/,
  );
});
