/**
 * Strict `.hcasm` validation helpers every feature kind's `validate` may use
 * (`featureKinds.ts`): field checkers and the shared reference shapes
 * (plane and profile references). Same rules as `format.ts`: the first
 * problem fails with a path-qualified message; nothing is repaired.
 */
import type { FormatHelpers } from './featureKinds.js';

type Rec = Record<string, unknown>;

export const isRecord = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isString = (v: unknown): v is string => typeof v === 'string';
export const isVec3 = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 3 && v.every(isNumber);

const isFrame = (v: unknown): boolean =>
  isRecord(v) && isVec3(v.origin) && isVec3(v.u) && isVec3(v.v) && isVec3(v.normal);

/** Field checkers bound to one record and path. */
export function fieldCheckers(r: Rec, path: string, h: FormatHelpers) {
  return {
    num(field: string) {
      if (!isNumber(r[field])) h.fail(`${path}.${field}`, 'expected a number');
    },
    optionalNum(field: string) {
      if (r[field] !== undefined && !isNumber(r[field]))
        h.fail(`${path}.${field}`, 'expected a number');
    },
    bool(field: string) {
      if (typeof r[field] !== 'boolean') h.fail(`${path}.${field}`, 'expected a boolean');
    },
    optionalBool(field: string) {
      if (r[field] !== undefined && typeof r[field] !== 'boolean') {
        h.fail(`${path}.${field}`, 'expected a boolean');
      }
    },
    str(field: string) {
      if (!isString(r[field])) h.fail(`${path}.${field}`, 'expected a string');
    },
    optionalStr(field: string) {
      if (r[field] !== undefined && !isString(r[field]))
        h.fail(`${path}.${field}`, 'expected a string');
    },
    oneOf(field: string, values: readonly string[]) {
      if (!values.includes(r[field] as string)) {
        h.fail(`${path}.${field}`, `expected ${values.map((v) => `"${v}"`).join(', ')}`);
      }
    },
    faceList(field: string, allowEmpty = false) {
      const v = r[field];
      if (!Array.isArray(v) || (!allowEmpty && v.length === 0)) {
        h.fail(`${path}.${field}`, allowEmpty ? 'expected an array' : 'expected a non-empty array');
      }
      v.forEach((f, i) => h.faceRef(f, `${path}.${field}[${i}]`));
    },
  };
}

/**
 * A plane reference (sketch plane, mirror/split plane, draft neutral
 * plane): world plane with offset, planar face, or construction plane.
 */
export function validatePlaneRef(v: unknown, p: string, h: FormatHelpers): void {
  if (!isRecord(v)) h.fail(p, 'expected an object');
  if (v.kind === 'plane') {
    if (!['XY', 'XZ', 'YZ'].includes(v.plane as string))
      h.fail(`${p}.plane`, 'expected XY, XZ or YZ');
    if (!isNumber(v.offset)) h.fail(`${p}.offset`, 'expected a number');
  } else if (v.kind === 'face') {
    h.faceRef(v.face, `${p}.face`);
  } else if (v.kind === 'construction') {
    if (!isString(v.featureId)) h.fail(`${p}.featureId`, 'expected a string');
    if (!isFrame(v.frame)) h.fail(`${p}.frame`, 'expected {origin, u, v, normal}');
    if (v.shown !== undefined) {
      const shown = v.shown;
      if (!isRecord(shown) || !isVec3(shown.center) || !isNumber(shown.size)) {
        h.fail(`${p}.shown`, 'expected {center, size}');
      }
    }
  } else {
    h.fail(`${p}.kind`, 'expected "plane", "face" or "construction"');
  }
}

/**
 * An axis reference (revolve/pattern/rotate axis, mirror line, construction
 * input): world axis, body edge, sketch line or construction axis.
 */
export function validateAxisRef(v: unknown, p: string, h: FormatHelpers): void {
  if (!isRecord(v)) h.fail(p, 'expected an object');
  if (v.kind === 'world') {
    if (!['X', 'Y', 'Z'].includes(v.axis as string)) h.fail(`${p}.axis`, 'expected X, Y or Z');
    if (v.origin !== undefined && !isVec3(v.origin)) h.fail(`${p}.origin`, 'expected a Vec3');
  } else if (v.kind === 'edge') {
    h.edgeRef(v.edge, `${p}.edge`);
  } else if (v.kind === 'sketchLine') {
    if (!isString(v.featureId)) h.fail(`${p}.featureId`, 'expected a string');
    if (!isString(v.entityId)) h.fail(`${p}.entityId`, 'expected a string');
  } else if (v.kind === 'construction') {
    if (!isString(v.featureId)) h.fail(`${p}.featureId`, 'expected a string');
    const line = v.line;
    if (!isRecord(line) || !isVec3(line.point) || !isVec3(line.dir)) {
      h.fail(`${p}.line`, 'expected {point, dir}');
    }
  } else {
    h.fail(`${p}.kind`, 'expected "world", "edge", "sketchLine" or "construction"');
  }
}

/** A profile reference: regions of a sketch, or a planar body face. */
export function validateProfileRef(v: unknown, p: string, h: FormatHelpers): void {
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
}
