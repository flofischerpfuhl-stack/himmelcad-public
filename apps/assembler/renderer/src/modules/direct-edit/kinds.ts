/**
 * The direct-edit feature kinds, Offset Face and Delete Face: their stored
 * types (plain, structured-clone-safe data like the rest of the document),
 * `.hcasm` validation and History labels, registered with the document's
 * feature-kind registry. Loaded by the product composition (`module.ts`)
 * and the kernel-worker composition (`kernel.ts`).
 */
import type { FaceRef, FeatureBase, Millimeters } from '../../foundation/document/document.js';
import { registerFeatureKind, type FormatHelpers } from '../../foundation/document/featureKinds.js';

/**
 * How Offset Face reads its value (Shapr3D DIR-01): `offset` moves the faces
 * by `distance` along their outward normals; with one face `radius` /
 * `diameter` set a cylindrical face's size and `total` its distance to the
 * parallel `opposite` face — re-measured on every evaluation, so the target
 * holds when earlier steps change the face.
 */
export type OffsetFaceMode = 'offset' | 'radius' | 'diameter' | 'total';

export const OFFSET_FACE_MODES: readonly OffsetFaceMode[] = [
  'offset',
  'radius',
  'diameter',
  'total',
];

/**
 * Offsets existing faces of one body along their normals (planar,
 * cylindrical and other smooth faces): positive adds material, negative
 * removes it (e.g. a negative offset on a hole's wall enlarges the hole).
 */
export interface OffsetFaceFeature extends FeatureBase {
  kind: 'offsetFace';
  faces: FaceRef[];
  /** The value in `mode`: offset distance (signed), target radius, diameter or total distance. */
  distance: Millimeters;
  /** Absent: `offset`. */
  mode?: OffsetFaceMode;
  /** `total`: the parallel planar face the distance is measured to. */
  opposite?: FaceRef;
}

/** Removes faces (holes, fillets, chamfers) and heals the body. */
export interface DeleteFaceFeature extends FeatureBase {
  kind: 'deleteFace';
  faces: FaceRef[];
}

export type DirectEditFeature = OffsetFaceFeature | DeleteFaceFeature;

declare module '../../foundation/document/featureKinds.js' {
  interface FeatureKindMap {
    offsetFace: OffsetFaceFeature;
    deleteFace: DeleteFaceFeature;
  }
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function faceList(r: Record<string, unknown>, field: string, path: string, h: FormatHelpers): void {
  const v = r[field];
  if (!Array.isArray(v) || v.length === 0) h.fail(`${path}.${field}`, 'expected a non-empty array');
  v.forEach((f, i) => h.faceRef(f, `${path}.${field}[${i}]`));
}

registerFeatureKind({
  kind: 'offsetFace',
  module: 'direct-edit',
  label: 'Offset Face',
  validate: (r, path, h) => {
    faceList(r, 'faces', path, h);
    if (!isNumber(r.distance)) h.fail(`${path}.distance`, 'expected a number');
    if (r.mode !== undefined && !(OFFSET_FACE_MODES as readonly unknown[]).includes(r.mode)) {
      h.fail(`${path}.mode`, `expected one of ${OFFSET_FACE_MODES.join(', ')}`);
    }
    if (r.opposite !== undefined) h.faceRef(r.opposite, `${path}.opposite`);
  },
});

registerFeatureKind({
  kind: 'deleteFace',
  module: 'direct-edit',
  label: 'Delete Face',
  validate: (r, path, h) => faceList(r, 'faces', path, h),
});
