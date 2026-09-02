import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_VIDEO_FRAME_PLAN,
  summarizeVideoFramePlan,
  validateVideoFramePlan,
  // @ts-expect-error Node's strip-types test runner loads the TypeScript source directly.
} from './videoFramePlan.ts';

describe('video frame plan', () => {
  it('maps the UI defaults to the complete sidecar selection policy', () => {
    const result = validateVideoFramePlan(DEFAULT_VIDEO_FRAME_PLAN);
    assert.equal(result.valid, true);
    if (!result.valid) return;
    assert.deepEqual(result.value.policy, {
      maximumFrames: 1000,
      minimumIntervalMicroseconds: 250_000,
      minimumWidthPixels: 640,
      minimumHeightPixels: 480,
      minimumSharpness: 0.02,
      maximumMotion: 0.8,
      minimumOverlap: 0.2,
      maximumOverlap: 0.98,
    });
    assert.equal(
      result.value.summary,
      'Up to 1,000 frames · at least 0.25 s apart · sharpness ≥ 0.02',
    );
  });

  it('rejects fractional frame counts and out-of-range gates', () => {
    const result = validateVideoFramePlan({
      intervalSeconds: '0',
      maximumFrames: '12.5',
      minimumSharpness: '1.1',
    });
    assert.equal(result.valid, false);
    if (result.valid) return;
    assert.deepEqual(Object.keys(result.errors).sort(), [
      'intervalSeconds',
      'maximumFrames',
      'minimumSharpness',
    ]);
  });

  it('summarizes whole-second intervals without trailing decimals', () => {
    assert.equal(
      summarizeVideoFramePlan({
        maximumFrames: 24,
        minimumIntervalMicroseconds: 2_000_000,
        minimumWidthPixels: 640,
        minimumHeightPixels: 480,
        minimumSharpness: 0.1,
        maximumMotion: 0.8,
        minimumOverlap: 0.2,
        maximumOverlap: 0.98,
      }),
      'Up to 24 frames · at least 2 s apart · sharpness ≥ 0.10',
    );
  });
});
