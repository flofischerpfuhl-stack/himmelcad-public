/**
 * The print-part features through the canonical agent API (`feature.create`
 * / `feature.edit`) on the real kernel: selectors resolve to stable
 * references, defaults apply, results match hand calculations, the schema
 * rejects malformed params with readable errors, and edits are one step.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../../renderer/src/foundation/commands/api/errors.js';
import { AgentSession, HEADLESS_CAPABILITIES } from '../../renderer/src/api/session.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
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

async function fails(promise: Promise<unknown>, code: ApiError['code']): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

async function plate(width = 40, depth = 30, height = 10): Promise<string> {
  store.getState().loadDocument([], { projectName: 'Print' });
  await store.getState().whenSettled();
  const s = await call<{ featureId: string }>('feature.create', {
    kind: 'sketch',
    params: { plane: 'XY', profiles: [{ kind: 'rectangle', x: 0, y: 0, width, height: depth }] },
  });
  const e = await call<{ featureId: string }>('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: s.featureId }, distance: height },
  });
  return `body:${e.featureId}`;
}

async function volume(bodyId: string): Promise<number> {
  const body = await call<{ volume: number; valid: boolean }>('body.get', { bodyId });
  assert.equal(body.valid, true, `${bodyId} valid`);
  return body.volume;
}

void test('agent API: hole with a selector face, defaults, edit and readable errors', async () => {
  const bodyId = await plate();
  const created = await call<{ featureId: string; name: string }>('feature.create', {
    kind: 'hole',
    params: {
      face: { bodyId, select: '>Z' },
      placements: [
        { kind: 'point', u: 10, v: 10 },
        { kind: 'point', u: 30, v: 20 },
      ],
      diameter: 3.4,
      thread: 'M3',
    },
  });
  assert.equal(created.name, 'Hole 1');
  const feature = await call<{ params: Json; error?: string }>('feature.get', {
    featureId: created.featureId,
  });
  assert.equal(feature.error, undefined);
  assert.equal(feature.params.holeType, 'simple', 'default type');
  assert.deepEqual(feature.params.extent, { kind: 'through' }, 'default extent');
  assert.ok(Math.abs((await volume(bodyId)) - (12000 - 2 * Math.PI * 1.7 ** 2 * 10)) < 1e-3);

  await call('feature.edit', {
    featureId: created.featureId,
    params: { holeType: 'counterbore', counterboreDiameter: 6.5, counterboreDepth: 3.4 },
  });
  const expected = 12000 - 2 * (Math.PI * 1.7 ** 2 * 10 + Math.PI * (3.25 ** 2 - 1.7 ** 2) * 3.4);
  assert.ok(Math.abs((await volume(bodyId)) - expected) < 1e-3, 'counterbored');

  await fails(
    call('feature.create', {
      kind: 'hole',
      params: { face: { bodyId, select: '>Z' }, placements: [], diameter: 3 },
    }),
    'invalidParams',
  );
  // The kernel's readable error comes back and nothing is committed.
  const count = store.getState().features.length;
  const rejected = await fails(
    call('feature.create', {
      kind: 'hole',
      params: {
        face: { bodyId, select: '>Z' },
        placements: [{ kind: 'point', u: 20, v: 15 }],
        diameter: 3,
        holeType: 'counterbore',
        counterboreDiameter: 2,
        counterboreDepth: 1,
      },
    }),
    'featureFailed',
  );
  assert.match(
    rejected.message,
    /Counterbore diameter \(2 mm\) must be larger than the hole \(3 mm\)/,
  );
  assert.equal(store.getState().features.length, count);
});

void test('agent API: fillet by rule, variable radius, chamfer modes, shell and boolean options', async () => {
  const bodyId = await plate(20, 10, 10);
  const byRule = await call<{ featureId: string }>('feature.create', {
    kind: 'fillet',
    params: { radius: 1, rules: [{ kind: 'faceEdges', face: { bodyId, select: '>Z' } }] },
  });
  const f = await call<{ params: Json; error?: string }>('feature.get', {
    featureId: byRule.featureId,
  });
  assert.equal(f.error, undefined);
  assert.deepEqual(f.params.edges, [], 'edges default to []');
  const rules = f.params.rules as { kind: string; face: { key: string; signature: unknown } }[];
  assert.equal(rules[0]!.kind, 'faceEdges');
  assert.ok(
    rules[0]!.face.key && rules[0]!.face.signature,
    'selector resolved to a stable face ref',
  );
  await fails(call('feature.create', { kind: 'fillet', params: { radius: 1 } }), 'invalidParams');
  // Too large for the part: the failure names the edge it fails on.
  const tooBig = await fails(
    call('feature.create', {
      kind: 'fillet',
      params: { edges: [{ bodyId, select: '>Z and |X and <Y' }], radius: 12 },
    }),
    'featureFailed',
  );
  const failures = tooBig.details?.failures as { refs?: { edgeKeys?: string[] } }[];
  assert.equal(failures[0]?.refs?.edgeKeys?.length, 1, 'the failing edge key is reported');
  await call('feature.delete', { featureId: byRule.featureId });

  const chamfer = await call<{ featureId: string }>('feature.create', {
    kind: 'chamfer',
    params: {
      edges: [{ bodyId, select: '>Z and |X and <Y' }],
      distance: 1,
      mode: 'twoDistances',
      distance2: 2,
    },
  });
  assert.ok(Math.abs((await volume(bodyId)) - (2000 - 20)) < 1e-6, 'two-distance chamfer');
  await call('feature.edit', {
    featureId: chamfer.featureId,
    params: { mode: 'distanceAngle', angle: 30 },
  });
  assert.ok(Math.abs((await volume(bodyId)) - (2000 - 0.5 * Math.tan(Math.PI / 6) * 20)) < 1e-6);
  await call('feature.delete', { featureId: chamfer.featureId });

  await call('feature.create', {
    kind: 'shell',
    params: { faces: [{ bodyId, select: '>Z' }], thickness: 1, direction: 'outside' },
  });
  assert.ok(Math.abs((await volume(bodyId)) - (22 * 12 * 11 - 2000)) < 1e-3, 'outward shell');

  const tool = await call<{ featureId: string }>('feature.create', {
    kind: 'sketch',
    params: { plane: 'XY', profiles: [{ kind: 'rectangle', x: 50, y: 0, width: 5, height: 5 }] },
  });
  const cutter = await call<{ featureId: string }>('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: tool.featureId }, distance: 5 },
  });
  await call('feature.create', {
    kind: 'boolean',
    params: {
      operation: 'union',
      targetBodyId: bodyId,
      toolBodyIds: [`body:${cutter.featureId}`],
      keepTools: true,
    },
  });
  const bodies = await call<{ id: string }[]>('bodies.list');
  assert.ok(
    bodies.some((b) => b.id === `body:${cutter.featureId}`),
    'tool body kept',
  );
});

void test('agent API: emboss, draft, rib and thicken', async () => {
  const bodyId = await plate(40, 30, 5);
  const label = await call<{ featureId: string }>('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY', offset: 5 },
      profiles: [{ kind: 'rectangle', x: 5, y: 5, width: 10, height: 4 }],
    },
  });
  await call('feature.create', {
    kind: 'emboss',
    params: {
      profile: { kind: 'sketch', featureId: label.featureId },
      face: { bodyId, select: '>Z' },
      depth: -0.6,
    },
  });
  assert.ok(Math.abs((await volume(bodyId)) - (6000 - 40 * 0.6)) < 1e-3, 'engraved');

  await call('feature.create', {
    kind: 'draft',
    params: {
      // '-X' alone also matches the engraved pocket's wall that faces -X.
      faces: [{ bodyId, select: '-X and <X' }],
      neutral: { kind: 'face', face: { bodyId, select: '<Z' } },
      angle: 5,
    },
  });
  const drafted = 6000 - 40 * 0.6 - 0.5 * 5 * 5 * Math.tan((5 * Math.PI) / 180) * 30;
  const draftedActual = await volume(bodyId);
  assert.ok(
    Math.abs(draftedActual - drafted) < 1e-3,
    `drafted: expected ${drafted}, got ${draftedActual}`,
  );

  const t = await call<{ featureId: string }>('feature.create', {
    kind: 'thicken',
    params: { source: { kind: 'faces', faces: [{ bodyId, select: '<Z' }] }, thickness: 2 },
  });
  const thick = await call<{ volume: number; bbox: { min: number[]; max: number[] } }>('body.get', {
    bodyId: `body:${t.featureId}`,
  });
  assert.ok(Math.abs(thick.bbox.min[2]! + 2) < 1e-6, 'thickened below the bottom face');

  // Rib: an upright, then a gusset line in the YZ plane at x = 20.
  const up = await call<{ featureId: string }>('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY', offset: 5 },
      profiles: [{ kind: 'rectangle', x: 0, y: 25, width: 40, height: 5 }],
    },
  });
  await call('feature.create', {
    kind: 'extrude',
    params: {
      profile: { kind: 'sketch', featureId: up.featureId },
      distance: 20,
      operation: 'join',
      targetBodyId: bodyId,
    },
  });
  const ribSketch = await call<{ featureId: string }>('feature.create', {
    kind: 'sketch',
    params: { plane: { kind: 'plane', plane: 'YZ', offset: 20 } },
  });
  const line = await call<{ lineIds: string[] }>('sketch.addPolyline', {
    featureId: ribSketch.featureId,
    points: [
      [25, 20],
      [10, 5],
    ],
    closed: false,
  });
  const before = await volume(bodyId);
  await call('feature.create', {
    kind: 'rib',
    params: {
      sketchId: ribSketch.featureId,
      entityIds: line.lineIds,
      thickness: 2,
      targetBodyId: bodyId,
    },
  });
  assert.ok(Math.abs((await volume(bodyId)) - (before + 0.5 * 15 * 15 * 2)) < 1e-3, 'gusset');
});

void test('agent API: hole diameter, draft angle and thicken thickness accept parameter formulas', async () => {
  const bodyId = await plate();
  await call('parameter.create', { name: 'bolt', unit: 'mm', value: 3.4 });
  const hole = await call<{ featureId: string }>('feature.create', {
    kind: 'hole',
    params: {
      face: { bodyId, select: '>Z' },
      placements: [{ kind: 'point', u: 20, v: 15 }],
      diameterExpression: 'bolt + 0.2',
    },
  });
  const stored = await call<{ params: Json }>('feature.get', { featureId: hole.featureId });
  assert.equal(stored.params.diameter, 3.6);
  assert.equal(stored.params.diameterExpression, 'bolt + 0.2');
  const hollow = (d: number) => 40 * 30 * 10 - Math.PI * (d / 2) ** 2 * 10;
  assert.ok(Math.abs((await volume(bodyId)) - hollow(3.6)) < 1e-3);

  // A parameter edit re-resolves the formula (one undo step) ...
  const edited = await call<{ changedFeatureIds: string[] }>('parameter.edit', {
    parameterId: 'bolt',
    value: 5.3,
  });
  assert.deepEqual(edited.changedFeatureIds, [hole.featureId]);
  assert.ok(Math.abs((await volume(bodyId)) - hollow(5.5)) < 1e-3);
  // ... and a formula that no longer gives a positive diameter is refused, nothing changes.
  await fails(call('parameter.edit', { parameterId: 'bolt', value: -1 }), 'invalidParams');
  assert.ok(Math.abs((await volume(bodyId)) - hollow(5.5)) < 1e-3);

  // Signed formulas (draft angle) and the schema's "one of" rule.
  await call('parameter.create', { name: 'tilt', unit: 'deg', value: 3 });
  const draft = await call<{ featureId: string }>('feature.create', {
    kind: 'draft',
    params: {
      faces: [{ bodyId, select: '-Y' }],
      neutral: { kind: 'plane', plane: 'XY', offset: 0 },
      angleExpression: '0 - tilt',
    },
  });
  const draftParams = (await call<{ params: Json }>('feature.get', { featureId: draft.featureId }))
    .params;
  assert.equal(draftParams.angle, -3);
  await fails(
    call('feature.create', {
      kind: 'thicken',
      params: { source: { kind: 'faces', faces: [{ bodyId, select: '>X' }] } },
    }),
    'invalidParams',
  );
});
