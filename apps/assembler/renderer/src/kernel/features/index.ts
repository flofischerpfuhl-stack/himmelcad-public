/**
 * Evaluation of the modelling features declared in `model/features.ts`.
 * Called by `evaluator.ts` for every feature kind it does not handle itself.
 */
import type { Feature } from '../../model/document.js';
import { isModelingFeature } from '../../model/features.js';
import {
  applyAlign,
  applyMirror,
  applyPattern,
  applyRotateAxis,
  applySplit,
  applyTransform,
} from './bodyOps.js';
import { applyDeleteFace, applyOffsetFace } from './faceOps.js';
import { applyDraft } from './draft.js';
import { applyEmboss } from './emboss.js';
import { applyHole } from './holes.js';
import { applyRib, applyThicken } from './ribThicken.js';
import type { FeatureKit, ReplayContextLike } from './kit.js';
import { applyLoft, applyRevolve, applySweep } from './profileSolids.js';

export type { FeatureKit } from './kit.js';

export function applyModelingFeature(
  feature: Feature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  if (!isModelingFeature(feature)) kit.fail(`Unknown feature kind "${feature.kind}"`);
  switch (feature.kind) {
    case 'revolve':
      return applyRevolve(feature, ctx, kit);
    case 'sweep':
      return applySweep(feature, ctx, kit);
    case 'loft':
      return applyLoft(feature, ctx, kit);
    case 'mirror':
      return applyMirror(feature, ctx, kit);
    case 'pattern':
      return applyPattern(feature, ctx, kit);
    case 'split':
      return applySplit(feature, ctx, kit);
    case 'transform':
      return applyTransform(feature, ctx, kit);
    case 'rotateAxis':
      return applyRotateAxis(feature, ctx, kit);
    case 'align':
      return applyAlign(feature, ctx, kit);
    case 'offsetFace':
      return applyOffsetFace(feature, ctx, kit);
    case 'deleteFace':
      return applyDeleteFace(feature, ctx, kit);
    case 'hole':
      return applyHole(feature, ctx, kit);
    case 'emboss':
      return applyEmboss(feature, ctx, kit);
    case 'draft':
      return applyDraft(feature, ctx, kit);
    case 'rib':
      return applyRib(feature, ctx, kit);
    case 'thicken':
      return applyThicken(feature, ctx, kit);
  }
}
