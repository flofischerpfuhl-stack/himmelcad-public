import { Group, Scene } from 'three';

import type { Layer } from './Layer.js';

/**
 * Owns the three.js Scene and the registered Layers.
 *
 * COORDINATE SYSTEM CONTRACT:
 *   - Layer object3d positions are *render-local* (already shifted by
 *     `renderOffset` upstream during import). The scene root therefore stays
 *     at the origin: rendering in local coordinates is what gives us f32
 *     precision over world-scale (UTM-like) inputs.
 *   - `renderOffset` is recorded so callers can convert a render-local
 *     position back to world coordinates (`world = local + renderOffset`).
 *
 * INVARIANT: never set `root.position` to a non-zero value — that would
 *   double-subtract the offset and put all geometry millions of metres away
 *   from the camera.
 */
export class SceneGraph {
  readonly scene: Scene;
  readonly root: Group;
  private layers = new Map<string, Layer>();
  private renderOffset: [number, number, number] = [0, 0, 0];
  private renderOffsetLocked = false;

  constructor() {
    this.scene = new Scene();
    this.root = new Group();
    this.root.name = 'hc:root';
    this.scene.add(this.root);
  }

  /**
   * Record the render offset (world coordinate corresponding to local zero).
   * Idempotent — only the FIRST call wins, so all subsequent imports stay in
   * the same local frame as the first one.
   */
  setRenderOffset(x: number, y: number, z: number): void {
    if (this.renderOffsetLocked) return;
    this.renderOffset = [x, y, z];
    this.renderOffsetLocked = true;
  }

  getRenderOffset(): [number, number, number] {
    return [this.renderOffset[0], this.renderOffset[1], this.renderOffset[2]];
  }

  addLayer(layer: Layer): void {
    if (this.layers.has(layer.id)) {
      throw new Error(`Layer already registered: ${layer.id}`);
    }
    this.layers.set(layer.id, layer);
    this.root.add(layer.object3d);
  }

  removeLayer(id: string): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    this.root.remove(layer.object3d);
    layer.dispose();
    this.layers.delete(id);
  }

  hasLayer(id: string): boolean {
    return this.layers.has(id);
  }

  *iterLayers(): IterableIterator<Layer> {
    for (const l of this.layers.values()) yield l;
  }

  iterLayerCount(): number {
    return this.layers.size;
  }
}
