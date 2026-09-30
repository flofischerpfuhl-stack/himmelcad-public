/**
 * Shapr3D parity round 2 on the real OCCT kernel (`assembler/GAP-INVENTORY.md`
 * MOD-01/02, MOD-30, MOD-08, MOD-21): Extrude Intersect, Through All, To
 * Object (plane and body), two sides, start offset; construction planes and
 * axes as sketch planes, mirror planes and pattern axes; Boolean Keep
 * Target; Mirror of sketches, planar faces and about an axis. Volumes and
 * boxes against hand calculations.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { faceSignatureOf } from '../../renderer/src/kernel/naming.js';
import type { Body, EvaluationResult } from '../../renderer/src/kernel/types.js';
import type {
  ConstructionAxisFeature,
  ConstructionPlaneFeature,
} from '../../renderer/src/model/construction.js';
import type {
  BooleanFeature,
  ExtrudeFeature,
  FaceRef,
  Feature,
  Plane,
  SketchFeature,
  SketchPlaneRef,
} from '../../renderer/src/model/document.js';
import {
  mirroredSketchId,
  type MirrorFeature,
  type OffsetFaceFeature,
  type PatternFeature,
} from '../../renderer/src/model/features.js';
import { loadProjectFile, saveProjectFile } from '../../renderer/src/model/project/format.js';
import { addPolyline, sketchFromLegacyProfiles } from '../../renderer/src/sketch/builders.js';
import { EMPTY_SKETCH } from '../../renderer/src/sketch/types.js';
import type { LegacySketchProfile } from '../sketch/fixtures.js';
import { loadNodeKernel } from './nodeKernel.js';

const base = (id: string) => ({ id, name: id, suppressed: false });

function sketchOn(
  id: string,
  plane: SketchPlaneRef,
  ...profiles: LegacySketchProfile[]
): SketchFeature {
  const { sketch: data } = sketchFromLegacyProfiles(profiles);
  return { ...base(id), kind: 'sketch', plane, ...data };
}

function sketch(id: string, plane: Plane, offset: number, ...profiles: LegacySketchProfile[]) {
  return sketchOn(id, { kind: 'plane', plane, offset }, ...profiles);
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

const rect = (x: number, y: number, width: number, height: number): LegacySketchProfile => ({
  kind: 'rectangle',
  x,
  y,
  width,
  height,
});
const circle = (cx: number, cy: number, radius: number): LegacySketchProfile => ({
  kind: 'circle',
  cx,
  cy,
  radius,
});

/** Box `x0..x0+w, y0..y0+d, z0..z0+h` (body `body:<id>`). */
function box(id: string, x0: number, y0: number, w: number, d: number, h: number, z0 = 0) {
  return [sketch(`${id}-s`, 'XY', z0, rect(x0, y0, w, d)), extrude(id, `${id}-s`, h)];
}

async function evaluate(features: Feature[]): Promise<EvaluationResult> {
  const { evaluator } = await loadNodeKernel();
  return evaluator.evaluate(features);
}

function only(result: EvaluationResult, id: string): Body {
  const found = result.bodies.find((b) => b.id === id);
  assert.ok(
    found,
    `body ${id} exists (bodies: ${result.bodies.map((b) => b.id).join(', ')}; errors: ${JSON.stringify(result.errors)})`,
  );
  return found;
}

function near(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: expected ${expected}, got ${actual}`);
}

function bbox(body: Body, min: number[], max: number[], tol = 1e-3): void {
  body.min.forEach((v, i) => near(v, min[i]!, tol, `min[${i}] of ${body.id}`));
  body.max.forEach((v, i) => near(v, max[i]!, tol, `max[${i}] of ${body.id}`));
}

function faceRef(body: Body, predicate: (f: Body['faces'][number]) => boolean): FaceRef {
  const face = body.faces.find(predicate);
  assert.ok(face, `face found on ${body.id}`);
  return { bodyId: body.id, key: face.key, signature: faceSignatureOf(face) };
}

const planeAt =
  (axis: 0 | 1 | 2, value: number, sign = 1) =>
  (f: Body['faces'][number]) =>
    f.surface === 'plane' &&
    f.normal !== null &&
    Math.abs(f.normal[axis]! - sign) < 1e-9 &&
    Math.abs(f.centroid[axis]! - value) < 1e-6;

const noErrors = (result: EvaluationResult) =>
  assert.deepEqual(result.errors, {}, `errors: ${JSON.stringify(result.errors)}`);

// ---- Extrude -------------------------------------------------------------------------

void test('Extrude Intersect keeps the common volume; no overlap is an error', async () => {
  const features: Feature[] = [
    ...box('a', 0, 0, 20, 20, 20),
    sketch('c-s', 'XY', 0, circle(10, 10, 5)),
    extrude('c', 'c-s', 30, { operation: 'intersect', targetBodyId: 'body:a' }),
  ];
  const result = await evaluate(features);
  noErrors(result);
  near(only(result, 'body:a').volume, Math.PI * 25 * 20, 0.05, 'intersect volume');
  const apart = await evaluate([
    ...box('a', 0, 0, 20, 20, 20),
    sketch('c-s', 'XY', 0, circle(60, 60, 5)),
    extrude('c', 'c-s', 30, { operation: 'intersect', targetBodyId: 'body:a' }),
  ]);
  assert.match(apart.errors['c'] ?? '', /does not overlap/);
  near(only(apart, 'body:a').volume, 8000, 1e-3, 'body unchanged after a failed intersect');
});

void test('Extrude Through All cuts through every body in its direction', async () => {
  const result = await evaluate([
    ...box('a', 0, 0, 20, 20, 10),
    ...box('b', 0, 0, 20, 20, 5, 15),
    sketch('h-s', 'XY', 25, circle(10, 10, 3)),
    extrude('h', 'h-s', -1, {
      operation: 'cut',
      targetBodyId: 'body:a',
      extent: { kind: 'throughAll' },
    }),
  ]);
  noErrors(result);
  near(only(result, 'body:a').volume, 4000 - Math.PI * 9 * 10, 0.05, 'through hole');
  const upward = await evaluate([
    ...box('a', 0, 0, 20, 20, 10),
    sketch('h-s', 'XY', 25, circle(10, 10, 3)),
    extrude('h', 'h-s', 1, { operation: 'cut', extent: { kind: 'throughAll' } }),
  ]);
  assert.match(upward.errors['h'] ?? '', /no body on this side/);
});

void test('Extrude To Object: parallel face, slanted face and body', async () => {
  const boxes = [...box('a', 0, 0, 20, 20, 10), ...box('b', 0, 0, 20, 20, 10, 30)];
  const first = await evaluate(boxes);
  const b = only(first, 'body:b');
  const bottom = faceRef(b, planeAt(2, 30, -1));
  const toFace = await evaluate([
    ...boxes,
    sketch('p-s', 'XY', 10, circle(10, 10, 4)),
    extrude('p', 'p-s', 1, {
      extent: { kind: 'toObject', target: { kind: 'face', face: bottom } },
    }),
  ]);
  noErrors(toFace);
  const peg = only(toFace, 'body:p');
  near(peg.volume, Math.PI * 16 * 20, 0.05, 'peg up to the face');
  bbox(peg, [6, 6, 10], [14, 14, 30]);
  const toBody = await evaluate([
    ...boxes,
    sketch('p-s', 'XY', 10, circle(10, 10, 4)),
    extrude('p', 'p-s', 1, {
      extent: { kind: 'toObject', target: { kind: 'body', bodyId: 'body:b' } },
    }),
  ]);
  noErrors(toBody);
  near(only(toBody, 'body:p').volume, Math.PI * 16 * 20, 0.05, 'peg up to the body');
  // A slanted target: a wedge whose underside rises from z 30 (x −5) to z 40 (x 25).
  const wedge: SketchFeature = {
    ...base('w-s'),
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XZ', offset: 0 },
    ...addPolyline(
      EMPTY_SKETCH,
      [
        [-5, 30],
        [25, 40],
        [25, 50],
        [-5, 50],
      ],
      { closed: true },
    ).sketch,
  };
  const wedgeDoc: Feature[] = [...box('a', 0, 0, 20, 20, 10), wedge, extrude('w', 'w-s', 20)];
  const wedgeFirst = await evaluate(wedgeDoc);
  noErrors(wedgeFirst);
  const slope = faceRef(
    only(wedgeFirst, 'body:w'),
    (f) => f.surface === 'plane' && f.normal !== null && f.normal[2] < -0.5 && f.normal[2] > -0.99,
  );
  const slanted = await evaluate([
    ...wedgeDoc,
    sketch('p-s', 'XY', 10, circle(10, 10, 4)),
    extrude('p', 'p-s', 1, { extent: { kind: 'toObject', target: { kind: 'face', face: slope } } }),
  ]);
  noErrors(slanted);
  // Height 35 − 10 at the centre; the slope's linear term averages out over the disk.
  near(only(slanted, 'body:p').volume, Math.PI * 16 * 25, 0.05, 'peg up to the slanted face');
});

void test('Extrude two sides, symmetric and start offset spans', async () => {
  const two = await evaluate([
    sketch('s', 'XY', 0, rect(0, 0, 10, 10)),
    extrude('e', 's', 10, { distance2: 5 }),
  ]);
  noErrors(two);
  bbox(only(two, 'body:e'), [0, 0, -5], [10, 10, 10]);
  const down = await evaluate([
    sketch('s', 'XY', 0, rect(0, 0, 10, 10)),
    extrude('e', 's', -10, { distance2: 4 }),
  ]);
  bbox(only(down, 'body:e'), [0, 0, -10], [10, 10, 4]);
  const offset = await evaluate([
    sketch('s', 'XY', 0, rect(0, 0, 10, 10)),
    extrude('e', 's', 10, { startOffset: 5 }),
  ]);
  bbox(only(offset, 'body:e'), [0, 0, 5], [10, 10, 15]);
  const symmetric = await evaluate([
    sketch('s', 'XY', 0, rect(0, 0, 10, 10)),
    extrude('e', 's', 6, { symmetric: true, startOffset: 2 }),
  ]);
  bbox(only(symmetric, 'body:e'), [0, 0, -4], [10, 10, 8]);
});

// ---- Construction planes and axes -------------------------------------------------------

function plane(
  id: string,
  definition: ConstructionPlaneFeature['definition'],
): ConstructionPlaneFeature {
  return { ...base(id), kind: 'constructionPlane', definition };
}

function axis(
  id: string,
  definition: ConstructionAxisFeature['definition'],
): ConstructionAxisFeature {
  return { ...base(id), kind: 'constructionAxis', definition };
}

const construction = (featureId: string): SketchPlaneRef => ({
  kind: 'construction',
  featureId,
  frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
});

void test('construction planes: offset/midplane/angle/three points/tangent, as sketch planes', async () => {
  const boxes = box('a', 0, 0, 20, 20, 10);
  const first = await evaluate(boxes);
  const a = only(first, 'body:a');
  const top = faceRef(a, planeAt(2, 10));
  const bottom = faceRef(a, planeAt(2, 0, -1));
  const doc: Feature[] = [
    ...boxes,
    plane('p1', { kind: 'offset', base: { kind: 'face', face: top }, distance: 12 }),
    sketchOn('s1', construction('p1'), rect(0, 0, 5, 5)),
    extrude('e1', 's1', 3),
    plane('mid', {
      kind: 'midplane',
      a: { kind: 'face', face: top },
      b: { kind: 'face', face: bottom },
    }),
    plane('tilt', {
      kind: 'angle',
      base: { kind: 'plane', plane: 'XY', offset: 0 },
      axis: { kind: 'world', axis: 'X' },
      angle: 90,
    }),
    plane('tri', {
      kind: 'threePoints',
      points: [
        { kind: 'point', point: [0, 0, 5] },
        { kind: 'point', point: [10, 0, 5] },
        { kind: 'point', point: [0, 10, 5] },
      ],
    }),
  ];
  const result = await evaluate(doc);
  noErrors(result);
  bbox(only(result, 'body:e1'), [0, 0, 22], [5, 5, 25]);
  const datum = (id: string) => result.datums?.find((d) => d.featureId === id);
  assert.equal(datum('p1')?.kind, 'plane');
  near(datum('mid')!.frame.origin[2], 5, 1e-9, 'midplane height');
  const tilt = datum('tilt')!.frame.normal;
  near(Math.abs(tilt[1]), 1, 1e-9, 'XY turned 90° about X faces ±Y');
  near(datum('tri')!.frame.normal[2], 1, 1e-9, 'three-point plane normal');
  // A cylinder: tangent plane at 0° and the cylinder's axis.
  const cyl = await evaluate([sketch('c-s', 'XY', 0, circle(0, 0, 5)), extrude('c', 'c-s', 10)]);
  const side = faceRef(only(cyl, 'body:c'), (f) => f.surface === 'cylinder');
  const tangent = await evaluate([
    sketch('c-s', 'XY', 0, circle(0, 0, 5)),
    extrude('c', 'c-s', 10),
    plane('t', { kind: 'tangent', face: side, angle: 0 }),
    axis('ax', { kind: 'cylinder', face: side }),
  ]);
  noErrors(tangent);
  const t = tangent.datums!.find((d) => d.featureId === 't')!;
  near(Math.hypot(t.center[0], t.center[1]), 5, 1e-6, 'tangent plane touches the cylinder');
  const ax = tangent.datums!.find((d) => d.featureId === 'ax')!;
  near(Math.abs(ax.frame.normal[2]), 1, 1e-9, 'cylinder axis along Z');
  near(Math.hypot(ax.frame.origin[0], ax.frame.origin[1]), 0, 1e-6, 'cylinder axis through 0');
});

void test('editing a construction plane re-evaluates the features that depend on it (prefix cache)', async () => {
  const { evaluator } = await loadNodeKernel();
  const doc = (distance: number, width = 5): Feature[] => [
    ...box('a', 0, 0, 20, 20, 10),
    plane('p1', { kind: 'offset', base: { kind: 'plane', plane: 'XY', offset: 0 }, distance }),
    sketchOn('s1', construction('p1'), rect(0, 0, width, 5)),
    extrude('e1', 's1', 3),
  ];
  const first = await evaluator.evaluate(doc(12));
  noErrors(first);
  bbox(only(first, 'body:e1'), [0, 0, 12], [5, 5, 15]);
  // The same document again: everything comes from the checkpoints.
  const again = await evaluator.evaluate(doc(12));
  assert.equal(again.stats.evaluatedFeatures, 0);
  // Moving the plane: the box is reused, the plane, its sketch and the extrude are replayed
  // on the new plane — no stale datum from the checkpoint before the edit.
  const moved = await evaluator.evaluate(doc(20));
  noErrors(moved);
  assert.equal(moved.stats.reusedFeatures, 2, 'box sketch + box reused');
  assert.equal(moved.stats.evaluatedFeatures, 3, 'plane, sketch and extrude replayed');
  near(moved.datums!.find((d) => d.featureId === 'p1')!.frame.origin[2], 20, 1e-9, 'plane moved');
  bbox(only(moved, 'body:e1'), [0, 0, 20], [5, 5, 23]);
  // An edit after the plane restores the moved plane's datum from its checkpoint.
  const wider = await evaluator.evaluate(doc(20, 8));
  noErrors(wider);
  assert.equal(wider.stats.reusedFeatures, 3, 'box and the moved plane reused');
  bbox(only(wider, 'body:e1'), [0, 0, 20], [8, 5, 23]);
  // Back to the first plane: served from the first document's checkpoints again.
  const back = await evaluator.evaluate(doc(12));
  assert.equal(back.stats.evaluatedFeatures, 0);
  bbox(only(back, 'body:e1'), [0, 0, 12], [5, 5, 15]);
});

void test('construction axes drive a circular pattern; a construction plane mirrors; missing reference', async () => {
  const doc: Feature[] = [
    ...box('a', 10, -2, 4, 4, 4),
    axis('z', {
      kind: 'planes',
      a: { kind: 'plane', plane: 'XZ', offset: 0 },
      b: { kind: 'plane', plane: 'YZ', offset: 0 },
    }),
    {
      ...base('pat'),
      kind: 'pattern',
      bodyIds: ['body:a'],
      pattern: {
        kind: 'circular',
        axis: { kind: 'construction', featureId: 'z', line: { point: [0, 0, 0], dir: [0, 0, 1] } },
        count: 4,
        angle: 360,
      },
    } as PatternFeature,
    plane('yz5', { kind: 'offset', base: { kind: 'plane', plane: 'YZ', offset: 0 }, distance: 20 }),
    {
      ...base('m'),
      kind: 'mirror',
      bodyIds: ['body:a'],
      plane: construction('yz5'),
      keepOriginal: true,
    } as MirrorFeature,
  ];
  const result = await evaluate(doc);
  noErrors(result);
  assert.equal(result.bodies.length, 5);
  const mirrored = result.bodies.find((b) => b.createdBy === 'm')!;
  bbox(mirrored, [26, -2, 0], [30, 2, 4]);
  // Deleting the plane: the mirror reports the missing reference, nothing else breaks.
  const broken = await evaluate(doc.filter((f) => f.id !== 'yz5'));
  assert.match(broken.errors['m'] ?? '', /Missing reference: construction plane/);
  assert.equal(broken.errors['pat'], undefined);
});

void test('Boolean Keep Target: the target stays and the result is a new body', async () => {
  const doc: Feature[] = [
    ...box('a', 0, 0, 10, 10, 10),
    ...box('b', 5, 0, 10, 10, 10),
    {
      ...base('u'),
      kind: 'boolean',
      operation: 'subtract',
      targetBodyId: 'body:a',
      toolBodyIds: ['body:b'],
      keepTools: true,
      keepTarget: true,
    } as BooleanFeature,
  ];
  const result = await evaluate(doc);
  noErrors(result);
  near(only(result, 'body:a').volume, 1000, 1e-6, 'target kept');
  near(only(result, 'body:b').volume, 1000, 1e-6, 'tool kept');
  near(only(result, 'body:u').volume, 500, 1e-6, 'result body');
});

void test('Mirror of a sketch, a planar face and about an axis', async () => {
  const doc: Feature[] = [sketch('s', 'XY', 0, rect(2, 0, 6, 4)), ...box('a', 0, 0, 10, 10, 5, 20)];
  const first = await evaluate(doc);
  const top = faceRef(only(first, 'body:a'), planeAt(2, 25));
  const mirror: MirrorFeature = {
    ...base('m'),
    kind: 'mirror',
    bodyIds: [],
    sketchIds: ['s'],
    faces: [top],
    plane: { kind: 'plane', plane: 'YZ', offset: 0 },
    keepOriginal: true,
  };
  const result = await evaluate([
    ...doc,
    mirror,
    extrude('e1', mirroredSketchId('m', 0), 3),
    extrude('e2', mirroredSketchId('m', 1), 2),
  ]);
  noErrors(result);
  bbox(only(result, 'body:e1'), [-8, 0, 0], [-2, 4, 3]);
  // The mirrored top face is a 10 × 10 profile at x −10..0; its normal still faces +Z.
  const e2 = only(result, 'body:e2');
  near(e2.volume, 200, 1e-6, 'mirrored face profile');
  near(e2.min[0], -10, 1e-6, 'mirrored face x');
  // About the Z axis: a half turn.
  const turned = await evaluate([
    ...box('b', 2, 0, 4, 4, 4),
    {
      ...base('m2'),
      kind: 'mirror',
      bodyIds: ['body:b'],
      plane: { kind: 'plane', plane: 'YZ', offset: 0 },
      axis: { kind: 'world', axis: 'Z' },
      keepOriginal: true,
    } as MirrorFeature,
  ]);
  noErrors(turned);
  bbox(turned.bodies.find((b) => b.createdBy === 'm2')!, [-6, -4, 0], [-2, 0, 4]);
});

// ---- Offset Face modes (DIR-01) ----------------------------------------------------------

function offsetFace(
  id: string,
  faces: FaceRef[],
  distance: number,
  extra: Partial<OffsetFaceFeature> = {},
): OffsetFaceFeature {
  return { ...base(id), kind: 'offsetFace', faces, distance, ...extra };
}

void test('Offset Face Radius/Diameter on a boss and a hole: exact target sizes', async () => {
  const boss = [sketch('c-s', 'XY', 0, circle(0, 0, 5)), extrude('c', 'c-s', 10)];
  const bossFirst = await evaluate(boss);
  const side = faceRef(only(bossFirst, 'body:c'), (f) => f.surface === 'cylinder');
  const radius = await evaluate([...boss, offsetFace('o', [side], 7, { mode: 'radius' })]);
  noErrors(radius);
  near(only(radius, 'body:c').volume, Math.PI * 49 * 10, 0.05, 'boss radius 5 → 7');
  const diameter = await evaluate([...boss, offsetFace('o', [side], 8, { mode: 'diameter' })]);
  noErrors(diameter);
  near(only(diameter, 'body:c').volume, Math.PI * 16 * 10, 0.05, 'boss Ø10 → Ø8');
  // Already at the size: the step changes nothing and reports nothing.
  const same = await evaluate([...boss, offsetFace('o', [side], 5, { mode: 'radius' })]);
  noErrors(same);
  near(only(same, 'body:c').volume, Math.PI * 25 * 10, 0.05, 'unchanged');
  // The target holds when an earlier step changes the face (re-measured on every replay).
  const wider = [sketch('c-s', 'XY', 0, circle(0, 0, 6)), extrude('c', 'c-s', 10)];
  const kept = await evaluate([...wider, offsetFace('o', [side], 7, { mode: 'radius' })]);
  noErrors(kept);
  near(only(kept, 'body:c').volume, Math.PI * 49 * 10, 0.05, 'radius 6 → 7');

  const plate = [
    ...box('a', 0, 0, 20, 20, 10),
    sketch('h-s', 'XY', 10, circle(10, 10, 3)),
    extrude('h', 'h-s', -10, { operation: 'cut', targetBodyId: 'body:a' }),
  ];
  const plateFirst = await evaluate(plate);
  noErrors(plateFirst);
  const wall = faceRef(only(plateFirst, 'body:a'), (f) => f.surface === 'cylinder');
  const hole = await evaluate([...plate, offsetFace('o', [wall], 4, { mode: 'radius' })]);
  noErrors(hole);
  near(only(hole, 'body:a').volume, 4000 - Math.PI * 16 * 10, 0.05, 'hole radius 3 → 4');
  const smaller = await evaluate([...plate, offsetFace('o', [wall], 5, { mode: 'diameter' })]);
  noErrors(smaller);
  near(only(smaller, 'body:a').volume, 4000 - Math.PI * 6.25 * 10, 0.05, 'hole Ø6 → Ø5');
});

void test('Offset Face Total to the opposite face; mode errors are readable', async () => {
  const doc = (height: number) => box('a', 0, 0, 20, 20, height);
  const first = await evaluate(doc(10));
  const a = only(first, 'body:a');
  const top = faceRef(a, planeAt(2, 10));
  const bottom = faceRef(a, planeAt(2, 0, -1));
  const total = await evaluate([
    ...doc(10),
    offsetFace('o', [top], 15, { mode: 'total', opposite: bottom }),
  ]);
  noErrors(total);
  bbox(only(total, 'body:a'), [0, 0, 0], [20, 20, 15]);
  // A taller box before the step: the total stays 15.
  const taller = await evaluate([
    ...doc(12),
    offsetFace('o', [top], 15, { mode: 'total', opposite: bottom }),
  ]);
  noErrors(taller);
  near(only(taller, 'body:a').volume, 6000, 1e-3, 'total kept at 15');
  const thinner = await evaluate([
    ...doc(10),
    offsetFace('o', [top], 4, { mode: 'total', opposite: bottom }),
  ]);
  noErrors(thinner);
  bbox(only(thinner, 'body:a'), [0, 0, 0], [20, 20, 4]);

  const side = faceRef(a, planeAt(0, 20));
  const errors = await evaluate([
    ...doc(10),
    offsetFace('r', [top], 5, { mode: 'radius' }),
    offsetFace('n', [top], 5, { mode: 'total' }),
    offsetFace('p', [top], 5, { mode: 'total', opposite: side }),
    offsetFace('m', [top, bottom], 5, { mode: 'total', opposite: bottom }),
    offsetFace('z', [top], -1, { mode: 'total', opposite: bottom }),
  ]);
  assert.match(errors.errors['r'] ?? '', /Radius needs a cylindrical face/);
  assert.match(errors.errors['n'] ?? '', /Total needs an opposite face/);
  assert.match(errors.errors['p'] ?? '', /parallel/);
  assert.match(errors.errors['m'] ?? '', /exactly one face/);
  assert.match(errors.errors['z'] ?? '', /total distance must be a positive number/);
});

void test('.hcasm: new extrude, construction and mirror fields round-trip; bad values are rejected', async () => {
  const features: Feature[] = [
    sketch('s', 'XY', 0, rect(0, 0, 10, 10)),
    extrude('e', 's', 10, {
      operation: 'intersect',
      extent: { kind: 'throughAll' },
      distance2: 2,
      startOffset: 1,
    }),
    plane('p', { kind: 'offset', base: { kind: 'plane', plane: 'XY', offset: 0 }, distance: 3 }),
    axis('x', {
      kind: 'twoPoints',
      a: { kind: 'point', point: [0, 0, 0] },
      b: { kind: 'point', point: [1, 0, 0] },
    }),
    sketchOn('s2', construction('p'), rect(0, 0, 1, 1)),
    offsetFace('o', [{ bodyId: 'body:e', key: 'e:end', signature: SIG }], 12, {
      mode: 'total',
      opposite: { bodyId: 'body:e', key: 'e:start', signature: SIG },
    }),
  ];
  const text = saveProjectFile({
    projectName: 'x',
    features,
    appVersion: 'test',
    createdAt: '2026-09-30T00:00:00.000Z',
  });
  const loaded = loadProjectFile(text);
  assert.deepEqual(loaded.features, features);
  const bad = JSON.parse(text) as { features: Record<string, unknown>[] };
  bad.features[1]!.extent = { kind: 'toNowhere' };
  assert.throws(() => loadProjectFile(JSON.stringify(bad)), /extent\.kind/);
  const badMode = JSON.parse(text) as { features: Record<string, unknown>[] };
  badMode.features[5]!.mode = 'volume';
  assert.throws(() => loadProjectFile(JSON.stringify(badMode)), /mode/);
});

const SIG: FaceRef['signature'] = {
  surface: 'plane',
  normal: [0, 0, 1],
  centroid: [5, 5, 10],
  area: 100,
  adjacentFaces: 4,
};
