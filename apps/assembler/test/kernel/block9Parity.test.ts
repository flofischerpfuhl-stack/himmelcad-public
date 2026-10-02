/**
 * Block 9 parity on the real OCCT kernel (`assembler/GAP-INVENTORY.md`):
 * MOD-23 Replace Face (planar and cylindrical replacing faces, kept keys,
 * refusals). Volumes and boxes against hand calculations.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { faceSignatureOf } from '../../renderer/src/foundation/geometry-kernel/naming.js';
import type {
  Body,
  EvaluationResult,
} from '../../renderer/src/foundation/geometry-kernel/types.js';
import type {
  ExtrudeFeature,
  FaceRef,
  Feature,
  Plane,
} from '../../renderer/src/foundation/document/document.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
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
