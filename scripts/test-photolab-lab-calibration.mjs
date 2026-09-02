import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_LAB_CALIBRATION,
  validateLabCalibration,
} from '../apps/photolab/renderer/src/labCalibration.ts';

const valid = {
  f: '3713.5',
  cx: '2640',
  cy: '1978',
  k1: '-0.1',
  k2: '-0.002',
  k3: '-0.015',
  p1: '0.0003',
  p2: '-0.0004',
  policy: 'fixed',
};
const dimensions = { widthPixels: 5280, heightPixels: 3956 };

test('lab calibration uses absolute principal-point pixels and full Brown parameters', () => {
  const result = validateLabCalibration(valid, dimensions);
  assert.deepEqual(result.errors, {});
  assert.equal(result.initialCalibration?.principalXPixels, 2640);
  assert.equal(result.initialCalibration?.principalYPixels, 1978);
  assert.deepEqual(
    result.initialCalibration?.fullBrownCalibration?.radialDistortion,
    [-0.1, -0.002, -0.015],
  );
  assert.deepEqual(result.intrinsicsPolicy, { kind: 'fixed' });
});

test('lab calibration rejects non-positive focal length and implausible distortion', () => {
  const result = validateLabCalibration({ ...valid, f: '0', k1: '11', p2: '-1.1' }, dimensions);
  assert.match(result.errors.f ?? '', /greater than 0/);
  assert.match(result.errors.k1 ?? '', /between -10 and 10/);
  assert.match(result.errors.p2 ?? '', /between -1 and 1/);
  assert.equal(result.initialCalibration, undefined);
});

test('lab calibration requires every value, dimensions, and an in-image principal point', () => {
  const incomplete = validateLabCalibration(EMPTY_LAB_CALIBRATION, undefined);
  assert.equal(Object.keys(incomplete.errors).length, 9);
  const outside = validateLabCalibration({ ...valid, cx: '5281', cy: '-1' }, dimensions);
  assert.match(outside.errors.cx ?? '', /inside the image width/);
  assert.match(outside.errors.cy ?? '', /inside the image height/);
});

test('prior policy refines all entered parameters from the frozen seed', () => {
  const result = validateLabCalibration({ ...valid, policy: 'prior' }, dimensions);
  assert.equal(result.intrinsicsPolicy?.kind, 'prior');
  if (result.intrinsicsPolicy?.kind !== 'prior') assert.fail('expected prior policy');
  assert.ok(Object.values(result.intrinsicsPolicy.parameters).every(Boolean));
});
