/**
 * Emboss/Engrave with sketch text (integration of the sketch text tool and
 * the print-part Emboss feature): glyph contours are profile regions keyed
 * `<textId>.<n>`; engraving "HC" into a plate removes exactly the glyph
 * area Ã— depth, embossing adds it, and wrapping the text around a cylinder
 * keeps surface lengths (volume = area Â· ((R Â± d)Â² âˆ’ RÂ²) / 2R) â€” all with a
 * valid B-rep.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { faceSignatureOf } from '../../renderer/src/kernel/naming.js';
import type { Body } from '../../renderer/src/kernel/types.js';
import type {
  ExtrudeFeature,
  FaceRef,
  Feature,
  Plane,
  SketchFeature,
  SketchPlaneRef,
} from '../../renderer/src/model/document.js';
import type { EmbossFeature } from '../../renderer/src/model/printFeatures.js';
import { addCircle, addRectangle, addText } from '../../renderer/src/sketch/builders.js';
import { detectRegions } from '../../renderer/src/sketch/regions.js';
import { DEFAULT_SKETCH_FONT, textOutline } from '../../renderer/src/sketch/text/fonts.js';
import { EMPTY_SKETCH, type SketchData } from '../../renderer/src/sketch/types.js';
import { installNodeFonts } from '../sketch/nodeFont.js';
import { loadNodeKernel } from './nodeKernel.js';

installNodeFonts();

const base = (id: string) => ({ id, name: id, suppressed: false });

function sketch(id: string, data: SketchData, plane: SketchPlaneRef | Plane): SketchFeature {
  return {
    ...base(id),
    kind: 'sketch',
    plane: typeof plane === 'string' ? { kind: 'plane', plane, offset: 0 } : plane,
    ...data,
  };
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

function emboss(face: FaceRef, depth: number, regions: string[]): EmbossFeature {
  return {
    ...base('e'),
    kind: 'emboss',
    profile: { kind: 'sketch', featureId: 't', regions },
    face,
    depth,
  };
}

async function evaluate(features: Feature[]) {
  const { evaluator } = await loadNodeKernel();
  return evaluator.evaluate(features);
}

function faceRef(body: Body, predicate: (f: Body['faces'][number]) => boolean): FaceRef {
  const face = body.faces.find(predicate);
  assert.ok(face, `face found on ${body.id}`);
  return { bodyId: body.id, key: face.key, signature: faceSignatureOf(face) };
}

async function hcText(anchor: [number, number], height: number) {
  const outline = await textOutline(DEFAULT_SKETCH_FONT, 'HC');
  const data = addText(EMPTY_SKETCH, anchor, {
    text: 'HC',
    height,
    font: DEFAULT_SKETCH_FONT,
    outline: outline.outline,
  }).sketch;
  const text = data.entities.find((e) => e.kind === 'text');
  assert.ok(text, 'text entity');
  const regions = detectRegions(data);
  assert.equal(regions.length, 2, 'one region per glyph (H, C)');
  for (const r of regions) {
    assert.match(r.key, new RegExp(`^${text.id}\\.\\d+$`), 'glyph region key <textId>.<n>');
    assert.equal(r.holes.length, 0);
  }
  const area = regions.reduce((sum, r) => sum + r.area, 0);
  assert.ok(area > 0);
  return { data, keys: regions.map((r) => r.key), area };
}

void test('engrave and emboss sketch text "HC" on a plate top face', async () => {
  const plateSketch = sketch('p-s', addRectangle(EMPTY_SKETCH, [0, 0], [40, 20]).sketch, 'XY');
  const plate: Feature[] = [plateSketch, extrude('p', 'p-s', 5)];
  const first = (await evaluate(plate)).bodies[0]!;
  const top = faceRef(
    first,
    (f) => f.surface === 'plane' && f.normal?.[2] === 1 && Math.abs(f.centroid[2] - 5) < 1e-9,
  );
  const { data, keys, area } = await hcText([5, 5], 10);
  // Sketched on the plate's top face (as in the app); the glyphs sit well inside the 40 × 20 plate.
  const label = sketch('t', data, { kind: 'face', face: top });

  const engraved = await evaluate([...plate, label, emboss(top, -1, keys)]);
  assert.deepEqual(engraved.errors, {});
  assert.equal(engraved.bodies.length, 1);
  const cut = engraved.bodies[0]!;
  assert.equal(cut.valid, true, 'engraved plate is a valid B-rep');
  assert.ok(Math.abs(cut.volume - (4000 - area)) < 1e-4 * area, `engraved ${cut.volume}`);
  assert.ok(
    cut.faces.some((f) => f.key.startsWith('e:floor:')),
    'engraved floors keyed',
  );
  assert.ok(Math.abs(cut.max[2] - 5) < 1e-6, `top unchanged (${cut.max[2]})`);

  const raised = await evaluate([...plate, label, emboss(top, 0.8, keys)]);
  assert.deepEqual(raised.errors, {});
  const up = raised.bodies[0]!;
  assert.equal(up.valid, true);
  assert.ok(Math.abs(up.volume - (4000 + area * 0.8)) < 1e-4 * area, `embossed ${up.volume}`);
  assert.ok(Math.abs(up.max[2] - 5.8) < 1e-6, 'raised to 5.8');

  // All regions (no explicit keys) behave the same as listing both glyphs.
  const all = await evaluate([
    ...plate,
    label,
    { ...emboss(top, -1, keys), profile: { kind: 'sketch', featureId: 't' } },
  ]);
  assert.ok(Math.abs(all.bodies[0]!.volume - cut.volume) < 1e-6);
});

void test('glyphs with corners cut through / joined from inside a plate stay valid (C0 chain regression)', async () => {
  // Before the fix a glyph contour was one C0 B-spline edge; booleans that crossed its side
  // faces (anything but a cut starting exactly on the top face) gave invalid, wrong solids.
  const plate: Feature[] = [
    sketch('p-s', addRectangle(EMPTY_SKETCH, [0, 0], [40, 20]).sketch, 'XY'),
    extrude('p', 'p-s', 5),
  ];
  const { data, area } = await hcText([5, 5], 10);
  const cases: [offset: number, distance: number, expected: number][] = [
    [6, -2, 4000 - area], // starts above the plate, 1 mm deep
    [5, -8, 4000 - 5 * area], // through all
    [4, 2, 4000 + area], // joined from 1 mm inside the plate
  ];
  for (const [offset, distance, expected] of cases) {
    const label: SketchFeature = {
      ...sketch('t', data, 'XY'),
      plane: { kind: 'plane', plane: 'XY', offset },
    };
    const result = await evaluate([
      ...plate,
      label,
      { ...extrude('x', 't', distance), operation: distance < 0 ? 'cut' : 'join' },
    ]);
    assert.deepEqual(result.errors, {});
    const body = result.bodies[0]!;
    assert.equal(body.valid, true, `valid (offset ${offset}, distance ${distance})`);
    assert.ok(Math.abs(body.volume - expected) < 1e-4 * area, `${body.volume} vs ${expected}`);
  }
});

void test('wrap sketch text "HC" around a cylinder (emboss and engrave)', async () => {
  const R = 10;
  const rod: Feature[] = [
    sketch('c-s', addCircle(EMPTY_SKETCH, [0, 0], R).sketch, 'XY'),
    extrude('c', 'c-s', 30),
  ];
  const first = (await evaluate(rod)).bodies[0]!;
  const mantle = faceRef(first, (f) => f.surface === 'cylinder');
  // XZ plane contains the axis: u = x, v = z; the wrap centre is on +Y.
  const { data, keys, area } = await hcText([-4, 12], 5);
  const label = sketch('t', data, 'XZ');
  const cylinder = Math.PI * R * R * 30;

  const d = 0.6;
  const up = await evaluate([...rod, label, emboss(mantle, d, keys)]);
  assert.deepEqual(up.errors, {});
  const b = up.bodies[0]!;
  assert.equal(b.valid, true, 'wrapped emboss is a valid B-rep');
  const added = (area * ((R + d) ** 2 - R ** 2)) / (2 * R);
  assert.ok(Math.abs(b.volume - (cylinder + added)) < 2e-3 * added, `wrapped ${b.volume}`);
  assert.ok(Math.abs(b.max[1] - (R + d)) < 1e-3, 'raised on the +Y side');
  assert.ok(
    b.faces.some((f) => f.key.startsWith('e:top:')),
    'raised glyph faces keyed',
  );

  const down = await evaluate([...rod, label, emboss(mantle, -d, keys)]);
  assert.deepEqual(down.errors, {});
  const c = down.bodies[0]!;
  assert.equal(c.valid, true, 'wrapped engrave is a valid B-rep');
  const removed = (area * (R ** 2 - (R - d) ** 2)) / (2 * R);
  assert.ok(Math.abs(c.volume - (cylinder - removed)) < 2e-3 * removed, `engraved ${c.volume}`);
});
