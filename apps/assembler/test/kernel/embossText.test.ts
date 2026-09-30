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

import { type OcctModuleId, selectedOcctModule } from '../../headless/occtModule.js';
import { faceSignatureOf } from '../../renderer/src/foundation/geometry-kernel/naming.js';
import type { Body } from '../../renderer/src/foundation/geometry-kernel/types.js';
import type {
  ExtrudeFeature,
  FaceRef,
  Feature,
  Plane,
  SketchPlaneRef,
} from '../../renderer/src/foundation/document/document.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import type { EmbossFeature } from '../../renderer/src/model/printFeatures.js';
import {
  addCircle,
  addRectangle,
  addText,
} from '../../renderer/src/foundation/sketch-solver/builders.js';
import { detectRegions } from '../../renderer/src/foundation/sketch-solver/regions.js';
import {
  DEFAULT_SKETCH_FONT,
  textOutline,
} from '../../renderer/src/foundation/sketch-solver/text/fonts.js';
import {
  EMPTY_SKETCH,
  type SketchData,
} from '../../renderer/src/foundation/sketch-solver/types.js';
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

/** Sorted `key [aliases]` of every face: the naming a feature change must not move. */
function faceNames(body: Body): string[] {
  return body.faces
    .map((f) => `${f.key}${f.aliases.length > 0 ? ` [${[...f.aliases].sort().join(' ')}]` : ''}`)
    .sort();
}

/** FNV-1a digest of the face names (pins a long list compactly). */
function digest(names: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const ch of names.join('\n')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Face names of the per-profile fuses with the old lead-overlapping tools (159fe7c,
 * replicad-opencascadejs 1.1.0), which the batched, face-plane-started tool must reproduce:
 * face count and the digest of all face keys and aliases (volumes: 11730.97869 / 12215.21708
 * then; now checked against area · depth). Pinned per OCCT module: a different build may name
 * split pieces differently — re-pin that module's row then. The HimmelCAD build 8.0.1-hc.2
 * (`HIMMELCAD_OCCT=himmelcad`) was checked separately and names them identically.
 */
const LABEL_PINS: Record<OcctModuleId, Record<string, { faces: number; digest: string }>> = {
  replicad: {
    '-1': { faces: 174, digest: '0b956828' },
    '0.8': { faces: 174, digest: 'b46e62e3' },
  },
  himmelcad: {
    '-1': { faces: 174, digest: '0b956828' },
    '0.8': { faces: 174, digest: 'b46e62e3' },
  },
};

void test('a label of many glyphs is applied as one batched tool: same names, exact volume', async () => {
  // Profiles whose tools cannot touch go into one compound instead of a fuse each; the face
  // names are pinned to what the per-profile fuses produced, the volume to area · depth.
  const plateSketch = sketch('p-s', addRectangle(EMPTY_SKETCH, [0, 0], [120, 20]).sketch, 'XY');
  const plate: Feature[] = [plateSketch, extrude('p', 'p-s', 5)];
  const first = (await evaluate(plate)).bodies[0]!;
  const top = faceRef(
    first,
    (f) => f.surface === 'plane' && f.normal?.[2] === 1 && Math.abs(f.centroid[2] - 5) < 1e-9,
  );
  const outline = await textOutline(DEFAULT_SKETCH_FONT, 'HIMMELCAD 26');
  const data = addText(EMPTY_SKETCH, [4, 5], {
    text: 'HIMMELCAD 26',
    height: 9,
    font: DEFAULT_SKETCH_FONT,
    outline: outline.outline,
  }).sketch;
  const regions = detectRegions(data);
  const area = regions.reduce((sum, r) => sum + r.area, 0);
  const label = sketch('t', data, { kind: 'face', face: top });
  for (const depth of [-1, 0.8]) {
    const result = await evaluate([
      ...plate,
      label,
      emboss(
        top,
        depth,
        regions.map((r) => r.key),
      ),
    ]);
    assert.deepEqual(result.errors, {});
    const body = result.bodies[0]!;
    assert.equal(body.valid, true, `valid (${depth})`);
    assert.ok(
      Math.abs(body.volume - (12000 + area * depth)) < 1e-4 * area,
      `volume ${body.volume} (${depth})`,
    );
    const pin = LABEL_PINS[selectedOcctModule()][String(depth)]!;
    const names = faceNames(body);
    assert.equal(names.length, pin.faces);
    assert.equal(digest(names), pin.digest, 'same face keys and aliases as the per-profile fuses');
  }

  // Touching profiles (two overlapping rectangles split into three regions) are still fused,
  // a separate circle joins them in the compound.
  let shapes = addRectangle(EMPTY_SKETCH, [10, 4], [30, 12]).sketch;
  shapes = addRectangle(shapes, [20, 8], [40, 16]).sketch;
  shapes = addCircle(shapes, [80, 10], 4).sketch;
  const shapeRegions = detectRegions(shapes);
  assert.equal(shapeRegions.length, 4);
  const mixed = await evaluate([
    ...plate,
    sketch('t', shapes, { kind: 'face', face: top }),
    emboss(
      top,
      1.5,
      shapeRegions.map((r) => r.key),
    ),
  ]);
  assert.deepEqual(mixed.errors, {});
  const body = mixed.bodies[0]!;
  assert.equal(body.valid, true);
  const shapesArea = 20 * 8 + 20 * 8 - 10 * 4 + Math.PI * 16;
  assert.ok(Math.abs(body.volume - (12000 + 1.5 * shapesArea)) < 1e-6, `volume ${body.volume}`);
  assert.deepEqual(faceNames(body), [
    'e:side:0',
    'e:side:1#1',
    'e:side:1#2',
    'e:side:1#3',
    'e:side:1#4',
    'e:side:2#1',
    'e:side:2#2',
    'e:side:2#3',
    'e:side:2#4',
    'e:top:0',
    'e:top:1 [e:top:2 e:top:3]',
    'p:end:0',
    'p:side:0:l1',
    'p:side:0:l2',
    'p:side:0:l3',
    'p:side:0:l4',
    'p:start:0',
  ]);
});

void test('an emboss hanging over the face edge adds exactly area · height (no skirt below the face)', async () => {
  const plate: Feature[] = [
    sketch('p-s', addRectangle(EMPTY_SKETCH, [0, 0], [40, 20]).sketch, 'XY'),
    extrude('p', 'p-s', 5),
  ];
  const top = faceRef(
    (await evaluate(plate)).bodies[0]!,
    (f) => f.surface === 'plane' && f.normal?.[2] === 1 && Math.abs(f.centroid[2] - 5) < 1e-9,
  );
  // 20 × 10, half of it beyond the plate's right edge (x = 40).
  const label = sketch('t', addRectangle(EMPTY_SKETCH, [30, 5], [50, 15]).sketch, {
    kind: 'face',
    face: top,
  });
  const regions = detectRegions(label);
  const result = await evaluate([
    ...plate,
    label,
    emboss(
      top,
      1,
      regions.map((r) => r.key),
    ),
  ]);
  assert.deepEqual(result.errors, {});
  const body = result.bodies[0]!;
  assert.equal(body.valid, true);
  assert.ok(Math.abs(body.volume - (4000 + 200)) < 1e-6, `volume ${body.volume}`);
  assert.ok(Math.abs(body.min[2]) < 1e-9 && Math.abs(body.max[2] - 6) < 1e-9);
});
