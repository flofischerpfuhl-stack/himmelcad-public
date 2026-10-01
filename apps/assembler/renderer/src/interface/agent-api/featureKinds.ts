/**
 * Builds stored {@link Feature}s from `feature.create`/`feature.edit`
 * params. Known kinds get defaults and reference resolution; every kind —
 * known or not — is finally validated by the project-format validator
 * (`model/project/format.ts`), so the API can never commit a feature that
 * Save/Open would reject.
 */
import type { EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import type { Feature } from '../../foundation/document/document.js';
import {
  CURRENT_SCHEMA_VERSION,
  ProjectFormatError,
  migrateAndValidate,
} from '../../foundation/document/format.js';

import { datumRef } from '../../foundation/geometry-kernel/datums.js';
import {
  expressionFieldsOf,
  resolveFieldExpression,
} from '../../foundation/document/parameters.js';
import { ApiError } from '../../foundation/commands/api/errors.js';
import { paramsOf } from '../../foundation/commands/api/describe.js';
import { addShape, type ShapeResult, type SketchShape } from '../../modules/sketching/sketchApi.js';
import {
  resolveEdgeInput,
  resolveFaceInput,
  fillSignatures,
} from '../../foundation/commands/api/references.js';
import { DEFS, FEATURE_KIND_SCHEMAS } from './schema.js';
import { PRIMITIVE_LABEL, type PrimitiveShape } from '../../modules/modeling/features.js';
import { validateSchema, type JsonSchema } from '../../foundation/commands/api/validate.js';

type Json = Record<string, unknown>;

const SCHEMA_ROOT: JsonSchema = { $defs: DEFS };
const RESERVED_FIELDS = ['id', 'name', 'kind', 'suppressed'];
// `paramsOf` (the stored fields the API exposes) is a read-model projection: `api/describe.ts`.

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Expands the sketch input shorthand `profiles: [SketchShape]` into
 * entities/constraints/dimensions (appended to the given ones, or to an
 * empty sketch when `fresh`). Returns the params without `profiles`.
 */
function expandSketchShapes(
  params: Json,
  base: { entities: unknown[]; constraints: unknown[]; dimensions: unknown[] },
  onShapes?: (shapes: ShapeResult[]) => void,
): Json {
  if (!Array.isArray(params.profiles)) return params;
  const { profiles, ...rest } = params;
  let sketch = {
    entities: (rest.entities as unknown[] | undefined) ?? base.entities,
    constraints: (rest.constraints as unknown[] | undefined) ?? base.constraints,
    dimensions: (rest.dimensions as unknown[] | undefined) ?? base.dimensions,
  } as Parameters<typeof addShape>[0];
  const shapes: ShapeResult[] = [];
  for (const shape of profiles as SketchShape[]) {
    const added = addShape(sketch, shape);
    sketch = added.sketch;
    shapes.push(added.added);
  }
  onShapes?.(shapes);
  return { ...rest, ...sketch };
}

export { paramsOf };

/** Agent-friendly shorthands accepted on input (normalised before validation). */
function preprocess(kind: string, params: Json): Json {
  const out = { ...params };
  if (
    (kind === 'sketch' || kind === 'mirror' || kind === 'split' || kind === 'primitive') &&
    typeof out.plane === 'string'
  ) {
    out.plane = { kind: 'plane', plane: out.plane, offset: 0 };
  }
  return out;
}

function checkSchema(kind: string, params: Json): void {
  for (const key of RESERVED_FIELDS) {
    if (key in params) {
      throw new ApiError('invalidParams', `params.${key} is not a parameter`, {
        hint: 'id/kind/suppressed are managed by the document; use feature.rename for the name.',
      });
    }
  }
  const spec = FEATURE_KIND_SCHEMAS[kind];
  if (!spec) return;
  const problems = validateSchema(params, spec.params, SCHEMA_ROOT);
  if (problems.length > 0) {
    throw new ApiError('invalidParams', `Invalid ${kind} params: ${problems[0]}`, {
      hint: `See featureKinds.${kind} in api.describe.`,
      details: { problems },
    });
  }
}

/** Resolves references/defaults of the given (possibly partial) params of a known kind. */
function normalise(
  kind: string,
  params: Json,
  evaluation: EvaluationResult,
  features: readonly Feature[],
): Json {
  const out = { ...params };
  /** A profile reference with its face selector (if any) resolved. */
  const profileRef = (value: unknown, path: string): unknown => {
    if (!isRecord(value) || value.kind !== 'face') return value;
    return {
      kind: 'face',
      face: resolveFaceInput(value.face, evaluation, features, `${path}.face`, { single: true })[0],
    };
  };
  const oneEdge = (value: unknown, path: string): unknown => {
    const edges = resolveEdgeInput(value, evaluation, path);
    if (edges.length !== 1) {
      throw new ApiError(
        'referenceNotFound',
        `${path}: expected exactly one edge, got ${edges.length}`,
        {
          hint: 'Narrow the selector or pass an explicit {bodyId, key} from edges.list.',
        },
      );
    }
    return edges[0];
  };
  const oneFace = (value: unknown, path: string): unknown =>
    resolveFaceInput(value, evaluation, features, path, { single: true })[0];
  /** A construction plane/axis reference with its signature (frame / line) from the evaluation. */
  const constructionRef = (value: Json, path: string): unknown => {
    if (typeof value.featureId !== 'string') return value;
    const filled = datumRef(evaluation, value.featureId);
    if (!filled) {
      if (value.frame !== undefined || value.line !== undefined) return value;
      throw new ApiError(
        'referenceNotFound',
        `${path}: "${value.featureId}" is not an evaluated construction plane or axis`,
        {
          hint: 'features.list shows constructionPlane/constructionAxis steps; datums.list their geometry.',
        },
      );
    }
    return filled;
  };
  const pointRef = (value: unknown, path: string): unknown => {
    if (!isRecord(value) || value.kind === 'point' || value.edge === undefined) return value;
    return { ...value, edge: oneEdge(value.edge, `${path}.edge`) };
  };
  const axisRef = (value: unknown, path: string): unknown => {
    if (isRecord(value) && value.kind === 'construction') return constructionRef(value, path);
    if (!isRecord(value) || value.kind !== 'edge') return value;
    const edges = resolveEdgeInput(value.edge, evaluation, `${path}.edge`);
    if (edges.length !== 1) {
      throw new ApiError(
        'referenceNotFound',
        `${path}.edge: expected exactly one edge, got ${edges.length}`,
        {
          hint: 'Narrow the selector or pass an explicit {bodyId, key} from edges.list.',
        },
      );
    }
    return { kind: 'edge', edge: edges[0] };
  };
  const planeRef = (value: unknown, path: string): unknown => {
    if (!isRecord(value)) return value;
    if (value.kind === 'plane') return { offset: 0, ...value };
    if (value.kind === 'construction') return constructionRef(value, path);
    if (value.kind !== 'face') return value;
    return {
      kind: 'face',
      face: resolveFaceInput(value.face, evaluation, features, `${path}.face`, { single: true })[0],
    };
  };
  switch (kind) {
    case 'sketch': {
      const plane = out.plane as Json | undefined;
      if (plane?.kind === 'plane') out.plane = { offset: 0, ...plane };
      if (plane?.kind === 'construction') out.plane = constructionRef(plane, 'params.plane');
      if (plane?.kind === 'face') {
        out.plane = {
          kind: 'face',
          face: resolveFaceInput(plane.face, evaluation, features, 'params.plane.face', {
            single: true,
          })[0],
        };
      }
      return out;
    }
    case 'extrude': {
      if (out.profile !== undefined) out.profile = profileRef(out.profile, 'params.profile');
      const extent = out.extent as Json | undefined;
      const target = extent?.target as Json | undefined;
      if (extent?.kind === 'toObject' && target?.kind === 'face') {
        out.extent = {
          ...extent,
          target: { kind: 'face', face: oneFace(target.face, 'params.extent.target.face') },
        };
      }
      return out;
    }
    case 'constructionPlane':
    case 'constructionAxis': {
      const def = out.definition as Json | undefined;
      if (!def) return out;
      const next: Json = { ...def };
      const p = 'params.definition';
      if (def.base !== undefined) next.base = planeRef(def.base, `${p}.base`);
      if (def.axis !== undefined) next.axis = axisRef(def.axis, `${p}.axis`);
      if (def.face !== undefined) next.face = oneFace(def.face, `${p}.face`);
      if (def.edge !== undefined) next.edge = oneEdge(def.edge, `${p}.edge`);
      if (Array.isArray(def.points)) {
        next.points = def.points.map((q, i) => pointRef(q, `${p}.points[${i}]`));
      }
      for (const key of ['a', 'b'] as const) {
        const value = def[key];
        if (!isRecord(value)) continue;
        next[key] =
          def.kind === 'twoPoints'
            ? pointRef(value, `${p}.${key}`)
            : planeRef(value, `${p}.${key}`);
      }
      out.definition = next;
      return out;
    }
    case 'revolve':
      if (out.profile !== undefined) out.profile = profileRef(out.profile, 'params.profile');
      if (out.axis !== undefined) out.axis = axisRef(out.axis, 'params.axis');
      return out;
    case 'rotateAxis':
      if (out.axis !== undefined) out.axis = axisRef(out.axis, 'params.axis');
      return out;
    case 'sweep': {
      if (out.profile !== undefined) out.profile = profileRef(out.profile, 'params.profile');
      const path = out.path as Json | undefined;
      if (path?.kind === 'edges' && Array.isArray(path.edges)) {
        const edges = path.edges.flatMap((edge, i) =>
          resolveEdgeInput(edge, evaluation, `params.path.edges[${i}]`),
        );
        out.path = { kind: 'edges', edges };
        dedupeByKey(out.path as Json, 'edges');
      }
      return out;
    }
    case 'loft':
      if (Array.isArray(out.profiles)) {
        out.profiles = out.profiles.map((p, i) => profileRef(p, `params.profiles[${i}]`));
      }
      return out;
    case 'mirror':
    case 'split':
      if (out.plane !== undefined) out.plane = planeRef(out.plane, 'params.plane');
      if (kind === 'split' && out.profile !== undefined) {
        out.profile = profileRef(out.profile, 'params.profile');
      }
      if (kind === 'mirror') {
        if (out.axis !== undefined) out.axis = axisRef(out.axis, 'params.axis');
        if (Array.isArray(out.faces)) {
          out.faces = out.faces.map((face, i) => oneFace(face, `params.faces[${i}]`));
        }
      }
      return out;
    case 'pattern': {
      const pattern = out.pattern as Json | undefined;
      if (pattern?.kind === 'linear' && pattern.direction !== undefined) {
        const second = pattern.second as Json | undefined;
        out.pattern = {
          ...pattern,
          direction: axisRef(pattern.direction, 'params.pattern.direction'),
          ...(isRecord(second) && second.direction !== undefined
            ? {
                second: {
                  ...second,
                  direction: axisRef(second.direction, 'params.pattern.second.direction'),
                },
              }
            : {}),
        };
      } else if (pattern?.kind === 'circular' && pattern.axis !== undefined) {
        out.pattern = { ...pattern, axis: axisRef(pattern.axis, 'params.pattern.axis') };
      }
      return out;
    }
    case 'align':
      for (const field of ['face', 'target'] as const) {
        if (out[field] !== undefined) {
          out[field] = resolveFaceInput(out[field], evaluation, features, `params.${field}`, {
            single: true,
          })[0];
        }
      }
      if (out.bodyId === undefined && isRecord(out.face)) out.bodyId = out.face.bodyId;
      return out;
    case 'offsetFace':
    case 'deleteFace':
      if (kind === 'offsetFace' && out.opposite !== undefined) {
        out.opposite = resolveFaceInput(out.opposite, evaluation, features, 'params.opposite', {
          single: true,
        })[0];
      }
      if (Array.isArray(out.faces)) {
        out.faces = out.faces.flatMap((face, i) =>
          resolveFaceInput(face, evaluation, features, `params.faces[${i}]`, { single: false }),
        );
        dedupeByKey(out, 'faces');
      }
      return out;
    case 'fillet':
    case 'chamfer':
      if (Array.isArray(out.edges)) {
        out.edges = out.edges.flatMap((edge, i) =>
          resolveEdgeInput(edge, evaluation, `params.edges[${i}]`),
        );
        dedupeByKey(out, 'edges');
      }
      if (Array.isArray(out.rules)) {
        out.rules = out.rules.map((rule, i) =>
          isRecord(rule) && rule.kind === 'faceEdges'
            ? {
                kind: 'faceEdges',
                face: resolveFaceInput(rule.face, evaluation, features, `params.rules[${i}].face`, {
                  single: true,
                })[0],
              }
            : rule,
        );
      }
      return out;
    case 'shell':
      if (Array.isArray(out.faces)) {
        out.faces = out.faces.flatMap((face, i) =>
          resolveFaceInput(face, evaluation, features, `params.faces[${i}]`, { single: false }),
        );
        dedupeByKey(out, 'faces');
      }
      if (Array.isArray(out.faceThickness)) {
        out.faceThickness = out.faceThickness.map((entry, i) =>
          isRecord(entry)
            ? {
                ...entry,
                face: resolveFaceInput(
                  entry.face,
                  evaluation,
                  features,
                  `params.faceThickness[${i}].face`,
                  { single: true },
                )[0],
              }
            : entry,
        );
      }
      return out;
    case 'hole':
    case 'emboss':
      if (out.face !== undefined) {
        out.face = resolveFaceInput(out.face, evaluation, features, 'params.face', {
          single: true,
        })[0];
      }
      if (out.profile !== undefined) out.profile = profileRef(out.profile, 'params.profile');
      return out;
    case 'draft':
      if (Array.isArray(out.faces)) {
        out.faces = out.faces.flatMap((face, i) =>
          resolveFaceInput(face, evaluation, features, `params.faces[${i}]`, { single: false }),
        );
        dedupeByKey(out, 'faces');
      }
      if (out.neutral !== undefined) out.neutral = planeRef(out.neutral, 'params.neutral');
      return out;
    case 'primitive':
      if (out.plane !== undefined) out.plane = planeRef(out.plane, 'params.plane');
      return out;
    case 'moveEdge':
      if (out.edge !== undefined) out.edge = oneEdge(out.edge, 'params.edge');
      return out;
    case 'moveFace':
      if (out.face !== undefined) out.face = oneFace(out.face, 'params.face');
      return out;
    case 'thicken': {
      const source = out.source as Json | undefined;
      if (source?.kind === 'faces' && Array.isArray(source.faces)) {
        const faces = source.faces.flatMap((face, i) =>
          resolveFaceInput(face, evaluation, features, `params.source.faces[${i}]`, {
            single: false,
          }),
        );
        out.source = { kind: 'faces', faces };
        dedupeByKey(out.source as Json, 'faces');
      } else if (source?.kind === 'profile') {
        out.source = {
          kind: 'profile',
          profile: profileRef(source.profile, 'params.source.profile'),
        };
      }
      return out;
    }
    default:
      return FEATURE_KIND_SCHEMAS[kind]
        ? out
        : (fillSignatures(out, evaluation, features, 'params') as Json);
  }
}

/**
 * Resolves the kind's `*Expression` field (extrude/fillet/chamfer/shell)
 * against the document's current parameter values, writing the plain
 * numeric field the kernel and `.hcasm` validator read. Only touches params
 * that actually set the expression field, so an edit that never mentions it
 * leaves an already-resolved value untouched.
 */
function resolveExpressionField(
  kind: string,
  params: Json,
  paramValues: ReadonlyMap<string, number>,
): Json {
  let out = params;
  for (const field of expressionFieldsOf(kind)) {
    const exprField = `${field}Expression`;
    const expression = params[exprField];
    if (typeof expression !== 'string') continue;
    const resolved = resolveFieldExpression(kind, field, expression, paramValues);
    if (!resolved.ok) {
      throw new ApiError('invalidParams', `params.${exprField}: ${resolved.message}`, {
        hint: 'parameters.list returns every document parameter name and value.',
      });
    }
    out = { ...out, [field]: resolved.value };
  }
  return out;
}

function dedupeByKey(params: Json, field: string): void {
  const seen = new Set<string>();
  params[field] = (params[field] as { bodyId: string; key: string }[]).filter((ref) => {
    const id = `${ref.bodyId}\u0000${ref.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Kind-specific defaults for a new feature (applied under the caller's params). */
function defaults(kind: string, params: Json): Json {
  switch (kind) {
    case 'sketch':
      return { entities: [], constraints: [], dimensions: [] };
    case 'extrude':
      return { symmetric: false, operation: 'new' };
    case 'revolve':
      return { angle: 360, operation: 'new' };
    case 'sweep':
      return { operation: 'new' };
    case 'loft':
      return { ruled: false, operation: 'new' };
    case 'mirror':
      return { keepOriginal: true, bodyIds: [], plane: { kind: 'plane', plane: 'YZ', offset: 0 } };
    case 'transform':
      return { dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0, pivot: [0, 0, 0], copy: false };
    case 'rotateAxis':
      return { copy: false };
    case 'align':
      return { flip: false, center: true, offset: 0 };
    case 'move':
      return { dx: 0, dy: 0, dz: 0 };
    case 'shell': {
      const faces = params.faces as { bodyId: string }[] | undefined;
      return faces?.[0] ? { bodyId: faces[0].bodyId } : {};
    }
    case 'fillet':
    case 'chamfer':
      return { edges: [] };
    case 'hole':
      return { holeType: 'simple', extent: { kind: 'through' } };
    case 'draft':
    case 'rib':
      return { flip: false };
    case 'thicken':
      return { direction: 'outside', operation: 'new' };
    case 'split':
      // A profile split needs no plane; the stored feature always has one.
      return { plane: { kind: 'plane', plane: 'XY', offset: 0 } };
    case 'scale':
      return { factor: 1, center: [0, 0, 0], copy: false };
    case 'translate':
      return { copy: false };
    case 'primitive':
      return {
        plane: { kind: 'plane', plane: 'XY', offset: 0 },
        center: [0, 0, 0],
        operation: 'new',
      };
    default:
      return {};
  }
}

/** Strict final check through the `.hcasm` validator (the persistence contract). */
export function validateStored(feature: Feature): Feature {
  try {
    const project = migrateAndValidate(CURRENT_SCHEMA_VERSION, {
      appVersion: 'agent-api',
      units: 'mm',
      projectName: 'validation',
      features: [feature],
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z',
    });
    return project.features[0]!;
  } catch (error) {
    if (error instanceof ProjectFormatError) {
      throw new ApiError('invalidParams', error.message.replace('features[0]', 'params'), {
        hint:
          FEATURE_KIND_SCHEMAS[feature.kind] === undefined
            ? `"${feature.kind}" is not a known feature kind; see featureKinds in api.describe.`
            : `See featureKinds.${feature.kind} in api.describe.`,
      });
    }
    throw error;
  }
}

export function buildNewFeature(input: {
  id: string;
  name: string;
  kind: string;
  params: Json;
  evaluation: EvaluationResult;
  features: readonly Feature[];
  /** Receives what the sketch `profiles` shorthand created. */
  onShapes?: (shapes: ShapeResult[]) => void;
  /** Document parameter values, for a `*Expression` field (`model/parameters.ts`). */
  paramValues?: ReadonlyMap<string, number>;
}): Feature {
  const raw = preprocess(input.kind, input.params);
  checkSchema(input.kind, raw);
  const expanded =
    input.kind === 'sketch'
      ? expandSketchShapes(raw, { entities: [], constraints: [], dimensions: [] }, input.onShapes)
      : raw;
  const withExpressions = resolveExpressionField(
    input.kind,
    expanded,
    input.paramValues ?? new Map(),
  );
  const resolved = normalise(input.kind, withExpressions, input.evaluation, input.features);
  const feature = {
    id: input.id,
    name: input.name,
    suppressed: false,
    kind: input.kind,
    ...defaults(input.kind, resolved),
    ...resolved,
  } as unknown as Feature;
  return validateStored(feature);
}

/** Applies a parameter patch to an existing feature (shallow merge, like the UI's `editFeatureParams`). */
export function buildEditedFeature(input: {
  existing: Feature;
  params: Json;
  evaluation: EvaluationResult;
  features: readonly Feature[];
  onShapes?: (shapes: ShapeResult[]) => void;
  /** Document parameter values, for a `*Expression` field (`model/parameters.ts`). */
  paramValues?: ReadonlyMap<string, number>;
}): Feature {
  const kind = input.existing.kind;
  const patch = preprocess(kind, input.params);
  checkSchema(kind, { ...paramsOf(input.existing), ...patch });
  // Editing a sketch with the `profiles` shorthand replaces its geometry by those shapes.
  const expanded =
    kind === 'sketch'
      ? expandSketchShapes(patch, { entities: [], constraints: [], dimensions: [] }, input.onShapes)
      : patch;
  const withExpressions = resolveExpressionField(kind, expanded, input.paramValues ?? new Map());
  const resolved = normalise(kind, withExpressions, input.evaluation, input.features);
  return validateStored({ ...input.existing, ...resolved } as Feature);
}

export function featureLabel(kind: string, params: Json): string {
  if (kind === 'boolean') {
    const op = params.operation;
    return op === 'subtract' ? 'Subtract' : op === 'intersect' ? 'Intersect' : 'Union';
  }
  // A primitive is named after its shape (Box 1), like the Add tools do.
  if (kind === 'primitive' && typeof params.shape === 'string' && params.shape in PRIMITIVE_LABEL) {
    return PRIMITIVE_LABEL[params.shape as PrimitiveShape];
  }
  return FEATURE_KIND_SCHEMAS[kind]?.label ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Same naming rule as the store's `nextFeatureName` ("Extrude 3"). */
export function nextFeatureName(prefix: string, features: readonly Feature[]): string {
  const count = features.filter((f) => f.name.startsWith(`${prefix} `)).length;
  return `${prefix} ${count + 1}`;
}

/** Feature-id kind segment the UI tools use (`feature-<segment>-<n>`). */
export function idSegment(kind: string): string {
  return kind === 'importStep' ? 'import' : kind === 'setAppearance' ? 'appearance' : kind;
}
