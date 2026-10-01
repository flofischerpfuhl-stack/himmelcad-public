/**
 * Projection modes and the orbit/zoom pivot (assembler/SELECTION-NAVIGATION.md
 * "Projection" and "Orbit and zoom pivot"): the pivot rules on synthetic depth
 * windows (hit, a hole's ring of hits, empty), ortho vs perspective depth and
 * ray math, orbiting/zooming about a pivot, projection changes without a jump
 * in apparent size, the Adaptive switching rules, the preference migration and
 * the hidden out-of-plane axis while sketching.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_POSE,
  cameraBasis,
  eyeOf,
  lerpPose,
  orbitAbout,
  pan,
  pointAtViewDepth,
  viewDepthOf,
  viewHeightAt,
  viewProjectionMatrix,
  withFov,
  withFovAt,
  zoomAtRay,
  zoomTowards,
  type CameraPose,
} from '../../renderer/src/platform/viewport/camera.js';
import {
  projectToScreen,
  unprojectRay,
  type Vec3,
} from '../../renderer/src/platform/viewport/math.js';
import {
  PIVOT_SEARCH_RADIUS_PX,
  linearDepth,
  pivotDepth,
  unpackDepth,
  type DepthProjection,
  type DepthSamples,
} from '../../renderer/src/platform/viewport/orbitPivot.js';
import {
  blendFov,
  nextProjection,
  wantedFov,
} from '../../renderer/src/platform/viewport/projection.js';
import { buildScene, type SceneInput } from '../../renderer/src/platform/viewport/scene.js';
import { parsePreferences } from '../../renderer/src/platform/input/preferences.js';

const W = 800;
const H = 600;
const ASPECT = W / H;

const perspective: CameraPose = { ...DEFAULT_POSE, target: [5, -3, 2], distance: 240, fov: 45 };
const orthographic: CameraPose = { ...perspective, fov: 0 };

function screen(pose: CameraPose, p: Vec3): [number, number] {
  const s = projectToScreen(viewProjectionMatrix(pose, ASPECT), p, W, H);
  assert.ok(s, 'in front of the camera');
  return s;
}

function near(actual: number, expected: number, tolerance: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} ≠ ${expected} (± ${tolerance})`,
  );
}

/** Window depth (0…1) of view depth `d` (the inverse of `linearDepth`). */
function windowZ(d: number, projection: DepthProjection): number {
  const { near: n, far: f } = projection;
  const ndc = projection.orthographic
    ? (2 * d - f - n) / (f - n)
    : (f + n - (2 * f * n) / d) / (f - n);
  return (ndc + 1) / 2;
}

/** A square depth window, `depthAt(dx, dy)` in CSS px from the cursor → view depth or null. */
function samples(
  projection: DepthProjection,
  depthAt: (dx: number, dy: number) => number | null,
  size = 64,
): DepthSamples {
  const z = new Float32Array(size * size);
  const c = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = depthAt(x + 0.5 - c, y + 0.5 - c);
      z[y * size + x] = d === null ? Number.NaN : windowZ(d, projection);
    }
  }
  return { width: size, height: size, z, cx: c, cy: c, cssPerSample: 1 };
}

const PERSP: DepthProjection = { near: 10, far: 1000, orthographic: false };
const ORTHO: DepthProjection = { near: -500, far: 500, orthographic: true };

void test('depth linearisation round-trips in perspective and orthographic projections', () => {
  for (const projection of [PERSP, ORTHO]) {
    for (const d of [12, 50, 200, 480]) {
      near(linearDepth(windowZ(d, projection), projection), d, 1e-6 * d, `depth ${d}`);
    }
  }
  assert.ok(Number.isNaN(unpackDepth(10, 20, 30, 0)), 'alpha 0 = nothing drawn');
  near(unpackDepth(255, 255, 255, 255), 1, 1e-9, 'full depth');
});

void test('pivot rule 1: the surface under the cursor', () => {
  for (const projection of [PERSP, ORTHO]) {
    const result = pivotDepth(
      samples(projection, () => 120),
      projection,
    );
    assert.equal(result?.rule, 'surface');
    near(result!.depth, 120, 1e-3, 'surface depth');
  }
});

void test('pivot rule 2: in a hole the ring of hits around the cursor gives the rim depth', () => {
  // A bore of radius 12 px in a plate at depth 100; through it: nothing (or far geometry
  // outside the search radius would not matter either).
  for (const projection of [PERSP, ORTHO]) {
    const result = pivotDepth(
      samples(projection, (dx, dy) => (Math.hypot(dx, dy) < 12 ? null : 100)),
      projection,
    );
    assert.equal(result?.rule, 'near');
    near(result!.depth, 100, 1e-3, 'rim depth');
  }
  // The visible inner wall (deeper, close to the cursor) pulls the pivot into the bore,
  // between the rim and the wall.
  const wall = pivotDepth(
    samples(PERSP, (dx, dy) => {
      const r = Math.hypot(dx, dy);
      if (r < 8) return null;
      return r < 12 ? 130 : 100;
    }),
    PERSP,
  );
  assert.equal(wall?.rule, 'near');
  assert.ok(wall!.depth > 100 && wall!.depth < 130, `inside the bore: ${wall!.depth}`);
  // Beside a part: hits only on one side, still at their depth.
  const beside = pivotDepth(
    samples(PERSP, (dx) => (dx > 20 ? 300 : null)),
    PERSP,
  );
  assert.equal(beside?.rule, 'near');
  near(beside!.depth, 300, 1e-3, 'beside');
});

void test('pivot rule 2 weighs closer hits more and ignores hits outside the radius', () => {
  const result = pivotDepth(
    samples(PERSP, (dx) => (dx < -10 && dx > -14 ? 100 : dx > 24 && dx < 28 ? 300 : null)),
    PERSP,
  );
  assert.ok(result && result.depth < 200, `closer side wins: ${result?.depth}`);
  const far = pivotDepth(
    samples(PERSP, (dx) => (dx > PIVOT_SEARCH_RADIUS_PX + 0.5 ? 100 : null), 80),
    PERSP,
  );
  assert.equal(far, null, 'nothing within the radius → rule 3 (caller)');
  assert.equal(
    pivotDepth(
      samples(PERSP, () => null),
      PERSP,
    ),
    null,
    'empty window',
  );
});

void test('the pivot point lies on the cursor ray at the depth (ortho and perspective)', () => {
  for (const pose of [perspective, orthographic]) {
    const ray = unprojectRay(viewProjectionMatrix(pose, ASPECT), 610, 140, W, H)!;
    const p = pointAtViewDepth(pose, ray, 180)!;
    near(viewDepthOf(pose, p), 180, 1e-6 * 180, 'depth');
    const s = screen(pose, p);
    // Float32 matrices: a few hundredths of a pixel.
    near(s[0], 610, 0.05, 'x');
    near(s[1], 140, 0.05, 'y');
  }
});

void test('orbiting about a pivot keeps the pivot where it is on screen', () => {
  const pivot: Vec3 = [20, 10, 8];
  for (const pose of [perspective, orthographic, { ...perspective, roll: 0.4 }]) {
    const before = screen(pose, pivot);
    let next = pose;
    for (let i = 0; i < 6; i += 1) next = orbitAbout(next, 37, -23, pivot);
    const after = screen(next, pivot);
    near(after[0], before[0], 1e-2, 'x');
    near(after[1], before[1], 1e-2, 'y');
    near(viewDepthOf(next, pivot), viewDepthOf(pose, pivot), 1e-6 * 300, 'pivot depth');
    assert.notEqual(next.yaw, pose.yaw, 'the view turned');
  }
  // Without a pivot it is the old orbit about the target.
  assert.deepEqual(orbitAbout(perspective, 10, 5, null).target, perspective.target);
});

void test('zoom and pan at the pivot keep it under the cursor (into a bore, not behind it)', () => {
  const pivot: Vec3 = [12, 4, 6];
  for (const pose of [perspective, orthographic]) {
    const before = screen(pose, pivot);
    const zoomed = zoomTowards(pose, 0.5, pivot);
    const after = screen(zoomed, pivot);
    near(after[0], before[0], 1e-2, 'zoom x');
    near(after[1], before[1], 1e-2, 'zoom y');
    // Panning at the pivot's depth moves it 1:1 with the pointer.
    const panned = pan(pose, 30, -12, H, viewDepthOf(pose, pivot));
    const moved = screen(panned, pivot);
    near(moved[0] - before[0], 30, 1e-2, 'pan x');
    near(moved[1] - before[1], -12, 1e-2, 'pan y');
  }
  // Perspective zoom-in moves the eye towards the pivot.
  const zoomed = zoomTowards(perspective, 0.5, pivot);
  const d0 = Math.hypot(
    ...(eyeOf(perspective).map((v, i) => v - pivot[i]!) as [number, number, number]),
  );
  const d1 = Math.hypot(
    ...(eyeOf(zoomed).map((v, i) => v - pivot[i]!) as [number, number, number]),
  );
  near(d1, d0 * 0.5, 1e-6 * d0, 'eye halfway to the pivot');
});

void test('zoom keeps the cursor pixel fixed, over the model and over empty background', () => {
  // Owner rule: the screen point under the cursor stays put. Orthographic scales about the pixel
  // (no depth); perspective dollies along the cursor ray, the depth only sets the step.
  const cursor: [number, number] = [612, 173];
  for (const start of [perspective, orthographic, { ...perspective, fov: 70, roll: 0.3 }]) {
    const ray0 = unprojectRay(viewProjectionMatrix(start, ASPECT), cursor[0], cursor[1], W, H)!;
    // Two points on the cursor ray: the whole ray must keep projecting onto the cursor pixel.
    const nearPoint = pointAtViewDepth(start, ray0, 90)!;
    const farPoint = pointAtViewDepth(start, ray0, 600)!;
    const cases: { name: string; depthPoint: Vec3 | null }[] = [
      { name: 'over the model (surface depth)', depthPoint: pointAtViewDepth(start, ray0, 140)! },
      { name: 'over empty background (no depth)', depthPoint: null },
      {
        name: 'empty background, model-centre depth',
        depthPoint: pointAtViewDepth(start, ray0, 260)!,
      },
    ];
    for (const c of cases) {
      let pose = start;
      for (const factor of [0.8, 0.8, 0.8, 0.8, 1.25, 0.7, 1.4, 0.9]) {
        const ray = unprojectRay(viewProjectionMatrix(pose, ASPECT), cursor[0], cursor[1], W, H)!;
        pose = zoomAtRay(pose, factor, ray, c.depthPoint ? viewDepthOf(pose, c.depthPoint) : null);
        for (const p of [nearPoint, farPoint, ...(c.depthPoint ? [c.depthPoint] : [])]) {
          const s = projectToScreen(viewProjectionMatrix(pose, ASPECT), p, W, H);
          // Points the eye has passed or almost reached (perspective, zoomed far in) are skipped:
          // the Float32 matrices lose precision right in front of the eye.
          if (!s || viewDepthOf(pose, p) < start.distance * 0.1) continue;
          // Sub-pixel: a few hundredths of a pixel (Float32 matrices).
          near(s[0], cursor[0], 0.1, `${c.name} x (fov ${start.fov})`);
          near(s[1], cursor[1], 0.1, `${c.name} y (fov ${start.fov})`);
        }
      }
      assert.notEqual(pose.distance, start.distance, 'it zoomed');
    }
  }
  // Perspective: the step heads for the depth under the cursor and never passes it.
  let pose = perspective;
  const ray = unprojectRay(viewProjectionMatrix(pose, ASPECT), cursor[0], cursor[1], W, H)!;
  const surface = pointAtViewDepth(pose, ray, 120)!;
  for (let i = 0; i < 60; i += 1) {
    const r = unprojectRay(viewProjectionMatrix(pose, ASPECT), cursor[0], cursor[1], W, H)!;
    pose = zoomAtRay(pose, 0.8, r, viewDepthOf(pose, surface));
  }
  assert.ok(viewDepthOf(pose, surface) > 0, 'still in front of the surface');
});

void test('a projection change keeps the pivot plane: same place, same size', () => {
  const anchor: Vec3 = [30, 25, -10];
  const cases: [CameraPose, number][] = [
    [perspective, 0],
    [orthographic, 45],
    [perspective, 20],
    [orthographic, 2],
  ];
  for (const [pose, fov] of cases) {
    const next = withFovAt(pose, fov, anchor);
    // A point beside the anchor in its screen-parallel plane.
    const right = cameraBasis(pose).right;
    const other: Vec3 = [
      anchor[0] + 15 * right[0],
      anchor[1] + 15 * right[1],
      anchor[2] + 15 * right[2],
    ];
    const a0 = screen(pose, anchor);
    const a1 = screen(next, anchor);
    near(a1[0], a0[0], 1e-2, 'anchor x');
    near(a1[1], a0[1], 1e-2, 'anchor y');
    // A point beside the anchor in its screen-parallel plane keeps its distance on screen.
    const b0 = screen(pose, other);
    const b1 = screen(next, other);
    near(
      Math.hypot(b1[0] - a1[0], b1[1] - a1[1]),
      Math.hypot(b0[0] - a0[0], b0[1] - a0[1]),
      0.5,
      'scale',
    );
    assert.equal(next.fov, fov);
  }
  // Without an anchor the target plane keeps its size (the old withFov).
  const plain = withFovAt(perspective, 0);
  near(
    viewHeightAt(plain, plain.distance),
    viewHeightAt(perspective, perspective.distance),
    1e-9,
    'height at the target',
  );
  near(withFov(perspective, 0).distance, plain.distance, 1e-9, 'same as withFov');
});

void test('a camera animation blends the projection without a jump', () => {
  const to: CameraPose = { ...orthographic, yaw: 0.3, pitch: 0.2, distance: 260 };
  const start = lerpPose(perspective, to, 0);
  near(
    viewHeightAt(start, start.distance),
    viewHeightAt(perspective, perspective.distance),
    1e-6,
    'starts at the same apparent size',
  );
  assert.ok((start.fov ?? 0) > 0, 'still perspective at the start');
  let lastHeight = viewHeightAt(start, start.distance);
  let lastFov = start.fov!;
  for (let i = 1; i < 10; i += 1) {
    const pose = lerpPose(perspective, to, i / 10);
    const height = viewHeightAt(pose, pose.distance);
    assert.ok(height >= lastHeight - 1e-9, 'apparent size moves monotonically');
    assert.ok(pose.fov! <= lastFov + 1e-9, 'the perspective fades');
    lastHeight = height;
    lastFov = pose.fov!;
  }
  const end = lerpPose(perspective, to, 1);
  assert.deepEqual(
    [end.fov, end.distance, end.yaw, end.pitch, end.target],
    [0, 260, 0.3, 0.2, to.target],
  );
});

void test('adaptive: perspective while orbiting, parallel in sketches and standard views', () => {
  assert.equal(wantedFov('orthographic', 45, { sketching: false, standardView: false }), 0);
  assert.equal(wantedFov('perspective', 60, { sketching: true, standardView: true }), 60);
  assert.equal(wantedFov('adaptive', 50, { sketching: false, standardView: false }), 50);
  assert.equal(wantedFov('adaptive', 50, { sketching: true, standardView: false }), 0);
  assert.equal(wantedFov('adaptive', 50, { sketching: false, standardView: true }), 0);
  assert.equal(nextProjection('orthographic'), 'adaptive');
  assert.equal(nextProjection('adaptive'), 'perspective');
  assert.equal(nextProjection('perspective'), 'orthographic');
  // The blend ends exactly (orthographic is 0, not a tiny perspective) and starts near the source.
  const blend = { fromFov: 45, toFov: 0, start: 1000, duration: 200 };
  near(blendFov(blend, 1000).fov, 45, 1e-9, 'start');
  assert.deepEqual(blendFov(blend, 1200), { fov: 0, done: true });
  const mid = blendFov(blend, 1100);
  assert.ok(mid.fov > 0 && mid.fov < 45 && !mid.done, `mid ${mid.fov}`);
  const up = blendFov({ fromFov: 0, toFov: 45, start: 0, duration: 200 }, 1);
  assert.ok(up.fov > 0 && up.fov < 5, `leaves parallel gently: ${up.fov}`);
});

void test('preferences: Orthographic is the new default; an old stored default moves to it', () => {
  assert.equal(parsePreferences(null).projection, 'orthographic');
  assert.equal(parsePreferences(null).orbitAround, 'cursor');
  // Stored by an older build: "perspective" was its default, not a choice.
  assert.equal(
    parsePreferences(JSON.stringify({ projection: 'perspective' })).projection,
    'orthographic',
  );
  // A choice is kept.
  assert.equal(
    parsePreferences(JSON.stringify({ projection: 'perspective', projectionChosen: true }))
      .projection,
    'perspective',
  );
  assert.equal(parsePreferences(JSON.stringify({ projection: 'adaptive' })).projection, 'adaptive');
  assert.equal(
    parsePreferences(JSON.stringify({ projection: 'bogus', projectionChosen: true })).projection,
    'orthographic',
  );
  assert.equal(
    parsePreferences(JSON.stringify({ orbitAround: 'selection' })).orbitAround,
    'selection',
  );
  assert.equal(parsePreferences(JSON.stringify({ orbitAround: 'x' })).orbitAround, 'cursor');
});

void test('an open sketch hides the world axis out of its plane', () => {
  const colors = {
    background: [0, 0, 0],
    gridMinor: [0.5, 0.5, 0.5],
    gridMajor: [0.6, 0.6, 0.6],
    axisX: [1, 0, 0],
    axisY: [0, 1, 0],
    axisZ: [0, 0, 1],
    bodyEdge: [0, 0, 0],
    selection: [1, 0.6, 0],
    support: [0.2, 0.7, 1],
    hover: [1, 1, 1],
    activePreview: [1, 0.8, 0.4],
    sketchOutline: [0.1, 0.6, 0.95],
    wire: [0.8, 0.8, 0.8],
    light: false,
  } satisfies SceneInput['colors'];
  const input = (sketchNormal: Vec3 | null): SceneInput => ({
    colors,
    pose: perspective,
    aspect: ASPECT,
    viewportHeightPx: H,
    bodies: [],
    sketches: [],
    hiddenBodyIds: [],
    isolatedBodyIds: null,
    displayMode: 'shaded',
    section: { enabled: false, axis: 'Z', offset: 0, flipped: false, bounds: null },
    gridVisible: false,
    gridStep: 5,
    selection: [],
    hover: null,
    movePreview: null,
    extrudePreviewBodyId: null,
    extrudeHandle: null,
    moveHandle: null,
    sketchPreview: null,
    sketchNormal,
  });
  const axisCount = (normal: Vec3 | null) =>
    (buildScene(input(normal)).frame.underlay ?? []).filter(
      (b) => 'kind' in b && b.kind === 'lines' && b.segments?.length === 6,
    ).length;
  assert.equal(axisCount(null), 3);
  assert.equal(axisCount([0, 0, 1]), 2, 'XY sketch: no Z axis');
  assert.equal(axisCount([0, -1, 0]), 2, 'XZ sketch (normal −Y): no Y axis');
  assert.equal(axisCount([0.6, 0, 0.8]), 3, 'a tilted face plane: all axes stay');
});
