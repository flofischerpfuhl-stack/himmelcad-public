import { BufferAttribute, BufferGeometry, Color, Points, PointsMaterial } from 'three';

import type { EntityId } from '@himmelcad/data';

import type { PointOctree } from '../spatial/PointOctree.js';
import type { Layer } from './Layer.js';

export interface CacheLayout {
  stride_bytes: number;
  xyz_offset: number;
  color_offset: number | null;
  intensity_offset: number | null;
}

export interface PointCloudData {
  positions: Float32Array;
  colors: Uint8Array | null;
}

/**
 * Decodes the binary `.points` cache produced by himmelcad-io into a
 * Three.js Points object. The cache layout is described in
 * `crates/himmelcad-io/src/las_import.rs`.
 *
 * Coordinates are already expressed relative to the file's render-offset
 * (bounds-min); the SceneGraph applies the offset as a single root
 * translation so f32 precision survives world-scale point clouds.
 */
export class PointCloudLayer implements Layer {
  readonly id: string;
  readonly entityId: EntityId;
  readonly object3d: Points;
  readonly pointCount: number;
  readonly positions: Float32Array;
  /**
   * Spatial index for cursor snap and (later) GPU pick refinement. May be
   * null briefly while it is being built or fetched; consumers must guard.
   * The octree's positions slice MUST be the same `positions` buffer as the
   * layer's, in the same point order.
   */
  octree: PointOctree | null = null;
  private geometry: BufferGeometry;
  private material: PointsMaterial;

  constructor(
    entityId: EntityId,
    pointCount: number,
    data: PointCloudData,
    options: { pointSize?: number; defaultColor?: number } = {},
  ) {
    this.id = `pc:${entityId}`;
    this.entityId = entityId;
    this.pointCount = pointCount;
    this.positions = data.positions;

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(data.positions, 3));

    let vertexColors = false;
    const colors = data.colors;
    if (colors) {
      const float = new Float32Array(pointCount * 3);
      for (let i = 0; i < pointCount; i++) {
        float[i * 3] = (colors[i * 3] ?? 0) / 255;
        float[i * 3 + 1] = (colors[i * 3 + 1] ?? 0) / 255;
        float[i * 3 + 2] = (colors[i * 3 + 2] ?? 0) / 255;
      }
      this.geometry.setAttribute('color', new BufferAttribute(float, 3));
      vertexColors = true;
    }
    this.geometry.computeBoundingSphere();

    this.material = new PointsMaterial({
      size: options.pointSize ?? 1.5,
      sizeAttenuation: false,
      vertexColors,
      color: vertexColors ? 0xffffff : new Color(options.defaultColor ?? 0xbcbec4),
    });

    this.object3d = new Points(this.geometry, this.material);
    this.object3d.name = this.id;
    this.object3d.frustumCulled = true;
  }

  setVisible(visible: boolean): void {
    this.object3d.visible = visible;
  }

  setPointSize(size: number): void {
    this.material.size = size;
  }

  setOctree(octree: PointOctree): void {
    this.octree = octree;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.octree = null;
  }
}

/**
 * Decode a binary `.points` cache buffer (described by `layout`) into the
 * Float32Array (XYZ) and optional Uint8Array (RGB) the layer constructor
 * expects.
 */
export function decodePointCache(
  buffer: ArrayBuffer,
  layout: CacheLayout,
): { pointCount: number; data: PointCloudData } {
  const view = new DataView(buffer);
  const stride = layout.stride_bytes;
  const pointCount = Math.floor(buffer.byteLength / stride);
  const positions = new Float32Array(pointCount * 3);
  const colors =
    layout.color_offset !== null && layout.color_offset !== undefined
      ? new Uint8Array(pointCount * 3)
      : null;

  for (let i = 0; i < pointCount; i++) {
    const base = i * stride;
    positions[i * 3] = view.getFloat32(base + layout.xyz_offset, true);
    positions[i * 3 + 1] = view.getFloat32(base + layout.xyz_offset + 4, true);
    positions[i * 3 + 2] = view.getFloat32(base + layout.xyz_offset + 8, true);
    if (colors && layout.color_offset != null) {
      const co = base + layout.color_offset;
      colors[i * 3] = view.getUint8(co);
      colors[i * 3 + 1] = view.getUint8(co + 1);
      colors[i * 3 + 2] = view.getUint8(co + 2);
    }
  }
  return { pointCount, data: { positions, colors } };
}
