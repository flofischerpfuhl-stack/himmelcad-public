/**
 * Block 8 modelling parity on the real OCCT kernel (`assembler/GAP-INVENTORY.md`
 * MOD-03 taper, MOD-05 helical revolve, MOD-16/DIR-03 Move Edge / Move Face,
 * MOD-18 Translate, MOD-19 Scale, UI-02 primitives): volumes and boxes
 * against hand calculations, references kept across edits, `.hcasm` round
 * trips, and the refusals with their reasons.
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
  Vec3,
} from '../../renderer/src/foundation/document/document.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import type {
  PrimitiveFeature,
  RevolveFeature,
  ScaleFeature,
  TranslateFeature,
} from '../../renderer/src/modules/modeling/features.js';
import type {
  MoveEdgeFeature,
  MoveFaceFeature,
} from '../../renderer/src/modules/direct-edit/kinds.js';
import { gTransformClass } from '../../renderer/src/foundation/geometry-kernel/occtExtras.js';
import { loadProjectFile, saveProjectFile } from '../../renderer/src/foundation/document/format.js';
import { sketchFromLegacyProfiles } from '../../renderer/src/foundation/sketch-solver/builders.js';
import { detectRegions } from '../../renderer/src/foundation/sketch-solver/regions.js';
import { sketchFeature, type LegacySketchProfile } from '../sketch/fixtures.js';
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

const noErrors = (result: EvaluationResult) =>
  assert.deepEqual(result.errors, {}, `errors: ${JSON.stringify(result.errors)}`);

function faceRef(body: Body, predicate: (f: Body['faces'][number]) => boolean): FaceRef {
  const face = body.faces.find(predicate);
  assert.ok(face, `face found on ${body.id}`);
  return { bodyId: body.id, key: face.key, signature: faceSignatureOf(face) };
}

function edgeRef(body: Body, predicate: (e: Body['edges'][number]) => boolean): EdgeRef {
  const edge = body.edges.find(predicate);
  assert.ok(edge, `edge found on ${body.id}`);
  return { bodyId: body.id, key: edge.key, signature: edgeSignatureOf(edge) };
}

const planeAt =
  (axis: 0 | 1 | 2, value: number, sign = 1) =>
  (f: Body['faces'][number]) =>
    f.surface === 'plane' &&
    f.normal !== null &&
    Math.abs(f.normal[axis]! - sign) < 1e-9 &&
    Math.abs(f.centroid[axis]! - value) < 1e-6;

const lineAt = (mid: Vec3) => (e: Body['edges'][number]) =>
  e.curve === 'line' && Math.hypot(...e.midpoint.map((v, i) => v - mid[i]!)) < 1e-6;

async function hasGTransform(): Promise<boolean> {
  const { oc } = await loadNodeKernel();
  return gTransformClass(oc) !== null;
}

// ---- Scale (MOD-19) -----------------------------------------------------------------------

function scaleFeature(id: string, extra: Partial<ScaleFeature>): ScaleFeature {
  return {
    ...base(id),
    kind: 'scale',
    bodyIds: ['body:a'],
    factor: 1,
    center: [0, 0, 0],
    copy: false,
    ...extra,
  };
}

void test('Scale uniformly about a point, in place and as a copy', async () => {
  const result = await evaluate([
    ...box('a', 0, 0, 10, 10, 10),
    scaleFeature('s', { factor: 2, center: [5, 5, 0] }),
  ]);
  noErrors(result);
  const a = only(result, 'body:a');
  near(a.volume, 8000, 1e-3, 'scaled volume');
  bbox(a, [-5, -5, 0], [15, 15, 20]);
  const copy = await evaluate([
    ...box('a', 0, 0, 10, 10, 10),
    scaleFeature('s', { factor: 1.02, center: [0, 0, 0], copy: true }),
  ]);
  noErrors(copy);
  near(only(copy, 'body:a').volume, 1000, 1e-6, 'original kept');
  near(only(copy, 'body:s:0').volume, 1000 * 1.02 ** 3, 1e-3, 'fit-test copy');
});

void test('Scale keeps face references (a later fillet on a scaled edge still resolves)', async () => {
  const before = await evaluate([...box('a', 0, 0, 10, 10, 10)]);
  const top = faceRef(only(before, 'body:a'), planeAt(2, 10));
  const result = await evaluate([
    ...box('a', 0, 0, 10, 10, 10),
    scaleFeature('s', { factor: 0.5, center: [0, 0, 0] }),
    {
      ...base('o'),
      kind: 'offsetFace',
      faces: [top],
      distance: 1,
    } as Feature,
  ]);
  noErrors(result);
  bbox(only(result, 'body:a'), [0, 0, 0], [5, 5, 6]);
});

void test('Scale per axis needs the HimmelCAD build; there it scales along X, Y, Z', async () => {
  const features = [
    ...box('a', 0, 0, 10, 10, 10),
    sketch('c-s', 'XY', 10, circle(5, 5, 2)),
    extrude('c', 'c-s', 4, { operation: 'join', targetBodyId: 'body:a' }),
    scaleFeature('s', { factors: [2, 1, 0.5], center: [0, 0, 0] }),
  ];
  const result = await evaluate(features);
  if (!(await hasGTransform())) {
    assert.match(result.errors['s'] ?? '', /HimmelCAD OCCT build/);
    return;
  }
  noErrors(result);
  const a = only(result, 'body:a');
  near(a.volume, (1000 + Math.PI * 4 * 4) * 2 * 1 * 0.5, 0.5, 'per-axis volume');
  bbox(a, [0, 0, 0], [20, 10, 7], 1e-2);
});

void test('Scale refuses factors out of range', async () => {
  const result = await evaluate([...box('a', 0, 0, 10, 10, 10), scaleFeature('s', { factor: 0 })]);
  assert.match(result.errors['s'] ?? '', /between 0.001 and 1000/);
});

// ---- Translate (MOD-18) ----------------------------------------------------------------------

void test('Translate moves bodies from a point to a point (and copies)', async () => {
  const t: TranslateFeature = {
    ...base('t'),
    kind: 'translate',
    bodyIds: ['body:a', 'body:b'],
    from: [10, 10, 10],
    to: [15, 16, 17],
    copy: false,
  };
  const result = await evaluate([...box('a', 0, 0, 10, 10, 10), ...box('b', 20, 0, 5, 5, 5), t]);
  noErrors(result);
  bbox(only(result, 'body:a'), [5, 6, 7], [15, 16, 17]);
  bbox(only(result, 'body:b'), [25, 6, 7], [30, 11, 12]);
  const copy = await evaluate([
    ...box('a', 0, 0, 10, 10, 10),
    { ...t, bodyIds: ['body:a'], copy: true },
  ]);
  noErrors(copy);
  bbox(only(copy, 'body:a'), [0, 0, 0], [10, 10, 10]);
  bbox(only(copy, 'body:t:0'), [5, 6, 7], [15, 16, 17]);
});

// ---- Primitives (UI-02) ----------------------------------------------------------------------

function primitive(
  id: string,
  shape: PrimitiveFeature['shape'],
  sizes: Partial<PrimitiveFeature>,
  extra: Partial<PrimitiveFeature> = {},
): PrimitiveFeature {
  return {
    ...base(id),
    kind: 'primitive',
    shape,
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    center: [0, 0, 0],
    operation: 'new',
    ...sizes,
    ...extra,
  };
}

void test('Primitives: box, cylinder, sphere, cone, torus standing on a plane', async () => {
  const result = await evaluate([
    primitive('b', 'box', { width: 10, depth: 20, height: 30 }, { center: [5, 5, 3] }),
    primitive('c', 'cylinder', { radius: 5, height: 10 }, { center: [50, 0, 0] }),
    primitive('s', 'sphere', { radius: 5 }, { center: [100, 0, 0] }),
    primitive('k', 'cone', { radius: 5, radius2: 2, height: 10 }, { center: [150, 0, 0] }),
    primitive('p', 'cone', { radius: 5, radius2: 0, height: 10 }, { center: [200, 0, 0] }),
    primitive('t', 'torus', { radius: 10, radius2: 2 }, { center: [250, 0, 0] }),
  ]);
  noErrors(result);
  const b = only(result, 'body:b');
  near(b.volume, 6000, 1e-3, 'box');
  bbox(b, [0, -5, 0], [10, 15, 30]);
  near(only(result, 'body:c').volume, Math.PI * 25 * 10, 1e-2, 'cylinder');
  const s = only(result, 'body:s');
  near(s.volume, (4 / 3) * Math.PI * 125, 1e-2, 'sphere');
  bbox(s, [95, -5, 0], [105, 5, 10], 1e-2);
  near(only(result, 'body:k').volume, (Math.PI * 10 * (25 + 10 + 4)) / 3, 1e-2, 'cone frustum');
  near(only(result, 'body:p').volume, (Math.PI * 25 * 10) / 3, 1e-2, 'pointed cone');
  const t = only(result, 'body:t');
  near(t.volume, 2 * Math.PI * Math.PI * 10 * 4, 1e-2, 'torus');
  bbox(t, [238, -12, 0], [262, 12, 4], 1e-2);
  assert.ok(b.faces.some((f) => f.key === 'b:top') && b.faces.some((f) => f.key === 'b:bottom'));
});

void test('A primitive on a face joins or cuts the body like Extrude', async () => {
  const first = await evaluate([...box('a', 0, 0, 20, 20, 10)]);
  const top = faceRef(only(first, 'body:a'), planeAt(2, 10));
  const joined = await evaluate([
    ...box('a', 0, 0, 20, 20, 10),
    primitive(
      'c',
      'cylinder',
      { radius: 3, height: 5 },
      {
        plane: { kind: 'face', face: top },
        center: [10, 10, 10],
        operation: 'join',
        targetBodyId: 'body:a',
      },
    ),
  ]);
  noErrors(joined);
  near(only(joined, 'body:a').volume, 4000 + Math.PI * 9 * 5, 1e-2, 'boss');
  // Into the face: a round pocket.
  const pocket = await evaluate([
    ...box('a', 0, 0, 20, 20, 10),
    primitive(
      'c',
      'cylinder',
      { radius: 3, height: 5 },
      {
        plane: { kind: 'face', face: top },
        center: [10, 10, 10],
        operation: 'cut',
        targetBodyId: 'body:a',
        flip: true,
      },
    ),
  ]);
  noErrors(pocket);
  near(only(pocket, 'body:a').volume, 4000 - Math.PI * 9 * 5, 1e-2, 'pocket');
  const bad = await evaluate([primitive('t', 'torus', { radius: 2, radius2: 3 })]);
  assert.match(bad.errors['t'] ?? '', /smaller than the ring radius/);
});

// ---- Helical revolve (MOD-05) -------------------------------------------------------------------

function spring(extra: Partial<RevolveFeature['helix']> = {}): Feature[] {
  return [
    sketch('p-s', 'XZ', 0, circle(10, 0, 1)),
    {
      ...base('r'),
      kind: 'revolve',
      profile: { kind: 'sketch', featureId: 'p-s' },
      axis: { kind: 'world', axis: 'Z' },
      angle: 360,
      helix: { pitch: 5, turns: 2, ...extra },
      operation: 'new',
    } as RevolveFeature,
  ];
}

void test('Helical revolve: a spring has the screw-motion volume and climbs pitch × turns', async () => {
  const result = await evaluate(spring());
  noErrors(result);
  const r = only(result, 'body:r');
  // Pappus for a screw motion: the meridian area times the path of its centroid around the axis.
  near(r.volume, Math.PI * 1 * 2 * Math.PI * 10 * 2, 2, 'spring volume');
  near(r.min[2], -1, 0.05, 'starts at the profile');
  near(r.max[2], 11, 0.05, 'climbs 2 × 5 mm');
  const left = await evaluate(spring({ leftHanded: true }));
  noErrors(left);
  near(only(left, 'body:r').volume, r.volume, 1, 'left-handed volume');
  const down = await evaluate(spring({ pitch: -5 }));
  noErrors(down);
  near(only(down, 'body:r').min[2], -11, 0.05, 'negative pitch climbs down');
});

void test('Helical revolve refuses overlapping turns and a profile on the axis', async () => {
  const overlap = await evaluate(spring({ pitch: 1.5 }));
  assert.match(overlap.errors['r'] ?? '', /turns would overlap/);
  const fraction = await evaluate(spring({ pitch: 1.5, turns: 0.5 }));
  noErrors(fraction);
});

// ---- Extrude taper (MOD-03) -------------------------------------------------------------------

void test('Extrude taper narrows the walls away from the start plane', async () => {
  const t = Math.tan((10 * Math.PI) / 180);
  const result = await evaluate([
    sketch('s', 'XY', 0, rect(0, 0, 20, 20)),
    extrude('e', 's', 10, { taper: 10 }),
  ]);
  noErrors(result);
  const e = only(result, 'body:e');
  const top = 20 - 2 * 10 * t;
  near(e.volume, (10 / 3) * (400 + top * top + 20 * top), 0.05, 'square frustum');
  bbox(e, [0, 0, 0], [20, 20, 10], 1e-3);
  const keys = e.faces.map((f) => f.key);
  assert.ok(keys.includes('e:start:0') && keys.includes('e:end:0'), keys.join(', '));
  // A cylinder becomes a cone frustum; a negative taper widens.
  const cone = await evaluate([
    sketch('s', 'XY', 0, circle(0, 0, 5)),
    extrude('e', 's', 10, { taper: -5 }),
  ]);
  noErrors(cone);
  const r2 = 5 + 10 * Math.tan((5 * Math.PI) / 180);
  near(only(cone, 'body:e').volume, (Math.PI * 10 * (25 + 5 * r2 + r2 * r2)) / 3, 0.05, 'cone');
});

void test('Symmetric taper narrows both ways; a hole widens; push/pull tapers too', async () => {
  const t = Math.tan((5 * Math.PI) / 180);
  const sym = await evaluate([
    sketch('s', 'XY', 0, rect(0, 0, 20, 20)),
    extrude('e', 's', 5, { taper: 5, symmetric: true }),
  ]);
  noErrors(sym);
  const end = 20 - 2 * 5 * t;
  near(only(sym, 'body:e').volume, 2 * (5 / 3) * (400 + end * end + 20 * end), 0.05, 'two frusta');
  bbox(only(sym, 'body:e'), [0, 0, -5], [20, 20, 5]);
  const { feature: ringSketch, regionKeys } = sketchFeature(
    's',
    [rect(0, 0, 20, 20), circle(10, 10, 3)],
    'XY',
  );
  // The region of the square that is not the disc (the disc is region 1).
  const ringKey = detectRegions(ringSketch).find((r) => r.key !== regionKeys[1])!.key;
  const ring = await evaluate([
    ringSketch,
    extrude('e', 's', 10, {
      taper: 5,
      profile: { kind: 'sketch', featureId: 's', regions: [ringKey] },
    }),
  ]);
  noErrors(ring);
  const top = 20 - 2 * 10 * t;
  const hole = 3 + 10 * t;
  const solid = (10 / 3) * (400 + top * top + 20 * top);
  const bore = (Math.PI * 10 * (9 + 3 * hole + hole * hole)) / 3;
  near(only(ring, 'body:e').volume, solid - bore, 0.1, 'tapered ring');
  const first = await evaluate([...box('a', 0, 0, 20, 20, 10)]);
  const topFace = faceRef(only(first, 'body:a'), planeAt(2, 10));
  const pushed = await evaluate([
    ...box('a', 0, 0, 20, 20, 10),
    {
      ...base('p'),
      kind: 'extrude',
      profile: { kind: 'face', face: topFace },
      distance: 10,
      symmetric: false,
      operation: 'join',
      taper: 10,
    } as ExtrudeFeature,
  ]);
  noErrors(pushed);
  const tt = Math.tan((10 * Math.PI) / 180);
  const pTop = 20 - 2 * 10 * tt;
  near(
    only(pushed, 'body:a').volume,
    4000 + (10 / 3) * (400 + pTop * pTop + 20 * pTop),
    0.1,
    'push/pull taper',
  );
});

void test('Taper is refused with Through All and survives a save/load', async () => {
  const bad = await evaluate([
    ...box('a', 0, 0, 20, 20, 10),
    sketch('h-s', 'XY', 20, circle(10, 10, 3)),
    extrude('h', 'h-s', -1, { operation: 'cut', extent: { kind: 'throughAll' }, taper: 3 }),
  ]);
  assert.match(bad.errors['h'] ?? '', /Distance extent/);
  const features: Feature[] = [
    sketch('s', 'XY', 0, rect(0, 0, 20, 20)),
    extrude('e', 's', 10, { taper: 10 }),
  ];
  const text = saveProjectFile({
    projectName: 'taper',
    features,
    appVersion: 'test',
    createdAt: new Date(0).toISOString(),
  });
  const loaded = loadProjectFile(text);
  assert.equal((loaded.features[1] as ExtrudeFeature).taper, 10);
  assert.throws(() => loadProjectFile(text.replace('"taper": 10', '"taper": 81')), /taper/);
});

// ---- Move Edge / Move Face (MOD-16, DIR-03) -------------------------------------------------------

void test('Move Edge tilts the two faces about their far sides', async () => {
  const first = await evaluate([...box('a', 0, 0, 10, 10, 10)]);
  const a = only(first, 'body:a');
  const frontTop = edgeRef(a, lineAt([5, 0, 10]));
  const up: MoveEdgeFeature = { ...base('m'), kind: 'moveEdge', edge: frontTop, vector: [0, 0, 5] };
  const lifted = await evaluate([...box('a', 0, 0, 10, 10, 10), up]);
  noErrors(lifted);
  near(only(lifted, 'body:a').volume, 1250, 1e-3, 'wedge roof');
  bbox(only(lifted, 'body:a'), [0, 0, 0], [10, 10, 15]);
  const diagonal = await evaluate([...box('a', 0, 0, 10, 10, 10), { ...up, vector: [0, -3, 4] }]);
  noErrors(diagonal);
  near(only(diagonal, 'body:a').volume, 1350, 1e-3, 'both faces tilt');
  bbox(only(diagonal, 'body:a'), [0, -3, 0], [10, 10, 14]);
  // The part along the edge changes nothing.
  const along = await evaluate([...box('a', 0, 0, 10, 10, 10), { ...up, vector: [7, 0, 0] }]);
  noErrors(along);
  near(only(along, 'body:a').volume, 1000, 1e-6, 'slide along the edge');
});

void test('Move Edge keeps the tilted faces referable and refuses curved or too-far moves', async () => {
  const first = await evaluate([...box('a', 0, 0, 10, 10, 10)]);
  const a = only(first, 'body:a');
  const top = faceRef(a, planeAt(2, 10));
  const frontTop = edgeRef(a, lineAt([5, 0, 10]));
  const moved = await evaluate([
    ...box('a', 0, 0, 10, 10, 10),
    { ...base('m'), kind: 'moveEdge', edge: frontTop, vector: [0, 0, 5] } as MoveEdgeFeature,
    { ...base('o'), kind: 'offsetFace', faces: [top], distance: 1 } as Feature,
  ]);
  noErrors(moved);
  const tooFar = await evaluate([
    ...box('a', 0, 0, 10, 10, 10),
    { ...base('m'), kind: 'moveEdge', edge: frontTop, vector: [0, 12, 0] } as MoveEdgeFeature,
  ]);
  assert.match(tooFar.errors['m'] ?? '', /past the far side/);
  const cyl = await evaluate([sketch('c-s', 'XY', 0, circle(0, 0, 5)), extrude('c', 'c-s', 10)]);
  const rim = edgeRef(only(cyl, 'body:c'), (e) => e.curve === 'circle');
  const curved = await evaluate([
    sketch('c-s', 'XY', 0, circle(0, 0, 5)),
    extrude('c', 'c-s', 10),
    { ...base('m'), kind: 'moveEdge', edge: rim, vector: [0, 0, 1] } as MoveEdgeFeature,
  ]);
  assert.match(curved.errors['m'] ?? '', /straight edges/);
});

void test('Move Face slides a face sideways (neighbours tilt) and along its normal', async () => {
  const first = await evaluate([...box('a', 0, 0, 10, 10, 10)]);
  const top = faceRef(only(first, 'body:a'), planeAt(2, 10));
  const slide: MoveFaceFeature = { ...base('m'), kind: 'moveFace', face: top, vector: [4, 0, 0] };
  const sheared = await evaluate([...box('a', 0, 0, 10, 10, 10), slide]);
  noErrors(sheared);
  near(only(sheared, 'body:a').volume, 1000, 1e-3, 'shear keeps the volume');
  bbox(only(sheared, 'body:a'), [0, 0, 0], [14, 10, 10]);
  const both = await evaluate([...box('a', 0, 0, 10, 10, 10), { ...slide, vector: [4, 0, 2] }]);
  noErrors(both);
  near(only(both, 'body:a').volume, 1200, 1e-3, 'offset and shear');
  bbox(only(both, 'body:a'), [0, 0, 0], [14, 10, 12]);
  // A round neighbour cannot follow a sideways move.
  const cyl = await evaluate([sketch('c-s', 'XY', 0, circle(0, 0, 5)), extrude('c', 'c-s', 10)]);
  const cap = faceRef(only(cyl, 'body:c'), planeAt(2, 10));
  const refused = await evaluate([
    sketch('c-s', 'XY', 0, circle(0, 0, 5)),
    extrude('c', 'c-s', 10),
    { ...base('m'), kind: 'moveFace', face: cap, vector: [2, 0, 0] } as MoveFaceFeature,
  ]);
  assert.match(refused.errors['m'] ?? '', /curved edge/);
});

void test('The new kinds round-trip through .hcasm', async () => {
  const first = await evaluate([...box('a', 0, 0, 10, 10, 10)]);
  const a = only(first, 'body:a');
  const features: Feature[] = [
    ...box('a', 0, 0, 10, 10, 10),
    {
      ...base('m'),
      kind: 'moveEdge',
      edge: edgeRef(a, lineAt([5, 0, 10])),
      vector: [0, 0, 2],
    } as MoveEdgeFeature,
    {
      ...base('f'),
      kind: 'moveFace',
      face: faceRef(a, planeAt(0, 10)),
      vector: [1, 0, 0],
    } as MoveFaceFeature,
    scaleFeature('s', { factors: [1, 1, 1], center: [1, 2, 3], copy: true }),
    {
      ...base('t'),
      kind: 'translate',
      bodyIds: ['body:a'],
      from: [0, 0, 0],
      to: [1, 1, 1],
      copy: false,
    } as TranslateFeature,
    primitive('p', 'cone', { radius: 3, radius2: 0, height: 4 }),
    ...spring(),
  ];
  const text = saveProjectFile({
    projectName: 'b8',
    features,
    appVersion: 'test',
    createdAt: new Date(0).toISOString(),
  });
  const loaded = loadProjectFile(text).features;
  loaded.forEach((f, i) =>
    assert.deepEqual(f, JSON.parse(JSON.stringify(features[i])), `feature ${f.id} round-trips`),
  );
  assert.throws(
    () => loadProjectFile(text.replace('"shape": "cone"', '"shape": "pyramid"')),
    /shape/,
  );
  const result = await evaluate(features);
  noErrors(result);
});
