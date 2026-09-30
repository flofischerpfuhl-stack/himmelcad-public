import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRect } from '../../renderer/src/viewport/boxSelect.js';
import { addRectangle } from '../../renderer/src/foundation/sketch-solver/builders.js';
import { EMPTY_SKETCH } from '../../renderer/src/foundation/sketch-solver/types.js';
import {
  nextSketchBoxFilter,
  sketchBoxFilterForKey,
  sketchBoxSelect,
} from '../../renderer/src/sketch/ui/sketchBoxSelect.js';

// A 10 x 10 rectangle at the origin; screen = (u, -v).
const sketch = addRectangle(EMPTY_SKETCH, [0, 0], [10, 10]).sketch;
const toScreen = (uv: readonly [number, number]) => [uv[0], -uv[1]] as const;
const curves = sketch.entities.filter((e) => e.kind !== 'point').map((e) => e.id);
const points = sketch.entities.filter((e) => e.kind === 'point').map((e) => e.id);

void test('sketch window box selects enclosed entities only', () => {
  const all = sketchBoxSelect(sketch, normalizeRect(-1, 1, 11, -11), 'window', 'all', toScreen);
  assert.deepEqual(all.sort(), [...curves, ...points].sort());
  // A box around the bottom edge only: the bottom line and its two corner points.
  const bottom = sketchBoxSelect(sketch, normalizeRect(-1, 1, 11, -1), 'window', 'all', toScreen);
  assert.equal(bottom.filter((id) => curves.includes(id)).length, 1);
  assert.equal(bottom.filter((id) => points.includes(id)).length, 2);
});

void test('sketch crossing box selects touched curves; filters restrict the kinds', () => {
  const rect = normalizeRect(4, -4, 6, -12); // crosses the bottom? no: from v=4 up to v=12 → top line
  const touched = sketchBoxSelect(sketch, rect, 'crossing', 'curves', toScreen);
  assert.equal(touched.length, 1);
  const none = sketchBoxSelect(sketch, rect, 'crossing', 'points', toScreen);
  assert.deepEqual(none, []);
  assert.equal(nextSketchBoxFilter('all'), 'curves');
  assert.equal(nextSketchBoxFilter('all', true), 'points');
  assert.equal(sketchBoxFilterForKey('e'), 'curves');
  assert.equal(sketchBoxFilterForKey('p'), 'points');
  assert.equal(sketchBoxFilterForKey('b'), null);
});
