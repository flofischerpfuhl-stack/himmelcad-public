/**
 * The construction module's agent-API method `datums.list`: construction
 * planes and axes as evaluated (plane frame / axis point and direction, the
 * drawn centre and size). Its spec stays in the core method block of
 * `interface/agent-api/schema.ts` (the published order), so this is a
 * handler-only contribution.
 */
import type { ApiContext, Json } from '../../foundation/commands/api/contract.js';
import type { ApiContribution } from '../../foundation/commands/api/registry.js';
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

export const CONSTRUCTION_API: ApiContribution = {
  handlers: { 'datums.list': (ctx, p) => listDatums(ctx, p) },
};
