import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalViewingBoxCommandId,
  setViewingBoxExtent,
  viewingBoxExtents,
  viewingBoxFromViewportDrag,
} from '../renderer/src/viewingBoxWorkflow.js';

void test('legacy SDK viewing_box methods resolve to the canonical view.box command rows', () => {
  assert.equal(canonicalViewingBoxCommandId('viewing_box.activate'), 'view.box.activate');
  assert.equal(canonicalViewingBoxCommandId('viewing_box.lock'), 'view.box.lock');
  assert.equal(canonicalViewingBoxCommandId('view.camera.undo'), 'view.camera.undo');
});

void test('typed min/max extents preserve the opposite face', () => {
  const initial = box();
  const resized = setViewingBoxExtent(initial, 'max', 'x', 14);
  assert.deepEqual(viewingBoxExtents(resized), {
    min: { x: -5, y: -5, z: -5 },
    max: { x: 14, y: 5, z: 5 },
  });
});

void test('viewport drag creates exact planar bounds and retains edge-on depth', () => {
  const initial = box();
  const dragged = viewingBoxFromViewportDrag(
    initial,
    { x: 10, y: 20, z: 7 },
    { x: 30, y: 50, z: 7 },
  );
  assert.deepEqual(dragged.center, { x: 20, y: 35, z: 0 });
  assert.deepEqual(dragged.halfExtents, { x: 10, y: 15, z: 5 });
  assert.deepEqual(dragged.rotation, [0, 0, 0, 1]);
});

function box() {
  return {
    id: 'box-a',
    center: { x: 0, y: 0, z: 0 },
    halfExtents: { x: 5, y: 5, z: 5 },
    rotation: [0, 0, 0, 1] as const,
    mode: 'resize' as const,
    enabled: true,
    operation: 'keepInside' as const,
    lockMode: 'unlocked' as const,
    bakeKey: null,
  };
}
