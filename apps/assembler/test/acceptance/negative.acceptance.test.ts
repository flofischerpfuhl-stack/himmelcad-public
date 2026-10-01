/**
 * PLAN §7 negative cases on the real kernel and solver: an over-constrained
 * sketch, invalid fillet and shell sizes, hidden geometry picked with Select
 * Through, and edits before referenced features (the reference is kept, or
 * the dependent feature reports a clear error). Every refusal must leave the
 * document untouched (same feature array, same revision).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { setSketchDimension } from '../../renderer/src/modules/sketching/featureOps.js';
import {
  collectCandidates,
  isAmbiguous,
  rayCastFaces,
} from '../../renderer/src/platform/viewport/pickCandidates.js';
import { bodies, call, evidence, fails, near, reset, store, type Json } from './harness.js';

async function plate(
  width = 40,
  depth = 30,
  height = 10,
): Promise<{ sketchId: string; bodyId: string; extrudeId: string }> {
  const sketch = await call<{ featureId: string }>('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      profiles: [{ kind: 'rectangle', x: 0, y: 0, width, height: depth }],
    },
  });
  const extrude = await call<{ featureId: string }>('feature.create', {
    kind: 'extrude',
    params: {
      profile: { kind: 'sketch', featureId: sketch.featureId },
      distance: height,
      resultBodyName: 'Plate',
    },
  });
  return {
    sketchId: sketch.featureId,
    extrudeId: extrude.featureId,
    bodyId: `body:${extrude.featureId}`,
  };
}

async function revision(): Promise<number> {
  return (await call<{ revision: number }>('document.get')).revision;
}

void test('N1 over-constrained sketch: a conflicting dimension is refused with the conflict named', async (t) => {
  await reset('Over-constrained');
  const { sketchId } = await plate();
  const sketch = await call<{ params: { entities: { id: string; kind: string }[] } }>(
    'feature.get',
    { featureId: sketchId },
  );
  const line = sketch.params.entities.find((e) => e.kind === 'line')!;
  const before = store.getState().features;
  const rev = await revision();
  // The rectangle is fully dimensioned already: a second, different length on a side conflicts.
  const error = await fails(
    call('sketch.addDimension', {
      featureId: sketchId,
      kind: 'distance',
      refs: [line.id],
      value: 55,
    }),
    'sketchConflict',
  );
  const details = error.details as { conflicting?: string[]; redundant?: string[] };
  assert.ok(
    (details.conflicting?.length ?? 0) + (details.redundant?.length ?? 0) > 0,
    'the conflicting/redundant constraints are named',
  );
  assert.strictEqual(store.getState().features, before, 'nothing changed');
  assert.equal(await revision(), rev);

  // The History panel's dimension edit refuses a collapsing value the same way.
  const dims = store.getState().features.find((f) => f.id === sketchId) as unknown as {
    dimensions: { id: string; value: number }[];
  };
  const width = dims.dimensions.find((d) => Math.abs(d.value - 40) < 1e-9)!;
  const uiMessage = await setSketchDimension(sketchId, width.id, 0);
  assert.ok(uiMessage, 'the UI edit is refused with a reason');
  assert.strictEqual(store.getState().features, before);
  evidence(t, 'N1-over-constrained', {
    apiError: error.code,
    message: error.message,
    details,
    uiMessage,
  });
});

void test('N2 invalid fillet radius and shell thickness fail before commit; nothing changes', async (t) => {
  await reset('Invalid sizes');
  const { bodyId } = await plate(20, 20, 10);
  const before = store.getState().features;
  const rev = await revision();
  const fillet = await fails(
    call('feature.create', {
      kind: 'fillet',
      params: { edges: [{ bodyId, select: '|Z and >X and >Y' }], radius: 25 },
    }),
    'featureFailed',
  );
  assert.equal((fillet.details as { committed: boolean }).committed, false);
  assert.strictEqual(store.getState().features, before);
  const shell = await fails(
    call('feature.create', {
      kind: 'shell',
      params: { faces: [{ bodyId, select: '>Z' }], thickness: 11 },
    }),
    'featureFailed',
  );
  assert.strictEqual(store.getState().features, before);
  // Exactly half the part: OCCT used to return an invalid, empty solid without an error.
  await fails(
    call('feature.create', {
      kind: 'shell',
      params: { faces: [{ bodyId, select: '>Z' }], thickness: 10 },
    }),
    'featureFailed',
  );
  assert.equal(await revision(), rev);
  const zero = await fails(
    call('feature.create', {
      kind: 'fillet',
      params: { edges: [{ bodyId, select: '|Z and >X and >Y' }], radius: 0 },
    }),
    'invalidParams',
  );
  const valid = (await bodies())[0]!;
  assert.ok(valid.valid);
  near(valid.volume, 20 * 20 * 10, 1e-9, 'the part is untouched');
  evidence(t, 'N2-invalid-sizes', {
    fillet25: { code: fillet.code, message: fillet.message, hint: fillet.hint },
    shell11: { code: shell.code, message: shell.message },
    fillet0: { code: zero.code, message: zero.message },
  });
});

void test('N3 hidden geometry: Select Through offers the occluded face; a feature on it works', async (t) => {
  await reset('Select Through');
  const { bodyId } = await plate(40, 30, 10);
  const evaluation = store.getState().evaluation;
  // Looking straight down at the plate centre: the top face is visible, the bottom hidden.
  const ray = {
    origin: [20, 15, 50] as [number, number, number],
    direction: [0, 0, -1] as [number, number, number],
  };
  const hits = rayCastFaces(evaluation.bodies, ray);
  const top = hits[0]!;
  const input = {
    visible: [{ kind: 'face' as const, bodyId, faceKey: top.faceKey }],
    rayFaces: hits,
    nearEdges: [],
  };
  const names = {
    bodies: evaluation.bodies,
    sketches: [],
    bodyName: () => 'Plate',
    sketchName: () => 'Sketch',
  };
  const without = collectCandidates({ ...input, selectThrough: false }, names);
  assert.deepEqual(
    without.map((c) => c.occluded),
    [false],
    'without Select Through only the visible face',
  );
  const through = collectCandidates({ ...input, selectThrough: true }, names);
  const hidden = through.find((c) => c.occluded && c.kind === 'face');
  assert.ok(hidden, 'Select Through offers the face behind');
  assert.ok(isAmbiguous(through, true), 'and asks which one');
  // Choosing it selects the hidden bottom face; a shell opening it is a valid feature.
  store.getState().select(hidden.item);
  const selected = store.getState().selection[0] as { faceKey: string };
  const bottom = await call<{ key: string; normal: number[] }[]>('faces.list', {
    bodyId,
    select: '<Z',
  });
  assert.equal(selected.faceKey, bottom[0]!.key, 'the selection is the bottom face');
  const shell = await call<{ errors: Json }>('feature.create', {
    kind: 'shell',
    params: { faces: [{ bodyId, key: selected.faceKey }], thickness: 2 },
  });
  assert.deepEqual(shell.errors, {});
  near((await bodies())[0]!.volume, 40 * 30 * 10 - 36 * 26 * 8, 1e-6, 'shelled from below');
  evidence(t, 'N3-select-through', {
    candidatesWithout: without.map((c) => c.label),
    candidatesThrough: through.map((c) => `${c.label}${c.occluded ? ' (behind)' : ''}`),
    selected: selected.faceKey,
  });
});

void test('N4 edits before referenced features: the fillet follows an earlier width change; a removed edge gives a clear error', async (t) => {
  await reset('Early edits');
  const { sketchId, bodyId } = await plate(40, 30, 10);
  const boss = await call<{ featureId: string }>('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'face', face: { bodyId, select: '>Z' } },
      profiles: [{ kind: 'circle', cx: 20, cy: 15, radius: 5 }],
    },
  });
  const bossExtrude = await call<{ featureId: string }>('feature.create', {
    kind: 'extrude',
    params: {
      profile: { kind: 'sketch', featureId: boss.featureId },
      distance: 6,
      operation: 'join',
      targetBodyId: bodyId,
    },
  });
  // Round the plate's front top edge (y = 0) and the boss rim.
  const front = await call<{ featureId: string }>('feature.create', {
    kind: 'fillet',
    params: { edges: [{ bodyId, select: '|X and <Y and >Z' }], radius: 2 },
  });
  const rim = await call<{ key: string }[]>('edges.list', { bodyId, select: '%CIRCLE and >Z' });
  const rimFillet = await call<{ featureId: string }>('feature.create', {
    kind: 'fillet',
    params: { edges: [{ bodyId, key: rim[0]!.key }], radius: 1 },
  });
  const filletRefs = () =>
    (
      store.getState().features.find((f) => f.id === front.featureId) as unknown as {
        edges: { key: string }[];
      }
    ).edges.map((e) => e.key);
  const keysBefore = filletRefs();

  // Widen the base sketch (step 1 of 6): the fillets downstream re-bind and stay valid.
  const sketch = await call<{ params: { dimensions: { name: string; value: number }[] } }>(
    'feature.get',
    { featureId: sketchId },
  );
  const widthName = sketch.params.dimensions.find((d) => Math.abs(d.value - 40) < 1e-9)!.name;
  const widened = await call<{ errors: Json }>('sketch.setDimension', {
    featureId: sketchId,
    dimension: widthName,
    value: 60,
  });
  assert.deepEqual(widened.errors, {}, 'no feature fails after the early edit');
  assert.deepEqual(filletRefs(), keysBefore, 'the fillet keeps its stable edge key');
  const body = (await bodies())[0]!;
  assert.ok(body.valid);
  // Rim round (r = 1 on the Ø10 boss) by Pappus: spandrel area (1 − π/4)·r² whose centroid
  // lies (10 − 3π)/(12 − 3π)·r inside the corner, revolved about the boss axis.
  const r = 1;
  const spandrel = (1 - Math.PI / 4) * r * r;
  const centroid = 5 - ((10 - 3 * Math.PI) / (12 - 3 * Math.PI)) * r;
  const expected =
    60 * 30 * 10 + Math.PI * 25 * 6 - (4 - Math.PI) * 60 - 2 * Math.PI * centroid * spandrel;
  assert.ok(Math.abs(body.bbox.size[0]! - 60) < 1e-9, 'the part is 60 wide');
  near(body.volume, expected, 1e-6, 'volume after the early edit');

  // Remove the boss (an earlier step the rim fillet references): a clear error names it.
  const deleted = await call<{ errors: Record<string, string> }>('feature.delete', {
    featureId: bossExtrude.featureId,
  });
  const message = deleted.errors[rimFillet.featureId];
  assert.ok(message, 'the rim fillet reports an error');
  assert.match(message, /edge|reference|not found|missing|no longer/i);
  assert.equal(deleted.errors[front.featureId], undefined, 'the other fillet is unaffected');
  // The error is visible to agents (features.list) and undo restores the working state.
  const listed = await call<{ id: string; error?: string }[]>('features.list');
  assert.equal(listed.find((f) => f.id === rimFillet.featureId)!.error, message);
  await call('history.undo');
  assert.deepEqual(store.getState().evaluation.errors, {});
  evidence(t, 'N4-early-edits', {
    edgeKeyKept: keysBefore,
    widenedTo: 60,
    volumeAfterWiden: body.volume,
    deleteBossError: message,
  });
});
