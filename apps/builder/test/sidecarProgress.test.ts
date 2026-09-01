import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSidecarProgress } from '../renderer/src/sidecarProgress.js';

test('parses structured sidecar progress embedded in a stderr line', () => {
  assert.deepEqual(
    parseSidecarProgress(
      'prefix __HC_PROGRESS__{"progressKey":"registration-1","fraction":0.625,"message":"Importing points"}',
    ),
    {
      progressKey: 'registration-1',
      fraction: 0.625,
      message: 'Importing points',
    },
  );
});

test('clamps structured progress and rejects tracing-only diagnostics', () => {
  assert.equal(
    parseSidecarProgress(
      '__HC_PROGRESS__{"progressKey":"registration-1","fraction":1.25,"message":"Done"}',
    )?.fraction,
    1,
  );
  assert.equal(
    parseSidecarProgress(
      'canonical import progress phase="hash" completed=9000 total=10000 hashing dataset',
    ),
    null,
  );
});
