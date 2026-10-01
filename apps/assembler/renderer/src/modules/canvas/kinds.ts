/**
 * The canvas module's feature kind (assembler/MODULES.md §3):
 * `referenceImage` (type in `referenceImage.ts`) with its History label and
 * strict `.hcasm` validator. Loaded by the module (`module.ts`) and by its
 * kernel part (`kernel.ts`).
 */
import { registerFeatureKind, type FormatHelpers } from '../../foundation/document/featureKinds.js';
import { isNumber, validatePlaneRef } from '../../foundation/document/validation.js';
import { MIN_IMAGE_OPACITY } from './referenceImage.js';

type Rec = Record<string, unknown>;

function validateReferenceImage(r: Rec, path: string, h: FormatHelpers): void {
  if (typeof r.imageId !== 'string' || r.imageId === '') {
    h.fail(`${path}.imageId`, 'expected a non-empty string');
  }
  if (typeof r.fileName !== 'string') h.fail(`${path}.fileName`, 'expected a string');
  for (const field of ['pixelWidth', 'pixelHeight', 'width']) {
    if (!isNumber(r[field]) || !((r[field] as number) > 0)) {
      h.fail(`${path}.${field}`, 'expected a positive number');
    }
  }
  validatePlaneRef(r.plane, `${path}.plane`, h);
  if (!Array.isArray(r.center) || r.center.length !== 2 || !r.center.every((v) => isNumber(v))) {
    h.fail(`${path}.center`, 'expected [u, v]');
  }
  if (!isNumber(r.rotation)) h.fail(`${path}.rotation`, 'expected a number');
  if (!isNumber(r.opacity) || r.opacity < MIN_IMAGE_OPACITY || r.opacity > 1) {
    h.fail(`${path}.opacity`, `expected a number from ${MIN_IMAGE_OPACITY} to 1`);
  }
}

registerFeatureKind({
  kind: 'referenceImage',
  module: 'canvas',
  label: 'Image',
  validate: validateReferenceImage,
});
