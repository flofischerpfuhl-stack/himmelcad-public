/**
 * Pure orbit-camera state and math for the Assembler viewport: presets
 * (`CameraPreset` from the store), orbit/pan/zoom deltas, perspective or
 * orthographic projection, view roll and the view-cube orientation. No
 * WebGL, no DOM — unit tested directly.
 *
 * Convention: `yaw` rotates around world Z (up), `pitch` tilts away from the
 * XY plane, `distance` is eye-to-target. Z is up, matching `model/document.ts`.
 * The camera basis is derived continuously from yaw/pitch (no special case
 * at the poles), so Top/Bottom are exact (pitch = ±90°) and screen-up there
 * is the direction pointing away from the eye's horizontal offset: with the
 * presets' yaw of -90° that is +Y on Top and -Y on Bottom, like every CAD
 * view cube.
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
  /** Rotation of the view about its viewing axis, radians (view-cube roll arrows). Default 0. */
  roll?: number;
  /**
   * Vertical field of view in degrees; `0` = orthographic. Default
   * {@link DEFAULT_FOV_DEG}. An orthographic view shows the same size at the
   * target as the default perspective, so toggling keeps the framing.
   */
  fov?: number;
}

export const DEFAULT_FOV_DEG = 45;
/** Kept for callers that need the default perspective angle. */
export const FOV_Y_RADIANS = (DEFAULT_FOV_DEG * Math.PI) / 180;
export const MIN_PERSPECTIVE_FOV_DEG = 10;
export const MAX_PERSPECTIVE_FOV_DEG = 90;
const MIN_DISTANCE = 1;
const MAX_DISTANCE = 100000;
/** Orbit stops just short of the poles; presets may sit exactly on them. */
const MAX_ORBIT_PITCH = Math.PI / 2 - 1e-4;

export const DEFAULT_POSE: CameraPose = {
  target: [0, 0, 0],
  distance: 300,
  yaw: -Math.PI / 4,
  pitch: Math.PI / 5,
};

export function isOrthographic(pose: CameraPose): boolean {
  return (pose.fov ?? DEFAULT_FOV_DEG) <= 0;
}

/** Perspective field of view (radians); the reference angle for orthographic views. */
export function fovRadians(pose: CameraPose): number {
  const fov = pose.fov ?? DEFAULT_FOV_DEG;
  return ((fov <= 0 ? DEFAULT_FOV_DEG : fov) * Math.PI) / 180;
}

/** World height visible at `depth` in front of the eye (constant for orthographic views). */
export function viewHeightAt(pose: CameraPose, depth: number): number {
  if (isOrthographic(pose)) return 2 * pose.distance * Math.tan(FOV_Y_RADIANS / 2);
  return 2 * Math.max(0, depth) * Math.tan(fovRadians(pose) / 2);
}

/** World units per CSS pixel at `depth` for a viewport `cssHeight` pixels tall. */
export function worldPerPixel(pose: CameraPose, depth: number, cssHeight: number): number {
  return viewHeightAt(pose, depth) / Math.max(1, cssHeight);
}

/** Unit direction from the target towards the eye. */
export function viewDirection(pose: CameraPose): Vec3 {
  const cp = Math.cos(pose.pitch);
  return [cp * Math.cos(pose.yaw), cp * Math.sin(pose.yaw), Math.sin(pose.pitch)];
}

export function eyeOf(pose: CameraPose): Vec3 {
  const d = viewDirection(pose);
  return [
    pose.target[0] + pose.distance * d[0],
    pose.target[1] + pose.distance * d[1],
    pose.target[2] + pose.distance * d[2],
  ];
}

/**
 * Eye position for screen-facing geometry (ribbons, billboards): the real
 * eye in perspective, a far point along the view direction in orthographic
 * views (parallel rays).
 */
export function billboardEye(pose: CameraPose): Vec3 {
  if (!isOrthographic(pose)) return eyeOf(pose);
  const d = viewDirection(pose);
  const far = pose.distance * 1000;
  return [pose.target[0] + far * d[0], pose.target[1] + far * d[1], pose.target[2] + far * d[2]];
}

/** Camera basis in world coordinates: `right`, `up` (screen axes) and `back` (towards the eye). */
export function cameraBasis(pose: CameraPose): { right: Vec3; up: Vec3; back: Vec3 } {
  const back = viewDirection(pose);
  const sp = Math.sin(pose.pitch);
  const cp = Math.cos(pose.pitch);
  // d(back)/d(pitch): continuous, never parallel to `back`, also at the poles.
  const up0: Vec3 = [-sp * Math.cos(pose.yaw), -sp * Math.sin(pose.yaw), cp];
  const right0 = normalizeVec3(crossVec3(up0, back));
  const roll = pose.roll ?? 0;
  if (roll === 0) return { right: right0, up: up0, back };
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  return {
    right: [right0[0] * c - up0[0] * s, right0[1] * c - up0[1] * s, right0[2] * c - up0[2] * s],
    up: [up0[0] * c + right0[0] * s, up0[1] * c + right0[1] * s, up0[2] * c + right0[2] * s],
    back,
  };
}

export function viewMatrix(pose: CameraPose): Mat4 {
  return lookAtMat4(eyeOf(pose), pose.target, cameraBasis(pose).up);
}

function orthographicMat4(halfWidth: number, halfHeight: number, near: number, far: number): Mat4 {
  const nf = 1 / (near - far);
  return new Float32Array([
    1 / halfWidth,
    0,
    0,
    0,
    0,
    1 / halfHeight,
    0,
    0,
    0,
    0,
    2 * nf,
    0,
    0,
    0,
    (far + near) * nf,
    1,
  ]);
}

/** Near/far clip distances along the viewing axis (orthographic `near` may be negative). */
export interface DepthRange {
  near: number;
  far: number;
}

export function projectionMatrix(
  aspect: number,
  distance: number,
  fovDeg?: number,
  range?: DepthRange | null,
): Mat4 {
  const fov = fovDeg ?? DEFAULT_FOV_DEG;
  if (fov <= 0) {
    const halfHeight = distance * Math.tan(FOV_Y_RADIANS / 2);
    // Depth range around the target, generous on both sides of the eye.
    return orthographicMat4(
      halfHeight * aspect,
      halfHeight,
      range?.near ?? -distance * 50,
      range?.far ?? distance * 50,
    );
  }
  const near = range?.near ?? Math.max(0.01, distance * 0.002);
  const far = range?.far ?? Math.max(near + 1, distance * 50);
  return perspectiveMat4((fov * Math.PI) / 180, aspect, near, far);
}

/**
 * View-projection matrix. `range` (from {@link depthRange}) only changes
 * depth precision, never where a point lands on screen, so picking/label
 * code may keep calling this without it.
 */
export function viewProjectionMatrix(
  pose: CameraPose,
  aspect: number,
  range?: DepthRange | null,
): Mat4 {
  return multiplyMat4(projectionMatrix(aspect, pose.distance, pose.fov, range), viewMatrix(pose));
}

/** Far/near ratio the depth buffer keeps precise (24-bit depth). */
const MAX_DEPTH_RATIO = 1e5;

/**
 * Adaptive clip planes fitted to what is drawn: the bounding sphere of the
 * visible model plus, when the grid is shown, the grid plane `z = 0` out to
 * `gridExtent` around the target. Tight planes keep 24-bit depth precise for
 * a 2 mm part and a 2 m part alike (WebGL2 has no clip control, so a
 * reversed-Z float depth buffer would not help the default framebuffer).
 */
export function depthRange(
  pose: CameraPose,
  bounds: Bounds | null,
  gridExtent: number | null,
): DepthRange {
  const eye = eyeOf(pose);
  const back = viewDirection(pose);
  const depthOf = (p: Vec3) =>
    -((p[0] - eye[0]) * back[0] + (p[1] - eye[1]) * back[1] + (p[2] - eye[2]) * back[2]);
  const ortho = isOrthographic(pose);
  let near = Infinity;
  let far = -Infinity;
  if (bounds) {
    // The box's corners bound the depth range of everything inside it.
    for (const x of [bounds.min[0], bounds.max[0]])
      for (const y of [bounds.min[1], bounds.max[1]])
        for (const z of [bounds.min[2], bounds.max[2]]) {
          const d = depthOf([x, y, z]);
          near = Math.min(near, d);
          far = Math.max(far, d);
        }
    const pad = Math.max(1e-3, (far - near) * 0.02);
    near -= pad;
    far += pad;
    // Inside the box (zoomed into a part): keep a small but useful near plane;
    // geometry closer than 0.5 % of the orbit distance is clipped.
    if (!ortho && near < pose.distance * 0.005) near = pose.distance * 0.005;
  }
  if (gridExtent !== null) {
    const t = depthOf(pose.target);
    far = Math.max(far, t + gridExtent);
    // The grid plane is never nearer than about half the eye's height above it
    // inside the view frustum (rays at most ~45° off axis).
    const height = Math.abs(eye[2]);
    near = Math.min(near, ortho ? t - gridExtent : height * 0.5);
  }
  if (!Number.isFinite(near) || !Number.isFinite(far)) {
    return ortho
      ? { near: -pose.distance * 50, far: pose.distance * 50 }
      : { near: Math.max(0.01, pose.distance * 0.002), far: Math.max(1, pose.distance * 50) };
  }
  if (ortho) {
    const pad = Math.max(1e-3, (far - near) * 0.01);
    return { near: near - pad, far: far + pad };
  }
  far = Math.max(far * 1.01, 1e-3);
  const minNear = Math.max(far / MAX_DEPTH_RATIO, 1e-4);
  return { near: Math.max(minNear, near), far };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function orbit(pose: CameraPose, dxPixels: number, dyPixels: number): CameraPose {
  return {
    ...pose,
    yaw: pose.yaw - dxPixels * 0.006,
    pitch: clamp(pose.pitch + dyPixels * 0.006, -MAX_ORBIT_PITCH, MAX_ORBIT_PITCH),
  };
}

/**
 * Screen-space pan: moves `target` along the camera's right/up axes so the
 * scene at view depth `depth` (default: the target's) follows the pointer 1:1.
 */
export function pan(
  pose: CameraPose,
  dxPixels: number,
  dyPixels: number,
  viewportHeightPx: number,
  depth: number = pose.distance,
): CameraPose {
  const { right, up } = cameraBasis(pose);
  const scale = worldPerPixel(pose, depth, viewportHeightPx);
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

/**
 * Changes the field of view (`0` = orthographic) keeping the apparent size
 * of the target plane: the distance is scaled so the visible height at the
 * target stays the same.
 */
export function withFov(pose: CameraPose, fovDeg: number): CameraPose {
  const next = fovDeg <= 0 ? 0 : clamp(fovDeg, MIN_PERSPECTIVE_FOV_DEG, MAX_PERSPECTIVE_FOV_DEG);
  const height = viewHeightAt(pose, pose.distance);
  if (next === 0) {
    return { ...pose, fov: 0, distance: height / (2 * Math.tan(FOV_Y_RADIANS / 2)) };
  }
  const distance = height / (2 * Math.tan((next * Math.PI) / 360));
  return { ...pose, fov: next, distance: clamp(distance, MIN_DISTANCE, MAX_DISTANCE) };
}

/** Rotates the view about its viewing axis by `degrees` (positive = content turns counter-clockwise on screen). */
export function rollBy(pose: CameraPose, degrees: number): CameraPose {
  let roll = (pose.roll ?? 0) + (degrees * Math.PI) / 180;
  while (roll > Math.PI) roll -= 2 * Math.PI;
  while (roll <= -Math.PI) roll += 2 * Math.PI;
  return { ...pose, roll: Math.abs(roll) < 1e-9 ? 0 : roll };
}

export type CameraPresetName = 'iso' | 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right';

const PRESET_ANGLES: Record<CameraPresetName, { yaw: number; pitch: number }> = {
  iso: { yaw: -Math.PI / 4, pitch: Math.PI / 5 },
  front: { yaw: -Math.PI / 2, pitch: 0 },
  back: { yaw: Math.PI / 2, pitch: 0 },
  right: { yaw: 0, pitch: 0 },
  left: { yaw: Math.PI, pitch: 0 },
  top: { yaw: -Math.PI / 2, pitch: Math.PI / 2 },
  bottom: { yaw: -Math.PI / 2, pitch: -Math.PI / 2 },
};

/** Keeps the current target/distance/projection, only reorienting yaw/pitch (roll reset). */
export function presetPose(preset: CameraPresetName, current: CameraPose): CameraPose {
  const angles = PRESET_ANGLES[preset];
  return { ...current, yaw: angles.yaw, pitch: angles.pitch, roll: 0 };
}

/**
 * Pose looking at the current target from world direction `dir` (target →
 * eye). Straight up/down directions use yaw -90° (screen-up +Y on top, -Y
 * below) unless `upHint` names the world direction that should point up.
 */
export function poseFromDirection(
  dir: Vec3,
  current: CameraPose,
  upHint?: Vec3 | null,
): CameraPose {
  const d = normalizeVec3(dir);
  const pitch = Math.asin(clamp(d[2], -1, 1));
  let yaw: number;
  if (Math.abs(d[2]) > 1 - 1e-9) {
    // At the poles screen-up is -(cos yaw, sin yaw) looking down, +(…) looking up.
    const up = upHint ?? [0, d[2] > 0 ? 1 : -1, 0];
    yaw = d[2] > 0 ? Math.atan2(-up[1], -up[0]) : Math.atan2(up[1], up[0]);
  } else {
    yaw = Math.atan2(d[1], d[0]);
  }
  return {
    ...current,
    yaw,
    pitch: Math.abs(d[2]) > 1 - 1e-9 ? Math.sign(d[2]) * (Math.PI / 2) : pitch,
    roll: 0,
  };
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
  const fov = isOrthographic(current) ? FOV_Y_RADIANS : fovRadians(current);
  const fitFactor = 1 / Math.sin(Math.min(fov, fov * Math.max(1, aspect)) / 2);
  // 1.5x (rather than a tight ~1.15x) leaves a comfortable margin around
  // the framed bounds so the part reads as centred in the free viewport
  // area at roughly 40-50% of the viewport height, matching the pleasing
  // "fit" look of the Shapr3D reference rather than filling the frame.
  const distance = radius * fitFactor * 1.5;
  return { ...current, target: center, distance: clamp(distance, MIN_DISTANCE, MAX_DISTANCE) };
}

function wrapAngle(a: number): number {
  let d = a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Smallest field of view a projection blend passes through (degrees): a
 * 2° perspective is indistinguishable from a parallel view, so a blend
 * from or to orthographic starts/ends there and then switches exactly.
 */
export const BLEND_MIN_FOV_DEG = 2;

/** `tan(fov / 2)` of a pose's projection: 0 for orthographic. */
export function perspectiveStrength(fovDeg: number | undefined): number {
  const fov = fovDeg ?? DEFAULT_FOV_DEG;
  return fov <= 0 ? 0 : Math.tan((fov * Math.PI) / 360);
}

/** Field of view (degrees) of a perspective strength; below the blend minimum it stays at that minimum. */
export function fovOfStrength(s: number): number {
  const min = perspectiveStrength(BLEND_MIN_FOV_DEG);
  return (Math.atan(Math.max(min, s)) * 360) / Math.PI;
}

export function lerpPose(a: CameraPose, b: CameraPose, t: number): CameraPose {
  // Views straight up/down keep the destination yaw (it sets screen-up there).
  const dyaw = wrapAngle(b.yaw - a.yaw);
  const rollA = a.roll ?? 0;
  const rollB = b.roll ?? 0;
  const target: Vec3 = [
    a.target[0] + (b.target[0] - a.target[0]) * t,
    a.target[1] + (b.target[1] - a.target[1]) * t,
    a.target[2] + (b.target[2] - a.target[2]) * t,
  ];
  const angles = {
    yaw: t >= 1 ? b.yaw : a.yaw + dyaw * t,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    roll: t >= 1 ? rollB : rollA + wrapAngle(rollB - rollA) * t,
  };
  const fovA = a.fov ?? DEFAULT_FOV_DEG;
  const fovB = b.fov ?? DEFAULT_FOV_DEG;
  if (fovA === fovB || t >= 1) {
    return {
      ...b,
      target,
      distance: t >= 1 ? b.distance : a.distance * Math.pow(b.distance / a.distance, t),
      ...angles,
    };
  }
  // A projection change on the way (Adaptive: perspective → a view-cube face in
  // orthographic): the visible height at the target follows the zoom, the
  // perspective strength fades, and the distance is what gives that height.
  const heightA = viewHeightAt(a, a.distance);
  const heightB = viewHeightAt(b, b.distance);
  const height = heightA * Math.pow(heightB / heightA, t);
  const s = perspectiveStrength(fovA) + (perspectiveStrength(fovB) - perspectiveStrength(fovA)) * t;
  const fov = fovOfStrength(s);
  return {
    ...b,
    target,
    fov,
    distance: height / (2 * Math.tan((fov * Math.PI) / 360)),
    ...angles,
  };
}

/** Depth of `point` along the viewing axis, measured from the eye (orthographic: from the target's eye). */
export function viewDepthOf(pose: CameraPose, point: Vec3): number {
  const eye = eyeOf(pose);
  const back = viewDirection(pose);
  return -(
    (point[0] - eye[0]) * back[0] +
    (point[1] - eye[1]) * back[1] +
    (point[2] - eye[2]) * back[2]
  );
}

/** The point of a pointer ray (`unprojectRay`) at view depth `depth`, or `null` for a ray parallel to the screen. */
export function pointAtViewDepth(
  pose: CameraPose,
  ray: { origin: Vec3; direction: Vec3 },
  depth: number,
): Vec3 | null {
  const back = viewDirection(pose);
  const along = -(
    ray.direction[0] * back[0] +
    ray.direction[1] * back[1] +
    ray.direction[2] * back[2]
  );
  if (along < 1e-9) return null;
  const t = (depth - viewDepthOf(pose, ray.origin)) / along;
  return [
    ray.origin[0] + ray.direction[0] * t,
    ray.origin[1] + ray.direction[1] * t,
    ray.origin[2] + ray.direction[2] * t,
  ];
}

/**
 * Changes the projection to `fovDeg` (`0` = orthographic; perspective
 * angles are not clamped, so blends may pass small ones) keeping the plane
 * through `anchor` parallel to the screen exactly where it is: same screen
 * position and the same scale. The target moves along the viewing axis to
 * that plane. Without an anchor the target's plane is kept.
 */
export function withFovAt(pose: CameraPose, fovDeg: number, anchor?: Vec3 | null): CameraPose {
  const back = viewDirection(pose);
  const depth = anchor ? viewDepthOf(pose, anchor) : pose.distance;
  const ortho = isOrthographic(pose);
  // Visible height on the anchor plane now.
  const height = ortho
    ? viewHeightAt(pose, pose.distance)
    : 2 * Math.max(1e-6, depth) * Math.tan(fovRadians(pose) / 2);
  // The anchor plane's centre (on the viewing axis).
  const shift = pose.distance - depth;
  const centre: Vec3 = [
    pose.target[0] + back[0] * shift,
    pose.target[1] + back[1] * shift,
    pose.target[2] + back[2] * shift,
  ];
  if (fovDeg <= 0) {
    return {
      ...pose,
      fov: 0,
      target: centre,
      distance: height / (2 * Math.tan(FOV_Y_RADIANS / 2)),
    };
  }
  const distance = height / (2 * Math.tan((fovDeg * Math.PI) / 360));
  return { ...pose, fov: fovDeg, target: centre, distance };
}

/**
 * Orbits like {@link orbit} but about `pivot` instead of the target: the
 * camera turns rigidly about the pivot, which stays where it is on screen.
 */
export function orbitAbout(
  pose: CameraPose,
  dxPixels: number,
  dyPixels: number,
  pivot: Vec3 | null,
): CameraPose {
  const next = orbit(pose, dxPixels, dyPixels);
  if (!pivot) return next;
  const before = cameraBasis(pose);
  const after = cameraBasis(next);
  const rel: Vec3 = [
    pose.target[0] - pivot[0],
    pose.target[1] - pivot[1],
    pose.target[2] - pivot[2],
  ];
  // Camera-space coordinates of the target relative to the pivot stay the same.
  const r = rel[0] * before.right[0] + rel[1] * before.right[1] + rel[2] * before.right[2];
  const u = rel[0] * before.up[0] + rel[1] * before.up[1] + rel[2] * before.up[2];
  const b = rel[0] * before.back[0] + rel[1] * before.back[1] + rel[2] * before.back[2];
  return {
    ...next,
    target: [
      pivot[0] + after.right[0] * r + after.up[0] * u + after.back[0] * b,
      pivot[1] + after.right[1] * r + after.up[1] * u + after.back[1] * b,
      pivot[2] + after.right[2] * r + after.up[2] * u + after.back[2] * b,
    ],
  };
}

/** `true` once camera-facing "up" for the view cube should read as looking from below (bottom-ish pitch). */
export function isLookingFromBelow(pose: CameraPose): boolean {
  return pose.pitch < 0;
}

export function invertViewProjection(pose: CameraPose, aspect: number): Mat4 | null {
  return invertMat4(viewProjectionMatrix(pose, aspect));
}

// ---- View cube ------------------------------------------------------------------------------

export type CubeFaceName = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';

/** A cube face in world terms: outward normal plus the directions its label reads right/up. */
export interface CubeFace {
  name: CubeFaceName;
  label: string;
  normal: Vec3;
  right: Vec3;
  up: Vec3;
}

/**
 * The six labelled faces. A face is what the camera sees when it looks
 * *from* that side: Front = from -Y, Right = from +X, Top = from +Z
 * (matching {@link presetPose}).
 */
export const CUBE_FACES: readonly CubeFace[] = [
  { name: 'front', label: 'Front', normal: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  { name: 'back', label: 'Back', normal: [0, 1, 0], right: [-1, 0, 0], up: [0, 0, 1] },
  { name: 'right', label: 'Right', normal: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] },
  { name: 'left', label: 'Left', normal: [-1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] },
  { name: 'top', label: 'Top', normal: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] },
  { name: 'bottom', label: 'Bottom', normal: [0, 0, -1], right: [1, 0, 0], up: [0, -1, 0] },
];

/** World → cube-local CSS coordinates (x right, y down, z towards the viewer when looking from the front). */
function worldToCss(v: Vec3): Vec3 {
  return [v[0], -v[2], -v[1]];
}

function matrix3d(x: Vec3, y: Vec3, z: Vec3, t: Vec3 = [0, 0, 0]): number[] {
  // CSS matrix3d is column-major: the images of the local x, y, z axes, then the translation.
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, t[0], t[1], t[2], 1];
}

/**
 * CSS `matrix3d` values that orient the view cube exactly like the scene:
 * derived from the same camera basis as {@link viewMatrix} (roll and poles
 * included), so the face facing the viewer is always the side the camera
 * looks from.
 */
export function cubeMatrix3d(pose: CameraPose): number[] {
  const { right, up, back } = cameraBasis(pose);
  // screen(css) = (world·right, -(world·up), world·back); cube-local css → world first.
  const cssAxisToScreen = (cssAxis: Vec3): Vec3 => {
    // cube-local css axis → world: inverse of worldToCss.
    const w: Vec3 = [cssAxis[0], -cssAxis[2], -cssAxis[1]];
    return [
      w[0] * right[0] + w[1] * right[1] + w[2] * right[2],
      -(w[0] * up[0] + w[1] * up[1] + w[2] * up[2]),
      w[0] * back[0] + w[1] * back[1] + w[2] * back[2],
    ];
  };
  return matrix3d(
    cssAxisToScreen([1, 0, 0]),
    cssAxisToScreen([0, 1, 0]),
    cssAxisToScreen([0, 0, 1]),
  );
}

/** CSS `matrix3d` placing a face (label upright, outward normal as its local +z) at `half` px from the centre. */
export function cubeFaceMatrix3d(face: CubeFace, half: number): number[] {
  const n = worldToCss(face.normal);
  return matrix3d(worldToCss(face.right), worldToCss([-face.up[0], -face.up[1], -face.up[2]]), n, [
    n[0] * half,
    n[1] * half,
    n[2] * half,
  ]);
}

/** Column-major 4x4 product `a · b` (apply `b` first), as CSS composes `transform: a b`. */
function multiplyCss(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export interface CubeFaceTransform {
  face: CubeFace;
  /** The face's complete `matrix3d` (cube orientation · face placement) about the cube centre. */
  matrix: number[];
  /** The face turns its outside towards the eye (perspective-correct back-face test). */
  visible: boolean;
  /** Distance of the face centre towards the viewer (CSS z, px): larger is nearer. */
  depth: number;
}

/**
 * The view cube's six faces, each as one flat transform plus its own
 * back-face test, so rendering needs neither `transform-style: preserve-3d`
 * nor `backface-visibility` (engines differ there — the WebKit tested here
 * flattens the preserve-3d cube and culls the wrong sides). `perspective` is
 * the CSS perspective distance (px) the faces are drawn with, the eye sitting
 * that far in front of the cube centre: a face is visible when the eye is on
 * its outer side, `(eye − centre) · normal > 0`.
 */
export function cubeFaceTransforms(
  pose: CameraPose,
  half: number,
  perspective: number,
): CubeFaceTransform[] {
  const cube = cubeMatrix3d(pose);
  return CUBE_FACES.map((face) => {
    const matrix = multiplyCss(cube, cubeFaceMatrix3d(face, half));
    const normal: Vec3 = [matrix[8]!, matrix[9]!, matrix[10]!];
    const centre: Vec3 = [matrix[12]!, matrix[13]!, matrix[14]!];
    const towardsEye =
      -centre[0] * normal[0] - centre[1] * normal[1] + (perspective - centre[2]) * normal[2];
    return { face, matrix, visible: towardsEye > 1e-6, depth: centre[2] };
  });
}

/** The face whose outward normal points most directly at the viewer. */
export function facingCubeFace(pose: CameraPose): CubeFace {
  const back = viewDirection(pose);
  let best = CUBE_FACES[0]!;
  let bestDot = -Infinity;
  for (const face of CUBE_FACES) {
    const d = face.normal[0] * back[0] + face.normal[1] * back[1] + face.normal[2] * back[2];
    if (d > bestDot) {
      bestDot = d;
      best = face;
    }
  }
  return best;
}

/** `true` when the camera looks straight at a cube face (within `toleranceDeg`). */
export function isFaceOnView(pose: CameraPose, toleranceDeg = 0.5): boolean {
  const back = viewDirection(pose);
  const face = facingCubeFace(pose);
  const d = face.normal[0] * back[0] + face.normal[1] * back[1] + face.normal[2] * back[2];
  return d > Math.cos((toleranceDeg * Math.PI) / 180);
}

/**
 * View direction (target → eye) for a cell of a face's 3x3 grid:
 * `(0, 0)` = the face, one non-zero coordinate = the edge view between two
 * faces, two = the corner (isometric) view of three faces.
 */
export function cubeCellDirection(face: CubeFace, i: -1 | 0 | 1, j: -1 | 0 | 1): Vec3 {
  return normalizeVec3([
    face.normal[0] + face.right[0] * i + face.up[0] * j,
    face.normal[1] + face.right[1] * i + face.up[1] * j,
    face.normal[2] + face.right[2] * i + face.up[2] * j,
  ]);
}
