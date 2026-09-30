/**
 * The 3D-printing part of the agent API on the real kernel: print.analyze,
 * print.orientations, print.placeOnPlate / print.orient (one undo step,
 * staged in transactions), export.meshStats and the STL/3MF export options.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../../renderer/src/foundation/commands/api/errors.js';
import { AgentSession, HEADLESS_CAPABILITIES } from '../../renderer/src/api/session.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { validateThreeMf } from '../kernel/threeMfValidator.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';

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

async function reset(): Promise<void> {
  store.getState().cancel();
  if (session.transactionOpen) await call('transaction.cancel');
  store.getState().loadDocument([], { projectName: 'Print' });
  await store.getState().whenSettled();
}

/** A 30 × 20 plate (6 mm) with a Ø1.5 hole cut through, plus a mushroom-like ledge. */
async function plate(): Promise<string> {
  const sketch = await call('feature.create', {
    kind: 'sketch',
    params: { plane: 'XY', profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 30, height: 20 }] },
  });
  const extrude = await call('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: sketch.featureId }, distance: 6 },
  });
  const bodyId = `body:${String(extrude.featureId)}`;
  const hole = await call('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY', offset: 6 },
      profiles: [{ kind: 'circle', cx: 10, cy: 10, radius: 0.75 }],
    },
  });
  await call('feature.create', {
    kind: 'extrude',
    params: {
      profile: { kind: 'sketch', featureId: hole.featureId },
      distance: -6,
      operation: 'cut',
      targetBodyId: bodyId,
    },
  });
  return bodyId;
}

void test('print.analyze reports checks, findings and material; settings override the defaults', async () => {
  await reset();
  const bodyId = await plate();
  const report = await call<{
    totals: { bodies: number; massG: number };
    bodies: Json[];
    findings: { kind: string; faceKeys: string[]; severity: string }[];
    settings: Json;
  }>('print.analyze', { settings: { material: 'PETG', minHoleMm: 2 } });
  assert.equal(report.totals.bodies, 1);
  const body = report.bodies[0]! as {
    bodyId: string;
    brepValid: boolean;
    watertight: boolean;
    holes: { kind: string; diameterMm: number; flagged: boolean }[];
    thinWall: { samples: number; minThicknessMm: number };
  };
  assert.equal(body.bodyId, bodyId);
  assert.ok(body.brepValid && body.watertight);
  assert.deepEqual(
    body.holes.map((h) => [h.kind, h.diameterMm, h.flagged]),
    [['hole', 1.5, true]],
  );
  assert.ok(body.thinWall.samples > 100);
  assert.equal(report.settings.material, 'PETG');
  assert.equal(report.settings.density, 1.27, 'the PETG preset density');
  const volume = 30 * 20 * 6 - Math.PI * 0.75 ** 2 * 6;
  assert.ok(Math.abs(report.totals.massG - (volume / 1000) * 1.27) < 1e-2);
  assert.ok(report.findings.some((f) => f.kind === 'smallHole' && f.faceKeys.length === 1));

  await assert.rejects(
    call('print.analyze', { settings: { overhangAngleDeg: 95 } }),
    (e: unknown) => e instanceof ApiError && e.code === 'invalidParams',
  );
});

void test('print.placeOnPlate: one undo step, face down on Z = 0; transactions stage it', async () => {
  await reset();
  const bodyId = await plate();
  const before = store.getState().features.length;
  const placed = await call<{ featureId: string; committed: boolean; bodies: Json[] }>(
    'print.placeOnPlate',
    { face: { bodyId, select: '+X' } },
  );
  assert.equal(placed.committed, true);
  assert.equal(store.getState().features.length, before + 1);
  const feature = store.getState().features.at(-1)!;
  assert.equal(feature.kind, 'transform');
  assert.match(feature.name, /^Place on Plate 1$/);
  const body = store.getState().evaluation.bodies.find((b) => b.id === bodyId)!;
  assert.ok(Math.abs(body.min[2]) < 1e-6);
  assert.ok(Math.abs(body.max[2] - 30) < 1e-6, 'the 30 mm side now stands up');
  await call('history.undo');
  assert.equal(store.getState().features.length, before);

  await call('transaction.begin', { label: 'Place' });
  await call('print.placeOnPlate', { face: { bodyId, select: '-Y' } });
  assert.equal(store.getState().features.length, before, 'staged, not committed');
  await call('transaction.cancel');
  assert.equal(store.getState().features.length, before);

  await assert.rejects(
    call('print.placeOnPlate', { face: { bodyId, select: '%CYLINDER' } }),
    (e: unknown) => e instanceof ApiError && e.code === 'invalidParams' && /flat/.test(e.message),
  );
});

void test('print.orientations + print.orient', async () => {
  await reset();
  const bodyId = await plate();
  const ranked = await call<
    { rank: number; label: string; overhangAreaMm2: number; heightMm: number }[]
  >('print.orientations', { bodyId, limit: 5 });
  assert.equal(ranked.length, 5);
  assert.deepEqual(
    ranked.map((c) => c.rank),
    [1, 2, 3, 4, 5],
  );
  assert.equal(
    ranked[0]!.heightMm,
    6,
    'flat plate: lowest height first among zero-overhang candidates',
  );
  const again = await call<typeof ranked>('print.orientations', { bodyId, limit: 5 });
  assert.deepEqual(again, ranked, 'deterministic');

  const oriented = await call<{ featureId: string; candidate: { rank: number } }>('print.orient', {
    bodyId,
    rank: 1,
  });
  assert.equal(oriented.candidate.rank, 1);
  const down = await call<{ featureId: string }>('print.orient', { bodyId, down: [0, 1, 0] });
  assert.ok(down.featureId);
  const body = store.getState().evaluation.bodies.find((b) => b.id === bodyId)!;
  assert.ok(Math.abs(body.min[2]) < 1e-6);
  assert.ok(
    Math.abs(body.max[2] - 20) < 1e-6,
    '+Y side on the plate: the 20 mm depth is the height',
  );
  await assert.rejects(
    call('print.orient', { bodyId, rank: 99 }),
    (e: unknown) => e instanceof ApiError && e.code === 'invalidParams',
  );
});

void test('export options: meshStats, STL format/resolution, 3MF validity', async () => {
  await reset();
  await plate();
  const stats = await call<{ triangles: number; stlBinaryBytes: number; bodies: Json[] }>(
    'export.meshStats',
  );
  assert.equal(stats.bodies.length, 1);
  assert.equal(stats.stlBinaryBytes, 84 + stats.triangles * 50);
  const fine = await call<{ triangles: number }>('export.meshStats', { resolution: 'fine' });
  const coarse = await call<{ triangles: number }>('export.meshStats', { resolution: 'coarse' });
  assert.ok(fine.triangles > coarse.triangles, `${fine.triangles} > ${coarse.triangles}`);

  const ascii = await call<{ data: string; triangles: number; mediaType: string }>('export.stl', {
    format: 'ascii',
    resolution: 'coarse',
  });
  assert.equal(ascii.mediaType, 'model/stl');
  assert.equal(ascii.triangles, coarse.triangles);
  const text = Buffer.from(ascii.data, 'base64').toString('utf8');
  assert.equal((text.match(/facet normal/g) ?? []).length, coarse.triangles);

  const threeMf = await call<{ data: string }>('export.3mf', { resolution: 'standard' });
  const { problems } = validateThreeMf(new Uint8Array(Buffer.from(threeMf.data, 'base64')));
  assert.deepEqual(problems, []);
  await assert.rejects(
    call('export.stl', { format: 'obj' }),
    (e: unknown) => e instanceof ApiError && e.code === 'invalidParams',
  );
});
