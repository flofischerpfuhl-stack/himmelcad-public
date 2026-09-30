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
  pointInsideBody,
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

/** The old brute-force parity test (every triangle), kept as the reference. */
function bruteInside(
  body: Awaited<ReturnType<typeof demo>>['bodies'][number],
  p: [number, number, number],
): boolean {
  if (p.some((v, i) => v < body.min[i]! - 1e-6 || v > body.max[i]! + 1e-6)) return false;
  const len = Math.hypot(0.5773, 0.5774, 0.5775);
  const d = [0.5773 / len, 0.5774 / len, 0.5775 / len];
  const { positions: P, indices: I } = body.mesh;
  let hits = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = [P[I[t]! * 3]!, P[I[t]! * 3 + 1]!, P[I[t]! * 3 + 2]!];
    const b = [P[I[t + 1]! * 3]!, P[I[t + 1]! * 3 + 1]!, P[I[t + 1]! * 3 + 2]!];
    const c = [P[I[t + 2]! * 3]!, P[I[t + 2]! * 3 + 1]!, P[I[t + 2]! * 3 + 2]!];
    const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const pv = [
      d[1]! * e2[2]! - d[2]! * e2[1]!,
      d[2]! * e2[0]! - d[0]! * e2[2]!,
      d[0]! * e2[1]! - d[1]! * e2[0]!,
    ];
    const det = e1[0]! * pv[0]! + e1[1]! * pv[1]! + e1[2]! * pv[2]!;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const s = [p[0] - a[0]!, p[1] - a[1]!, p[2] - a[2]!];
    const u = (s[0]! * pv[0]! + s[1]! * pv[1]! + s[2]! * pv[2]!) * inv;
    if (u < 0 || u > 1) continue;
    const q = [
      s[1]! * e1[2]! - s[2]! * e1[1]!,
      s[2]! * e1[0]! - s[0]! * e1[2]!,
      s[0]! * e1[1]! - s[1]! * e1[0]!,
    ];
    const v = (d[0]! * q[0]! + d[1]! * q[1]! + d[2]! * q[2]!) * inv;
    if (v < 0 || u + v > 1) continue;
    if ((e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) * inv > 1e-9) hits += 1;
  }
  return hits % 2 === 1;
}

void test('point-in-body parity with the triangle grid equals the brute-force ray test', async () => {
  const result = await demo();
  const body = result.bodies[0]!;
  let inside = 0;
  let checked = 0;
  // A lattice through the box (incl. the hole, the fillet and points on faces), then mesh vertices.
  for (let i = -1; i <= 21; i += 1) {
    for (let j = -1; j <= 13; j += 1) {
      for (let k = -1; k <= 13; k += 1) {
        const p: [number, number, number] = [
          body.min[0] + ((body.max[0] - body.min[0]) * i) / 20,
          body.min[1] + ((body.max[1] - body.min[1]) * j) / 12,
          body.min[2] + ((body.max[2] - body.min[2]) * k) / 12,
        ];
        const expected = bruteInside(body, p);
        assert.equal(pointInsideBody(body, p), expected, `point ${p.join(', ')}`);
        if (expected) inside += 1;
        checked += 1;
      }
    }
  }
  const P = body.mesh.positions;
  for (let v = 0; v < P.length; v += 3) {
    const p: [number, number, number] = [P[v]!, P[v + 1]!, P[v + 2]!];
    assert.equal(pointInsideBody(body, p), bruteInside(body, p), `vertex ${p.join(', ')}`);
    checked += 1;
  }
  assert.ok(inside > 200 && checked > 5000, `${inside} of ${checked} inside`);
  // The plate is solid, the air above it is not.
  assert.equal(pointInsideBody(body, [10, 10, 3]), true);
  assert.equal(pointInsideBody(body, [10, 10, 20]), false);
});
