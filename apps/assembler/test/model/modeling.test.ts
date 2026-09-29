import assert from 'node:assert/strict';
import test from 'node:test';

import { createDemoDocument } from '../../renderer/src/model/document.js';
import {
  autoExtrudeOperation,
  consumedSketchIds,
  defaultSectionOffset,
  findSketchContact,
  isSketchVisible,
  measureSelection,
  sectionRange,
  visibleBounds,
} from '../../renderer/src/model/modeling.js';
import { loadNodeKernel } from '../kernel/nodeKernel.js';

const PLATE = 'body:feature-extrude-1';

async function demo() {
  const { evaluator } = await loadNodeKernel();
  return evaluator.evaluate(createDemoDocument());
}

void test('automatic extrude operation: out of a face joins, into it cuts, free is new', () => {
  const top = { bodyId: 'b', faceKey: 'f', sign: 1 as const };
  const bottom = { bodyId: 'b', faceKey: 'g', sign: -1 as const };
  assert.equal(autoExtrudeOperation(null, 10), 'new');
  assert.equal(autoExtrudeOperation(null, -10), 'new');
  assert.equal(autoExtrudeOperation(top, 5), 'join');
  assert.equal(autoExtrudeOperation(top, -5), 'cut');
  assert.equal(autoExtrudeOperation(bottom, 5), 'cut');
  assert.equal(autoExtrudeOperation(bottom, -5), 'join');
  assert.equal(autoExtrudeOperation(top, 0), 'join');
  assert.equal(autoExtrudeOperation(bottom, 0), 'cut');
});

void test('sketch contact: the demo hole sketch lies on the plate top face', async () => {
  const result = await demo();
  const contact = findSketchContact(result, 'feature-sketch-4');
  assert.deepEqual(contact, { bodyId: PLATE, faceKey: 'feature-extrude-1:end:0', sign: 1 });
  // Sketch 1 (XY, z = 0) touches the plate's bottom face, whose normal is opposite.
  assert.equal(findSketchContact(result, 'feature-sketch-1')?.sign, -1);
});

void test('sketches used by an extrude are hidden by default; an explicit choice wins', () => {
  const consumed = consumedSketchIds(createDemoDocument());
  assert.deepEqual([...consumed].sort(), [
    'feature-sketch-1',
    'feature-sketch-2',
    'feature-sketch-4',
  ]);
  assert.equal(isSketchVisible('feature-sketch-1', consumed, {}), false);
  assert.equal(isSketchVisible('feature-sketch-1', consumed, { 'feature-sketch-1': true }), true);
  assert.equal(isSketchVisible('free', consumed, {}), true);
  assert.equal(isSketchVisible('free', consumed, { free: false }), false);
  const suppressed = createDemoDocument().map((f) =>
    f.id === 'feature-extrude-1' ? { ...f, suppressed: true } : f,
  );
  assert.equal(consumedSketchIds(suppressed).has('feature-sketch-1'), false);
});

void test('section defaults: centre of the visible bounds; range with margin', async () => {
  const result = await demo();
  const bounds = visibleBounds(result.bodies, [], null);
  assert.ok(bounds);
  assert.equal(defaultSectionOffset(bounds, 'X'), 40);
  assert.equal(defaultSectionOffset(bounds, 'Y'), 25);
  assert.equal(defaultSectionOffset(bounds, 'Z'), 23);
  assert.equal(visibleBounds(result.bodies, [PLATE], null), null);
  assert.equal(visibleBounds(result.bodies, [], ['nothing']), null);
  assert.equal(defaultSectionOffset(null, 'Z'), 0);
  const [lo, hi] = sectionRange(bounds, 'Z');
  assert.ok(lo < 0 && hi > 46);
});

void test('measure: body size and volume, hole diameter, arc radius, edge length, face distance', async () => {
  const result = await demo();
  const body = result.bodies[0]!;
  assert.equal(
    measureSelection(result, [{ kind: 'body', bodyId: PLATE }]),
    'Bracket: 80 × 50 × 46 mm · 49,705 mm³',
  );
  const hole = body.edges.find((e) => e.curve === 'circle' && Math.abs(e.radius! - 3) < 1e-9)!;
  assert.equal(
    measureSelection(result, [{ kind: 'edge', bodyId: PLATE, edgeKey: hole.key }]),
    'Circle: Ø 6 mm · length 18.85 mm',
  );
  const arc = body.edges.find((e) => e.curve === 'circle' && Math.abs(e.radius! - 4) < 1e-9)!;
  assert.match(
    measureSelection(result, [{ kind: 'edge', bodyId: PLATE, edgeKey: arc.key }]) ?? '',
    /^Arc: R 4 mm/,
  );
  const line = body.edges.find((e) => e.curve === 'line' && Math.abs(e.length - 80) < 1e-9)!;
  assert.equal(
    measureSelection(result, [{ kind: 'edge', bodyId: PLATE, edgeKey: line.key }]),
    'Edge length: 80 mm',
  );
  assert.equal(
    measureSelection(result, [
      { kind: 'face', bodyId: PLATE, faceKey: 'feature-extrude-1:start:0' },
      { kind: 'face', bodyId: PLATE, faceKey: 'feature-extrude-1:end:0' },
    ]),
    'Distance: 6 mm',
  );
  assert.equal(
    measureSelection(result, [
      { kind: 'face', bodyId: PLATE, faceKey: 'feature-extrude-1:start:0' },
      { kind: 'face', bodyId: PLATE, faceKey: 'feature-extrude-2:side:0:l1' },
    ]),
    'Distance: faces are not parallel',
  );
  assert.equal(measureSelection(result, []), null);
});
