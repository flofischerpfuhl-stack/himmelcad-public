/**
 * Build-plate orientation: rotation maths against the transform feature's
 * own convention, Place on Plate replayed by the real kernel, and the
 * deterministic Auto-orient ranking.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Vec3 } from '../../renderer/src/foundation/document/document.js';
import {
  applyMat3,
  axisAngle,
  eulerXYZ,
  mulMat3,
  placementAffine,
  rankOrientations,
  rotationToDown,
  type Mat3,
} from '../../renderer/src/modules/print/orientation.js';
import {
  orientationInput,
  placeOnPlateFeature,
} from '../../renderer/src/modules/print/placement.js';
import { boxFeatures, chamferedBlock, evaluate, mushroom } from './fixtures.js';

function close(a: readonly number[], b: readonly number[], tol = 1e-9): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= tol);
}

void test('rotationToDown turns any direction into −Z', () => {
  const dirs: Vec3[] = [
    [0, 0, -1],
    [0, 0, 1],
    [1, 0, 0],
    [0, -1, 0],
    [0.3, -0.4, 0.866],
    [-0.577, 0.577, -0.577],
  ];
  for (const d of dirs) {
    const len = Math.hypot(...d);
    const r = rotationToDown(d);
    const down = applyMat3(r, [d[0] / len, d[1] / len, d[2] / len]);
    assert.ok(close(down, [0, 0, -1], 1e-9), `${d.join(',')} -> ${down.join(',')}`);
  }
});

void test('eulerXYZ matches the transform feature convention (Rz·Ry·Rx about the pivot)', () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 200; i += 1) {
    const r: Mat3 = mulMat3(
      axisAngle([random() - 0.5, random() - 0.5, random() - 0.5], random() * 2 * Math.PI),
      axisAngle([random() - 0.5, random() - 0.5, random() - 0.5], random() * Math.PI),
    );
    const angles = eulerXYZ(r);
    const affine = placementAffine({ ...angles, pivot: [1, 2, 3], dx: 0, dy: 0, dz: 0 });
    assert.ok(close(affine.m, r, 1e-7), `case ${i}`);
    // The pivot stays fixed.
    const p = [affine.m[0]! + affine.m[1]! * 2 + affine.m[2]! * 3 + affine.t[0]];
    assert.ok(Math.abs(p[0]! - 1) < 1e-9);
  }
  // Gimbal lock (ry = ±90°).
  const lock = axisAngle([0, 1, 0], Math.PI / 2);
  const angles = eulerXYZ(lock);
  assert.ok(
    close(placementAffine({ ...angles, pivot: [0, 0, 0], dx: 0, dy: 0, dz: 0 }).m, lock, 1e-9),
  );
});

void test('Place on Plate: the kernel replays the transform; the face lies on Z = 0 facing −Z', async () => {
  const base = boxFeatures('p', 30, 20, 10);
  const before = await evaluate(base);
  const body = before.bodies[0]!;
  const cases: Vec3[] = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, 1],
  ];
  for (const normal of cases) {
    const face = body.faces.find((f) => f.normal && close(f.normal, normal, 1e-9))!;
    const feature = placeOnPlateFeature(before, base, body.id, face.key, 'place');
    assert.equal(feature.kind, 'transform');
    assert.equal(feature.copy, false);
    const after = await evaluate([...base, feature]);
    const placed = after.bodies.find((b) => b.id === body.id)!;
    assert.ok(Math.abs(placed.min[2]) < 1e-6, `min z = ${placed.min[2]}`);
    const down = placed.faces.find((f) => f.normal && f.normal[2] < -0.999999);
    assert.ok(down, 'a face points down');
    assert.ok(Math.abs(down.area - face.area) < 1e-6, 'it is the picked face (same area)');
    assert.ok(Math.abs(down.centroid[2]) < 1e-6, 'lying on Z = 0');
    assert.ok(Math.abs(placed.volume - body.volume) < 1e-6, 'rigid motion keeps the volume');
  }
});

void test('Place on Plate rejects unknown and curved faces', async () => {
  const features = boxFeatures('c', 10, 10, 10);
  const result = await evaluate(features);
  assert.throws(
    () => placeOnPlateFeature(result, features, result.bodies[0]!.id, 'nope', 'x'),
    /No face/,
  );
  const { pin } = await import('./fixtures.js');
  const pinFeatures = pin();
  const pinResult = await evaluate(pinFeatures);
  const side = pinResult.bodies[0]!.faces.find((f) => f.surface === 'cylinder')!;
  assert.throws(
    () => placeOnPlateFeature(pinResult, pinFeatures, pinResult.bodies[0]!.id, side.key, 'x'),
    /flat/,
  );
});

void test('Auto orient: ranking is deterministic and flips the mushroom upside down', async () => {
  const features = mushroom();
  const result = await evaluate(features);
  const body = result.bodies[0]!;
  const { mesh, faceLabels } = orientationInput(result, features, body.id);
  const rank = () =>
    rankOrientations(mesh, 45, { faceLabel: (_k, i) => faceLabels[i] ?? `Face ${i + 1}` });
  const first = rank();
  const second = rank();
  assert.deepEqual(
    first.map((c) => [c.label, c.overhangAreaMm2, c.heightMm]),
    second.map((c) => [c.label, c.overhangAreaMm2, c.heightMm]),
    'same input, same ranking',
  );
  assert.equal(first[0]!.overhangAreaMm2, 0, 'the best candidate has no overhang');
  assert.ok(close(first[0]!.down, [0, 0, 1], 1e-9), 'cap down: the top (+Z) faces the plate');
  const asModelled = first.find((c) => close(c.down, [0, 0, -1], 1e-9))!;
  assert.ok(
    asModelled.overhangAreaMm2 > 700,
    `as modelled the cap overhangs (${asModelled.overhangAreaMm2})`,
  );
  assert.ok(first.every((c, i) => c.rank === i + 1));

  // Applying the winner through the kernel leaves a body without overhang on Z = 0.
  const { placementFeature } = await import('../../renderer/src/modules/print/placement.js');
  const applied = await evaluate([
    ...features,
    placementFeature(body.id, first[0]!.transform, 'orient', 'Orient'),
  ]);
  const placed = applied.bodies[0]!;
  assert.ok(Math.abs(placed.min[2]) < 1e-6);
  assert.ok(Math.abs(placed.max[2] - 14) < 1e-6, 'height 14 mm');
});

void test('Auto orient on the chamfered block prefers a face with no overhang', async () => {
  const features = chamferedBlock();
  const result = await evaluate(features);
  const { mesh } = orientationInput(result, features, result.bodies[0]!.id);
  const ranked = rankOrientations(mesh, 45);
  const asModelled = ranked.find((c) => close(c.down, [0, 0, -1], 1e-9))!;
  assert.ok(asModelled.overhangAreaMm2 > 0, 'the 60° side overhangs as modelled');
  assert.ok(ranked[0]!.overhangAreaMm2 < asModelled.overhangAreaMm2);
});
