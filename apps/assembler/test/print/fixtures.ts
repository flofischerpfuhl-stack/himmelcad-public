/**
 * Known geometry for the 3D-printing tests, evaluated by the real OCCT
 * kernel: extruded polygons (sketch polylines), boxes, a shelled box, a
 * plate with holes and a "mushroom" (overhanging cap).
 */
import type { EvaluationResult } from '../../renderer/src/kernel/types.js';
import type {
  ExtrudeFeature,
  Feature,
  Plane,
  SketchFeature,
} from '../../renderer/src/model/document.js';
import { makeFaceRef } from '../../renderer/src/model/store.js';
import { addPolyline } from '../../renderer/src/sketch/builders.js';
import { detectRegions } from '../../renderer/src/sketch/regions.js';
import { EMPTY_SKETCH, type Vec2 } from '../../renderer/src/sketch/types.js';
import { circle, rect, sketchFeature } from '../sketch/fixtures.js';
import { loadNodeKernel } from '../kernel/nodeKernel.js';

/** A sketch of one closed polygon on `plane`. */
export function polygonSketch(
  id: string,
  points: Vec2[],
  plane: Plane = 'XY',
): { feature: SketchFeature; regionKey: string } {
  const { sketch } = addPolyline(EMPTY_SKETCH, points, { closed: true });
  const regions = detectRegions(sketch);
  if (regions.length !== 1) throw new Error(`expected one region, got ${regions.length}`);
  return {
    feature: {
      id,
      name: id,
      suppressed: false,
      kind: 'sketch',
      plane: { kind: 'plane', plane, offset: 0 },
      ...sketch,
    },
    regionKey: regions[0]!.key,
  };
}

export function extrude(
  id: string,
  sketchId: string,
  regions: string[],
  distance: number,
  options: { symmetric?: boolean; name?: string } = {},
): ExtrudeFeature {
  return {
    id,
    name: options.name ?? id,
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketchId, regions },
    distance,
    symmetric: options.symmetric ?? false,
    operation: 'new',
    resultBodyName: options.name ?? id,
  };
}

export async function evaluate(features: Feature[]): Promise<EvaluationResult> {
  const { evaluator } = await loadNodeKernel();
  const result = await evaluator.evaluate(features);
  const errors = Object.entries(result.errors);
  if (errors.length > 0) throw new Error(`evaluation errors: ${JSON.stringify(errors)}`);
  return result;
}

/**
 * A block (profile in the XZ plane, extruded 20 mm along Y) whose right side
 * leans out at 60° from vertical and whose left side leans out at 45°:
 * bottom 10 mm wide at Z = 0, height 10 mm.
 */
export function chamferedBlock(): Feature[] {
  const h = 10;
  const right = 10 + h * Math.tan((60 * Math.PI) / 180);
  const left = -h * Math.tan((45 * Math.PI) / 180);
  const s = polygonSketch(
    'sk',
    [
      [0, 0],
      [10, 0],
      [right, h],
      [left, h],
    ],
    'XZ',
  );
  return [s.feature, extrude('ex', 'sk', [s.regionKey], 20, { name: 'Chamfered' })];
}

/** A `w × d × h` box standing on Z = 0 with a corner at the origin. */
export function boxFeatures(
  prefix: string,
  w: number,
  d: number,
  h: number,
  x = 0,
  y = 0,
): Feature[] {
  const s = sketchFeature(`${prefix}-s`, [rect(x, y, w, d)]);
  return [
    s.feature,
    extrude(`${prefix}-e`, `${prefix}-s`, [s.regionKeys[0]!], h, { name: prefix }),
  ];
}

/** A 30 × 30 × 20 box shelled to `thickness`, top face open. */
export async function shelledBox(thickness: number): Promise<Feature[]> {
  const base = boxFeatures('box', 30, 30, 20);
  const result = await evaluate(base);
  const body = result.bodies[0]!;
  const top = body.faces.find((f) => f.normal && f.normal[2] > 0.99)!;
  const ref = makeFaceRef(result, body.id, top.key)!;
  return [
    ...base,
    {
      id: 'sh',
      name: 'Shell',
      suppressed: false,
      kind: 'shell',
      bodyId: body.id,
      faces: [ref],
      thickness,
    },
  ];
}

/** A 40 × 20 × 5 plate with a Ø1.5 mm and a Ø6 mm through hole. */
export function plateWithHoles(): Feature[] {
  // The usual workflow: a plate, then circles cut through it.
  const plate = sketchFeature('p-s', [rect(0, 0, 40, 20)]);
  const holes = sketchFeature('p-h', [circle(10, 10, 0.75), circle(28, 10, 3)], {
    kind: 'plane',
    plane: 'XY',
    offset: 5,
  });
  return [
    plate.feature,
    extrude('p-e', 'p-s', [plate.regionKeys[0]!], 5, { name: 'Plate' }),
    holes.feature,
    {
      ...extrude('p-c', 'p-h', holes.regionKeys, -5),
      operation: 'cut',
      targetBodyId: 'body:p-e',
    },
  ];
}

/** A Ø0.8 mm pin, 4 mm tall. */
export function pin(): Feature[] {
  const s = sketchFeature('pin-s', [circle(0, 0, 0.4)]);
  return [s.feature, extrude('pin-e', 'pin-s', [s.regionKeys[0]!], 4, { name: 'Pin' })];
}

/**
 * A "mushroom": a 10 × 10 stem, 10 mm tall, under a 30 × 30 × 4 cap.
 * As modelled the cap's underside overhangs; upside down nothing does.
 */
export function mushroom(): Feature[] {
  const stem = sketchFeature('m-s1', [rect(-5, -5, 10, 10)]);
  const cap = sketchFeature('m-s2', [rect(-15, -15, 30, 30)], {
    kind: 'plane',
    plane: 'XY',
    offset: 10,
  });
  return [
    stem.feature,
    extrude('m-e1', 'm-s1', [stem.regionKeys[0]!], 10, { name: 'Mushroom' }),
    cap.feature,
    {
      ...extrude('m-e2', 'm-s2', [cap.regionKeys[0]!], 4, { name: 'Mushroom' }),
      operation: 'join',
      targetBodyId: 'body:m-e1',
    },
  ];
}
