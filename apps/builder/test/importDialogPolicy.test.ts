import assert from 'node:assert/strict';
import test from 'node:test';

import {
  droppedImportPaths,
  importStageNeedsFurtherInput,
  registeredImportExtensions,
} from '../renderer/src/importDialogPolicy.js';

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

void test('general import uses every registered reader extension in the native picker', () => {
  assert.deepEqual(
    registeredImportExtensions([
      { extensions: ['.LAS', '.laz', '.e57'] },
      { extensions: ['.dxf', '.las', '../unsafe'] },
    ]),
    ['dxf', 'e57', 'las', 'laz'],
  );
});

void test('viewport drops resolve through the Electron file-path bridge', () => {
  const las = { name: 'road.las' } as File;
  const e57 = { name: 'station.e57' } as File;
  assert.deepEqual(
    droppedImportPaths([las, e57], (file) => `/survey/${file.name}`),
    ['/survey/road.las', '/survey/station.e57'],
  );
});
