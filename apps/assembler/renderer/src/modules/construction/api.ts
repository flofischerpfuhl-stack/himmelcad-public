/**
 * The construction module's agent-API method `datums.list`: construction
 * planes and axes as evaluated (plane frame / axis point and direction, the
 * drawn centre and size), whose spec stays in the core method block of
 * `interface/agent-api/schema.ts` (the published order); and the
 * `feature.create` parameter schemas of `constructionPlane` and
 * `constructionAxis` (block `API_ORDER.featureKinds.construction`).
 */
import {
  schemaNumber,
  schemaObject,
  schemaRef,
  type ApiContext,
  type FeatureKindSpec,
  type Json,
} from '../../foundation/commands/api/contract.js';
import { API_ORDER, type ApiContribution } from '../../foundation/commands/api/registry.js';
import { isConstructionFeatureKind } from './construction.js';

async function listDatums(ctx: ApiContext, p: Json): Promise<Json[]> {
  const features = ctx.readFeatures(p);
  const evaluation = await ctx.readEvaluation(p);
  return features
    .filter((f) => isConstructionFeatureKind(f.kind))
    .map((f) => {
      const datum = evaluation.datums?.find((d) => d.featureId === f.id);
      return {
        featureId: f.id,
        name: f.name,
        kind: f.kind === 'constructionPlane' ? 'plane' : 'axis',
        frame: datum?.frame ?? null,
        center: datum?.center ?? null,
        size: datum?.size ?? null,
        ...(evaluation.errors[f.id] ? { error: evaluation.errors[f.id] } : {}),
      };
    });
}

const KIND_SCHEMAS: Record<string, FeatureKindSpec> = {
  constructionPlane: {
    label: 'Plane',
    summary:
      'Construction plane (no body): offset from a plane/face, at an angle about an axis, through three points, midplane between two parallel planes/faces, or tangent to a cylindrical face. Usable as a sketch plane, mirror/split plane and section plane by `{kind: "construction", featureId}`.',
    params: schemaObject(
      {
        definition: {
          oneOf: [
            schemaObject(
              { kind: { const: 'offset' }, base: schemaRef('SketchPlane'), distance: schemaNumber },
              ['kind', 'base', 'distance'],
            ),
            schemaObject(
              {
                kind: { const: 'angle' },
                base: schemaRef('SketchPlane'),
                axis: schemaRef('AxisRef'),
                angle: schemaNumber,
              },
              ['kind', 'base', 'axis', 'angle'],
              'Through `axis` (parallel to `base`), turned `angle` degrees from `base`.',
            ),
            schemaObject(
              {
                kind: { const: 'threePoints' },
                points: { type: 'array', items: schemaRef('PointRef'), minItems: 3, maxItems: 3 },
              },
              ['kind', 'points'],
            ),
            schemaObject(
              {
                kind: { const: 'midplane' },
                a: schemaRef('SketchPlane'),
                b: schemaRef('SketchPlane'),
              },
              ['kind', 'a', 'b'],
            ),
            schemaObject(
              { kind: { const: 'tangent' }, face: schemaRef('FaceInput'), angle: schemaNumber },
              ['kind', 'face', 'angle'],
              '`angle` degrees around the cylinder axis, from the axis frame u.',
            ),
          ],
        },
        flip: { type: 'boolean', default: false },
      },
      ['definition'],
    ),
  },
  constructionAxis: {
    label: 'Axis',
    summary:
      'Construction axis (no body): along a straight edge (a circular edge: its axis), through two points, the axis of a cylindrical face, or the intersection of two planes. Usable as revolve/pattern/rotate axis and mirror line by `{kind: "construction", featureId}`.',
    params: schemaObject(
      {
        definition: {
          oneOf: [
            schemaObject({ kind: { const: 'edge' }, edge: schemaRef('EdgeInput') }, [
              'kind',
              'edge',
            ]),
            schemaObject(
              { kind: { const: 'twoPoints' }, a: schemaRef('PointRef'), b: schemaRef('PointRef') },
              ['kind', 'a', 'b'],
            ),
            schemaObject({ kind: { const: 'cylinder' }, face: schemaRef('FaceInput') }, [
              'kind',
              'face',
            ]),
            schemaObject(
              {
                kind: { const: 'planes' },
                a: schemaRef('SketchPlane'),
                b: schemaRef('SketchPlane'),
              },
              ['kind', 'a', 'b'],
            ),
          ],
        },
        flip: { type: 'boolean', default: false },
      },
      ['definition'],
    ),
  },
};

export const CONSTRUCTION_API: ApiContribution = {
  handlers: { 'datums.list': (ctx, p) => listDatums(ctx, p) },
  featureKinds: [{ order: API_ORDER.featureKinds.construction, kinds: KIND_SCHEMAS }],
};
