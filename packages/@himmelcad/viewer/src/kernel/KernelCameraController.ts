import type { KernelWorldCamera, KernelWorldPoint } from './WgpuKernelViewer.js';

const MIN_DISTANCE = 1e-5;
const MAX_DISTANCE = 1e12;
const PITCH_LIMIT = Math.PI / 2 - 0.01;
const DEFAULT_FOV = (50 * Math.PI) / 180;
const ORTHONORMAL_TOLERANCE = 1e-9;

type Vec3 = [number, number, number];

interface OrbitState {
  readonly target: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
}

interface LocalOrthographicState {
  readonly normal: Vec3;
  readonly up: Vec3;
}

export interface KernelCameraVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A plane-local view definition. `normal` points from the plane toward the camera. */
export interface KernelLocalOrthographicViewFrame {
  readonly origin: KernelWorldPoint;
  readonly normal: KernelCameraVector;
  readonly up: KernelCameraVector;
  readonly verticalSpan: number;
}

export interface KernelCameraTransitionPair {
  readonly from: KernelWorldCamera;
  readonly to: KernelWorldCamera;
}

/** Z-up perspective camera authored directly in project-world coordinates. */
export interface KernelPerspectiveViewpoint {
  readonly eye: KernelWorldPoint;
  readonly target: KernelWorldPoint;
  readonly verticalFovRadians?: number;
}

/** Throws before use when a local frame cannot define a stable camera basis. */
export function assertValidKernelLocalOrthographicViewFrame(
  frame: KernelLocalOrthographicViewFrame,
): void {
  validateLocalOrthographicFrame(frame);
}

/**
 * Framework-free f64 CAD camera used by browser, Electron and native hosts.
 * Z is permanently up; orbit and zoom can preserve an arbitrary cursor pivot.
 */
export class KernelCameraController {
  private target: Vec3 = [0, 0, 0];
  private yaw = 0;
  private pitch = Math.PI / 4;
  private distance = 50;
  private width: number;
  private height: number;
  private verticalFovRadians = DEFAULT_FOV;
  private lockedTopDown = false;
  private orthographicSpan = 50;
  private savedOrbit = { yaw: 0, pitch: Math.PI / 4, distance: 50 };
  private localOrthographic: LocalOrthographicState | null = null;
  private localReturn: OrbitState | null = null;

  constructor(width: number, height: number) {
    this.width = positiveExtent(width);
    this.height = positiveExtent(height);
  }

  setViewportSize(width: number, height: number): void {
    this.width = positiveExtent(width);
    this.height = positiveExtent(height);
  }

  worldCamera(): KernelWorldCamera {
    const aspect = this.width / this.height;
    const eye = this.eye();
    const near = Math.max(1e-5, Math.min(10, this.distance / 10_000));
    const far = Math.max(1_000_000, Math.min(MAX_DISTANCE, this.distance * 10_000));
    return {
      eye: point(eye),
      target: point(this.target),
      up: point(this.localOrthographic?.up ?? (this.lockedTopDown ? [0, 1, 0] : [0, 0, 1])),
      projection: this.isOrthographicView()
        ? { kind: 'orthographic', verticalSpan: this.orthographicSpan, aspect, near, far }
        : {
            kind: 'perspective',
            verticalFovRadians: this.verticalFovRadians,
            aspect,
            near,
            far,
          },
    };
  }

  targetPoint(): KernelWorldPoint {
    return point(this.target);
  }

  /** World coordinate below any cursor on the plane through the orbit target. */
  worldPointOnTargetPlane(ndcX: number, ndcY: number): KernelWorldPoint {
    const safeX = clamp(ndcX, -3, 3);
    const safeY = clamp(ndcY, -3, 3);
    const eye = this.eye();
    const basis = this.basis();
    let rayOrigin = eye;
    let rayDirection = basis.forward;
    if (this.isOrthographicView()) {
      rayOrigin = add(
        eye,
        add(
          scale(basis.right, (safeX * this.orthographicSpan * this.width) / this.height / 2),
          scale(basis.up, (safeY * this.orthographicSpan) / 2),
        ),
      );
    } else {
      const tangent = Math.tan(this.verticalFovRadians / 2);
      rayDirection = normalize(
        add(
          basis.forward,
          add(
            scale(basis.right, (safeX * tangent * this.width) / this.height),
            scale(basis.up, safeY * tangent),
          ),
        ),
      );
    }
    const denominator = dot(rayDirection, basis.forward);
    const distance = dot(subtract(this.target, rayOrigin), basis.forward) / denominator;
    return point(add(rayOrigin, scale(rayDirection, distance)));
  }

  orbit(deltaYaw: number, deltaPitch: number): void {
    if (this.isOrthographicView() || !finite(deltaYaw, deltaPitch)) return;
    this.yaw += deltaYaw;
    this.pitch = clamp(this.pitch + deltaPitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  orbitAround(deltaYaw: number, deltaPitch: number, pivot: KernelWorldPoint): void {
    if (this.isOrthographicView() || !finite(deltaYaw, deltaPitch) || !finitePoint(pivot)) return;
    const effectivePitch = clamp(this.pitch + deltaPitch, -PITCH_LIMIT, PITCH_LIMIT) - this.pitch;
    const right: Vec3 = [Math.cos(this.yaw), Math.sin(this.yaw), 0];
    const relative = subtract(this.target, vector(pivot));
    const pitched = rotateAroundAxis(relative, right, -effectivePitch);
    const rotated = rotateAroundAxis(pitched, [0, 0, 1], deltaYaw);
    this.target = add(vector(pivot), rotated);
    this.yaw += deltaYaw;
    this.pitch += effectivePitch;
  }

  panPixels(deltaX: number, deltaY: number): void {
    if (!finite(deltaX, deltaY)) return;
    const basis = this.basis();
    const worldPerPixel = this.isOrthographicView()
      ? this.orthographicSpan / this.height
      : (2 * Math.tan(this.verticalFovRadians / 2) * this.distance) / this.height;
    this.target = add(
      this.target,
      add(scale(basis.right, -deltaX * worldPerPixel), scale(basis.up, deltaY * worldPerPixel)),
    );
  }

  /** Keeps a drag-start world point exactly beneath the current pointer NDC. */
  panAnchorToPointer(anchor: KernelWorldPoint, ndcX: number, ndcY: number): boolean {
    if (!finitePoint(anchor) || !finite(ndcX, ndcY)) return false;
    const safeX = clamp(ndcX, -3, 3);
    const safeY = clamp(ndcY, -3, 3);
    const eye = this.eye();
    const basis = this.basis();
    let rayOrigin = eye;
    let rayDirection = basis.forward;
    if (this.isOrthographicView()) {
      rayOrigin = add(
        eye,
        add(
          scale(basis.right, (safeX * this.orthographicSpan * this.width) / this.height / 2),
          scale(basis.up, (safeY * this.orthographicSpan) / 2),
        ),
      );
    } else {
      const tangent = Math.tan(this.verticalFovRadians / 2);
      rayDirection = normalize(
        add(
          basis.forward,
          add(
            scale(basis.right, (safeX * tangent * this.width) / this.height),
            scale(basis.up, safeY * tangent),
          ),
        ),
      );
    }
    const denominator = dot(rayDirection, basis.forward);
    if (Math.abs(denominator) <= Number.EPSILON) return false;
    const distance = dot(subtract(vector(anchor), rayOrigin), basis.forward) / denominator;
    if (!Number.isFinite(distance)) return false;
    const hit = add(rayOrigin, scale(rayDirection, distance));
    this.target = add(this.target, subtract(vector(anchor), hit));
    return true;
  }

  zoom(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    if (this.isOrthographicView()) {
      this.orthographicSpan = clampDistance(this.orthographicSpan * factor);
    } else this.distance = clampDistance(this.distance * factor);
  }

  zoomAt(factor: number, anchor: KernelWorldPoint): void {
    if (!Number.isFinite(factor) || factor <= 0 || !finitePoint(anchor)) return;
    const previous = this.isOrthographicView() ? this.orthographicSpan : this.distance;
    const next = clampDistance(previous * factor);
    if (next === previous) return;
    const applied = next / previous;
    this.target = add(vector(anchor), scale(subtract(this.target, vector(anchor)), applied));
    if (this.isOrthographicView()) this.orthographicSpan = next;
    else this.distance = next;
  }

  frame(minimum: KernelWorldPoint, maximum: KernelWorldPoint): void {
    if (!finitePoint(minimum) || !finitePoint(maximum)) return;
    const minimumVector = vector(minimum);
    const maximumVector = vector(maximum);
    this.target = scale(add(minimumVector, maximumVector), 0.5);
    const diagonalVector = subtract(maximumVector, minimumVector);
    const diagonal = length(diagonalVector);
    this.distance = clampDistance(Math.max(1, diagonal * 1.2));
    if (this.isOrthographicView()) {
      const basis = this.basis();
      const halfExtents: Vec3 = diagonalVector.map((value) => Math.abs(value) / 2) as Vec3;
      const projectedExtent = (axis: Vec3): number =>
        2 *
        (Math.abs(axis[0]) * halfExtents[0] +
          Math.abs(axis[1]) * halfExtents[1] +
          Math.abs(axis[2]) * halfExtents[2]);
      const verticalExtent = projectedExtent(basis.up);
      const horizontalExtent = projectedExtent(basis.right);
      this.orthographicSpan = clampDistance(
        Math.max(1, verticalExtent * 1.2, (horizontalExtent * 1.2) / (this.width / this.height)),
      );
    }
  }

  /** Commits a mode change and returns endpoints for the Rust matrix morph. */
  setLockedTopDown(enabled: boolean): KernelCameraTransitionPair | null {
    if (enabled && this.lockedTopDown) return null;
    if (!enabled && !this.lockedTopDown) return null;
    const from = this.worldCamera();
    if (enabled) {
      this.restoreLocalPerspective();
      this.savedOrbit = { yaw: this.yaw, pitch: this.pitch, distance: this.distance };
      this.orthographicSpan = 2 * this.distance * Math.tan(this.verticalFovRadians / 2);
      this.lockedTopDown = true;
    } else {
      this.yaw = this.savedOrbit.yaw;
      this.pitch = this.savedOrbit.pitch;
      // Preserve the target-plane scale changed by orthographic zoom. Restoring
      // the entry distance would visibly jump when the projection morph ends.
      this.distance = clampDistance(
        this.orthographicSpan / (2 * Math.tan(this.verticalFovRadians / 2)),
      );
      this.lockedTopDown = false;
    }
    return { from, to: this.worldCamera() };
  }

  /** Sets an exact user-authored Z-up perspective standpoint and look target. */
  setPerspectiveViewpoint(viewpoint: KernelPerspectiveViewpoint): KernelCameraTransitionPair {
    if (!finitePoint(viewpoint.eye) || !finitePoint(viewpoint.target)) {
      throw new RangeError('perspective viewpoint eye and target must be finite');
    }
    const relative = subtract(vector(viewpoint.eye), vector(viewpoint.target));
    const distance = length(relative);
    if (distance < MIN_DISTANCE || distance > MAX_DISTANCE) {
      throw new RangeError('perspective viewpoint eye and target must be distinct and supported');
    }
    const pitch = Math.asin(clamp(relative[2] / distance, -1, 1));
    if (Math.abs(pitch) > PITCH_LIMIT) {
      throw new RangeError('perspective viewpoint is too close to the Z-up singularity');
    }
    const verticalFovRadians = viewpoint.verticalFovRadians ?? this.verticalFovRadians;
    if (
      !Number.isFinite(verticalFovRadians) ||
      verticalFovRadians < 1e-3 ||
      verticalFovRadians > Math.PI - 1e-3
    ) {
      throw new RangeError('perspective viewpoint vertical FOV is outside the supported range');
    }
    const from = this.worldCamera();
    this.restoreLocalPerspective();
    this.lockedTopDown = false;
    this.target = vector(viewpoint.target);
    this.yaw = Math.atan2(relative[0], -relative[1]);
    this.pitch = pitch;
    this.distance = distance;
    this.verticalFovRadians = verticalFovRadians;
    this.savedOrbit = { yaw: this.yaw, pitch: this.pitch, distance: this.distance };
    return { from, to: this.worldCamera() };
  }

  /**
   * Enters or replaces an arbitrary plane-local orthographic view. The first
   * entry captures the complete perspective camera restored by
   * `clearLocalOrthographicFrame`, independently of local pan and zoom.
   */
  setLocalOrthographicFrame(frame: KernelLocalOrthographicViewFrame): KernelCameraTransitionPair {
    const validated = validateLocalOrthographicFrame(frame);
    const from = this.worldCamera();
    if (this.localOrthographic === null) {
      if (this.lockedTopDown) {
        this.localReturn = {
          target: copy(this.target),
          yaw: this.savedOrbit.yaw,
          pitch: this.savedOrbit.pitch,
          distance: clampDistance(
            this.orthographicSpan / (2 * Math.tan(this.verticalFovRadians / 2)),
          ),
        };
      } else {
        this.localReturn = this.orbitState();
      }
    }
    this.lockedTopDown = false;
    this.target = validated.origin;
    this.localOrthographic = { normal: validated.normal, up: validated.up };
    this.orthographicSpan = validated.verticalSpan;
    return { from, to: this.worldCamera() };
  }

  /** Restores the exact perspective camera captured on first local-frame entry. */
  clearLocalOrthographicFrame(): KernelCameraTransitionPair | null {
    if (this.localOrthographic === null || this.localReturn === null) return null;
    const from = this.worldCamera();
    this.restoreLocalPerspective();
    return { from, to: this.worldCamera() };
  }

  /** True for locked top-down and arbitrary local orthographic camera views. */
  isOrthographicView(): boolean {
    return this.lockedTopDown || this.localOrthographic !== null;
  }

  recommendedFloatingOrigin(gridSize = 1_024): readonly [number, number, number] {
    if (!Number.isFinite(gridSize) || gridSize <= 0) {
      throw new RangeError('floating-origin gridSize must be positive and finite');
    }
    return this.target.map((coordinate) => Math.round(coordinate / gridSize) * gridSize) as Vec3;
  }

  private eye(): Vec3 {
    if (this.localOrthographic) {
      return add(this.target, scale(this.localOrthographic.normal, this.distance));
    }
    if (this.lockedTopDown) return add(this.target, [0, 0, this.distance]);
    const horizontal = this.distance * Math.cos(this.pitch);
    return add(this.target, [
      horizontal * Math.sin(this.yaw),
      -horizontal * Math.cos(this.yaw),
      this.distance * Math.sin(this.pitch),
    ]);
  }

  private basis(): { readonly forward: Vec3; readonly right: Vec3; readonly up: Vec3 } {
    const forward = normalize(subtract(this.target, this.eye()));
    const authoredUp: Vec3 =
      this.localOrthographic?.up ?? (this.lockedTopDown ? [0, 1, 0] : [0, 0, 1]);
    const right = normalize(cross(forward, authoredUp));
    return { forward, right, up: normalize(cross(right, forward)) };
  }

  private orbitState(): OrbitState {
    return {
      target: copy(this.target),
      yaw: this.yaw,
      pitch: this.pitch,
      distance: this.distance,
    };
  }

  private restoreLocalPerspective(): void {
    if (this.localOrthographic === null) return;
    const saved = this.localReturn;
    this.localOrthographic = null;
    this.localReturn = null;
    if (!saved) return;
    this.target = copy(saved.target);
    this.yaw = saved.yaw;
    this.pitch = saved.pitch;
    this.distance = saved.distance;
  }
}

function validateLocalOrthographicFrame(frame: KernelLocalOrthographicViewFrame): {
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly up: Vec3;
  readonly verticalSpan: number;
} {
  if (!finitePoint(frame.origin) || !finiteVector(frame.normal) || !finiteVector(frame.up)) {
    throw new RangeError('local orthographic frame coordinates must be finite');
  }
  if (
    !Number.isFinite(frame.verticalSpan) ||
    frame.verticalSpan < MIN_DISTANCE ||
    frame.verticalSpan > MAX_DISTANCE
  ) {
    throw new RangeError('local orthographic verticalSpan is outside the supported finite range');
  }
  const normal = vector(frame.normal);
  const up = vector(frame.up);
  if (
    Math.abs(length(normal) - 1) > ORTHONORMAL_TOLERANCE ||
    Math.abs(length(up) - 1) > ORTHONORMAL_TOLERANCE ||
    Math.abs(dot(normal, up)) > ORTHONORMAL_TOLERANCE
  ) {
    throw new RangeError('local orthographic normal and up must be orthonormal unit vectors');
  }
  return {
    origin: vector(frame.origin),
    normal,
    up,
    verticalSpan: frame.verticalSpan,
  };
}

function positiveExtent(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function clampDistance(value: number): number {
  return clamp(value, MIN_DISTANCE, MAX_DISTANCE);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(...values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

function finitePoint(value: KernelWorldPoint): boolean {
  return finite(value.x, value.y, value.z);
}

function finiteVector(value: KernelCameraVector): boolean {
  return finite(value.x, value.y, value.z);
}

function vector(value: KernelCameraVector): Vec3 {
  return [value.x, value.y, value.z];
}

function copy(value: Vec3): Vec3 {
  return [value[0], value[1], value[2]];
}

function point(value: Vec3): KernelWorldPoint {
  return { x: value[0], y: value[1], z: value[2] };
}

function add(left: Vec3, right: Vec3): Vec3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale(value: Vec3, factor: number): Vec3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function length(value: Vec3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

function normalize(value: Vec3): Vec3 {
  const magnitude = length(value);
  return magnitude > Number.EPSILON ? scale(value, 1 / magnitude) : [0, 0, 0];
}

function rotateAroundAxis(value: Vec3, axis: Vec3, angle: number): Vec3 {
  const unit = normalize(axis);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return add(
    add(scale(value, cosine), scale(cross(unit, value), sine)),
    scale(unit, dot(unit, value) * (1 - cosine)),
  );
}
