/**
 * Pure orbit-camera state and math for the Assembler viewport: presets
 * (`CameraPreset` from the store), orbit/pan/zoom deltas, and the
 * view-projection matrix. No WebGL, no DOM — unit tested directly.
 *
 * Convention: `yaw` rotates around world Z (up), `pitch` tilts away from the
 * XY plane, `distance` is eye-to-target. Z is up, matching `model/document.ts`.
 */
import {
  crossVec3,
  invertMat4,
  lookAtMat4,
  multiplyMat4,
  normalizeVec3,
  perspectiveMat4,
  type Mat4,
  type Vec3,
} from './math.js';

export interface CameraPose {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
}

export const FOV_Y_RADIANS = (45 * Math.PI) / 180;
const MIN_DISTANCE = 1;
const MAX_DISTANCE = 100000;
const MIN_PITCH = -Math.PI / 2 + 0.02;
const MAX_PITCH = Math.PI / 2 - 0.02;

export const DEFAULT_POSE: CameraPose = {
  target: [0, 0, 0],
  distance: 300,
  yaw: -Math.PI / 4,
  pitch: Math.PI / 5,
};

export function eyeOf(pose: CameraPose): Vec3 {
  const cp = Math.cos(pose.pitch);
  return [
    pose.target[0] + pose.distance * cp * Math.cos(pose.yaw),
    pose.target[1] + pose.distance * cp * Math.sin(pose.yaw),
    pose.target[2] + pose.distance * Math.sin(pose.pitch),
  ];
}

export function viewMatrix(pose: CameraPose): Mat4 {
  const eye = eyeOf(pose);
  const up: Vec3 =
    Math.abs(pose.pitch) > MAX_PITCH - 0.05
      ? [Math.cos(pose.yaw), Math.sin(pose.yaw), 0]
      : [0, 0, 1];
  return lookAtMat4(eye, pose.target, up);
}

export function projectionMatrix(aspect: number, distance: number): Mat4 {
  const near = Math.max(0.01, distance * 0.002);
  const far = Math.max(near + 1, distance * 50);
  return perspectiveMat4(FOV_Y_RADIANS, aspect, near, far);
}

export function viewProjectionMatrix(pose: CameraPose, aspect: number): Mat4 {
  return multiplyMat4(projectionMatrix(aspect, pose.distance), viewMatrix(pose));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function orbit(pose: CameraPose, dxPixels: number, dyPixels: number): CameraPose {
  return {
    ...pose,
    yaw: pose.yaw - dxPixels * 0.006,
    pitch: clamp(pose.pitch + dyPixels * 0.006, MIN_PITCH, MAX_PITCH),
  };
}

/** Screen-space pan: moves `target` along the camera's right/up axes so the scene appears to follow the pointer 1:1. */
export function pan(
  pose: CameraPose,
  dxPixels: number,
  dyPixels: number,
  viewportHeightPx: number,
): CameraPose {
  const eye = eyeOf(pose);
  const forward = normalizeVec3([
    pose.target[0] - eye[0],
    pose.target[1] - eye[1],
    pose.target[2] - eye[2],
  ]);
  const worldUp: Vec3 = [0, 0, 1];
  const right = normalizeVec3(crossVec3(forward, worldUp));
  const up = crossVec3(right, forward);
  const scale = (2 * pose.distance * Math.tan(FOV_Y_RADIANS / 2)) / Math.max(1, viewportHeightPx);
  const dx = -dxPixels * scale;
  const dy = dyPixels * scale;
  return {
    ...pose,
    target: [
      pose.target[0] + right[0] * dx + up[0] * dy,
      pose.target[1] + right[1] * dx + up[1] * dy,
      pose.target[2] + right[2] * dx + up[2] * dy,
    ],
  };
}

/** Zooms by `factor` (>1 zooms out), pulling `target` toward `anchor` (the world point under the cursor) so the anchor stays fixed on screen. */
export function zoomTowards(pose: CameraPose, factor: number, anchor: Vec3 | null): CameraPose {
  const nextDistance = clamp(pose.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
  if (!anchor) return { ...pose, distance: nextDistance };
  const k = 1 - nextDistance / pose.distance;
  return {
    ...pose,
    distance: nextDistance,
    target: [
      pose.target[0] + (anchor[0] - pose.target[0]) * k,
      pose.target[1] + (anchor[1] - pose.target[1]) * k,
      pose.target[2] + (anchor[2] - pose.target[2]) * k,
    ],
  };
}

export type CameraPresetName = 'iso' | 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right';

const PRESET_ANGLES: Record<CameraPresetName, { yaw: number; pitch: number }> = {
  iso: { yaw: -Math.PI / 4, pitch: Math.PI / 5 },
  front: { yaw: -Math.PI / 2, pitch: 0 },
  back: { yaw: Math.PI / 2, pitch: 0 },
  right: { yaw: 0, pitch: 0 },
  left: { yaw: Math.PI, pitch: 0 },
  top: { yaw: -Math.PI / 2, pitch: MAX_PITCH },
  bottom: { yaw: -Math.PI / 2, pitch: MIN_PITCH },
};

/** Keeps the current target/distance, only reorienting yaw/pitch. */
export function presetPose(preset: CameraPresetName, current: CameraPose): CameraPose {
  const angles = PRESET_ANGLES[preset];
  return { ...current, yaw: angles.yaw, pitch: angles.pitch };
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** Frames all given bounds (union) with the current orientation preserved; falls back to the origin with a modest radius when there is nothing to frame. */
export function fitPose(
  bounds: readonly Bounds[],
  current: CameraPose,
  aspect: number,
): CameraPose {
  if (bounds.length === 0) {
    return { ...current, target: [0, 0, 0], distance: Math.max(200, current.distance) };
  }
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of bounds) {
    min = [Math.min(min[0], b.min[0]), Math.min(min[1], b.min[1]), Math.min(min[2], b.min[2])];
    max = [Math.max(max[0], b.max[0]), Math.max(max[1], b.max[1]), Math.max(max[2], b.max[2])];
  }
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
  const fitFactor = 1 / Math.sin(Math.min(FOV_Y_RADIANS, FOV_Y_RADIANS * Math.max(1, aspect)) / 2);
  // 2.0x (rather than a tight ~1.15x) leaves a comfortable margin around
  // the framed bounds so the part reads as centred in the free viewport
  // area at roughly 40-50% of the viewport height, matching the pleasing
  // "fit" look of the Shapr3D reference rather than filling the frame.
  const distance = radius * fitFactor * 1.5;
  return { ...current, target: center, distance: clamp(distance, MIN_DISTANCE, MAX_DISTANCE) };
}

export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  let dyaw = b.yaw - a.yaw;
  while (dyaw > Math.PI) dyaw -= Math.PI * 2;
  while (dyaw < -Math.PI) dyaw += Math.PI * 2;
  return {
    target: [
      a.target[0] + (b.target[0] - a.target[0]) * t,
      a.target[1] + (b.target[1] - a.target[1]) * t,
      a.target[2] + (b.target[2] - a.target[2]) * t,
    ],
    distance: a.distance * Math.pow(b.distance / a.distance, t),
    yaw: a.yaw + dyaw * t,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
  };
}

/** `true` once camera-facing "up" for the view cube should read as looking from below (bottom-ish pitch). */
export function isLookingFromBelow(pose: CameraPose): boolean {
  return pose.pitch < 0;
}

export function invertViewProjection(pose: CameraPose, aspect: number): Mat4 | null {
  return invertMat4(viewProjectionMatrix(pose, aspect));
}
