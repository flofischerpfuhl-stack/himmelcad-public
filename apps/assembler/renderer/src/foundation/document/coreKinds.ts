/**
 * Registration of the core kinds (`document.ts`): the kinds the evaluator
 * implements with its private state. Loaded by `format.ts`, so every
 * program that reads or writes documents knows them. Their `.hcasm`
 * validators are the ones `format.ts` had inline; the messages are
 * unchanged.
 */
import type { FeatureKindDefinition, FormatHelpers } from './featureKinds.js';
import { registerFeatureKind } from './featureKinds.js';
import { MAX_EXTRUDE_TAPER } from './document.js';
import { fieldCheckers, isNumber, isRecord, isString } from './validation.js';

type Rec = Record<string, unknown>;

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

function optionalExpression(r: Rec, field: string, path: string, h: FormatHelpers): void {
  if (r[field] !== undefined && !isString(r[field]))
    h.fail(`${path}.${field}`, 'expected a string');
}

/**
 * The optional variant fields of fillet, chamfer, shell and boolean
 * features (`blendOptions.ts`). Returns `true` when `edges` may be empty
 * (edges chosen by rule).
 */
export function validateBlendOptions(r: Rec, path: string, h: FormatHelpers): boolean {
  const c = fieldCheckers(r, path, h);
  switch (r.kind) {
    case 'fillet':
    case 'chamfer': {
      if (r.kind === 'fillet') {
        c.optionalNum('radius2');
        c.optionalStr('radius2Expression');
      }
      if (r.kind === 'chamfer') {
        if (r.mode !== undefined) c.oneOf('mode', ['equal', 'twoDistances', 'distanceAngle']);
        c.optionalNum('distance2');
        c.optionalStr('distance2Expression');
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
      c.optionalBool('keepTarget');
      return false;
    default:
      return false;
  }
}

/** Extent, second side and start offset of an extrude (all optional, additive). */
function validateExtrudeExtent(r: Rec, path: string, h: FormatHelpers): void {
  const extent = r.extent;
  if (extent !== undefined) {
    if (!isRecord(extent)) h.fail(`${path}.extent`, 'expected an object');
    if (extent.kind === 'toObject') {
      const target = extent.target;
      if (!isRecord(target)) h.fail(`${path}.extent.target`, 'expected an object');
      if (target.kind === 'face') h.faceRef(target.face, `${path}.extent.target.face`);
      else if (target.kind === 'body') {
        if (!isString(target.bodyId)) h.fail(`${path}.extent.target.bodyId`, 'expected a string');
      } else h.fail(`${path}.extent.target.kind`, 'expected "face" or "body"');
    } else if (extent.kind !== 'distance' && extent.kind !== 'throughAll') {
      h.fail(`${path}.extent.kind`, 'expected "distance", "throughAll" or "toObject"');
    }
  }
  if (r.distance2 !== undefined && !(isNumber(r.distance2) && r.distance2 >= 0)) {
    h.fail(`${path}.distance2`, 'expected a number ≥ 0');
  }
  if (r.startOffset !== undefined && !isNumber(r.startOffset)) {
    h.fail(`${path}.startOffset`, 'expected a number');
  }
  if (r.taper !== undefined && !(isNumber(r.taper) && Math.abs(r.taper) <= MAX_EXTRUDE_TAPER)) {
    h.fail(
      `${path}.taper`,
      `expected a number of degrees between -${MAX_EXTRUDE_TAPER} and ${MAX_EXTRUDE_TAPER}`,
    );
  }
}

function validateBlend(r: Rec, path: string, h: FormatHelpers): void {
  // Edges picked by rule (`rules`) allow an empty `edges` list.
  const byRule = validateBlendOptions(r, path, h);
  if (!Array.isArray(r.edges) || (r.edges.length === 0 && !byRule)) {
    h.fail(`${path}.edges`, 'expected a non-empty array');
  }
  r.edges.forEach((e, i) => h.edgeRef(e, `${path}.edges[${i}]`));
  const sizeField = r.kind === 'fillet' ? 'radius' : 'distance';
  if (!isNumber(r[sizeField])) h.fail(`${path}.${sizeField}`, 'expected a number');
  optionalExpression(r, `${sizeField}Expression`, path, h);
}

/** The core kinds in their historical order (the order `format.ts` validated them in). */
export const CORE_FEATURE_KINDS: readonly FeatureKindDefinition[] = [
  {
    kind: 'extrude',
    module: 'document',
    label: 'Extrude',
    expressionFields: ['distance'],
    sketchIdsUsedBy: (f) => (f.profile.kind === 'sketch' ? [f.profile.featureId] : []),
    // Push/pull of a body face joins outwards and cuts inwards whatever `operation` says.
    booleanResult: (f) => f.profile.kind === 'face',
    // Block 8: an older reader would build the walls straight.
    formatCapabilities: [
      { id: 'extrude.taper', label: 'Extrude taper', usedBy: (f) => (f.taper ?? 0) !== 0 },
    ],
    validate(r: Rec, path: string, h: FormatHelpers) {
      const profile = r.profile;
      if (!isRecord(profile)) h.fail(`${path}.profile`, 'expected an object');
      if (profile.kind === 'sketch') {
        if (!isString(profile.featureId)) h.fail(`${path}.profile.featureId`, 'expected a string');
        if (
          profile.regions !== undefined &&
          (!Array.isArray(profile.regions) || !profile.regions.every(isString))
        ) {
          h.fail(`${path}.profile.regions`, 'expected an array of region keys');
        }
      } else if (profile.kind === 'face') {
        h.faceRef(profile.face, `${path}.profile.face`);
      } else {
        h.fail(`${path}.profile.kind`, 'expected "sketch" or "face"');
      }
      if (!isNumber(r.distance)) h.fail(`${path}.distance`, 'expected a number');
      optionalExpression(r, 'distanceExpression', path, h);
      if (!isBoolean(r.symmetric)) h.fail(`${path}.symmetric`, 'expected a boolean');
      if (!['new', 'join', 'cut', 'intersect'].includes(r.operation as string)) {
        h.fail(`${path}.operation`, 'expected "new", "join", "cut" or "intersect"');
      }
      if (r.targetBodyId !== undefined && !isString(r.targetBodyId)) {
        h.fail(`${path}.targetBodyId`, 'expected a string');
      }
      validateExtrudeExtent(r, path, h);
    },
  } satisfies FeatureKindDefinition<'extrude'>,
  {
    kind: 'fillet',
    module: 'document',
    label: 'Fillet',
    expressionFields: ['radius', 'radius2'],
    validate: validateBlend,
  } satisfies FeatureKindDefinition<'fillet'>,
  {
    kind: 'chamfer',
    module: 'document',
    label: 'Chamfer',
    expressionFields: ['distance', 'distance2'],
    validate: validateBlend,
  } satisfies FeatureKindDefinition<'chamfer'>,
  {
    kind: 'shell',
    module: 'document',
    label: 'Shell',
    expressionFields: ['thickness'],
    validate(r: Rec, path: string, h: FormatHelpers) {
      if (!isString(r.bodyId)) h.fail(`${path}.bodyId`, 'expected a string');
      if (!Array.isArray(r.faces) || r.faces.length === 0) {
        h.fail(`${path}.faces`, 'expected a non-empty array');
      }
      r.faces.forEach((f, i) => h.faceRef(f, `${path}.faces[${i}]`));
      if (!isNumber(r.thickness)) h.fail(`${path}.thickness`, 'expected a number');
      validateBlendOptions(r, path, h);
      optionalExpression(r, 'thicknessExpression', path, h);
    },
  } satisfies FeatureKindDefinition<'shell'>,
  {
    kind: 'boolean',
    module: 'document',
    label: 'Boolean',
    booleanResult: () => true,
    validate(r: Rec, path: string, h: FormatHelpers) {
      if (!['union', 'subtract', 'intersect'].includes(r.operation as string)) {
        h.fail(`${path}.operation`, 'expected "union", "subtract" or "intersect"');
      }
      if (!isString(r.targetBodyId)) h.fail(`${path}.targetBodyId`, 'expected a string');
      if (!Array.isArray(r.toolBodyIds) || !r.toolBodyIds.every(isString)) {
        h.fail(`${path}.toolBodyIds`, 'expected an array of strings');
      }
      validateBlendOptions(r, path, h);
    },
  } satisfies FeatureKindDefinition<'boolean'>,
  {
    kind: 'move',
    module: 'document',
    label: 'Move',
    validate(r: Rec, path: string, h: FormatHelpers) {
      for (const field of ['dx', 'dy', 'dz']) {
        if (!isNumber(r[field])) h.fail(`${path}.${field}`, 'expected a number');
      }
      if (!isString(r.bodyId)) h.fail(`${path}.bodyId`, 'expected a string');
    },
  } satisfies FeatureKindDefinition<'move'>,
  {
    kind: 'setAppearance',
    module: 'document',
    label: 'Appearance',
    validate(r: Rec, path: string, h: FormatHelpers) {
      if (!isString(r.bodyId)) h.fail(`${path}.bodyId`, 'expected a string');
      if (!isString(r.color) || !/^#[0-9a-fA-F]{6}$/.test(r.color)) {
        h.fail(`${path}.color`, 'expected a "#RRGGBB" string');
      }
      if (
        r.material !== undefined &&
        !['pla', 'petg', 'metal', 'resin'].includes(r.material as string)
      ) {
        h.fail(`${path}.material`, 'expected "pla", "petg", "metal" or "resin"');
      }
    },
  } satisfies FeatureKindDefinition<'setAppearance'>,
  {
    kind: 'importStep',
    module: 'document',
    label: 'Import',
    validate(r: Rec, path: string, h: FormatHelpers) {
      if (!isString(r.data) || r.data === '') h.fail(`${path}.data`, 'expected a non-empty string');
      if (!isString(r.fileName)) h.fail(`${path}.fileName`, 'expected a string');
      if (r.structure !== undefined && r.structure !== 'assembly') {
        h.fail(`${path}.structure`, 'expected "assembly"');
      }
      if (r.format !== undefined && r.format !== 'iges') {
        h.fail(`${path}.format`, 'expected "iges"');
      }
    },
  } satisfies FeatureKindDefinition<'importStep'>,
  {
    kind: 'meshSolid',
    module: 'document',
    label: 'Mesh to Solid',
    validate(r: Rec, path: string, h: FormatHelpers) {
      if (!isString(r.data) || r.data === '') h.fail(`${path}.data`, 'expected a non-empty string');
      if (!isString(r.fileName)) h.fail(`${path}.fileName`, 'expected a string');
      if (!isNumber(r.triangles) || r.triangles < 0) {
        h.fail(`${path}.triangles`, 'expected a non-negative number');
      }
    },
  } satisfies FeatureKindDefinition<'meshSolid'>,
] as unknown as readonly FeatureKindDefinition[];

for (const definition of CORE_FEATURE_KINDS) registerFeatureKind(definition);
