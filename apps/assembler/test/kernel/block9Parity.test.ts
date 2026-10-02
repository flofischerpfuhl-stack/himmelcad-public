/**
 * Block 9 parity on the real OCCT kernel (`assembler/GAP-INVENTORY.md`):
 * MOD-23 Replace Face (planar and cylindrical replacing faces, kept keys,
 * refusals). Volumes and boxes against hand calculations.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  edgeSignatureOf,
  faceSignatureOf,
} from '../../renderer/src/foundation/geometry-kernel/naming.js';
import type {
  Body,
  EvaluationResult,
} from '../../renderer/src/foundation/geometry-kernel/types.js';
import type {
  EdgeRef,
  ExtrudeFeature,
  FaceRef,
  Feature,
  Plane,
} from '../../renderer/src/foundation/document/document.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import type { AlignFeature } from '../../renderer/src/modules/modeling/features.js';
import type {
  MoveFaceFeature,
  ReplaceFaceFeature,
} from '../../renderer/src/modules/direct-edit/kinds.js';
import { loadProjectFile, saveProjectFile } from '../../renderer/src/foundation/document/format.js';
import { sketchFromLegacyProfiles } from '../../renderer/src/foundation/sketch-solver/builders.js';
import type { LegacySketchProfile } from '../sketch/fixtures.js';
import { loadNodeKernel } from './nodeKernel.js';

const base = (id: string) => ({ id, name: id, suppressed: false });

function sketch(id: string, plane: Plane, offset: number, ...profiles: LegacySketchProfile[]) {
  const { sketch: data } = sketchFromLegacyProfiles(profiles);
  return {
    ...base(id),
    kind: 'sketch',
    plane: { kind: 'plane', plane, offset },
    ...data,
  } as SketchFeature;
}

function extrude(id: string, sketchId: string, distance: number): ExtrudeFeature {
  return {
    ...base(id),
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketchId },
    distance,
    symmetric: false,
    operation: 'new',
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

function box(id: string, x0: number, y0: number, w: number, d: number, h: number): Feature[] {
  return [sketch(`${id}-s`, 'XY', 0, rect(x0, y0, w, d)), extrude(id, `${id}-s`, h)];
}

async function evaluate(features: Feature[]): Promise<EvaluationResult> {
  const { evaluator } = await loadNodeKernel();
  return evaluator.evaluate(features);
}

function only(result: EvaluationResult, id: string): Body {
  const found = result.bodies.find((b) => b.id === id);
  assert.ok(found, `body ${id} exists (errors: ${JSON.stringify(result.errors)})`);
  return found;
}

function near(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: expected ${expected}, got ${actual}`);
}

const noErrors = (result: EvaluationResult) =>
  assert.deepEqual(result.errors, {}, `errors: ${JSON.stringify(result.errors)}`);

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

function replace(id: string, faces: FaceRef[], target: FaceRef): ReplaceFaceFeature {
  return { ...base(id), kind: 'replaceFace', faces, target };
}

// ---- Replace Face (MOD-23) -------------------------------------------------------------------

void test('Replace Face: a top face extends and trims to a parallel face of another body', async () => {
  const bodies = [...box('a', 0, 0, 10, 10, 10), ...box('b', 20, 0, 10, 10, 15)];
  const first = await evaluate(bodies);
  const topA = faceRef(only(first, 'body:a'), planeAt(2, 10));
  const topB = faceRef(only(first, 'body:b'), planeAt(2, 15));
  const up = await evaluate([...bodies, replace('r', [topA], topB)]);
  noErrors(up);
  near(only(up, 'body:a').volume, 1500, 1e-3, 'extended to z = 15');
  near(only(up, 'body:a').max[2], 15, 1e-6, 'top at the replacing plane');
  // The replaced face keeps its key (a later step on it still resolves).
  assert.ok(
    only(up, 'body:a').faces.some((f) => f.key === topA.key && Math.abs(f.centroid[2] - 15) < 1e-6),
    'the top face kept its key',
  );
  const down = await evaluate([...bodies, replace('r', [topB], topA)]);
  noErrors(down);
  near(only(down, 'body:b').volume, 1000, 1e-3, 'trimmed to z = 10');
  // Round trip through the file format.
  const text = saveProjectFile({
    projectName: 'replace',
    features: [...bodies, replace('r', [topA], topB)],
    appVersion: 'test',
    createdAt: new Date(0).toISOString(),
  });
  const loaded = loadProjectFile(text);
  assert.equal(loaded.features.at(-1)?.kind, 'replaceFace');
});

void test('Replace Face: a tilted replacing plane turns the face; neighbours follow', async () => {
  const bodies = [...box('a', 0, 0, 10, 10, 10), ...box('b', 20, 0, 10, 10, 10)];
  const first = await evaluate(bodies);
  const topB = faceRef(only(first, 'body:b'), planeAt(2, 10));
  const turn: MoveFaceFeature = {
    ...base('t'),
    kind: 'moveFace',
    face: topB,
    vector: [0, 0, 0],
    rotation: { point: [25, 10, 10], axis: [-1, 0, 0], angle: 20 },
  };
  const turned = await evaluate([...bodies, turn]);
  noErrors(turned);
  const tilted = faceRef(
    only(turned, 'body:b'),
    (f) => f.surface === 'plane' && f.normal !== null && f.normal[2] > 0.5 && f.normal[2] < 0.99,
  );
  const topA = faceRef(only(turned, 'body:a'), planeAt(2, 10));
  const result = await evaluate([...bodies, turn, replace('r', [topA], tilted)]);
  noErrors(result);
  const rise = 10 * Math.tan((20 * Math.PI) / 180);
  near(only(result, 'body:a').volume, 1000 + 0.5 * 10 * 10 * rise, 1e-3, 'a wedge on top');
  near(only(result, 'body:a').max[2], 10 + rise, 1e-3, 'front edge on the tilted plane');
});

void test('Replace Face: an end face extends to a round post (cylindrical replacing face)', async () => {
  const bodies: Feature[] = [
    ...box('a', 0, 2, 10, 6, 10),
    sketch('p-s', 'XY', 0, circle(30, 5, 5)),
    extrude('p', 'p-s', 20),
  ];
  const first = await evaluate(bodies);
  const end = faceRef(only(first, 'body:a'), planeAt(0, 10));
  const wall = faceRef(only(first, 'body:p'), (f) => f.surface === 'cylinder');
  const result = await evaluate([...bodies, replace('r', [end], wall)]);
  noErrors(result);
  // Between x = 10 and the post's near side, over y 2…8: 6·20 minus the circle segment.
  const segment = 3 * 4 + 25 * Math.asin(0.6);
  near(only(result, 'body:a').volume, 600 + (120 - segment) * 10, 1e-2, 'reaches the post');
  near(only(result, 'body:a').max[0], 26, 1e-3, 'ends on the cylinder (x = 30 - 4 at y = 2/8)');
});

void test('Replace Face refuses curved faces, perpendicular targets and itself', async () => {
  const bodies: Feature[] = [
    ...box('a', 0, 0, 10, 10, 10),
    sketch('p-s', 'XY', 0, circle(30, 5, 5)),
    extrude('p', 'p-s', 20),
  ];
  const first = await evaluate(bodies);
  const a = only(first, 'body:a');
  const top = faceRef(a, planeAt(2, 10));
  const side = faceRef(a, planeAt(0, 10));
  const wall = faceRef(only(first, 'body:p'), (f) => f.surface === 'cylinder');
  const capP = faceRef(only(first, 'body:p'), planeAt(2, 20));
  const curved = await evaluate([...bodies, replace('r', [wall], capP)]);
  assert.match(curved.errors['r'] ?? '', /Only planar faces/);
  const perpendicular = await evaluate([...bodies, replace('r', [top], side)]);
  assert.match(perpendicular.errors['r'] ?? '', /perpendicular/);
  const self = await evaluate([...bodies, replace('r', [top], top)]);
  assert.match(self.errors['r'] ?? '', /cannot be one of the faces/);
  // Along the post's axis the normal never meets its wall.
  const along = await evaluate([...bodies, replace('r', [top], wall)]);
  assert.match(along.errors['r'] ?? '', /runs along the cylinder axis/);
});

// ---- Align with axes, edges and centres (MOD-22) -------------------------------------------

function cylinderBody(id: string, cx: number, cy: number, r: number, h: number, z0 = 0): Feature[] {
  return [{ ...sketch(`${id}-s`, 'XY', z0, circle(cx, cy, r)) }, extrude(id, `${id}-s`, h)];
}

function align(id: string, extra: Partial<AlignFeature>): AlignFeature {
  return {
    ...base(id),
    kind: 'align',
    bodyId: 'body:a',
    flip: false,
    center: true,
    offset: 0,
    ...extra,
  } as AlignFeature;
}

const edgeRef = (body: Body, predicate: (e: Body['edges'][number]) => boolean): EdgeRef => {
  const edge = body.edges.find(predicate);
  assert.ok(edge, `edge found on ${body.id}`);
  return { bodyId: body.id, key: edge.key, signature: edgeSignatureOf(edge) };
};

void test('Align: a pin lands coaxial in a post (cylindrical faces), centred or kept, offset along the axis', async () => {
  // Pin: r 2, h 10 lying along Z at (30, 10); target: post r 5, h 20 at the origin.
  const bodies = [...cylinderBody('a', 30, 10, 2, 10, 5), ...cylinderBody('b', 0, 0, 5, 20)];
  const first = await evaluate(bodies);
  const pin = faceRef(only(first, 'body:a'), (f) => f.surface === 'cylinder');
  const post = faceRef(only(first, 'body:b'), (f) => f.surface === 'cylinder');
  const centred = await evaluate([
    ...bodies,
    align('al', { from: { kind: 'face', face: pin }, to: { kind: 'face', face: post } }),
  ]);
  noErrors(centred);
  const a = only(centred, 'body:a');
  near((a.min[0] + a.max[0]) / 2, 0, 1e-6, 'x on the post axis');
  near((a.min[1] + a.max[1]) / 2, 0, 1e-6, 'y on the post axis');
  near((a.min[2] + a.max[2]) / 2, 10, 1e-6, 'mid-heights together');
  const kept = await evaluate([
    ...bodies,
    align('al', {
      from: { kind: 'face', face: pin },
      to: { kind: 'face', face: post },
      center: false,
      offset: 3,
    }),
  ]);
  noErrors(kept);
  near(only(kept, 'body:a').min[2], 8, 1e-6, 'height kept, then 3 mm along the axis');
  near(only(kept, 'body:a').min[0], -2, 1e-6, 'on the axis');
});

void test('Align: a round edge onto a round edge (coaxial, centres together), a straight edge onto a world axis', async () => {
  const bodies = [...cylinderBody('a', 30, 10, 2, 10, 5), ...box('b', -5, -5, 10, 10, 4)];
  const first = await evaluate(bodies);
  const bottomCircle = edgeRef(
    only(first, 'body:a'),
    (e) => e.curve === 'circle' && Math.abs(e.midpoint[2] - 5) < 1e-6,
  );
  // b's top front edge (y = -5, z = 4) along X.
  const top = edgeRef(
    only(first, 'body:b'),
    (e) =>
      e.curve === 'line' &&
      Math.abs(e.midpoint[1] + 5) < 1e-6 &&
      Math.abs(e.midpoint[2] - 4) < 1e-6,
  );
  // The pin's circle centre onto the edge's midpoint line (a centre onto an axis is not this; an axis onto an axis is).
  const coaxial = await evaluate([
    ...bodies,
    align('al', {
      from: { kind: 'axis', axis: { kind: 'edge', edge: bottomCircle } },
      to: { kind: 'axis', axis: { kind: 'world', axis: 'Z' } },
    }),
  ]);
  noErrors(coaxial);
  const a = only(coaxial, 'body:a');
  near((a.min[0] + a.max[0]) / 2, 0, 1e-6, 'on Z (x)');
  near((a.min[1] + a.max[1]) / 2, 0, 1e-6, 'on Z (y)');
  near(a.min[2], 0, 1e-6, 'circle centre at the world origin');
  // An axis lying along X (the pin turned) onto the box's top front edge.
  const turned = await evaluate([
    ...bodies,
    align('al', {
      from: { kind: 'axis', axis: { kind: 'edge', edge: bottomCircle } },
      to: { kind: 'axis', axis: { kind: 'edge', edge: top } },
      center: false,
    }),
  ]);
  noErrors(turned);
  const t = only(turned, 'body:a');
  near(t.max[0] - t.min[0], 10, 1e-6, 'the pin now lies along X');
  near((t.min[1] + t.max[1]) / 2, -5, 1e-6, 'its axis on the edge (y)');
  near((t.min[2] + t.max[2]) / 2, 4, 1e-6, 'its axis on the edge (z)');
  // A plane onto an axis is refused with the rule.
  const planeOnAxis = await evaluate([
    ...bodies,
    align('al', {
      from: { kind: 'face', face: faceRef(only(first, 'body:a'), planeAt(2, 15)) },
      to: { kind: 'axis', axis: { kind: 'edge', edge: top } },
    }),
  ]);
  assert.match(planeOnAxis.errors['al'] ?? '', /plane to a plane/);
  // Two planar faces still work through face/target (stored as before).
  const planes = await evaluate([
    ...bodies,
    align('al', {
      face: faceRef(only(first, 'body:a'), planeAt(2, 5, -1)),
      target: faceRef(only(first, 'body:b'), planeAt(2, 4)),
    }),
  ]);
  noErrors(planes);
  near(only(planes, 'body:a').min[2], 4, 1e-6, 'standing on the box');
});

void test('Align: a ball centre onto an axis and onto a centre, a cone axis onto an axis', async () => {
  const prim = (id: string, shape: string, center: [number, number, number], extra: object) =>
    ({
      ...base(id),
      kind: 'primitive',
      shape,
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      center,
      operation: 'new',
      ...extra,
    }) as unknown as Feature;
  const bodies = [
    prim('a', 'sphere', [20, 10, 0], { radius: 3 }),
    prim('c', 'cone', [-20, 5, 0], { radius: 4, radius2: 1, height: 6 }),
    ...cylinderBody('b', 0, 0, 5, 20),
  ];
  const first = await evaluate(bodies);
  noErrors(first);
  const ball = faceRef(only(first, 'body:a'), (f) => f.surface === 'sphere');
  const cone = faceRef(only(first, 'body:c'), (f) => f.surface === 'cone');
  const post = faceRef(only(first, 'body:b'), (f) => f.surface === 'cylinder');
  const onAxis = await evaluate([
    ...bodies,
    align('al', {
      from: { kind: 'face', face: ball },
      to: { kind: 'face', face: post },
      center: false,
    }),
  ]);
  noErrors(onAxis);
  const a = only(onAxis, 'body:a');
  near((a.min[0] + a.max[0]) / 2, 0, 1e-5, 'ball centre on the post axis (x)');
  near((a.min[1] + a.max[1]) / 2, 0, 1e-5, 'ball centre on the post axis (y)');
  near((a.min[2] + a.max[2]) / 2, 3, 1e-5, 'height kept');
  const coneAxis = await evaluate([
    ...bodies,
    align('al', {
      bodyId: 'body:c',
      from: { kind: 'face', face: cone },
      to: { kind: 'axis', axis: { kind: 'world', axis: 'Z' } },
      center: false,
    }),
  ]);
  noErrors(coneAxis);
  const c = only(coneAxis, 'body:c');
  near((c.min[0] + c.max[0]) / 2, 0, 1e-5, 'cone axis on Z (x)');
  near((c.min[1] + c.max[1]) / 2, 0, 1e-5, 'cone axis on Z (y)');
});

// ---- Split several bodies in one step (MOD-12) -------------------------------------------------

void test('Split: one plane cuts several bodies in one step; ids per body; every body must be cut', async () => {
  const bodies = [...box('a', 0, 0, 10, 10, 10), ...box('b', 20, 0, 10, 10, 10)];
  const split = (extra: object) =>
    ({
      ...base('s'),
      kind: 'split',
      bodyId: 'body:a',
      bodyIds: ['body:b'],
      plane: { kind: 'plane', plane: 'XY', offset: 4 },
      ...extra,
    }) as unknown as Feature;
  const result = await evaluate([...bodies, split({})]);
  noErrors(result);
  near(only(result, 'body:a').volume, 400, 1e-6, 'a below');
  near(only(result, 'body:s').volume, 600, 1e-6, 'a above');
  near(only(result, 'body:b').volume, 400, 1e-6, 'b below');
  near(only(result, 'body:s:102').volume, 600, 1e-6, 'b above');
  const kept = await evaluate([...bodies, split({ keepOriginal: true })]);
  noErrors(kept);
  assert.equal(kept.bodies.length, 6, 'both originals kept, four parts');
  near(only(kept, 'body:s:103').volume, 400, 1e-6, "b's kept-original part");
  const miss = await evaluate([
    ...bodies,
    ...box('c', 40, 0, 10, 10, 3),
    split({ bodyIds: ['body:b', 'body:c'] }),
  ]);
  assert.match(miss.errors['s'] ?? '', /does not cut "Body 3"/);
});

// ---- Taper with other extents (MOD-03) -----------------------------------------------------------

void test('Extrude taper with To Object: the tapered prism stops at the face', async () => {
  const features: Feature[] = [
    ...box('a', 0, 0, 20, 20, 10),
    sketch('p-s', 'XY', 20, rect(5, 5, 10, 10)),
  ];
  const first = await evaluate(features);
  const top = faceRef(only(first, 'body:a'), planeAt(2, 10));
  const result = await evaluate([
    ...features,
    {
      ...extrude('p', 'p-s', -1),
      operation: 'join',
      extent: { kind: 'toObject', target: { kind: 'face', face: top } },
      taper: 5,
    } as ExtrudeFeature,
  ]);
  noErrors(result);
  // From z = 20 down to the top (z = 10): a frustum narrowing by tan 5° per mm on every side.
  const k = Math.tan((5 * Math.PI) / 180);
  const low = 10 - 2 * 10 * k;
  near(
    only(result, 'body:a').volume,
    4000 + (10 / 3) * (100 + low * low + 10 * low),
    0.05,
    'tapered to the face',
  );
});

// ---- Pattern in three directions (MOD-20) ----------------------------------------------------------

void test('Pattern: a third direction makes a block of layers; it must leave the grid plane', async () => {
  const pattern = (third: object) =>
    ({
      ...base('p'),
      kind: 'pattern',
      bodyIds: ['body:a'],
      pattern: {
        kind: 'linear',
        direction: { kind: 'world', axis: 'X' },
        count: 3,
        spacing: 10,
        second: { direction: { kind: 'world', axis: 'Y' }, count: 2, spacing: 10 },
        third,
      },
    }) as unknown as Feature;
  const result = await evaluate([
    ...box('a', 0, 0, 4, 4, 4),
    pattern({ direction: { kind: 'world', axis: 'Z' }, count: 2, spacing: 8 }),
  ]);
  noErrors(result);
  assert.equal(result.bodies.length, 12, '3 × 2 × 2 instances');
  const top = result.bodies.filter((b) => Math.abs(b.min[2] - 8) < 1e-6);
  assert.equal(top.length, 6, 'the second layer');
  assert.ok(
    top.every((b) => /\(\d+, \d+, 2\)$/.test(b.name)),
    'layer names',
  );
  const flat = await evaluate([
    ...box('a', 0, 0, 4, 4, 4),
    pattern({ direction: { kind: 'world', axis: 'X' }, count: 2, spacing: 8 }),
  ]);
  assert.match(flat.errors['p'] ?? '', /leave the plane/);
});

void test('Pattern of a sketch: derived sketches whose profiles later steps extrude', async () => {
  const features: Feature[] = [
    sketch('s', 'XY', 0, rect(0, 0, 4, 4)),
    {
      ...base('p'),
      kind: 'pattern',
      bodyIds: [],
      sketchIds: ['s'],
      pattern: { kind: 'linear', direction: { kind: 'world', axis: 'X' }, count: 3, spacing: 10 },
    } as unknown as Feature,
    extrude('e', 'p:sketch:2', 5),
  ];
  const result = await evaluate(features);
  noErrors(result);
  const body = only(result, 'body:e');
  near(body.min[0], 20, 1e-6, 'the third instance');
  near(body.volume, 80, 1e-6, '4 × 4 × 5');
  assert.ok(result.sketches.some((s) => s.featureId === 'p:sketch:1'));
  const text = saveProjectFile({
    projectName: 'pattern sketch',
    features,
    appVersion: 'test',
    createdAt: new Date(0).toISOString(),
  });
  assert.deepEqual((loadProjectFile(text).features[1] as { sketchIds?: string[] }).sketchIds, [
    's',
  ]);
});
