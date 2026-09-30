/**
 * The `sketch` feature kind: a constrained 2D sketch (schema v2) on a plane
 * reference. Declared here, beside the sketch data model, through the
 * document's feature-kind registry (`../document/featureKinds.ts`), together
 * with its `.hcasm` validator and the v1 → v2 file migration the sketch
 * model owns. The evaluator implements the kind itself
 * (`../geometry-kernel/evaluator.ts`).
 */
import type { SketchPlaneRef } from '../document/document.js';
import {
  registerFeatureKind,
  type FeatureBase,
  type FormatHelpers,
} from '../document/featureKinds.js';
import { registerFormatMigration } from '../document/format.js';
import { validatePlaneRef } from '../document/validation.js';
import { migrateSketchesV1ToV2 } from './migration.js';
import type { SketchData } from './types.js';
import { validateSketchData } from './validation.js';

/**
 * A constrained 2D sketch (schema v2): entities in the sketch frame's
 * (u, v) coordinates (always the last solved state), constraints and
 * driving dimensions — see `types.ts`. Profiles are not stored: they are
 * the closed regions detected from the geometry (`regions.ts`).
 */
export interface SketchFeature extends FeatureBase, SketchData {
  kind: 'sketch';
  plane: SketchPlaneRef;
}

declare module '../document/featureKinds.js' {
  interface FeatureKindMap {
    sketch: SketchFeature;
  }
}

registerFeatureKind({
  kind: 'sketch',
  module: 'sketch-solver',
  label: 'Sketch',
  validate(r: Record<string, unknown>, path: string, h: FormatHelpers) {
    validatePlaneRef(r.plane, `${path}.plane`, h);
    const sketchError = validateSketchData(r);
    if (sketchError) h.fail(`${path}.${sketchError.path}`, sketchError.message);
  },
});

// v1 -> v2: rectangle/circle profiles become constrained sketches; extrude
// profile indices become region keys; index-based face keys are renamed.
registerFormatMigration(1, (body) => ({ ...body, features: migrateSketchesV1ToV2(body.features) }));
