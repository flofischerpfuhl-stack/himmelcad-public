import { PerspectiveCamera, Plane, Quaternion, Ray, Vector3 } from 'three';

/**
 * Orbit-style camera controller with a permanent world-Z up axis. We avoid
 * three.js' default Y-up orbit by storing yaw/pitch around Z and constructing
 * the camera basis ourselves on every update.
 *
 * INVARIANT: Z is world-up. Importers/converters must satisfy this; the camera
 * must never compensate for non-Z-up data.
 *
 * Convention:
 *   yaw   = 0  → camera south of target, looking +Y (north).
 *   pitch = 0  → looking horizontally; +π/2 → straight down (camera above).
 *   pitch +    → camera above target.
 *   pitch −    → camera below target.
 *
 * Orbit + zoom pivot (CAD-style):
 *   The default `orbit` / `zoom` methods rotate / scale around the current
 *   `target`. CAD UX wants the *cursor world position* as pivot instead:
 *   `orbitAround(dy, dp, pivot)` rotates BOTH cameraPos and target around
 *   `pivot` — preserving the camera→target direction and therefore the
 *   pixel where `pivot` lands. `zoomAt(factor, anchor)` scales `target`
 *   and `distance` so `anchor` stays stable in screen space.
 *
 *   Critically: there is NO "set pivot then rotate" two-step. The pivot
 *   is supplied per orbit operation and never written back into `target`.
 *   Setting `target = pivot` would force `lookAt(target)` in `update()` to
 *   re-aim the camera, swinging the cursor point to the screen centre —
 *   which is a hard no-op visually. Always rotate around the pivot, but
 *   keep `target` as the point the camera *looks at*.
 */
const SCRATCH_QUAT = new Quaternion();
const SCRATCH_YAW_QUAT = new Quaternion();
const SCRATCH_PITCH_QUAT = new Quaternion();
const SCRATCH_RIGHT_AXIS = new Vector3();
const SCRATCH_WORLD_UP = new Vector3(0, 0, 1);
const SCRATCH_NEW_T = new Vector3();
const SCRATCH_SCREEN_RIGHT = new Vector3();
const SCRATCH_SCREEN_UP = new Vector3();
const SCRATCH_VIEW_DIR = new Vector3();
const SCRATCH_PAN_PLANE = new Plane();
const SCRATCH_PAN_RAY = new Ray();
const SCRATCH_PAN_NDC = new Vector3();
const SCRATCH_PAN_HIT = new Vector3();
const SCRATCH_PAN_DELTA = new Vector3();
const MIN_DISTANCE = 1e-5;
const MAX_DISTANCE = 1e8;
const MIN_NEAR = 1e-5;
const MAX_POINTER_NDC = 3;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

export class CameraController {
  readonly camera: PerspectiveCamera;
  readonly target = new Vector3();
  private readonly lastGoodTarget = new Vector3();
  private readonly lastGoodCameraPosition = new Vector3();
  private yaw = 0;
  private pitch = Math.PI / 4; // 45° from above
  private distance = 50;
  private viewportHeight = 1;
  private lastGoodYaw = 0;
  private lastGoodPitch = Math.PI / 4;
  private lastGoodDistance = 50;
  private lockedTopDown = false;

  constructor(width: number, height: number) {
    this.viewportHeight = Math.max(1, height);
    this.camera = new PerspectiveCamera(50, width / height, 0.01, MAX_DISTANCE);
    this.update();
  }

  setViewportSize(width: number, height: number): void {
    this.viewportHeight = Math.max(1, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setLockedTopDown(enabled: boolean): void {
    this.lockedTopDown = enabled;
    this.update();
  }

  orbit(deltaYaw: number, deltaPitch: number): void {
    this.yaw += deltaYaw;
    this.pitch = clampFinite(this.pitch + deltaPitch, -PITCH_LIMIT, PITCH_LIMIT, this.pitch);
    this.update();
  }

  /**
   * CAD-style orbit: rotate both camera position AND target around `pivot`
   * (a scene-space point) by (`deltaYaw` around world Z, `deltaPitch` around
   * the current camera-right axis). Standard scale-about-point applied to
   * a rotation:
   *
   *   newCameraPos = pivot + ΔR · (oldCameraPos − pivot)
   *   newTarget    = pivot + ΔR · (oldTarget    − pivot)
   *
   * Because both endpoints rotate with the same ΔR, the camera→target
   * direction (and therefore the view orientation) is preserved up to the
   * rotation, and the world point `pivot` projects to the same screen
   * pixel after the rotation as before. Rhino / SketchUp / Inventor feel.
   *
   * SIGN CONVENTION (matches `orbit`):
   *   positive `deltaYaw`   → camera rotates CCW around world-Z (look right→left).
   *   positive `deltaPitch` → camera tilts UP (looks more steeply downward).
   * The Rodrigues rotation around the +right axis would tilt the camera
   * DOWN for positive angles, so we feed `−deltaPitch` into the pitch
   * quaternion to align the convention.
   *
   * NO POST-HOC RE-DERIVATION. The rotation we apply changes the camera's
   * (yaw, pitch, distance) state by exactly (`deltaYaw`, `effectiveDeltaPitch`,
   * 0): yaw and pitch increment by the input deltas, distance is preserved
   * by the rotation. We update those scalars directly, then `update()`
   * reconstructs camera position from `target + offset(yaw,pitch,distance)`,
   * which is bit-for-bit equivalent to the rotated camera position. This
   * avoids the asin/atan2 round-trip that previously produced a clamp-
   * snap flicker near the polar singularity.
   *
   * PITCH CLAMP IS PRE-COMPUTED. We trim `deltaPitch` so the resulting
   * pitch lands inside [-limit, +limit] *before* applying the rotation;
   * we never rotate past the pole and then snap back. The user's drag
   * stalls smoothly at ±90°, exactly like `orbit`.
   */
  orbitAround(deltaYaw: number, deltaPitch: number, pivot: Vector3): void {
    let effectiveDeltaPitch = deltaPitch;
    const proposed = this.pitch + deltaPitch;
    if (proposed > PITCH_LIMIT) effectiveDeltaPitch = PITCH_LIMIT - this.pitch;
    else if (proposed < -PITCH_LIMIT) effectiveDeltaPitch = -PITCH_LIMIT - this.pitch;
    if (!isFiniteVector(pivot)) return;

    // Build ΔR = Yaw_world ∘ Pitch_local. Pitch first (in the pre-yaw
    // camera-right axis), then yaw around world Z, so up/down dragging
    // tilts intuitively regardless of compass direction.
    SCRATCH_RIGHT_AXIS.set(Math.cos(this.yaw), Math.sin(this.yaw), 0);
    SCRATCH_PITCH_QUAT.setFromAxisAngle(SCRATCH_RIGHT_AXIS, -effectiveDeltaPitch);
    SCRATCH_YAW_QUAT.setFromAxisAngle(SCRATCH_WORLD_UP, deltaYaw);
    SCRATCH_QUAT.copy(SCRATCH_YAW_QUAT).multiply(SCRATCH_PITCH_QUAT);

    // Only target needs explicit rotation; camera position is reconstructed
    // by `update()`. The (yaw, pitch, distance) increments below match the
    // rotation analytically (see proof in commit message), so reconstruction
    // is identical to `pivot + ΔR·(oldCameraPos − pivot)`.
    SCRATCH_NEW_T.copy(this.target).sub(pivot).applyQuaternion(SCRATCH_QUAT).add(pivot);
    this.target.copy(SCRATCH_NEW_T);

    this.yaw += deltaYaw;
    this.pitch += effectiveDeltaPitch;
    this.update();
  }

  panPixels(deltaX: number, deltaY: number): void {
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    this.camera.updateMatrixWorld();
    SCRATCH_SCREEN_RIGHT.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    SCRATCH_SCREEN_UP.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    const worldPerPixel =
      (2 * Math.tan((this.camera.fov * Math.PI) / 360) * this.distance) / this.viewportHeight;
    this.target.addScaledVector(SCRATCH_SCREEN_RIGHT, -deltaX * worldPerPixel);
    this.target.addScaledVector(SCRATCH_SCREEN_UP, deltaY * worldPerPixel);
    this.update();
  }

  /**
   * Cursor-anchored pan. `anchor` is the scene-space point captured when the
   * drag starts; `ndcX/Y` is the current pointer position. We translate camera
   * and target so the anchor projects exactly to the current pointer pixel.
   */
  panAnchorToPointer(anchor: Vector3, ndcX: number, ndcY: number): boolean {
    if (!isFiniteVector(anchor)) return false;
    const safeNdcX = clampFinite(ndcX, -MAX_POINTER_NDC, MAX_POINTER_NDC, 0);
    const safeNdcY = clampFinite(ndcY, -MAX_POINTER_NDC, MAX_POINTER_NDC, 0);
    this.camera.updateMatrixWorld();
    this.camera.getWorldDirection(SCRATCH_VIEW_DIR);
    SCRATCH_PAN_PLANE.setFromNormalAndCoplanarPoint(SCRATCH_VIEW_DIR, anchor);
    SCRATCH_PAN_NDC.set(safeNdcX, safeNdcY, 0.5).unproject(this.camera);
    SCRATCH_PAN_RAY.origin.copy(this.camera.position);
    SCRATCH_PAN_RAY.direction.copy(SCRATCH_PAN_NDC).sub(this.camera.position).normalize();
    const hit = SCRATCH_PAN_RAY.intersectPlane(SCRATCH_PAN_PLANE, SCRATCH_PAN_HIT);
    if (!hit) return false;
    SCRATCH_PAN_DELTA.copy(anchor).sub(hit);
    this.target.add(SCRATCH_PAN_DELTA);
    this.update();
    return true;
  }

  /**
   * Multiplicative zoom around the current `target`. Use `zoomAt` for
   * cursor-anchored CAD-style zoom; this method is a fallback for when no
   * cursor pivot is available.
   */
  zoom(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.distance = clampDistance(this.distance * factor);
    this.update();
  }

  /**
   * CAD-style zoom: scale `distance` by `factor` while keeping `anchor`
   * (a scene-space point) at its current screen position. Implementation:
   * scale-about-anchor on both camera-position and target.
   *
   *   newCameraPos = anchor + (oldCameraPos - anchor) * factor
   *   newTarget    = anchor + (oldTarget    - anchor) * factor
   *
   * This preserves the camera→target direction and scales the camera→anchor
   * vector by the same factor, so `anchor`'s screen-space NDC stays put.
   * Distance is clamped; the actually-applied factor is recomputed against
   * the clamp so we don't accidentally drift the anchor when we hit a limit.
   */
  zoomAt(factor: number, anchor: Vector3): void {
    if (!Number.isFinite(factor) || factor <= 0 || !isFiniteVector(anchor)) return;
    const newDistance = clampDistance(this.distance * factor);
    if (newDistance === this.distance) return;
    const actualFactor = newDistance / this.distance;
    // We only need to translate `target`; camera position is derived in
    // `update()` from target + offset(yaw, pitch, distance). Scaling
    // distance by `actualFactor` and target by the same factor about the
    // anchor reproduces the scale-about-anchor for camera position too.
    this.target.sub(anchor).multiplyScalar(actualFactor).add(anchor);
    this.distance = newDistance;
    this.update();
  }

  frame(min: Vector3, max: Vector3): void {
    if (!isFiniteVector(min) || !isFiniteVector(max)) return;
    this.target.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    const size = new Vector3().subVectors(max, min).length();
    this.distance = clampDistance(Math.max(1, size * 1.2));
    this.update();
  }

  private update(): void {
    if (
      !isFiniteVector(this.target) ||
      !Number.isFinite(this.yaw) ||
      !Number.isFinite(this.pitch) ||
      !Number.isFinite(this.distance)
    ) {
      this.restoreLastGood();
      return;
    }
    this.pitch = clampFinite(this.pitch, -PITCH_LIMIT, PITCH_LIMIT, this.lastGoodPitch);
    this.distance = clampDistance(this.distance);
    const cp = Math.cos(this.pitch);
    const offset = this.lockedTopDown
      ? new Vector3(0, 0, this.distance)
      : new Vector3(
          this.distance * cp * Math.sin(this.yaw),
          -this.distance * cp * Math.cos(this.yaw),
          this.distance * Math.sin(this.pitch),
        );
    if (!isFiniteVector(offset)) {
      this.restoreLastGood();
      return;
    }
    this.camera.position.copy(this.target).add(offset);
    if (!isFiniteVector(this.camera.position)) {
      this.restoreLastGood();
      return;
    }
    this.camera.up.set(0, this.lockedTopDown ? 1 : 0, this.lockedTopDown ? 0 : 1);
    this.camera.lookAt(this.target);
    const near = Math.max(MIN_NEAR, Math.min(10, this.distance / 10_000));
    const far = Math.max(1_000_000, Math.min(MAX_DISTANCE, this.distance * 10_000));
    if (Math.abs(this.camera.near - near) > 1e-9 || Math.abs(this.camera.far - far) > 1e-3) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.lastGoodTarget.copy(this.target);
    this.lastGoodCameraPosition.copy(this.camera.position);
    this.lastGoodYaw = this.yaw;
    this.lastGoodPitch = this.pitch;
    this.lastGoodDistance = this.distance;
  }

  private restoreLastGood(): void {
    this.target.copy(this.lastGoodTarget);
    this.yaw = this.lastGoodYaw;
    this.pitch = this.lastGoodPitch;
    this.distance = this.lastGoodDistance;
    this.camera.position.copy(this.lastGoodCameraPosition);
    this.camera.up.set(0, this.lockedTopDown ? 1 : 0, this.lockedTopDown ? 0 : 1);
    this.camera.lookAt(this.target);
  }
}

function clampDistance(distance: number): number {
  return clampFinite(distance, MIN_DISTANCE, MAX_DISTANCE, MIN_DISTANCE);
}

function clampFinite(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function isFiniteVector(v: Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
