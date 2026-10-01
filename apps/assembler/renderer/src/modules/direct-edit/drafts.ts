/**
 * The tools of the direct-edit kinds as drafts of the generic feature tool
 * (`foundation/commands/draftTools.ts`, installed by `module.ts`): Offset Face (with its value
 * modes and the Move Face variant started from Move/Rotate on a face) and
 * Delete Face. Pure data + functions; no store access, no DOM.
 */
import {
  baseEdgeKey,
  baseFaceKey,
  edgeSignatureOf,
  faceSignatureOf,
} from '../../foundation/geometry-kernel/naming.js';
import type { Body, EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import { PRINT_CLEARANCES } from '../../foundation/document/blendOptions.js';
import {
  frameForFace,
  type EdgeRef,
  type FaceRef,
  type Feature,
  type Vec3,
} from '../../foundation/document/document.js';
import {
  defineDraftTool,
  type DraftPick as ToolPick,
  type DraftToolBadge,
  type DraftToolContext as DraftContext,
  type DraftToolHandle,
  type DraftToolMeta as DraftMeta,
  type DraftToolStart as DraftStart,
} from '../../foundation/commands/draftTools.js';

type DraftBadge = DraftToolBadge<OffsetFaceDraft>;
type DraftHandle = DraftToolHandle<OffsetFaceDraft>;
import type { OffsetFaceMode } from './kinds.js';
import {
  OFFSET_FACE_MODE_LABEL,
  availableOffsetFaceModes,
  defaultOpposite,
  modeGrowthSign,
  modeValueOfOffset,
  offsetOfModeValue,
  totalGap,
} from './offsetFaceModes.js';

/** `viaMove`: started from Move/Rotate on a face (Shapr3D moves faces with the gizmo). */
export interface OffsetFaceDraft {
  kind: 'offsetFace';
  faces: FaceRef[];
  /** The value in `mode` (`OffsetFaceFeature.distance`). */
  distance: number;
  viaMove?: boolean;
  /** Radius / Diameter / Total (one face); absent: Offset. */
  mode?: OffsetFaceMode;
  opposite?: FaceRef;
}

export interface DeleteFaceDraft {
  kind: 'deleteFace';
  faces: FaceRef[];
}

declare module '../../foundation/commands/draftTools.js' {
  interface DraftToolMap {
    offsetFace: OffsetFaceDraft;
    deleteFace: DeleteFaceDraft;
  }
}

export const DEFAULT_OFFSET_MM = 1;

const STEM_MM = 8;

const roundMm = (value: number) => Math.round(value * 1e6) / 1e6;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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

function selectedFaceRefs(ctx: DraftContext): FaceRef[] {
  return ctx.selection
    .filter((s): s is Extract<typeof s, { kind: 'face' }> => s.kind === 'face')
    .map((f) => faceRefOf(ctx.evaluation, f.bodyId, f.faceKey))
    .filter((f): f is FaceRef => f !== null);
}

function toggle<T>(list: readonly T[], item: T, same: (a: T, b: T) => boolean): T[] {
  const present = list.some((x) => same(x, item));
  if (!present) return [...list, item];
  if (list.length === 1) return [...list];
  return list.filter((x) => !same(x, item));
}

/** Faces of one body from the selection (the start of both tools). */
function startFaces(ctx: DraftContext): DraftStart<FaceRef[]> {
  const faces = selectedFaceRefs(ctx);
  if (faces.length === 0 || faces.length !== ctx.selection.length) {
    return { ok: false, reason: 'Select one or more faces of one body.' };
  }
  if (faces.some((f) => f.bodyId !== faces[0]!.bodyId)) {
    return { ok: false, reason: 'All faces must belong to one body.' };
  }
  return { ok: true, draft: faces };
}

// ---- Offset Face -----------------------------------------------------------------------

/**
 * Offset Face in another value mode (DIR-01), keeping the geometry: the
 * value is converted (offset 1 on a Ø10 boss → radius 6), Total measures to
 * the nearest parallel face unless one was picked. Unchanged when the face
 * does not support `mode`.
 */
export function setOffsetFaceMode(
  draft: OffsetFaceDraft,
  mode: OffsetFaceMode,
  evaluation: EvaluationResult,
): OffsetFaceDraft {
  if (mode === (draft.mode ?? 'offset')) return draft;
  const offset = offsetOfModeValue(evaluation, draft) ?? 0;
  const opposite =
    mode === 'total' && draft.faces[0]
      ? (draft.opposite ?? defaultOpposite(evaluation, draft.faces[0]) ?? undefined)
      : undefined;
  const value = modeValueOfOffset(evaluation, { faces: draft.faces, opposite }, mode, offset);
  if (value === null || (mode !== 'offset' && !(value > 0))) return draft;
  return {
    kind: 'offsetFace',
    faces: draft.faces,
    ...(draft.viaMove ? { viaMove: true } : {}),
    distance: roundMm(value),
    ...(mode !== 'offset' ? { mode } : {}),
    ...(opposite ? { opposite } : {}),
  };
}

function acceptOffsetFacePick(
  draft: OffsetFaceDraft,
  pick: ToolPick,
  evaluation: EvaluationResult,
): OffsetFaceDraft {
  const faceRef = pick.kind === 'face' ? faceRefOf(evaluation, pick.bodyId, pick.faceKey) : null;
  if (!faceRef) return draft;
  const face = draft.faces[0];
  // Total: a parallel planar face (not the moved one) becomes the opposite face.
  if (
    draft.mode === 'total' &&
    face &&
    faceRef.key !== face.key &&
    totalGap(evaluation, face, faceRef) !== null
  ) {
    const offset = offsetOfModeValue(evaluation, draft);
    const next = { ...draft, opposite: faceRef };
    const value = offset === null ? null : modeValueOfOffset(evaluation, next, 'total', offset);
    return value !== null && value > 0 ? { ...next, distance: roundMm(value) } : next;
  }
  if (faceRef.bodyId !== face?.bodyId) return draft;
  const faces = toggle(draft.faces, faceRef, (a, b) => a.key === b.key);
  if ((draft.mode ?? 'offset') === 'offset' || faces.length === 1) return { ...draft, faces };
  // Radius/Diameter/Total are single-face modes: more faces continue as Offset.
  const offset = offsetOfModeValue(evaluation, draft) ?? 0;
  return {
    kind: 'offsetFace',
    faces,
    distance: roundMm(offset),
    ...(draft.viaMove ? { viaMove: true } : {}),
  };
}

function offsetFaceToFeature(
  draft: OffsetFaceDraft,
  base: { id: string; name: string },
): Feature | null {
  const mode = draft.mode ?? 'offset';
  if (draft.faces.length === 0) return null;
  if (mode === 'offset' ? draft.distance === 0 : !(draft.distance > 0)) return null;
  if (mode === 'total' && !draft.opposite) return null;
  return {
    id: base.id,
    name: base.name,
    suppressed: false,
    kind: 'offsetFace',
    faces: draft.faces,
    distance: draft.distance,
    ...(mode !== 'offset' ? { mode } : {}),
    ...(mode === 'total' && draft.opposite ? { opposite: draft.opposite } : {}),
  };
}

function offsetFaceMeta(draft: OffsetFaceDraft): DraftMeta {
  return draft.viaMove
    ? {
        label: 'Move Face',
        shortcut: 'M',
        prompt: `Drag the arrow: a face moves along its normal (neighbours follow as with Offset Face). ${plural(draft.faces.length, 'face')}.`,
      }
    : {
        label: 'Offset Face',
        shortcut: '',
        prompt:
          draft.mode === 'radius' || draft.mode === 'diameter'
            ? `Drag the arrow or type the ${draft.mode} of the face; it is kept when earlier steps change.`
            : draft.mode === 'total'
              ? 'Drag the arrow or type the distance to the opposite face; click a parallel face to measure to it instead.'
              : `Drag the arrow or type a distance (negative removes material). ${plural(draft.faces.length, 'face')}.`,
      };
}

function offsetFaceBadges(draft: OffsetFaceDraft, evaluation?: EvaluationResult): DraftBadge[] {
  // Move Face (Move/Rotate on a face) is a plain drag; no modes or clearance presets there.
  if (draft.viaMove) return [];
  const mode = draft.mode ?? 'offset';
  const modes = evaluation ? availableOffsetFaceModes(evaluation, draft.faces) : [mode];
  if (!modes.includes(mode)) modes.push(mode);
  const out: DraftBadge[] = [];
  if (modes.length > 1) {
    out.push({
      ariaLabel: 'Offset mode',
      value: mode,
      options: modes.map((m) => ({ value: m, label: OFFSET_FACE_MODE_LABEL[m] })),
      apply: (d, value, evaluation) => setOffsetFaceMode(d, value as OffsetFaceMode, evaluation),
    });
  }
  // Printing clearances: remove 0.1-0.4 mm from mating faces (a hole wall grows, a peg shrinks).
  if (mode === 'offset') {
    out.push({
      ariaLabel: 'Clearance',
      value: PRINT_CLEARANCES.find((c) => Math.abs(draft.distance + c) < 1e-9)?.toString() ?? '',
      options: PRINT_CLEARANCES.map((c) => ({ value: String(c), label: `−${c}` })),
      apply: (d, value) => ({ ...d, distance: -Number(value) }),
    });
  }
  return out;
}

/** A point on a face's surface with its outward normal (first mesh triangle), for handles on curved faces. */
function faceAnchor(
  evaluation: EvaluationResult,
  ref: FaceRef,
): { point: Vec3; normal: Vec3 } | null {
  const body = evaluation.bodies.find((b) => b.id === ref.bodyId);
  const face = body ? faceOf(body, ref.key) : undefined;
  if (!body || !face) return null;
  if (face.normal) return { point: face.centroid, normal: face.normal };
  if (face.triangleCount === 0) return null;
  const t = face.triangleStart + Math.floor(face.triangleCount / 2);
  const corners = [0, 1, 2].map((k) => {
    const v = body.mesh.indices[t * 3 + k]! * 3;
    return {
      p: [
        body.mesh.positions[v]!,
        body.mesh.positions[v + 1]!,
        body.mesh.positions[v + 2]!,
      ] as Vec3,
      n: [body.mesh.normals[v]!, body.mesh.normals[v + 1]!, body.mesh.normals[v + 2]!] as Vec3,
    };
  });
  const point = scale(add(add(corners[0]!.p, corners[1]!.p), corners[2]!.p), 1 / 3);
  const normal = normalize(add(add(corners[0]!.n, corners[1]!.n), corners[2]!.n));
  return { point, normal };
}

function offsetFaceHandles(draft: OffsetFaceDraft, evaluation: EvaluationResult): DraftHandle[] {
  const first = draft.faces[0];
  const anchor = first ? faceAnchor(evaluation, first) : null;
  if (!anchor) return [];
  const mode = draft.mode ?? 'offset';
  // The arrow points the way the value grows (a hole's radius grows into the material)
  // and reaches past the moved face.
  const sign = modeGrowthSign(evaluation, draft);
  const offset = offsetOfModeValue(evaluation, draft) ?? 0;
  return [
    {
      kind: 'linear',
      id: 'distance',
      label: mode === 'offset' ? 'Offset distance' : OFFSET_FACE_MODE_LABEL[mode],
      ...(mode === 'diameter' ? { prefix: 'Ø' } : mode === 'radius' ? { prefix: 'R' } : {}),
      unit: 'mm',
      value: draft.distance,
      base: anchor.point,
      dir: sign === 1 ? anchor.normal : scale(anchor.normal, -1),
      length: STEM_MM + Math.max(0, sign * offset),
      apply: (d, value) =>
        d.kind !== 'offsetFace'
          ? d
          : {
              ...d,
              // Target sizes stay positive; Offset may cross zero (add ↔ remove).
              distance: (d.mode ?? 'offset') === 'offset' ? value : Math.max(0.01, value),
            },
    },
  ];
}

export const OFFSET_FACE_DRAFT_TOOL = defineDraftTool<OffsetFaceDraft>({
  module: 'direct-edit',
  kinds: ['offsetFace'],
  createDraft: (_kind, ctx) => {
    const faces = startFaces(ctx);
    return faces.ok
      ? {
          ok: true,
          draft: { kind: 'offsetFace', faces: faces.draft, distance: -DEFAULT_OFFSET_MM },
        }
      : faces;
  },
  acceptPick: (draft, pick, evaluation) => acceptOffsetFacePick(draft, pick, evaluation),
  toFeature: offsetFaceToFeature,
  meta: offsetFaceMeta,
  badges: offsetFaceBadges,
  handles: (draft, evaluation) => offsetFaceHandles(draft, evaluation),
  modifiedBodyIds: (draft) => (draft.faces[0] ? [draft.faces[0].bodyId] : []),
});

// ---- Delete Face -----------------------------------------------------------------------

export const DELETE_FACE_DRAFT_TOOL = defineDraftTool<DeleteFaceDraft>({
  module: 'direct-edit',
  kinds: ['deleteFace'],
  createDraft: (_kind, ctx) => {
    const faces = startFaces(ctx);
    return faces.ok ? { ok: true, draft: { kind: 'deleteFace', faces: faces.draft } } : faces;
  },
  acceptPick: (draft, pick, evaluation) => {
    const faceRef = pick.kind === 'face' ? faceRefOf(evaluation, pick.bodyId, pick.faceKey) : null;
    if (faceRef && faceRef.bodyId === draft.faces[0]?.bodyId) {
      return { ...draft, faces: toggle(draft.faces, faceRef, (a, b) => a.key === b.key) };
    }
    return draft;
  },
  toFeature: (draft, base) =>
    draft.faces.length === 0
      ? null
      : { id: base.id, name: base.name, suppressed: false, kind: 'deleteFace', faces: draft.faces },
  meta: (draft) => ({
    label: 'Delete Face',
    shortcut: '',
    prompt: `Removes ${plural(draft.faces.length, 'face')} and heals the body. Click faces to add or remove.`,
  }),
  modifiedBodyIds: (draft) => (draft.faces[0] ? [draft.faces[0].bodyId] : []),
});

// ---- Move Edge / Move Face (Move/Rotate on an edge or a planar face) ----------------------

/** A straight edge moved by `vector` (its two planar faces tilt; `moveEdits.ts`). */
export interface MoveEdgeDraft {
  kind: 'moveEdge';
  edge: EdgeRef;
  vector: Vec3;
}

/** A planar face moved by `vector` in any direction (`moveEdits.ts`). */
export interface MoveFaceDraft {
  kind: 'moveFace';
  face: FaceRef;
  vector: Vec3;
}

declare module '../../foundation/commands/draftTools.js' {
  interface DraftToolMap {
    moveEdge: MoveEdgeDraft;
    moveFace: MoveFaceDraft;
  }
}

const WORLD: [Vec3, Vec3, Vec3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function edgeOf(evaluation: EvaluationResult, bodyId: string, key: string) {
  const body = evaluation.bodies.find((b) => b.id === bodyId);
  return (
    body?.edges.find((e) => e.key === key) ??
    body?.edges.find((e) => baseEdgeKey(e.key) === baseEdgeKey(key))
  );
}

function edgeRefOf(evaluation: EvaluationResult, bodyId: string, key: string): EdgeRef | null {
  const edge = edgeOf(evaluation, bodyId, key);
  return edge ? { bodyId, key: edge.key, signature: edgeSignatureOf(edge) } : null;
}

/** `vector` with its component along the unit `axis` set to `value`. */
function withComponent(vector: Vec3, axis: Vec3, value: number): Vec3 {
  const k = value - dot(vector, axis);
  return [
    roundMm(vector[0] + axis[0] * k),
    roundMm(vector[1] + axis[1] * k),
    roundMm(vector[2] + axis[2] * k),
  ];
}

function moveHandles<D extends MoveEdgeDraft | MoveFaceDraft>(
  draft: D,
  base: Vec3,
  axes: { dir: Vec3; label: string; prefix: string }[],
): DraftToolHandle<D>[] {
  // The arrows ride on the moved edge/face, like the Move/Rotate gizmo.
  const moved = add(base, draft.vector);
  return axes.map((axis, i) => {
    const value = roundMm(dot(draft.vector, axis.dir));
    return {
      kind: 'linear',
      id: `move${i}`,
      label: axis.label,
      prefix: axis.prefix,
      unit: 'mm',
      value,
      base: moved,
      dir: axis.dir,
      length: STEM_MM * 1.5,
      apply: (d, v) => ({ ...d, vector: withComponent(d.vector, axis.dir, v) }),
    };
  });
}

export const MOVE_EDGE_DRAFT_TOOL = defineDraftTool<MoveEdgeDraft>({
  module: 'direct-edit',
  kinds: ['moveEdge'],
  createDraft: (_kind, ctx) => {
    const edges = ctx.selection.filter(
      (s): s is Extract<typeof s, { kind: 'edge' }> => s.kind === 'edge',
    );
    if (edges.length !== 1 || ctx.selection.length !== 1) {
      return { ok: false, reason: 'Select one straight edge to move.' };
    }
    const ref = edgeRefOf(ctx.evaluation, edges[0]!.bodyId, edges[0]!.edgeKey);
    if (!ref) return { ok: false, reason: 'The edge is not evaluated yet.' };
    if (ref.signature.curve !== 'line') {
      return {
        ok: false,
        reason: 'Only straight edges between two planar faces can be moved; move a face instead.',
      };
    }
    return { ok: true, draft: { kind: 'moveEdge', edge: ref, vector: [0, 0, 0] } };
  },
  // A click on another straight edge of the body moves that edge instead.
  acceptPick: (draft, pick, evaluation) => {
    if (pick.kind !== 'edge' || pick.bodyId !== draft.edge.bodyId) return draft;
    const ref = edgeRefOf(evaluation, pick.bodyId, pick.edgeKey);
    return ref && ref.signature.curve === 'line' ? { ...draft, edge: ref } : draft;
  },
  toFeature: (draft, base) =>
    draft.vector.every((c) => c === 0)
      ? null
      : {
          id: base.id,
          name: base.name,
          suppressed: false,
          kind: 'moveEdge',
          edge: draft.edge,
          vector: draft.vector,
        },
  meta: () => ({
    label: 'Move Edge',
    shortcut: 'M',
    prompt:
      'Drag an arrow or type a value: the two faces at the edge tilt about their far sides to follow it.',
  }),
  handles: (draft, evaluation) => {
    const edge = edgeOf(evaluation, draft.edge.bodyId, draft.edge.key);
    const mid = edge?.midpoint ?? draft.edge.signature.midpoint;
    const dir = edge?.direction ?? draft.edge.signature.direction ?? [1, 0, 0];
    // The two world axes most across the edge (moving along the edge changes nothing).
    const across = [0, 1, 2]
      .sort((a, b) => Math.abs(dot(WORLD[a]!, dir)) - Math.abs(dot(WORLD[b]!, dir)))
      .slice(0, 2)
      .sort((a, b) => a - b);
    return moveHandles(
      draft,
      mid,
      across.map((i) => ({ dir: WORLD[i]!, label: `${'XYZ'[i]} offset`, prefix: 'XYZ'[i]! })),
    );
  },
  modifiedBodyIds: (draft) => [draft.edge.bodyId],
  ghostsModifiedBodies: () => true,
});

export const MOVE_FACE_DRAFT_TOOL = defineDraftTool<MoveFaceDraft>({
  module: 'direct-edit',
  kinds: ['moveFace'],
  createDraft: (_kind, ctx) => {
    const faces = selectedFaceRefs(ctx);
    if (faces.length !== 1 || ctx.selection.length !== 1) {
      return { ok: false, reason: 'Select one planar face to move.' };
    }
    const face = faces[0]!;
    if (face.signature.surface !== 'plane' || !face.signature.normal) {
      return { ok: false, reason: 'Only planar faces move in any direction; use Offset Face.' };
    }
    return { ok: true, draft: { kind: 'moveFace', face, vector: [0, 0, 0] } };
  },
  acceptPick: (draft, pick, evaluation) => {
    if (pick.kind !== 'face' || pick.bodyId !== draft.face.bodyId) return draft;
    const ref = faceRefOf(evaluation, pick.bodyId, pick.faceKey);
    return ref && ref.signature.surface === 'plane' ? { ...draft, face: ref } : draft;
  },
  toFeature: (draft, base) =>
    draft.vector.every((c) => c === 0)
      ? null
      : {
          id: base.id,
          name: base.name,
          suppressed: false,
          kind: 'moveFace',
          face: draft.face,
          vector: draft.vector,
        },
  meta: () => ({
    label: 'Move Face',
    shortcut: 'M',
    prompt:
      'Drag an arrow or type a value: along the normal the face offsets, sideways its neighbours tilt to follow.',
  }),
  handles: (draft, evaluation) => {
    const anchor = faceAnchor(evaluation, draft.face);
    if (!anchor) return [];
    const frame = frameForFace(anchor.normal, anchor.point);
    return moveHandles(draft, anchor.point, [
      { dir: anchor.normal, label: 'Normal offset', prefix: 'N' },
      { dir: frame.u, label: 'Slide 1', prefix: '↔' },
      { dir: frame.v, label: 'Slide 2', prefix: '↕' },
    ]);
  },
  modifiedBodyIds: (draft) => [draft.face.bodyId],
  ghostsModifiedBodies: () => true,
});

// ---- vector helpers ----------------------------------------------------------------------

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
