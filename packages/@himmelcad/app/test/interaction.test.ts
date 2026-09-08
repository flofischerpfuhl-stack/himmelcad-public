import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConstructionInputController,
  InteractionStateStore,
  pointFromPolar,
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
