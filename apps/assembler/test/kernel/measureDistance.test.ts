import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtrudeFeature, Feature } from '../../renderer/src/model/document.js';
import { rect, sketchFeature } from '../sketch/fixtures.js';
import { loadNodeKernel } from './nodeKernel.js';

async function kernel() {
  const { evaluator } = await loadNodeKernel();
  assert.ok(evaluator.measureDistance);
  return {
    evaluator: { ...evaluator, measureDistance: evaluator.measureDistance.bind(evaluator) },
  };
}

function box(id: string, x: number): Feature[] {
  const { feature } = sketchFeature(`s-${id}`, [rect(x, 0, 10, 10)]);
  const extrude: ExtrudeFeature = {
    id,
    name: id,
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: feature.id },
    distance: 10,
    symmetric: false,
    operation: 'new',
  };
  return [feature, extrude];
}

const features = [...box('a', 0), ...box('b', 20)];

void test('measureDistance: exact minimum distance between two bodies (BRepExtrema)', async () => {
  const { evaluator } = await kernel();
  const result = await evaluator.measureDistance(
    features,
    { kind: 'body', bodyId: 'body:a' },
    { kind: 'body', bodyId: 'body:b' },
  );
  assert.ok(Math.abs(result.distance - 10) < 1e-9, `distance ${result.distance}`);
  assert.ok(Math.abs(result.pointA[0] - 10) < 1e-9);
  assert.ok(Math.abs(result.pointB[0] - 20) < 1e-9);
});

void test('measureDistance: faces, edges and a point', async () => {
  const { evaluator } = await kernel();
  const evaluation = await evaluator.evaluate(features);
  const a = evaluation.bodies.find((b) => b.id === 'body:a')!;
  const b = evaluation.bodies.find((x) => x.id === 'body:b')!;
  const facing = (body: typeof a, sign: number) =>
    body.faces.find((f) => f.normal && Math.abs(f.normal[0] - sign) < 1e-9)!;
  const face = await evaluator.measureDistance(
    features,
    { kind: 'face', bodyId: 'body:a', faceKey: facing(a, 1).key },
    { kind: 'face', bodyId: 'body:b', faceKey: facing(b, -1).key },
  );
  assert.ok(Math.abs(face.distance - 10) < 1e-9);
  // A vertical edge of box b at x = 20 against a point above box a.
  const edge = b.edges.find(
    (e) =>
      e.direction &&
      Math.abs(Math.abs(e.direction[2]) - 1) < 1e-9 &&
      Math.abs(e.midpoint[0] - 20) < 1e-9,
  )!;
  const point = await evaluator.measureDistance(
    features,
    { kind: 'point', point: [0, 0, 20] },
    { kind: 'body', bodyId: 'body:a' },
  );
  assert.ok(Math.abs(point.distance - 10) < 1e-9, `point ${point.distance}`);
  const edgeToBody = await evaluator.measureDistance(
    features,
    { kind: 'edge', bodyId: 'body:b', edgeKey: edge.key },
    { kind: 'body', bodyId: 'body:a' },
  );
  assert.ok(Math.abs(edgeToBody.distance - 10) < 1e-9);
});

void test('measureDistance: a missing reference fails with a readable message', async () => {
  const { evaluator } = await kernel();
  await assert.rejects(
    evaluator.measureDistance(
      features,
      { kind: 'body', bodyId: 'body:a' },
      { kind: 'face', bodyId: 'body:a', faceKey: 'nope' },
    ),
    /Missing face/,
  );
});
