import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { spatialCheckpointIds, type CheckpointSuggestionPoint } from './gcpCheckpointSuggestion.js';

function point(
  id: string,
  eastMeters: number,
  northMeters = 0,
  heightMeters = 0,
): CheckpointSuggestionPoint {
  return { id, coordinate: { eastMeters, northMeters, heightMeters } };
}

describe('spatialCheckpointIds', () => {
  it('does not suggest check points for fewer than four points', () => {
    assert.deepEqual(spatialCheckpointIds([]), []);
    assert.deepEqual(spatialCheckpointIds([point('a', 0), point('b', 1), point('c', 2)]), []);
  });

  it('selects the middle point when one check point is suggested', () => {
    assert.deepEqual(
      spatialCheckpointIds([
        point('west', -20),
        point('middle-west', -10),
        point('middle-east', 10),
        point('east', 20),
      ]),
      ['middle-east'],
    );
  });

  it('is deterministic regardless of input order', () => {
    const points = Array.from({ length: 15 }, (_, index) =>
      point(`point-${index.toString().padStart(2, '0')}`, index % 5, Math.floor(index / 5)),
    );
    const expected = ['point-00', 'point-07', 'point-14'];

    assert.deepEqual(spatialCheckpointIds(points), expected);
    assert.deepEqual(spatialCheckpointIds([...points].reverse()), expected);
  });

  it('caps the suggestion at ten points', () => {
    const points = Array.from({ length: 100 }, (_, index) => point(`point-${index}`, index));
    assert.equal(spatialCheckpointIds(points).length, 10);
  });
});
