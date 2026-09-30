/**
 * Registers the modelling feature kinds (`features.ts`, `printFeatures.ts`)
 * with the document's feature-kind registry: History label, `.hcasm` validator, consumed sketches, formula
 * fields and the boolean-result rule. Loaded by the product composition and
 * the kernel-worker composition (`renderer/src/app/`).
 */
import {
  registerFeatureKind,
  type Feature,
  type FeatureKindDefinition,
} from '../foundation/document/featureKinds.js';
import {
  MODELING_FEATURE_KINDS,
  MODELING_FEATURE_LABEL,
  sketchIdsUsedBy,
  type ModelingFeature,
} from './features.js';
import { validateModelingFeature } from './project/featureFormat.js';

/** Formula fields of the modelling kinds (`foundation/document/parameters.ts`). */
const EXPRESSION_FIELDS: Partial<Record<ModelingFeature['kind'], readonly string[]>> = {
  hole: ['diameter'],
  draft: ['angle'],
  rib: ['thickness'],
  thicken: ['thickness'],
};

/** Kinds whose result is always a boolean of solids (holes, emboss/engrave, ribs). */
const BOOLEAN_RESULT_KINDS: ReadonlySet<string> = new Set(['hole', 'emboss', 'rib']);

for (const kind of MODELING_FEATURE_KINDS) {
  const definition: FeatureKindDefinition = {
    kind,
    module: 'modeling',
    label: MODELING_FEATURE_LABEL[kind],
    validate: (record, path, helpers) => {
      validateModelingFeature(record, path, helpers);
    },
    sketchIdsUsedBy: (feature: Feature) => sketchIdsUsedBy(feature as ModelingFeature),
    ...(EXPRESSION_FIELDS[kind] ? { expressionFields: EXPRESSION_FIELDS[kind] } : {}),
    ...(kind === 'draft' ? { signedExpressionFields: ['angle'] } : {}),
    ...(BOOLEAN_RESULT_KINDS.has(kind) ? { booleanResult: () => true } : {}),
  };
  registerFeatureKind(definition);
}
