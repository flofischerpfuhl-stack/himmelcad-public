/**
 * `.hcasm` validation of the modelling features (`model/features.ts`),
 * called by `format.ts` for kinds it does not know itself. Same strictness:
 * the first problem throws with a path-qualified message.
 */
import type { EdgeRef, FaceRef, Feature } from '../document.js';
import { MODELING_FEATURE_KINDS, type ModelingFeature } from '../features.js';
import { isPrintFeatureKind, validatePrintFeature } from './printFeatureFormat.js';

export interface FormatHelpers {
  fail: (path: string, message: string) => never;
  faceRef: (v: unknown, path: string) => FaceRef;
  edgeRef: (v: unknown, path: string) => EdgeRef;
}

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isVec3 = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(isNumber);

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
    if (!['new', 'join', 'cut'].includes(r.operation as string)) {
      h.fail(`${path}.operation`, 'expected "new", "join" or "cut"');
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
  const axis = (v: unknown, p: string) => {
    if (!isRecord(v)) h.fail(p, 'expected an object');
    if (v.kind === 'world') {
      if (!['X', 'Y', 'Z'].includes(v.axis as string)) h.fail(`${p}.axis`, 'expected X, Y or Z');
      if (v.origin !== undefined && !isVec3(v.origin)) h.fail(`${p}.origin`, 'expected a Vec3');
    } else if (v.kind === 'edge') {
      h.edgeRef(v.edge, `${p}.edge`);
    } else if (v.kind === 'sketchLine') {
      if (!isString(v.featureId)) h.fail(`${p}.featureId`, 'expected a string');
      if (!isString(v.entityId)) h.fail(`${p}.entityId`, 'expected a string');
    } else {
      h.fail(`${p}.kind`, 'expected "world", "edge" or "sketchLine"');
    }
  };
  const plane = (v: unknown, p: string) => {
    if (!isRecord(v)) h.fail(p, 'expected an object');
    if (v.kind === 'plane') {
      if (!['XY', 'XZ', 'YZ'].includes(v.plane as string))
        h.fail(`${p}.plane`, 'expected XY, XZ or YZ');
      if (!isNumber(v.offset)) h.fail(`${p}.offset`, 'expected a number');
    } else if (v.kind === 'face') {
      h.faceRef(v.face, `${p}.face`);
    } else {
      h.fail(`${p}.kind`, 'expected "plane" or "face"');
    }
  };
  const stringList = (field: string) => {
    const v = r[field];
    if (!Array.isArray(v) || v.length === 0 || !v.every(isString)) {
      h.fail(`${path}.${field}`, 'expected a non-empty array of strings');
    }
  };
  const faceList = (field: string) => {
    const v = r[field];
    if (!Array.isArray(v) || v.length === 0)
      h.fail(`${path}.${field}`, 'expected a non-empty array');
    v.forEach((f, i) => h.faceRef(f, `${path}.${field}[${i}]`));
  };

  switch (r.kind as ModelingFeature['kind']) {
    case 'revolve':
      profile(r.profile, `${path}.profile`);
      axis(r.axis, `${path}.axis`);
      num('angle');
      operation();
      break;
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
    case 'mirror':
      stringList('bodyIds');
      plane(r.plane, `${path}.plane`);
      bool('keepOriginal');
      break;
    case 'pattern': {
      stringList('bodyIds');
      const p = r.pattern;
      if (!isRecord(p)) h.fail(`${path}.pattern`, 'expected an object');
      if (!isNumber(p.count)) h.fail(`${path}.pattern.count`, 'expected a number');
      if (p.kind === 'linear') {
        axis(p.direction, `${path}.pattern.direction`);
        if (!isNumber(p.spacing)) h.fail(`${path}.pattern.spacing`, 'expected a number');
      } else if (p.kind === 'circular') {
        axis(p.axis, `${path}.pattern.axis`);
        if (!isNumber(p.angle)) h.fail(`${path}.pattern.angle`, 'expected a number');
      } else {
        h.fail(`${path}.pattern.kind`, 'expected "linear" or "circular"');
      }
      break;
    }
    case 'split':
      str('bodyId');
      plane(r.plane, `${path}.plane`);
      break;
    case 'transform':
      str('bodyId');
      for (const field of ['dx', 'dy', 'dz', 'rx', 'ry', 'rz']) num(field);
      if (!isVec3(r.pivot)) h.fail(`${path}.pivot`, 'expected a Vec3');
      bool('copy');
      break;
    case 'align':
      str('bodyId');
      h.faceRef(r.face, `${path}.face`);
      h.faceRef(r.target, `${path}.target`);
      bool('flip');
      bool('center');
      num('offset');
      break;
    case 'offsetFace':
      faceList('faces');
      num('distance');
      break;
    case 'deleteFace':
      faceList('faces');
      break;
    default:
      if (isPrintFeatureKind(r.kind)) return validatePrintFeature(r, path, h);
      h.fail(`${path}.kind`, `unknown feature kind "${String(r.kind)}"`);
  }
  return r as unknown as Feature;
}
