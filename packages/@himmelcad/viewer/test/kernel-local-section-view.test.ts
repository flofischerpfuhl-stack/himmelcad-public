import assert from 'node:assert/strict';
import test from 'node:test';

import { localSectionClipVolume } from '../src/kernel/KernelLocalSectionView.js';

void test('local section depth emits the exact two inward slab half-spaces', () => {
  const inverseRootTwo = Math.SQRT1_2;
  const volume = localSectionClipVolume({
    id: 'profile-depth',
    frame: {
      origin: { x: 500_000, y: 5_400_000, z: 120 },
      normal: { x: inverseRootTwo, y: -inverseRootTwo, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      verticalSpan: 80,
    },
    depth: { towardCamera: 2, awayFromCamera: 18 },
  });

  assert.equal(volume.operation, 'keepInside');
  assert.equal(volume.previewCap, false);
  assert.equal(volume.planes.length, 2);
  const towardCameraPlane = volume.planes[0];
  const awayFromCameraPlane = volume.planes[1];
  assert(towardCameraPlane);
  assert(awayFromCameraPlane);
  assert(Math.abs(signedDistance(towardCameraPlane, pointAlongNormal(2))) < 1e-8);
  assert(Math.abs(signedDistance(awayFromCameraPlane, pointAlongNormal(-18))) < 1e-8);
  assert(signedDistance(towardCameraPlane, pointAlongNormal(2.001)) < 0);
  assert(signedDistance(awayFromCameraPlane, pointAlongNormal(-18.001)) < 0);
  assert(signedDistance(towardCameraPlane, pointAlongNormal(-18)) >= 0);
  assert(signedDistance(awayFromCameraPlane, pointAlongNormal(2)) >= 0);

  function pointAlongNormal(distance: number): { x: number; y: number; z: number } {
    return {
      x: 500_000 + inverseRootTwo * distance,
      y: 5_400_000 - inverseRootTwo * distance,
      z: 120,
    };
  }
});

void test('local section depth rejects ambiguous identities and degenerate slabs', () => {
  const base = {
    id: 'profile-depth',
    frame: {
      origin: { x: 0, y: 0, z: 0 },
      normal: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      verticalSpan: 10,
    },
    depth: { towardCamera: 0, awayFromCamera: 10 },
  } as const;

  assert.throws(() => localSectionClipVolume({ ...base, id: ' profile-depth' }), RangeError);
  assert.throws(
    () =>
      localSectionClipVolume({
        ...base,
        depth: { towardCamera: 0, awayFromCamera: 0 },
      }),
    RangeError,
  );
  assert.throws(
    () =>
      localSectionClipVolume({
        ...base,
        depth: { towardCamera: Number.POSITIVE_INFINITY, awayFromCamera: 1 },
      }),
    RangeError,
  );
});

function signedDistance(
  plane: Readonly<{ normal: Readonly<{ x: number; y: number; z: number }>; distance: number }>,
  point: Readonly<{ x: number; y: number; z: number }>,
): number {
  return (
    plane.normal.x * point.x + plane.normal.y * point.y + plane.normal.z * point.z + plane.distance
  );
}
