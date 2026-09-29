/**
 * Modelling features on the real OCCT kernel (`kernel/features/`): Revolve,
 * Sweep, Loft, Mirror, Pattern, Split, Transform, Align, Offset Face and
 * Delete Face — volumes and bounding boxes against hand calculations,
 * B-rep validity, stable references across an earlier parameter edit, and
 * the error paths.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Body, EvaluationResult } from '../../renderer/src/kernel/types.js';
import { edgeSignatureOf, faceSignatureOf } from '../../renderer/src/kernel/naming.js';
import type {
  ExtrudeFeature,
  FaceRef,
  Feature,
  FilletFeature,
  Plane,
  SketchFeature,
} from '../../renderer/src/model/document.js';
import type {
  AlignFeature,
  AxisRef,
  DeleteFaceFeature,
  LoftFeature,
  MirrorFeature,
  OffsetFaceFeature,
  PatternFeature,
  RevolveFeature,
  SplitFeature,
  SweepFeature,
  TransformFeature,
} from '../../renderer/src/model/features.js';
import { addPolyline, sketchFromLegacyProfiles } from '../../renderer/src/sketch/builders.js';
import { EMPTY_SKETCH } from '../../renderer/src/sketch/types.js';
import { detectRegions } from '../../renderer/src/sketch/regions.js';
import type { LegacySketchProfile } from '../sketch/fixtures.js';
import { PROJECT_FORMAT_ID, loadProjectFile } from '../../renderer/src/model/project/format.js';
import { loadNodeKernel } from './nodeKernel.js';

const base = (id: string) => ({ id, name: id, suppressed: false });

function sketch(
  id: string,
  plane: Plane,
  offset: number,
  ...profiles: LegacySketchProfile[]
): SketchFeature {
  // Rectangle sides become lines l1 (bottom, -v), l2 (+u), l3 (top), l4 (-u); a circle is c1.
  const { sketch: data } = sketchFromLegacyProfiles(profiles);
  return { ...base(id), kind: 'sketch', plane: { kind: 'plane', plane, offset }, ...data };
}

/** Key of the only region of a sketch feature. */
function regionKey(feature: SketchFeature): string {
  const [region] = detectRegions(feature);
  assert.ok(region, `${feature.id} has a region`);
  return region.key;
}

function extrude(
  id: string,
  sketchId: string,
  distance: number,
  extra: Partial<ExtrudeFeature> = {},
): ExtrudeFeature {
  return {
    ...base(id),
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketchId },
    distance,
    symmetric: false,
    operation: 'new',
    ...extra,
  };
}

/** Box `x0..x0+w, y0..y0+d, z0..z0+h` as `<id>-s` + `<id>` (body `body:<id>`). */
function box(
  id: string,
  x0: number,
  y0: number,
  w: number,
  d: number,
  h: number,
  z0 = 0,
): Feature[] {
  return [
    sketch(`${id}-s`, 'XY', z0, { kind: 'rectangle', x: x0, y: y0, width: w, height: d }),
    extrude(id, `${id}-s`, h),
  ];
}

function revolve(
  id: string,
  profile: RevolveFeature['profile'],
  axis: AxisRef,
  angle = 360,
  extra: Partial<RevolveFeature> = {},
): RevolveFeature {
  return { ...base(id), kind: 'revolve', profile, axis, angle, operation: 'new', ...extra };
}

async function evaluate(features: Feature[]): Promise<EvaluationResult> {
  const { evaluator } = await loadNodeKernel();
  return evaluator.evaluate(features);
}

function only(result: EvaluationResult, id?: string): Body {
  const found = id ? result.bodies.find((b) => b.id === id) : result.bodies[0];
  assert.ok(
    found,
    `body ${id ?? '#0'} exists (bodies: ${result.bodies.map((b) => b.id).join(', ')}; errors: ${JSON.stringify(result.errors)})`,
  );
  return found;
}

function near(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: expected ${expected}, got ${actual}`);
}

function bbox(body: Body, min: number[], max: number[], tol = 1e-4): void {
  body.min.forEach((v, i) => near(v, min[i]!, tol, `min[${i}] of ${body.id}`));
  body.max.forEach((v, i) => near(v, max[i]!, tol, `max[${i}] of ${body.id}`));
}

function faceRef(body: Body, predicate: (f: Body['faces'][number]) => boolean): FaceRef {
  const face = body.faces.find(predicate);
  assert.ok(face, `face found on ${body.id}`);
  return { bodyId: body.id, key: face.key, signature: faceSignatureOf(face) };
}

const topOf = (z: number) => (f: Body['faces'][number]) =>
  f.surface === 'plane' && f.normal?.[2] === 1 && Math.abs(f.centroid[2] - z) < 1e-6;

// ---- Revolve -------------------------------------------------------------------------

void test('revolve: full and partial revolutions of a sketch rectangle about world Z', async () => {
  const ring = sketch('s1', 'XZ', 0, { kind: 'rectangle', x: 10, y: 0, width: 10, height: 5 });
  const full = await evaluate([
    ring,
    revolve('r1', { kind: 'sketch', featureId: 's1' }, { kind: 'world', axis: 'Z' }),
  ]);
  assert.deepEqual(full.errors, {});
  const body = only(full);
  near(body.volume, Math.PI * (20 * 20 - 10 * 10) * 5, 1e-3, 'ring volume');
  bbox(body, [-20, -20, 0], [20, 20, 5]);
  assert.equal(body.valid, true);
  // Faces named after the profile's sketch lines: l2 = +u side (outer wall), l4 = -u side (inner wall).
  const outer = body.faces.find((f) => f.key === 'r1:side:0:l2');
  assert.equal(outer?.surface, 'cylinder');
  near(outer.area, 2 * Math.PI * 20 * 5, 1e-3, 'outer wall area');
  assert.ok(body.faces.some((f) => f.key === 'r1:side:0:l4'));
  assert.ok(
    body.faces.some((f) => f.key === 'r1:side:0:l1'),
    'bottom annulus named by OCCT-missed fallback',
  );

  const quarter = await evaluate([
    ring,
    revolve('r1', { kind: 'sketch', featureId: 's1' }, { kind: 'world', axis: 'Z' }, 90),
  ]);
  const q = only(quarter);
  near(q.volume, (Math.PI * (400 - 100) * 5) / 4, 1e-3, 'quarter volume');
  assert.ok(
    q.faces.some((f) => f.key === 'r1:start:0') && q.faces.some((f) => f.key === 'r1:end:0'),
  );
  assert.equal(q.valid, true);
  const negative = only(
    await evaluate([
      ring,
      revolve('r1', { kind: 'sketch', featureId: 's1' }, { kind: 'world', axis: 'Z' }, -90),
    ]),
  );
  near(negative.volume, q.volume, 1e-6, 'negative angle volume');
  assert.ok(negative.max[1] < 1e-6 && negative.min[1] < -19, 'turned the other way (towards -Y)');
});

void test('revolve: axis from a sketch line and from a body edge', async () => {
  const s = sketch('s1', 'XZ', 0, { kind: 'rectangle', x: 0, y: 0, width: 10, height: 5 });
  // Revolve about the rectangle's own left side (line l4, the Z axis) -> cylinder r=10 h=5.
  const cyl = only(
    await evaluate([
      s,
      revolve(
        'r1',
        { kind: 'sketch', featureId: 's1' },
        { kind: 'sketchLine', featureId: 's1', entityId: 'l4' },
      ),
    ]),
  );
  near(cyl.volume, Math.PI * 100 * 5, 1e-3, 'cylinder volume');

  // A box whose vertical edge x=40,y=0 is the axis; a free profile 5..15 mm from it.
  const features: Feature[] = [...box('b', 40, 0, 10, 10, 10)];
  const boxBody = only(await evaluate(features), 'body:b');
  const edge = boxBody.edges.find(
    (e) =>
      e.curve === 'line' &&
      e.direction &&
      Math.abs(Math.abs(e.direction[2]) - 1) < 1e-9 &&
      Math.abs(e.midpoint[0] - 40) < 1e-9 &&
      Math.abs(e.midpoint[1]) < 1e-9,
  )!;
  const profile = sketch('p', 'XZ', 0, { kind: 'rectangle', x: 20, y: 0, width: 10, height: 4 });
  const result = await evaluate([
    ...features,
    profile,
    revolve(
      'r2',
      { kind: 'sketch', featureId: 'p' },
      { kind: 'edge', edge: { bodyId: 'body:b', key: edge.key, signature: edgeSignatureOf(edge) } },
      360,
      {
        operation: 'new',
      },
    ),
  ]);
  assert.deepEqual(result.errors, {});
  const ring = only(result, 'body:r2');
  near(ring.volume, Math.PI * (20 * 20 - 10 * 10) * 4, 1e-3, 'ring about the edge');
  bbox(ring, [20, -20, 0], [60, 20, 4]);
});

void test('revolve: an L-profile about a construction centre line of the same sketch', async () => {
  let data = addPolyline(
    EMPTY_SKETCH,
    [
      [5, 0],
      [15, 0],
      [15, 4],
      [9, 4],
      [9, 10],
      [5, 10],
    ],
    { closed: true },
  ).sketch;
  const axis = addPolyline(
    data,
    [
      [2, -2],
      [2, 12],
    ],
    { construction: true },
  );
  data = axis.sketch;
  const s: SketchFeature = {
    ...base('s1'),
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XZ', offset: 0 },
    ...data,
  };
  // The construction line bounds no region: the profile is the L alone.
  assert.equal(detectRegions(s).length, 1);
  const lineId = axis.lineIds[0]!;
  const result = await evaluate([
    s,
    revolve(
      'r1',
      { kind: 'sketch', featureId: 's1' },
      { kind: 'sketchLine', featureId: 's1', entityId: lineId },
    ),
  ]);
  assert.deepEqual(result.errors, {});
  const body = only(result);
  // Pappus about u = 2: rectangles u 5..15 x v 0..4 and u 5..9 x v 4..10 (radii from the axis).
  const ring = (r0: number, r1: number, h: number) => Math.PI * (r1 * r1 - r0 * r0) * h;
  near(body.volume, ring(3, 13, 4) + ring(3, 7, 6), 1e-3, 'revolved L');
  bbox(body, [-11, -13, 0], [15, 13, 10]);
  assert.equal(body.valid, true);

  const missing = await evaluate([
    s,
    revolve(
      'r2',
      { kind: 'sketch', featureId: 's1' },
      { kind: 'sketchLine', featureId: 's1', entityId: 'l99' },
    ),
  ]);
  assert.equal(missing.errors.r2, 'Missing reference: line "l99" of "s1"');
  const notLine = await evaluate([
    sketch('c', 'XZ', 0, { kind: 'circle', cx: 20, cy: 0, radius: 2 }),
    revolve(
      'r3',
      { kind: 'sketch', featureId: 'c' },
      { kind: 'sketchLine', featureId: 'c', entityId: 'c1' },
    ),
  ]);
  assert.equal(notLine.errors.r3, 'An axis must be a straight sketch line');
});

void test('revolve: join onto a body, cut a groove into a shaft; errors are readable', async () => {
  const shaft = [
    sketch('s', 'XY', 0, { kind: 'circle', cx: 0, cy: 0, radius: 10 }),
    extrude('shaft', 's', 40),
  ];
  const groove = sketch('g', 'XZ', 0, { kind: 'rectangle', x: 8, y: 18, width: 6, height: 4 });
  const cut = await evaluate([
    ...shaft,
    groove,
    revolve('rc', { kind: 'sketch', featureId: 'g' }, { kind: 'world', axis: 'Z' }, 360, {
      operation: 'cut',
      targetBodyId: 'body:shaft',
    }),
  ]);
  assert.deepEqual(cut.errors, {});
  const body = only(cut);
  near(body.volume, Math.PI * 100 * 40 - Math.PI * (100 - 64) * 4, 1e-3, 'grooved shaft');
  assert.equal(body.valid, true);
  assert.ok(
    body.faces.some((f) => f.key === 'rc:side:0:l4' && f.surface === 'cylinder'),
    'groove bottom keyed',
  );

  const collar = sketch('c', 'XZ', 0, { kind: 'rectangle', x: 10, y: 0, width: 5, height: 3 });
  const joined = await evaluate([
    ...shaft,
    collar,
    revolve('rj', { kind: 'sketch', featureId: 'c' }, { kind: 'world', axis: 'Z' }, 360, {
      operation: 'join',
      targetBodyId: 'body:shaft',
    }),
  ]);
  assert.equal(joined.bodies.length, 1);
  near(
    only(joined).volume,
    Math.PI * 100 * 40 + Math.PI * (225 - 100) * 3,
    1e-3,
    'shaft with collar',
  );

  const crossing = sketch('x', 'XZ', 0, { kind: 'rectangle', x: -5, y: 0, width: 10, height: 5 });
  const bad = await evaluate([
    crossing,
    revolve('rx', { kind: 'sketch', featureId: 'x' }, { kind: 'world', axis: 'Z' }),
  ]);
  assert.equal(bad.errors.rx, 'The profile crosses the revolve axis');
  assert.equal(bad.bodies.length, 0);
  const perpendicular = await evaluate([
    crossing,
    revolve('rp', { kind: 'sketch', featureId: 'x' }, { kind: 'world', axis: 'Y' }),
  ]);
  assert.equal(
    perpendicular.errors.rp,
    'The revolve axis must not be perpendicular to the profile',
  );
  const missing = await evaluate([
    revolve('rm', { kind: 'sketch', featureId: 'nope' }, { kind: 'world', axis: 'Z' }),
  ]);
  assert.equal(missing.errors.rm, 'Missing reference: sketch "nope"');
  const angle = await evaluate([
    crossing,
    revolve('ra', { kind: 'sketch', featureId: 'x' }, { kind: 'world', axis: 'Z' }, 0),
  ]);
  assert.match(angle.errors.ra ?? '', /angle/);
});

void test('revolve: a fillet on a revolved edge survives an earlier sketch edit (stable references)', async () => {
  const doc = (width: number): Feature[] => [
    sketch('s1', 'XZ', 0, { kind: 'rectangle', x: 10, y: 0, width, height: 5 }),
    revolve('r1', { kind: 'sketch', featureId: 's1' }, { kind: 'world', axis: 'Z' }),
  ];
  const first = only(await evaluate(doc(10)));
  // Outer top circle: between the outer wall (side:0:l2) and the top annulus (side:0:l3).
  const edge = first.edges.find((e) => e.key === 'r1:side:0:l2|r1:side:0:l3');
  assert.ok(edge, `outer top edge keyed (edges: ${first.edges.map((e) => e.key).join(', ')})`);
  const fillet: FilletFeature = {
    ...base('f1'),
    kind: 'fillet',
    radius: 1,
    edges: [{ bodyId: first.id, key: edge.key, signature: edgeSignatureOf(edge) }],
  };
  const before = await evaluate([...doc(10), fillet]);
  assert.deepEqual(before.errors, {});
  const after = await evaluate([...doc(14), fillet]);
  assert.deepEqual(after.errors, {});
  assert.deepEqual(after.warnings, {}, 'resolved by key, not by geometry');
  const body = only(after);
  bbox(body, [-24, -24, 0], [24, 24, 5]);
  assert.equal(body.valid, true);
  const round = body.faces.find((f) => f.key === 'f1:round:0');
  assert.equal(round?.surface, 'torus', 'the fillet stayed on the outer top edge');
  near(round.centroid[2], 4 + 2 / Math.PI, 0.05, 'fillet at the top outer edge');
});

// ---- Sweep -------------------------------------------------------------------------

void test('sweep: along a line, a closed sketch path (torus) and a body edge', async () => {
  const profile = sketch('p', 'XY', 0, { kind: 'circle', cx: 0, cy: 0, radius: 2 });
  const line: SweepFeature = {
    ...base('w1'),
    kind: 'sweep',
    profile: { kind: 'sketch', featureId: 'p' },
    path: { kind: 'line', start: [0, 0, 0], end: [0, 0, 30] },
    operation: 'new',
  };
  const rod = only(await evaluate([profile, line]));
  near(rod.volume, Math.PI * 4 * 30, 1e-3, 'rod volume');
  bbox(rod, [-2, -2, 0], [2, 2, 30]);
  assert.ok(rod.faces.some((f) => f.key === 'w1:side:0:c1' && f.surface === 'cylinder'));
  assert.ok(
    rod.faces.some((f) => f.key === 'w1:start:0') && rod.faces.some((f) => f.key === 'w1:end:0'),
  );

  // Torus: small circle on XZ at x=20 swept around a circle of radius 20 on XY.
  const ringPath = sketch('path', 'XY', 0, { kind: 'circle', cx: 0, cy: 0, radius: 20 });
  const small = sketch('small', 'XZ', 0, { kind: 'circle', cx: 20, cy: 0, radius: 2 });
  const torus = await evaluate([
    ringPath,
    small,
    {
      ...line,
      id: 'w2',
      profile: { kind: 'sketch', featureId: 'small' },
      path: { kind: 'sketch', featureId: 'path', region: regionKey(ringPath) },
    },
  ]);
  assert.deepEqual(torus.errors, {});
  near(only(torus).volume, 2 * Math.PI * Math.PI * 20 * 4, 0.05, 'torus volume');
  assert.equal(only(torus).valid, true);

  // Along the top circular edge of a cylinder (edge path), joined into it: an O-ring bead.
  const cylinder = [
    sketch('c', 'XY', 0, { kind: 'circle', cx: 0, cy: 0, radius: 20 }),
    extrude('cyl', 'c', 10),
  ];
  const cylBody = only(await evaluate(cylinder));
  const topEdge = cylBody.edges.find(
    (e) => e.curve === 'circle' && Math.abs(e.midpoint[2] - 10) < 1e-9,
  )!;
  const bead = sketch('bead', 'XZ', 0, { kind: 'circle', cx: 20, cy: 10, radius: 1 });
  const beaded = await evaluate([
    ...cylinder,
    bead,
    {
      ...line,
      id: 'w3',
      profile: { kind: 'sketch', featureId: 'bead' },
      path: {
        kind: 'edges',
        edges: [{ bodyId: cylBody.id, key: topEdge.key, signature: edgeSignatureOf(topEdge) }],
      },
      operation: 'join',
      targetBodyId: cylBody.id,
    },
  ]);
  assert.deepEqual(beaded.errors, {});
  const beadBody = only(beaded);
  assert.equal(beadBody.valid, true);
  // Pappus: the bead torus minus its quarter inside the cylinder (area π/4, centroid radius 20 - 4/(3π)).
  const inside = (Math.PI / 4) * 2 * Math.PI * (20 - 4 / (3 * Math.PI));
  near(
    beadBody.volume,
    Math.PI * 400 * 10 + 2 * Math.PI * Math.PI * 20 - inside,
    1e-2,
    'cylinder + bead',
  );
  near(beadBody.max[2], 11, 1e-3, 'bead on top');

  const short = await evaluate([
    profile,
    { ...line, id: 'w4', path: { kind: 'line', start: [0, 0, 0], end: [0, 0, 0.01] } },
  ]);
  assert.match(short.errors.w4 ?? '', /at least/);
});

// ---- Loft --------------------------------------------------------------------------

void test('loft: square frustum (ruled) matches the prismatoid volume; three sections; errors', async () => {
  const s1 = sketch('a', 'XY', 0, { kind: 'rectangle', x: -5, y: -5, width: 10, height: 10 });
  const s2 = sketch('b', 'XY', 20, { kind: 'rectangle', x: -3, y: -3, width: 6, height: 6 });
  const loft: LoftFeature = {
    ...base('l1'),
    kind: 'loft',
    profiles: [
      { kind: 'sketch', featureId: 'a', regions: [regionKey(s1)] },
      { kind: 'sketch', featureId: 'b', regions: [regionKey(s2)] },
    ],
    ruled: true,
    operation: 'new',
  };
  const frustum = only(await evaluate([s1, s2, loft]));
  near(frustum.volume, (20 / 3) * (100 + 36 + Math.sqrt(100 * 36)), 1e-3, 'frustum volume');
  bbox(frustum, [-5, -5, 0], [5, 5, 20]);
  assert.equal(frustum.valid, true);
  assert.ok(
    frustum.faces.some((f) => f.key === 'l1:start:0') &&
      frustum.faces.some((f) => f.key === 'l1:end:0'),
  );
  assert.equal(frustum.faces.filter((f) => f.key.startsWith('l1:side:0:')).length, 4);

  const c1 = sketch('c1', 'XY', 0, { kind: 'circle', cx: 0, cy: 0, radius: 5 });
  const c2 = sketch('c2', 'XY', 10, { kind: 'circle', cx: 0, cy: 0, radius: 3 });
  const c3 = sketch('c3', 'XY', 20, { kind: 'circle', cx: 0, cy: 0, radius: 5 });
  const vase = await evaluate([
    c1,
    c2,
    c3,
    {
      ...loft,
      id: 'l2',
      ruled: true,
      profiles: ['c1', 'c2', 'c3'].map((featureId) => ({ kind: 'sketch' as const, featureId })),
    },
  ]);
  assert.deepEqual(vase.errors, {});
  // Two ruled cone frustums r5->r3 over 10 mm each.
  near(only(vase).volume, 2 * ((Math.PI * 10) / 3) * (25 + 9 + 15), 1e-2, 'double frustum');

  const same = await evaluate([
    s1,
    { ...loft, id: 'l3', profiles: [loft.profiles[0]!, loft.profiles[0]!] },
  ]);
  assert.equal(same.errors.l3, 'Loft profiles 1 and 2 lie on the same plane');
  const one = await evaluate([s1, { ...loft, id: 'l4', profiles: [loft.profiles[0]!] }]);
  assert.equal(one.errors.l4, 'Select at least two profiles to loft');
});

void test('revolve, sweep and loft bodies are named after their creating feature', async () => {
  // Two extrudes first, so a global body count would call the revolve "Revolve 3".
  const ring = sketch('s1', 'XZ', 0, { kind: 'rectangle', x: 10, y: 0, width: 10, height: 5 });
  const disc = sketch('p', 'XY', 50, { kind: 'circle', cx: 0, cy: 0, radius: 2 });
  const s1 = sketch('a', 'XY', 100, { kind: 'rectangle', x: -5, y: -5, width: 10, height: 10 });
  const s2 = sketch('b', 'XY', 120, { kind: 'rectangle', x: -3, y: -3, width: 6, height: 6 });
  const result = await evaluate([
    ...box('b1', 100, 100, 5, 5, 5),
    ...box('b2', 200, 100, 5, 5, 5),
    ring,
    {
      ...revolve('r1', { kind: 'sketch', featureId: 's1' }, { kind: 'world', axis: 'Z' }),
      name: 'Revolve 1',
    },
    disc,
    {
      ...base('w1'),
      name: 'Sweep 1',
      kind: 'sweep',
      profile: { kind: 'sketch', featureId: 'p' },
      path: { kind: 'line', start: [0, 0, 50], end: [0, 0, 70] },
      operation: 'new',
    },
    s1,
    s2,
    {
      ...base('l1'),
      name: 'Loft 1',
      kind: 'loft',
      profiles: [
        { kind: 'sketch', featureId: 'a' },
        { kind: 'sketch', featureId: 'b' },
      ],
      ruled: true,
      operation: 'new',
    },
  ]);
  assert.deepEqual(result.errors, {});
  const names = Object.fromEntries(result.bodies.map((b) => [b.createdBy, b.name]));
  assert.deepEqual(
    { r1: names.r1, w1: names.w1, l1: names.l1 },
    { r1: 'Revolve 1', w1: 'Sweep 1', l1: 'Loft 1' },
  );
  // An explicit result name still wins.
  const named = await evaluate([
    ring,
    {
      ...revolve('r2', { kind: 'sketch', featureId: 's1' }, { kind: 'world', axis: 'Z' }),
      resultBodyName: 'Ring',
    },
  ]);
  assert.equal(only(named).name, 'Ring');
});

// ---- Mirror, Pattern, Split, Transform, Align ---------------------------------------------

void test('mirror: copies across a world plane or a face, or mirrors in place keeping face keys', async () => {
  const doc = box('b', 0, 0, 10, 20, 5);
  const copy: MirrorFeature = {
    ...base('m1'),
    kind: 'mirror',
    bodyIds: ['body:b'],
    plane: { kind: 'plane', plane: 'YZ', offset: 0 },
    keepOriginal: true,
  };
  const two = await evaluate([...doc, copy]);
  assert.equal(two.bodies.length, 2);
  bbox(only(two, 'body:m1:0'), [-10, 0, 0], [0, 20, 5]);
  assert.equal(only(two, 'body:m1:0').valid, true);
  near(only(two, 'body:m1:0').volume, 1000, 1e-6, 'mirror volume');

  const inPlace = await evaluate([...doc, { ...copy, keepOriginal: false }]);
  assert.equal(inPlace.bodies.length, 1);
  const moved = only(inPlace);
  bbox(moved, [-10, 0, 0], [0, 20, 5]);
  assert.ok(
    moved.faces.some((f) => f.key === 'b:end:0' && f.normal?.[2] === 1),
    'top keeps its key',
  );

  const first = only(await evaluate(doc));
  const side = faceRef(first, (f) => f.normal?.[0] === 1);
  const acrossFace = await evaluate([...doc, { ...copy, plane: { kind: 'face', face: side } }]);
  bbox(only(acrossFace, 'body:m1:0'), [10, 0, 0], [20, 20, 5]);
});

void test('pattern: linear and circular copies; count/spacing validation', async () => {
  const doc = box('b', 0, 0, 10, 10, 10);
  const linear: PatternFeature = {
    ...base('p1'),
    kind: 'pattern',
    bodyIds: ['body:b'],
    pattern: { kind: 'linear', direction: { kind: 'world', axis: 'X' }, count: 4, spacing: 15 },
  };
  const row = await evaluate([...doc, linear]);
  assert.deepEqual(row.errors, {});
  assert.equal(row.bodies.length, 4);
  const last = row.bodies[3]!;
  bbox(last, [45, 0, 0], [55, 10, 10]);
  assert.equal(last.name, 'Body 1 (4)');

  const ring = await evaluate([
    ...box('c', 20, -5, 10, 10, 10),
    {
      ...linear,
      bodyIds: ['body:c'],
      pattern: { kind: 'circular', axis: { kind: 'world', axis: 'Z' }, count: 6, angle: 360 },
    },
  ]);
  assert.equal(ring.bodies.length, 6);
  const opposite = ring.bodies[3]!; // 180°
  bbox(opposite, [-30, -5, 0], [-20, 5, 10]);
  ring.bodies.forEach((b) => near(b.volume, 1000, 1e-6, 'copy volume'));

  const partial = await evaluate([
    ...box('c', 20, -5, 10, 10, 10),
    {
      ...linear,
      bodyIds: ['body:c'],
      pattern: { kind: 'circular', axis: { kind: 'world', axis: 'Z' }, count: 3, angle: 90 },
    },
  ]);
  bbox(partial.bodies[2]!, [-5, 20, 0], [5, 30, 10]);

  const bad = await evaluate([...doc, { ...linear, pattern: { ...linear.pattern, count: 1 } }]);
  assert.match(bad.errors.p1 ?? '', /count/);
  const missing = await evaluate([...doc, { ...linear, bodyIds: ['body:gone'] }]);
  assert.equal(missing.errors.p1, 'Missing reference: body "body:gone"');
});

void test('split: two bodies by a plane; the plane must cut the body', async () => {
  const doc = box('b', 0, 0, 20, 20, 10);
  const split: SplitFeature = {
    ...base('x1'),
    kind: 'split',
    bodyId: 'body:b',
    plane: { kind: 'plane', plane: 'XY', offset: 4 },
  };
  const result = await evaluate([...doc, split]);
  assert.deepEqual(result.errors, {});
  assert.equal(result.bodies.length, 2);
  const lower = only(result, 'body:b');
  const upper = only(result, 'body:x1');
  near(lower.volume, 20 * 20 * 4, 1e-6, 'lower part');
  near(upper.volume, 20 * 20 * 6, 1e-6, 'upper part');
  bbox(upper, [0, 0, 4], [20, 20, 10]);
  assert.ok(lower.valid && upper.valid);
  assert.ok(
    lower.faces.some((f) => f.key === 'x1:cut'),
    'cut face named',
  );
  assert.ok(
    upper.faces.some((f) => f.key === 'b:end:0'),
    'upper keeps the top key',
  );

  const miss = await evaluate([
    ...doc,
    { ...split, plane: { kind: 'plane', plane: 'XY', offset: 30 } },
  ]);
  assert.equal(miss.errors.x1, 'The plane does not cut "Body 1"');
  assert.equal(miss.bodies.length, 1);
});

void test('transform: rotate about a pivot and translate; copy; later references survive', async () => {
  const doc = box('b', 0, 0, 20, 10, 5);
  const rotate: TransformFeature = {
    ...base('t1'),
    kind: 'transform',
    bodyId: 'body:b',
    dx: 0,
    dy: 0,
    dz: 10,
    rx: 0,
    ry: 0,
    rz: 90,
    pivot: [0, 0, 0],
    copy: false,
  };
  const turned = only(await evaluate([...doc, rotate]));
  bbox(turned, [-10, 0, 10], [0, 20, 15]);
  assert.ok(turned.faces.some((f) => f.key === 'b:end:0' && Math.abs(f.centroid[2] - 15) < 1e-6));

  const copied = await evaluate([...doc, { ...rotate, copy: true }]);
  assert.equal(copied.bodies.length, 2);
  bbox(only(copied, 'body:b'), [0, 0, 0], [20, 10, 5]);
  bbox(only(copied, 'body:t1'), [-10, 0, 10], [0, 20, 15]);

  // A fillet taken after the transform keeps resolving when the box sketch changes size.
  const edge = turned.edges.find(
    (e) =>
      e.curve === 'line' &&
      Math.abs(e.midpoint[2] - 15) < 1e-6 &&
      Math.abs(e.midpoint[0] + 10) < 1e-6,
  )!;
  const fillet: FilletFeature = {
    ...base('f1'),
    kind: 'fillet',
    radius: 1,
    edges: [{ bodyId: 'body:b', key: edge.key, signature: edgeSignatureOf(edge) }],
  };
  const edited = await evaluate([
    sketch('b-s', 'XY', 0, { kind: 'rectangle', x: 0, y: 0, width: 30, height: 10 }),
    doc[1]!,
    rotate,
    fillet,
  ]);
  assert.deepEqual(edited.errors, {});
  assert.deepEqual(edited.warnings, {});
  bbox(only(edited), [-10, 0, 10], [0, 30, 15]);
});

void test('align: a face of body A lands opposed on a face of body B', async () => {
  const doc = [...box('a', 0, 0, 10, 10, 10), ...box('c', 30, 0, 20, 20, 20)];
  const result = await evaluate(doc);
  const a = only(result, 'body:a');
  const c = only(result, 'body:c');
  const align: AlignFeature = {
    ...base('al'),
    kind: 'align',
    bodyId: a.id,
    face: faceRef(a, topOf(10)),
    target: faceRef(c, (f) => f.normal?.[0] === -1),
    flip: false,
    center: true,
    offset: 0,
  };
  const aligned = await evaluate([...doc, align]);
  assert.deepEqual(aligned.errors, {});
  const moved = only(aligned, 'body:a');
  // A's top (+Z) now faces -(-X) = +X at x=30, centred on the target (y=10, z=10).
  bbox(moved, [20, 5, 5], [30, 15, 15]);
  const top = moved.faces.find((f) => f.key === 'a:end:0')!;
  assert.deepEqual(
    top.normal?.map((v) => Math.round(v) || 0),
    [1, 0, 0],
  );

  const gap = only(
    await evaluate([...doc, { ...align, flip: true, center: false, offset: 2 }]),
    'body:a',
  );
  // Same direction as the target (-X), 2 mm in front of it: A's top at x=32... outside B? No: along -X normal -> x=28.
  near(gap.min[0], 28, 1e-6, 'flush with a 2 mm offset along the target normal');
  const self = await evaluate([
    ...doc,
    { ...align, target: faceRef(a, (f) => f.normal?.[0] === 1) },
  ]);
  assert.equal(self.errors.al, 'Pick the target face on another body');
});

// ---- Offset Face / Delete Face --------------------------------------------------------------

function plateWithHole(radius = 3): Feature[] {
  return [
    ...box('p', 0, 0, 20, 20, 10),
    sketch('h-s', 'XY', 10, { kind: 'circle', cx: 10, cy: 10, radius }),
    extrude('h', 'h-s', -10, { operation: 'cut', targetBodyId: 'body:p' }),
  ];
}

void test('offset face: enlarge and shrink a hole, push a planar face; errors', async () => {
  const doc = plateWithHole();
  const plate = only(await evaluate(doc));
  const hole = faceRef(plate, (f) => f.surface === 'cylinder');
  const offset: OffsetFaceFeature = {
    ...base('o1'),
    kind: 'offsetFace',
    faces: [hole],
    distance: -1,
  };
  const larger = only(await evaluate([...doc, offset]));
  near(larger.volume, 4000 - Math.PI * 16 * 10, 1e-3, 'hole r=4');
  assert.equal(larger.valid, true);
  const wall = larger.faces.find((f) => f.key === hole.key);
  assert.ok(wall, 'the hole wall keeps its key');
  near(wall.area, 2 * Math.PI * 4 * 10, 1e-3, 'wall area at r=4');

  const smaller = only(await evaluate([...doc, { ...offset, distance: 1 }]));
  near(smaller.volume, 4000 - Math.PI * 4 * 10, 1e-3, 'hole r=2');

  const top = faceRef(plate, topOf(10));
  const pushed = only(await evaluate([...doc, { ...offset, faces: [top], distance: 2 }]));
  near(pushed.volume, (400 - Math.PI * 9) * 12, 1e-3, 'top pushed by 2');
  near(pushed.max[2], 12, 1e-6, 'top at z=12');

  const closes = await evaluate([...doc, { ...offset, distance: 3 }]);
  assert.equal(closes.errors.o1, 'Offset of 3 mm closes the hole (radius 3 mm)');
  const mixed = await evaluate([
    ...doc,
    { ...offset, faces: [hole, { ...hole, bodyId: 'body:x' }] },
  ]);
  assert.equal(mixed.errors.o1, 'All faces must belong to one body');

  // Stable reference: moving the hole (earlier sketch edit) keeps the offset on the hole wall.
  const moved = doc.map((f) =>
    f.id === 'h-s' ? sketch('h-s', 'XY', 10, { kind: 'circle', cx: 6, cy: 7, radius: 3 }) : f,
  );
  const edited = await evaluate([...moved, offset]);
  assert.deepEqual(edited.errors, {});
  assert.deepEqual(edited.warnings, {});
  const editedWall = only(edited).faces.find((f) => f.key === hole.key)!;
  near(editedWall.centroid[0], 6, 1e-6, 'wall followed the hole');
  near(editedWall.area, 2 * Math.PI * 4 * 10, 1e-3, 'still r=4');
});

void test('delete face: fill a hole, remove a fillet and a chamfer; unsupported faces fail clearly', async () => {
  const doc = plateWithHole();
  const plate = only(await evaluate(doc));
  const del: DeleteFaceFeature = {
    ...base('d1'),
    kind: 'deleteFace',
    faces: [faceRef(plate, (f) => f.surface === 'cylinder')],
  };
  const filled = only(await evaluate([...doc, del]));
  near(filled.volume, 4000, 1e-3, 'hole filled');
  assert.equal(filled.valid, true);
  assert.equal(filled.faces.length, 6, 'a plain box again');

  const blockDoc = box('k', 0, 0, 20, 10, 10);
  const block = only(await evaluate(blockDoc));
  const topFront = block.edges.find(
    (e) =>
      e.curve === 'line' && Math.abs(e.midpoint[2] - 10) < 1e-9 && Math.abs(e.midpoint[1]) < 1e-9,
  )!;
  const edgeRef = { bodyId: block.id, key: topFront.key, signature: edgeSignatureOf(topFront) };
  for (const kind of ['fillet', 'chamfer'] as const) {
    const blend: Feature =
      kind === 'fillet'
        ? { ...base('bl'), kind, radius: 3, edges: [edgeRef] }
        : { ...base('bl'), kind, distance: 3, edges: [edgeRef] };
    const blended = only(await evaluate([...blockDoc, blend]));
    const blendFace = blended.faces.find(
      (f) => f.key === `bl:${kind === 'fillet' ? 'round' : 'chamfer'}:0`,
    )!;
    const healed = only(
      await evaluate([
        ...blockDoc,
        blend,
        {
          ...del,
          faces: [{ bodyId: block.id, key: blendFace.key, signature: faceSignatureOf(blendFace) }],
        },
      ]),
    );
    near(healed.volume, 2000, 1e-3, `${kind} removed`);
    assert.equal(healed.valid, true);
    assert.equal(healed.faces.length, 6, `${kind}: sharp box again`);
  }

  const topDel = await evaluate([...doc, { ...del, faces: [faceRef(plate, topOf(10))] }]);
  assert.match(topDel.errors.d1 ?? '', /^Delete Face can remove holes/);
  assert.match(topDel.errors.d1 ?? '', /BRepAlgoAPI_Defeaturing/);
});

// ---- Schema v1 files with modelling features -------------------------------------------------

void test('a schema-1 file with revolve/sweep/loft/pattern migrates (profiles, axes, paths, face keys) and evaluates', async () => {
  const plane = (p: Plane, offset = 0) => ({ kind: 'plane', plane: p, offset });
  const rect = (x: number, y: number, width: number, height: number) => ({
    kind: 'rectangle',
    x,
    y,
    width,
    height,
  });
  const v1Features = [
    { ...base('s1'), kind: 'sketch', plane: plane('XZ'), profiles: [rect(10, 0, 10, 5)] },
    {
      ...base('r1'),
      kind: 'revolve',
      profile: { kind: 'sketch', featureId: 's1', profileIndex: 0 },
      axis: { kind: 'world', axis: 'Z' },
      angle: 360,
      operation: 'new',
    },
    {
      ...base('f1'),
      kind: 'fillet',
      radius: 1,
      edges: [
        {
          bodyId: 'body:r1',
          // v1 naming: outer wall (segment 1) | top annulus (segment 2).
          key: 'r1:side:0:1|r1:side:0:2',
          signature: {
            curve: 'circle',
            midpoint: [-20, 0, 5],
            length: 40 * Math.PI,
            direction: null,
          },
        },
      ],
    },
    { ...base('s2'), kind: 'sketch', plane: plane('XZ'), profiles: [rect(30, 0, 4, 4)] },
    {
      ...base('r2'),
      kind: 'revolve',
      profile: { kind: 'sketch', featureId: 's2' },
      axis: { kind: 'sketchEdge', featureId: 's1', profileIndex: 0, segment: 3 },
      angle: 90,
      operation: 'new',
    },
    {
      ...base('p'),
      kind: 'sketch',
      plane: plane('XY', 40),
      profiles: [{ kind: 'circle', cx: 0, cy: 0, radius: 20 }],
    },
    {
      ...base('ring'),
      kind: 'sketch',
      plane: plane('XZ'),
      profiles: [{ kind: 'circle', cx: 20, cy: 40, radius: 2 }],
    },
    {
      ...base('w1'),
      kind: 'sweep',
      profile: { kind: 'sketch', featureId: 'ring' },
      path: { kind: 'sketch', featureId: 'p', profileIndex: 0 },
      operation: 'new',
    },
    { ...base('la'), kind: 'sketch', plane: plane('XY', 60), profiles: [rect(-5, -5, 10, 10)] },
    { ...base('lb'), kind: 'sketch', plane: plane('XY', 70), profiles: [rect(-3, -3, 6, 6)] },
    {
      ...base('l1'),
      kind: 'loft',
      profiles: [
        { kind: 'sketch', featureId: 'la', profileIndex: 0 },
        { kind: 'sketch', featureId: 'lb', profileIndex: 0 },
      ],
      ruled: true,
      operation: 'new',
    },
    {
      ...base('pt'),
      kind: 'pattern',
      bodyIds: ['body:l1'],
      pattern: {
        kind: 'linear',
        direction: { kind: 'sketchEdge', featureId: 'la', profileIndex: 0, segment: 0 },
        count: 2,
        spacing: 30,
      },
    },
  ];
  const project = loadProjectFile(
    JSON.stringify({
      format: PROJECT_FORMAT_ID,
      schemaVersion: 1,
      appVersion: '0.1.0-features',
      units: 'mm',
      projectName: 'v1 modelling features',
      features: v1Features,
      createdAt: '2026-09-29T00:00:00.000Z',
      modifiedAt: '2026-09-29T00:00:00.000Z',
    }),
  );
  assert.equal(project.schemaVersion, 2);
  const byId = new Map(project.features.map((f) => [f.id, f]));
  const r1 = byId.get('r1') as RevolveFeature;
  assert.deepEqual(r1.profile, { kind: 'sketch', featureId: 's1', regions: ['l1+l2+l3+l4'] });
  assert.deepEqual((byId.get('r2') as RevolveFeature).axis, {
    kind: 'sketchLine',
    featureId: 's1',
    entityId: 'l4',
  });
  assert.deepEqual((byId.get('r2') as RevolveFeature).profile, { kind: 'sketch', featureId: 's2' });
  assert.deepEqual((byId.get('w1') as SweepFeature).path, {
    kind: 'sketch',
    featureId: 'p',
    region: 'c1',
  });
  assert.deepEqual(
    (byId.get('l1') as LoftFeature).profiles.map((p) => p.kind === 'sketch' && p.regions),
    [['l1+l2+l3+l4'], ['l1+l2+l3+l4']],
  );
  const pattern = (byId.get('pt') as PatternFeature).pattern;
  assert.deepEqual(pattern.kind === 'linear' && pattern.direction, {
    kind: 'sketchLine',
    featureId: 'la',
    entityId: 'l1',
  });
  assert.equal((byId.get('f1') as FilletFeature).edges[0]!.key, 'r1:side:0:l2|r1:side:0:l3');

  const result = await evaluate(project.features);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.warnings, {}, 'the fillet resolves by its renamed key');
  assert.ok(result.bodies.every((b) => b.valid));
  // r1 ring + r2 quarter ring + swept torus + loft frustum + its pattern copy.
  assert.equal(result.bodies.length, 5);
});

// ---- Timing ------------------------------------------------------------------------

void test('a part combining several new features evaluates and re-evaluates in measured time', async (t) => {
  const { evaluator } = await loadNodeKernel();
  const part = (height: number): Feature[] => [
    sketch('s', 'XY', 0, { kind: 'circle', cx: 0, cy: 0, radius: 12 }),
    extrude('shaft', 's', height),
    sketch('g', 'XZ', 0, { kind: 'rectangle', x: 10, y: 10, width: 4, height: 3 }),
    revolve('groove', { kind: 'sketch', featureId: 'g' }, { kind: 'world', axis: 'Z' }, 360, {
      operation: 'cut',
      targetBodyId: 'body:shaft',
    }),
    ...box('lug', 12, -4, 10, 8, 6),
    {
      ...base('pat'),
      kind: 'pattern',
      bodyIds: ['body:lug'],
      pattern: { kind: 'circular', axis: { kind: 'world', axis: 'Z' }, count: 4, angle: 360 },
    },
    {
      ...base('mir'),
      kind: 'mirror',
      bodyIds: ['body:shaft'],
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      keepOriginal: true,
    },
    {
      ...base('cut'),
      kind: 'split',
      bodyId: 'body:shaft',
      plane: { kind: 'plane', plane: 'XY', offset: height / 2 },
    },
  ];
  const t0 = performance.now();
  const first = await evaluator.evaluate(part(40));
  const t1 = performance.now();
  const again = await evaluator.evaluate(part(50));
  const t2 = performance.now();
  assert.deepEqual(first.errors, {});
  assert.deepEqual(again.errors, {});
  assert.equal(again.bodies.length, 1 + 4 + 1 + 1);
  assert.ok(again.bodies.every((b) => b.valid));
  t.diagnostic(
    `multi-feature part: first ${(t1 - t0).toFixed(0)} ms (model ${first.stats.modelMs.toFixed(0)}, tessellation ${first.stats.tessellateMs.toFixed(0)}), ` +
      `after height edit ${(t2 - t1).toFixed(0)} ms (model ${again.stats.modelMs.toFixed(0)}, tessellation ${again.stats.tessellateMs.toFixed(0)}), ` +
      `${again.stats.triangles} triangles, ${again.bodies.length} bodies`,
  );
});
