import assert from 'node:assert/strict';
import test from 'node:test';

import { importStageNeedsFurtherInput } from '../renderer/src/importDialogPolicy.js';

void test('import modal remains only while registration still needs user input', () => {
  assert.equal(importStageNeedsFurtherInput('sourceCoordinates'), false);
  for (const interactive of [
    'originAndProjectNorth',
    'manualPlacement',
    'pointPairs',
    'icp',
  ] as const) {
    assert.equal(importStageNeedsFurtherInput(interactive), true);
  }
});
