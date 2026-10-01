/**
 * The direct-edit feature kinds, Offset Face and Delete Face: their stored
 * types (plain, structured-clone-safe data like the rest of the document),
 * `.hcasm` validation and History labels, registered with the document's
 * feature-kind registry. Loaded by the product composition (`module.ts`)
 * and the kernel-worker composition (`kernel.ts`).
 */
import type {
  EdgeRef,
  FaceRef,
  FeatureBase,
  Millimeters,
  Vec3,
} from '../../foundation/document/document.js';
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

/**
 * Moves a straight edge between two planar faces by `vector` (Shapr3D Move
 * on an edge): each of the two faces tilts about its far side (the
 * boundary farthest from the edge, parallel to it) so that it passes
 * through the moved edge; the neighbours are trimmed or extended to meet
 * them. The part of `vector` along the edge changes nothing.
 */
export interface MoveEdgeFeature extends FeatureBase {
  kind: 'moveEdge';
  edge: EdgeRef;
  vector: Vec3;
}

/**
 * Moves a planar face by `vector` in any direction (Shapr3D Move on a
 * face): the part along the normal offsets it (as Offset Face), the part in
 * its plane slides it — every planar neighbour sharing a straight edge with
 * it tilts about its far side to follow the moved edge.
 */
export interface MoveFaceFeature extends FeatureBase {
  kind: 'moveFace';
  face: FaceRef;
  vector: Vec3;
  /**
   * Then turns the face by `angle` degrees (right-hand) about the line
   * through `point` (moved with the face) along `axis` (in the face's plane);
   * the neighbours follow (Shapr3D's gizmo rings on a face).
   */
  rotation?: { point: Vec3; axis: Vec3; angle: number };
}

export type DirectEditFeature =
  | OffsetFaceFeature
  | DeleteFaceFeature
  | MoveEdgeFeature
  | MoveFaceFeature;

declare module '../../foundation/document/featureKinds.js' {
  interface FeatureKindMap {
    offsetFace: OffsetFaceFeature;
    deleteFace: DeleteFaceFeature;
    moveEdge: MoveEdgeFeature;
    moveFace: MoveFaceFeature;
  }
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(isNumber);

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

registerFeatureKind({
  kind: 'moveEdge',
  module: 'direct-edit',
  label: 'Move Edge',
  validate: (r, path, h) => {
    h.edgeRef(r.edge, `${path}.edge`);
    if (!isVec3(r.vector)) h.fail(`${path}.vector`, 'expected a Vec3');
  },
});

registerFeatureKind({
  kind: 'moveFace',
  module: 'direct-edit',
  label: 'Move Face',
  validate: (r, path, h) => {
    h.faceRef(r.face, `${path}.face`);
    if (!isVec3(r.vector)) h.fail(`${path}.vector`, 'expected a Vec3');
    if (r.rotation !== undefined) {
      const raw = r.rotation;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        h.fail(`${path}.rotation`, 'expected an object');
      }
      const rot = raw as Record<string, unknown>;
      if (!isVec3(rot.point)) h.fail(`${path}.rotation.point`, 'expected a Vec3');
      if (!isVec3(rot.axis)) h.fail(`${path}.rotation.axis`, 'expected a Vec3');
      if (!isNumber(rot.angle)) h.fail(`${path}.rotation.angle`, 'expected a number');
    }
  },
});
