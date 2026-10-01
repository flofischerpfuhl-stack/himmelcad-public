/**
 * The sketching module's agent-API methods (`hcasm.agent-api@1`):
 * `sketches.list` and the `sketch.*` edits, as handlers on the session
 * services (`foundation/commands/api/contract.ts`), with their specs
 * (`apiSchema.ts`, two blocks at their places in the published order).
 *
 * Every `sketch.*` edit is one edit of one sketch: applied to the sketch
 * data, re-solved by planeGCS, validated like Save/Open would and committed
 * (or staged in a transaction) as one step through `ctx.write`.
 */
import type { ApiContext, Json, WriteOutcome } from '../../foundation/commands/api/contract.js';
import { ApiError } from '../../foundation/commands/api/errors.js';
import {
  API_ORDER,
  type ApiContribution,
  type ApiHandler,
} from '../../foundation/commands/api/registry.js';
import type { Feature } from '../../foundation/document/document.js';
import { consumedSketchIds, parseDerivedSketchId } from '../../foundation/document/sketchUsage.js';
import type { EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import { rememberRegions } from '../../foundation/sketch-solver/regionMemory.js';
import type { SketchFeature } from '../../foundation/sketch-solver/sketchFeature.js';
import type {
  SketchConstraintKind,
  SketchData,
  SketchDimensionKind,
  Vec2,
} from '../../foundation/sketch-solver/types.js';
import { SKETCH_EDIT_METHODS, SKETCHES_LIST_METHODS } from './apiSchema.js';
import { ADVANCED_SKETCH_METHODS, advancedSketchEdit } from './sketchAdvancedApi.js';
import {
  addArcShape,
  addConstraint,
  addDimension,
  addPolylineShape,
  addShape,
  deleteSketchItems,
  describeRegions,
  findDimension,
  setDimension,
  sketchDataOf,
  solveSketch,
  type SketchShape,
} from './sketchApi.js';

/** The basic `sketch.*` edits (the advanced ones are `ADVANCED_SKETCH_METHODS`). */
const BASIC_SKETCH_METHODS = [
  'sketch.addProfile',
  'sketch.addPolyline',
  'sketch.addArc',
  'sketch.addConstraint',
  'sketch.addDimension',
  'sketch.setDimension',
  'sketch.deleteItems',
] as const;

/** Solves `data` for sketch `feature`; the stored (validated) solved feature and its DOF. */
export async function solvedSketchFeature(
  ctx: Pick<ApiContext, 'validateStored'>,
  feature: SketchFeature,
  data: SketchData,
): Promise<{ feature: SketchFeature; dof: number }> {
  const { sketch, dof } = await solveSketch(data);
  // Region fingerprints, like a sketch commit in the app (geometric re-binding of profiles).
  const stored = ctx.validateStored({
    ...feature,
    ...rememberRegions(sketch, feature),
  }) as SketchFeature;
  return { feature: stored, dof };
}

/** Every sketch (and every derived sketch, e.g. a Mirror's) with geometry and regions. */
async function listSketches(ctx: ApiContext, p: Json): Promise<Json[]> {
  const features = ctx.readFeatures(p);
  const evaluation = await ctx.readEvaluation(p);
  const consumed = consumedSketchIds(features);
  return features
    .filter((f): f is SketchFeature => f.kind === 'sketch')
    .map((sketch): Json => {
      const evaluated = evaluation.sketches.find((s) => s.featureId === sketch.id);
      return {
        featureId: sketch.id,
        name: sketch.name,
        plane: sketch.plane,
        frame: evaluated?.frame ?? null,
        consumed: consumed.has(sketch.id),
        ...(evaluation.errors[sketch.id] ? { error: evaluation.errors[sketch.id] } : {}),
        entities: sketch.entities,
        constraints: sketch.constraints,
        dimensions: sketch.dimensions,
        regions: describeRegions(sketch, evaluated),
      };
    })
    .concat(
      // Mirrored sketches and faces (Mirror steps): profiles only, referenced by their id.
      evaluation.sketches
        .map((s) => ({ s, derived: parseDerivedSketchId(s.featureId) }))
        .filter((d) => d.derived !== null)
        .map(({ s, derived }) => {
          const source = features.find((f) => f.id === derived!.featureId);
          return {
            featureId: s.featureId,
            name: `${source?.name ?? 'Mirror'} sketch ${derived!.index + 1}`,
            derivedFrom: source?.id ?? null,
            frame: s.frame,
            consumed: consumed.has(s.featureId),
            regions: s.profiles.map((profile) => ({
              key: profile.key,
              area: profile.area,
              center: profile.center,
            })),
          };
        }),
    );
}

/** One `sketch.*` edit of one sketch, re-solved and validated. */
async function editSketch(
  ctx: ApiContext,
  method: string,
  p: Json,
  features: Feature[],
  evaluation: EvaluationResult,
): Promise<WriteOutcome> {
  const existing = ctx.findFeature(features, String(p.featureId));
  if (existing.kind !== 'sketch') {
    throw new ApiError('invalidParams', `"${existing.name}" is a ${existing.kind}, not a sketch`);
  }
  const data = sketchDataOf(existing);
  let next: SketchData;
  let result: Json = {};
  if ((ADVANCED_SKETCH_METHODS as readonly string[]).includes(method)) {
    const edit = await advancedSketchEdit(method, p, data, {
      featureId: existing.id,
      evaluation,
      features,
    });
    next = edit.sketch;
    result = edit.result;
  } else
    switch (method) {
      case 'sketch.addProfile': {
        const added = addShape(data, p.profile as SketchShape);
        next = added.sketch;
        result = { shape: added.added };
        break;
      }
      case 'sketch.addPolyline': {
        const added = addPolylineShape(data, p.points as Vec2[], {
          closed: p.closed === true,
          construction: p.construction === true,
          autoConstrain: p.autoConstrain !== false,
        });
        next = added.sketch;
        result = { pointIds: added.pointIds, lineIds: added.lineIds };
        break;
      }
      case 'sketch.addArc': {
        const added = addArcShape(
          data,
          p.center as Vec2,
          p.start as Vec2,
          p.end as Vec2,
          p.construction === true,
        );
        next = added.sketch;
        result = { entityIds: added.entityIds };
        break;
      }
      case 'sketch.addConstraint': {
        const added = addConstraint(data, p.kind as SketchConstraintKind, p.refs as string[]);
        next = added.sketch;
        result = { constraintId: added.constraintId };
        break;
      }
      case 'sketch.addDimension': {
        const added = addDimension(data, p.kind as SketchDimensionKind, p.refs as string[], {
          ...(typeof p.value === 'number' ? { value: p.value } : {}),
          ...(typeof p.expression === 'string' ? { expression: p.expression } : {}),
          ...(typeof p.name === 'string' ? { name: p.name } : {}),
        });
        next = added.sketch;
        result = { dimensionId: added.dimension.id, name: added.dimension.name };
        break;
      }
      case 'sketch.setDimension': {
        const dimension = findDimension(data, String(p.dimension));
        next = setDimension(data, dimension.id, {
          ...(typeof p.value === 'number' ? { value: p.value } : {}),
          ...(typeof p.expression === 'string' ? { expression: p.expression } : {}),
        });
        result = { dimensionId: dimension.id, name: dimension.name };
        break;
      }
      default:
        next = deleteSketchItems(data, p.ids as string[]);
        break;
    }
  const solved = await solvedSketchFeature(ctx, existing, next);
  const dimensionId = result.dimensionId;
  if (typeof dimensionId === 'string') {
    result.value = solved.feature.dimensions.find((d) => d.id === dimensionId)?.value ?? null;
  }
  return {
    features: features.map((f) => (f.id === existing.id ? solved.feature : f)),
    touched: [existing.id],
    result: {
      featureId: existing.id,
      ...result,
      dof: solved.dof,
      // World-space centres come with the next evaluation (sketches.list).
      regions: describeRegions(solved.feature, undefined),
    },
  };
}

const editHandler: ApiHandler = (ctx, p, method) =>
  ctx.write(method, (features, evaluation) => editSketch(ctx, method, p, features, evaluation));

const EDIT_METHODS: ReadonlySet<string> = new Set([
  ...BASIC_SKETCH_METHODS,
  ...ADVANCED_SKETCH_METHODS,
]);
for (const name of Object.keys(SKETCH_EDIT_METHODS)) {
  if (!EDIT_METHODS.has(name)) throw new Error(`sketching: "${name}" has a spec but no edit`);
}

export const SKETCHING_API: ApiContribution = {
  methods: [
    {
      order: API_ORDER.methods.sketchesList,
      methods: {
        'sketches.list': {
          spec: SKETCHES_LIST_METHODS['sketches.list']!,
          handler: (ctx, p) => listSketches(ctx, p),
        },
      },
    },
    {
      order: API_ORDER.methods.sketchEdits,
      methods: Object.fromEntries(
        Object.entries(SKETCH_EDIT_METHODS).map(([name, spec]) => [
          name,
          { spec, handler: editHandler },
        ]),
      ),
    },
  ],
};
