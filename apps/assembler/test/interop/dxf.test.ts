/**
 * DXF: reading the fixture (units, polyline bulges, blocks, splines,
 * ellipses, mirrored OCS arcs, skipped entities), turning it into sketch
 * geometry with connected end points and closed profiles, and writing
 * sketches / face outlines as R12 and R2000 that read back identically.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  flattenEntity,
  parseDxf,
  splinePoint,
  writeDxf,
  type DxfEntity,
} from '../../renderer/src/modules/interop/dxf.js';
import { dxfToSketchData, sketchToDxfEntities } from '../../renderer/src/modules/interop/dxfSketch.js';
import { dxfSketchFeature, dxfUnits } from '../../renderer/src/modules/interop/importActions.js';
import { detectRegions } from '../../renderer/src/foundation/sketch-solver/regions.js';
import { addCircle, addRectangle } from '../../renderer/src/foundation/sketch-solver/builders.js';
import { EMPTY_SKETCH } from '../../renderer/src/foundation/sketch-solver/types.js';
import { interopFixture } from './fixtures.js';

const plateText = new TextDecoder().decode(interopFixture('plate.dxf'));

function near(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) <= tol;
}

void test('DXF reader: entities, units, blocks, mirrored OCS arc, skipped text', () => {
  const drawing = parseDxf(plateText);
  assert.equal(drawing.insunits, 4);
  assert.equal(drawing.version, 'AC1015');
  assert.deepEqual(drawing.skipped, { TEXT: 1 });
  const kinds = drawing.entities.map((e) => e.kind);
  assert.deepEqual(kinds, [
    'polyline',
    'circle',
    'arc',
    'line',
    'spline',
    'ellipse',
    'point',
    'circle',
    'arc',
  ]);
  const poly = drawing.entities[0] as Extract<DxfEntity, { kind: 'polyline' }>;
  assert.equal(poly.closed, true);
  assert.equal(poly.layer, 'OUTLINE');
  assert.ok(near(poly.bulges[2]!, Math.tan(Math.PI / 8)));
  // Block HOLE (r 2) inserted at (40, 10), scale 1.5, rotated 90°.
  const inserted = drawing.entities[7] as Extract<DxfEntity, { kind: 'circle' }>;
  assert.ok(
    near(inserted.center[0], 40) && near(inserted.center[1], 10) && near(inserted.radius, 3),
  );
  // OCS extrusion (0, 0, −1): centre x mirrored, the 0°..90° arc becomes 90°..180°.
  const mirrored = drawing.entities[8] as Extract<DxfEntity, { kind: 'arc' }>;
  assert.ok(near(mirrored.center[0], 120) && near(mirrored.center[1], 25));
  const cos = (a: number) => Math.cos(a);
  const sin = (a: number) => Math.sin(a);
  assert.ok(
    near(cos(mirrored.start), 0) && near(sin(mirrored.start), 1),
    'mirrored arc starts at 90°',
  );
  assert.ok(near(cos(mirrored.end), -1) && near(sin(mirrored.end), 0), 'mirrored arc ends at 180°');
});

void test('DXF → sketch: connected outline with a fillet arc, profiles, exact spline, units', () => {
  const drawing = parseDxf(plateText);
  const units = dxfUnits(drawing);
  assert.deepEqual(units, {
    scale: 1,
    source: 'file',
    label: 'millimetres (from the file)',
    fileUnit: 'millimetres',
  });
  const { feature, stats } = dxfSketchFeature({
    id: 'sk1',
    name: 'Sketch 1',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    drawing,
    scaleToMm: units.scale,
  });
  assert.equal(stats.curves, 12);
  assert.equal(stats.points, 1);
  assert.equal(
    stats.connected,
    7,
    'polyline corners (5) and the D-shape (2) share their end points',
  );
  assert.equal(stats.approximated, 0);
  const arcs = feature.entities.filter((e) => e.kind === 'arc');
  assert.equal(arcs.length, 3);
  const spline = feature.entities.find((e) => e.kind === 'spline');
  assert.ok(spline && spline.kind === 'spline' && spline.mode === 'control');
  assert.deepEqual(spline.knots, [0, 0, 0, 0, 1, 1, 1, 1]);
  const regions = detectRegions(feature);
  const areas = regions.map((r) => Math.round(r.area * 100) / 100).sort((a, b) => b - a);
  // Outline 80 × 50 minus the 10 mm fillet corner (100 − 25π), with the Ø10 hole, the Ø6 hole and
  // the D-shape (half disc r 8) inside; the ellipse (π·15·7.5) outside.
  const outer = 80 * 50 - (100 - 25 * Math.PI);
  const inner = outer - Math.PI * 25 - Math.PI * 9 - (Math.PI * 64) / 2;
  assert.ok(
    areas.some((a) => near(a, Math.round(inner * 100) / 100, 0.02)),
    `areas ${areas.join(', ')}`,
  );
  assert.ok(areas.some((a) => near(a, Math.round(Math.PI * 15 * 7.5 * 100) / 100, 0.02)));
  assert.ok(areas.some((a) => near(a, Math.round(((Math.PI * 64) / 2) * 100) / 100, 0.02)));
});

void test('DXF units: inches from the file, unitless read as mm and said so, override wins', () => {
  assert.equal(dxfUnits({ insunits: 1 }).scale, 25.4);
  assert.equal(dxfUnits({ insunits: 0 }).source, 'unitless');
  assert.equal(dxfUnits({ insunits: null }).label, 'no unit in the file: read as millimetres');
  assert.equal(dxfUnits({ insunits: 1 }, 1).scale, 1);
  const { sketch } = dxfToSketchData([{ kind: 'line', a: [0, 0], b: [1, 0] }], { scaleToMm: 25.4 });
  const pts = sketch.entities.filter((e) => e.kind === 'point');
  assert.deepEqual(
    pts.map((p) => (p.kind === 'point' ? p.x : NaN)),
    [0, 25.4],
  );
});

void test('connect off keeps every end point separate', () => {
  const { stats, sketch } = dxfToSketchData(
    [
      { kind: 'line', a: [0, 0], b: [10, 0] },
      { kind: 'line', a: [10, 0], b: [10, 10] },
    ],
    { scaleToMm: 1, connect: false },
  );
  assert.equal(stats.connected, 0);
  assert.equal(sketch.entities.filter((e) => e.kind === 'point').length, 4);
});

void test('writer: R2000 and R12 read back to the same geometry (sketch round trip)', () => {
  let sketch = addRectangle(EMPTY_SKETCH, [0, 0], [40, 20]).sketch;
  sketch = addCircle(sketch, [10, 10], 4).sketch;
  const drawing = parseDxf(plateText);
  const imported = dxfToSketchData(drawing.entities, { scaleToMm: 1 }).sketch;
  for (const source of [sketch, imported]) {
    const entities = sketchToDxfEntities(source);
    for (const version of ['R2000', 'R12'] as const) {
      const text = writeDxf(entities, version);
      assert.match(text, version === 'R2000' ? /AC1015/ : /AC1009/);
      assert.match(text, /\r\n {2}0\r\nEOF\r\n$/);
      const back = parseDxf(text);
      assert.deepEqual(back.skipped, {});
      const again = dxfToSketchData(back.entities, { scaleToMm: 1 }).sketch;
      const areas = (s: typeof sketch) =>
        detectRegions(s)
          .map((r) => r.area)
          .sort((a, b) => a - b);
      const before = areas(source);
      const after = areas(again);
      assert.equal(after.length, before.length, `${version}: same number of profiles`);
      // R12 has no SPLINE/ELLIPSE: those come back as polylines (area within 0.5 %).
      before.forEach((a, i) =>
        assert.ok(
          Math.abs(after[i]! - a) <= a * (version === 'R12' ? 5e-3 : 1e-6),
          `${version}: area ${after[i]} vs ${a}`,
        ),
      );
    }
  }
});

void test('writer: R2000 structure has handles, owner links, tables and objects', () => {
  const text = writeDxf([{ kind: 'line', a: [0, 0], b: [1, 1], layer: 'CONSTRUCTION' }], 'R2000');
  for (const needle of [
    '$HANDSEED',
    'BLOCK_RECORD',
    '*Model_Space',
    'AcDbLine',
    'OBJECTS',
    'ACAD_GROUP',
    '$INSUNITS',
  ]) {
    assert.ok(text.includes(needle), needle);
  }
  const afterHeader = text.slice(text.indexOf('CLASSES'));
  const handles = [...afterHeader.matchAll(/\r\n {2}5\r\n([0-9A-F]+)\r\n/g)].map((m) => m[1]);
  assert.equal(new Set(handles).size, handles.length, 'handles are unique');
  const seed = /\$HANDSEED\r\n {2}5\r\n([0-9A-F]+)/.exec(text)![1]!;
  assert.ok(
    handles.every((h) => parseInt(h!, 16) < parseInt(seed, 16)),
    'HANDSEED is above every handle',
  );
});

void test('R12 flattening: chords within the tolerance, a vertex count that follows the shape', () => {
  // An ellipse (major 20, minor 10) and a clamped cubic spline with a straight and a curved part.
  const ellipse: DxfEntity = {
    kind: 'ellipse',
    center: [0, 0],
    major: [20, 0],
    ratio: 0.5,
    start: 0,
    end: 2 * Math.PI,
  } as DxfEntity;
  const spline = {
    kind: 'spline',
    degree: 3,
    controlPoints: [
      [0, 0],
      [5, 0],
      [10, 0],
      [15, 0],
      [20, 5],
      [20, 10],
      [15, 15],
    ],
    knots: [0, 0, 0, 0, 1, 2, 3, 4, 4, 4, 4],
    fitPoints: [],
    closed: false,
  } as unknown as Extract<DxfEntity, { kind: 'spline' }>;
  const tol = 1e-3;
  const deviation = (pts: [number, number][], at: (i: number, f: number) => [number, number]) => {
    let worst = 0;
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const [a, b] = [pts[i]!, pts[i + 1]!];
      for (let k = 1; k < 8; k += 1) {
        const p = at(i, k / 8);
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)),
        );
        worst = Math.max(worst, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
      }
    }
    return worst;
  };
  const e = flattenEntity(ellipse, tol);
  assert.ok(e.length > 16 && e.length < 400, `${e.length} ellipse vertices`);
  // Points of the ellipse between two vertices: by angle between the vertices' angles.
  const angle = (p: [number, number]) => Math.atan2(p[1] / 10, p[0] / 20);
  const e2 = deviation(e as [number, number][], (i, f) => {
    let a0 = angle(e[i] as [number, number]);
    let a1 = angle(e[i + 1] as [number, number]);
    if (a1 < a0) a1 += 2 * Math.PI;
    if (a1 - a0 > Math.PI) a0 += 2 * Math.PI;
    const a = a0 + (a1 - a0) * f;
    return [20 * Math.cos(a), 10 * Math.sin(a)];
  });
  assert.ok(e2 <= tol * 1.5, `ellipse chord deviation ${e2}`);
  const s = flattenEntity(spline, tol);
  // The straight first spans are one piece each; the curved ones are refined.
  assert.ok(s.length > 5 && s.length < 200, `${s.length} spline vertices`);
  assert.deepEqual(s[0], [0, 0]);
  assert.deepEqual(s.at(-1), splinePoint(spline, 4));
});
