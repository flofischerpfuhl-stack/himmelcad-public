/**
 * Turns agent-supplied reference inputs into the stored reference types of
 * `model/document.ts`: `{bodyId, key}` gets its geometric signature from the
 * given evaluation (exactly what the UI does when it builds a reference from
 * a click, via `makeFaceRef`/`makeEdgeRef`), `{bodyId, select}` expands a
 * selector. Unknown keys fail with `referenceNotFound` and the closest
 * candidate keys, so an agent can repair its call in one round.
 */
import type { Body, EvaluationResult } from '../../geometry-kernel/types.js';
import { keyFeatureId } from '../../geometry-kernel/naming.js';
import type { EdgeRef, FaceRef, Feature } from '../../document/document.js';
import { makeEdgeRef, makeFaceRef } from '../store.js';
import {
  describeEdgeName,
  describeFaceName,
  findBody,
  selectEdges,
  selectFaces,
} from '../../../api/describe.js';
import { ApiError } from './errors.js';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ranks candidate keys by similarity to `wanted`: same generating feature first, then shared prefix. */
function rankCandidates<T extends { key: string }>(wanted: string, items: T[]): T[] {
  const feature = keyFeatureId(wanted);
  const prefix = (a: string, b: string) => {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
    return n;
  };
  return [...items].sort((a, b) => {
    const fa = a.key.includes(feature) ? 1 : 0;
    const fb = b.key.includes(feature) ? 1 : 0;
    if (fa !== fb) return fb - fa;
    return prefix(b.key, wanted) - prefix(a.key, wanted);
  });
}

function faceCandidates(body: Body, wanted: string, features: readonly Feature[]) {
  return rankCandidates(wanted, body.faces)
    .slice(0, 12)
    .map((f) => ({ key: f.key, name: describeFaceName(f, features) }));
}

function edgeCandidates(body: Body, wanted: string) {
  return rankCandidates(wanted, body.edges)
    .slice(0, 12)
    .map((e) => ({ key: e.key, name: describeEdgeName(e) }));
}

export function resolveFaceInput(
  input: unknown,
  evaluation: EvaluationResult,
  features: readonly Feature[],
  path: string,
  options: { single: boolean },
): FaceRef[] {
  if (!isRecord(input) || typeof input.bodyId !== 'string') {
    throw new ApiError('invalidParams', `${path}: expected {bodyId, key} or {bodyId, select}`);
  }
  const body = findBody(evaluation, input.bodyId);
  if (typeof input.select === 'string') {
    const faces = selectFaces(body, input.select);
    if (faces.length === 0 || (options.single && faces.length !== 1)) {
      throw new ApiError(
        'referenceNotFound',
        `${path}: selector "${input.select}" matched ${faces.length} faces of "${body.name}"${options.single ? ', expected exactly one' : ''}`,
        {
          hint: 'Narrow the selector (combine terms with " and ") or pass an explicit {bodyId, key} from faces.list.',
          details: {
            matched: faces.map((f) => ({ key: f.key, name: describeFaceName(f, features) })),
          },
        },
      );
    }
    return faces.map((f) => makeFaceRef(evaluation, body.id, f.key)!);
  }
  if (typeof input.key !== 'string') {
    throw new ApiError('invalidParams', `${path}: expected "key" or "select"`);
  }
  const resolved = makeFaceRef(evaluation, body.id, input.key);
  if (!resolved) {
    throw new ApiError('referenceNotFound', `${path}: no face "${input.key}" on "${body.name}"`, {
      hint: 'Face keys come from faces.list; they name the generating feature and role (e.g. "<extrudeId>:end:0").',
      details: { bodyId: body.id, candidates: faceCandidates(body, input.key, features) },
    });
  }
  return [resolved];
}

export function resolveEdgeInput(
  input: unknown,
  evaluation: EvaluationResult,
  path: string,
): EdgeRef[] {
  if (!isRecord(input) || typeof input.bodyId !== 'string') {
    throw new ApiError('invalidParams', `${path}: expected {bodyId, key} or {bodyId, select}`);
  }
  const body = findBody(evaluation, input.bodyId);
  if (typeof input.select === 'string') {
    const edges = selectEdges(body, input.select);
    if (edges.length === 0) {
      throw new ApiError(
        'referenceNotFound',
        `${path}: selector "${input.select}" matched no edge of "${body.name}"`,
        {
          hint: 'Check edges.list for the body; selectors test line directions, circles and midpoints.',
        },
      );
    }
    return edges.map((e) => makeEdgeRef(evaluation, body.id, e.key)!);
  }
  if (typeof input.key !== 'string') {
    throw new ApiError('invalidParams', `${path}: expected "key" or "select"`);
  }
  const resolved = makeEdgeRef(evaluation, body.id, input.key);
  if (!resolved) {
    throw new ApiError('referenceNotFound', `${path}: no edge "${input.key}" on "${body.name}"`, {
      hint: 'Edge keys are "<faceKeyA>|<faceKeyB>" from edges.list.',
      details: { bodyId: body.id, candidates: edgeCandidates(body, input.key) },
    });
  }
  return [resolved];
}

/**
 * Generic pass for feature kinds without a registered resolver: every
 * `{bodyId, key}` object lacking a `signature` gets one — edge keys contain
 * `|`, face keys do not (see `kernel/naming.ts`).
 */
export function fillSignatures(
  value: unknown,
  evaluation: EvaluationResult,
  features: readonly Feature[],
  path: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => fillSignatures(item, evaluation, features, `${path}[${i}]`));
  }
  if (!isRecord(value)) return value;
  if (typeof value.bodyId === 'string' && typeof value.key === 'string' && !value.signature) {
    return value.key.includes('|')
      ? resolveEdgeInput(value, evaluation, path)[0]
      : resolveFaceInput(value, evaluation, features, path, { single: true })[0];
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = fillSignatures(v, evaluation, features, `${path}.${k}`);
  }
  return out;
}
