import assert from 'node:assert/strict';
import test from 'node:test';

import type { Body, EvaluatedSketch } from '../../renderer/src/foundation/geometry-kernel/types.js';
import {
  boxFilterForKey,
  boxModeFor,
  boxSelect,
  mergeSelection,
  nextBoxFilter,
  normalizeRect,
  segmentTouchesRect,
  targetKey,
  triangleTouchesRect,
  type Projector,
} from '../../renderer/src/platform/viewport/boxSelect.js';
import { cameraTargetBounds } from '../../renderer/src/platform/viewport/cameraTargets.js';
import {
  NAVIGATION_PRESETS,
  navigationPreset,
  resolveDrag,
} from '../../renderer/src/platform/input/navigation.js';
import {
  collectCandidates,
  edgesNearPoint,
  isAmbiguous,
  rayCastFaces,
  rayTriangle,
} from '../../renderer/src/platform/viewport/pickCandidates.js';

/**
 * An axis-aligned box body [x0,x1]×[y0,y1]×[z0,z1] with six faces ("-x", "+x", …),
 * two triangles each, and its twelve edges named by their two faces.
 */
function boxBody(id: string, min: [number, number, number], max: [number, number, number]): Body {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const corner = (i: number): [number, number, number] => [
    i & 1 ? x1 : x0,
    i & 2 ? y1 : y0,
    i & 4 ? z1 : z0,
  ];
  const positions: number[] = [];
  for (let i = 0; i < 8; i += 1) positions.push(...corner(i));
  const quads: [string, number[], [number, number, number]][] = [
    ['-x', [0, 2, 6, 4], [-1, 0, 0]],
    ['+x', [1, 5, 7, 3], [1, 0, 0]],
    ['-y', [0, 4, 5, 1], [0, -1, 0]],
    ['+y', [2, 3, 7, 6], [0, 1, 0]],
    ['-z', [0, 1, 3, 2], [0, 0, -1]],
    ['+z', [4, 6, 7, 5], [0, 0, 1]],
  ];
  const indices: number[] = [];
  const triangleFaces: number[] = [];
  const faces = quads.map(([key, q, normal], faceIndex) => {
    indices.push(q[0]!, q[1]!, q[2]!, q[0]!, q[2]!, q[3]!);
    triangleFaces.push(faceIndex, faceIndex);
    return {
      key,
      aliases: [],
      surface: 'plane' as const,
      normal,
      centroid: [0, 0, 0] as [number, number, number],
      area: 1,
      triangleStart: faceIndex * 2,
      triangleCount: 2,
      edgeIndices: [],
      adjacentFaces: 4,
    };
  });
  // Edges: pairs of corners differing in one bit.
  const edges = [];
  for (let a = 0; a < 8; a += 1) {
    for (const bit of [1, 2, 4]) {
      const b = a | bit;
      if (b === a) continue;
      const pa = corner(a);
      const pb = corner(b);
      edges.push({
        key: `e${a}-${b}`,
        faceIndices: [],
        curve: 'line' as const,
        midpoint: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2] as [
          number,
          number,
          number,
        ],
        length: 1,
        direction: null,
        segments: new Float32Array([...pa, ...pb]),
      });
    }
  }
  return {
    id,
    name: id,
    color: '#cccccc',
    createdBy: `f-${id}`,
    min,
    max,
    volume: (x1 - x0) * (y1 - y0) * (z1 - z0),
    valid: true,
    mesh: {
      positions: new Float32Array(positions),
      normals: new Float32Array(positions.length),
      indices: new Uint32Array(indices),
      triangleFaces: new Uint32Array(triangleFaces),
    },
    faces,
    edges,
  };
}

/** Top view: screen = world (x, -y) (y grows downwards on screen). */
const topView: Projector = (p) => [p[0], -p[1]];

const bodyA = boxBody('A', [0, 0, 0], [10, 10, 10]);
const bodyB = boxBody('B', [20, 0, 0], [30, 10, 10]);
const allVisible = (bodies: Body[]) =>
  new Set(
    bodies.flatMap((b) => [
      ...b.faces.map((f) => targetKey({ kind: 'face', bodyId: b.id, faceKey: f.key })),
      ...b.edges.map((e) => targetKey({ kind: 'edge', bodyId: b.id, edgeKey: e.key })),
    ]),
  );

void test('box direction: left → right is a window, right → left a crossing box', () => {
  assert.equal(boxModeFor(10, 50), 'window');
  assert.equal(boxModeFor(50, 10), 'crossing');
  assert.deepEqual(normalizeRect(50, 40, 10, 5), { x0: 10, y0: 5, x1: 50, y1: 40 });
});

void test('box filters: Tab cycles All → Bodies → Faces → Edges, B/F/E/A choose directly', () => {
  assert.equal(nextBoxFilter('all'), 'bodies');
  assert.equal(nextBoxFilter('edges'), 'all');
  assert.equal(nextBoxFilter('all', true), 'edges');
  assert.equal(boxFilterForKey('b'), 'bodies');
  assert.equal(boxFilterForKey('F'), 'faces');
  assert.equal(boxFilterForKey('e'), 'edges');
  assert.equal(boxFilterForKey('a'), 'all');
  assert.equal(boxFilterForKey('x'), null);
});

void test('segment/triangle vs rectangle', () => {
  const r = { x0: 0, y0: 0, x1: 10, y1: 10 };
  assert.ok(segmentTouchesRect([-5, 5], [15, 5], r)); // passes through
  assert.ok(!segmentTouchesRect([-5, -5], [-1, 20], r));
  assert.ok(triangleTouchesRect([-100, -100], [100, -100], [0, 100], r)); // rect inside triangle
  assert.ok(!triangleTouchesRect([20, 20], [30, 20], [25, 30], r));
});

void test('window box selects only bodies completely inside; crossing box also touched ones', () => {
  const bodies = [bodyA, bodyB];
  const visibleKeys = allVisible(bodies);
  // Screen rect around body A only, cutting through body B.
  const rect = normalizeRect(-1, 1, 25, -11);
  const window = boxSelect({
    rect,
    mode: 'window',
    filter: 'bodies',
    bodies,
    sketches: [],
    project: topView,
    visibleKeys,
    touchedKeys: new Set(),
    selectThrough: false,
  });
  assert.deepEqual(window, [{ kind: 'body', bodyId: 'A' }]);
  const crossing = boxSelect({
    rect,
    mode: 'crossing',
    filter: 'bodies',
    bodies,
    sketches: [],
    project: topView,
    visibleKeys,
    touchedKeys: new Set(),
    selectThrough: true,
  });
  assert.deepEqual(
    crossing.map((i) => (i.kind === 'body' ? i.bodyId : '?')),
    ['A', 'B'],
  );
});

void test('without Select Through a window ignores hidden geometry and crossing uses the id buffer', () => {
  const bodies = [bodyA];
  // Only the top face and its edges are visible (top view).
  const visibleKeys = new Set([targetKey({ kind: 'face', bodyId: 'A', faceKey: '+z' })]);
  const rect = normalizeRect(-1, 1, 11, -11);
  const faces = boxSelect({
    rect,
    mode: 'window',
    filter: 'faces',
    bodies,
    sketches: [],
    project: topView,
    visibleKeys,
    touchedKeys: new Set(),
    selectThrough: false,
  });
  assert.deepEqual(faces, [{ kind: 'face', bodyId: 'A', faceKey: '+z' }]);
  const through = boxSelect({
    rect,
    mode: 'window',
    filter: 'faces',
    bodies,
    sketches: [],
    project: topView,
    visibleKeys,
    touchedKeys: new Set(),
    selectThrough: true,
  });
  assert.equal(through.length, 6);
  const crossing = boxSelect({
    rect: normalizeRect(4, -4, 6, -6),
    mode: 'crossing',
    filter: 'edges',
    bodies,
    sketches: [],
    project: topView,
    visibleKeys,
    touchedKeys: new Set([targetKey({ kind: 'edge', bodyId: 'A', edgeKey: 'e4-5' })]),
    selectThrough: false,
  });
  assert.deepEqual(crossing, [{ kind: 'edge', bodyId: 'A', edgeKey: 'e4-5' }]);
});

void test('the All filter picks whole bodies and sketch profiles', () => {
  const sketch: EvaluatedSketch = {
    featureId: 'sk',
    frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
    profiles: [
      {
        key: 'r1',
        outline: [
          [40, 0, 0],
          [45, 0, 0],
          [45, 5, 0],
          [40, 5, 0],
        ],
        holes: [],
        triangles: [],
        center: [42, 2, 0],
        area: 25,
      },
    ],
    curves: [],
  };
  const result = boxSelect({
    rect: normalizeRect(-1, 1, 50, -11),
    mode: 'window',
    filter: 'all',
    bodies: [bodyA, bodyB],
    sketches: [sketch],
    project: topView,
    visibleKeys: allVisible([bodyA, bodyB]),
    touchedKeys: new Set(),
    selectThrough: false,
  });
  assert.deepEqual(result, [
    { kind: 'body', bodyId: 'A' },
    { kind: 'body', bodyId: 'B' },
    { kind: 'sketchProfile', featureId: 'sk', regionKey: 'r1' },
  ]);
});

void test('mergeSelection: Shift adds without duplicates, otherwise replaces', () => {
  const a = { kind: 'body' as const, bodyId: 'A' };
  const b = { kind: 'body' as const, bodyId: 'B' };
  assert.deepEqual(mergeSelection([a], [a, b], true), [a, b]);
  assert.deepEqual(mergeSelection([a], [b], false), [b]);
});

void test('ray casting finds every face along the ray, nearest first', () => {
  const ray = { origin: [5, 5, 100] as const, direction: [0, 0, -1] as const };
  assert.equal(rayTriangle(ray, [0, 0, 0], [10, 0, 0], [0, 10, 0]), 100);
  const hits = rayCastFaces([bodyA], ray);
  assert.deepEqual(
    hits.map((h) => h.faceKey),
    ['+z', '-z'],
  );
  assert.ok(hits[0]!.t < hits[1]!.t);
  assert.deepEqual(rayCastFaces([bodyB], ray), []);
});

void test('edges near a point: projected distance at any depth', () => {
  const near = edgesNearPoint([bodyA], topView, [10, -5], 1);
  // In the top view the x = 10 side shows two coincident vertical edges (z = 0 and z = 10) plus the vertical z edges at the corners project to points.
  assert.ok(near.length >= 2);
  assert.ok(near.every((e) => e.distancePx <= 1));
});

const names = {
  bodies: [bodyA],
  sketches: [],
  bodyName: (id: string) => `Body ${id}`,
  sketchName: (id: string) => `Sketch ${id}`,
};

void test('overlapping candidates: one edge + faces is not ambiguous, two edges are', () => {
  const edge = { kind: 'edge' as const, bodyId: 'A', edgeKey: 'e4-5' };
  const face = { kind: 'face' as const, bodyId: 'A', faceKey: '+z' };
  const one = collectCandidates(
    { visible: [edge, face], rayFaces: [], nearEdges: [], selectThrough: false },
    names,
  );
  assert.equal(isAmbiguous(one, false), false);
  const two = collectCandidates(
    {
      visible: [edge, { kind: 'edge', bodyId: 'A', edgeKey: 'e4-6' }, face],
      rayFaces: [],
      nearEdges: [],
      selectThrough: false,
    },
    names,
  );
  assert.equal(isAmbiguous(two, false), true);
  assert.match(two[0]!.label, /^Edge · Line/);
  assert.equal(two[0]!.owner, 'Body A');
});

void test('a sketch profile over a face is ambiguous (the face below becomes a candidate)', () => {
  const candidates = collectCandidates(
    {
      visible: [{ kind: 'sketchProfile', featureId: 'sk', regionKey: 'r1' }],
      rayFaces: [{ bodyId: 'A', faceKey: '+z', t: 1 }],
      nearEdges: [],
      selectThrough: false,
    },
    names,
  );
  assert.deepEqual(
    candidates.map((c) => c.kind),
    ['sketchProfile', 'face'],
  );
  assert.equal(isAmbiguous(candidates, false), true);
});

void test('Select Through adds occluded faces and edges and always asks', () => {
  const candidates = collectCandidates(
    {
      visible: [{ kind: 'face', bodyId: 'A', faceKey: '+z' }],
      rayFaces: [
        { bodyId: 'A', faceKey: '+z', t: 1 },
        { bodyId: 'A', faceKey: '-z', t: 2 },
      ],
      nearEdges: [{ bodyId: 'A', edgeKey: 'e0-1', distancePx: 0.5 }],
      selectThrough: true,
    },
    names,
  );
  assert.deepEqual(
    candidates.map((c) => [c.kind, c.occluded]),
    [
      ['face', false],
      ['edge', true],
      ['face', true],
    ],
  );
  assert.equal(isAmbiguous(candidates, true), true);
  assert.equal(isAmbiguous(candidates.slice(0, 1), true), false);
});

void test('navigation presets are data: Shapr3D right-drag orbits, SolidWorks middle-drag orbits', () => {
  const none = { shift: false, ctrl: false, alt: false };
  const shapr = navigationPreset('shapr3d');
  assert.equal(resolveDrag(shapr, 2, none), 'orbit');
  assert.equal(resolveDrag(shapr, 2, { ...none, shift: true }), 'pan');
  assert.equal(resolveDrag(shapr, 1, none), 'pan');
  assert.equal(resolveDrag(shapr, 0, none), 'select');
  const fusion = navigationPreset('fusion');
  assert.equal(resolveDrag(fusion, 1, none), 'pan');
  assert.equal(resolveDrag(fusion, 1, { ...none, shift: true }), 'orbit');
  assert.equal(resolveDrag(fusion, 2, none), null);
  const sw = navigationPreset('solidworks');
  assert.equal(resolveDrag(sw, 1, none), 'orbit');
  assert.equal(resolveDrag(sw, 1, { ...none, ctrl: true }), 'pan');
  // Every preset keeps left-click selection and has an orbit and a pan gesture.
  for (const preset of NAVIGATION_PRESETS) {
    assert.equal(resolveDrag(preset, 0, none), 'select');
    assert.ok(preset.bindings.some((b) => b.action === 'orbit'));
    assert.ok(preset.bindings.some((b) => b.action === 'pan'));
  }
});

void test('zoom-to-selection bounds: bodies, faces and edges', () => {
  const evaluation = { bodies: [bodyA, bodyB], sketches: [] };
  const [body] = cameraTargetBounds(evaluation, [{ kind: 'body', bodyId: 'B' }]);
  assert.deepEqual(body, { min: [20, 0, 0], max: [30, 10, 10] });
  const [face] = cameraTargetBounds(evaluation, [{ kind: 'face', bodyId: 'A', faceKey: '+z' }]);
  assert.deepEqual(face, { min: [0, 0, 10], max: [10, 10, 10] });
  const [edge] = cameraTargetBounds(evaluation, [{ kind: 'edge', bodyId: 'A', edgeKey: 'e0-1' }]);
  assert.deepEqual(edge, { min: [0, 0, 0], max: [10, 0, 0] });
  assert.deepEqual(cameraTargetBounds(evaluation, [{ kind: 'feature', featureId: 'x' }]), []);
});
