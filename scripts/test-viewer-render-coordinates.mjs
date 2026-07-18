import assert from 'node:assert/strict';

import {
  MAX_RENDER_LOCAL_COMPONENT_METERS,
  isFiniteCoordinate3,
  toRenderLocal,
} from '../packages/@himmelcad/viewer/src/spatial/renderCoordinates.ts';

// Canonical PhotoLab axis contract: X=Easting, Y=Northing, Z=Height.
assert.deepEqual(
  toRenderLocal([4_375_050, 5_281_025, 735], [4_375_000, 5_281_000, 700]),
  [50, 25, 35],
);

assert.equal(isFiniteCoordinate3([Number.NaN, 0, 0]), false);
assert.equal(toRenderLocal([Number.POSITIVE_INFINITY, 0, 0], [0, 0, 0]), null);

// Reconstruction-local data passed as projected world coordinates must never
// reach WebGL: this is the failure that caused orbit flicker at UTM/GK scale.
assert.equal(toRenderLocal([20, -10, 5], [4_375_000, 5_281_000, 700]), null);

assert.deepEqual(toRenderLocal([MAX_RENDER_LOCAL_COMPONENT_METERS, 0, 0], [0, 0, 0]), [
  MAX_RENDER_LOCAL_COMPONENT_METERS,
  0,
  0,
]);
assert.equal(toRenderLocal([MAX_RENDER_LOCAL_COMPONENT_METERS + 1, 0, 0], [0, 0, 0]), null);

console.log('viewer render-coordinate contract: ok');
