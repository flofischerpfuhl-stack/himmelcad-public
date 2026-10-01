/**
 * Camera pose that looks straight at a sketch plane (Shapr3D animates the
 * view normal to the sketch when sketch mode starts). Construction planes
 * are viewed so that the sketch's u axis points right and v up; a sketch on
 * a body face is viewed from outside the body (along the outward normal).
 */
import type { SketchFrame, SketchPlaneRef } from '../../foundation/document/document.js';
import type { CameraPose } from '../../platform/viewport/camera.js';
import {
  entityMap,
  pointPos,
  type SketchData,
  type Vec2,
} from '../../foundation/sketch-solver/types.js';

const NEAR_POLE_PITCH = Math.PI / 2 - 0.02;

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}

/** Unit direction from the target towards the eye. */
export function sketchViewDirection(
  frame: SketchFrame,
  plane: SketchPlaneRef,
): [number, number, number] {
  return plane.kind === 'plane' ? cross(frame.u, frame.v) : [...frame.normal];
}

/**
 * Pose looking at `center` (world) from `direction`, keeping `distance`.
 * Straight up/down views use the same near-pole pitch as the Top/Bottom
 * presets so the orbit camera keeps a stable up vector.
 */
export function poseLookingAlong(
  direction: readonly number[],
  center: readonly [number, number, number],
  distance: number,
  /** World direction that should point up on screen for straight up/down views (e.g. the sketch v axis). */
  up: readonly number[] = [0, 1, 0],
): CameraPose {
  const [x, y, z] = direction as [number, number, number];
  if (Math.abs(z) > 0.999) {
    // Near the poles the orbit camera's screen-up is -(cos yaw, sin yaw, 0) looking
    // down and +(cos yaw, sin yaw, 0) looking up (see `viewport/camera.ts` `cameraBasis`).
    return {
      target: [...center],
      distance,
      yaw: z > 0 ? Math.atan2(-up[1]!, -up[0]!) : Math.atan2(up[1]!, up[0]!),
      pitch: Math.sign(z) * NEAR_POLE_PITCH,
    };
  }
  return {
    target: [...center],
    distance,
    yaw: Math.atan2(y, x),
    pitch: Math.max(
      -NEAR_POLE_PITCH,
      Math.min(NEAR_POLE_PITCH, Math.asin(Math.max(-1, Math.min(1, z)))),
    ),
  };
}

/** Bounding box of a sketch's points in (u, v), or `null` when empty. */
export function sketchBounds(sketch: SketchData): { min: Vec2; max: Vec2 } | null {
  const map = entityMap(sketch);
  let min: Vec2 | null = null;
  let max: Vec2 | null = null;
  for (const e of sketch.entities) {
    const points: Vec2[] = [];
    if (e.kind === 'point') points.push([e.x, e.y]);
    else if (e.kind === 'circle') {
      const c = pointPos(map, e.center);
      if (c) points.push([c[0] - e.radius, c[1] - e.radius], [c[0] + e.radius, c[1] + e.radius]);
    }
    for (const p of points) {
      min = min ? [Math.min(min[0], p[0]), Math.min(min[1], p[1])] : [...p];
      max = max ? [Math.max(max[0], p[0]), Math.max(max[1], p[1])] : [...p];
    }
  }
  return min && max ? { min, max } : null;
}
