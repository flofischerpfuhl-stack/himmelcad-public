/**
 * What the HimmelCAD OCCT build (`vendor/occt-wasm`, `HIMMELCAD_OCCT=himmelcad`)
 * adds over `replicad-opencascadejs` 1.1.0, on the real kernel: true Offset
 * Face (neighbours re-extended, `BRepOffset_MakeOffset::SetOffsetOnFace`),
 * Delete Face by `BRepAlgoAPI_Defeaturing`, per-wall shell thickness in one
 * `MakeThickSolid`, and an IGES round trip. Volumes against hand
 * calculations. Skipped on the replicad build (the module lacks the classes).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { selectedOcctModule } from '../../headless/occtModule.js';
import { faceSignatureOf } from '../../renderer/src/foundation/geometry-kernel/naming.js';
import { occtExtras } from '../../renderer/src/foundation/geometry-kernel/occtExtras.js';
import type {
  Body,
  EvaluationResult,
} from '../../renderer/src/foundation/geometry-kernel/types.js';
import type {
  ExtrudeFeature,
  FaceRef,
  Feature,
  Plane,
  SketchFeature,
} from '../../renderer/src/foundation/document/document.js';
import type { DeleteFaceFeature, OffsetFaceFeature } from '../../renderer/src/model/features.js';
import {
  addPolyline,
  sketchFromLegacyProfiles,
} from '../../renderer/src/foundation/sketch-solver/builders.js';
import { EMPTY_SKETCH } from '../../renderer/src/foundation/sketch-solver/types.js';
import type { LegacySketchProfile } from '../sketch/fixtures.js';
import { loadNodeKernel } from './nodeKernel.js';

const skip = selectedOcctModule() !== 'himmelcad' && 'needs HIMMELCAD_OCCT=himmelcad';

const base = (id: string) => ({ id, name: id, suppressed: false });

function sketch(
  id: string,
  plane: Plane,
  offset: number,
  ...profiles: LegacySketchProfile[]
): SketchFeature {
  const { sketch: data } = sketchFromLegacyProfiles(profiles);
  return { ...base(id), kind: 'sketch', plane: { kind: 'plane', plane, offset }, ...data };
}

function polygon(id: string, plane: Plane, points: [number, number][]): SketchFeature {
  const data = addPolyline(EMPTY_SKETCH, points, { closed: true }).sketch;
  return { ...base(id), kind: 'sketch', plane: { kind: 'plane', plane, offset: 0 }, ...data };
}

function extrude(
  id: string,
  sketchId: string,
  distance: number,
  extra: Partial<ExtrudeFeature> = {},
): ExtrudeFeature {
  return {
    ...base(id),
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketchId },
    distance,
    symmetric: false,
    operation: 'new',
    ...extra,
  };
}

function box(
  id: string,
  x0: number,
  y0: number,
  w: number,
  d: number,
  h: number,
  z0 = 0,
): Feature[] {
  return [
    sketch(`${id}-s`, 'XY', z0, { kind: 'rectangle', x: x0, y: y0, width: w, height: d }),
    extrude(id, `${id}-s`, h),
  ];
}

async function evaluate(features: Feature[]): Promise<EvaluationResult> {
  const { evaluator } = await loadNodeKernel();
  return evaluator.evaluate(features);
}

function only(result: EvaluationResult): Body {
  const body = result.bodies[0];
  assert.ok(body, `a body (errors: ${JSON.stringify(result.errors)})`);
  return body;
}

function near(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: expected ${expected}, got ${actual}`);
}

function faceRef(body: Body, predicate: (f: Body['faces'][number]) => boolean): FaceRef {
  const face = body.faces.find(predicate);
  assert.ok(face, `face found on ${body.id}`);
  return { bodyId: body.id, key: face.key, signature: faceSignatureOf(face) };
}

function facesRefs(body: Body, predicate: (f: Body['faces'][number]) => boolean): FaceRef[] {
  return body.faces
    .filter(predicate)
    .map((face) => ({ bodyId: body.id, key: face.key, signature: faceSignatureOf(face) }));
}

const planeAt = (axis: 0 | 1 | 2, sign: 1 | -1, at: number) => (f: Body['faces'][number]) =>
  f.surface === 'plane' && f.normal?.[axis] === sign && Math.abs(f.centroid[axis] - at) < 1e-6;

void test('the selected module exposes the extra classes', { skip }, async () => {
  const { oc } = await loadNodeKernel();
  assert.ok(occtExtras(oc), 'HimmelcadOffset, BRepAlgoAPI_Defeaturing, IGESControl_* are bound');
});

// A trapezoid prism: bottom 20 wide, top 10 wide, 10 high (sides inclined at
// atan(5/10)), 10 deep. Area (20 + 10) / 2 · 10 = 150, volume 1 500.
function trapezoidPrism(): Feature[] {
  const s = polygon('t-s', 'XZ', [
    [0, 0],
    [20, 0],
    [15, 10],
    [5, 10],
  ]);
  return [s, extrude('t', 't-s', 10)];
}

void test(
  'offset face between inclined neighbours: neighbours re-extend, no step',
  { skip },
  async () => {
    const doc = trapezoidPrism();
    const prism = only(await evaluate(doc));
    near(prism.volume, 1500, 1e-6, 'trapezoid prism');
    const top = faceRef(prism, planeAt(2, 1, 10));
    const offset: OffsetFaceFeature = {
      ...base('o1'),
      kind: 'offsetFace',
      faces: [top],
      distance: 2,
    };
    const result = await evaluate([...doc, offset]);
    assert.deepEqual(result.errors, {});
    const grown = only(result);
    // The sides keep their slope: at z = 12 the top is 10 − 2·(5/10)·2 = 8 wide.
    // Volume (20 + 8) / 2 · 12 · 10 = 1 680 (a slab on the old top would give 1 700 and a step).
    near(grown.volume, 1680, 1e-3, 'true offset volume');
    assert.equal(grown.valid, true);
    assert.equal(grown.faces.length, 6, 'still six faces (no step faces)');
    near(grown.max[2], 12, 1e-6, 'top at z = 12');
    const newTop = grown.faces.find((f) => f.key === top.key);
    assert.ok(newTop, 'the moved top keeps its key');
    near(newTop.area, 8 * 10, 1e-3, 'top 8 × 10');
    // The inclined sides keep their keys and grew.
    for (const side of prism.faces.filter(
      (f) =>
        f.surface === 'plane' &&
        Math.abs(f.normal?.[2] ?? 0) > 1e-6 &&
        Math.abs(f.normal?.[2] ?? 0) < 1,
    )) {
      const after = grown.faces.find((f) => f.key === side.key);
      assert.ok(after, `inclined side ${side.key} keeps its key`);
      assert.ok(after.area > side.area, `inclined side ${side.key} extended`);
    }

    // Inward: −2 → top at z = 8, 10 + 2·(5/10)·2 = 12 wide; (20 + 12) / 2 · 8 · 10 = 1 280.
    const shrunk = only(await evaluate([...doc, { ...offset, distance: -2 }]));
    near(shrunk.volume, 1280, 1e-3, 'inward true offset');
    assert.equal(shrunk.faces.length, 6);
  },
);

void test(
  'delete face: a notch and a boss removed by defeaturing; a plain box face fails clearly',
  { skip },
  async () => {
    const block = box('b', 0, 0, 20, 20, 10);

    // Notch: a 20 × 5 × 4 slot along X cut into the top front edge (y 0..5, z 6..10).
    const notchDoc: Feature[] = [
      ...block,
      sketch('n-s', 'XY', 10, { kind: 'rectangle', x: 0, y: 0, width: 20, height: 5 }),
      extrude('n', 'n-s', -4, { operation: 'cut', targetBodyId: 'body:b' }),
    ];
    const notched = only(await evaluate(notchDoc));
    near(notched.volume, 4000 - 20 * 5 * 4, 1e-6, 'notched block');
    const notchFaces = facesRefs(notched, (f) => f.key.startsWith('n:'));
    assert.ok(
      notchFaces.length >= 2,
      `notch faces (${notched.faces.map((f) => f.key).join(', ')})`,
    );
    const del: DeleteFaceFeature = { ...base('d1'), kind: 'deleteFace', faces: notchFaces };
    const healed = await evaluate([...notchDoc, del]);
    assert.deepEqual(healed.errors, {});
    near(only(healed).volume, 4000, 1e-3, 'notch removed');
    assert.equal(only(healed).valid, true);
    assert.equal(only(healed).faces.length, 6, 'a plain box again');

    // Boss: a 6 × 6 × 5 block on the top, joined; delete its top and four sides.
    const bossDoc: Feature[] = [
      ...block,
      sketch('k-s', 'XY', 10, { kind: 'rectangle', x: 7, y: 7, width: 6, height: 6 }),
      extrude('k', 'k-s', 5, { operation: 'join', targetBodyId: 'body:b' }),
    ];
    const bossed = only(await evaluate(bossDoc));
    near(bossed.volume, 4000 + 180, 1e-6, 'block with boss');
    const bossFaces = facesRefs(bossed, (f) => f.key.startsWith('k:'));
    assert.equal(bossFaces.length, 5, 'boss top + 4 sides');
    const unbossed = await evaluate([...bossDoc, { ...del, faces: bossFaces }]);
    assert.deepEqual(unbossed.errors, {});
    near(only(unbossed).volume, 4000, 1e-3, 'boss removed');
    assert.equal(only(unbossed).faces.length, 6);
    const top = only(unbossed).faces.find(planeAt(2, 1, 10));
    assert.ok(top, 'the block top healed over the boss');
    near(top.area, 400, 1e-3, 'full top');
    assert.equal(
      top.key,
      only(await evaluate(block)).faces.find(planeAt(2, 1, 10))!.key,
      'top keeps its key',
    );

    // A plain box face has no neighbours that could close the gap: a clear error.
    const plain = only(await evaluate(block));
    const failed = await evaluate([
      ...block,
      { ...del, faces: [faceRef(plain, planeAt(2, 1, 10))] },
    ]);
    assert.match(failed.errors.d1 ?? '', /Delete Face/);
  },
);

void test(
  'shell with per-wall thickness in one MakeThickSolid (thicker and thinner walls)',
  { skip },
  async () => {
    // 30 × 20 × 20 block, open top, 2 mm walls; the left wall (x = 0) 4 mm, the right wall 1 mm.
    const block = box('b', 0, 0, 30, 20, 20);
    const plain = only(await evaluate(block));
    const shell: Feature = {
      ...base('sh'),
      kind: 'shell',
      bodyId: plain.id,
      faces: [faceRef(plain, planeAt(2, 1, 20))],
      thickness: 2,
      direction: 'inside',
      faceThickness: [
        { face: faceRef(plain, planeAt(0, -1, 0)), thickness: 4 },
        { face: faceRef(plain, planeAt(0, 1, 30)), thickness: 1 },
      ],
    } as Feature;
    const result = await evaluate([...block, shell]);
    assert.deepEqual(result.errors, {});
    const hollow = only(result);
    // Cavity x 4..29 (25), y 2..18 (16), z 2..20 (18): 12 000 − 25·16·18 = 4 800.
    near(hollow.volume, 30 * 20 * 20 - 25 * 16 * 18, 1e-3, 'per-wall shell volume');
    assert.equal(hollow.valid, true);
  },
);

void test('IGES round trip keeps the solid', { skip }, async () => {
  const { oc } = await loadNodeKernel();
  const extras = occtExtras(oc)!;
  const o = oc as unknown as {
    BRepPrimAPI_MakeBox: new (
      dx: number,
      dy: number,
      dz: number,
    ) => { Shape(): unknown; delete(): void };
    Message_ProgressRange: new () => { delete(): void };
    FS: {
      writeFile(p: string, d: Uint8Array): void;
      readFile(p: string): Uint8Array;
      unlink(p: string): void;
    };
    BRepGProp: {
      VolumeProperties(s: unknown, p: unknown, a: boolean, b: boolean, c: boolean): void;
    };
    GProp_GProps: new () => { Mass(): number; delete(): void };
  };
  const maker = new o.BRepPrimAPI_MakeBox(10, 20, 30);
  const shape = maker.Shape();
  const range = new o.Message_ProgressRange();
  const writer = new extras.IGESControl_Writer('MM', 1);
  assert.ok(writer.AddShape(shape as never, range), 'IGES writer accepted the solid');
  writer.ComputeModel();
  assert.ok(writer.Write('/roundtrip.igs', false), 'IGES file written');
  const bytes = o.FS.readFile('/roundtrip.igs');
  assert.ok(bytes.byteLength > 1000, `IGES file size ${bytes.byteLength}`);

  const reader = new extras.IGESControl_Reader();
  const status = reader.ReadFile('/roundtrip.igs');
  assert.equal(
    status,
    (oc as unknown as { IFSelect_ReturnStatus: { IFSelect_RetDone: unknown } })
      .IFSelect_ReturnStatus.IFSelect_RetDone,
    'IFSelect_RetDone',
  );
  assert.ok(reader.TransferRoots(range) > 0, 'roots transferred');
  const back = reader.OneShape();
  // IGES 5.3 faces come back as a shell/compound of trimmed faces; the area is the check.
  const props = new o.GProp_GProps();
  (
    oc as unknown as {
      BRepGProp: { SurfaceProperties(s: unknown, p: unknown, a: boolean, b: boolean): void };
    }
  ).BRepGProp.SurfaceProperties(back, props, false, false);
  near(props.Mass(), 2 * (10 * 20 + 20 * 30 + 10 * 30), 1e-3, 'surface area after IGES round trip');
  props.delete();
  reader.delete();
  writer.delete();
  range.delete();
  maker.delete();
  o.FS.unlink('/roundtrip.igs');
});
