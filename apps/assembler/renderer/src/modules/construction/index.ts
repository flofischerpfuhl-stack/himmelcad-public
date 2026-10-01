/**
 * Public API of the construction module (for products and tests): the kind
 * types, the draft helpers the tests drive and the module descriptors.
 * Other domain modules never import it — they read construction planes and
 * axes through `foundation/geometry-kernel/datums.ts`.
 */
export type {
  ConstructionAxisDef,
  ConstructionAxisFeature,
  ConstructionFeature,
  ConstructionPlaneDef,
  ConstructionPlaneFeature,
  PointRef,
} from './construction.js';
export { createConstructionDraft, type ConstructionDraft } from './constructionTools.js';
export { constructionModule } from './module.js';
