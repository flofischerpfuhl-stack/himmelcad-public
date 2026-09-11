import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConstructionInputController,
  DrawSnapLatencyRing,
  DrawToolController,
  InteractionStateStore,
  pointAcquisition,
  pointFromPolar,
  snapDirectionDegrees,
} from '../src/index.js';

void test('G-B2-P9-TREE propagates, reports mixed, supports node-only changes, and preserves overrides across global defaults', () => {
  const store = new InteractionStateStore([
    { id: 'root', parentId: null, kind: 'project' },
    { id: 'layer', parentId: 'root', kind: 'layer' },
    { id: 'a', parentId: 'layer', kind: 'lines' },
    { id: 'b', parentId: 'layer', kind: 'points' },
  ]);

  assert.deepEqual(store.setRequested(['layer'], 'reference'), ['layer', 'a', 'b']);
  assert.equal(store.presentation('layer'), 'reference');
  store.setRequested(['a'], 'editable', 'node');
  assert.equal(store.presentation('layer'), 'mixed');
  assert.equal(
    store.effective('a').effective,
    'reference',
    'parent remains the permission ceiling',
  );

  store.setRequested(['root'], 'editable', 'node');
  store.setGlobalDefault('hidden');
  assert.equal(
    store.requestedState('a'),
    'editable',
    'global default must not overwrite explicit state',
  );
  assert.equal(store.requestedState('b'), 'reference');
});

void test('G-B2-P9-TREE visible/reference/editable eligibility feeds render, picking and snapping', () => {
  const store = new InteractionStateStore([
    { id: 'root', parentId: null, kind: 'project' },
    { id: 'hidden', parentId: 'root', kind: 'lines' },
    { id: 'reference', parentId: 'root', kind: 'lines' },
    { id: 'editable', parentId: 'root', kind: 'points' },
    { id: 'inert', parentId: 'root', kind: 'points' },
    {
      id: 'raster',
      parentId: 'root',
      kind: 'surfaces',
      capabilities: new Set(['render', 'select']),
    },
  ]);
  store.setRequested(['hidden'], 'hidden', 'node');
  store.setRequested(['reference'], 'reference', 'node');
  store.setRequested(['editable'], 'editable', 'node');
  store.setRequested(['inert'], 'inert', 'node');
  store.setRequested(['raster'], 'reference', 'node');

  assert.deepEqual([...store.visibleSet()].sort(), [
    'editable',
    'inert',
    'raster',
    'reference',
    'root',
  ]);
  assert.deepEqual([...store.pickableSet(new Set(['lines']))], ['reference']);
  assert.equal(store.effective('raster').snappable, false, 'reference is only a ceiling');
  assert.equal(store.snappableSet().has('reference'), true);
  assert.equal(store.effective('inert').selectable, false);
});

void test('G-B2-P9-TREE consumes the S-08 display snapshot without becoming a second history owner', () => {
  const store = new InteractionStateStore([
    { id: 'root', parentId: null, kind: 'project' },
    { id: 'line', parentId: 'root', kind: 'lines' },
  ]);
  store.applyViewDisplayState({
    globalDefault: 'reference',
    overrides: { line: 'editable', stale: 'hidden' },
  });
  assert.equal(store.getGlobalDefault(), 'reference');
  assert.deepEqual(store.requestedOverrides(), { line: 'editable' });
  assert.equal(store.effective('line').effective, 'reference');
});

void test('G-B2-INPUT click, constrain and typed absolute coordinates agree to 1e-6 m', () => {
  const origin = { x: 100, y: 200, z: 10 };
  const target = pointFromPolar(origin, { directionDegrees: 30, distance: 12.5, deltaZ: 2.25 });
  const input = new ConstructionInputController();
  input.arm({
    toolId: 'draw.line',
    prompt: 'Line — pick or type endpoint',
    firstPoint: origin,
    fields: ['x', 'y', 'z', 'direction', 'distance', 'deltaZ'],
  });
  const clicked = input.pointer(target);
  const constrained = input.constrain({ directionDegrees: 30, distance: 12.5, deltaZ: 2.25 });
  const typed = input.typeAbsolute(target);
  for (const axis of ['x', 'y', 'z'] as const) {
    assert.ok(Math.abs(clicked[axis] - constrained[axis]) <= 1e-6);
    assert.ok(Math.abs(typed[axis] - constrained[axis]) <= 1e-6);
  }
});

void test('G-B2-INPUT typed XYZ stays a draft until an explicit commit', () => {
  const input = new ConstructionInputController();
  input.arm({
    toolId: 'draw.boundary',
    prompt: 'Boundary — type or pick vertex',
    fields: ['x', 'y', 'z'],
  });
  input.setField('x', 2_538_126);
  assert.deepEqual(input.snapshot().preview, { x: 2_538_126, y: 0, z: 0 });
  assert.equal(input.snapshot().committedValues.x, 0);
  input.setField('y', 5_486_632.661);
  input.setField('z', 489.158);
  assert.equal(input.snapshot().committedValues.x, 0, 'Tab/field edits must not accept the vertex');
  const point = input.commit();
  assert.deepEqual(point, { x: 2_538_126, y: 5_486_632.661, z: 489.158 });
  assert.equal(input.snapshot().committedValues.x, 2_538_126);
});

void test('G-B2-INPUT first Escape reverts a field and leaves the armed tool for the second Escape rung', () => {
  const input = new ConstructionInputController();
  input.arm({ toolId: 'draw.point', prompt: 'Point', fields: ['x', 'y', 'z'] });
  input.commit();
  input.setField('x', 42);
  assert.equal(input.revertField(), true);
  assert.equal(input.snapshot().values.x, 0);
  assert.equal(
    input.revertField(),
    false,
    'no field edit remains; Escape can continue through the ladder',
  );
  assert.equal(input.snapshot().armed, true);
});

void test('G-DR-INPUT click, 45-degree constraint and typed XYZ converge to 1e-6 m', async () => {
  const writes: unknown[] = [];
  const controller = new DrawToolController(
    {
      write: async (input) => {
        writes.push(input);
        return {
          entityId: input.entityId,
          revision: writes.length - 1,
          commandId: `c${writes.length}`,
        };
      },
      undo: async () => ({ entityId: 'curve-1', revision: null }),
    },
    () => ({ entityId: 'curve-1', name: 'Breakline 1' }),
  );
  const origin = { x: 100, y: 200, z: 10 };
  const target = pointFromPolar(origin, { directionDegrees: 45, distance: 10, deltaZ: 2 });
  controller.arm('polyline', 'breakline');
  controller.pointer({
    kind: 'pick',
    point: origin,
    sourceEntityId: 'cloud-1',
    sourceRevision: 4,
    providerId: 'point-cloud',
    primitiveAddress: 'point:42',
  });
  await controller.acceptPreview();
  await controller.acceptConstraint(44.6, 10, { kind: 'deltaZ', value: 2 });
  const constrained = controller.snapshot().vertices[1]!.point;
  for (const axis of ['x', 'y', 'z'] as const) {
    assert.ok(Math.abs(constrained[axis] - target[axis]) <= 1e-6);
  }
  assert.equal(controller.snapshot().journalWrites, 0, 'accepted vertices remain view-local');
  assert.equal(await controller.finish(), true);
  assert.equal(controller.snapshot().journalWrites, 1);
  assert.equal(
    (writes[0] as { acquisitions: { inputMode: string }[] }).acquisitions[1]!.inputMode,
    'constrained',
  );
});

void test('G-DR-INPUT rejects non-zero slope over zero horizontal run', async () => {
  const controller = new DrawToolController(
    {
      write: async (input) => ({ entityId: input.entityId, revision: 0, commandId: 'c1' }),
      undo: async () => ({ entityId: 'curve-1', revision: null }),
    },
    () => ({ entityId: 'curve-1', name: 'Line 1' }),
  );
  controller.arm('line');
  await controller.acceptTyped({ x: 1, y: 2, z: 3 });
  await assert.rejects(
    controller.acceptConstraint(0, 0, { kind: 'slope', value: 1 }),
    /ZeroRunForSlope/,
  );
});

void test('G-DR-INPUT vertex undo remains local before the one canonical publication', async () => {
  const targets: string[] = [];
  let revision = -1;
  const controller = new DrawToolController(
    {
      write: async (input) => ({
        entityId: input.entityId,
        revision: ++revision,
        commandId: `write-${revision}`,
      }),
      undo: async (commandId) => {
        targets.push(commandId);
        return { entityId: 'curve-1', revision: commandId === 'write-0' ? null : ++revision };
      },
    },
    () => ({ entityId: 'curve-1', name: 'Polyline 1' }),
  );
  controller.arm('polyline');
  await controller.acceptTyped({ x: 0, y: 0, z: 0 });
  await controller.acceptTyped({ x: 1, y: 0, z: 0 });
  await controller.acceptTyped({ x: 2, y: 0, z: 0 });
  await controller.undoVertex();
  await controller.undoVertex();
  assert.deepEqual(targets, []);
  assert.equal(controller.snapshot().entityId, null);
  assert.equal(controller.snapshot().vertices.length, 1);
});

void test('DR-D5 Boundary Close publishes once and a failed close preserves a retryable draft', async () => {
  const writes: { closed: boolean; vertices: readonly unknown[] }[] = [];
  let fail = true;
  const controller = new DrawToolController(
    {
      write: async (input) => {
        writes.push(input);
        if (fail) throw new Error('canonical residency inventory is stale');
        return { entityId: input.entityId, revision: 0, commandId: 'boundary-create' };
      },
      undo: async () => assert.fail('a view-local draft has nothing canonical to undo'),
    },
    () => ({ entityId: 'boundary-1', name: 'Boundary 1' }),
  );
  controller.arm('boundary');
  await controller.acceptTyped({ x: 0, y: 0, z: 1 });
  await controller.acceptTyped({ x: 10, y: 0, z: 2 });
  await controller.acceptTyped({ x: 10, y: 10, z: 3 });
  await assert.rejects(controller.finish(true), /canonical residency inventory is stale/);
  assert.equal(controller.snapshot().armed, true);
  assert.equal(controller.snapshot().vertices.length, 3);
  assert.match(controller.snapshot().error ?? '', /canonical residency inventory is stale/);
  fail = false;
  assert.equal(await controller.finish(true), true);
  assert.equal(controller.snapshot().armed, false);
  assert.equal(controller.snapshot().journalWrites, 1);
  assert.deepEqual(
    writes.map((write) => [write.closed, write.vertices.length]),
    [
      [true, 3],
      [true, 3],
    ],
  );
});

void test('G-DR-INPUT provenance distinguishes exact picks, typed and constrained vertices', () => {
  assert.equal(snapDirectionDegrees(89, 45), 90);
  assert.equal(pointAcquisition({ kind: 'typed', point: { x: 1, y: 2, z: 3 } }).truth, 'typed');
  const pick = pointAcquisition({
    kind: 'pick',
    point: { x: 1, y: 2, z: 3 },
    sourceEntityId: 'cloud',
    sourceRevision: 2,
    providerId: 'point-cloud',
  });
  assert.equal(pick.truth, 'exact');
  assert.equal(pick.sourceEntityId, 'cloud');
});

void test('draw snap latency ring is bounded and reports the V-01 p95 shape', () => {
  const ring = new DrawSnapLatencyRing(4);
  for (const value of [8, 1, 3, 2, 4]) ring.record(value);
  assert.deepEqual(ring.snapshot(), { samples: 4, p95Ms: 4, maximumMs: 4 });
});
