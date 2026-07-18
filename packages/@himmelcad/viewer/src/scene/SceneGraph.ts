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
   * Setting and locking are separate: an empty PhotoLab project may first
   * publish a placeholder offset and replace it when its reference frame is
   * established. The viewport locks only when real render geometry is added.
   */
  setRenderOffset(x: number, y: number, z: number): [number, number, number] {
    if (this.renderOffsetLocked) return this.getRenderOffset();
    if (![x, y, z].every(Number.isFinite)) return this.getRenderOffset();
    this.renderOffset = [x, y, z];
    return this.getRenderOffset();
  }

  lockRenderOffset(): void {
    this.renderOffsetLocked = true;
  }

  /** Start a new project reference frame after the previous scene was cleared. */
  resetRenderOffset(x: number, y: number, z: number): [number, number, number] {
    if (![x, y, z].every(Number.isFinite)) return this.getRenderOffset();
    this.renderOffsetLocked = false;
    this.renderOffset = [x, y, z];
    return this.getRenderOffset();
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
