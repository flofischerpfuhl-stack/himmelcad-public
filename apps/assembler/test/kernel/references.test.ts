/**
 * Adversarial stable-reference cases for reference scheme v2 (OCCT history
 * first, surface identity as fallback; `kernel/naming.ts`,
 * `assembler/KERNEL-SPIKE.md` "Reference scheme v2"):
 *
 * - a topology change that splits a referenced face: the piece at the
 *   reference's recorded position keeps it (with a warning), or the
 *   reference is reported ambiguous — never a silent pick;
 * - a fillet on an edge whose adjacent face is offset (before and after);
 * - a pattern count change with a fillet on instance 2;
 * - a revolve angle change with references on the cap faces;
 * - a sketch region redrawn (entity ids change): best-effort rebind by the
 *   unchanged edges/geometry plus warnings;
 * - v1 `#n` keys of coplanar faces of different features.
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
import type { EdgeRef, FaceRef, Feature } from '../../renderer/src/foundation/document/document.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import type {
  PatternFeature,
  RevolveFeature,
} from '../../renderer/src/modules/modeling/features.js';
import type { OffsetFaceFeature } from '../../renderer/src/modules/direct-edit/kinds.js';
import { detectRegions } from '../../renderer/src/foundation/sketch-solver/regions.js';
import { extrude, fillet, sketch } from '../bench/parts.js';
import { loadNodeKernel } from './nodeKernel.js';

async function evaluate(features: Feature[]): Promise<EvaluationResult> {
  const { evaluator } = await loadNodeKernel();
  return evaluator.evaluate(features);
}

function only(result: EvaluationResult, id: string): Body {
  const body = result.bodies.find((b) => b.id === id);
  assert.ok(body, `body ${id} (errors ${JSON.stringify(result.errors)})`);
  return body;
}

function faceRefOf(body: Body, key: string): FaceRef {
  const face = body.faces.find((f) => f.key === key);
  assert.ok(face, `face ${key} on ${body.id}: ${body.faces.map((f) => f.key).join(', ')}`);
  return { bodyId: body.id, key: face.key, signature: faceSignatureOf(face) };
}

function edgeRefOf(body: Body, key: string): EdgeRef {
  const edge = body.edges.find((e) => e.key === key);
  assert.ok(edge, `edge ${key} on ${body.id}: ${body.edges.map((e) => e.key).join(', ')}`);
  return { bodyId: body.id, key: edge.key, signature: edgeSignatureOf(edge) };
}

const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: expected ${b}, got ${a}`);

const base = (id: string) => ({ id, name: id, suppressed: false });

// ---- split of a referenced face --------------------------------------------------------

/** Box 40 × 20 × 10; a slot cut across the top (x = x0..x1, depth 2) splits the top face. */
function slotted(slot: [number, number] | null): Feature[] {
  const out: Feature[] = [
    sketch('s', 'XY', 0, { kind: 'rectangle', x: 0, y: 0, width: 40, height: 20 }),
    extrude('b', 's', 10),
  ];
  if (slot) {
    out.push(
      sketch('slot-s', 'XY', 8, {
        kind: 'rectangle',
        x: slot[0],
        y: -1,
        width: slot[1] - slot[0],
        height: 22,
      }),
      extrude('slot', 'slot-s', 5, { operation: 'cut', targetBodyId: 'body:b' }),
    );
  }
  return out;
}

void test('split face: the piece at the recorded position keeps the reference, with a warning', async () => {
  // The reference is taken on the whole top face (centroid x = 20).
  const whole = only(await evaluate(slotted(null)), 'body:b');
  const top = faceRefOf(whole, 'b:end:0');
  const hole = (features: Feature[]): Feature[] => [
    ...features,
    {
      ...sketch('h-s', 'XY', 0, { kind: 'circle', cx: 10, cy: 10, radius: 2 }),
      plane: { kind: 'face', face: top },
    },
    extrude('h', 'h-s', -10, { operation: 'cut', targetBodyId: 'body:b' }),
  ];
  // Slot at x = 30..32: the recorded centre (20, 10, 10) lies on the left piece.
  const kept = await evaluate(hole(slotted([30, 32])));
  assert.deepEqual(kept.errors, {});
  assert.match(
    kept.warnings['h-s'] ?? '',
    /was split into 2 faces; the piece at its recorded position keeps the reference/,
  );
  const body = only(kept, 'body:b');
  near(body.volume, 40 * 20 * 10 - 2 * 20 * 2 - Math.PI * 4 * 10, 1e-3, 'slot and hole cut');
  // Before the slot existed there was nothing to warn about.
  assert.deepEqual((await evaluate(hole(slotted(null)))).warnings, {});
});

void test('split face: a recorded position between the pieces is an ambiguity error, not a guess', async () => {
  const whole = only(await evaluate(slotted(null)), 'body:b');
  const top = faceRefOf(whole, 'b:end:0');
  // Slot at x = 19..21: the recorded centre x = 20 lies in the gap, equally far from both pieces.
  const result = await evaluate([
    ...slotted([19, 21]),
    {
      ...sketch('h-s', 'XY', 0, { kind: 'circle', cx: 10, cy: 10, radius: 2 }),
      plane: { kind: 'face', face: top },
    },
    extrude('h', 'h-s', -10, { operation: 'cut', targetBodyId: 'body:b' }),
  ]);
  assert.match(
    result.errors['h-s'] ?? '',
    /Ambiguous reference: face "b:end:0" was split into 2 faces — re-select the face/,
  );
  assert.match(result.errors.h ?? '', /Missing reference: sketch|no closed profile/);
});

// ---- fillet next to an offset face -----------------------------------------------------

void test('fillet on an edge whose adjacent face is offset — before or after the fillet', async () => {
  const box = [
    sketch('s', 'XY', 0, { kind: 'rectangle', x: 0, y: 0, width: 40, height: 20 }),
    extrude('b', 's', 10),
  ];
  const plain = only(await evaluate(box), 'body:b');
  const front = faceRefOf(plain, 'b:side:0:l1'); // y = 0
  const edge = edgeRefOf(plain, 'b:end:0|b:side:0:l1'); // top front edge
  const round = fillet('f', [edge], 3);
  const offset: OffsetFaceFeature = {
    ...base('o'),
    kind: 'offsetFace',
    faces: [front],
    distance: 2,
  };
  const cornerLoss = (9 - (Math.PI * 9) / 4) * 40;

  // Fillet first, then the front face is pushed out by 2: the offset follows the face by key.
  const after = await evaluate([...box, round, offset]);
  assert.deepEqual(after.errors, {});
  assert.deepEqual(after.warnings, {});
  const a = only(after, 'body:b');
  assert.ok(a.faces.some((f) => f.key === 'f:round:0' && f.surface === 'cylinder'));
  assert.ok(a.faces.some((f) => f.key === 'b:side:0:l1' && f.centroid[1] < -1.9));
  near(
    a.volume,
    40 * 20 * 10 - cornerLoss + 40 * 7 * 2,
    1e-3,
    'fillet then offset (front face 7 mm high)',
  );
  assert.equal(a.valid, true);

  // The offset inserted before the fillet: the edge keeps its key (top merges with the slab top).
  const before = await evaluate([...box, offset, round]);
  assert.deepEqual(before.errors, {});
  assert.deepEqual(before.warnings, {}, 'resolved by key, no geometric re-bind');
  const b = only(before, 'body:b');
  near(b.volume, 40 * 22 * 10 - cornerLoss, 1e-3, 'offset then fillet');
  assert.ok(b.faces.some((f) => f.key === 'f:round:0'));
  near(b.min[1], -2, 1e-6, 'front face moved out');
});

// ---- pattern count change ----------------------------------------------------------------

void test('pattern count change with a fillet on instance 2', async () => {
  const pattern = (count: number): Feature[] => [
    sketch('s', 'XY', 0, { kind: 'rectangle', x: 0, y: 0, width: 10, height: 10 }),
    extrude('b', 's', 10),
    {
      ...base('pat'),
      kind: 'pattern',
      bodyIds: ['body:b'],
      pattern: { kind: 'linear', direction: { kind: 'world', axis: 'X' }, count, spacing: 20 },
    } satisfies PatternFeature,
  ];
  const three = await evaluate(pattern(3));
  const second = only(three, 'body:pat:2'); // instance 3 (k = 2); instance 2 is body:pat:1
  const instance2 = only(three, 'body:pat:1');
  assert.ok(second && instance2);
  const edge = edgeRefOf(instance2, 'b:end:0|b:side:0:l1');
  const round = fillet('f', [edge], 2);
  const loss = (4 - Math.PI) * 10;

  for (const count of [3, 5]) {
    const result = await evaluate([...pattern(count), round]);
    assert.deepEqual(result.errors, {}, `count ${count}`);
    assert.deepEqual(result.warnings, {}, `count ${count}: by key`);
    near(
      only(result, 'body:pat:1').volume,
      1000 - loss,
      1e-3,
      `instance 2 filleted (count ${count})`,
    );
    near(only(result, 'body:b').volume, 1000, 1e-6, 'the source is untouched');
    near(only(result, 'body:pat:1').min[0], 20, 1e-6, 'still the second instance');
  }
  const fewer = await evaluate([...pattern(1 + 1), round]);
  assert.deepEqual(fewer.errors, {}, 'count 2 still has instance 2');
  const gone = await evaluate([
    ...pattern(2).map((f) =>
      f.kind === 'pattern' ? { ...f, pattern: { ...f.pattern, count: 2 } } : f,
    ),
    fillet('f3', [{ ...edgeRefOf(second, 'b:end:0|b:side:0:l1') }], 2),
  ]);
  assert.match(gone.errors.f3 ?? '', /Missing reference: body of "pat"/);
});

// ---- revolve angle change -----------------------------------------------------------------

void test('revolve angle change keeps references on the cap faces; a full turn removes them', async () => {
  const revolve = (angle: number): Feature[] => [
    sketch('p', 'XZ', 0, { kind: 'rectangle', x: 10, y: 0, width: 10, height: 5 }),
    {
      ...base('r'),
      kind: 'revolve',
      profile: { kind: 'sketch', featureId: 'p' },
      axis: { kind: 'world', axis: 'Z' },
      angle,
      operation: 'new',
    } satisfies RevolveFeature,
  ];
  const quarter = only(await evaluate(revolve(90)), 'body:r');
  const capEdge = edgeRefOf(quarter, 'r:end:0|r:side:0:l2'); // end cap × outer wall
  const capFace = faceRefOf(quarter, 'r:start:0');
  const doc = (angle: number): Feature[] => [
    ...revolve(angle),
    fillet('f', [capEdge], 1),
    {
      ...sketch('c', 'XY', 0, { kind: 'circle', cx: 15, cy: 2.5, radius: 1 }),
      plane: { kind: 'face', face: capFace },
    },
  ];
  for (const angle of [90, 120, 200]) {
    const result = await evaluate(doc(angle));
    assert.deepEqual(result.errors, {}, `angle ${angle}`);
    assert.deepEqual(result.warnings, {}, `angle ${angle}: cap references resolve by key`);
    const body = only(result, 'body:r');
    assert.ok(
      body.faces.some((f) => f.key === 'f:round:0'),
      `fillet on the moved end cap at ${angle}°`,
    );
    const sweep = (Math.PI * (400 - 100) * 5 * angle) / 360;
    // The fillet between the planar cap and the convex wall removes about (1 - π/4)·r² per mm.
    near(body.volume, sweep - (1 - Math.PI / 4) * 5, 0.15, `volume at ${angle}°`);
  }
  const full = await evaluate(doc(360));
  assert.match(full.errors.f ?? '', /Missing reference: edge "r:end:0\|r:side:0:l2"/);
  assert.match(full.errors.c ?? '', /Missing reference: face "r:start:0"/);
});

// ---- sketch region redrawn -----------------------------------------------------------------

/** The rectangle sketch with its top line `l3` deleted and redrawn as `l5` between the same points. */
function redrawn(feature: SketchFeature): SketchFeature {
  const l3 = feature.entities.find((e) => e.id === 'l3');
  assert.ok(l3 && l3.kind === 'line');
  const uses = (refs: readonly string[]) => refs.includes('l3');
  return {
    ...feature,
    entities: [
      ...feature.entities.filter((e) => e.id !== 'l3'),
      { id: 'l5', kind: 'line', a: l3.a, b: l3.b },
    ],
    constraints: feature.constraints.filter((c) => !uses(c.refs)),
    dimensions: feature.dimensions.filter((d) => !uses(d.refs)),
  };
}

void test('sketch region redraw: best-effort rebind by the unchanged edges and by geometry, with warnings', async () => {
  const s = sketch('s', 'XY', 0, { kind: 'rectangle', x: 0, y: 0, width: 30, height: 20 });
  const [region] = detectRegions(s);
  assert.equal(region!.key, 'l1+l2+l3+l4');
  const e = extrude('e', 's', 10, {
    profile: { kind: 'sketch', featureId: 's', regions: [region!.key] },
  });
  const body = only(await evaluate([s, e]), 'body:e');
  const topBack = edgeRefOf(body, 'e:end:0|e:side:0:l3'); // the redrawn line's side face
  const round = fillet('f', [topBack], 2);
  const original = await evaluate([s, e, round]);
  assert.deepEqual(original.warnings, {});

  const again = await evaluate([redrawn(s), e, round]);
  assert.deepEqual(again.errors, {});
  assert.match(
    again.warnings.e ?? '',
    /Profile "l1\+l2\+l3\+l4" of "s" was redrawn; re-bound to "l1\+l2\+l4\+l5" by its unchanged edges \(l1, l2, l4\)/,
  );
  assert.match(
    again.warnings.f ?? '',
    /Edge reference "e:end:0\|e:side:0:l3" was re-bound by geometry/,
  );
  near(only(again, 'body:e').volume, only(original, 'body:e').volume, 1e-6, 'same solid');

  // A redrawn circle (no edge survives): the sketch's only profile.
  const c = sketch('c', 'XY', 0, { kind: 'circle', cx: 0, cy: 0, radius: 5 });
  const cx = extrude('x', 'c', 4, { profile: { kind: 'sketch', featureId: 'c', regions: ['c1'] } });
  const renamed: SketchFeature = {
    ...c,
    entities: c.entities.map((en) => (en.id === 'c1' ? { ...en, id: 'c2' } : en)),
    constraints: [],
    dimensions: [],
  };
  const circle = await evaluate([renamed, cx]);
  assert.deepEqual(circle.errors, {});
  assert.match(circle.warnings.x ?? '', /re-bound to the sketch's only remaining profile "c2"/);
  // Two candidate regions and no surviving edge: no guess.
  const two: SketchFeature = {
    ...sketch(
      'c',
      'XY',
      0,
      { kind: 'circle', cx: 0, cy: 0, radius: 5 },
      { kind: 'circle', cx: 20, cy: 0, radius: 5 },
    ),
  };
  const twoRenamed: SketchFeature = {
    ...two,
    entities: two.entities.map((en) => (en.id === 'c1' ? { ...en, id: 'c9' } : en)),
  };
  const ambiguous = await evaluate([twoRenamed, cx]);
  assert.match(ambiguous.errors.x ?? '', /Missing reference: profile "c1"/);
});

// ---- v1 keys of coplanar faces -------------------------------------------------------------

void test('a v1 "#n" key of coplanar faces from several features resolves to the face at its position', async () => {
  // Two separate bosses on one plate: v1 named both tops "<first boss>:end:0#1/#2".
  const doc: Feature[] = [
    sketch('s', 'XY', 0, { kind: 'rectangle', x: 0, y: 0, width: 60, height: 20 }),
    extrude('b', 's', 5),
    sketch('b1-s', 'XY', 5, { kind: 'circle', cx: 10, cy: 10, radius: 4 }),
    extrude('b1', 'b1-s', 5, { operation: 'join', targetBodyId: 'body:b' }),
    sketch('b2-s', 'XY', 5, { kind: 'circle', cx: 50, cy: 10, radius: 4 }),
    extrude('b2', 'b2-s', 5, { operation: 'join', targetBodyId: 'body:b' }),
  ];
  const body = only(await evaluate(doc), 'body:b');
  // v2 gives each boss top its own key.
  assert.ok(body.faces.some((f) => f.key === 'b1:end:0'));
  assert.ok(body.faces.some((f) => f.key === 'b2:end:0'));
  const secondTop = body.faces.find((f) => f.key === 'b2:end:0')!;
  // A v1 file stored the second top as "b1:end:0#2".
  const v1Ref: FaceRef = {
    bodyId: 'body:b',
    key: 'b1:end:0#2',
    signature: faceSignatureOf(secondTop),
  };
  const result = await evaluate([
    ...doc,
    {
      ...sketch('m', 'XY', 0, { kind: 'circle', cx: 50, cy: 10, radius: 1 }),
      plane: { kind: 'face', face: v1Ref },
    },
  ]);
  assert.deepEqual(result.errors, {});
  assert.match(result.warnings.m ?? '', /re-bound by geometry/);
  const sketchFrame = result.sketches.find((s) => s.featureId === 'm')!.frame;
  near(sketchFrame.origin[2], 10, 1e-9, 'sketch on the boss top plane');
});
