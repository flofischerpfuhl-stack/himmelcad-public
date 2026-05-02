import { PerspectiveCamera, Vector3 } from 'three';

/**
 * Orbit-style camera controller with a permanent world-Z up axis. We avoid
 * three.js' default Y-up orbit by storing yaw/pitch around Z and constructing
 * the camera basis ourselves on every update.
 *
 * INVARIANT: Z is world-up. Importers/converters must satisfy this; the camera
 * must never compensate for non-Z-up data.
 */
export class CameraController {
  readonly camera: PerspectiveCamera;
  readonly target = new Vector3();
  private yaw = 0;
  private pitch = -Math.PI / 4;
  private distance = 50;

  constructor(width: number, height: number) {
    this.camera = new PerspectiveCamera(50, width / height, 0.1, 1e7);
    this.update();
  }

  setViewportSize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  orbit(deltaYaw: number, deltaPitch: number): void {
    this.yaw += deltaYaw;
    const limit = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch + deltaPitch));
    this.update();
  }

  pan(deltaX: number, deltaY: number): void {
    const right = new Vector3(Math.cos(this.yaw), Math.sin(this.yaw), 0);
    const forwardXY = new Vector3(-Math.sin(this.yaw), Math.cos(this.yaw), 0);
    this.target.addScaledVector(right, deltaX);
    this.target.addScaledVector(forwardXY, deltaY);
    this.update();
  }

  zoom(factor: number): void {
    this.distance = Math.max(0.01, Math.min(1e7, this.distance * factor));
    this.update();
  }

  frame(min: Vector3, max: Vector3): void {
    this.target.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    const size = new Vector3().subVectors(max, min).length();
    this.distance = Math.max(1, size * 1.2);
    this.update();
  }

  private update(): void {
    const cp = Math.cos(this.pitch);
    const offset = new Vector3(
      this.distance * cp * Math.sin(this.yaw),
      -this.distance * cp * Math.cos(this.yaw),
      this.distance * Math.sin(this.pitch),
    );
    this.camera.position.copy(this.target).add(offset);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(this.target);
  }
}
