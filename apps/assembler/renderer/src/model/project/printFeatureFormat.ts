/**
 * `.hcasm` validation of the print features (`model/printFeatures.ts`) and
 * of the optional Fillet/Chamfer/Shell/Boolean fields
 * (`model/blendOptions.ts`). Same strictness as `format.ts`: the first
 * problem throws with a path-qualified message.
 */
import type { Feature } from '../document.js';
import { PRINT_FEATURE_KINDS, type PrintFeature } from '../printFeatures.js';
import type { FormatHelpers } from './featureFormat.js';

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string';

export function isPrintFeatureKind(kind: unknown): boolean {
  return (PRINT_FEATURE_KINDS as readonly unknown[]).includes(kind);
}

function checkers(r: Rec, path: string, h: FormatHelpers) {
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

function profile(v: unknown, p: string, h: FormatHelpers): void {
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

function plane(v: unknown, p: string, h: FormatHelpers): void {
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
}

export function validatePrintFeature(r: Rec, path: string, h: FormatHelpers): Feature {
  const c = checkers(r, path, h);
  switch (r.kind as PrintFeature['kind']) {
    case 'hole': {
      h.faceRef(r.face, `${path}.face`);
      if (!Array.isArray(r.placements) || r.placements.length === 0) {
        h.fail(`${path}.placements`, 'expected a non-empty array');
      }
      r.placements.forEach((p, i) => {
        const at = `${path}.placements[${i}]`;
        if (!isRecord(p)) h.fail(at, 'expected an object');
        if (p.kind === 'point') {
          if (!isNumber(p.u)) h.fail(`${at}.u`, 'expected a number');
          if (!isNumber(p.v)) h.fail(`${at}.v`, 'expected a number');
        } else if (p.kind === 'sketchPoint') {
          if (!isString(p.featureId)) h.fail(`${at}.featureId`, 'expected a string');
          if (!isString(p.entityId)) h.fail(`${at}.entityId`, 'expected a string');
        } else {
          h.fail(`${at}.kind`, 'expected "point" or "sketchPoint"');
        }
      });
      c.oneOf('holeType', ['simple', 'counterbore', 'countersink']);
      c.num('diameter');
      const extent = r.extent;
      if (!isRecord(extent)) h.fail(`${path}.extent`, 'expected an object');
      if (extent.kind === 'blind') {
        if (!isNumber(extent.depth)) h.fail(`${path}.extent.depth`, 'expected a number');
      } else if (extent.kind !== 'through') {
        h.fail(`${path}.extent.kind`, 'expected "blind" or "through"');
      }
      for (const field of [
        'counterboreDiameter',
        'counterboreDepth',
        'countersinkDiameter',
        'countersinkAngle',
      ]) {
        c.optionalNum(field);
      }
      c.optionalStr('thread');
      c.optionalStr('preset');
      break;
    }
    case 'emboss':
      profile(r.profile, `${path}.profile`, h);
      h.faceRef(r.face, `${path}.face`);
      c.num('depth');
      break;
    case 'draft':
      c.faceList('faces');
      plane(r.neutral, `${path}.neutral`, h);
      c.num('angle');
      c.bool('flip');
      break;
    case 'rib':
      c.str('sketchId');
      if (!Array.isArray(r.entityIds) || r.entityIds.length === 0 || !r.entityIds.every(isString)) {
        h.fail(`${path}.entityIds`, 'expected a non-empty array of strings');
      }
      c.num('thickness');
      c.bool('flip');
      c.optionalStr('targetBodyId');
      break;
    case 'thicken': {
      const source = r.source;
      if (!isRecord(source)) h.fail(`${path}.source`, 'expected an object');
      if (source.kind === 'faces') {
        if (!Array.isArray(source.faces) || source.faces.length === 0) {
          h.fail(`${path}.source.faces`, 'expected a non-empty array');
        }
        source.faces.forEach((f, i) => h.faceRef(f, `${path}.source.faces[${i}]`));
      } else if (source.kind === 'profile') {
        profile(source.profile, `${path}.source.profile`, h);
      } else {
        h.fail(`${path}.source.kind`, 'expected "faces" or "profile"');
      }
      c.num('thickness');
      c.oneOf('direction', ['outside', 'inside', 'both']);
      c.oneOf('operation', ['new', 'join', 'cut']);
      c.optionalStr('targetBodyId');
      c.optionalStr('resultBodyName');
      break;
    }
    default:
      h.fail(`${path}.kind`, `unknown feature kind "${String(r.kind)}"`);
  }
  return r as unknown as Feature;
}

/**
 * The optional variant fields of fillet, chamfer, shell and boolean
 * features. Returns `true` when `edges` may be empty (edges chosen by rule).
 */
export function validateBlendOptions(r: Rec, path: string, h: FormatHelpers): boolean {
  const c = checkers(r, path, h);
  switch (r.kind) {
    case 'fillet':
    case 'chamfer': {
      if (r.kind === 'fillet') c.optionalNum('radius2');
      if (r.kind === 'chamfer') {
        if (r.mode !== undefined) c.oneOf('mode', ['equal', 'twoDistances', 'distanceAngle']);
        c.optionalNum('distance2');
        c.optionalNum('angle');
        c.optionalBool('flip');
      }
      if (r.rules === undefined) return false;
      if (!Array.isArray(r.rules)) h.fail(`${path}.rules`, 'expected an array');
      r.rules.forEach((rule, i) => {
        const at = `${path}.rules[${i}]`;
        if (!isRecord(rule)) h.fail(at, 'expected an object');
        if (rule.kind === 'faceEdges') h.faceRef(rule.face, `${at}.face`);
        else if (rule.kind === 'concave' || rule.kind === 'convex') {
          if (!isString(rule.bodyId)) h.fail(`${at}.bodyId`, 'expected a string');
        } else h.fail(`${at}.kind`, 'expected "faceEdges", "concave" or "convex"');
      });
      return r.rules.length > 0;
    }
    case 'shell': {
      if (r.direction !== undefined) c.oneOf('direction', ['inside', 'outside']);
      c.optionalNum('clearance');
      if (r.faceThickness !== undefined) {
        if (!Array.isArray(r.faceThickness)) h.fail(`${path}.faceThickness`, 'expected an array');
        r.faceThickness.forEach((entry, i) => {
          const at = `${path}.faceThickness[${i}]`;
          if (!isRecord(entry)) h.fail(at, 'expected an object');
          h.faceRef(entry.face, `${at}.face`);
          if (!isNumber(entry.thickness)) h.fail(`${at}.thickness`, 'expected a number');
        });
      }
      return false;
    }
    case 'boolean':
      c.optionalBool('keepTools');
      return false;
    default:
      return false;
  }
}
