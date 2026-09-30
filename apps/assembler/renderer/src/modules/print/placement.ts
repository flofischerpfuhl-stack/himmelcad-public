/**
 * Builds the History steps of the build-plate tools: "Place on plate" and
 * an applied "Auto orient" candidate are ordinary `transform` features
 * (rotate about the body's box centre, then drop onto Z = 0), so they are
 * one undo step, editable in History and replayed by the kernel like a
 * Move/Rotate. Shared by the UI commands and the agent API.
 */
import type { Body, EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import type { Feature, Vec3 } from '../../foundation/document/document.js';
import type { FeatureOf } from '../../foundation/document/featureKinds.js';

/** The modelling module's rigid-transform kind, read through the kind registry (no module import). */
type TransformFeature = FeatureOf<'transform'>;
import { referenceMeshIdOf } from '../../foundation/commands/referenceMesh.js';
import { findFace } from '../../foundation/commands/store.js';
import type { OrientationMesh, PlacementTransform } from './orientation.js';
import { placeOnPlate } from './orientation.js';

export const PLACE_ON_PLATE_LABEL = 'Place on Plate';
export const AUTO_ORIENT_LABEL = 'Orient for Print';

export class PlacementError extends Error {}

/** Next free display name `"<prefix> <n>"`. */
function nextName(prefix: string, features: readonly Feature[]): string {
  const count = features.filter((f) => f.name.startsWith(`${prefix} `)).length;
  return `${prefix} ${count + 1}`;
}

function modelBody(evaluation: EvaluationResult, bodyId: string): Body {
  if (referenceMeshIdOf(bodyId) !== null) {
    throw new PlacementError('Reference meshes cannot be placed; only modelled bodies can.');
  }
  const body = evaluation.bodies.find((b) => b.id === bodyId);
  if (!body) throw new PlacementError(`No body "${bodyId}".`);
  return body;
}

/** `true` when the placement moves nothing (the body already lies that way on the plate). */
export function isIdentityPlacement(placement: PlacementTransform): boolean {
  const eps = 1e-9;
  return [placement.dx, placement.dy, placement.dz, placement.rx, placement.ry, placement.rz].every(
    (v) => Math.abs(v) < eps,
  );
}

/** A transform feature for `placement` of `bodyId`. */
export function placementFeature(
  bodyId: string,
  placement: PlacementTransform,
  id: string,
  name: string,
): TransformFeature {
  return {
    id,
    name,
    suppressed: false,
    kind: 'transform',
    bodyId,
    dx: placement.dx,
    dy: placement.dy,
    dz: placement.dz,
    rx: placement.rx,
    ry: placement.ry,
    rz: placement.rz,
    pivot: [...placement.pivot] as Vec3,
    copy: false,
  };
}

/**
 * The transform laying planar face `faceKey` of `bodyId` flat on the
 * build plate (its outward normal pointing −Z, lowest point at Z = 0).
 */
export function placeOnPlateFeature(
  evaluation: EvaluationResult,
  features: readonly Feature[],
  bodyId: string,
  faceKey: string,
  id: string,
): TransformFeature {
  const body = modelBody(evaluation, bodyId);
  const face = findFace(body, faceKey);
  if (!face) throw new PlacementError(`No face "${faceKey}" on ${body.name}.`);
  if (face.surface !== 'plane' || !face.normal) {
    throw new PlacementError('Pick a flat (planar) face to lay on the plate.');
  }
  const placement = placeOnPlate(
    { positions: body.mesh.positions, min: body.min, max: body.max },
    face.normal,
  );
  return placementFeature(bodyId, placement, id, nextName(PLACE_ON_PLATE_LABEL, features));
}

/** Short readable face label, e.g. `"Extrude 1 end"`. */
export function faceLabel(key: string, features: readonly Feature[]): string {
  const [featureId = key, role = ''] = key.split(':');
  const name = features.find((f) => f.id === featureId)?.name ?? featureId;
  return role ? `${name} ${role.replace(/#\d+$/, '')}` : name;
}

/** The mesh + planar faces "Auto orient" ranks, and readable labels of those faces. */
export function orientationInput(
  evaluation: EvaluationResult,
  features: readonly Feature[],
  bodyId: string,
): { mesh: OrientationMesh; faceLabels: string[] } {
  const body = modelBody(evaluation, bodyId);
  const planar = body.faces.filter(
    (f): f is typeof f & { normal: Vec3 } => f.surface === 'plane' && f.normal !== null,
  );
  return {
    mesh: {
      positions: body.mesh.positions,
      indices: body.mesh.indices,
      min: [...body.min],
      max: [...body.max],
      planarFaces: planar.map((f) => ({ normal: [...f.normal] as Vec3, area: f.area, key: f.key })),
    },
    faceLabels: planar.map((f) => `Face “${faceLabel(f.key, features)}” down`),
  };
}

/** Name of an applied auto-orient step. */
export function orientFeatureName(features: readonly Feature[]): string {
  return nextName(AUTO_ORIENT_LABEL, features);
}
