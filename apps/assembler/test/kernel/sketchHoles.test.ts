/**
 * Regression (2026-09-30): a sketch region with holes (a rectangle around
 * circles, glyphs with counters) must become an OCCT face whose inner
 * wires are holes — on every sketch plane, for extrude and revolve — with
 * exact volumes and valid B-rep. Before the fix the XY/YZ faces *added*
 * the hole discs (e.g. 3282.7 instead of 2717.3 mm³) and failed
 * BRepCheck.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ExtrudeFeature,
  Feature,
  Plane,
  SketchFeature,
} from '../../renderer/src/model/document.js';
import type { RevolveFeature } from '../../renderer/src/model/features.js';
import { addCircle, addRectangle, addText } from '../../renderer/src/sketch/builders.js';
import { detectRegions } from '../../renderer/src/sketch/regions.js';
import { DEFAULT_SKETCH_FONT, textOutline } from '../../renderer/src/sketch/text/fonts.js';
import { EMPTY_SKETCH, type SketchData } from '../../renderer/src/sketch/types.js';
import { installNodeFonts } from '../sketch/nodeFont.js';
import { loadNodeKernel } from './nodeKernel.js';

installNodeFonts();

function sketch(id: string, data: SketchData, plane: Plane = 'XY', offset = 0): SketchFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane, offset },
    ...data,
  };
}

function extrude(
  id: string,
  sketchId: string,
  distance: number,
  regions?: string[],
  extra: Partial<ExtrudeFeature> = {},
): ExtrudeFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketchId, ...(regions ? { regions } : {}) },
    distance,
    symmetric: false,
    operation: 'new',
    ...extra,
  };
}

async function evaluate(features: Feature[]) {
  const { evaluator } = await loadNodeKernel();
  return evaluator.evaluate(features);
}

/** Rectangle 30 × 20 with two Ø6 holes. */
function plateWithHoles(): SketchData {
  let s = addRectangle(EMPTY_SKETCH, [0, 0], [30, 20]).sketch;
  s = addCircle(s, [8, 10], 3).sketch;
  s = addCircle(s, [22, 10], 3).sketch;
  return s;
}

const RING_AREA = 600 - 2 * Math.PI * 9;

for (const plane of ['XY', 'XZ', 'YZ'] as const) {
  void test(`extruding a region with holes cuts the holes (${plane} plane, offset 7)`, async () => {
    const data = plateWithHoles();
    const regions = detectRegions(data);
    const ring = regions.find((r) => r.holes.length === 2)!;
    assert.ok(Math.abs(ring.area - RING_AREA) < 1e-9);
    const result = await evaluate([sketch('s', data, plane, 7), extrude('x', 's', 5, [ring.key])]);
    assert.deepEqual(result.errors, {});
    assert.equal(result.bodies.length, 1);
    const body = result.bodies[0]!;
    assert.equal(body.valid, true, 'BRepCheck valid');
    assert.ok(Math.abs(body.volume - RING_AREA * 5) < 1e-6, `volume ${body.volume}`);
    // Symmetric and reversed extrudes too.
    const both = await evaluate([
      sketch('s', data, plane),
      extrude('x', 's', 4, [ring.key], { symmetric: true }),
    ]);
    assert.equal(both.bodies[0]!.valid, true);
    assert.ok(Math.abs(both.bodies[0]!.volume - RING_AREA * 8) < 1e-6);
    const reversed = await evaluate([sketch('s', data, plane), extrude('x', 's', -3, [ring.key])]);
    assert.equal(reversed.bodies[0]!.valid, true);
    assert.ok(Math.abs(reversed.bodies[0]!.volume - RING_AREA * 3) < 1e-6);
  });
}

void test('every region of the plate sketch (ring + hole discs) fuses into the full block', async () => {
  const result = await evaluate([sketch('s', plateWithHoles()), extrude('x', 's', 5)]);
  assert.deepEqual(result.errors, {});
  assert.equal(result.bodies[0]!.valid, true);
  assert.ok(Math.abs(result.bodies[0]!.volume - 3000) < 1e-6);
});

void test('revolving a region with a hole gives the Pappus volume and a valid solid', async () => {
  // On XZ: a 10 × 10 square at x 10..20 with a Ø4 hole at its centre, revolved about Z.
  let data = addRectangle(EMPTY_SKETCH, [10, 0], [20, 10]).sketch;
  data = addCircle(data, [15, 5], 2).sketch;
  const ring = detectRegions(data).find((r) => r.holes.length === 1)!;
  const revolve: RevolveFeature = {
    id: 'r',
    name: 'r',
    suppressed: false,
    kind: 'revolve',
    profile: { kind: 'sketch', featureId: 's', regions: [ring.key] },
    axis: { kind: 'world', axis: 'Z' },
    angle: 360,
    operation: 'new',
  };
  const result = await evaluate([sketch('s', data, 'XZ'), revolve]);
  assert.deepEqual(result.errors, {});
  const body = result.bodies[0]!;
  assert.equal(body.valid, true);
  const expected = 2 * Math.PI * 15 * (100 - 4 * Math.PI);
  assert.ok(Math.abs(body.volume - expected) < 1e-3, `${body.volume} vs ${expected}`);
});

void test('text with counters (O, e, A, B) extrudes to glyph solids with open counters; cut into a plate', async () => {
  const text = await textOutline(DEFAULT_SKETCH_FONT, 'OeAB');
  const data = addText(EMPTY_SKETCH, [2, 2], {
    text: 'OeAB',
    height: 10,
    font: DEFAULT_SKETCH_FONT,
    outline: text.outline,
  }).sketch;
  const regions = detectRegions(data);
  assert.equal(regions.length, 4, 'one region per glyph');
  assert.deepEqual(
    regions.map((r) => r.holes.length).sort(),
    [1, 1, 1, 2],
    'O, e and A have one counter, B two',
  );
  const area = regions.reduce((sum, r) => sum + r.area, 0);
  for (const plane of ['XY', 'YZ'] as const) {
    const result = await evaluate([sketch('t', data, plane), extrude('x', 't', 2)]);
    assert.deepEqual(result.errors, {});
    const volume = result.bodies.reduce((sum, b) => sum + b.volume, 0);
    for (const b of result.bodies) assert.equal(b.valid, true);
    assert.ok(Math.abs(volume - area * 2) < 1e-4 * area, `${plane}: ${volume} vs ${area * 2}`);
  }
  // Engraved into a plate (cut 1 mm deep from the top at z = 5).
  const plate = sketch('p', addRectangle(EMPTY_SKETCH, [0, 0], [40, 14]).sketch);
  const engraved = await evaluate([
    plate,
    extrude('px', 'p', 5),
    sketch('t', data, 'XY', 5),
    extrude('tx', 't', -1, undefined, { operation: 'cut' }),
  ]);
  assert.deepEqual(engraved.errors, {});
  const body = engraved.bodies[0]!;
  assert.equal(body.valid, true);
  assert.ok(Math.abs(body.volume - (40 * 14 * 5 - area)) < 1e-3 * area, `${body.volume}`);
});
