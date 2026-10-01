/**
 * The construction module's feature kinds (assembler/MODULES.md §3):
 * `constructionPlane` and `constructionAxis` (types in `construction.ts`)
 * with their History label and strict `.hcasm` validator. Loaded by the
 * module (`module.ts`, every program) and by its kernel part (`kernel.ts`,
 * the kernel worker).
 */
import { registerFeatureKind, type FormatHelpers } from '../../foundation/document/featureKinds.js';
import {
  isNumber,
  isRecord,
  isVec3,
  validateAxisRef,
  validatePlaneRef,
} from '../../foundation/document/validation.js';
import { CONSTRUCTION_FEATURE_KINDS, CONSTRUCTION_FEATURE_LABEL } from './construction.js';

type Rec = Record<string, unknown>;

/** A point reference (`PointRef`): world point, edge end, edge midpoint or circle centre. */
function validatePointRef(v: unknown, p: string, h: FormatHelpers): void {
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

function validatePlaneDefinition(d: unknown, p: string, h: FormatHelpers): void {
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
    d.points.forEach((q, i) => validatePointRef(q, `${p}.points[${i}]`, h));
  } else if (d.kind === 'midplane') {
    validatePlaneRef(d.a, `${p}.a`, h);
    validatePlaneRef(d.b, `${p}.b`, h);
  } else if (d.kind === 'tangent') {
    h.faceRef(d.face, `${p}.face`);
    if (!isNumber(d.angle)) h.fail(`${p}.angle`, 'expected a number');
  } else {
    h.fail(`${p}.kind`, 'expected "offset", "angle", "threePoints", "midplane" or "tangent"');
  }
}

function validateAxisDefinition(d: unknown, p: string, h: FormatHelpers): void {
  if (!isRecord(d)) h.fail(p, 'expected an object');
  if (d.kind === 'edge') h.edgeRef(d.edge, `${p}.edge`);
  else if (d.kind === 'twoPoints') {
    validatePointRef(d.a, `${p}.a`, h);
    validatePointRef(d.b, `${p}.b`, h);
  } else if (d.kind === 'cylinder') h.faceRef(d.face, `${p}.face`);
  else if (d.kind === 'planes') {
    validatePlaneRef(d.a, `${p}.a`, h);
    validatePlaneRef(d.b, `${p}.b`, h);
  } else {
    h.fail(`${p}.kind`, 'expected "edge", "twoPoints", "cylinder" or "planes"');
  }
}

function validateConstruction(r: Rec, path: string, h: FormatHelpers): void {
  if (r.kind === 'constructionPlane') {
    validatePlaneDefinition(r.definition, `${path}.definition`, h);
  } else {
    validateAxisDefinition(r.definition, `${path}.definition`, h);
  }
  if (r.flip !== undefined && typeof r.flip !== 'boolean') {
    h.fail(`${path}.flip`, 'expected a boolean');
  }
}

for (const kind of CONSTRUCTION_FEATURE_KINDS) {
  registerFeatureKind({
    kind,
    module: 'construction',
    label: CONSTRUCTION_FEATURE_LABEL[kind],
    validate: validateConstruction,
  });
}
