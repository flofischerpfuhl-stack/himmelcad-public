import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalSelectionBounds } from '../renderer/src/selectionBounds.js';

void test('Viewing Box From selection derives exact bounds from a canonical boundary', () => {
  const result = canonicalSelectionBounds(
    new Set(['boundary-a']),
    [
      {
        entityId: 'boundary-a',
        vertices: [
          { x: 2_538_170, y: 5_486_660, z: 380 },
          { x: 2_538_180, y: 5_486_662, z: 384 },
          { x: 2_538_176, y: 5_486_670, z: 390 },
        ],
      },
    ],
    [],
  );
  assert.deepEqual(result, {
    bounds: {
      min: [2_538_170, 5_486_660, 380],
      max: [2_538_180, 5_486_670, 390],
    },
    hasUnknownHeight: false,
  });
});

void test('Viewing Box From selection includes fixed and attached measurement anchors', () => {
  const result = canonicalSelectionBounds(
    new Set(['measurement-a']),
    [],
    [
      {
        entityId: 'measurement-a',
        measurement: {
          anchors: [
            { binding: 'fixed', position: { x: 10, y: 20, z: 30 } },
            {
              binding: 'attached',
              entityId: 'cloud-a',
              expectedRevision: 3,
              expectedVersionHash: 'ab'.repeat(32),
              providerId: 'potree@2',
              representationId: 'source',
              primitiveAddress: 'r:4',
              sourceParameter: null,
              exactSourcePosition: { x: 14, y: 26, z: 38 },
              offset: { x: 1, y: -1, z: 2 },
            },
          ],
        },
      },
    ],
  );
  assert.deepEqual(result.bounds, { min: [10, 20, 30], max: [15, 25, 40] });
  assert.equal(result.hasUnknownHeight, false);
});

void test('Viewing Box From selection refuses plan-only canonical geometry without inventing Z', () => {
  const result = canonicalSelectionBounds(
    new Set(['polyline-a']),
    [{ entityId: 'polyline-a', vertices: [{ x: 1, y: 2, z: null }] }],
    [],
  );
  assert.deepEqual(result, { bounds: null, hasUnknownHeight: true });
});
