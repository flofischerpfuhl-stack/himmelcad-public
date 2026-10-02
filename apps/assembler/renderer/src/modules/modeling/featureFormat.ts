/**
 * `.hcasm` validation of the modelling features (`features.ts`),
 * called by `format.ts` for kinds it does not know itself. Same strictness:
 * the first problem throws with a path-qualified message.
 */
import type { Feature } from '../../foundation/document/document.js';
import {
  MODELING_FEATURE_KINDS,
  PRIMITIVE_SHAPES,
  PRIMITIVE_SIZE_FIELDS,
  type ModelingFeature,
  type PrimitiveShape,
} from './features.js';
import { isPrintFeatureKind, validatePrintFeature } from './printFeatureFormat.js';
import { validateAxisRef, validatePlaneRef } from '../../foundation/document/validation.js';
import type { FormatHelpers } from '../../foundation/document/featureKinds.js';

export type { FormatHelpers };

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isVec3 = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(isNumber);

export { validatePlaneRef };

/** `true` if `kind` is a modelling feature kind this module validates. */
export function isModelingFeatureKind(kind: unknown): boolean {
  return (MODELING_FEATURE_KINDS as readonly unknown[]).includes(kind);
}

export function validateModelingFeature(r: Rec, path: string, h: FormatHelpers): Feature {
  const num = (field: string) => {
    if (!isNumber(r[field])) h.fail(`${path}.${field}`, 'expected a number');
  };
  const bool = (field: string) => {
    if (typeof r[field] !== 'boolean') h.fail(`${path}.${field}`, 'expected a boolean');
  };
  const str = (field: string) => {
    if (!isString(r[field])) h.fail(`${path}.${field}`, 'expected a string');
  };
  const optionalStr = (field: string) => {
    if (r[field] !== undefined && !isString(r[field]))
      h.fail(`${path}.${field}`, 'expected a string');
  };
  const operation = () => {
    if (!['new', 'join', 'cut', 'intersect'].includes(r.operation as string)) {
      h.fail(`${path}.operation`, 'expected "new", "join", "cut" or "intersect"');
    }
    optionalStr('targetBodyId');
    optionalStr('resultBodyName');
  };
  const profile = (v: unknown, p: string) => {
    if (!isRecord(v)) h.fail(p, 'expected an object');
    if (v.kind === 'sketch') {
      if (!isString(v.featureId)) h.fail(`${p}.featureId`, 'expected a string');
      if (v.regions !== undefined && (!Array.isArray(v.regions) || !v.regions.every(isString))) {
        h.fail(`${p}.regions`, 'expected an array of region keys');
      }
    } else if (v.kind === 'face') {
      h.faceRef(v.face, `${p}.face`);
    } else {
      h.fail(`${p}.kind`, 'expected "sketch" or "face"');
    }
  };
  const axis = (v: unknown, p: string) => validateAxisRef(v, p, h);
  const plane = (v: unknown, p: string) => validatePlaneRef(v, p, h);
  const stringList = (field: string) => {
    const v = r[field];
    if (!Array.isArray(v) || v.length === 0 || !v.every(isString)) {
      h.fail(`${path}.${field}`, 'expected a non-empty array of strings');
    }
  };
  const vec3 = (field: string) => {
    if (!isVec3(r[field])) h.fail(`${path}.${field}`, 'expected a Vec3');
  };
  const optionalPositive = (field: string) => {
    if (r[field] !== undefined && !(isNumber(r[field]) && r[field] >= 0)) {
      h.fail(`${path}.${field}`, 'expected a number ≥ 0');
    }
  };
  switch (r.kind as ModelingFeature['kind']) {
    case 'revolve':
      profile(r.profile, `${path}.profile`);
      axis(r.axis, `${path}.axis`);
      num('angle');
      operation();
      if (r.helix !== undefined) {
        const helix = r.helix;
        if (!isRecord(helix)) h.fail(`${path}.helix`, 'expected an object');
        if (!isNumber(helix.pitch)) h.fail(`${path}.helix.pitch`, 'expected a number');
        if (!isNumber(helix.turns)) h.fail(`${path}.helix.turns`, 'expected a number');
        if (helix.leftHanded !== undefined && typeof helix.leftHanded !== 'boolean') {
          h.fail(`${path}.helix.leftHanded`, 'expected a boolean');
        }
      }
      break;
    case 'scale':
      stringList('bodyIds');
      num('factor');
      optionalStr('factorExpression');
      if (r.factors !== undefined) vec3('factors');
      vec3('center');
      bool('copy');
      break;
    case 'translate':
      stringList('bodyIds');
      vec3('from');
      vec3('to');
      bool('copy');
      break;
    case 'primitive': {
      if (!(PRIMITIVE_SHAPES as readonly unknown[]).includes(r.shape)) {
        h.fail(`${path}.shape`, `expected one of ${PRIMITIVE_SHAPES.join(', ')}`);
      }
      plane(r.plane, `${path}.plane`);
      vec3('center');
      for (const field of ['width', 'depth', 'height', 'radius', 'radius2']) {
        optionalPositive(field);
        optionalStr(`${field}Expression`);
      }
      if (r.flip !== undefined) bool('flip');
      for (const field of PRIMITIVE_SIZE_FIELDS[r.shape as PrimitiveShape]) {
        if (r[field] === undefined) h.fail(`${path}.${field}`, 'expected a number');
      }
      operation();
      break;
    }
    case 'sweep': {
      profile(r.profile, `${path}.profile`);
      const p = r.path;
      if (!isRecord(p)) h.fail(`${path}.path`, 'expected an object');
      if (p.kind === 'edges') {
        if (!Array.isArray(p.edges) || p.edges.length === 0) {
          h.fail(`${path}.path.edges`, 'expected a non-empty array');
        }
        p.edges.forEach((e, i) => h.edgeRef(e, `${path}.path.edges[${i}]`));
      } else if (p.kind === 'sketch') {
        if (!isString(p.featureId)) h.fail(`${path}.path.featureId`, 'expected a string');
        if (!isString(p.region)) h.fail(`${path}.path.region`, 'expected a region key');
      } else if (p.kind === 'line') {
        if (!isVec3(p.start)) h.fail(`${path}.path.start`, 'expected a Vec3');
        if (!isVec3(p.end)) h.fail(`${path}.path.end`, 'expected a Vec3');
      } else {
        h.fail(`${path}.path.kind`, 'expected "edges", "sketch" or "line"');
      }
      operation();
      break;
    }
    case 'loft':
      if (!Array.isArray(r.profiles) || r.profiles.length === 0) {
        h.fail(`${path}.profiles`, 'expected a non-empty array');
      }
      r.profiles.forEach((p, i) => profile(p, `${path}.profiles[${i}]`));
      bool('ruled');
      operation();
      break;
    case 'mirror': {
      if (!Array.isArray(r.bodyIds) || !r.bodyIds.every(isString)) {
        h.fail(`${path}.bodyIds`, 'expected an array of strings');
      }
      plane(r.plane, `${path}.plane`);
      bool('keepOriginal');
      if (r.sketchIds !== undefined) {
        if (!Array.isArray(r.sketchIds) || !r.sketchIds.every(isString)) {
          h.fail(`${path}.sketchIds`, 'expected an array of strings');
        }
      }
      if (r.faces !== undefined) {
        if (!Array.isArray(r.faces)) h.fail(`${path}.faces`, 'expected an array');
        r.faces.forEach((f, i) => h.faceRef(f, `${path}.faces[${i}]`));
      }
      if (r.axis !== undefined) axis(r.axis, `${path}.axis`);
      const targets =
        r.bodyIds.length +
        (Array.isArray(r.sketchIds) ? r.sketchIds.length : 0) +
        (Array.isArray(r.faces) ? r.faces.length : 0);
      if (targets === 0) h.fail(`${path}.bodyIds`, 'expected at least one body, sketch or face');
      break;
    }
    case 'pattern': {
      stringList('bodyIds');
      const p = r.pattern;
      if (!isRecord(p)) h.fail(`${path}.pattern`, 'expected an object');
      if (!isNumber(p.count)) h.fail(`${path}.pattern.count`, 'expected a number');
      if (p.kind === 'linear') {
        axis(p.direction, `${path}.pattern.direction`);
        if (!isNumber(p.spacing)) h.fail(`${path}.pattern.spacing`, 'expected a number');
        if (
          p.spacingMode !== undefined &&
          p.spacingMode !== 'spacing' &&
          p.spacingMode !== 'total'
        ) {
          h.fail(`${path}.pattern.spacingMode`, 'expected "spacing" or "total"');
        }
        if (p.second !== undefined) {
          const s = p.second;
          if (!isRecord(s)) h.fail(`${path}.pattern.second`, 'expected an object');
          axis(s.direction, `${path}.pattern.second.direction`);
          if (!isNumber(s.count)) h.fail(`${path}.pattern.second.count`, 'expected a number');
          if (!isNumber(s.spacing)) h.fail(`${path}.pattern.second.spacing`, 'expected a number');
        }
      } else if (p.kind === 'circular') {
        axis(p.axis, `${path}.pattern.axis`);
        if (!isNumber(p.angle)) h.fail(`${path}.pattern.angle`, 'expected a number');
        if (p.angleMode !== undefined && p.angleMode !== 'total' && p.angleMode !== 'spacing') {
          h.fail(`${path}.pattern.angleMode`, 'expected "total" or "spacing"');
        }
        if (p.uniform !== undefined && typeof p.uniform !== 'boolean') {
          h.fail(`${path}.pattern.uniform`, 'expected a boolean');
        }
      } else {
        h.fail(`${path}.pattern.kind`, 'expected "linear" or "circular"');
      }
      break;
    }
    case 'split':
      str('bodyId');
      plane(r.plane, `${path}.plane`);
      if (r.profile !== undefined) profile(r.profile, `${path}.profile`);
      if (r.keepOriginal !== undefined) bool('keepOriginal');
      break;
    case 'transform':
      str('bodyId');
      for (const field of ['dx', 'dy', 'dz', 'rx', 'ry', 'rz']) num(field);
      if (!isVec3(r.pivot)) h.fail(`${path}.pivot`, 'expected a Vec3');
      bool('copy');
      break;
    case 'rotateAxis':
      stringList('bodyIds');
      axis(r.axis, `${path}.axis`);
      num('angle');
      bool('copy');
      break;
    case 'align': {
      str('bodyId');
      // Two planar faces: `face`/`target`; other references (Block 9): `from`/`to`, which win.
      const alignRef = (v: unknown, at: string) => {
        if (!isRecord(v)) h.fail(at, 'expected an object');
        if (v.kind === 'face') h.faceRef(v.face, `${at}.face`);
        else if (v.kind === 'axis') axis(v.axis, `${at}.axis`);
        else if (v.kind === 'plane') plane(v.plane, `${at}.plane`);
        else h.fail(`${at}.kind`, 'expected "face", "axis" or "plane"');
      };
      if (r.from !== undefined) alignRef(r.from, `${path}.from`);
      else h.faceRef(r.face, `${path}.face`);
      if (r.to !== undefined) alignRef(r.to, `${path}.to`);
      else h.faceRef(r.target, `${path}.target`);
      if (r.from !== undefined && r.face !== undefined) h.faceRef(r.face, `${path}.face`);
      if (r.to !== undefined && r.target !== undefined) h.faceRef(r.target, `${path}.target`);
      bool('flip');
      bool('center');
      num('offset');
      break;
    }
    default:
      if (isPrintFeatureKind(r.kind)) return validatePrintFeature(r, path, h);
      h.fail(`${path}.kind`, `unknown feature kind "${String(r.kind)}"`);
  }
  return r as unknown as Feature;
}
