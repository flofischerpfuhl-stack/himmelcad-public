/**
 * The Replace Face tool (MOD-23) as a draft of the generic feature tool:
 * two input steps with Next — the faces to replace (planar, one body), then
 * the replacing face (planar or cylindrical, any body). Started with two
 * faces of two bodies selected (the adaptive suggestion next to Align), the
 * last selected face replaces the others. Pure data + functions.
 */
import { baseFaceKey, faceSignatureOf } from '../../foundation/geometry-kernel/naming.js';
import type { Body, EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import { frameForFace, type FaceRef, type Vec3 } from '../../foundation/document/document.js';
import {
  defineDraftTool,
  type DraftToolContext,
  type DraftToolGuides,
} from '../../foundation/commands/draftTools.js';

export interface ReplaceFaceDraft {
  kind: 'replaceFace';
  faces: FaceRef[];
  target: FaceRef | null;
  /** Input step (Next): 0 the faces to replace, 1 the replacing face. */
  step: 0 | 1;
}

declare module '../../foundation/commands/draftTools.js' {
  interface DraftToolMap {
    replaceFace: ReplaceFaceDraft;
  }
}

function faceOf(body: Body, key: string) {
  return (
    body.faces.find((f) => f.key === key) ??
    body.faces.find((f) => f.aliases.includes(key)) ??
    body.faces.find((f) => baseFaceKey(f.key) === baseFaceKey(key))
  );
}

function faceRefOf(evaluation: EvaluationResult, bodyId: string, key: string): FaceRef | null {
  const body = evaluation.bodies.find((b) => b.id === bodyId);
  const face = body ? faceOf(body, key) : undefined;
  return face ? { bodyId, key: face.key, signature: faceSignatureOf(face) } : null;
}

const isPlanar = (ref: FaceRef) => ref.signature.surface === 'plane';
/** Surfaces the kernel can replace with (`replaceFace.ts`). */
const replacingSurface = (ref: FaceRef) =>
  ref.signature.surface === 'plane' || ref.signature.surface === 'cylinder';

const sameFace = (a: FaceRef, b: FaceRef) =>
  a.bodyId === b.bodyId && baseFaceKey(a.key) === baseFaceKey(b.key);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Start: faces to replace (one body) and, if more than one face is selected, the last as the replacing face. */
export function createReplaceFaceDraft(
  ctx: DraftToolContext,
): { ok: true; draft: ReplaceFaceDraft } | { ok: false; reason: string } {
  const refs = ctx.selection
    .filter((s): s is Extract<typeof s, { kind: 'face' }> => s.kind === 'face')
    .map((f) => faceRefOf(ctx.evaluation, f.bodyId, f.faceKey))
    .filter((f): f is FaceRef => f !== null);
  if (refs.length === 0 || refs.length !== ctx.selection.length) {
    return { ok: false, reason: 'Select the planar faces to replace, then the replacing face.' };
  }
  const target = refs.length > 1 ? refs[refs.length - 1]! : null;
  const faces = target ? refs.slice(0, -1) : refs;
  if (faces.some((f) => f.bodyId !== faces[0]!.bodyId)) {
    return { ok: false, reason: 'The faces to replace must belong to one body.' };
  }
  if (!faces.every(isPlanar)) return { ok: false, reason: 'Only planar faces can be replaced.' };
  if (target && !replacingSurface(target)) {
    return { ok: false, reason: 'The replacing face must be planar or cylindrical.' };
  }
  // Started with its faces: the replacing-face step is current (a step badge goes back).
  return { ok: true, draft: { kind: 'replaceFace', faces, target, step: 1 } };
}

export function acceptReplaceFacePick(
  draft: ReplaceFaceDraft,
  pick: Parameters<ReplaceFaceTool['acceptPick']>[1],
  evaluation: EvaluationResult,
): ReplaceFaceDraft {
  if (pick.kind !== 'face') return draft;
  const ref = faceRefOf(evaluation, pick.bodyId, pick.faceKey);
  if (!ref) return draft;
  if (draft.step === 0) {
    if (!isPlanar(ref) || (draft.faces[0] && ref.bodyId !== draft.faces[0].bodyId)) return draft;
    if (draft.target && sameFace(draft.target, ref)) return draft;
    const present = draft.faces.some((f) => sameFace(f, ref));
    if (present && draft.faces.length === 1) return draft;
    return {
      ...draft,
      faces: present ? draft.faces.filter((f) => !sameFace(f, ref)) : [...draft.faces, ref],
    };
  }
  if (!replacingSurface(ref) || draft.faces.some((f) => sameFace(f, ref))) return draft;
  return { ...draft, target: ref };
}

type ReplaceFaceTool = Parameters<typeof defineDraftTool<ReplaceFaceDraft>>[0];

/** The replacing plane as a guide quad around the replaced faces (a cylinder needs none). */
function replaceFaceGuides(draft: ReplaceFaceDraft, evaluation: EvaluationResult): DraftToolGuides {
  const out: DraftToolGuides = { lines: [], planes: [] };
  const target = draft.target;
  if (!target || target.signature.surface !== 'plane' || !target.signature.normal) return out;
  const body = evaluation.bodies.find((b) => b.id === draft.faces[0]?.bodyId);
  const normal = target.signature.normal;
  const point = target.signature.centroid;
  const centre: Vec3 = body
    ? [
        (body.min[0] + body.max[0]) / 2,
        (body.min[1] + body.max[1]) / 2,
        (body.min[2] + body.max[2]) / 2,
      ]
    : point;
  const k =
    (centre[0] - point[0]) * normal[0] +
    (centre[1] - point[1]) * normal[1] +
    (centre[2] - point[2]) * normal[2];
  const onPlane: Vec3 = [
    centre[0] - normal[0] * k,
    centre[1] - normal[1] * k,
    centre[2] - normal[2] * k,
  ];
  const frame = frameForFace(normal, onPlane);
  const half = body
    ? Math.max(
        10,
        Math.hypot(
          body.max[0] - body.min[0],
          body.max[1] - body.min[1],
          body.max[2] - body.min[2],
        ) * 0.6,
      )
    : 20;
  const corner = (a: number, b: number): Vec3 => [
    onPlane[0] + frame.u[0] * a * half + frame.v[0] * b * half,
    onPlane[1] + frame.u[1] * a * half + frame.v[1] * b * half,
    onPlane[2] + frame.u[2] * a * half + frame.v[2] * b * half,
  ];
  out.planes.push([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);
  return out;
}

export const REPLACE_FACE_DRAFT_TOOL = defineDraftTool<ReplaceFaceDraft>({
  module: 'direct-edit',
  kinds: ['replaceFace'],
  createDraft: (_kind, ctx) => createReplaceFaceDraft(ctx),
  acceptPick: (draft, pick, evaluation) => acceptReplaceFacePick(draft, pick, evaluation),
  toFeature: (draft, base) =>
    draft.faces.length === 0 || !draft.target
      ? null
      : {
          id: base.id,
          name: base.name,
          suppressed: false,
          kind: 'replaceFace',
          faces: draft.faces,
          target: draft.target,
        },
  meta: (draft) => ({
    label: 'Replace Face',
    shortcut: '',
    prompt:
      draft.step === 0
        ? `Click the planar faces to replace (${plural(draft.faces.length, 'face')}), then Next.`
        : draft.target
          ? 'The faces extend or trim to the replacing face. Click another face to replace with it.'
          : 'Click the replacing face (planar or cylindrical).',
  }),
  steps: (draft) => ({
    labels: ['Faces to replace', 'Replacing face'],
    current: draft.step,
    go: (d, step) =>
      step === 0 || (step === 1 && d.faces.length > 0) ? { ...d, step: step as 0 | 1 } : d,
  }),
  guides: (draft, evaluation) => replaceFaceGuides(draft, evaluation),
  modifiedBodyIds: (draft) => (draft.faces[0] ? [draft.faces[0].bodyId] : []),
});
