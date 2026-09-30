/**
 * Benchmark parts for the kernel (shared by `kernelBench.ts`, the leak
 * session and the incremental-evaluation tests): the demo bracket, the
 * 9-feature part of `features.test.ts` and a synthetic 60-feature plate.
 * Each part is a family of documents so edits and previews can use fresh
 * values (`v`) that no cache has seen before.
 */

import { createDemoDocument } from '../../renderer/src/foundation/commands/demoDocument.js';
import type {
  EdgeRef,
  ExtrudeFeature,
  FaceRef,
  Feature,
  FilletFeature,
  Plane,
} from '../../renderer/src/foundation/document/document.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import type { PatternFeature, RevolveFeature } from '../../renderer/src/modules/modeling/features.js';
import {
  addCircle,
  addRectangle,
  sketchFromLegacyProfiles,
  type LegacySketchProfile,
} from '../../renderer/src/foundation/sketch-solver/builders.js';
import {
  EMPTY_SKETCH,
  type SketchData,
} from '../../renderer/src/foundation/sketch-solver/types.js';

const base = (id: string, name = id) => ({ id, name, suppressed: false });

export function sketch(
  id: string,
  plane: Plane,
  offset: number,
  ...profiles: LegacySketchProfile[]
): SketchFeature {
  const { sketch: data } = sketchFromLegacyProfiles(profiles);
  return { ...base(id), kind: 'sketch', plane: { kind: 'plane', plane, offset }, ...data };
}

export function extrude(
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

/** Edge reference by key; the signature only matters for the geometric fallback. */
export function edge(
  bodyId: string,
  faceA: string,
  faceB: string,
  midpoint: [number, number, number],
): EdgeRef {
  const [a, b] = [faceA, faceB].sort();
  return {
    bodyId,
    key: `${a}|${b}`,
    signature: { curve: 'line', midpoint, length: 1, direction: null },
  };
}

export function faceRef(bodyId: string, key: string, centroid: [number, number, number]): FaceRef {
  return {
    bodyId,
    key,
    signature: { surface: 'plane', normal: null, centroid, area: 1, adjacentFaces: 4 },
  };
}

export function fillet(id: string, edges: EdgeRef[], radius: number): FilletFeature {
  return { ...base(id), kind: 'fillet', edges, radius };
}

export interface BenchPart {
  name: string;
  /** The document with parameter value `v` of the edited features (v = 0: the base document). */
  document(v?: number): Feature[];
  /** The document with feature #2 edited to variant `v`. */
  editSecond(v: number): Feature[];
  /** The document with the last feature edited to variant `v`. */
  editLast(v: number): Feature[];
  /** A provisional (tool preview) feature appended to the base document, variant `v`. */
  preview(v: number): Feature;
}

// ---- (a) demo bracket ------------------------------------------------------------

export const demoBracket: BenchPart = {
  name: 'demo bracket (7 features)',
  document: () => createDemoDocument(),
  editSecond(v) {
    return createDemoDocument().map((f) =>
      f.id === 'feature-extrude-1' && f.kind === 'extrude'
        ? { ...f, distance: 6 + 0.01 * (v + 1) }
        : f,
    );
  },
  editLast(v) {
    return createDemoDocument().map((f) =>
      f.id === 'feature-extrude-5' && f.kind === 'extrude'
        ? { ...f, distance: -8 - 0.01 * (v + 1) }
        : f,
    );
  },
  preview(v) {
    return {
      ...base('__preview_extrude__', 'Extrude (preview)'),
      kind: 'extrude',
      profile: {
        kind: 'face',
        face: faceRef('body:feature-extrude-1', 'feature-extrude-2:end:0', [40, 46, 46]),
      },
      distance: 2 + 0.1 * v,
      symmetric: false,
      operation: 'join',
    };
  },
};

// ---- (b) the 9-feature part of features.test.ts ---------------------------------------

function ninePart(height: number, splitAt: number): Feature[] {
  const revolve: RevolveFeature = {
    ...base('groove'),
    kind: 'revolve',
    profile: { kind: 'sketch', featureId: 'g' },
    axis: { kind: 'world', axis: 'Z' },
    angle: 360,
    operation: 'cut',
    targetBodyId: 'body:shaft',
  };
  const pattern: PatternFeature = {
    ...base('pat'),
    kind: 'pattern',
    bodyIds: ['body:lug'],
    pattern: { kind: 'circular', axis: { kind: 'world', axis: 'Z' }, count: 4, angle: 360 },
  };
  return [
    sketch('s', 'XY', 0, { kind: 'circle', cx: 0, cy: 0, radius: 12 }),
    extrude('shaft', 's', height),
    sketch('g', 'XZ', 0, { kind: 'rectangle', x: 10, y: 10, width: 4, height: 3 }),
    revolve,
    sketch('lug-s', 'XY', 0, { kind: 'rectangle', x: 12, y: -4, width: 10, height: 8 }),
    extrude('lug', 'lug-s', 6),
    pattern,
    {
      ...base('mir'),
      kind: 'mirror',
      bodyIds: ['body:shaft'],
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      keepOriginal: true,
    },
    {
      ...base('cut'),
      kind: 'split',
      bodyId: 'body:shaft',
      plane: { kind: 'plane', plane: 'XY', offset: splitAt },
    },
  ];
}

export const ninePartBench: BenchPart = {
  name: 'features-branch part (9 features)',
  document: () => ninePart(40, 20),
  editSecond: (v) => ninePart(40 + 0.1 * (v + 1), 20),
  editLast: (v) => ninePart(40, 20 + 0.1 * (v + 1)),
  preview(v) {
    return {
      ...base('__preview_extrude__', 'Extrude (preview)'),
      kind: 'extrude',
      profile: { kind: 'face', face: faceRef('body:lug', 'lug:end:0', [17, 0, 6]) },
      distance: 1 + 0.1 * v,
      symmetric: false,
      operation: 'join',
    };
  },
};

// ---- (c) synthetic 60-feature plate --------------------------------------------------

const PLATE = { w: 200, d: 120, h: 20 };
const HOLE_ROWS = 5;
const HOLES_PER_ROW = 8;
const BOSSES = 10;

/**
 * Plate 200 × 120 × 20 with rounded vertical edges, shelled open at the
 * bottom (2 mm walls), 40 holes (5 rows × linear pattern of 8 pins,
 * subtracted), 10 bosses on top, each with a filleted top edge, a chamfered
 * top outline, a move, a colour and a final boss fillet as the last feature.
 * 60 features.
 */
function sixtyPart(p: { plateHeight: number; lastRadius: number }): Feature[] {
  const out: Feature[] = [];
  out.push(
    sketch('plate-s', 'XY', 0, { kind: 'rectangle', x: 0, y: 0, width: PLATE.w, height: PLATE.d }),
  );
  out.push(extrude('plate', 'plate-s', p.plateHeight, { resultBodyName: 'Plate' }));
  const body = 'body:plate';
  const side = (l: string) => `plate:side:0:${l}`;
  const corners: [string, string, [number, number, number]][] = [
    ['l1', 'l2', [PLATE.w, 0, p.plateHeight / 2]],
    ['l2', 'l3', [PLATE.w, PLATE.d, p.plateHeight / 2]],
    ['l3', 'l4', [0, PLATE.d, p.plateHeight / 2]],
    ['l4', 'l1', [0, 0, p.plateHeight / 2]],
  ];
  corners.forEach(([a, b, mid], i) => {
    out.push(fillet(`corner-${i}`, [edge(body, side(a), side(b), mid)], 6));
  });
  out.push({
    ...base('shell'),
    kind: 'shell',
    bodyId: body,
    faces: [faceRef(body, 'plate:start:0', [PLATE.w / 2, PLATE.d / 2, 0])],
    thickness: 2,
  });
  for (let r = 0; r < HOLE_ROWS; r += 1) {
    const y = 20 + r * 20;
    out.push(sketch(`pin-s-${r}`, 'XY', -1, { kind: 'circle', cx: 30, cy: y, radius: 2.5 }));
    out.push(extrude(`pin-${r}`, `pin-s-${r}`, p.plateHeight + 2));
    out.push({
      ...base(`pins-${r}`),
      kind: 'pattern',
      bodyIds: [`body:pin-${r}`],
      pattern: {
        kind: 'linear',
        direction: { kind: 'world', axis: 'X' },
        count: HOLES_PER_ROW,
        spacing: 20,
      },
    } satisfies PatternFeature);
    const copies = Array.from({ length: HOLES_PER_ROW - 1 }, (_, k) => `body:pins-${r}:${k + 1}`);
    out.push({
      ...base(`holes-${r}`),
      kind: 'boolean',
      operation: 'subtract',
      targetBodyId: body,
      toolBodyIds: [`body:pin-${r}`, ...copies],
    });
  }
  for (let b = 0; b < BOSSES; b += 1) {
    const x = 20 + (b % 5) * 40;
    const y = b < 5 ? 10 : 110;
    out.push(
      sketch(`boss-s-${b}`, 'XY', p.plateHeight, { kind: 'circle', cx: x, cy: y, radius: 4 }),
    );
    out.push(extrude(`boss-${b}`, `boss-s-${b}`, 6, { operation: 'join', targetBodyId: body }));
  }
  for (let b = 0; b < BOSSES - 1; b += 1) {
    const top = `boss-${b}:end:0`;
    const wall = `boss-${b}:side:0:c1`;
    out.push(fillet(`boss-round-${b}`, [edge(body, top, wall, [0, 0, p.plateHeight + 6])], 1));
  }
  out.push({
    ...base('edge-chamfer'),
    kind: 'chamfer',
    edges: [edge(body, 'plate:end:0', side('l1'), [PLATE.w / 2, 0, p.plateHeight])],
    distance: 1,
  });
  // The front chamfer runs around the whole top outline (a tangent chain through the corner
  // rounds), so the next feature moves the plate instead: keys survive rigid motions.
  out.push({
    ...base('shift'),
    kind: 'transform',
    bodyId: body,
    dx: 5,
    dy: 0,
    dz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    pivot: [0, 0, 0],
    copy: false,
  });
  out.push({ ...base('colour'), kind: 'setAppearance', bodyId: body, color: '#9AAE9B' });
  const last = BOSSES - 1;
  out.push(
    fillet(
      `boss-round-${last}`,
      [edge(body, `boss-${last}:end:0`, `boss-${last}:side:0:c1`, [0, 0, p.plateHeight + 6])],
      p.lastRadius,
    ),
  );
  return out;
}

export const sixtyPartBench: BenchPart = {
  name: 'synthetic plate (60 features)',
  document: () => sixtyPart({ plateHeight: 20, lastRadius: 1 }),
  editSecond: (v) => sixtyPart({ plateHeight: 20 + 0.05 * (v + 1), lastRadius: 1 }),
  editLast: (v) => sixtyPart({ plateHeight: 20, lastRadius: 1 + 0.05 * (v + 1) }),
  preview(v) {
    return {
      ...base('__preview_extrude__', 'Extrude (preview)'),
      kind: 'extrude',
      profile: { kind: 'face', face: faceRef('body:plate', 'boss-3:end:0', [140, 10, 26]) },
      distance: 1 + 0.1 * v,
      symmetric: false,
      operation: 'join',
    };
  },
};

export const BENCH_PARTS: readonly BenchPart[] = [demoBracket, ninePartBench, sixtyPartBench];

/**
 * A sketch of 60 entities for the interactive bench's drag scenario: five
 * rectangles (horizontal/vertical rules, free size) and ten dimensioned
 * circles. `corner` is a free corner point of the middle rectangle.
 */
export function sixtyEntitySketch(): {
  feature: SketchFeature;
  corner: string;
  start: [number, number];
} {
  let data: SketchData = EMPTY_SKETCH;
  let corner = '';
  for (let i = 0; i < 5; i += 1) {
    const r = addRectangle(data, [i * 30, 0], [i * 30 + 20, 15]);
    data = r.sketch;
    if (i === 2) corner = r.pointIds[2]!;
  }
  for (let i = 0; i < 10; i += 1)
    data = addCircle(data, [i * 15 + 5, 40], 4, { size: true }).sketch;
  if (data.entities.length !== 60)
    throw new Error(`expected 60 entities, got ${data.entities.length}`);
  const point = data.entities.find((e) => e.id === corner);
  if (point?.kind !== 'point') throw new Error('corner point');
  return {
    feature: {
      ...base('bench-sketch', 'Sketch 1'),
      kind: 'sketch',
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      ...data,
    },
    corner,
    start: [point.x, point.y],
  };
}
