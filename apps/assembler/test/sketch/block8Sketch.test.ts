/**
 * Block 8 sketching: patterns in two directions and patterns edited after
 * they were made (SK-12), solved by the real planeGCS solver.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

import { addCircle, addRectangle } from '../../renderer/src/foundation/sketch-solver/builders.js';
import {
  deleteItems,
  offsetChain,
  SketchBuilder,
} from '../../renderer/src/foundation/sketch-solver/edits.js';
import {
  closestOnCurve,
  curveLength,
  entityCurves,
  sampleCurve,
  sub,
} from '../../renderer/src/foundation/sketch-solver/geometry.js';
import { detectRegions } from '../../renderer/src/foundation/sketch-solver/regions.js';
import { buildEllipse, buildSpline } from '../../renderer/src/modules/sketching/shapes.js';
import { validateSketchData } from '../../renderer/src/foundation/sketch-solver/validation.js';
import type { Inference, SketchHit } from '../../renderer/src/modules/sketching/inference.js';
import {
  circularPattern,
  cornerLimit,
  editPattern,
  roundCorner,
  linearPattern,
  patternOf,
} from '../../renderer/src/modules/sketching/operations.js';
import {
  initialTool,
  offsetToolFor,
  reduceTool,
  toolPreview,
  type SketchTool,
  type ToolEvent,
  type ValueField,
} from '../../renderer/src/modules/sketching/tools.js';
import {
  EMPTY_SKETCH,
  entityMap,
  pointPos,
  type SketchData,
  type Vec2,
} from '../../renderer/src/foundation/sketch-solver/types.js';
import { loadNodeSolver } from './nodeSolver.js';
import { installNodeFonts } from './nodeFont.js';
import {
  fontLabel,
  listSketchFonts,
  loadSketchFont,
  setSystemFontProvider,
  systemFontsAvailable,
  textOutline,
  textOutlineOf,
} from '../../renderer/src/foundation/sketch-solver/text/fonts.js';
import { parseOutline } from '../../renderer/src/foundation/sketch-solver/text/outline.js';

function snap(pos: Vec2, extra: Partial<Inference> = {}): Inference {
  return { pos, hints: [], guides: [], ...extra };
}

async function solved(sketch: SketchData): Promise<{ sketch: SketchData; dof: number }> {
  const result = (await loadNodeSolver()).solveSync({ sketch });
  assert.equal(
    result.status,
    'ok',
    `${result.message ?? ''} conflicting ${result.conflicting} redundant ${result.redundant}`,
  );
  return { sketch: result.sketch, dof: result.dof };
}

/** Sorted circle centres of a sketch, rounded to 1e-6. */
function centres(sketch: SketchData): Vec2[] {
  const map = entityMap(sketch);
  return sketch.entities
    .flatMap((e) => (e.kind === 'circle' ? [pointPos(map, e.center)!] : []))
    .map((p) => [Math.round(p[0] * 1e6) / 1e6 + 0, Math.round(p[1] * 1e6) / 1e6 + 0] as Vec2)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

class Drive {
  tool: SketchTool;
  notices: string[] = [];
  constructor(
    public sketch: SketchData,
    selection: string[],
  ) {
    this.tool = initialTool('pattern', selection);
  }
  async send(event: ToolEvent): Promise<void> {
    const step = reduceTool(this.sketch, this.tool, event, { construction: false });
    if (step.notice) this.notices.push(step.notice);
    if (step.edit) this.sketch = (await solved(step.edit.sketch)).sketch;
    this.tool = step.tool;
  }
  click(pos: Vec2, hit: SketchHit | null = null): Promise<void> {
    return this.send({ type: 'click', snap: snap(pos), hit, raw: pos });
  }
  value(field: ValueField, value: number, at: Vec2 = [0, 0]): Promise<void> {
    return this.send({ type: 'value', field, value, snap: snap(at) });
  }
}

void test('linear pattern in two directions: a 3 × 2 grid from two clicks, fully determined, recorded', async () => {
  const c = addCircle(EMPTY_SKETCH, [0, 0], 2, { size: true, position: true });
  const d = new Drive(c.sketch, [c.circleId]);
  d.tool = { ...d.tool, directions: 2, count: 3, count2: 2 } as SketchTool;
  // First direction: the last copy at x = 20 (horizontal); second: y = 15 (vertical).
  await d.click([20, 0]);
  assert.equal(d.tool.kind === 'pattern' && d.tool.first !== null, true, 'first direction placed');
  const preview = toolPreview(d.sketch, d.tool, snap([0, 15]), null);
  assert.ok(preview.curves.length >= 5, 'the preview shows the grid');
  await d.click([0, 15]);
  assert.deepEqual(centres(d.sketch), [
    [0, 0],
    [0, 15],
    [10, 0],
    [10, 15],
    [20, 0],
    [20, 15],
  ]);
  const { dof } = await solved(d.sketch);
  assert.equal(dof, 0, 'both directions are dimensioned and axis-aligned');
  const record = d.sketch.patterns?.[0];
  assert.ok(record);
  assert.deepEqual(
    [record.kind, record.count, record.count2, record.lines?.length],
    ['linear', 3, 2, 2],
  );
  assert.equal(validateSketchData(d.sketch as never), null, 'the record validates');
  // Every copy belongs to the pattern; the source too.
  assert.equal(patternOf(d.sketch, c.circleId)?.id, record.id);
  // The second spacing dimension drives the second row.
  const spacing2 = d.sketch.dimensions.find((x) => Math.abs(x.value - 15) < 1e-9)!;
  const moved = await solved({
    ...d.sketch,
    dimensions: d.sketch.dimensions.map((x) => (x.id === spacing2.id ? { ...x, value: 25 } : x)),
  });
  assert.deepEqual(
    centres(moved.sketch).map((p) => p[1]),
    [0, 25, 0, 25, 0, 25],
  );
});

void test('editing a linear pattern after creation: count up and down, second count, one rebuild each', async () => {
  const c = addCircle(EMPTY_SKETCH, [0, 0], 2, { size: true, position: true });
  const made = linearPattern(c.sketch, [c.circleId], 3, [1, 0], 10, { horizontal: true });
  assert.ok(made);
  let sketch = (await solved(made.sketch)).sketch;
  const id = sketch.patterns![0]!.id;
  const more = editPattern(sketch, id, { count: 5 });
  assert.ok(!('reason' in more));
  sketch = (await solved(more.sketch)).sketch;
  assert.deepEqual(
    centres(sketch).map((p) => p[0]),
    [0, 10, 20, 30, 40],
  );
  assert.equal(sketch.patterns![0]!.count, 5);
  const less = editPattern(sketch, id, { count: 2 });
  assert.ok(!('reason' in less));
  const after = await solved(less.sketch);
  assert.deepEqual(
    centres(after.sketch).map((p) => p[0]),
    [0, 10],
  );
  assert.equal(after.dof, 0, 'still fully determined');
  // Spacing dimension and direction line survive the rebuilds.
  assert.equal(after.sketch.dimensions.filter((x) => x.value === 10).length, 1);
  // A one-direction pattern has no second count.
  assert.match(
    (editPattern(after.sketch, id, { count2: 3 }) as { reason: string }).reason,
    /one direction/,
  );
  assert.match(
    (editPattern(after.sketch, id, { count: 1 }) as { reason: string }).reason,
    /2 to 200/,
  );
  assert.match(
    (editPattern(after.sketch, 'pat9', { count: 3 }) as { reason: string }).reason,
    /no longer/,
  );
  // A grid's second count.
  const grid = linearPattern(c.sketch, [c.circleId], 2, [1, 0], 10, {
    horizontal: true,
    second: { count: 2, direction: [0, 1], spacing: 5, vertical: true },
  })!;
  const gridSketch = (await solved(grid.sketch)).sketch;
  const wider = editPattern(gridSketch, gridSketch.patterns![0]!.id, { count2: 4 });
  assert.ok(!('reason' in wider));
  const g = await solved(wider.sketch);
  assert.equal(centres(g.sketch).length, 8);
  assert.equal(g.dof, 0);
});

void test('editing a circular pattern: count and total angle; the centre stays', async () => {
  const c = addCircle(EMPTY_SKETCH, [20, 0], 3, { size: true, position: true });
  const made = circularPattern(c.sketch, [c.circleId], 4, { pos: [0, 0], pointId: 'origin' }, 360);
  assert.ok(made);
  let sketch = (await solved(made.sketch)).sketch;
  const id = sketch.patterns![0]!.id;
  const angleOf = (s: SketchData) =>
    centres(s)
      .map((p) => Math.round((Math.atan2(p[1], p[0]) * 180) / Math.PI))
      .sort((a, b) => a - b);
  assert.deepEqual(angleOf(sketch), [-90, 0, 90, 180]);
  const six = editPattern(sketch, id, { count: 6 });
  assert.ok(!('reason' in six));
  sketch = (await solved(six.sketch)).sketch;
  assert.deepEqual(angleOf(sketch), [-120, -60, 0, 60, 120, 180]);
  // 90° total spreads the 6 instances from first to last.
  const quarter = editPattern(sketch, id, { angle: 90 });
  assert.ok(!('reason' in quarter));
  const q = await solved(quarter.sketch);
  assert.deepEqual(angleOf(q.sketch), [0, 18, 36, 54, 72, 90]);
  assert.equal(q.dof, 0);
  assert.equal(q.sketch.patterns![0]!.angle, 90);
});

/** Shoelace area of a curve entity's samples. */
function curveArea(sketch: SketchData, id: string): number {
  const map = entityMap(sketch);
  const e = map.get(id);
  assert.ok(e && e.kind !== 'point');
  const pts = entityCurves(map, e).flatMap(({ curve }) => sampleCurve(curve, Math.PI / 720));
  let a = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

void test('offset (SK-09): an ellipse offsets outward as a closed fit spline on its true offset; inward fold-over is refused', async () => {
  const b = new SketchBuilder(EMPTY_SKETCH);
  const ellipse = buildEllipse(b, { pos: [0, 0] }, { pos: [20, 0] }, 10, { construction: false });
  const sketch = (await solved(b.result([ellipse]).sketch)).sketch;
  const out = offsetChain(sketch, ellipse, -2); // left of a counter-clockwise ellipse is inside
  assert.ok(out);
  const spline = out.sketch.entities.find((e) => e.kind === 'spline');
  assert.ok(spline?.kind === 'spline');
  assert.equal(spline.points[0], spline.points[spline.points.length - 1], 'closed');
  // Exact offset area: πab + d·perimeter + πd².
  const ell = {
    kind: 'ellipse' as const,
    c: [0, 0] as Vec2,
    rx: 20,
    ry: 10,
    rot: 0,
    a0: 0,
    sweep: Math.PI * 2,
  };
  const perimeter = curveLength(ell);
  const expected = Math.PI * 200 + 2 * perimeter + Math.PI * 4;
  const area = curveArea(out.sketch, spline.id);
  assert.ok(Math.abs(area / expected - 1) < 2e-4, `offset area ${area} ≈ ${expected}`);
  const solvedOut = await solved(out.sketch);
  assert.ok(solvedOut.dof > 0, 'new, free geometry');
  // Inward by more than the smallest radius of curvature (b²/a = 5 mm) folds over: refused.
  assert.equal(offsetChain(sketch, ellipse, 6), null);
  assert.ok(offsetChain(sketch, ellipse, 4), 'within the radius of curvature');
});

void test('offset (SK-09): an open spline offsets at a constant distance; a line + spline chain stays connected', async () => {
  const b = new SketchBuilder(EMPTY_SKETCH);
  const p0 = b.addPoint([0, 0]);
  const p1 = b.addPoint([-20, 0]);
  const line = b.addLine(p1, p0);
  const spline = buildSpline(
    b,
    [{ pos: [0, 0], pointId: p0 }, { pos: [15, 10] }, { pos: [30, 0] }],
    'fit',
    false,
  );
  const sketch = b.result([line, spline]).sketch;
  const chain = offsetChain(sketch, spline, 3);
  assert.ok(chain);
  const map = entityMap(chain.sketch);
  const created = chain.sketch.entities.filter(
    (e) => !sketch.entities.some((x) => x.id === e.id) && e.kind !== 'point',
  );
  assert.deepEqual(created.map((e) => e.kind).sort(), ['line', 'spline'], 'the chain came along');
  const newSpline = created.find((e) => e.kind === 'spline')!;
  const newLine = created.find((e) => e.kind === 'line')!;
  assert.ok(newLine.kind === 'line' && newSpline.kind === 'spline');
  assert.ok(
    [newLine.a, newLine.b].includes(newSpline.points[0]!),
    'the offset pieces share a point',
  );
  const source = sketch.entities.find((e) => e.id === spline);
  assert.ok(source?.kind === 'spline');
  const original = entityCurves(entityMap(sketch), source)[0]!.curve;
  for (const { curve } of entityCurves(map, newSpline)) {
    for (const p of sampleCurve(curve).slice(2, -2)) {
      const d = Math.hypot(...(sub(p, closestOnCurve(original, p).point) as [number, number]));
      assert.ok(Math.abs(d - 3) < 0.01, `distance ${d} ≈ 3`);
    }
  }
});

void test('offset (SK-09): several loops at once, all outward; an arrow flips one loop; single curve mode', async () => {
  const r1 = addRectangle(EMPTY_SKETCH, [0, 0], [10, 10], {});
  const r2 = addRectangle(r1.sketch, [30, 0], [50, 10], {});
  const sketch = r2.sketch;
  let tool = offsetToolFor(sketch, [r1.lineIds[0]!, r1.lineIds[2]!, r2.lineIds[1]!]);
  assert.equal(tool.loops.length, 2, 'one loop per selected chain');
  // The cursor 2 mm below the first rectangle's bottom line: outward for both.
  const cursor = snap([5, -2]);
  const preview = toolPreview(sketch, tool, cursor, null);
  assert.equal(preview.arrows?.length, 2);
  const step = reduceTool(
    sketch,
    tool,
    { type: 'click', snap: cursor, hit: null, raw: [5, -2] },
    {
      construction: false,
    },
  );
  assert.ok(step.edit);
  const areas = detectRegions(step.edit.sketch)
    .map((r) => Math.round(r.area))
    .sort((a, b) => a - b);
  // Two rings around the rectangles: (14×14 − 100) and (24×14 − 200).
  assert.deepEqual(areas, [96, 100, 136, 200]);
  // Flip the second loop: it goes inside (16×6 inner rectangle).
  tool = { ...tool, loops: tool.loops.map((l, i) => (i === 1 ? { ...l, flip: true } : l)) };
  const flipped = reduceTool(
    sketch,
    tool,
    { type: 'click', snap: cursor, hit: null, raw: [5, -2] },
    {
      construction: false,
    },
  );
  const flippedAreas = detectRegions(flipped.edit!.sketch)
    .map((r) => Math.round(r.area))
    .sort((a, b) => a - b);
  assert.deepEqual(flippedAreas, [96, 96, 100, 104]);
  // Single: only the picked line.
  const single = offsetToolFor(sketch, [r1.lineIds[0]!], 'single');
  const one = reduceTool(
    sketch,
    single,
    { type: 'value', field: 'distance', value: 2, snap: cursor },
    {
      construction: false,
    },
  );
  const lines = (s: SketchData) => s.entities.filter((e) => e.kind === 'line').length;
  assert.equal(lines(one.edit!.sketch), lines(sketch) + 1);
});

/** A "D": the diameter line (-10,0)–(10,0) and the upper half circle of radius 10, dimensioned. */
function dShape(): { sketch: SketchData; right: string; left: string; line: string; arc: string } {
  const sketch: SketchData = {
    entities: [
      { id: 'pc', kind: 'point', x: 0, y: 0 },
      { id: 'pl', kind: 'point', x: -10, y: 0 },
      { id: 'pr', kind: 'point', x: 10, y: 0 },
      { id: 'l1', kind: 'line', a: 'pl', b: 'pr' },
      { id: 'a1', kind: 'arc', center: 'pc', start: 'pr', end: 'pl' },
    ],
    constraints: [
      { id: 'k1', kind: 'coincident', refs: ['pc', 'origin'] },
      { id: 'k2', kind: 'horizontal', refs: ['l1'] },
      { id: 'k3', kind: 'pointOnObject', refs: ['pc', 'l1'] },
    ],
    dimensions: [{ id: 'm1', name: 'd1', kind: 'radius', refs: ['a1'], value: 10 }],
  };
  return { sketch, right: 'pr', left: 'pl', line: 'l1', arc: 'a1' };
}

void test('sketch fillet/chamfer (SK-14): line–arc corners, tangent and dimensioned; limits and refusals', async () => {
  const d = dShape();
  const base = await solved(d.sketch);
  assert.equal(base.dof, 0);
  const fillet = roundCorner(base.sketch, d.right, 2, 'fillet');
  assert.ok(!('reason' in fillet), 'reason' in fillet ? fillet.reason : '');
  const f = await solved(fillet.sketch);
  assert.equal(f.dof, 0, 'the radius dimension determines the fillet');
  const map = entityMap(f.sketch);
  const arc = f.sketch.entities.find((e) => e.kind === 'arc' && e.id !== d.arc);
  assert.ok(arc?.kind === 'arc');
  const c = pointPos(map, arc.center)!;
  // Tangent to the line (distance 2) and inside the half circle (distance 10 − 2 from its centre).
  assert.ok(Math.abs(c[1] - 2) < 1e-6 && Math.abs(Math.hypot(c[0], c[1]) - 8) < 1e-6);
  assert.ok(Math.abs(c[0] - Math.sqrt(60)) < 1e-6);
  // One region, smaller than the half disc by the rounded corner.
  const regions = detectRegions(f.sketch);
  assert.equal(regions.length, 1);
  assert.ok(regions[0]!.area < Math.PI * 50 && regions[0]!.area > Math.PI * 50 - 4);
  // The other corner as a chamfer: chord set-back 3 on the arc, 3 along the line.
  const chamfer = roundCorner(f.sketch, d.left, 3, 'chamfer');
  assert.ok(!('reason' in chamfer));
  const ch = await solved(chamfer.sketch);
  assert.equal(ch.dof, 0);
  // Arc–arc: the fillet arc and the half circle meet at a corner? No — tangent: refused.
  const tangentCorner = (
    ch.sketch.entities.find((e) => e.kind === 'arc' && e.id !== d.arc) as {
      start: string;
    }
  ).start;
  const refused = roundCorner(ch.sketch, tangentCorner, 1, 'fillet');
  assert.ok('reason' in refused && /tangent/.test(refused.reason));
  // Too large: the message names the largest radius that fits.
  const tooLarge = roundCorner(base.sketch, d.right, 50, 'fillet');
  assert.ok('reason' in tooLarge && /at most \d/.test(tooLarge.reason));
  const limit = cornerLimit(base.sketch, d.right, 'fillet');
  assert.ok(limit > 2 && limit < 10, `limit ${limit}`);
  // Splines are refused with the reason.
  const b = new SketchBuilder(EMPTY_SKETCH);
  const p0 = b.addPoint([0, 0]);
  const p1 = b.addPoint([10, 0]);
  b.addLine(p0, p1);
  buildSpline(b, [{ pos: [10, 0], pointId: p1 }, { pos: [15, 5] }, { pos: [20, 0] }], 'fit', false);
  const spline = roundCorner(b.result().sketch, p1, 1, 'fillet');
  assert.ok('reason' in spline && /spline/.test(spline.reason));
});

void test('text (SK-11): alignment shifts the stored outline; installed fonts load through a provider, collections split', async () => {
  installNodeFonts();
  const inter = await loadSketchFont('inter');
  const left = textOutlineOf(inter, 'HC');
  const center = textOutlineOf(inter, 'HC', 'center');
  const right = textOutlineOf(inter, 'HC', 'right');
  const xs = (outline: string) =>
    parseOutline(outline).flatMap((c) => c.flatMap((seg) => seg.map((p) => p[0])));
  const minX = (o: string) => Math.min(...xs(o));
  const maxX = (o: string) => Math.max(...xs(o));
  assert.ok(Math.abs(minX(center.outline) - (minX(left.outline) - left.width / 2)) < 1e-3);
  assert.ok(maxX(right.outline) <= 1e-3, 'right: the text ends at the anchor');
  assert.equal(center.width, left.width);
  // Installed fonts: a provider (the desktop app's Local Font Access) gives the bytes.
  assert.equal(systemFontsAvailable(), false, 'tests and headless: bundled only');
  await assert.rejects(loadSketchFont('system:Inter-Regular'), /not available here/);
  const ttf = await interSfnt();
  // A two-font collection of that font: the provider hands out the .ttc bytes.
  const ttc = makeCollection([ttf, ttf]);
  const listed: string[] = [];
  setSystemFontProvider({
    list: async () => [
      { id: 'system:Inter-Regular', label: 'Inter Regular', source: 'system', family: 'Inter' },
    ],
    bytes: async (info) => {
      listed.push(info.id);
      return ttc;
    },
  });
  try {
    const fonts = await listSketchFonts();
    assert.deepEqual(
      fonts.map((f) => [f.id, f.source]),
      [
        ['inter', 'bundled'],
        ['system:Inter-Regular', 'system'],
      ],
    );
    const system = await textOutline('system:Inter-Regular', 'HC');
    assert.deepEqual(listed, ['system:Inter-Regular']);
    assert.equal(system.width.toFixed(4), left.width.toFixed(4), 'same glyphs from the collection');
    assert.equal(fontLabel('system:Inter-Regular'), 'Inter Regular');
    // A document's installed font that is not on this computer keeps a readable name.
    assert.equal(fontLabel('system:Some-Font'), 'Some-Font');
  } finally {
    setSystemFontProvider(null);
  }
  // The file validator knows the alignment field.
  const sketch: SketchData = {
    entities: [
      { id: 'p1', kind: 'point', x: 0, y: 0 },
      {
        id: 't1',
        kind: 'text',
        anchor: 'p1',
        text: 'HC',
        height: 5,
        angle: 0,
        font: 'system:Arial',
        align: 'center',
        outline: center.outline,
      },
    ],
    constraints: [],
    dimensions: [],
  };
  assert.equal(validateSketchData(sketch as never), null);
  const bad = {
    ...sketch,
    entities: [sketch.entities[0], { ...sketch.entities[1], align: 'top' }],
  };
  assert.match(validateSketchData(bad as never)?.path ?? '', /align/);
});

/** The bundled Inter WOFF as a plain sfnt (what an installed `.ttf`/`.otf` file holds). */
async function interSfnt(): Promise<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const woff = await readFile(
    require.resolve('@fontsource/inter/files/inter-latin-400-normal.woff'),
  );
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  const numTables = view.getUint16(12);
  const tables: { tag: number; checksum: number; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const at = 44 + 20 * i;
    const offset = view.getUint32(at + 4);
    const compLength = view.getUint32(at + 8);
    const origLength = view.getUint32(at + 12);
    const raw = woff.subarray(offset, offset + compLength);
    tables.push({
      tag: view.getUint32(at),
      checksum: view.getUint32(at + 16),
      data: compLength < origLength ? new Uint8Array(inflateSync(raw)) : new Uint8Array(raw),
    });
  }
  let size = 12 + 16 * numTables;
  for (const t of tables) size += (t.data.length + 3) & ~3;
  const out = new Uint8Array(size);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, view.getUint32(4)); // flavor
  ov.setUint16(4, numTables);
  let at = 12 + 16 * numTables;
  tables.forEach((t, i) => {
    const rec = 12 + 16 * i;
    ov.setUint32(rec, t.tag);
    ov.setUint32(rec + 4, t.checksum);
    ov.setUint32(rec + 8, at);
    ov.setUint32(rec + 12, t.data.length);
    out.set(t.data, at);
    at += (t.data.length + 3) & ~3;
  });
  return out.buffer;
}

/** A TrueType collection of `fonts` (each a standalone sfnt), as `.ttc` files are laid out. */
function makeCollection(fonts: ArrayBuffer[]): ArrayBuffer {
  const header = 12 + 4 * fonts.length;
  const total = header + fonts.reduce((n, f) => n + f.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x74746366);
  view.setUint32(4, 0x00010000);
  view.setUint32(8, fonts.length);
  let at = header;
  fonts.forEach((font, i) => {
    view.setUint32(12 + 4 * i, at);
    out.set(new Uint8Array(font), at);
    // Table offsets inside a collection are relative to the file start.
    const numTables = view.getUint16(at + 4);
    for (let t = 0; t < numTables; t += 1) {
      const field = at + 12 + 16 * t + 8;
      view.setUint32(field, view.getUint32(field) + at);
    }
    at += font.byteLength;
  });
  return out.buffer;
}

void test('pattern records follow deletions: copies may go, sources or the direction line end the record', () => {
  const c = addCircle(EMPTY_SKETCH, [0, 0], 2, { size: true, position: true });
  const made = linearPattern(c.sketch, [c.circleId], 3, [1, 0], 10)!;
  const record = made.sketch.patterns![0]!;
  const copy = record.created.find((x) => x.startsWith('c'))!;
  const withoutCopy = deleteItems(made.sketch, [copy]);
  assert.equal(withoutCopy.patterns?.length, 1, 'a deleted copy keeps the pattern editable');
  assert.ok(!withoutCopy.patterns![0]!.created.includes(copy));
  assert.equal(deleteItems(made.sketch, record.lines!).patterns, undefined, 'direction line gone');
  assert.equal(deleteItems(made.sketch, [c.circleId]).patterns, undefined, 'source gone');
  // Invalid records are refused by the file validator.
  const bad = { ...made.sketch, patterns: [{ ...record, count: 1 }] };
  assert.match(validateSketchData(bad as never)?.path ?? '', /patterns\[0\]\.count/);
});
