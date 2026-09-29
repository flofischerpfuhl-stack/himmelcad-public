import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addVec3,
  closestPointOnLineToRay,
  crossVec3,
  dotVec3,
  identityMat4,
  invertMat4,
  lookAtMat4,
  multiplyMat4,
  normalizeVec3,
  perspectiveMat4,
  projectToScreen,
  rayPlaneIntersect,
  transformPoint4,
  unprojectRay,
} from '../../renderer/src/viewport/math.js';

void test('multiplyMat4 with identity is a no-op', () => {
  const m = perspectiveMat4(Math.PI / 4, 1.5, 0.1, 100);
  const result = multiplyMat4(m, identityMat4());
  for (let i = 0; i < 16; i += 1) assert.ok(Math.abs(result[i]! - m[i]!) < 1e-9);
});

void test('invertMat4 undoes lookAtMat4 (round trip on a point)', () => {
  const view = lookAtMat4([0, -10, 0], [0, 0, 0], [0, 0, 1]);
  const inv = invertMat4(view);
  assert.ok(inv !== null);
  const p = transformPoint4(view!, [1, 2, 3]);
  const back = transformPoint4(inv!, [p.x, p.y, p.z]);
  assert.ok(Math.abs(back.x - 1) < 1e-4);
  assert.ok(Math.abs(back.y - 2) < 1e-4);
  assert.ok(Math.abs(back.z - 3) < 1e-4);
});

void test('invertMat4 returns null for a singular matrix', () => {
  const singular = new Float32Array(16); // all zeros
  assert.equal(invertMat4(singular), null);
});

void test('projectToScreen maps the view-space origin to the screen center', () => {
  const view = lookAtMat4([0, -10, 0], [0, 0, 0], [0, 0, 1]);
  const proj = perspectiveMat4(Math.PI / 4, 1, 0.1, 100);
  const vp = multiplyMat4(proj, view);
  const screen = projectToScreen(vp, [0, 0, 0], 800, 600);
  assert.ok(screen !== null);
  assert.ok(Math.abs(screen![0] - 400) < 1);
  assert.ok(Math.abs(screen![1] - 300) < 1);
});

void test('projectToScreen returns null for a point behind the eye', () => {
  const view = lookAtMat4([0, -10, 0], [0, 0, 0], [0, 0, 1]);
  const proj = perspectiveMat4(Math.PI / 4, 1, 0.1, 100);
  const vp = multiplyMat4(proj, view);
  const screen = projectToScreen(vp, [0, -50, 0], 800, 600);
  assert.equal(screen, null);
});

void test('unprojectRay from the screen center points toward the camera target', () => {
  const view = lookAtMat4([0, -10, 0], [0, 0, 0], [0, 0, 1]);
  const proj = perspectiveMat4(Math.PI / 4, 1, 0.1, 100);
  const vp = multiplyMat4(proj, view);
  const ray = unprojectRay(vp, 400, 300, 800, 600);
  assert.ok(ray !== null);
  // Direction should point roughly along +Y (from eye at -Y towards the origin).
  assert.ok(ray!.direction[1] > 0.9);
});

void test('rayPlaneIntersect finds the ground hit for a straight-down ray', () => {
  const hit = rayPlaneIntersect([0, 0, 10], [0, 0, -1], [0, 0, 0], [0, 0, 1]);
  assert.ok(hit !== null);
  assert.ok(Math.abs(hit![0]) < 1e-9);
  assert.ok(Math.abs(hit![1]) < 1e-9);
  assert.ok(Math.abs(hit![2]) < 1e-9);
});

void test('rayPlaneIntersect returns null for a ray parallel to the plane', () => {
  const hit = rayPlaneIntersect([0, 0, 10], [1, 0, 0], [0, 0, 0], [0, 0, 1]);
  assert.equal(hit, null);
});

void test('rayPlaneIntersect returns null when the intersection is behind the ray origin', () => {
  const hit = rayPlaneIntersect([0, 0, -10], [0, 0, -1], [0, 0, 0], [0, 0, 1]);
  assert.equal(hit, null);
});

void test('closestPointOnLineToRay recovers the exact drag distance along an axis', () => {
  // A ray from directly "above" a point on the X axis, looking straight down,
  // should recover that point's X coordinate as the line parameter.
  const t = closestPointOnLineToRay([0, 0, 0], [1, 0, 0], [12.5, 0, 10], [0, 0, -1]);
  assert.ok(Math.abs(t - 12.5) < 1e-6);
});

void test('vector helpers: dot/cross/normalize/add are internally consistent', () => {
  const a = normalizeVec3([3, 4, 0]);
  assert.ok(Math.abs(dotVec3(a, a) - 1) < 1e-9);
  const cross = crossVec3([1, 0, 0], [0, 1, 0]);
  assert.deepEqual(cross, [0, 0, 1]);
  const sum = addVec3([1, 2, 3], [4, 5, 6]);
  assert.deepEqual(sum, [5, 7, 9]);
});
