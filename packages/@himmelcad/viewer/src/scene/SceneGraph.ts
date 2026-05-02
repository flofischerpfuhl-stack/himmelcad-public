import { Group, Scene } from 'three';

import type { Layer } from './Layer.js';

/**
 * Owns the three.js Scene and the registered Layers. The render-offset is
 * applied as a single root translation so that f64 world coordinates can be
 * authored upstream and rendered with f32 precision here.
 */
export class SceneGraph {
  readonly scene: Scene;
  readonly root: Group;
  private layers = new Map<string, Layer>();

  constructor() {
    this.scene = new Scene();
    this.root = new Group();
    this.root.name = 'hc:root';
    this.scene.add(this.root);
  }

  setRenderOffset(x: number, y: number, z: number): void {
    this.root.position.set(-x, -y, -z);
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
}
