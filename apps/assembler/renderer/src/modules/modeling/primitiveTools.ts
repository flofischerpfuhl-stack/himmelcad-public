/**
 * The "Add" tools (UI-02): Box, Cylinder, Sphere, Cone and Torus as one
 * draft of the generic feature tool (`foundation/commands/draftTools.ts`,
 * registered in `drafts.ts`). A primitive stands on a plane — the selected
 * planar face or construction plane, else the XY grid at the origin; a
 * click on a planar face places it there (on the clicked point, snapped to
 * vertices, midpoints and centres), a click on a construction plane puts
 * it on that plane. Drag arrows or type sizes; New/Join/Cut/Intersect like
 * Extrude: placed on a body's face it joins the body, and Cut turns it into
 * the face (a pocket or a hole) until the side is chosen explicitly.
 *
 * Pure data + functions; no store access, no DOM.
 */
import {
  frameForFace,
  frameForPlane,
  type ExtrudeOperation,
  type FaceRef,
  type Feature,
  type PlaneRef,
  type SketchFrame,
  type Vec3,
} from '../../foundation/document/document.js';
import {
  defineDraftTool,
  type DraftPick,
  type DraftToolBadge,
  type DraftToolContext,
  type DraftToolHandle,
  type DraftToolStart,
} from '../../foundation/commands/draftTools.js';
import { datumRef, planeRefPlane } from '../../foundation/geometry-kernel/datums.js';
import { baseFaceKey, faceSignatureOf } from '../../foundation/geometry-kernel/naming.js';
import type { EvaluationResult, FaceInfo } from '../../foundation/geometry-kernel/types.js';
import {
  PRIMITIVE_LABEL,
  PRIMITIVE_SHAPES,
  PRIMITIVE_SIZE_FIELDS,
  type PrimitiveShape,
} from './features.js';
import { snapPickPoint } from './pointSnap.js';

export type PrimitiveSizeField = 'width' | 'depth' | 'height' | 'radius' | 'radius2';

export interface PrimitiveDraft {
  kind: 'primitive';
  shape: PrimitiveShape;
  plane: PlaneRef;
  center: Vec3;
  sizes: Record<PrimitiveSizeField, number>;
  operation: ExtrudeOperation;
  targetBodyId?: string;
  /** Grows to the other side of the plane (into the face). */
  flip?: boolean;
  /** `true` once the user picked the operation (no automatic Join on a face). */
  operationLocked?: boolean;
  /** `true` once the user picked the side (no automatic side for Cut). */
  sideLocked?: boolean;
}

declare module '../../foundation/commands/draftTools.js' {
  interface DraftToolMap {
    primitive: PrimitiveDraft;
  }
}

/** Starting sizes on the grid, mm (a 20 mm cube, Ø20 × 20 cylinder, …). */
export const DEFAULT_PRIMITIVE_SIZES: Record<PrimitiveSizeField, number> = {
  width: 20,
  depth: 20,
  height: 20,
  radius: 10,
  radius2: 0,
};

const SIZE_LABEL: Record<PrimitiveShape, Partial<Record<PrimitiveSizeField, string>>> = {
  box: { width: 'Width', depth: 'Depth', height: 'Height' },
  cylinder: { radius: 'Radius', height: 'Height' },
  sphere: { radius: 'Radius' },
  cone: { radius: 'Base radius', radius2: 'Top radius', height: 'Height' },
  torus: { radius: 'Ring radius', radius2: 'Tube radius' },
};

/** Length of the size arrows outside the primitive, mm. */
const STEM_MM = 8;

const round = (v: number) => Math.round(v * 1000) / 1000;

function faceOf(evaluation: EvaluationResult, bodyId: string, key: string): FaceInfo | undefined {
  const body = evaluation.bodies.find((b) => b.id === bodyId);
  return (
    body?.faces.find((f) => f.key === key) ??
    body?.faces.find((f) => baseFaceKey(f.key) === baseFaceKey(key))
  );
}

function faceRefOf(evaluation: EvaluationResult, bodyId: string, key: string): FaceRef | null {
  const face = faceOf(evaluation, bodyId, key);
  return face ? { bodyId, key: face.key, signature: faceSignatureOf(face) } : null;
}

/** The frame a primitive stands on (u, v, normal at a point of the plane). */
export function primitiveFrame(evaluation: EvaluationResult, plane: PlaneRef): SketchFrame | null {
  if (plane.kind === 'plane') return frameForPlane(plane.plane, plane.offset);
  if (plane.kind === 'construction') {
    const p = planeRefPlane(plane, evaluation);
    return p ? frameForFace(p.normal, p.point) : null;
  }
  const face = faceOf(evaluation, plane.face.bodyId, plane.face.key);
  const normal = face?.normal ?? plane.face.signature.normal;
  if (!normal) return null;
  return frameForFace(normal, face?.centroid ?? plane.face.signature.centroid);
}

/** Sizes of `shape` scaled to a typical size `s` (half the smaller side of a face). */
function sizesFor(shape: PrimitiveShape, s: number): Record<PrimitiveSizeField, number> {
  const k = Math.max(0.5, Math.round(s * 2) / 2);
  const sizes: Record<PrimitiveSizeField, number> = {
    width: k * 2,
    depth: k * 2,
    height: k * 2,
    radius: k,
    radius2: 0,
  };
  if (shape === 'cone') sizes.radius2 = 0;
  if (shape === 'torus') {
    sizes.radius = k * 1.5;
    sizes.radius2 = Math.max(0.5, Math.round(k * 0.8) / 2);
  }
  return sizes;
}

/** A quarter of the face's smaller extent in its own plane (the starting size on a face). */
function faceScale(evaluation: EvaluationResult, face: FaceRef): number {
  const body = evaluation.bodies.find((b) => b.id === face.bodyId);
  const info = faceOf(evaluation, face.bodyId, face.key);
  if (!body || !info?.normal) return 10;
  const frame = frameForFace(info.normal, info.centroid);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const e of info.edgeIndices) {
    const s = body.edges[e]?.segments;
    if (!s) continue;
    for (let i = 0; i + 2 < s.length; i += 3) {
      const rel: Vec3 = [
        s[i]! - info.centroid[0],
        s[i + 1]! - info.centroid[1],
        s[i + 2]! - info.centroid[2],
      ];
      const u = dot(rel, frame.u);
      const v = dot(rel, frame.v);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }
  const extent = Math.min(maxU - minU, maxV - minV);
  return Number.isFinite(extent) && extent > 0 ? extent / 4 : 10;
}

/** Starts the primitive `shape` on the selected planar face / construction plane, else on XY. */
export function createPrimitiveDraft(
  shape: PrimitiveShape,
  ctx: DraftToolContext,
): DraftToolStart<PrimitiveDraft> {
  const base = {
    kind: 'primitive' as const,
    shape,
    sizes: sizesFor(shape, DEFAULT_PRIMITIVE_SIZES.radius),
    operation: 'new' as ExtrudeOperation,
  };
  for (const item of ctx.selection) {
    if (item.kind === 'face') {
      const face = faceRefOf(ctx.evaluation, item.bodyId, item.faceKey);
      if (face?.signature.surface === 'plane' && face.signature.normal) {
        return {
          ok: true,
          draft: {
            ...base,
            sizes: sizesFor(shape, faceScale(ctx.evaluation, face)),
            plane: { kind: 'face', face },
            center: face.signature.centroid.map(round) as Vec3,
            operation: 'join',
            targetBodyId: face.bodyId,
          },
        };
      }
    }
    if (item.kind === 'datum') {
      const ref = datumRef(ctx.evaluation, item.featureId);
      if (ref && 'frame' in ref) {
        const p = planeRefPlane(ref, ctx.evaluation);
        return {
          ok: true,
          draft: { ...base, plane: ref, center: (p?.point ?? [0, 0, 0]).map(round) as Vec3 },
        };
      }
    }
  }
  return {
    ok: true,
    draft: { ...base, plane: { kind: 'plane', plane: 'XY', offset: 0 }, center: [0, 0, 0] },
  };
}

/** The automatic side: Cut on a face goes into it (a pocket/hole); otherwise outwards. */
function autoSide(draft: PrimitiveDraft): PrimitiveDraft {
  if (draft.sideLocked) return draft;
  const into = draft.operation === 'cut' && draft.plane.kind === 'face';
  const next = { ...draft };
  if (into) next.flip = true;
  else delete next.flip;
  return next;
}

function acceptPrimitivePick(
  draft: PrimitiveDraft,
  pick: DraftPick,
  evaluation: EvaluationResult,
): PrimitiveDraft {
  if (pick.kind === 'datum') {
    const ref = datumRef(evaluation, pick.featureId);
    if (!ref || !('frame' in ref)) return draft;
    const p = planeRefPlane(ref, evaluation);
    const next: PrimitiveDraft = {
      ...draft,
      plane: ref,
      center: (p?.point ?? draft.center).map(round) as Vec3,
    };
    if (!draft.operationLocked) {
      next.operation = 'new';
      delete next.targetBodyId;
    }
    return autoSide(next);
  }
  if (pick.kind !== 'face') return draft;
  const face = faceRefOf(evaluation, pick.bodyId, pick.faceKey);
  if (!face || face.signature.surface !== 'plane' || !face.signature.normal) return draft;
  const snapped = snapPickPoint(evaluation, pick);
  const next: PrimitiveDraft = {
    ...draft,
    plane: { kind: 'face', face },
    center: (snapped?.point ?? face.signature.centroid).map(round) as Vec3,
  };
  if (!draft.operationLocked) {
    next.operation = 'join';
    next.targetBodyId = face.bodyId;
  } else if (next.operation !== 'new') {
    next.targetBodyId = face.bodyId;
  }
  return autoSide(next);
}

function primitiveToFeature(draft: PrimitiveDraft, base: { id: string; name: string }): Feature {
  const sizes: Partial<Record<PrimitiveSizeField, number>> = {};
  for (const field of PRIMITIVE_SIZE_FIELDS[draft.shape]) sizes[field] = draft.sizes[field];
  return {
    id: base.id,
    name: base.name,
    suppressed: false,
    kind: 'primitive',
    shape: draft.shape,
    plane: draft.plane,
    center: draft.center,
    ...sizes,
    ...(draft.flip ? { flip: true } : {}),
    operation: draft.operation,
    ...(draft.operation !== 'new' && draft.targetBodyId
      ? { targetBodyId: draft.targetBodyId }
      : {}),
  };
}

/**
 * Size arrows on the primitive's outside (from a face or the rim, pointing
 * away), so they stay visible; dragging one changes that size.
 */
function primitiveHandles(
  draft: PrimitiveDraft,
  evaluation: EvaluationResult,
): DraftToolHandle<PrimitiveDraft>[] {
  const frame = primitiveFrame(evaluation, draft.plane);
  if (!frame) return [];
  const { u, v } = frame;
  const n = draft.flip ? scale(frame.normal, -1) : frame.normal;
  // The base centre on the plane (like the kernel: the point dropped onto the plane).
  const c0 = sub(
    draft.center,
    scale(frame.normal, dot(sub(draft.center, frame.origin), frame.normal)),
  );
  const s = draft.sizes;
  const at = (p: Vec3, d: Vec3, k: number): Vec3 => add(p, scale(d, k));
  const set =
    (field: PrimitiveSizeField) =>
    (d: PrimitiveDraft, value: number): PrimitiveDraft => {
      if (d.kind !== 'primitive') return d;
      const min = field === 'radius2' && d.shape === 'cone' ? 0 : 0.1;
      return { ...d, sizes: { ...d.sizes, [field]: Math.max(min, round(value)) } };
    };
  const arrow = (
    field: PrimitiveSizeField,
    base: Vec3,
    dir: Vec3,
    prefix?: string,
  ): DraftToolHandle<PrimitiveDraft> => ({
    kind: 'linear',
    id: field,
    label: SIZE_LABEL[draft.shape][field] ?? field,
    ...(prefix ? { prefix } : {}),
    unit: 'mm',
    value: round(s[field]),
    base,
    dir,
    length: STEM_MM,
    apply: set(field),
  });
  const chip = (
    field: PrimitiveSizeField,
    where: Vec3,
    prefix: string,
  ): DraftToolHandle<PrimitiveDraft> => ({
    kind: 'chip',
    id: field,
    label: SIZE_LABEL[draft.shape][field] ?? field,
    prefix,
    unit: 'mm',
    value: round(s[field]),
    at: where,
    apply: set(field),
  });
  switch (draft.shape) {
    case 'box': {
      const mid = at(c0, n, s.height / 2);
      return [
        arrow('height', at(c0, n, s.height), n, 'H'),
        arrow('width', at(mid, u, s.width / 2), u, 'W'),
        arrow('depth', at(mid, v, s.depth / 2), v, 'D'),
      ];
    }
    case 'cylinder':
      return [
        arrow('height', at(c0, n, s.height), n, 'H'),
        arrow('radius', at(at(c0, n, s.height / 2), u, s.radius), u, 'R'),
      ];
    case 'sphere':
      return [arrow('radius', at(at(c0, n, s.radius), u, s.radius), u, 'R')];
    case 'cone':
      return [
        arrow('height', at(c0, n, s.height), n, 'H'),
        arrow('radius', at(c0, u, s.radius), u, 'R'),
        chip('radius2', at(at(c0, n, s.height), u, Math.max(s.radius2, 2) + 4), 'R'),
      ];
    case 'torus':
      return [
        arrow('radius', at(at(c0, n, s.radius2), u, s.radius + s.radius2), u, 'R'),
        chip('radius2', at(at(c0, n, s.radius2 * 2 + 3), v, s.radius), 'r'),
      ];
  }
}

const OPERATION_OPTIONS: { value: ExtrudeOperation; label: string }[] = [
  { value: 'new', label: 'New body' },
  { value: 'join', label: 'Join' },
  { value: 'cut', label: 'Cut' },
  { value: 'intersect', label: 'Intersect' },
];

function primitiveBadges(draft: PrimitiveDraft): DraftToolBadge<PrimitiveDraft>[] {
  const onFace = draft.plane.kind === 'face';
  return [
    {
      ariaLabel: 'Shape',
      value: draft.shape,
      options: PRIMITIVE_SHAPES.map((shape) => ({ value: shape, label: PRIMITIVE_LABEL[shape] })),
      apply: (d, value) => {
        const shape = value as PrimitiveShape;
        if (d.shape === shape) return d;
        // Keep the overall size: the new shape takes the old one's radius as its scale.
        return { ...d, shape, sizes: sizesFor(shape, d.sizes.radius) };
      },
    },
    {
      ariaLabel: 'Operation',
      value: draft.operation,
      options: OPERATION_OPTIONS,
      apply: (d, value, evaluation) => {
        const operation = value as ExtrudeOperation;
        const next: PrimitiveDraft = { ...d, operation, operationLocked: true };
        if (operation === 'new') delete next.targetBodyId;
        else if (!next.targetBodyId) {
          const target =
            d.plane.kind === 'face' ? d.plane.face.bodyId : evaluation.bodies.at(-1)?.id;
          if (target) next.targetBodyId = target;
        }
        return autoSide(next);
      },
    },
    {
      ariaLabel: 'Side',
      value: draft.flip ? 'in' : 'out',
      options: [
        { value: 'out', label: onFace ? 'Outward' : 'Above' },
        { value: 'in', label: onFace ? 'Into face' : 'Below' },
      ],
      apply: (d, value) => {
        const next: PrimitiveDraft = { ...d, sideLocked: true };
        if (value === 'in') next.flip = true;
        else delete next.flip;
        return next;
      },
    },
  ];
}

export const PRIMITIVE_DRAFT_TOOL = defineDraftTool<PrimitiveDraft>({
  module: 'modeling',
  kinds: ['primitive'],
  createDraft: (_kind, ctx) => createPrimitiveDraft('box', ctx),
  acceptPick: (draft, pick, evaluation) => acceptPrimitivePick(draft, pick, evaluation),
  toFeature: primitiveToFeature,
  meta: (draft) => ({
    label: PRIMITIVE_LABEL[draft.shape],
    shortcut: '',
    prompt:
      draft.plane.kind === 'face'
        ? 'On the face: drag the arrows or type sizes; click another face or a construction plane to move it.'
        : 'Click a planar face or a construction plane to place it there; drag the arrows or type sizes.',
  }),
  badges: (draft) => primitiveBadges(draft),
  handles: (draft, evaluation) => primitiveHandles(draft, evaluation),
  modifiedBodyIds: (draft) =>
    draft.operation !== 'new' && draft.targetBodyId ? [draft.targetBodyId] : [],
  namePrefix: (draft) => PRIMITIVE_LABEL[draft.shape],
});

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
