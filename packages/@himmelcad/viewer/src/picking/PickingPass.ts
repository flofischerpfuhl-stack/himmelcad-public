import { type Camera, Points, Scene, WebGLRenderTarget, type WebGLRenderer } from 'three';

import type { EntityId } from '@himmelcad/data';

import type { PointCloudLayer } from '../scene/PointCloudLayer.js';
import { PointCloudPickMaterial } from './PickMaterial.js';
import type { PickResult } from './PickResult.js';

/**
 * GPU pick orchestrator. Maintains a parallel "pick scene" containing one
 * `Points` per registered layer (sharing the layer's geometry buffer) with
 * a `PointCloudPickMaterial`. The pass is rendered into a small render
 * target every frame (as long as anything is registered); after each render
 * the cursor pixel is read back asynchronously and decoded into a
 * `PickResult` consumed by the snapping service.
 *
 * Cost contract:
 *   - One additional points draw per layer per frame. We accept this for
 *     MVP scale (a handful of layers, each ≤ 8 M points). Future scaling:
 *     skip pick render when pointer is outside the viewport, drop to
 *     30 Hz, or render to a half-resolution target.
 *   - Readback: 1 pixel async via `readRenderTargetPixelsAsync`. Pipelined,
 *     no main-thread stall.
 */
export class PickingPass {
  private renderer: WebGLRenderer;
  private camera: Camera;
  private scene: Scene = new Scene();
  private target: WebGLRenderTarget;
  private targetSize: { width: number; height: number };
  private layers: Map<string, PickLayerEntry> = new Map();
  private drawIdToEntry: Map<number, PickLayerEntry> = new Map();
  private nextDrawId = 1;
  private latest: PickResult | null = null;
  private inflight = false;

  constructor(renderer: WebGLRenderer, camera: Camera, width: number, height: number) {
    this.renderer = renderer;
    this.camera = camera;
    this.targetSize = { width, height };
    this.target = new WebGLRenderTarget(width, height, {
      depthBuffer: true,
      stencilBuffer: false,
    });
    // Three.js doesn't expose the texture format on creation in a clean way
    // across versions; the default (RGBA8 unorm) is what we want.
  }

  resize(width: number, height: number): void {
    if (this.targetSize.width === width && this.targetSize.height === height) return;
    this.targetSize = { width, height };
    this.target.setSize(width, height);
  }

  registerPointCloudLayer(layer: PointCloudLayer): void {
    if (this.layers.has(layer.id)) return;
    if (this.nextDrawId > 255) {
      // Hard limit of the 8-bit drawId channel. Future fix: rotate ids per
      // frame so visible layers always have a valid slot.
      console.warn('[picking] drawId pool exhausted; layer not pickable');
      return;
    }
    const drawId = this.nextDrawId++;
    const material = new PointCloudPickMaterial();
    material.setDrawId(drawId);
    const pickPoints = new Points(layer.object3d.geometry, material);
    pickPoints.position.copy(layer.object3d.position);
    pickPoints.frustumCulled = layer.object3d.frustumCulled;
    pickPoints.name = `${layer.id}:pick`;
    this.scene.add(pickPoints);
    const entry: PickLayerEntry = {
      layerId: layer.id,
      entityId: layer.entityId,
      pickObject: pickPoints,
      material,
      drawId,
      sourceLayer: layer,
    };
    this.layers.set(layer.id, entry);
    this.drawIdToEntry.set(drawId, entry);
  }

  unregisterLayer(layerId: string): void {
    const entry = this.layers.get(layerId);
    if (!entry) return;
    this.scene.remove(entry.pickObject);
    entry.material.dispose();
    this.layers.delete(layerId);
    this.drawIdToEntry.delete(entry.drawId);
  }

  /** Render the pick pass into the offscreen target. Cheap when empty. */
  render(): void {
    if (this.layers.size === 0) return;
    // Sync each pick object's position to its source layer (in case the
    // source moved between frames — first import sets the offset; later
    // imports differ by their layer offset).
    for (const entry of this.layers.values()) {
      entry.pickObject.position.copy(entry.sourceLayer.object3d.position);
      entry.pickObject.visible = entry.sourceLayer.object3d.visible;
    }
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prevTarget);
  }

  /**
   * Read the cursor pixel from the most recent pick render. Async via the
   * three.js PBO path; the promise resolves with the decoded result or null
   * if the cursor is over the background. Re-entrant calls coalesce: only
   * one readback is in flight at a time.
   */
  async readback(clientX: number, clientY: number): Promise<PickResult | null> {
    if (this.inflight) return this.latest;
    if (this.layers.size === 0) {
      this.latest = null;
      return null;
    }
    const px = Math.round(clientX);
    const py = Math.round(this.targetSize.height - clientY);
    if (px < 0 || py < 0 || px >= this.targetSize.width || py >= this.targetSize.height) {
      return this.latest;
    }
    this.inflight = true;
    const buf = new Uint8Array(4);
    try {
      const r = this.renderer as unknown as {
        readRenderTargetPixelsAsync?: (
          rt: WebGLRenderTarget,
          x: number,
          y: number,
          w: number,
          h: number,
          buffer: Uint8Array,
        ) => Promise<Uint8Array>;
      };
      if (r.readRenderTargetPixelsAsync) {
        await r.readRenderTargetPixelsAsync(this.target, px, py, 1, 1, buf);
      } else {
        this.renderer.readRenderTargetPixels(this.target, px, py, 1, 1, buf);
      }
    } finally {
      this.inflight = false;
    }

    const drawId = buf[3] ?? 0;
    if (drawId === 0) {
      this.latest = null;
      return null;
    }
    const entry = this.drawIdToEntry.get(drawId);
    if (!entry) {
      this.latest = null;
      return null;
    }
    const pointIndex = (buf[0] ?? 0) | ((buf[1] ?? 0) << 8) | ((buf[2] ?? 0) << 16);
    this.latest = {
      entityId: entry.entityId,
      datasetKind: 'point-cloud',
      primitive: { kind: 'point', pointIndex },
      pointIndex,
      layerId: entry.layerId,
      cursorClient: { x: clientX, y: clientY },
      timestampMs: performance.now(),
    };
    return this.latest;
  }

  getLatest(): PickResult | null {
    return this.latest;
  }

  /**
   * Read a square `(2*halfPx+1)` window centred on the cursor and return
   * each distinct (layerId, pointIndex) pair found, in order of increasing
   * pixel distance to the centre. Used by snap-hierarchy / Space cycling so
   * the user can step through occluded points and other layers.
   *
   * Synchronous readback. Cheap (small window) but blocks until the GPU
   * catches up; intended for one-off use on Space-key press, not every
   * pointer move.
   */
  readNeighborhood(clientX: number, clientY: number, halfPx: number): NeighborhoodHit[] {
    if (this.layers.size === 0) return [];
    const w = halfPx * 2 + 1;
    const cx = Math.round(clientX);
    const cy = Math.round(clientY);
    const px = Math.max(0, cx - halfPx);
    const py = Math.max(0, this.targetSize.height - cy - halfPx);
    const readW = Math.min(w, this.targetSize.width - px);
    const readH = Math.min(w, this.targetSize.height - py);
    if (readW <= 0 || readH <= 0) return [];
    const buf = new Uint8Array(readW * readH * 4);
    this.renderer.readRenderTargetPixels(this.target, px, py, readW, readH, buf);

    const found = new Map<string, NeighborhoodHit>();
    for (let row = 0; row < readH; row++) {
      for (let col = 0; col < readW; col++) {
        const offset = (row * readW + col) * 4;
        const drawId = buf[offset + 3] ?? 0;
        if (drawId === 0) continue;
        const entry = this.drawIdToEntry.get(drawId);
        if (!entry) continue;
        const pointIndex =
          (buf[offset] ?? 0) | ((buf[offset + 1] ?? 0) << 8) | ((buf[offset + 2] ?? 0) << 16);
        const key = `${entry.layerId}:${pointIndex}`;
        if (found.has(key)) continue;
        // Re-derive the pixel position in window coords for distance ranking.
        const winX = px + col;
        const winY = this.targetSize.height - (py + row);
        const dx = winX - cx;
        const dy = winY - cy;
        found.set(key, {
          entityId: entry.entityId,
          datasetKind: 'point-cloud',
          primitive: { kind: 'point', pointIndex },
          layerId: entry.layerId,
          pointIndex,
          pixelDistance: Math.sqrt(dx * dx + dy * dy),
        });
      }
    }

    return Array.from(found.values()).sort((a, b) => a.pixelDistance - b.pixelDistance);
  }

  dispose(): void {
    for (const entry of this.layers.values()) {
      this.scene.remove(entry.pickObject);
      entry.material.dispose();
    }
    this.layers.clear();
    this.drawIdToEntry.clear();
    this.target.dispose();
  }
}

interface PickLayerEntry {
  layerId: string;
  entityId: EntityId;
  pickObject: Points;
  material: PointCloudPickMaterial;
  drawId: number;
  sourceLayer: PointCloudLayer;
}

export interface NeighborhoodHit {
  entityId: EntityId;
  datasetKind: 'point-cloud';
  primitive: { kind: 'point'; pointIndex: number };
  layerId: string;
  pointIndex: number;
  /** Distance from the cursor in window pixels. */
  pixelDistance: number;
}
