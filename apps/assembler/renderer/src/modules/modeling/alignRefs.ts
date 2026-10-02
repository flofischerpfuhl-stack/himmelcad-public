/**
 * Align references on the UI side (MOD-22): what a picked face, edge or
 * datum stands for — a plane, an axis (line) or a centre (point) — and
 * which pairs Align can bring together. The kernel resolves the same
 * references exactly (`kernel/bodyOps.ts` `applyAlign`). Pure functions.
 */
import type { EdgeRef, FaceRef } from '../../foundation/document/document.js';
import type { AlignReference } from './features.js';

export type AlignShape = 'plane' | 'line' | 'point';

/** What a reference stands for, or `null` when Align cannot use it. */
export function alignShapeOf(ref: AlignReference): AlignShape | null {
  if (ref.kind === 'plane') return 'plane';
  if (ref.kind === 'axis') {
    if (ref.axis.kind !== 'edge') return 'line';
    const curve = ref.axis.edge.signature.curve;
    return curve === 'line' || curve === 'circle' ? 'line' : null;
  }
  switch (ref.face.signature.surface) {
    case 'plane':
      return ref.face.signature.normal ? 'plane' : null;
    case 'cylinder':
    case 'cone':
      return 'line';
    case 'sphere':
      return 'point';
    default:
      return null;
  }
}

/** A face as an Align reference (`null` for surfaces Align cannot use). */
export function alignFaceRef(face: FaceRef): AlignReference | null {
  const ref: AlignReference = { kind: 'face', face };
  return alignShapeOf(ref) ? ref : null;
}

/** A straight or circular edge as an Align reference (its line / its axis). */
export function alignEdgeRef(edge: EdgeRef): AlignReference | null {
  const ref: AlignReference = { kind: 'axis', axis: { kind: 'edge', edge } };
  return alignShapeOf(ref) ? ref : null;
}

/** `null` when Align can bring `from` onto `to`, else why not. */
export function alignPairProblem(from: AlignReference, to: AlignReference): string | null {
  const a = alignShapeOf(from);
  const b = alignShapeOf(to);
  if (!a || !b) {
    return 'Align takes planar, cylindrical, conical or spherical faces, straight or round edges, planes and axes.';
  }
  if (a === b || (a === 'point' && b === 'line') || (a === 'line' && b === 'point')) return null;
  return 'Align a plane to a plane, an axis to an axis, or a centre to a centre or an axis.';
}

/** The body a reference lies on (`null` for datums and world references). */
export function alignRefBodyId(ref: AlignReference): string | null {
  if (ref.kind === 'face') return ref.face.bodyId;
  if (ref.kind === 'axis' && ref.axis.kind === 'edge') return ref.axis.edge.bodyId;
  if (ref.kind === 'plane' && ref.plane.kind === 'face') return ref.plane.face.bodyId;
  return null;
}

/** Both references are planar faces: stored as `face`/`target` (readable by every build). */
export function bothPlanarFaces(
  from: AlignReference,
  to: AlignReference,
): { face: FaceRef; target: FaceRef } | null {
  if (from.kind !== 'face' || to.kind !== 'face') return null;
  if (alignShapeOf(from) !== 'plane' || alignShapeOf(to) !== 'plane') return null;
  return { face: from.face, target: to.face };
}

/** The `from`/`to` references of a stored Align (old files: `face`/`target`). */
export function alignReferencesOf(feature: {
  face?: FaceRef;
  target?: FaceRef;
  from?: AlignReference;
  to?: AlignReference;
}): { from: AlignReference | null; to: AlignReference | null } {
  return {
    from: feature.from ?? (feature.face ? { kind: 'face', face: feature.face } : null),
    to: feature.to ?? (feature.target ? { kind: 'face', face: feature.target } : null),
  };
}
