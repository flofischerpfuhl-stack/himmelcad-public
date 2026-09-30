/**
 * Print-part modelling tools on the real OCCT kernel: Hole, Emboss (planar
 * and wrapped), Draft, Rib, Thicken, the Fillet/Chamfer variants (variable
 * radius, two distances, distance-angle, edges by rule), Shell variants
 * (outward, per-face walls) and Boolean keep-tools — volumes and boxes
 * against hand calculations, B-rep validity, references after an earlier
 * edit, and the readable error paths.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  Body,
  EvaluationResult,
} from '../../renderer/src/foundation/geometry-kernel/types.js';
import {
  edgeSignatureOf,
  faceSignatureOf,
} from '../../renderer/src/foundation/geometry-kernel/naming.js';
import type {
  BooleanFeature,
  ChamferFeature,
  ExtrudeFeature,
  FaceRef,
  Feature,
  FilletFeature,
  Plane,
  ShellFeature,
  SketchPlaneRef,
} from '../../renderer/src/foundation/document/document.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import type {
  DraftFeature,
  EmbossFeature,
  HoleFeature,
  RibFeature,
  ThickenFeature,
} from '../../renderer/src/model/printFeatures.js';
import {
  addPolyline,
  sketchFromLegacyProfiles,
} from '../../renderer/src/foundation/sketch-solver/builders.js';
import { EMPTY_SKETCH } from '../../renderer/src/foundation/sketch-solver/types.js';
import type { LegacySketchProfile } from '../sketch/fixtures.js';
import { loadNodeKernel } from './nodeKernel.js';

const base = (id: string) => ({ id, name: id, suppressed: false });

function sketchOn(
  id: string,
  plane: SketchPlaneRef | Plane,
  offset: number,
  ...profiles: LegacySketchProfile[]
): SketchFeature {
  const { sketch: data } = sketchFromLegacyProfiles(profiles);
  return {
    ...base(id),
    kind: 'sketch',
    plane: typeof plane === 'string' ? { kind: 'plane', plane, offset } : plane,
    ...data,
  };
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

/** Box `x0..x0+w, y0..y0+d, z0..z0+h` (body `body:<id>`). */
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
    sketchOn(`${id}-s`, 'XY', z0, { kind: 'rectangle', x: x0, y: y0, width: w, height: d }),
    extrude(id, `${id}-s`, h),
  ];
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

function noErrors(result: EvaluationResult): void {
  assert.deepEqual(result.errors, {}, 'no feature errors');
}

function faceRef(body: Body, predicate: (f: Body['faces'][number]) => boolean): FaceRef {
  const face = body.faces.find(predicate);
  assert.ok(face, `face found on ${body.id}`);
  return { bodyId: body.id, key: face.key, signature: faceSignatureOf(face) };
}

const planeFace = (normal: [number, number, number], coord: number) => (f: Body['faces'][number]) =>
  f.surface === 'plane' &&
  f.normal !== null &&
  normal.every((c, i) => Math.abs(f.normal![i]! - c) < 1e-9) &&
  Math.abs(f.centroid[normal.findIndex((c) => c !== 0)]! - coord) < 1e-6;

function edgeWhere(body: Body, predicate: (e: Body['edges'][number]) => boolean) {
  const edge = body.edges.find(predicate);
  assert.ok(edge, `edge found on ${body.id}`);
  return { bodyId: body.id, key: edge.key, signature: edgeSignatureOf(edge) };
}

function hole(id: string, face: FaceRef, extra: Partial<HoleFeature>): HoleFeature {
  return {
    ...base(id),
    kind: 'hole',
    face,
    placements: [{ kind: 'point', u: 10, v: 10 }],
    holeType: 'simple',
    diameter: 5,
    extent: { kind: 'through' },
    ...extra,
  };
}

// ---- Hole ------------------------------------------------------------------------------

void test('hole: simple through, blind, counterbore and countersink against hand calculations', async () => {
  const plate = box('p', 0, 0, 40, 30, 10);
  const first = only(await evaluate(plate), 'body:p');
  const top = faceRef(first, planeFace([0, 0, 1], 10));
  const V = 40 * 30 * 10;

  const simple = await evaluate([
    ...plate,
    hole('h', top, {
      placements: [
        { kind: 'point', u: 10, v: 10 },
        { kind: 'point', u: 30, v: 20 },
      ],
    }),
  ]);
  noErrors(simple);
  const s = only(simple, 'body:p');
  near(s.volume, V - 2 * Math.PI * 2.5 ** 2 * 10, 1e-3, 'two through holes');
  assert.equal(s.valid, true);
  assert.ok(
    s.faces.some((f) => f.key === 'h:wall:0'),
    'hole 0 wall keyed',
  );
  assert.ok(
    s.faces.some((f) => f.key === 'h:wall:1'),
    'hole 1 wall keyed',
  );
  const wall0 = s.faces.find((f) => f.key === 'h:wall:0')!;
  near(wall0.centroid[0], 10, 1e-6, 'hole 0 x');
  near(wall0.area, 2 * Math.PI * 2.5 * 10, 1e-3, 'hole 0 wall area');

  const blind = only(
    await evaluate([...plate, hole('h', top, { extent: { kind: 'blind', depth: 6 } })]),
    'body:p',
  );
  near(blind.volume, V - Math.PI * 2.5 ** 2 * 6, 1e-3, 'blind hole');
  assert.ok(
    blind.faces.some((f) => f.key === 'h:floor:0'),
    'blind floor keyed',
  );

  const cb = only(
    await evaluate([
      ...plate,
      hole('h', top, {
        holeType: 'counterbore',
        diameter: 3.4,
        counterboreDiameter: 6.5,
        counterboreDepth: 3.4,
      }),
    ]),
    'body:p',
  );
  near(
    cb.volume,
    V - Math.PI * 1.7 ** 2 * 10 - Math.PI * (3.25 ** 2 - 1.7 ** 2) * 3.4,
    1e-3,
    'counterbore',
  );
  assert.equal(cb.valid, true);
  assert.ok(
    cb.faces.some((f) => f.key === 'h:cbore:0') && cb.faces.some((f) => f.key === 'h:cbfloor:0'),
  );

  const cs = only(
    await evaluate([
      ...plate,
      hole('h', top, {
        holeType: 'countersink',
        diameter: 3.4,
        countersinkDiameter: 6.3,
        countersinkAngle: 90,
      }),
    ]),
    'body:p',
  );
  const sink = 3.15 - 1.7; // 90°: depth = radius difference
  const frustum = (Math.PI * sink * (3.15 ** 2 + 3.15 * 1.7 + 1.7 ** 2)) / 3;
  near(cs.volume, V - Math.PI * 1.7 ** 2 * (10 - sink) - frustum, 1e-3, 'countersink');
  assert.equal(cs.valid, true);
  assert.ok(cs.faces.some((f) => f.key === 'h:csink:0'));
});

void test('hole: placed at sketch points, follows an earlier thickness edit, fillet on its edge survives', async () => {
  const plate = box('p', 0, 0, 40, 30, 10);
  const first = only(await evaluate(plate), 'body:p');
  const top = faceRef(first, planeFace([0, 0, 1], 10));
  const marks = sketchOn(
    'm',
    { kind: 'face', face: top },
    0,
    { kind: 'circle', cx: 12, cy: 8, radius: 1 },
    { kind: 'circle', cx: 28, cy: 22, radius: 1 },
  );
  const centres = marks.entities.filter((e) => e.kind === 'circle').map((e) => e.id);
  const h: HoleFeature = hole('h', top, {
    placements: centres.map((entityId) => ({ kind: 'sketchPoint', featureId: 'm', entityId })),
    diameter: 4,
  });
  const doc = [...plate, marks, h];
  const r1 = await evaluate(doc);
  noErrors(r1);
  const b1 = only(r1, 'body:p');
  const walls = b1.faces.filter((f) => f.key.startsWith('h:wall:')).map((f) => f.centroid);
  assert.equal(walls.length, 2);
  assert.ok(walls.some((c) => Math.abs(c[0] - 12) < 1e-6 && Math.abs(c[1] - 8) < 1e-6));
  assert.ok(walls.some((c) => Math.abs(c[0] - 28) < 1e-6 && Math.abs(c[1] - 22) < 1e-6));

  // Fillet the top edge of hole 0, then make the plate thicker: everything re-resolves by key.
  const rim = edgeWhere(b1, (e) => e.curve === 'circle' && Math.abs(e.midpoint[2] - 10) < 1e-6);
  const fillet: FilletFeature = { ...base('f'), kind: 'fillet', edges: [rim], radius: 0.5 };
  const thick = [
    sketchOn('p-s', 'XY', 0, { kind: 'rectangle', x: 0, y: 0, width: 40, height: 30 }),
    extrude('p', 'p-s', 14),
    marks,
    h,
    fillet,
  ];
  const r2 = await evaluate(thick);
  noErrors(r2);
  assert.deepEqual(r2.warnings, {}, 'resolved by key, no geometric re-bind');
  const b2 = only(r2, 'body:p');
  assert.equal(b2.valid, true);
  const removed = 2 * Math.PI * 2 ** 2 * 14;
  // A 0.5 fillet on the hole rim removes the spandrel (1 - pi/4) r^2 swept around the rim
  // (Pappus: its centroid lies r (10 - 3 pi) / (12 - 3 pi) outside the 2 mm hole radius).
  const rimRemoved =
    (1 - Math.PI / 4) * 0.25 * 2 * Math.PI * (2 + (0.5 * (10 - 3 * Math.PI)) / (12 - 3 * Math.PI));
  near(
    b2.volume,
    40 * 30 * 14 - removed - rimRemoved,
    0.05,
    'thicker plate with holes and rim fillet',
  );
});

void test('hole: readable errors for bad sizes and misplaced holes', async () => {
  const plate = box('p', 0, 0, 40, 30, 10);
  const first = only(await evaluate(plate), 'body:p');
  const top = faceRef(first, planeFace([0, 0, 1], 10));
  const side = faceRef(first, planeFace([0, -1, 0], 0));
  const cases: [Partial<HoleFeature>, RegExp][] = [
    [{ diameter: 0 }, /Hole diameter must be at least/],
    [
      { holeType: 'counterbore', counterboreDiameter: 3, counterboreDepth: 2 },
      /Counterbore diameter .* must be larger/,
    ],
    [
      {
        extent: { kind: 'blind', depth: 5 },
        holeType: 'counterbore',
        counterboreDiameter: 8,
        counterboreDepth: 6,
      },
      /must be less than the hole depth/,
    ],
    [{ placements: [{ kind: 'point', u: 100, v: 100 }] }, /outside the face/],
    [{ placements: [] }, /Place at least one hole/],
  ];
  for (const [extra, message] of cases) {
    const result = await evaluate([...plate, hole('h', top, extra)]);
    assert.match(result.errors.h ?? '', message);
    near(only(result, 'body:p').volume, 12000, 1e-6, 'body unchanged');
  }
  // A side face works too (planar face, frame of the XZ plane: u = x, v = z).
  const sideHole = await evaluate([
    ...plate,
    hole('h', side, { placements: [{ kind: 'point', u: 20, v: 5 }], diameter: 4 }),
  ]);
  noErrors(sideHole);
  near(only(sideHole, 'body:p').volume, 12000 - Math.PI * 4 * 30, 1e-3, 'hole through the side');
});

// ---- Emboss ------------------------------------------------------------------------------

void test('emboss: raised and engraved profiles on a planar face', async () => {
  const plate = box('p', 0, 0, 40, 30, 5);
  const first = only(await evaluate(plate), 'body:p');
  const top = faceRef(first, planeFace([0, 0, 1], 5));
  const label = sketchOn('t', { kind: 'face', face: top }, 0, {
    kind: 'rectangle',
    x: 5,
    y: 5,
    width: 10,
    height: 4,
  });
  const emboss = (depth: number): EmbossFeature => ({
    ...base('e'),
    kind: 'emboss',
    profile: { kind: 'sketch', featureId: 't' },
    face: top,
    depth,
  });
  const up = only(await evaluate([...plate, label, emboss(1.5)]), 'body:p');
  near(up.volume, 6000 + 40 * 1.5, 1e-3, 'embossed');
  near(up.max[2], 6.5, 1e-6, 'raised to 6.5');
  assert.equal(up.valid, true);
  assert.ok(up.faces.some((f) => f.key === 'e:top:0'));
  const down = only(await evaluate([...plate, label, emboss(-1)]), 'body:p');
  near(down.volume, 6000 - 40, 1e-3, 'engraved');
  assert.ok(down.faces.some((f) => f.key === 'e:floor:0'));

  // A sketch on a parallel plane is projected; a perpendicular one is refused.
  const high = sketchOn('t', 'XY', 20, { kind: 'rectangle', x: 5, y: 5, width: 10, height: 4 });
  near(only(await evaluate([...plate, high, emboss(1)]), 'body:p').volume, 6040, 1e-3, 'projected');
  const across = sketchOn('t', 'XZ', 0, { kind: 'rectangle', x: 5, y: 1, width: 10, height: 2 });
  const refused = await evaluate([...plate, across, emboss(1)]);
  assert.match(refused.errors.e ?? '', /parallel to the face/);
});

void test('emboss: wraps a profile around a cylinder keeping surface lengths', async () => {
  const rod = [
    sketchOn('c-s', 'XY', 0, { kind: 'circle', cx: 0, cy: 0, radius: 10 }),
    extrude('c', 'c-s', 30),
  ];
  const first = only(await evaluate(rod), 'body:c');
  const mantle = faceRef(first, (f) => f.surface === 'cylinder');
  // XZ plane (normal +Y) contains the axis: u = x, v = z; wrap centre at +Y.
  const label = sketchOn('t', 'XZ', 0, { kind: 'rectangle', x: -2, y: 10, width: 4, height: 5 });
  const emboss = (depth: number): EmbossFeature => ({
    ...base('e'),
    kind: 'emboss',
    profile: { kind: 'sketch', featureId: 't' },
    face: mantle,
    depth,
  });
  const base0 = Math.PI * 100 * 30;
  const up = await evaluate([...rod, label, emboss(1)]);
  noErrors(up);
  const b = only(up, 'body:c');
  // 4 mm of arc at R = 10 is 0.4 rad; the raised band spans radii 10..11 over 5 mm.
  near(b.volume, base0 + (0.4 / 2) * (11 ** 2 - 10 ** 2) * 5, 1e-3, 'wrapped emboss volume');
  assert.equal(b.valid, true);
  near(b.max[1], 11, 1e-6, 'raised on the +Y side');
  near(b.max[2], 30, 1e-6, 'height unchanged');
  const topFace = b.faces.find((f) => f.key === 'e:top:0');
  assert.ok(topFace, 'raised face keyed');
  near(topFace.area, 0.4 * 11 * 5, 1e-3, 'raised face area (arc at R 11)');
  // Centred on +Y at mid-height of the label (z 10..15), not somewhere else on the rod.
  near(topFace.centroid[0], 0, 1e-6, 'centred about the sketch centre line');
  near(topFace.centroid[2], 12.5, 1e-6, 'label height kept');

  // An off-centre label keeps its position: x -9..-5 at R 10 is -0.9..-0.5 rad from +Y, z 16..24.
  const rod2 = [
    sketchOn('c-s', 'XY', 0, { kind: 'circle', cx: 0, cy: 0, radius: 10 }),
    extrude('c', 'c-s', 40),
  ];
  const mantle2 = faceRef(only(await evaluate(rod2), 'body:c'), (f) => f.surface === 'cylinder');
  const offCentre = sketchOn('t', 'XZ', 0, {
    kind: 'rectangle',
    x: -9,
    y: 16,
    width: 4,
    height: 8,
  });
  const moved = only(
    await evaluate([...rod2, offCentre, { ...emboss(1), face: mantle2 }]),
    'body:c',
  );
  const raised = moved.faces.find((f) => f.key === 'e:top:0')!;
  near(raised.centroid[2], 20, 1e-6, 'z 16..24');
  const angle = Math.atan2(raised.centroid[0], raised.centroid[1]);
  near(angle, -0.7, 1e-3, 'wrapped to -0.7 rad from +Y (towards -X)');
  near(raised.area, 0.4 * 11 * 8, 1e-3, 'surface lengths kept');

  const down = only(await evaluate([...rod, label, emboss(-0.8)]), 'body:c');
  near(down.volume, base0 - (0.4 / 2) * (10 ** 2 - 9.2 ** 2) * 5, 1e-3, 'wrapped engrave volume');

  // Too wide to wrap from the centre.
  const wide = sketchOn('t', 'XZ', 0, { kind: 'rectangle', x: -40, y: 10, width: 80, height: 5 });
  assert.match(
    (await evaluate([...rod, wide, emboss(1)])).errors.e ?? '',
    /does not fit around|more than halfway/,
  );
});

// ---- Draft ------------------------------------------------------------------------------------

void test('draft: side faces tilt about the neutral bottom face', async () => {
  const block = box('b', 0, 0, 20, 10, 10);
  const first = only(await evaluate(block), 'body:b');
  const left = faceRef(first, planeFace([-1, 0, 0], 0));
  const right = faceRef(first, planeFace([1, 0, 0], 20));
  const bottom = faceRef(first, planeFace([0, 0, -1], 0));
  const draft = (angle: number, extra: Partial<DraftFeature> = {}): DraftFeature => ({
    ...base('d'),
    kind: 'draft',
    faces: [left, right],
    neutral: { kind: 'face', face: bottom },
    angle,
    flip: false,
    ...extra,
  });
  const t = Math.tan((5 * Math.PI) / 180);
  const r = await evaluate([...block, draft(5)]);
  noErrors(r);
  const b = only(r, 'body:b');
  near(b.volume, 2000 - 2 * 0.5 * 10 * (10 * t) * 10, 1e-3, 'two 5° drafts');
  assert.equal(b.valid, true);
  near(b.min[0], 0, 1e-6, 'bottom keeps its width');
  // Faces keep their keys (Modified history).
  assert.ok(
    b.faces.some((f) => f.key === left.key && f.normal && f.normal[2] > 0.05),
    'left face tilted, same key',
  );
  const added = only(await evaluate([...block, draft(-5)]), 'body:b');
  near(added.volume, 2000 + 2 * 0.5 * 10 * (10 * t) * 10, 1e-3, 'negative draft adds');
  const flipped = only(await evaluate([...block, draft(5, { flip: true })]), 'body:b');
  near(flipped.volume, 2000 + 2 * 0.5 * 10 * (10 * t) * 10, 1e-3, 'flipped pull direction');

  const top = faceRef(first, planeFace([0, 0, 1], 10));
  const bad = await evaluate([...block, draft(5, { faces: [top] })]);
  assert.match(bad.errors.d ?? '', /parallel to the neutral plane/);
  assert.deepEqual(bad.errorRefs?.d?.faceKeys, [top.key], 'the offending face is pointed at');
  assert.match(
    (await evaluate([...block, draft(60)])).errors.d ?? '',
    /Draft angle must be between/,
  );
});

// ---- Rib --------------------------------------------------------------------------------------

void test('rib: a gusset fills from the sketch line to the L-bracket', async () => {
  // Plate 40 x 30 x 5 and an upright at y 25..30 up to z 35.
  const bracket = [
    ...box('p', 0, 0, 40, 30, 5),
    sketchOn('u-s', 'XY', 5, { kind: 'rectangle', x: 0, y: 25, width: 40, height: 5 }),
    extrude('u', 'u-s', 30, { operation: 'join', targetBodyId: 'body:p' }),
  ];
  const plain = only(await evaluate(bracket), 'body:p');
  // YZ plane at x = 20: u = y, v = z. Line from the upright (y 25, z 25) to the plate (y 5, z 5).
  const { sketch: data, lineIds } = addPolyline(EMPTY_SKETCH, [
    [25, 25],
    [5, 5],
  ]);
  const ribSketch: SketchFeature = {
    ...base('r-s'),
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'YZ', offset: 20 },
    ...data,
  };
  const rib: RibFeature = {
    ...base('r'),
    kind: 'rib',
    sketchId: 'r-s',
    entityIds: lineIds,
    thickness: 3,
    flip: false,
    targetBodyId: 'body:p',
  };
  const r = await evaluate([...bracket, ribSketch, rib]);
  noErrors(r);
  const b = only(r, 'body:p');
  near(b.volume, plain.volume + 0.5 * 20 * 20 * 3, 1e-3, 'triangular gusset 20 x 20 x 3');
  assert.equal(b.valid, true);
  near(b.min[0], 0, 1e-9, 'box unchanged');

  // Flipped: the other side of the line fills up to the body and the bracket's bounding box:
  // y 0..5 over z 5..35, plus y 5..25 between the line (z = y) and z 35 = 550 mm^2.
  const flipped = only(await evaluate([...bracket, ribSketch, { ...rib, flip: true }]), 'body:p');
  near(flipped.volume, plain.volume + 550 * 3, 1e-3, 'flipped fill');

  // A line away from the body never reaches it.
  const far = addPolyline(EMPTY_SKETCH, [
    [-60, 60],
    [-50, 70],
  ]);
  const farSketch: SketchFeature = { ...ribSketch, ...far.sketch };
  const missing = await evaluate([...bracket, farSketch, { ...rib, entityIds: far.lineIds }]);
  assert.match(missing.errors.r ?? '', /does not reach the body|does not face the body/);
});

// ---- Thicken ------------------------------------------------------------------------------------

void test('thicken: a planar face, a cylindrical face and a sketch profile', async () => {
  const block = box('b', 0, 0, 40, 30, 10);
  const first = only(await evaluate(block), 'body:b');
  const top = faceRef(first, planeFace([0, 0, 1], 10));
  const thicken = (extra: Partial<ThickenFeature>): ThickenFeature => ({
    ...base('t'),
    kind: 'thicken',
    source: { kind: 'faces', faces: [top] },
    thickness: 2,
    direction: 'outside',
    operation: 'new',
    ...extra,
  });
  const out = await evaluate([...block, thicken({})]);
  noErrors(out);
  const plate = only(out, 'body:t');
  near(plate.volume, 40 * 30 * 2, 1e-3, 'outside');
  near(plate.min[2], 10, 1e-6, 'starts at the face');
  near(plate.max[2], 12, 1e-6, 'grows outwards');
  const both = only(await evaluate([...block, thicken({ direction: 'both' })]), 'body:t');
  near(both.min[2], 9, 1e-6, 'half inside');
  near(both.max[2], 11, 1e-6, 'half outside');
  const joined = only(
    await evaluate([...block, thicken({ operation: 'join', targetBodyId: 'body:b' })]),
    'body:b',
  );
  near(joined.volume, 40 * 30 * 12, 1e-3, 'joined');

  const rod = [
    sketchOn('c-s', 'XY', 0, { kind: 'circle', cx: 0, cy: 0, radius: 10 }),
    extrude('c', 'c-s', 20),
  ];
  const rodBody = only(await evaluate(rod), 'body:c');
  const mantle = faceRef(rodBody, (f) => f.surface === 'cylinder');
  const sleeve = only(
    await evaluate([
      ...rod,
      thicken({ source: { kind: 'faces', faces: [mantle] }, thickness: 1.5 }),
    ]),
    'body:t',
  );
  near(sleeve.volume, Math.PI * (11.5 ** 2 - 100) * 20, 1e-3, 'sleeve around the rod');
  assert.equal(sleeve.valid, true);
  const liner = only(
    await evaluate([
      ...rod,
      thicken({ source: { kind: 'faces', faces: [mantle] }, thickness: 1.5, direction: 'inside' }),
    ]),
    'body:t',
  );
  near(liner.volume, Math.PI * (100 - 8.5 ** 2) * 20, 1e-3, 'liner inside the rod surface');

  const s = sketchOn('s', 'XY', 50, { kind: 'rectangle', x: 0, y: 0, width: 10, height: 10 });
  const fromProfile = only(
    await evaluate([
      ...block,
      s,
      thicken({ source: { kind: 'profile', profile: { kind: 'sketch', featureId: 's' } } }),
    ]),
    'body:t',
  );
  near(fromProfile.volume, 200, 1e-3, 'sketch profile thickened');
});

// ---- Fillet / chamfer variants -------------------------------------------------------------------

void test('fillet/chamfer variants: variable radius, two distances, distance-angle', async () => {
  const block = box('b', 0, 0, 20, 10, 10);
  const first = only(await evaluate(block), 'body:b');
  // Top front edge (along X, length 20).
  const edge = edgeWhere(
    first,
    (e) =>
      e.curve === 'line' && Math.abs(e.midpoint[2] - 10) < 1e-6 && Math.abs(e.midpoint[1]) < 1e-6,
  );
  const variable: FilletFeature = {
    ...base('f'),
    kind: 'fillet',
    edges: [edge],
    radius: 1,
    radius2: 3,
  };
  const vr = only(await evaluate([...block, variable]), 'body:b');
  // Linear radius law: removed (1 - pi/4) * integral r^2 = (1 - pi/4) L (r1^2 + r1 r2 + r2^2) / 3 (approximately).
  near(vr.volume, 2000 - ((1 - Math.PI / 4) * 20 * (1 + 3 + 9)) / 3, 1.2, 'variable fillet');
  assert.equal(vr.valid, true);
  // An end radius that does not fit: OCCT returns a broken solid, reported as an error.
  const broken = await evaluate([...block, { ...variable, radius: 15, radius2: 3 }]);
  assert.match(broken.errors.f ?? '', /an end radius does not fit/);
  assert.deepEqual(broken.errorRefs?.f?.edgeKeys, [edge.key]);

  const chamfer = (extra: Partial<ChamferFeature>): ChamferFeature => ({
    ...base('c'),
    kind: 'chamfer',
    edges: [edge],
    distance: 1,
    ...extra,
  });
  near(
    only(await evaluate([...block, chamfer({ mode: 'twoDistances', distance2: 2 })]), 'body:b')
      .volume,
    2000 - 0.5 * 1 * 2 * 20,
    1e-6,
    'two distances',
  );
  const flipped = only(
    await evaluate([...block, chamfer({ mode: 'twoDistances', distance2: 2, flip: true })]),
    'body:b',
  );
  near(flipped.volume, 1980, 1e-6, 'flipped two distances (same volume)');
  near(
    only(await evaluate([...block, chamfer({ mode: 'distanceAngle', angle: 30 })]), 'body:b')
      .volume,
    2000 - 0.5 * 1 * Math.tan(Math.PI / 6) * 20,
    1e-6,
    'distance-angle',
  );
  assert.match(
    (await evaluate([...block, chamfer({ mode: 'distanceAngle', angle: 95 })])).errors.c ?? '',
    /angle must be between/,
  );
});

void test('fillet by rule: all concave edges of an L-bracket, all edges of a face; failing edge highlighted', async () => {
  const bracket = [
    ...box('p', 0, 0, 40, 30, 5),
    sketchOn('u-s', 'XY', 5, { kind: 'rectangle', x: 0, y: 25, width: 40, height: 5 }),
    extrude('u', 'u-s', 30, { operation: 'join', targetBodyId: 'body:p' }),
  ];
  const plain = only(await evaluate(bracket), 'body:p');
  const concave: FilletFeature = {
    ...base('f'),
    kind: 'fillet',
    edges: [],
    radius: 2,
    rules: [{ kind: 'concave', bodyId: 'body:p' }],
  };
  const r = await evaluate([...bracket, concave]);
  noErrors(r);
  const b = only(r, 'body:p');
  // Exactly one concave edge: the 40 mm inner corner.
  assert.equal(b.faces.filter((f) => f.key.startsWith('f:round:')).length, 1, 'one round face');
  near(b.volume, plain.volume + (4 - Math.PI) * 40, 1e-3, 'inner fillet adds (1 - pi/4) r^2 L');

  const box1 = box('b', 0, 0, 20, 10, 10);
  const first = only(await evaluate(box1), 'body:b');
  const top = faceRef(first, planeFace([0, 0, 1], 10));
  const faceRule: FilletFeature = {
    ...base('f'),
    kind: 'fillet',
    edges: [],
    radius: 1,
    rules: [{ kind: 'faceEdges', face: top }],
  };
  const rounded = only(await evaluate([...box1, faceRule]), 'body:b');
  assert.equal(rounded.valid, true);
  assert.ok(
    rounded.faces.filter((f) => f.key.startsWith('f:round:')).length >= 4,
    'the four top edges are rounded',
  );
  const convex: FilletFeature = {
    ...base('f'),
    kind: 'fillet',
    edges: [],
    radius: 1,
    rules: [{ kind: 'convex', bodyId: 'body:b' }],
  };
  assert.equal(
    only(await evaluate([...box1, convex]), 'body:b').valid,
    true,
    'all convex edges of a box',
  );

  // A radius larger than the part: the error names the edge(s).
  const edge = edgeWhere(
    first,
    (e) =>
      e.curve === 'line' && Math.abs(e.midpoint[2] - 10) < 1e-6 && Math.abs(e.midpoint[1]) < 1e-6,
  );
  const tooBig = await evaluate([
    ...box1,
    { ...base('f'), kind: 'fillet', edges: [edge], radius: 12 } satisfies FilletFeature,
  ]);
  assert.match(tooBig.errors.f ?? '', /^Fillet failed: .*smaller radius/);
  assert.deepEqual(tooBig.errorRefs?.f?.edgeKeys, [edge.key], 'the failing edge is pointed at');
  near(only(tooBig, 'body:b').volume, 2000, 1e-9, 'body unchanged');
});

// ---- Shell variants ---------------------------------------------------------------------------

void test('shell: outward, per-face wall thickness', async () => {
  const block = box('b', 0, 0, 20, 10, 10);
  const first = only(await evaluate(block), 'body:b');
  const top = faceRef(first, planeFace([0, 0, 1], 10));
  const left = faceRef(first, planeFace([-1, 0, 0], 0));
  const shell = (extra: Partial<ShellFeature>): ShellFeature => ({
    ...base('s'),
    kind: 'shell',
    bodyId: 'body:b',
    faces: [top],
    thickness: 1,
    ...extra,
  });
  const inward = only(await evaluate([...block, shell({})]), 'body:b');
  near(inward.volume, 2000 - 18 * 8 * 9, 1e-3, 'inward');
  const outward = only(await evaluate([...block, shell({ direction: 'outside' })]), 'body:b');
  near(outward.volume, 22 * 12 * 11 - 2000, 1e-3, 'outward: the body becomes the cavity');
  near(outward.min[0], -1, 1e-6, 'grows outwards');
  assert.equal(outward.valid, true);
  const thick = await evaluate([
    ...block,
    shell({ faceThickness: [{ face: left, thickness: 3 }] }),
  ]);
  noErrors(thick);
  const t = only(thick, 'body:b');
  near(t.volume, 2000 - 16 * 8 * 9, 1e-3, 'left wall 3 mm, others 1 mm');
  assert.equal(t.valid, true);
  // A case that fits over the block with a 0.2 mm printing gap on every face:
  // cavity 20.4 x 10.4 x 10.4 (z -0.2..10.2), walls 1 mm, open at the (grown) top.
  const caseResult = await evaluate([...block, shell({ direction: 'outside', clearance: 0.2 })]);
  assert.deepEqual(caseResult.errors, {});
  const shellCase = only(caseResult, 'body:b');
  near(
    shellCase.volume,
    22.4 * 12.4 * 11.4 - 20.4 * 10.4 * 10.4,
    1e-3,
    'outward shell with clearance',
  );
  near(shellCase.min[0], -1.2, 1e-6, 'gap + wall outside the block');
  assert.equal(shellCase.valid, true);
  assert.match(
    (await evaluate([...block, shell({ clearance: 0.2 })])).errors.s ?? '',
    /clearance applies to outward shells/,
  );
  const openWall = await evaluate([
    ...block,
    shell({ faceThickness: [{ face: top, thickness: 3 }] }),
  ]);
  assert.match(openWall.errors.s ?? '', /open face has no wall/);
});

// ---- Boolean polish ---------------------------------------------------------------------------------

void test('boolean: keep tools, several tools, duplicate tool refused', async () => {
  const doc = [
    ...box('a', 0, 0, 20, 20, 10),
    ...box('t1', 5, 5, 4, 4, 20, -5),
    ...box('t2', 12, 12, 4, 4, 20, -5),
  ];
  const sub = (extra: Partial<BooleanFeature>): BooleanFeature => ({
    ...base('x'),
    kind: 'boolean',
    operation: 'subtract',
    targetBodyId: 'body:a',
    toolBodyIds: ['body:t1', 'body:t2'],
    ...extra,
  });
  const consumed = await evaluate([...doc, sub({})]);
  assert.deepEqual(
    consumed.bodies.map((b) => b.id),
    ['body:a'],
  );
  near(only(consumed, 'body:a').volume, 4000 - 2 * 16 * 10, 1e-6, 'two pockets');
  const kept = await evaluate([...doc, sub({ keepTools: true })]);
  assert.deepEqual(kept.bodies.map((b) => b.id).sort(), ['body:a', 'body:t1', 'body:t2']);
  near(only(kept, 'body:t1').volume, 16 * 20, 1e-6, 'tool kept unchanged');
  const twice = await evaluate([...doc, sub({ toolBodyIds: ['body:t1', 'body:t1'] })]);
  assert.match(twice.errors.x ?? '', /listed twice/);
});
