import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextualPointcloudPayload,
  pointcloudSourceRequirementReason,
} from '../renderer/src/pointcloudSourcePredicates.js';

void test('Pointcloud ribbon actions explain a missing resident cloud before launch', () => {
  assert.equal(pointcloudSourceRequirementReason(false), 'Select one resident point cloud.');
  assert.equal(pointcloudSourceRequirementReason(true), undefined);
  assert.equal(pointcloudSourceRequirementReason(undefined), undefined);
});

void test('Builder entity context commands retain the invoked point-cloud target', () => {
  assert.deepEqual(contextualPointcloudPayload(['cloud-invoked']), {
    entityIds: ['cloud-invoked'],
    sourceEntityId: 'cloud-invoked',
  });
  assert.deepEqual(contextualPointcloudPayload(['cloud-a', 'cloud-b']), {
    entityIds: ['cloud-a', 'cloud-b'],
  });
});
