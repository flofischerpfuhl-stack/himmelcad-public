import assert from 'node:assert/strict';
import test from 'node:test';

import type { Feature } from '../../renderer/src/foundation/document/document.js';
import {
  bodyGeometry,
  isStable,
  sectionContour,
  silhouetteCandidates,
  vertexCurvature,
} from '../../renderer/src/platform/viewport/bodyGeometry.js';
import { DEFAULT_POSE, depthRange, withFov } from '../../renderer/src/platform/viewport/camera.js';
import {
  activeDisplayEntry,
  bodyMaterials,
  curvatureColor,
  curvatureRange,
  curvatureStrength,
  DISPLAY_MODE_ENTRIES,
  isDisplayMode,
} from '../../renderer/src/platform/viewport/displayModes.js';
import {
  imageExportSize,
  imageFileName,
  unpremultiply,
} from '../../renderer/src/viewport/imageExport.js';
import {
  sectionClip,
  sectionHandle,
  sectionOffsetRange,
  sectionOutline,
} from '../../renderer/src/modules/modeling/toolAnchors.js';
import { boxBody, cylinderBody } from './meshFixtures.js';

void test('bodyGeometry: per-vertex face index and concatenated edges with ranges', () => {
  const body = boxBody('b', [0, 0, 0], [10, 20, 30]);
  const g = bodyGeometry(body);
  assert.equal(g.faceIndex.length, body.mesh.positions.length / 3);
  assert.equal(g.faceIndex[0], 0);
  assert.equal(g.faceIndex[4], 1); // second face's first vertex
  assert.equal(g.edgeSegments.length, 12 * 6);
  assert.deepEqual(g.edgeRanges[3], { first: 3, count: 1 });
  assert.equal(g.edgeIndex[7], 7);
  assert.ok(isStable(g.edgeSegments) && isStable(body.mesh.positions));
  // Cached by mesh identity.
  assert.equal(bodyGeometry(body), g);
});

void test('silhouetteCandidates: interior edges of curved faces only, with both triangle normals', () => {
  assert.equal(silhouetteCandidates(boxBody('p', [0, 0, 0], [1, 1, 1])).length, 0);
  const cylinder = cylinderBody('c', 5, 10, 32);
  const candidates = silhouetteCandidates(cylinder);
  // 32 vertical seams + 32 quad diagonals, 12 floats each.
  assert.equal(candidates.length / 12, 64);
  // A candidate's two normals differ (neighbouring quads) or match (diagonal inside one quad).
  const n1 = candidates.subarray(6, 9);
  assert.ok(Math.abs(Math.hypot(n1[0]!, n1[1]!, n1[2]!) - 1) < 1e-5);
});

void test('vertexCurvature: ≈ 1/r on a cylinder (convex, positive), 0 on planes', () => {
  const r = 5;
  const k = vertexCurvature(cylinderBody('c', r, 10, 64));
  for (const value of k) assert.ok(Math.abs(value - 1 / r) < 0.01, `k = ${value}`);
  const flat = vertexCurvature(boxBody('p', [0, 0, 0], [1, 1, 1]));
  assert.ok(flat.every((v) => v === 0));
});

void test('sectionContour: a box cut at mid height gives its outline (4 sides)', () => {
  const body = boxBody('b', [0, 0, 0], [10, 20, 30]);
  const contour = sectionContour(body, [0, 0, 1], 15);
  assert.ok(contour.length > 0);
  for (let i = 2; i < contour.length; i += 3) assert.ok(Math.abs(contour[i]! - 15) < 1e-4);
  let length = 0;
  for (let i = 0; i < contour.length; i += 6) {
    length += Math.hypot(
      contour[i + 3]! - contour[i]!,
      contour[i + 4]! - contour[i + 1]!,
      contour[i + 5]! - contour[i + 2]!,
    );
  }
  assert.ok(Math.abs(length - 60) < 1e-3, `perimeter ${length}`);
  assert.equal(sectionContour(body, [0, 0, 1], 99).length, 0);
});

void test('display modes: entries, active entry, validation', () => {
  assert.equal(DISPLAY_MODE_ENTRIES.length, 7);
  assert.equal(new Set(DISPLAY_MODE_ENTRIES.map((e) => e.shortcut)).size, 7);
  assert.equal(activeDisplayEntry('shaded', true), 'shadedEdges');
  assert.equal(activeDisplayEntry('shaded', false), 'shaded');
  assert.equal(activeDisplayEntry('zebra', false), 'zebra');
  assert.ok(isDisplayMode('curvature'));
  assert.ok(!isDisplayMode('toon'));
});

void test('bodyMaterials: the last active appearance step of a body decides', () => {
  const step = (id: string, bodyId: string, material?: string, suppressed = false): Feature =>
    ({
      id,
      name: id,
      suppressed,
      kind: 'setAppearance',
      bodyId,
      color: '#112233',
      ...(material ? { material } : {}),
    }) as Feature;
  const features = [
    step('a1', 'body:x', 'petg'),
    step('a2', 'body:y', 'metal'),
    step('a3', 'body:x', 'resin', true),
    step('a4', 'body:y'),
    step('a5', 'body:z', 'pla'),
  ];
  const all = bodyMaterials(features);
  assert.equal(all.get('body:x'), 'petg'); // the suppressed step is ignored
  assert.equal(all.has('body:y'), false); // a later step without material clears it
  assert.equal(all.get('body:z'), 'pla');
  // Rolled back before a5.
  assert.equal(bodyMaterials(features, 4).has('body:z'), false);
});

void test('curvature scale: flat, convex warm, concave cool, clamped by radius', () => {
  const range = curvatureRange(100);
  assert.equal(curvatureStrength(0, range), 0);
  assert.equal(curvatureStrength(1 / range.min, range), 1);
  assert.equal(curvatureStrength(1 / (range.max * 10), range), 0);
  const convex = curvatureColor(1 / range.min, range);
  const concave = curvatureColor(-1 / range.min, range);
  assert.ok(convex[0] > convex[2]);
  assert.ok(concave[2] > concave[0]);
});

void test('depthRange: tight planes around the model; grid far plane; tiny and huge parts stay precise', () => {
  const pose = { ...DEFAULT_POSE, target: [0, 0, 0] as [number, number, number], distance: 10 };
  const small = depthRange(pose, { min: [-1, -1, -1], max: [1, 1, 1] }, null);
  assert.ok(small.near > 7 && small.near < 9, `near ${small.near}`);
  assert.ok(small.far > 11 && small.far < 13, `far ${small.far}`);
  const withGrid = depthRange(pose, { min: [-1, -1, -1], max: [1, 1, 1] }, 200);
  assert.ok(withGrid.far >= 200);
  assert.ok(withGrid.far / withGrid.near <= 1e5 + 1);
  const huge = depthRange(
    { ...pose, distance: 5000 },
    { min: [-2000, -2000, 0], max: [2000, 2000, 500] },
    null,
  );
  assert.ok(huge.near > 0 && huge.far > 5000 && huge.far / huge.near < 1e5);
  // Camera inside the box: near stays a useful fraction of the orbit distance.
  const inside = depthRange(pose, { min: [-100, -100, -100], max: [100, 100, 100] }, null);
  assert.ok(Math.abs(inside.near - 0.05) < 1e-9);
  // Orthographic: planes may lie behind the eye.
  const ortho = depthRange(withFov(pose, 0), { min: [-1, -1, -1], max: [1, 1, 1] }, null);
  assert.ok(ortho.far > ortho.near);
});

void test('section at a face-aligned plane: clip, handle, outline and offset range', () => {
  const plane = { normal: [0, 1, 0] as const, origin: [0, 42, 0] as const };
  const view = { axis: 'Z' as const, offset: -4, flipped: false, plane };
  const clip = sectionClip(view);
  assert.deepEqual(clip.normal, [0, 1, 0]);
  assert.equal(clip.offset, 38);
  const flipped = sectionClip({ ...view, flipped: true });
  assert.deepEqual(flipped.normal, [0, -1, 0]);
  assert.equal(flipped.offset, -38);
  const bounds = {
    min: [0, 0, 0] as [number, number, number],
    max: [80, 50, 46] as [number, number, number],
  };
  const handle = sectionHandle(view, bounds);
  assert.equal(handle.base[1], 38);
  assert.deepEqual(handle.dragDir, [0, 1, 0]);
  for (const corner of sectionOutline(view, bounds)) assert.ok(Math.abs(corner[1] - 38) < 1e-9);
  const [lo, hi] = sectionOffsetRange(view, bounds);
  assert.ok(lo < -42 && hi > 8);
  // Axis sections keep their behaviour.
  assert.equal(sectionClip({ axis: 'X', offset: 5, flipped: false }).offset, 5);
});

void test('image export: sizes, straight alpha, file name', () => {
  assert.deepEqual(
    imageExportSize({ size: 'view', scale: 2, width: 0, height: 0 }, { width: 1440, height: 900 }),
    {
      width: 2880,
      height: 1800,
    },
  );
  assert.deepEqual(
    imageExportSize({ size: '3840x2160', scale: 1, width: 0, height: 0 }, { width: 1, height: 1 }),
    {
      width: 3840,
      height: 2160,
    },
  );
  assert.deepEqual(
    imageExportSize({ size: 'custom', scale: 1, width: 640, height: 480 }, { width: 1, height: 1 }),
    {
      width: 640,
      height: 480,
    },
  );
  const pixels = new Uint8Array([50, 25, 0, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
  unpremultiply(pixels);
  assert.deepEqual([...pixels.slice(0, 4)], [100, 50, 0, 128]);
  assert.deepEqual([...pixels.slice(4)], [10, 20, 30, 255, 0, 0, 0, 0]);
  assert.equal(
    imageFileName('Bracket: v2', new Date(2026, 8, 30, 14, 5)),
    'Bracket_ v2 2026-09-30 14-05.png',
  );
});
