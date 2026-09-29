import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CUBE_FACES,
  DEFAULT_POSE,
  cameraBasis,
  cubeCellDirection,
  cubeFaceMatrix3d,
  cubeMatrix3d,
  eyeOf,
  facingCubeFace,
  fitPose,
  isFaceOnView,
  lerpPose,
  orbit,
  pan,
  poseFromDirection,
  presetPose,
  rollBy,
  viewProjectionMatrix,
  withFov,
  worldPerPixel,
  zoomTowards,
  type CameraPose,
  type CubeFaceName,
} from '../../renderer/src/viewport/camera.js';
import { projectToScreen, type Vec3 } from '../../renderer/src/viewport/math.js';

/** Applies a CSS matrix3d (column-major) to a vector (no translation). */
function applyCss(m: number[], v: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2],
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2],
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2],
  ];
}

/** The cube face whose rendered normal points most towards the viewer (+z in CSS). */
function renderedFrontFace(pose: CameraPose): CubeFaceName {
  const cube = cubeMatrix3d(pose);
  let best: CubeFaceName = 'front';
  let bestZ = -Infinity;
  for (const face of CUBE_FACES) {
    const local = cubeFaceMatrix3d(face, 1);
    const normal: Vec3 = [local[8]!, local[9]!, local[10]!];
    const z = applyCss(cube, normal)[2];
    if (z > bestZ) {
      bestZ = z;
      best = face.name;
    }
  }
  return best;
}

/** Screen direction (CSS: x right, y down) of the rendered face label's "up". */
function renderedLabelUp(pose: CameraPose, name: CubeFaceName): [number, number] {
  const face = CUBE_FACES.find((f) => f.name === name)!;
  const local = cubeFaceMatrix3d(face, 1);
  const down: Vec3 = [local[4]!, local[5]!, local[6]!];
  const screen = applyCss(cubeMatrix3d(pose), down);
  return [-screen[0], -screen[1]];
}

const PRESETS: CubeFaceName[] = ['front', 'back', 'right', 'left', 'top', 'bottom'];

void test('view cube shows the face the camera looks from, upright, for all six presets', () => {
  for (const preset of PRESETS) {
    const pose = presetPose(preset, DEFAULT_POSE);
    assert.equal(renderedFrontFace(pose), preset, `cube face for ${preset}`);
    assert.equal(facingCubeFace(pose).name, preset);
    assert.ok(isFaceOnView(pose), `${preset} is a face-on view`);
    // The label reads upright (its up vector points up on screen, CSS y < 0).
    const up = renderedLabelUp(pose, preset);
    assert.ok(up[1] < -0.99, `${preset} label upright: ${up.join(',')}`);
  }
});

void test('view cube in the iso preset shows Front, Right and Top towards the viewer', () => {
  const pose = presetPose('iso', DEFAULT_POSE);
  const cube = cubeMatrix3d(pose);
  const towards = CUBE_FACES.filter((face) => {
    const local = cubeFaceMatrix3d(face, 1);
    return applyCss(cube, [local[8]!, local[9]!, local[10]!])[2] > 0.1;
  }).map((f) => f.name);
  assert.deepEqual(towards.sort(), ['front', 'right', 'top']);
  assert.ok(!isFaceOnView(pose));
});

void test('scene and cube agree: world +X projects to the right in the Front view', () => {
  const pose = { ...presetPose('front', DEFAULT_POSE), target: [0, 0, 0] as const };
  const vp = viewProjectionMatrix(pose, 1);
  const origin = projectToScreen(vp, [0, 0, 0], 100, 100)!;
  const plusX = projectToScreen(vp, [10, 0, 0], 100, 100)!;
  const plusZ = projectToScreen(vp, [0, 0, 10], 100, 100)!;
  assert.ok(plusX[0] > origin[0]);
  assert.ok(plusZ[1] < origin[1]);
  // Top view: +Y up on screen, +X right.
  const top = { ...presetPose('top', DEFAULT_POSE), target: [0, 0, 0] as const };
  const vpTop = viewProjectionMatrix(top, 1);
  const o = projectToScreen(vpTop, [0, 0, 0], 100, 100)!;
  assert.ok(projectToScreen(vpTop, [10, 0, 0], 100, 100)![0] > o[0] + 1);
  assert.ok(projectToScreen(vpTop, [0, 10, 0], 100, 100)![1] < o[1] - 1);
  // Bottom view: -Y up on screen, +X right.
  const bottom = { ...presetPose('bottom', DEFAULT_POSE), target: [0, 0, 0] as const };
  const vpBottom = viewProjectionMatrix(bottom, 1);
  const b = projectToScreen(vpBottom, [0, 0, 0], 100, 100)!;
  assert.ok(projectToScreen(vpBottom, [10, 0, 0], 100, 100)![0] > b[0] + 1);
  assert.ok(projectToScreen(vpBottom, [0, -10, 0], 100, 100)![1] < b[1] - 1);
});

void test('cube cells: edges and corners give the 12 edge and 8 isometric directions', () => {
  const edges = new Set<string>();
  const corners = new Set<string>();
  for (const face of CUBE_FACES) {
    for (const i of [-1, 0, 1] as const) {
      for (const j of [-1, 0, 1] as const) {
        const d = cubeCellDirection(face, i, j);
        const key = d.map((c) => Math.round(c * 1000)).join(',');
        if (i !== 0 && j !== 0) corners.add(key);
        else if (i !== 0 || j !== 0) edges.add(key);
      }
    }
  }
  assert.equal(edges.size, 12);
  assert.equal(corners.size, 8);
  // The top-right-front corner of the Front face is the (+X, -Y, +Z) iso direction.
  const front = CUBE_FACES.find((f) => f.name === 'front')!;
  const d = cubeCellDirection(front, 1, 1);
  const s = 1 / Math.sqrt(3);
  assert.ok(Math.abs(d[0] - s) < 1e-9 && Math.abs(d[1] + s) < 1e-9 && Math.abs(d[2] - s) < 1e-9);
});

void test('poseFromDirection looks from the given direction (poles upright)', () => {
  const dir: Vec3 = [1, -1, 1];
  const pose = poseFromDirection(dir, DEFAULT_POSE);
  const back = cameraBasis(pose).back;
  const n = Math.sqrt(3);
  assert.ok(Math.abs(back[0] - 1 / n) < 1e-9 && Math.abs(back[2] - 1 / n) < 1e-9);
  const top = poseFromDirection([0, 0, 1], DEFAULT_POSE);
  assert.equal(renderedFrontFace(top), 'top');
  assert.ok(renderedLabelUp(top, 'top')[1] < -0.99);
});

void test('roll turns the view by 90° steps and the cube with it', () => {
  const front = presetPose('front', DEFAULT_POSE);
  const rolled = rollBy(front, 90);
  assert.equal(renderedFrontFace(rolled), 'front');
  const up = renderedLabelUp(rolled, 'front');
  // Content turns counter-clockwise: the label's up now points left.
  assert.ok(up[0] < -0.99, `rolled label up ${up.join(',')}`);
  const vp = viewProjectionMatrix({ ...rolled, target: [0, 0, 0] }, 1);
  const o = projectToScreen(vp, [0, 0, 0], 100, 100)!;
  // World +Z (was up) now points left on screen.
  assert.ok(projectToScreen(vp, [0, 0, 10], 100, 100)![0] < o[0] - 1);
  assert.equal(rollBy(rolled, -90).roll, 0);
});

void test('orthographic projection keeps the apparent size at the target', () => {
  const pose = { ...DEFAULT_POSE, target: [0, 0, 0] as const };
  const ortho = withFov(pose, 0);
  assert.equal(ortho.fov, 0);
  assert.ok(
    Math.abs(worldPerPixel(ortho, 1, 500) - worldPerPixel(pose, pose.distance, 500)) < 1e-9,
  );
  // Parallel rays: equal-size objects at different depths project equally.
  const vp = viewProjectionMatrix(presetPose('front', ortho), 1);
  const near = projectToScreen(vp, [10, -50, 0], 100, 100)!;
  const far = projectToScreen(vp, [10, 50, 0], 100, 100)!;
  assert.ok(Math.abs(near[0] - far[0]) < 1e-3);
  const wide = withFov(pose, 60);
  assert.ok(
    Math.abs(worldPerPixel(wide, wide.distance, 500) - worldPerPixel(pose, pose.distance, 500)) <
      1e-9,
  );
  assert.ok(wide.distance < pose.distance);
});

void test('presetPose "front"/"top" reorient yaw/pitch but keep target and distance', () => {
  const current = { ...DEFAULT_POSE, target: [1, 2, 3] as const, distance: 500 };
  const front = presetPose('front', current);
  assert.deepEqual(front.target, current.target);
  assert.equal(front.distance, current.distance);
  const top = presetPose('top', current);
  assert.ok(top.pitch > front.pitch);
});

void test('orbit changes yaw/pitch, not target/distance', () => {
  const next = orbit(DEFAULT_POSE, 100, 50);
  assert.notEqual(next.yaw, DEFAULT_POSE.yaw);
  assert.notEqual(next.pitch, DEFAULT_POSE.pitch);
  assert.equal(next.distance, DEFAULT_POSE.distance);
  assert.deepEqual(next.target, DEFAULT_POSE.target);
});

void test('orbit clamps pitch so the camera cannot flip past the poles', () => {
  const next = orbit(DEFAULT_POSE, 0, 1_000_000);
  assert.ok(next.pitch < Math.PI / 2);
  assert.ok(next.pitch > -Math.PI / 2);
});

void test('pan moves the target but leaves yaw/pitch/distance untouched', () => {
  const next = pan(DEFAULT_POSE, 50, 0, 800);
  assert.notDeepEqual(next.target, DEFAULT_POSE.target);
  assert.equal(next.yaw, DEFAULT_POSE.yaw);
  assert.equal(next.pitch, DEFAULT_POSE.pitch);
  assert.equal(next.distance, DEFAULT_POSE.distance);
});

void test('zoomTowards with no anchor scales distance only', () => {
  const next = zoomTowards(DEFAULT_POSE, 2, null);
  assert.ok(Math.abs(next.distance - DEFAULT_POSE.distance * 2) < 1e-6);
  assert.deepEqual(next.target, DEFAULT_POSE.target);
});

void test('zoomTowards pulls the target toward the anchor as distance shrinks', () => {
  const pose = { ...DEFAULT_POSE, target: [0, 0, 0] as const, distance: 100 };
  const next = zoomTowards(pose, 0.5, [10, 0, 0]);
  assert.ok(next.target[0] > 0);
  assert.ok(next.target[0] < 10);
});

void test('fitPose frames a bounding box: the eye ends up outside it', () => {
  const bounds = [{ min: [-10, -10, -10] as const, max: [10, 10, 10] as const }];
  const fitted = fitPose(bounds, DEFAULT_POSE, 1);
  assert.deepEqual(fitted.target, [0, 0, 0]);
  const eye = eyeOf(fitted);
  const distanceFromCenter = Math.hypot(eye[0], eye[1], eye[2]);
  assert.ok(distanceFromCenter > 10);
});

void test('fitPose with no bounds falls back to the origin without throwing', () => {
  const fitted = fitPose([], DEFAULT_POSE, 1);
  assert.deepEqual(fitted.target, [0, 0, 0]);
  assert.ok(fitted.distance > 0);
});

void test('lerpPose at t=0 and t=1 returns the endpoints; wraps yaw the short way', () => {
  const a = { target: [0, 0, 0] as const, distance: 100, yaw: Math.PI - 0.1, pitch: 0 };
  const b = { target: [10, 0, 0] as const, distance: 200, yaw: -Math.PI + 0.1, pitch: 0.5 };
  const at0 = lerpPose(a, b, 0);
  assert.deepEqual(at0.target, a.target);
  const at1 = lerpPose(a, b, 1);
  assert.ok(Math.abs(at1.distance - b.distance) < 1e-6);
  // The short way around the wrap should not pass through 0.
  const mid = lerpPose(a, b, 0.5);
  assert.ok(mid.yaw > Math.PI - 0.2 || mid.yaw < -Math.PI + 0.2);
});
