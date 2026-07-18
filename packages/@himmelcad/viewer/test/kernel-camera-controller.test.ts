import assert from 'node:assert/strict';
import test from 'node:test';

import { KernelCameraController } from '../src/kernel/KernelCameraController.js';
import type { KernelWorldPoint } from '../src/kernel/WgpuKernelViewer.js';

void test('kernel CAD orbit and zoom preserve the authored cursor pivot', () => {
  const controller = new KernelCameraController(1_600, 900);
  controller.frame({ x: 499_900, y: 5_399_900, z: 90 }, { x: 500_100, y: 5_400_100, z: 110 });
  const pivot = { x: 500_040, y: 5_400_020, z: 100 };
  const before = controller.worldCamera();
  controller.orbitAround(0.2, -0.1, pivot);
  const afterOrbit = controller.worldCamera();

  assert.ok(Math.abs(distance(before.eye, pivot) - distance(afterOrbit.eye, pivot)) < 1e-8);
  assert.ok(Math.abs(distance(before.target, pivot) - distance(afterOrbit.target, pivot)) < 1e-8);

  const beforeZoom = controller.worldCamera();
  controller.zoomAt(0.5, pivot);
  const afterZoom = controller.worldCamera();
  assert.ok(
    Math.abs(distance(afterZoom.eye, pivot) / distance(beforeZoom.eye, pivot) - 0.5) < 1e-10,
  );
  assert.ok(
    Math.abs(distance(afterZoom.target, pivot) / distance(beforeZoom.target, pivot) - 0.5) < 1e-10,
  );
});

void test('top-down mode produces a matched orthographic transition and blocks orbit', () => {
  const controller = new KernelCameraController(1_000, 500);
  const transition = controller.setLockedTopDown(true);
  assert.ok(transition);
  assert.equal(transition.from.projection.kind, 'perspective');
  assert.equal(transition.to.projection.kind, 'orthographic');
  assert.equal(transition.to.eye.x, transition.to.target.x);
  assert.equal(transition.to.eye.y, transition.to.target.y);
  assert.deepEqual(transition.to.up, { x: 0, y: 1, z: 0 });

  const locked = controller.worldCamera();
  controller.orbit(1, 1);
  assert.deepEqual(controller.worldCamera(), locked);
  assert.deepEqual(controller.recommendedFloatingOrigin(), [0, 0, 0]);
});

void test('returning from top-down preserves the orthographic zoom scale', () => {
  const controller = new KernelCameraController(1_000, 500);
  const entry = controller.worldCamera();
  assert.equal(entry.projection.kind, 'perspective');
  const initialDistance = distance(entry.eye, entry.target);

  controller.setLockedTopDown(true);
  controller.zoom(0.25);
  const topDown = controller.worldCamera();
  assert.equal(topDown.projection.kind, 'orthographic');

  const exit = controller.setLockedTopDown(false);
  assert.ok(exit);
  assert.equal(exit.from.projection.kind, 'orthographic');
  assert.equal(exit.to.projection.kind, 'perspective');
  assert.ok(Math.abs(distance(exit.to.eye, exit.to.target) - initialDistance * 0.25) < 1e-10);

  if (exit.from.projection.kind === 'orthographic' && exit.to.projection.kind === 'perspective') {
    const perspectiveSpanAtTarget =
      2 *
      distance(exit.to.eye, exit.to.target) *
      Math.tan(exit.to.projection.verticalFovRadians / 2);
    assert.ok(Math.abs(perspectiveSpanAtTarget - exit.from.projection.verticalSpan) < 1e-10);
  }
});

void test('civil-coordinate top-down zoom remains usable far below object scale', () => {
  const controller = new KernelCameraController(1_920, 1_080);
  controller.frame(
    { x: 4_375_465.2058, y: 5_281_171.141, z: 693.0004 },
    { x: 4_375_599.2036, y: 5_281_305.1388, z: 826.9982 },
  );
  controller.setLockedTopDown(true);
  for (let index = 0; index < 80; index += 1) controller.zoom(0.85);

  const camera = controller.worldCamera();
  assert.equal(camera.projection.kind, 'orthographic');
  if (camera.projection.kind === 'orthographic') {
    assert.ok(camera.projection.verticalSpan < 0.001);
    assert.ok(camera.projection.verticalSpan >= 1e-5);
  }
});

void test('arbitrary local orthographic frames pan and zoom in their own plane', () => {
  const controller = new KernelCameraController(1_000, 500);
  const inverseRootTwo = Math.SQRT1_2;
  const transition = controller.setLocalOrthographicFrame({
    origin: { x: 500_000, y: 5_400_000, z: 125 },
    normal: { x: 0, y: -inverseRootTwo, z: inverseRootTwo },
    up: { x: 0, y: inverseRootTwo, z: inverseRootTwo },
    verticalSpan: 100,
  });

  assert.equal(transition.from.projection.kind, 'perspective');
  assert.equal(transition.to.projection.kind, 'orthographic');
  assert.equal(controller.isOrthographicView(), true);
  assert.deepEqual(transition.to.target, { x: 500_000, y: 5_400_000, z: 125 });
  assert.deepEqual(transition.to.up, {
    x: 0,
    y: inverseRootTwo,
    z: inverseRootTwo,
  });
  assert.ok(Math.abs(transition.to.eye.y - (5_400_000 - 50 * inverseRootTwo)) < 1e-9);
  assert.ok(Math.abs(transition.to.eye.z - (125 + 50 * inverseRootTwo)) < 1e-9);

  controller.panPixels(10, 20);
  const panned = controller.worldCamera();
  assert.ok(Math.abs(panned.target.x - 499_998) < 1e-10);
  assert.ok(Math.abs(panned.target.y - (5_400_000 + 4 * inverseRootTwo)) < 1e-9);
  assert.ok(Math.abs(panned.target.z - (125 + 4 * inverseRootTwo)) < 1e-9);

  controller.zoom(0.25);
  const zoomed = controller.worldCamera();
  assert.equal(zoomed.projection.kind, 'orthographic');
  assert.equal(zoomed.projection.verticalSpan, 25);

  const center = controller.worldPointOnTargetPlane(0, 0);
  const localCorner = controller.worldPointOnTargetPlane(0.5, 0.5);
  assert.ok(distance(center, zoomed.target) < 1e-10);
  assert.ok(Math.abs(localCorner.x - (center.x + 12.5)) < 1e-9);
  assert.ok(Math.abs(localCorner.y - (center.y + 6.25 * inverseRootTwo)) < 1e-9);
  assert.ok(Math.abs(localCorner.z - (center.z + 6.25 * inverseRootTwo)) < 1e-9);
});

void test('leaving a local frame restores the exact camera from before first entry', () => {
  const controller = new KernelCameraController(1_600, 900);
  controller.frame({ x: 499_900, y: 5_399_900, z: 90 }, { x: 500_100, y: 5_400_100, z: 110 });
  controller.orbit(0.35, -0.2);
  const authored3dCamera = controller.worldCamera();

  controller.setLocalOrthographicFrame({
    origin: { x: 500_020, y: 5_400_010, z: 100 },
    normal: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    verticalSpan: 80,
  });
  controller.panPixels(-80, 120);
  controller.zoom(0.125);
  controller.setLocalOrthographicFrame({
    origin: { x: 499_980, y: 5_399_990, z: 95 },
    normal: { x: 0, y: 1, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    verticalSpan: 40,
  });

  const exit = controller.clearLocalOrthographicFrame();
  assert.ok(exit);
  assert.equal(exit.from.projection.kind, 'orthographic');
  assert.deepEqual(exit.to, authored3dCamera);
  assert.deepEqual(controller.worldCamera(), authored3dCamera);
  assert.equal(controller.isOrthographicView(), false);
  assert.equal(controller.clearLocalOrthographicFrame(), null);
});

void test('framing an AABB in a local view uses its projected local extents', () => {
  const controller = new KernelCameraController(1_000, 500);
  controller.setLocalOrthographicFrame({
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: Math.SQRT1_2, y: -Math.SQRT1_2, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    verticalSpan: 10,
  });
  controller.frame({ x: -100, y: -100, z: -2 }, { x: 100, y: 100, z: 2 });

  const camera = controller.worldCamera();
  assert.equal(camera.projection.kind, 'orthographic');
  if (camera.projection.kind === 'orthographic') {
    // The diagonal local horizontal axis spans 200 * sqrt(2); at aspect 2 it
    // requires 120 * sqrt(2) vertical world units including the 1.2 margin.
    assert.ok(Math.abs(camera.projection.verticalSpan - 120 * Math.SQRT2) < 1e-10);
  }
  assert.deepEqual(camera.target, { x: 0, y: 0, z: 0 });
});

void test('a user-authored perspective standpoint preserves exact world eye, target and FOV', () => {
  const controller = new KernelCameraController(1_600, 900);
  controller.setLocalOrthographicFrame({
    origin: { x: 6_378_137, y: 5_400_000, z: 520 },
    normal: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    verticalSpan: 40,
  });
  const viewpoint = {
    eye: { x: 6_378_167.125, y: 5_399_960.25, z: 538.75 },
    target: { x: 6_378_140.5, y: 5_400_006.75, z: 515.25 },
    verticalFovRadians: Math.PI / 2.7,
  };
  const transition = controller.setPerspectiveViewpoint(viewpoint);

  assert.equal(transition.from.projection.kind, 'orthographic');
  assert.equal(transition.to.projection.kind, 'perspective');
  assert.ok(distance(transition.to.eye, viewpoint.eye) < 1e-8);
  assert.deepEqual(transition.to.target, viewpoint.target);
  assert.equal(transition.to.projection.verticalFovRadians, viewpoint.verticalFovRadians);
  assert.equal(controller.isOrthographicView(), false);

  const beforeInvalid = controller.worldCamera();
  assert.throws(
    () =>
      controller.setPerspectiveViewpoint({
        eye: viewpoint.target,
        target: viewpoint.target,
      }),
    RangeError,
  );
  assert.deepEqual(controller.worldCamera(), beforeInvalid);
});

void test('panorama camera keeps its scan station fixed and zooms only its field of view', () => {
  const controller = new KernelCameraController(1_600, 900);
  controller.frame({ x: 499_900, y: 5_399_900, z: 90 }, { x: 500_100, y: 5_400_100, z: 110 });
  controller.orbit(0.31, -0.17);
  const returnCamera = controller.worldCamera();
  const viewpoint = {
    eye: { x: 500_010, y: 5_400_020, z: 120 },
    target: { x: 500_010, y: 5_400_030, z: 120 },
    up: { x: 0, y: 0, z: 1 },
    verticalFovRadians: Math.PI / 2,
  };
  const entry = controller.setOrientedPerspectiveViewpoint(viewpoint);
  assert.deepEqual(entry.to.eye, viewpoint.eye);
  assert.ok(distance(entry.to.target, viewpoint.target) < 1e-9);
  assert.deepEqual(entry.to.up, viewpoint.up);

  controller.orbit(Math.PI / 2, 0.2);
  const rotated = controller.worldCamera();
  assert.deepEqual(rotated.eye, viewpoint.eye);
  assert.ok(Math.abs(distance(rotated.eye, rotated.target) - 10) < 1e-9);
  assert.ok(Math.abs(distance(rotated.eye, entry.to.target) - 10) < 1e-9);

  controller.zoom(0.5);
  const zoomed = controller.worldCamera();
  assert.deepEqual(zoomed.eye, viewpoint.eye);
  assert.equal(zoomed.projection.kind, 'perspective');
  if (zoomed.projection.kind === 'perspective') {
    assert.equal(zoomed.projection.verticalFovRadians, Math.PI / 4);
  }

  const exit = controller.clearOrientedPerspectiveViewpoint();
  assert.ok(exit);
  assert.deepEqual(exit.to, returnCamera);
  assert.equal(controller.clearOrientedPerspectiveViewpoint(), null);

  assert.throws(
    () =>
      controller.setOrientedPerspectiveViewpoint({
        eye: { x: 0, y: 0, z: 0 },
        target: { x: 0, y: 0, z: 1 },
        up: { x: 0, y: 0, z: 2 },
      }),
    RangeError,
  );
});

void test('invalid local frames fail before mutating the active camera', () => {
  const controller = new KernelCameraController(800, 600);
  const before = controller.worldCamera();
  const base = {
    origin: { x: 1, y: 2, z: 3 },
    normal: { x: 0, y: 0, z: 1 },
    up: { x: 0, y: 1, z: 0 },
    verticalSpan: 20,
  };

  assert.throws(
    () => controller.setLocalOrthographicFrame({ ...base, normal: { x: 0, y: 0, z: 2 } }),
    RangeError,
  );
  assert.throws(
    () => controller.setLocalOrthographicFrame({ ...base, up: { x: 0, y: 0, z: 1 } }),
    RangeError,
  );
  assert.throws(
    () => controller.setLocalOrthographicFrame({ ...base, origin: { x: Number.NaN, y: 2, z: 3 } }),
    RangeError,
  );
  assert.throws(
    () => controller.setLocalOrthographicFrame({ ...base, verticalSpan: 0 }),
    RangeError,
  );
  assert.deepEqual(controller.worldCamera(), before);
});

void test('every cursor resolves a finite fallback coordinate on the orbit target plane', () => {
  const controller = new KernelCameraController(1_200, 800);
  controller.frame({ x: 6_378_100, y: 5_399_950, z: 500 }, { x: 6_378_200, y: 5_400_050, z: 540 });

  const center = controller.worldPointOnTargetPlane(0, 0);
  const corner = controller.worldPointOnTargetPlane(0.9, -0.8);

  assert.deepEqual(center, controller.targetPoint());
  assert(Object.values(corner).every(Number.isFinite));
  assert.notDeepEqual(corner, center);
});

function distance(left: KernelWorldPoint, right: KernelWorldPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
