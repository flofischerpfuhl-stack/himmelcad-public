import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  selectWorstResidualImageForPoint,
  // @ts-expect-error Node's strip-types test runner loads the TypeScript source directly.
} from './gcpAccuracyNavigation.ts';

describe('GCP accuracy navigation', () => {
  it('selects the image with the worst residual for the requested point', () => {
    assert.equal(
      selectWorstResidualImageForPoint(
        'gcp-1',
        [
          { pointId: 'gcp-1', imageId: 10, residualPixels: 0.8 },
          { pointId: 'gcp-2', imageId: 20, residualPixels: 9.2 },
          { pointId: 'gcp-1', imageId: 30, residualPixels: 2.4 },
        ],
        [10, 30],
      ),
      30,
    );
  });

  it('keeps the first snapshot image when worst residuals tie', () => {
    assert.equal(
      selectWorstResidualImageForPoint(
        'gcp-1',
        [
          { pointId: 'gcp-1', imageId: 30, residualPixels: 2.4 },
          { pointId: 'gcp-1', imageId: 10, residualPixels: 2.4 },
        ],
        [10, 30],
      ),
      30,
    );
  });

  it('falls back to the first observed image when per-image data is missing', () => {
    assert.equal(selectWorstResidualImageForPoint('gcp-1', [], [40, 50]), 40);
    assert.equal(
      selectWorstResidualImageForPoint(
        'gcp-1',
        [
          { pointId: 'gcp-2', imageId: 60, residualPixels: 3.1 },
          { pointId: 'gcp-1', imageId: 70, residualPixels: Number.NaN },
          { pointId: 'gcp-1', imageId: 80, residualPixels: null },
        ],
        [40, 50],
      ),
      40,
    );
    assert.equal(selectWorstResidualImageForPoint('gcp-1', [], []), null);
  });
});
