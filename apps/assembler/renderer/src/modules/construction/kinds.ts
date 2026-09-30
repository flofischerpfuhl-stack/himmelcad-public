/**
 * Registers the construction kinds (`model/construction.ts`: planes and
 * axes) with the document's feature-kind registry: History label and
 * `.hcasm` validator. Loaded by the product composition (`module.ts`) and
 * the kernel-worker composition (`kernel/features/constructionKernel.ts`).
 *
 * Phase B note: written by agent B when the modelling module stopped
 * validating construction kinds; agent A's construction move owns this file
 * (take A's version on a merge conflict).
 */
import { registerFeatureKind, type FormatHelpers } from '../../foundation/document/featureKinds.js';
import {
  isNumber,
  isRecord,
  isVec3,
  validateAxisRef,
  validatePlaneRef,
} from '../../foundation/document/validation.js';
import { CONSTRUCTION_FEATURE_LABEL } from '../../model/construction.js';

function validatePoint(v: unknown, p: string, h: FormatHelpers): void {
  if (!isRecord(v)) h.fail(p, 'expected an object');
  if (v.kind === 'point') {
    if (!isVec3(v.point)) h.fail(`${p}.point`, 'expected a Vec3');
  } else if (v.kind === 'edgeEnd') {
    h.edgeRef(v.edge, `${p}.edge`);
    if (!isVec3(v.near)) h.fail(`${p}.near`, 'expected a Vec3');
  } else if (v.kind === 'edgeMid' || v.kind === 'circleCenter') {
    h.edgeRef(v.edge, `${p}.edge`);
  } else {
    h.fail(`${p}.kind`, 'expected "point", "edgeEnd", "edgeMid" or "circleCenter"');
  }
}

function validateFlip(r: Record<string, unknown>, path: string, h: FormatHelpers): void {
  if (r.flip !== undefined && typeof r.flip !== 'boolean') {
    h.fail(`${path}.flip`, 'expected a boolean');
  }
}

registerFeatureKind({
  kind: 'constructionPlane',
  module: 'construction',
  label: CONSTRUCTION_FEATURE_LABEL.constructionPlane,
  validate: (r: Record<string, unknown>, path: string, h: FormatHelpers) => {
    const d = r.definition;
    const p = `${path}.definition`;
    if (!isRecord(d)) h.fail(p, 'expected an object');
    if (d.kind === 'offset') {
      validatePlaneRef(d.base, `${p}.base`, h);
      if (!isNumber(d.distance)) h.fail(`${p}.distance`, 'expected a number');
    } else if (d.kind === 'angle') {
      validatePlaneRef(d.base, `${p}.base`, h);
      validateAxisRef(d.axis, `${p}.axis`, h);
      if (!isNumber(d.angle)) h.fail(`${p}.angle`, 'expected a number');
    } else if (d.kind === 'threePoints') {
      if (!Array.isArray(d.points) || d.points.length !== 3) {
        h.fail(`${p}.points`, 'expected three points');
      }
      d.points.forEach((q, i) => validatePoint(q, `${p}.points[${i}]`, h));
    } else if (d.kind === 'midplane') {
      validatePlaneRef(d.a, `${p}.a`, h);
      validatePlaneRef(d.b, `${p}.b`, h);
    } else if (d.kind === 'tangent') {
      h.faceRef(d.face, `${p}.face`);
      if (!isNumber(d.angle)) h.fail(`${p}.angle`, 'expected a number');
    } else {
      h.fail(`${p}.kind`, 'expected "offset", "angle", "threePoints", "midplane" or "tangent"');
    }
    validateFlip(r, path, h);
  },
});

registerFeatureKind({
  kind: 'constructionAxis',
  module: 'construction',
  label: CONSTRUCTION_FEATURE_LABEL.constructionAxis,
  validate: (r: Record<string, unknown>, path: string, h: FormatHelpers) => {
    const d = r.definition;
    const p = `${path}.definition`;
    if (!isRecord(d)) h.fail(p, 'expected an object');
    if (d.kind === 'edge') h.edgeRef(d.edge, `${p}.edge`);
    else if (d.kind === 'twoPoints') {
      validatePoint(d.a, `${p}.a`, h);
      validatePoint(d.b, `${p}.b`, h);
    } else if (d.kind === 'cylinder') h.faceRef(d.face, `${p}.face`);
    else if (d.kind === 'planes') {
      validatePlaneRef(d.a, `${p}.a`, h);
      validatePlaneRef(d.b, `${p}.b`, h);
    } else {
      h.fail(`${p}.kind`, 'expected "edge", "twoPoints", "cylinder" or "planes"');
    }
    validateFlip(r, path, h);
  },
});
