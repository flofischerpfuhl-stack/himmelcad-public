/**
 * Builds stored {@link Feature}s from `feature.create`/`feature.edit`
 * params. Known kinds get defaults and reference resolution; every kind —
 * known or not — is finally validated by the project-format validator
 * (`model/project/format.ts`), so the API can never commit a feature that
 * Save/Open would reject.
 */
import type { EvaluationResult } from '../kernel/types.js';
import type { Feature } from '../model/document.js';
import { ProjectFormatError, migrateAndValidate } from '../model/project/format.js';
import { ApiError } from './errors.js';
import { resolveEdgeInput, resolveFaceInput, fillSignatures } from './references.js';
import { DEFS, FEATURE_KIND_SCHEMAS } from './schema.js';
import { validateSchema, type JsonSchema } from './validate.js';

type Json = Record<string, unknown>;

const SCHEMA_ROOT: JsonSchema = { $defs: DEFS };
const RESERVED_FIELDS = ['id', 'name', 'kind', 'suppressed'];

/** The stored fields of a feature that the API exposes as `params`. */
export function paramsOf(feature: Feature): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(feature)) {
    if (!RESERVED_FIELDS.includes(key)) out[key] = value;
  }
  return out;
}

/** Agent-friendly shorthands accepted on input (normalised before validation). */
function preprocess(kind: string, params: Json): Json {
  const out = { ...params };
  if (kind === 'sketch' && typeof out.plane === 'string') {
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
  switch (kind) {
    case 'sketch': {
      const plane = out.plane as Json | undefined;
      if (plane?.kind === 'plane') out.plane = { offset: 0, ...plane };
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
      const profile = out.profile as Json | undefined;
      if (profile?.kind === 'face') {
        out.profile = {
          kind: 'face',
          face: resolveFaceInput(profile.face, evaluation, features, 'params.profile.face', {
            single: true,
          })[0],
        };
      }
      return out;
    }
    case 'fillet':
    case 'chamfer':
      if (Array.isArray(out.edges)) {
        out.edges = out.edges.flatMap((edge, i) =>
          resolveEdgeInput(edge, evaluation, `params.edges[${i}]`),
        );
        dedupeByKey(out, 'edges');
      }
      return out;
    case 'shell':
      if (Array.isArray(out.faces)) {
        out.faces = out.faces.flatMap((face, i) =>
          resolveFaceInput(face, evaluation, features, `params.faces[${i}]`, { single: false }),
        );
        dedupeByKey(out, 'faces');
      }
      return out;
    default:
      return FEATURE_KIND_SCHEMAS[kind]
        ? out
        : (fillSignatures(out, evaluation, features, 'params') as Json);
  }
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
    case 'extrude':
      return { symmetric: false, operation: 'new' };
    case 'move':
      return { dx: 0, dy: 0, dz: 0 };
    case 'shell': {
      const faces = params.faces as { bodyId: string }[] | undefined;
      return faces?.[0] ? { bodyId: faces[0].bodyId } : {};
    }
    default:
      return {};
  }
}

/** Strict final check through the `.hcasm` validator (the persistence contract). */
export function validateStored(feature: Feature): Feature {
  try {
    const project = migrateAndValidate(1, {
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
}): Feature {
  const raw = preprocess(input.kind, input.params);
  checkSchema(input.kind, raw);
  const resolved = normalise(input.kind, raw, input.evaluation, input.features);
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
}): Feature {
  const kind = input.existing.kind;
  const patch = preprocess(kind, input.params);
  checkSchema(kind, { ...paramsOf(input.existing), ...patch });
  const resolved = normalise(kind, patch, input.evaluation, input.features);
  return validateStored({ ...input.existing, ...resolved } as Feature);
}

export function featureLabel(kind: string, params: Json): string {
  if (kind === 'boolean') {
    const op = params.operation;
    return op === 'subtract' ? 'Subtract' : op === 'intersect' ? 'Intersect' : 'Union';
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
