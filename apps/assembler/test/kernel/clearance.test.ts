/**
 * Clearance between bodies (`geometry-kernel/clearance.ts`, evaluator
 * `measureClearance`): exact gap, contact, overlap with the shared volume,
 * a body inside another, the time budget, and missing bodies.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtrudeFeature, Feature } from '../../renderer/src/foundation/document/document.js';
import { rect, sketchFeature } from '../sketch/fixtures.js';
import { createNodeKernelAdapter, loadNodeKernel } from './nodeKernel.js';

function box(id: string, x: number, y: number, size: number, height = 10, z = 0): Feature[] {
  const { feature } = sketchFeature(`s-${id}`, [rect(x, y, size, size)], {
    kind: 'plane',
    plane: 'XY',
    offset: z,
  });
  const extrude: ExtrudeFeature = {
    id,
    name: id,
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: feature.id },
    distance: height,
    symmetric: false,
    operation: 'new',
  };
  return [feature, extrude];
}

const features = [
  ...box('a', 0, 0, 10),
  ...box('gap', 10.3, 0, 10), // 0.3 mm to the right of a
  ...box('touch', -10, 0, 10), // shares a face with a
  ...box('over', 5, 5, 10), // 5 × 5 × 10 = 250 mm³ inside a
  ...box('inner', 2, 2, 3, 3, 4), // 3 × 3 × 3 inside a, touching nothing
];

async function evaluator() {
  const { evaluator } = await loadNodeKernel();
  assert.ok(evaluator.measureClearance);
  return evaluator as Required<typeof evaluator>;
}

void test('measureClearance: gap, contact, overlap volume and a body inside another', async () => {
  const kernel = await evaluator();
  const result = await kernel.measureClearance(features, {
    pairs: [
      { a: 'body:a', b: 'body:gap' },
      { a: 'body:a', b: 'body:touch' },
      { a: 'body:a', b: 'body:over' },
      { a: 'body:a', b: 'body:inner' },
    ],
  });
  const [gap, touch, over, inner] = result.pairs;
  assert.equal(result.skipped.length, 0);
  assert.equal(gap!.relation, 'clear');
  assert.ok(Math.abs(gap!.distance - 0.3) < 1e-9, `gap ${gap!.distance}`);
  assert.ok(Math.abs(gap!.pointA[0] - 10) < 1e-9 && Math.abs(gap!.pointB[0] - 10.3) < 1e-9);
  assert.equal(gap!.overlapVolume, 0);

  assert.equal(touch!.relation, 'contact');
  assert.equal(touch!.distance, 0);
  assert.ok((touch!.overlapVolume ?? 1) < 1e-3, `contact volume ${touch!.overlapVolume}`);

  assert.equal(over!.relation, 'overlap');
  assert.ok(Math.abs(over!.overlapVolume! - 250) < 1e-6, `overlap ${over!.overlapVolume}`);
  // The centre of the shared 5 × 5 × 10 block.
  assert.deepEqual(
    over!.overlapCenter!.map((v) => Math.round(v * 1e6) / 1e6),
    [7.5, 7.5, 5],
  );

  assert.equal(inner!.relation, 'overlap');
  assert.ok(Math.abs(inner!.overlapVolume! - 27) < 1e-6, `inner ${inner!.overlapVolume}`);
});

void test('measureClearance: without overlap volumes, contact is reported unmeasured', async () => {
  const kernel = await evaluator();
  const result = await kernel.measureClearance(features, {
    pairs: [{ a: 'body:a', b: 'body:touch' }],
    overlap: false,
  });
  assert.equal(result.pairs[0]!.relation, 'contact');
  assert.equal(result.pairs[0]!.overlapVolume, null);
});

void test('measureClearance: the time budget skips the remaining pairs', async () => {
  const kernel = await evaluator();
  const result = await kernel.measureClearance(features, {
    pairs: [
      { a: 'body:a', b: 'body:over' },
      { a: 'body:a', b: 'body:gap' },
      { a: 'body:gap', b: 'body:touch' },
    ],
    budgetMs: 0,
  });
  // The first pair always runs; the budget is checked between pairs.
  assert.equal(result.pairs.length, 1);
  assert.deepEqual(result.skipped, [
    { a: 'body:a', b: 'body:gap' },
    { a: 'body:gap', b: 'body:touch' },
  ]);
});

void test('measureClearance: a missing body fails with a readable message', async () => {
  const kernel = await evaluator();
  await assert.rejects(
    kernel.measureClearance(features, { pairs: [{ a: 'body:a', b: 'body:nope' }] }),
    /Missing body "body:nope"/,
  );
});

void test('measureClearance: through the in-process adapter', async () => {
  const adapter = createNodeKernelAdapter();
  try {
    const result = await adapter.measureClearance(features, {
      pairs: [{ a: 'body:gap', b: 'body:touch' }],
    });
    assert.equal(result.pairs[0]!.relation, 'clear');
    assert.ok(Math.abs(result.pairs[0]!.distance - 10.3) < 1e-9);
  } finally {
    adapter.dispose();
  }
});
