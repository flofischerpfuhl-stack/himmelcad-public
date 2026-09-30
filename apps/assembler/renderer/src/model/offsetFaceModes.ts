/**
 * Offset Face value modes (Shapr3D DIR-01) on the UI side: which modes a
 * face offers, the opposite face `Total` measures to, and the conversion
 * between a mode's value and the offset along the outward normal — the
 * same arithmetic the kernel does on the exact surfaces
 * (`kernel/features/faceOps.ts#modeOffset`), here on the evaluated face
 * (radius from its circular edges, hole or boss from the mesh normals).
 */
import type { Body, EvaluationResult, FaceInfo } from '../kernel/types.js';
import { faceSignatureOf } from '../kernel/naming.js';
import type { FaceRef, Vec3 } from './document.js';
import type { OffsetFaceMode } from './features.js';
import { circleOfEdge } from './measure.js';

/** What the modes need to know about one face. */
export interface OffsetFaceShape {
  /** A cylindrical face: radius and whether it is a boss (`true`) or a hole wall. */
  cylinder: { radius: number; convex: boolean } | null;
  /** A planar face: its outward normal and centroid. */
  plane: { normal: Vec3; point: Vec3 } | null;
}

export const OFFSET_FACE_MODE_LABEL: Record<OffsetFaceMode, string> = {
  offset: 'Offset',
  radius: 'Radius',
  diameter: 'Diameter',
  total: 'Total',
};

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function bodyAndFace(
  evaluation: Pick<EvaluationResult, 'bodies'>,
  ref: FaceRef,
): { body: Body; face: FaceInfo } | null {
  const body = evaluation.bodies.find((b) => b.id === ref.bodyId);
  const face =
    body?.faces.find((f) => f.key === ref.key) ??
    body?.faces.find((f) => f.aliases.includes(ref.key));
  return body && face ? { body, face } : null;
}

/** Radius and hole/boss of a cylindrical face, from a circular edge and a mesh normal. */
function cylinderOf(body: Body, face: FaceInfo): OffsetFaceShape['cylinder'] {
  if (face.surface !== 'cylinder') return null;
  const edge = face.edgeIndices.map((i) => body.edges[i]).find((e) => e?.curve === 'circle');
  const circle = edge ? circleOfEdge(edge) : null;
  if (!circle || face.triangleCount === 0) return null;
  const vertex = body.mesh.indices[face.triangleStart * 3]!;
  const p: Vec3 = [
    body.mesh.positions[vertex * 3]!,
    body.mesh.positions[vertex * 3 + 1]!,
    body.mesh.positions[vertex * 3 + 2]!,
  ];
  const n: Vec3 = [
    body.mesh.normals[vertex * 3]!,
    body.mesh.normals[vertex * 3 + 1]!,
    body.mesh.normals[vertex * 3 + 2]!,
  ];
  const fromCentre = sub(p, circle.center);
  const along = dot(fromCentre, circle.normal);
  const radial: Vec3 = [
    fromCentre[0] - circle.normal[0] * along,
    fromCentre[1] - circle.normal[1] * along,
    fromCentre[2] - circle.normal[2] * along,
  ];
  return { radius: edge?.radius ?? circle.radius, convex: dot(n, radial) > 0 };
}

export function offsetFaceShape(
  evaluation: Pick<EvaluationResult, 'bodies'>,
  ref: FaceRef,
): OffsetFaceShape | null {
  const found = bodyAndFace(evaluation, ref);
  if (!found) return null;
  const { body, face } = found;
  return {
    cylinder: cylinderOf(body, face),
    plane:
      face.surface === 'plane' && face.normal
        ? { normal: face.normal, point: face.centroid }
        : null,
  };
}

/** Signed distance of `face` from the plane of `opposite`, along the face's outward normal. */
export function totalGap(
  evaluation: Pick<EvaluationResult, 'bodies'>,
  face: FaceRef,
  opposite: FaceRef,
): number | null {
  const a = bodyAndFace(evaluation, face)?.face;
  const b = bodyAndFace(evaluation, opposite)?.face;
  if (!a?.normal || !b?.normal || a.surface !== 'plane' || b.surface !== 'plane') return null;
  if (Math.abs(dot(a.normal, b.normal)) < 1 - 1e-6) return null;
  const gap = dot(a.normal, sub(a.centroid, b.centroid));
  return Math.abs(gap) < 1e-6 ? null : gap;
}

/**
 * The face `Total` measures to by default: the nearest parallel planar face
 * of the same body behind `face` (the wall's other side), else the nearest
 * parallel one in front of it.
 */
export function defaultOpposite(
  evaluation: Pick<EvaluationResult, 'bodies'>,
  ref: FaceRef,
): FaceRef | null {
  const found = bodyAndFace(evaluation, ref);
  if (!found?.face.normal || found.face.surface !== 'plane') return null;
  const { body, face } = found;
  let best: { face: FaceInfo; score: number } | null = null;
  for (const other of body.faces) {
    if (other === face || other.surface !== 'plane' || !other.normal) continue;
    if (Math.abs(dot(face.normal!, other.normal)) < 1 - 1e-6) continue;
    const gap = dot(face.normal!, sub(face.centroid, other.centroid));
    if (Math.abs(gap) < 1e-6) continue;
    // Behind the face (material side) first, then the nearest.
    const score = (gap > 0 ? 0 : 1e9) + Math.abs(gap);
    if (!best || score < best.score) best = { face: other, score };
  }
  return best
    ? { bodyId: body.id, key: best.face.key, signature: faceSignatureOf(best.face) }
    : null;
}

/** The modes `faces` offer: Offset always; Radius/Diameter for one cylinder; Total for one plane with a parallel face. */
export function availableOffsetFaceModes(
  evaluation: Pick<EvaluationResult, 'bodies'>,
  faces: readonly FaceRef[],
): OffsetFaceMode[] {
  if (faces.length !== 1) return ['offset'];
  const shape = offsetFaceShape(evaluation, faces[0]!);
  const modes: OffsetFaceMode[] = ['offset'];
  if (shape?.cylinder) modes.push('radius', 'diameter');
  if (shape?.plane && defaultOpposite(evaluation, faces[0]!)) modes.push('total');
  return modes;
}

interface ModeDraft {
  faces: readonly FaceRef[];
  distance: number;
  mode?: OffsetFaceMode | undefined;
  opposite?: FaceRef | undefined;
}

/** The offset along the outward normal a draft's value stands for, or `null` if unknown. */
export function offsetOfModeValue(
  evaluation: Pick<EvaluationResult, 'bodies'>,
  draft: ModeDraft,
): number | null {
  const mode = draft.mode ?? 'offset';
  if (mode === 'offset') return draft.distance;
  const face = draft.faces[0];
  if (!face) return null;
  if (mode === 'total') {
    const gap = draft.opposite ? totalGap(evaluation, face, draft.opposite) : null;
    return gap === null ? null : Math.sign(gap) * draft.distance - gap;
  }
  const cylinder = offsetFaceShape(evaluation, face)?.cylinder;
  if (!cylinder) return null;
  const target = mode === 'radius' ? draft.distance : draft.distance / 2;
  return cylinder.convex ? target - cylinder.radius : cylinder.radius - target;
}

/** The value in `mode` for an offset of `offset` along the outward normal, or `null` if unknown. */
export function modeValueOfOffset(
  evaluation: Pick<EvaluationResult, 'bodies'>,
  draft: Pick<ModeDraft, 'faces' | 'opposite'>,
  mode: OffsetFaceMode,
  offset: number,
): number | null {
  if (mode === 'offset') return offset;
  const face = draft.faces[0];
  if (!face) return null;
  if (mode === 'total') {
    const gap = draft.opposite ? totalGap(evaluation, face, draft.opposite) : null;
    return gap === null ? null : Math.abs(gap + offset);
  }
  const cylinder = offsetFaceShape(evaluation, face)?.cylinder;
  if (!cylinder) return null;
  const radius = cylinder.convex ? cylinder.radius + offset : cylinder.radius - offset;
  return mode === 'radius' ? radius : radius * 2;
}

/**
 * Which way the value grows when the face moves out along its normal: `1`
 * (offset, a boss's radius, a wall's total) or `-1` (a hole's radius, the
 * total across a gap in front of the face).
 */
export function modeGrowthSign(
  evaluation: Pick<EvaluationResult, 'bodies'>,
  draft: ModeDraft,
): 1 | -1 {
  const mode = draft.mode ?? 'offset';
  const face = draft.faces[0];
  if (mode === 'offset' || !face) return 1;
  if (mode === 'total') {
    const gap = draft.opposite ? totalGap(evaluation, face, draft.opposite) : null;
    return gap !== null && gap < 0 ? -1 : 1;
  }
  return offsetFaceShape(evaluation, face)?.cylinder?.convex === false ? -1 : 1;
}
