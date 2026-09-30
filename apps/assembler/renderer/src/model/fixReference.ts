/**
 * History "Fix…" (Shapr3D, modelling research §5; interaction research §3):
 * a step whose reference no longer resolves shows a warning; Fix… shows
 * where the missing geometry was (its last known place — the reference's
 * signature — as an outlined ghost) and lets the user pick a replacement.
 * The replacement is written into the step as one undo step; the next
 * missing reference of the same step follows, then the session ends.
 *
 * Pure analysis ({@link missingReferences}, {@link replaceAt},
 * {@link replacementFor}) plus a small session store; the viewport routes
 * clicks here while a session runs.
 */
import { create } from 'zustand';

import type { EvaluationResult } from '../foundation/geometry-kernel/types.js';
import { datumRef } from './construction.js';
import {
  frameForFace,
  type EdgeRef,
  type FaceRef,
  type Feature,
  type SketchFrame,
  type Vec3,
} from '../foundation/document/document.js';
import { parseMirroredSketchId } from './features.js';
import {
  findEdge,
  findFace,
  makeEdgeRef,
  makeFaceRef,
  useAssemblerStore,
  type SelectionItem,
} from '../foundation/commands/store.js';

/** What kind of geometry a reference needs. */
export type FixKind = 'face' | 'edge' | 'body' | 'sketch' | 'profile' | 'plane' | 'axis';

/** Where the missing geometry was, for the ghost. */
export type FixGhost =
  | { kind: 'plane'; frame: SketchFrame; center: Vec3; size: number }
  | { kind: 'axis'; point: Vec3; dir: Vec3; size: number }
  | { kind: 'point'; point: Vec3 };

export interface MissingReference {
  /** Path of the reference inside the feature (object keys and array indices). */
  path: (string | number)[];
  kind: FixKind;
  /** Readable label ("face", "construction plane", "sketch profile"). */
  label: string;
  ghost: FixGhost | null;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFaceRef(value: Json): value is Json & FaceRef {
  return (
    typeof value.bodyId === 'string' &&
    typeof value.key === 'string' &&
    isRecord(value.signature) &&
    'surface' in value.signature
  );
}

function isEdgeRef(value: Json): value is Json & EdgeRef {
  return (
    typeof value.bodyId === 'string' &&
    typeof value.key === 'string' &&
    isRecord(value.signature) &&
    'curve' in value.signature
  );
}

function faceGhost(ref: FaceRef): FixGhost {
  const { normal, centroid, area } = ref.signature;
  if (!normal) return { kind: 'point', point: centroid };
  return {
    kind: 'plane',
    frame: frameForFace(normal, centroid),
    center: centroid,
    size: Math.max(2, Math.sqrt(Math.max(area, 0)) / 2),
  };
}

function edgeGhost(ref: EdgeRef): FixGhost {
  const { midpoint, direction, length } = ref.signature;
  return direction
    ? { kind: 'axis', point: midpoint, dir: direction, size: Math.max(1, length / 2) }
    : { kind: 'point', point: midpoint };
}

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c));

/**
 * Where a missing construction plane was drawn: the centre and size stored
 * with the reference (`shown`), else — for references saved before that —
 * the frame origin (the world origin projected onto the plane).
 */
function planeGhost(frame: SketchFrame, shown: unknown): FixGhost {
  if (isRecord(shown) && isVec3(shown.center) && typeof shown.size === 'number') {
    return { kind: 'plane', frame, center: shown.center, size: shown.size };
  }
  return { kind: 'plane', frame, center: frame.origin, size: 20 };
}

/**
 * References of `feature` that do not resolve in `evaluation` (first
 * reference first). Body ids, sketch/profile ids, construction planes and
 * axes, and face/edge keys are checked; a face/edge counts as missing when
 * its body is gone or its key (and aliases) is no longer on the body.
 */
export function missingReferences(
  feature: Feature,
  evaluation: EvaluationResult,
  features: readonly Feature[],
): MissingReference[] {
  const out: MissingReference[] = [];
  const bodyExists = (id: string) => evaluation.bodies.some((b) => b.id === id);
  const sketchExists = (id: string) =>
    features.some((f) => f.id === id && f.kind === 'sketch') ||
    (parseMirroredSketchId(id) !== null && evaluation.sketches.some((s) => s.featureId === id));
  const visit = (value: unknown, path: (string | number)[], parentKey: string | null): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, [...path, i], parentKey));
      return;
    }
    if (!isRecord(value)) {
      if (typeof value === 'string') {
        if ((parentKey === 'bodyId' || parentKey === 'targetBodyId') && !bodyExists(value)) {
          if (path.length > 0 && path[path.length - 1] === parentKey) {
            // Only direct body fields; a face/edge ref's bodyId is checked with the ref.
            out.push({ path, kind: 'body', label: 'body', ghost: null });
          }
        } else if (parentKey === 'bodyIds' || parentKey === 'toolBodyIds') {
          if (!bodyExists(value)) out.push({ path, kind: 'body', label: 'body', ghost: null });
        } else if (parentKey === 'sketchIds' && !sketchExists(value)) {
          out.push({ path, kind: 'sketch', label: 'sketch', ghost: null });
        }
      }
      return;
    }
    if (isFaceRef(value)) {
      const body = evaluation.bodies.find((b) => b.id === value.bodyId);
      if (!body || !findFace(body, value.key)) {
        out.push({ path, kind: 'face', label: 'face', ghost: faceGhost(value) });
      }
      return;
    }
    if (isEdgeRef(value)) {
      const body = evaluation.bodies.find((b) => b.id === value.bodyId);
      if (!body || !findEdge(body, value.key)) {
        out.push({ path, kind: 'edge', label: 'edge', ghost: edgeGhost(value) });
      }
      return;
    }
    if (value.kind === 'construction' && typeof value.featureId === 'string') {
      const datum = evaluation.datums?.find((d) => d.featureId === value.featureId);
      if (isRecord(value.frame)) {
        if (datum?.kind !== 'plane') {
          out.push({
            path,
            kind: 'plane',
            label: 'construction plane',
            ghost: planeGhost(value.frame as unknown as SketchFrame, value.shown),
          });
        }
      } else if (isRecord(value.line)) {
        if (datum?.kind !== 'axis') {
          const line = value.line as unknown as { point: Vec3; dir: Vec3 };
          out.push({
            path,
            kind: 'axis',
            label: 'construction axis',
            ghost: { kind: 'axis', point: line.point, dir: line.dir, size: 20 },
          });
        }
      }
      return;
    }
    if (value.kind === 'sketch' && typeof value.featureId === 'string') {
      // A profile reference (extrude/revolve/sweep/loft profile, sweep path).
      if (!sketchExists(value.featureId)) {
        out.push({ path, kind: 'profile', label: 'sketch profile', ghost: null });
        return;
      }
      if (Array.isArray(value.regions)) {
        const sketch = evaluation.sketches.find((s) => s.featureId === value.featureId);
        const missing = sketch
          ? (value.regions as string[]).some((k) => !sketch.profiles.some((p) => p.key === k))
          : false;
        if (missing) out.push({ path, kind: 'profile', label: 'sketch profile', ghost: null });
      }
      return;
    }
    if (value.kind === 'sketchLine' && typeof value.featureId === 'string') {
      if (!sketchExists(value.featureId)) {
        out.push({ path, kind: 'axis', label: 'axis', ghost: null });
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'id' || key === 'name' || key === 'kind' || key === 'signature') continue;
      visit(child, [...path, key], key);
    }
  };
  visit(feature, [], null);
  return out;
}

/** `feature` with the value at `path` replaced (structural copy along the path). */
export function replaceAt<T>(feature: T, path: readonly (string | number)[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  if (Array.isArray(feature)) {
    const copy = [...feature];
    copy[head as number] = replaceAt(copy[head as number], rest, value);
    return copy as T;
  }
  const record = feature as unknown as Json;
  return { ...record, [head as string]: replaceAt(record[head as string], rest, value) } as T;
}

/**
 * The reference value a picked item gives for a missing reference of
 * `kind`, or the reason it does not fit. Keeps the shape of the old
 * reference where it matters (a profile's `kind: 'sketch'` wrapper).
 */
export function replacementFor(
  missing: MissingReference,
  pick: SelectionItem,
  evaluation: EvaluationResult,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  switch (missing.kind) {
    case 'face': {
      if (pick.kind !== 'face') return { ok: false, reason: 'Pick a face.' };
      const ref = makeFaceRef(evaluation, pick.bodyId, pick.faceKey);
      return ref ? { ok: true, value: ref } : { ok: false, reason: 'That face is not evaluated.' };
    }
    case 'edge': {
      if (pick.kind !== 'edge') return { ok: false, reason: 'Pick an edge.' };
      const ref = makeEdgeRef(evaluation, pick.bodyId, pick.edgeKey);
      return ref ? { ok: true, value: ref } : { ok: false, reason: 'That edge is not evaluated.' };
    }
    case 'body': {
      const bodyId =
        pick.kind === 'body' || pick.kind === 'face' || pick.kind === 'edge' ? pick.bodyId : null;
      return bodyId ? { ok: true, value: bodyId } : { ok: false, reason: 'Pick a body.' };
    }
    case 'sketch':
      return pick.kind === 'sketchProfile'
        ? { ok: true, value: pick.featureId }
        : { ok: false, reason: 'Pick a sketch.' };
    case 'profile':
      return pick.kind === 'sketchProfile'
        ? {
            ok: true,
            value: {
              kind: 'sketch',
              featureId: pick.featureId,
              ...(pick.regionKey !== undefined ? { regions: [pick.regionKey] } : {}),
            },
          }
        : { ok: false, reason: 'Pick a sketch profile.' };
    case 'plane': {
      if (pick.kind === 'datum') {
        const ref = datumRef(evaluation, pick.featureId);
        if (ref && 'frame' in ref) return { ok: true, value: ref };
        return { ok: false, reason: 'Pick a construction plane or a planar face.' };
      }
      if (pick.kind === 'face') {
        const ref = makeFaceRef(evaluation, pick.bodyId, pick.faceKey);
        if (ref?.signature.normal) return { ok: true, value: { kind: 'face', face: ref } };
      }
      return { ok: false, reason: 'Pick a construction plane or a planar face.' };
    }
    case 'axis': {
      if (pick.kind === 'datum') {
        const ref = datumRef(evaluation, pick.featureId);
        if (ref && 'line' in ref) return { ok: true, value: ref };
      }
      if (pick.kind === 'edge') {
        const ref = makeEdgeRef(evaluation, pick.bodyId, pick.edgeKey);
        if (ref && (ref.signature.curve === 'line' || ref.signature.curve === 'circle')) {
          return { ok: true, value: { kind: 'edge', edge: ref } };
        }
      }
      return { ok: false, reason: 'Pick a construction axis or a straight edge.' };
    }
  }
}

// ---- session ---------------------------------------------------------------------------------

export interface FixSession {
  featureId: string;
  featureName: string;
  missing: MissingReference;
  /** How many references of the step were missing when the session started. */
  total: number;
  /** Why the last pick did not fit, else `null`. */
  problem: string | null;
}

export interface FixState {
  session: FixSession | null;
  start: (session: Omit<FixSession, 'problem'>) => void;
  setProblem: (problem: string | null) => void;
  end: () => void;
}

export const useFixStore = create<FixState>((set) => ({
  session: null,
  start: (session) => set({ session: { ...session, problem: null } }),
  setProblem: (problem) => set((s) => (s.session ? { session: { ...s.session, problem } } : {})),
  end: () => set({ session: null }),
}));

// A session belongs to one step of one document: it ends when another document is loaded
// (ids are sequential and may recur there) or when its step is gone (undo, delete).
useAssemblerStore.subscribe((state, previous) => {
  const session = useFixStore.getState().session;
  if (!session) return;
  if (
    state.documentGeneration !== previous.documentGeneration ||
    (state.features !== previous.features &&
      !state.features.some((f) => f.id === session.featureId))
  ) {
    useFixStore.getState().end();
  }
});

/** The ghost of the running Fix session's missing reference (drawn by the viewport). */
export function fixGhost(): FixGhost | null {
  return useFixStore.getState().session?.missing.ghost ?? null;
}

/**
 * Starts "Fix…" on step `featureId`: its first missing reference becomes the
 * one to replace. Returns why it cannot start (no missing reference, a tool
 * is running), else `null`.
 */
export function startFix(featureId: string): string | null {
  const state = useAssemblerStore.getState();
  if (state.activeTool) return 'Finish the running tool first.';
  const feature = state.features.find((f) => f.id === featureId);
  if (!feature) return 'That step no longer exists.';
  const missing = missingReferences(feature, state.evaluation, state.features);
  if (missing.length === 0) {
    return state.evaluation.errors[featureId]
      ? 'No missing reference found; the step fails for another reason (see its message).'
      : 'Every reference of this step resolves.';
  }
  state.clearSelection();
  useFixStore.getState().start({
    featureId,
    featureName: feature.name,
    missing: missing[0]!,
    total: missing.length,
  });
  return null;
}

/**
 * Applies a pick to the running Fix session: a fitting pick replaces the
 * reference (one undo step) and moves on to the next missing reference of
 * the step (the session ends when none is left); a pick of the wrong kind
 * explains what is needed. Resolves `true` when the reference was replaced.
 */
export async function applyFixPick(item: SelectionItem): Promise<boolean> {
  const fix = useFixStore.getState();
  const session = fix.session;
  if (!session) return false;
  const state = useAssemblerStore.getState();
  const feature = state.features.find((f) => f.id === session.featureId);
  if (!feature) {
    fix.end();
    return false;
  }
  const replacement = replacementFor(session.missing, item, state.evaluation);
  if (!replacement.ok) {
    fix.setProblem(replacement.reason);
    return false;
  }
  const next = replaceAt(feature, session.missing.path, replacement.value);
  const done = state.commitDocumentChange(
    state.features.map((f) => (f.id === feature.id ? next : f)),
    { keepRollback: true, selection: [] },
  );
  if (!done) {
    fix.setProblem('Finish the running tool first.');
    return false;
  }
  await useAssemblerStore.getState().whenSettled();
  const after = useAssemblerStore.getState();
  const current = after.features.find((f) => f.id === feature.id);
  const remaining = current ? missingReferences(current, after.evaluation, after.features) : [];
  // Editing continues with the next missing reference of the same step.
  if (remaining.length > 0 && useFixStore.getState().session?.featureId === feature.id) {
    useFixStore.getState().start({ ...session, missing: remaining[0]! });
  } else {
    useFixStore.getState().end();
  }
  return true;
}
