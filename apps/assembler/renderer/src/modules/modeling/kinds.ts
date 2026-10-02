/**
 * Registers the modelling feature kinds (`features.ts`, `printFeatures.ts`)
 * with the document's feature-kind registry: History label, `.hcasm`
 * validator, consumed sketches, formula fields and the boolean-result rule.
 * Loaded by the product composition (`module.ts`) and the kernel-worker
 * composition (`kernel.ts`).
 */
import {
  registerFeatureKind,
  type Feature,
  type FeatureFormatCapability,
  type FeatureKindDefinition,
} from '../../foundation/document/featureKinds.js';
import {
  MODELING_FEATURE_KINDS,
  MODELING_FEATURE_LABEL,
  sketchIdsUsedBy,
  splitBodyIds,
  type ModelingFeature,
} from './features.js';
import { validateModelingFeature } from './featureFormat.js';

/** Formula fields of the modelling kinds (`foundation/document/parameters.ts`). */
const EXPRESSION_FIELDS: Partial<Record<ModelingFeature['kind'], readonly string[]>> = {
  hole: ['diameter'],
  draft: ['angle'],
  rib: ['thickness'],
  thicken: ['thickness'],
  scale: ['factor'],
  primitive: ['width', 'depth', 'height', 'radius'],
};

/** Kinds whose result is always a boolean of solids (holes, emboss/engrave, ribs). */
const BOOLEAN_RESULT_KINDS: ReadonlySet<string> = new Set(['hole', 'emboss', 'rib']);

type Capability = FeatureFormatCapability<Feature>;
const as = <K extends ModelingFeature['kind']>(kind: K, f: Feature) =>
  f.kind === kind ? (f as Extract<ModelingFeature, { kind: K }>) : null;
const linear = (f: Feature) => {
  const p = as('pattern', f)?.pattern;
  return p?.kind === 'linear' ? p : null;
};
const circular = (f: Feature) => {
  const p = as('pattern', f)?.pattern;
  return p?.kind === 'circular' ? p : null;
};

/**
 * Optional fields (Block 8, Block 9) that change the geometry: an older
 * reader would build the plain feature, so it must refuse the file
 * (`formatCapabilities.ts`). Not listed: the extrude taper on Through All /
 * To Object (Block 9) — a Block 8 reader reports that step as an error
 * instead of building it differently, and every reader of `requires`
 * supports it.
 */
const FORMAT_CAPABILITIES: Partial<Record<ModelingFeature['kind'], readonly Capability[]>> = {
  revolve: [
    { id: 'revolve.helix', label: 'Helical revolve', usedBy: (f) => !!as('revolve', f)?.helix },
  ],
  pattern: [
    {
      id: 'pattern.twoDirections',
      label: 'Two-direction pattern',
      usedBy: (f) => !!linear(f)?.second,
    },
    {
      id: 'pattern.totalLength',
      label: 'Pattern by total length',
      usedBy: (f) => linear(f)?.spacingMode === 'total',
    },
    {
      id: 'pattern.angleSpacing',
      label: 'Circular pattern by spacing angle',
      usedBy: (f) => circular(f)?.angleMode === 'spacing',
    },
    {
      id: 'pattern.uniform',
      label: 'Circular pattern keeping orientation',
      usedBy: (f) => circular(f)?.uniform === true,
    },
    // Block 9: a third direction and whole sketches.
    {
      id: 'pattern.third',
      label: 'Three-direction pattern',
      usedBy: (f) => !!linear(f)?.third,
    },
    {
      id: 'pattern.sketchIds',
      label: 'Pattern of sketches',
      usedBy: (f) => (as('pattern', f)?.sketchIds?.length ?? 0) > 0,
    },
  ],
  split: [
    { id: 'split.profile', label: 'Split by profile', usedBy: (f) => !!as('split', f)?.profile },
    {
      id: 'split.keepOriginal',
      label: 'Split keeping the original',
      usedBy: (f) => as('split', f)?.keepOriginal === true,
    },
    // Block 9: several bodies split in one step.
    {
      id: 'split.bodyIds',
      label: 'Split of several bodies',
      usedBy: (f) => {
        const split = as('split', f);
        return !!split && splitBodyIds(split).length > 1;
      },
    },
  ],
  // Block 9: Align on axes, edges, centres and datums (`from`/`to`) and the turn after it.
  align: [
    {
      id: 'align.from',
      label: 'Align from an edge, axis or curved face',
      usedBy: (f) => as('align', f)?.from !== undefined,
    },
    {
      id: 'align.to',
      label: 'Align to an edge, axis, datum or curved face',
      usedBy: (f) => as('align', f)?.to !== undefined,
    },
    {
      id: 'align.turn',
      label: 'Align with a turn',
      usedBy: (f) => (as('align', f)?.turn ?? 0) !== 0,
    },
  ],
};

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
    ...(FORMAT_CAPABILITIES[kind] ? { formatCapabilities: FORMAT_CAPABILITIES[kind] } : {}),
  };
  registerFeatureKind(definition);
}
