import assert from 'node:assert/strict';
import test from 'node:test';

import { importRegistrationProfile } from '../src/importRegistrationProfile.js';

test('point-cloud formats expose fresh point picking and bounded ICP', () => {
  for (const formatId of ['las@1.4', 'laz@1.4', 'e57@1.0']) {
    const profile = importRegistrationProfile(formatId);
    assert.equal(profile.family, 'pointCloud');
    assert.equal(profile.pointPicking, true);
    assert.equal(profile.recommendedMethod, 'pointPairs');
    assert.ok(profile.methods.includes('icp'));
  }
});

test('format profiles constrain methods to meaningful registration choices', () => {
  assert.deepEqual(importRegistrationProfile('geotiff@1.1').methods, [
    'sourceCoordinates',
    'manualPlacement',
    'pointPairs',
  ]);
  assert.equal(
    importRegistrationProfile('hcad.format.ifc4x3-spf@1').recommendedMethod,
    'originAndProjectNorth',
  );
  assert.equal(importRegistrationProfile('landxml@1.2').family, 'civil');
  assert.equal(importRegistrationProfile('slpk-i3s-common-mesh@1').family, 'sceneLayer');
});
