import assert from 'node:assert/strict';
import test from 'node:test';

import type { Feature } from '../../renderer/src/foundation/document/document.js';
import { withBodyColour, withBodyMaterial } from '../../renderer/src/model/appearance.js';
import {
  circleThrough,
  closestPointOnTriangle,
  currentRefs,
  measure,
  meshMinDistance,
  meshVolume,
  snapMeasurePoint,
  snapPoints,
  type MeasureContext,
} from '../../renderer/src/model/measure.js';
import { formatMeasureValue } from '../../renderer/src/model/measureLive.js';
import { parsePins, serializePins } from '../../renderer/src/model/measureStore.js';
import {
  parseSectionPlane,
  sectionPlaneFromFace,
  viewDisplayFromProject,
  viewDisplayToProject,
} from '../../renderer/src/model/viewDisplay.js';
import { bodyMaterials } from '../../renderer/src/platform/viewport/displayModes.js';
import { boxBody, cylinderBody } from '../viewport/meshFixtures.js';

const a = boxBody('a', [0, 0, 0], [10, 10, 10]);
const b = boxBody('b', [20, 0, 0], [30, 10, 10]);
const cyl = cylinderBody('c', 3, 6);
const ctx: MeasureContext = { bodies: [a, b, cyl] };
const value = (m: ReturnType<typeof measure>, label: string) =>
  m?.values.find((v) => v.label === label)?.value;

void test('measure: a body gives W × D × H, volume, mass (PLA unless a material is set)', () => {
  const m = measure([{ kind: 'body', bodyId: 'body:a' }], ctx)!;
  assert.equal(m.title, 'Body');
  assert.equal(value(m, 'Width (X)'), 10);
  assert.equal(value(m, 'Volume'), 1000);
  // 1000 mm³ × 1.24 g/cm³ = 1.24 g
  assert.ok(Math.abs(m.values.find((v) => v.kind === 'mass')!.value - 1.24) < 1e-9);
  const metal = measure([{ kind: 'body', bodyId: 'body:a' }], {
    ...ctx,
    materials: new Map([['body:a', 'metal']]),
  })!;
  assert.ok(Math.abs(metal.values.find((v) => v.kind === 'mass')!.value - 2.7) < 1e-9);
  assert.equal(m.graphics.length, 3);
});

void test('measure: circle edge → diameter; line edge → length; faces → area and cylinder diameter', () => {
  const circle = measure([{ kind: 'edge', bodyId: 'body:c', edgeKey: 'c:top' }], ctx)!;
  assert.equal(circle.title, 'Circle');
  assert.equal(value(circle, 'Diameter'), 6);
  const line = measure([{ kind: 'edge', bodyId: 'body:a', edgeKey: 'a:e0' }], ctx)!;
  assert.equal(value(line, 'Length'), 10);
  const face = measure([{ kind: 'face', bodyId: 'body:a', faceKey: 'a:top' }], ctx)!;
  assert.equal(value(face, 'Area'), 100);
  const side = measure([{ kind: 'face', bodyId: 'body:c', faceKey: 'c:side' }], ctx)!;
  assert.equal(value(side, 'Diameter'), 6);
});

void test('measure: parallel faces → distance; perpendicular faces → angle', () => {
  const parallel = measure(
    [
      { kind: 'face', bodyId: 'body:a', faceKey: 'a:right' },
      { kind: 'face', bodyId: 'body:b', faceKey: 'b:left' },
    ],
    ctx,
  )!;
  assert.equal(parallel.title, 'Parallel faces');
  assert.equal(value(parallel, 'Distance'), 10);
  const angle = measure(
    [
      { kind: 'face', bodyId: 'body:a', faceKey: 'a:top' },
      { kind: 'face', bodyId: 'body:a', faceKey: 'a:right' },
    ],
    {
      ...ctx,
      distance: () => ({ distance: 0, pointA: [10, 5, 10], pointB: [10, 5, 10], approx: false }),
    },
  )!;
  assert.equal(value(angle, 'Angle'), 90);
  assert.equal(value(angle, 'Minimum distance'), 0);
});

void test('measure: two bodies use the kernel distance when available, else an approx. mesh estimate', () => {
  const refs = [
    { kind: 'body', bodyId: 'body:a' },
    { kind: 'body', bodyId: 'body:b' },
  ] as const;
  const pending = measure([...refs], { ...ctx, distance: () => 'pending' })!;
  assert.equal(pending.pending, true);
  const exact = measure([...refs], {
    ...ctx,
    distance: () => ({ distance: 10, pointA: [10, 0, 0], pointB: [20, 0, 0], approx: false }),
  })!;
  const exactValue = exact.values.find((v) => v.label === 'Minimum distance')!;
  assert.equal(exactValue.value, 10);
  assert.equal(exactValue.approx, undefined);
  const approx = measure([...refs], ctx)!;
  const approxValue = approx.values.find((v) => v.label === 'Minimum distance')!;
  assert.ok(Math.abs(approxValue.value - 10) < 1e-6);
  assert.equal(approxValue.approx, true);
  assert.match(formatMeasureValue(approxValue, 'mm'), /^≈ 10 mm$/);
});

void test('measure: points and circle centres give point-to-point distances', () => {
  const m = measure(
    [
      { kind: 'point', point: [0, 0, 0], label: 'Vertex' },
      { kind: 'point', point: [3, 4, 0], label: 'Vertex' },
    ],
    ctx,
  )!;
  assert.equal(m.title, 'Point to point');
  assert.equal(value(m, 'Distance'), 5);
  const centres = measure(
    [
      { kind: 'edge', bodyId: 'body:c', edgeKey: 'c:top' },
      { kind: 'edge', bodyId: 'body:c', edgeKey: 'c:bottom' },
    ],
    ctx,
  )!;
  assert.equal(centres.title, 'Centre distance');
  assert.ok(Math.abs(value(centres, 'Distance')! - 6) < 1e-5);
});

void test('measure: several bodies; a vanished reference; nothing selected', () => {
  const many = measure(
    [
      { kind: 'body', bodyId: 'body:a' },
      { kind: 'body', bodyId: 'body:b' },
      { kind: 'body', bodyId: 'body:c' },
    ],
    ctx,
  )!;
  assert.equal(value(many, 'Width (X)'), 33);
  const gone = measure([{ kind: 'body', bodyId: 'body:nope' }], ctx)!;
  assert.match(gone.note!, /no longer exists/);
  assert.equal(measure([], ctx), null);
  assert.deepEqual(currentRefs([{ kind: 'body', bodyId: 'x' }], []), [
    { kind: 'body', bodyId: 'x' },
  ]);
});

void test('geometry helpers: circle through three points, closest point on a triangle, mesh volume', () => {
  const c = circleThrough([5, 0, 0], [0, 5, 0], [-5, 0, 0])!;
  assert.ok(Math.hypot(...c.center) < 1e-9 && Math.abs(c.radius - 5) < 1e-9);
  assert.equal(circleThrough([0, 0, 0], [1, 1, 1], [2, 2, 2]), null);
  const inside = closestPointOnTriangle([0.2, 0.2, 5], [0, 0, 0], [1, 0, 0], [0, 1, 0]);
  assert.ok(Math.hypot(inside[0] - 0.2, inside[1] - 0.2, inside[2]) < 1e-12);
  assert.deepEqual(closestPointOnTriangle([-1, -1, 0], [0, 0, 0], [1, 0, 0], [0, 1, 0]), [0, 0, 0]);
  assert.ok(Math.abs(meshVolume(a.mesh.positions, a.mesh.indices) - 1000) < 1e-6);
  const d = meshMinDistance(
    { triangles: new Float32Array(0), points: [[0, 0, 5]] },
    { triangles: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), points: [] },
  )!;
  assert.equal(d.distance, 5);
});

void test('snapping: vertices and circle centres near the pointer win, else the surface point', () => {
  const candidates = snapPoints([a, cyl]);
  assert.ok(candidates.some((c) => c.label === 'Centre'));
  const project = (p: readonly number[]): [number, number] => [p[0]! * 10, p[1]! * 10];
  const near = snapMeasurePoint(candidates, project, [101, 1], 10, [9, 0, 0]);
  assert.equal(near?.label, 'Vertex');
  assert.deepEqual(near?.point, [10, 0, 0]);
  const centre = snapMeasurePoint(candidates, project, [2, 1], 10, null);
  assert.equal(centre?.label, 'Centre');
  const surface = snapMeasurePoint(candidates, project, [500, 500], 10, [50, 50, 0]);
  assert.equal(surface?.label, 'Point on face');
});

void test('pins round-trip through the project file; malformed entries are dropped', () => {
  const pins = [
    { id: 'm1', refs: [{ kind: 'body' as const, bodyId: 'body:a' }], showInViewport: true },
    {
      id: 'm2',
      refs: [
        { kind: 'point' as const, point: [1, 2, 3] as [number, number, number], label: 'Vertex' },
      ],
      showInViewport: false,
    },
  ];
  const parsed = parsePins(JSON.parse(JSON.stringify(serializePins(pins))));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0]!.refs, pins[0]!.refs);
  assert.equal(parsed[1]!.showInViewport, false);
  assert.deepEqual(parsePins([{ refs: [{ kind: 'face' }] }, 'x', { refs: [] }]), []);
  assert.deepEqual(parsePins(undefined), []);
});

void test('view display state round-trips; invalid values keep the defaults', () => {
  const view = {
    displayMode: 'zebra',
    edgesVisible: false,
    hiddenEdgesVisible: true,
    axesVisible: false,
    sectionPlane: {
      normal: [0, 0, 1] as [number, number, number],
      origin: [1, 2, 3] as [number, number, number],
      label: 'Face of A',
    },
    sectionOnly: true,
  };
  const saved = viewDisplayToProject(view as never);
  const loaded = viewDisplayFromProject({
    displayMode: saved.displayMode,
    display: saved.display,
    section: saved.sectionExtras,
  });
  assert.equal(loaded.displayMode, 'zebra');
  assert.equal(loaded.edgesVisible, false);
  assert.equal(loaded.hiddenEdgesVisible, true);
  assert.deepEqual(loaded.sectionPlane, view.sectionPlane);
  assert.equal(loaded.sectionOnly, true);
  assert.deepEqual(viewDisplayFromProject({ displayMode: 'toon' as never }), {});
  assert.equal(parseSectionPlane({ normal: [0, 0, 0], origin: [0, 0, 0] }), null);
  assert.deepEqual(parseSectionPlane({ normal: [0, 0, 2], origin: [0, 0, 0] })?.normal, [0, 0, 1]);
});

void test('section at a face: outward normal, offset halfway through the body behind the face', () => {
  const placed = sectionPlaneFromFace(
    { min: [0, 0, 0], max: [80, 50, 46] },
    { normal: [0, -1, 0], centroid: [40, 0, 3] },
    'Front',
  )!;
  assert.deepEqual(placed.plane.normal, [0, -1, 0]);
  assert.equal(placed.offset, -25);
  assert.equal(
    sectionPlaneFromFace(
      { min: [0, 0, 0], max: [1, 1, 1] },
      { normal: null, centroid: [0, 0, 0] },
      'x',
    ),
    null,
  );
});

void test('appearance: material steps keep colours; colour steps keep the material', () => {
  const allocate = (i: number) => ({ id: `app-${i}`, name: `Appearance ${i}` });
  const base: Feature[] = [];
  const withMaterial = withBodyMaterial(
    base,
    0,
    [{ bodyId: 'body:a', color: '#112233' }],
    'petg',
    allocate,
  );
  assert.equal(withMaterial.length, 1);
  assert.equal(bodyMaterials(withMaterial).get('body:a'), 'petg');
  // Changing the colour right after updates that step in place and keeps the material.
  const recoloured = withBodyColour(withMaterial, 1, ['body:a'], '#445566', allocate);
  assert.equal(recoloured.length, 1);
  assert.equal(bodyMaterials(recoloured).get('body:a'), 'petg');
  // A new colour step for the body (another step in between) carries the material over.
  const other = withBodyColour(recoloured, 1, ['body:b'], '#000000', allocate);
  const again = withBodyColour(other, 2, ['body:a'], '#FFFFFF', allocate);
  assert.equal(again.length, 3);
  assert.equal(bodyMaterials(again).get('body:a'), 'petg');
  // Clearing.
  const cleared = withBodyMaterial(
    again,
    3,
    [{ bodyId: 'body:a', color: '#FFFFFF' }],
    null,
    allocate,
  );
  assert.equal(bodyMaterials(cleared).has('body:a'), false);
});
