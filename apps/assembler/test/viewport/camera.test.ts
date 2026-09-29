import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_POSE,
  eyeOf,
  fitPose,
  lerpPose,
  orbit,
  pan,
  presetPose,
  zoomTowards,
} from '../../renderer/src/viewport/camera.js';

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
