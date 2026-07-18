import assert from 'node:assert/strict';
import { stdout } from 'node:process';

import { buildCaptureCalibrationDrafts } from '../apps/photolab/renderer/src/captureGroupDraft.ts';

const cameras = [{ entityId: 'camera-a' }, { entityId: 'camera-b' }, { entityId: 'camera-c' }];
const groups = buildCaptureCalibrationDrafts(cameras, ['Before landing', 'After landing'], {
  'camera-a': 0,
  'camera-b': 0,
  'camera-c': 1,
});

assert.deepEqual(groups, [
  {
    name: 'Before landing',
    cameraEntityIds: ['camera-a', 'camera-b'],
    groupingBasis: 'missionAutofocus',
  },
  {
    name: 'After landing',
    cameraEntityIds: ['camera-c'],
    groupingBasis: 'missionAutofocus',
  },
]);
assert.equal(new Set(groups.flatMap((group) => group.cameraEntityIds)).size, cameras.length);
assert.equal(groups.flatMap((group) => group.cameraEntityIds).length, cameras.length);

stdout.write('PhotoLab capture-group partition test passed.\n');
