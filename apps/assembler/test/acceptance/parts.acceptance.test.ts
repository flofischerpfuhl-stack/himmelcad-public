/**
 * PLAN §7 mandatory parts, built through the canonical agent API on the real
 * kernel (headless path) and checked by numbers: enclosure with lid (shell,
 * lip with clearance, screw bosses with holes), holder with slot, pipe
 * adapter (revolve), the cable-clip template, an imported STEP adapted by a
 * new feature, a static multi-body assembly (align) and a multicolour 3MF.
 * The enclosure, bracket and clip are the Home screen's templates
 * (`templates/projectTemplates.ts`) — the same builders the app runs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDemoDocument } from '../../renderer/src/foundation/document/document.js';
import { projectTemplate } from '../../renderer/src/templates/projectTemplates.js';
import {
  bboxIs,
  bodies,
  bodyNamed,
  call,
  evidence,
  export3mf,
  exportStlWatertight,
  near,
  reset,
  roundedRectArea,
  store,
  type Json,
} from './harness.js';

const apiCall = (method: string, params: Json = {}) => call(method, params);

/** Hand calculations of the enclosure template (defaults: 80 × 60 × 30, wall 2). */
const ENCLOSURE_VOLUME =
  roundedRectArea(80, 60, 4) * 30 -
  roundedRectArea(76, 56, 2) * 28 +
  4 * Math.PI * 3.5 ** 2 * 24 -
  4 * Math.PI * 1.25 ** 2 * 20;
const LID_VOLUME =
  roundedRectArea(80, 60, 4) * 2 +
  roundedRectArea(75.6, 55.6, 1.8) * 3 -
  4 * Math.PI * 1.7 ** 2 * 5;

void test('A1 enclosure with lid: shell, screw bosses with pilot holes, lid with a 0.2 mm lip clearance', async (t) => {
  await reset('Enclosure');
  await projectTemplate('enclosure').build(apiCall);
  const all = await bodies();
  assert.equal(all.length, 2, 'two bodies: enclosure and lid');
  assert.ok(
    all.every((b) => b.valid),
    'valid B-rep',
  );
  const enclosure = await bodyNamed('Enclosure');
  const lid = await bodyNamed('Lid');
  bboxIs(enclosure, [0, 0, 0], [80, 60, 30]);
  bboxIs(lid, [90, 0, 0], [170, 60, 5]);
  near(enclosure.volume, ENCLOSURE_VOLUME, 1e-6, 'enclosure volume');
  near(lid.volume, LID_VOLUME, 1e-6, 'lid volume');

  // The screw bosses and their pilot holes: 4 cylinders Ø7 and 4 holes Ø2.5 (exact B-rep faces).
  const cylinders = await call<{ centroid: number[]; area: number }[]>('faces.list', {
    bodyId: enclosure.id,
    select: '%CYLINDER',
  });
  const circles = await call<{ radius: number }[]>('edges.list', {
    bodyId: enclosure.id,
    select: '%CIRCLE',
  });
  const radii = circles.map((c) => Math.round(c.radius * 1000) / 1000);
  assert.equal(radii.filter((r) => r === 3.5).length >= 4, true, 'boss rims Ø7');
  assert.equal(radii.filter((r) => r === 1.25).length >= 4, true, 'pilot holes Ø2.5');

  // Parameters drive the history: a wider box re-solves both sketches, lid and lip follow.
  const params = await call<{ name: string; value: number }[]>('parameters.list');
  assert.deepEqual(
    params.map((p) => `${p.name}=${p.value}`),
    ['width=80', 'depth=60', 'height=30', 'wall=2', 'clearance=0.2', 'screw_clear=3.4'],
  );
  const widened = await call<{ errors: Json; changedFeatureIds: string[] }>('parameter.edit', {
    parameterId: 'width',
    value: 100,
  });
  assert.deepEqual(widened.errors, {}, 'the whole history re-evaluates cleanly');
  bboxIs(await bodyNamed('Enclosure'), [0, 0, 0], [100, 60, 30]);
  bboxIs(await bodyNamed('Lid'), [110, 0, 0], [210, 60, 5]);
  await call('history.undo');
  bboxIs(await bodyNamed('Enclosure'), [0, 0, 0], [80, 60, 30]);

  const stl = await exportStlWatertight();
  const { model } = await export3mf();
  evidence(t, 'A1-enclosure', {
    bodies: all.map((b) => ({ name: b.name, volume: b.volume, bbox: b.bbox.size, valid: b.valid })),
    expected: { enclosure: ENCLOSURE_VOLUME, lid: LID_VOLUME },
    cylinderFaces: cylinders.length,
    widenTo100: 'bbox 100 × 60 × 30, lid at x = 110, undo restores 80',
    stlTriangles: stl.triangles,
    threeMfObjects: model.objects.size,
  });
});

void test('A5 static multi-body assembly: the lid aligned onto the enclosure seats with 0.2 mm clearance', async (t) => {
  await reset('Assembly');
  await projectTemplate('enclosure').build(apiCall);
  const enclosure = (await bodyNamed('Enclosure')).id;
  const lid = (await bodyNamed('Lid')).id;
  // Flip the lid (lip down), then align its plate face onto the rim, centred.
  await call('feature.create', {
    kind: 'transform',
    params: { bodyId: lid, rx: 180, pivot: [130, 30, 2.5] },
  });
  const plateFace = await call<{ key: string }[]>('faces.list', {
    bodyId: lid,
    select: '-Z and >Z',
  });
  assert.equal(plateFace.length, 1, 'the lid plate face around the lip');
  await call('feature.create', {
    kind: 'align',
    params: {
      bodyId: lid,
      face: { bodyId: lid, key: plateFace[0]!.key },
      target: { bodyId: enclosure, select: '>Z' },
    },
  });
  const seated = await bodyNamed('Lid');
  assert.ok(seated.valid);
  bboxIs(seated, [0, 0, 27], [80, 60, 32], 1e-6);

  // Exact kernel distances: lip side ↔ inner wall = clearance; lip end ↔ boss tops = 1 mm.
  const gap = async (a: Json, b: Json) =>
    (
      await call<{ distance: number }>('measure.distance', {
        a: { kind: 'face', face: a },
        b: { kind: 'face', face: b },
      })
    ).distance;
  const innerLeft = (
    await call<{ key: string; centroid: number[] }[]>('faces.list', {
      bodyId: enclosure,
      select: '+X',
    })
  ).find((f) => Math.abs(f.centroid[0]! - 2) < 1e-6)!;
  const lipLeft = (
    await call<{ key: string; centroid: number[] }[]>('faces.list', { bodyId: lid, select: '-X' })
  ).find((f) => f.centroid[2]! < 30)!;
  const clearance = await gap(
    { bodyId: lid, key: lipLeft.key },
    { bodyId: enclosure, key: innerLeft.key },
  );
  near(clearance, 0.2, 1e-6, 'lip clearance');
  const touching = (
    await call<{ distance: number }>('measure.distance', {
      a: { kind: 'body', bodyId: lid },
      b: { kind: 'body', bodyId: enclosure },
    })
  ).distance;
  near(touching, 0, 1e-6, 'the lid rests on the rim');
  // The lip ends 1 mm above the screw bosses.
  const lipEnd = { bodyId: lid, select: '-Z and <Z' };
  const bossTop = (
    await call<{ key: string; centroid: number[] }[]>('faces.list', {
      bodyId: enclosure,
      select: '+Z',
    })
  ).find((f) => Math.abs(f.centroid[2]! - 26) < 1e-6)!;
  const bossGap = await gap(lipEnd, { bodyId: enclosure, key: bossTop.key });
  near(bossGap, 1, 1e-6, 'lip end above the bosses');
  evidence(t, 'A5-assembly', {
    lidBbox: seated.bbox,
    lipClearanceMm: clearance,
    lidToEnclosureMm: touching,
    lipToBossMm: bossGap,
  });
});

void test('A2 holder with slot: L-bracket, slot entity, screw holes, rounds — volume by hand', async (t) => {
  await reset('Bracket');
  await projectTemplate('bracket').build(apiCall);
  const bracket = await bodyNamed('Bracket');
  assert.ok(bracket.valid);
  assert.equal((await bodies()).length, 1);
  bboxIs(bracket, [0, 0, 0], [60, 30, 45]);
  const expected =
    60 * 30 * 5 +
    60 * 5 * 40 +
    (16 - Math.PI * 4) * 60 -
    (14 * 6 + Math.PI * 9) * 5 -
    2 * Math.PI * 2.5 ** 2 * 5 -
    2 * (9 - (Math.PI * 9) / 4) * 5;
  near(bracket.volume, expected, 1e-6, 'bracket volume');
  // The slot is one sketch slot entity (dimensioned centre distance and width).
  const sketches = await call<{ id: string; dimensions: { value: number }[] }[]>('sketches.list');
  const slot = sketches.find((s) => s.dimensions.some((d) => Math.abs(d.value - 14) < 1e-9));
  assert.ok(slot, 'a sketch with the 14 mm slot centre distance');
  const stl = await exportStlWatertight();
  evidence(t, 'A2-bracket', {
    volume: bracket.volume,
    expected,
    bbox: bracket.bbox.size,
    stlTriangles: stl.triangles,
  });
});

void test('A3 pipe adapter by revolve: stepped reducer with socket, volume π·1875', async (t) => {
  await reset('Pipe adapter');
  const sketch = await call<{ featureId: string }>('feature.create', {
    kind: 'sketch',
    params: { plane: { kind: 'plane', plane: 'XZ', offset: 0 } },
  });
  await call('sketch.addPolyline', {
    featureId: sketch.featureId,
    points: [
      [13, 0],
      [15, 0],
      [15, 15],
      [10, 15],
      [10, 35],
      [8, 35],
      [8, 12],
      [13, 12],
    ],
    closed: true,
  });
  const axis = await call<{ lineIds: string[] }>('sketch.addPolyline', {
    featureId: sketch.featureId,
    points: [
      [0, -5],
      [0, 40],
    ],
    construction: true,
  });
  await call('feature.create', {
    kind: 'revolve',
    params: {
      profile: { kind: 'sketch', featureId: sketch.featureId },
      axis: { kind: 'sketchLine', featureId: sketch.featureId, entityId: axis.lineIds[0] },
      angle: 360,
      resultBodyName: 'Adapter',
    },
  });
  const adapter = await bodyNamed('Adapter');
  assert.ok(adapter.valid);
  bboxIs(adapter, [-15, -15, 0], [15, 15, 35], 1e-6);
  near(adapter.volume, Math.PI * 1875, 1e-6, 'adapter volume');
  const stl = await exportStlWatertight();
  evidence(t, 'A3-pipe-adapter', {
    volume: adapter.volume,
    expected: Math.PI * 1875,
    bbox: adapter.bbox,
    stlTriangles: stl.triangles,
  });
});

void test('template: cable clip evaluates valid with the hand-calculated volume', async (t) => {
  await reset('Cable clip');
  await projectTemplate('cableClip').build(apiCall);
  const clip = await bodyNamed('Cable clip');
  assert.ok(clip.valid);
  const d = 6;
  const segment = 49 * Math.acos(d / 7) - d * Math.sqrt(49 - d * d);
  const steps = 20000;
  let openingArea = 0;
  for (let i = 0; i < steps; i += 1) {
    const x = -2.5 + ((i + 0.5) * 5) / steps;
    openingArea += (Math.sqrt(49 - x * x) - Math.sqrt(25 - x * x)) * (5 / steps);
  }
  const expected =
    Math.PI * 49 * 8 +
    24 * 5 * 8 -
    segment * 8 -
    Math.PI * 25 * 8 -
    openingArea * 8 -
    2 * Math.PI * 1.75 ** 2 * 5 -
    2 * (2.25 - (Math.PI * 2.25) / 4) * 8;
  near(clip.volume, expected, 1e-3, 'clip volume');
  evidence(t, 'template-cable-clip', { volume: clip.volume, expected, bbox: clip.bbox.size });
});

void test('A4 imported STEP adapted: the demo part exported as STEP, imported, a hole added', async (t) => {
  // The demo bracket (the app's start document) → STEP (exact B-rep, AP214).
  store.getState().loadDocument(createDemoDocument(), { projectName: 'Demo' });
  await store.getState().whenSettled();
  const demo = (await bodies())[0]!;
  const step = await call<{ data: string; byteLength: number }>('export.step');
  assert.ok(step.byteLength > 1000);

  await reset('Imported');
  const imported = await call<{ featureId: string; createdBodyIds: string[] }>('import.step', {
    data: step.data,
    fileName: 'demo-bracket.step',
  });
  assert.equal(imported.createdBodyIds.length, 1, 'one body from the STEP file');
  const bodyId = imported.createdBodyIds[0]!;
  const before = (await bodies())[0]!;
  assert.ok(before.valid);
  near(before.volume, demo.volume, 1e-6, 'STEP round trip keeps the volume');
  for (let i = 0; i < 3; i += 1) near(before.bbox.size[i]!, demo.bbox.size[i]!, 1e-6, 'bbox');

  // Adapt it: a Ø5 through hole in its top face (an imported face is referenced like any other).
  const top = await call<{ key: string; centroid: number[]; area: number }[]>('faces.list', {
    bodyId,
    select: '+Z and >Z',
  });
  assert.equal(top.length, 1);
  const [cx, cy, cz] = top[0]!.centroid as [number, number, number];
  const bottomZ = before.bbox.min[2]!;
  await call('feature.create', {
    kind: 'hole',
    params: {
      face: { bodyId, key: top[0]!.key },
      placements: [{ kind: 'point', u: cx, v: cy }],
      diameter: 5,
      extent: { kind: 'blind', depth: 2 },
    },
  });
  const after = (await bodies())[0]!;
  assert.ok(after.valid);
  near(before.volume - after.volume, Math.PI * 2.5 ** 2 * 2, 1e-6, 'removed hole volume');
  // Save/reopen keeps the embedded STEP and the new feature.
  const saved = await call<{ text: string }>('project.save');
  await reset('Scratch');
  const reopened = await call<{ errors: Json; featureCount: number }>('project.open', {
    text: saved.text,
  });
  assert.deepEqual(reopened.errors, {});
  assert.equal(reopened.featureCount, 2);
  near((await bodies())[0]!.volume, after.volume, 1e-9, 'reopened volume');
  evidence(t, 'A4-step-import', {
    stepBytes: step.byteLength,
    demoVolume: demo.volume,
    importedVolume: before.volume,
    topFace: { centroid: [cx, cy, cz], bottomZ },
    afterHoleVolume: after.volume,
    reopenedFeatures: reopened.featureCount,
  });
});

void test('A6 multicolour 3MF: one object per body with its colour, validator clean', async (t) => {
  await reset('Colours');
  await projectTemplate('enclosure').build(apiCall);
  const { model, bytes } = await export3mf();
  const objects = [...model.objects.values()];
  assert.equal(objects.length, 2, 'one object per body');
  const colourOf = (object: (typeof objects)[number]): string => {
    const group = object.pid !== undefined ? model.baseMaterials.get(object.pid) : undefined;
    const colour =
      group?.[object.pindex ?? 0]?.color ??
      (object.pid !== undefined ? model.colorGroups.get(object.pid)?.[object.pindex ?? 0] : '');
    return (colour ?? '').slice(0, 7).toUpperCase();
  };
  const byName = new Map(objects.map((o) => [o.name, colourOf(o)]));
  assert.equal(byName.get('Enclosure'), '#5B7FA6');
  assert.equal(byName.get('Lid'), '#D9A441');
  assert.equal(model.items.length, 2, 'two build items');
  evidence(t, 'A6-multicolour-3mf', {
    bytes,
    objects: objects.map((o) => ({
      name: o.name,
      colour: colourOf(o),
      triangles: o.triangles.length,
    })),
    unit: model.unit,
  });
});
