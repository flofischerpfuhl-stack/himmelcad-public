import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ExtrudeFeature,
  Feature,
  SketchRectFeature,
} from '../../renderer/src/model/mockDocument.js';
import { createDemoDocument, evaluate } from '../../renderer/src/model/mockDocument.js';

void test('demo document evaluates to two bodies with the documented dimensions', () => {
  const result = evaluate(createDemoDocument());
  assert.equal(Object.keys(result.errors).length, 0);
  assert.equal(result.bodies.length, 2);

  const plate = result.bodies.find((b) => b.name === 'Base plate');
  const upright = result.bodies.find((b) => b.name === 'Upright');
  assert.ok(plate);
  assert.ok(upright);

  assert.deepEqual(plate.min, [0, 0, 0]);
  assert.deepEqual(plate.max, [80, 50, 6]);

  assert.deepEqual(upright.min, [0, 0, 6]);
  // Thickened by the face-extrude from 6 to 8 mm along Y.
  assert.deepEqual(upright.max, [80, 8, 46]);
});

void test('editing an early sketch width re-dimensions the dependent body and keeps its id', () => {
  const features = createDemoDocument();
  const before = evaluate(features);
  const plateBefore = before.bodies.find((b) => b.name === 'Base plate')!;

  const edited: Feature[] = features.map((f) =>
    f.id === 'feature-sketch-1' ? ({ ...f, width: 120 } as SketchRectFeature) : f,
  );
  const after = evaluate(edited);
  const plateAfter = after.bodies.find((b) => b.name === 'Base plate')!;

  assert.equal(plateAfter.id, plateBefore.id);
  assert.deepEqual(plateAfter.max, [120, 50, 6]);
});

void test('deleting a sketch yields a missing-reference error on its dependent extrude', () => {
  const features = createDemoDocument().filter((f) => f.id !== 'feature-sketch-1');
  const result = evaluate(features);

  assert.match(result.errors['feature-extrude-1'] ?? '', /Missing reference/);
  // The upright (fed by sketch 2, unaffected) still evaluates fine.
  assert.equal(
    result.bodies.some((b) => b.name === 'Upright'),
    true,
  );
  assert.equal(
    result.bodies.some((b) => b.name === 'Base plate'),
    false,
  );
});

function buildSingleBoxDocument(distance: number): Feature[] {
  const sketch: SketchRectFeature = {
    id: 'sketch-1',
    name: 'Sketch 1',
    suppressed: false,
    kind: 'sketchRect',
    plane: 'XY',
    offset: 0,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  };
  const extrude: ExtrudeFeature = {
    id: 'extrude-1',
    name: 'Extrude 1',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketch.id },
    distance,
    operation: 'new',
  };
  return [sketch, extrude];
}

void test('face extrude grows a body along the face normal', () => {
  const base = buildSingleBoxDocument(5);
  const bodyId = 'body:extrude-1';
  const grow: ExtrudeFeature = {
    id: 'extrude-2',
    name: 'Extrude 2',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'face', bodyId, side: '+Z' },
    distance: 3,
    operation: 'join',
  };
  const result = evaluate([...base, grow]);
  assert.equal(Object.keys(result.errors).length, 0);
  const body = result.bodies.find((b) => b.id === bodyId)!;
  assert.equal(body.max[2] - body.min[2], 8);
});

void test('face extrude shrinks a body along the face normal', () => {
  const base = buildSingleBoxDocument(5);
  const bodyId = 'body:extrude-1';
  const shrink: ExtrudeFeature = {
    id: 'extrude-2',
    name: 'Extrude 2',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'face', bodyId, side: '+Z' },
    distance: -4,
    operation: 'join',
  };
  const result = evaluate([...base, shrink]);
  assert.equal(Object.keys(result.errors).length, 0);
  const body = result.bodies.find((b) => b.id === bodyId)!;
  assert.equal(Math.round((body.max[2] - body.min[2]) * 100) / 100, 1);
});

void test('face extrude reports an error instead of clamping when it would invert the body', () => {
  const base = buildSingleBoxDocument(5);
  const bodyId = 'body:extrude-1';
  const invert: ExtrudeFeature = {
    id: 'extrude-2',
    name: 'Extrude 2',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'face', bodyId, side: '+Z' },
    distance: -4.95,
    operation: 'join',
  };
  const result = evaluate([...base, invert]);
  assert.match(result.errors['extrude-2'] ?? '', /below the 0\.1 mm minimum/);
  // The body is left exactly as it was before the failed feature.
  const body = result.bodies.find((b) => b.id === bodyId)!;
  assert.equal(body.max[2] - body.min[2], 5);
});
