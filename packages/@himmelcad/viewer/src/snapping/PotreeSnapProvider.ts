import { Box3, BufferAttribute, PerspectiveCamera, type Points, Ray, Sphere, Vector3 } from 'three';
import type { PointCloudOctree, PointCloudOctreeNode, PickPoint } from '@himmelcad/three-loader';

import type { EntityId, GeometryTargetRef, SnapResult } from '@himmelcad/data';

import { fitPlane, intersectRayPlane } from '../spatial/planeFit.js';
import type { SnapProvider, SnapQueryInput } from './SnapProvider.js';

/**
 * three-loader-driven cursor provider for streaming point clouds.
 *
 * Two stages, deterministic in this order:
 *
 *   1. **Exact vertex snap**: a scissored GPU pick of the visible nodes
 *      around the cursor (`Potree.pick` via the `pickRay` closure). Returns
 *      the world-space position of the *actual* point under the cursor with
 *      sub-pixel accuracy. Cost: one tiny render + a few-byte readback,
 *      ~0.5–1 ms on a typical desktop GPU. Only fires while the cursor is
 *      over the cloud.
 *
 *   2. **Interpolated surface**: a weighted PCA plane fitted to the k
 *      nearest visible-node points around the cursor anchor (= the exact
 *      hit if stage 1 succeeded, otherwise a depth-derived point along the
 *      ray). The cursor ray is then intersected with that plane. This
 *      keeps the cursor on a smooth surface in gaps between samples and
 *      gives orbit / tool pivots a stable anchor when the GPU pick misses.
 *
 * Performance contract:
 *   - **No global octree walks**. We only ever look at points that
 *     three-loader has already streamed into GPU memory (the visible
 *     nodes), so cost is bounded by `pointBudget` regardless of the
 *     total cloud size (millions vs. billions of points).
 *   - **Bounding-box pre-filter** for k-NN: only nodes whose bounding box
 *     intersects a sphere around the cursor anchor are scanned. Typical
 *     hit count is 1–5 nodes, so per-query work is single-digit ms even
 *     on dense scans.
 *   - **Zero per-query allocations** for the inner loops; we pool the
 *     k-best heap across queries (see `KNN_BUFFER`).
 *
 * Coordinate frames:
 *   - Input ray is in *scene* space (world minus scene render offset).
 *   - The cloud's `position` is the cloud's offset within scene space.
 *   - Visible-node positions live in the cloud's local frame already
 *     because three-loader sets `sceneNode.matrix` from the per-node
 *     offset and we keep the cloud rotation-free. We therefore work in
 *     the cloud-local frame: `localOrigin = ray.origin - cloud.position`,
 *     `localDir = ray.direction`.
 *   - Returned `SnapResult.position` is in absolute world coordinates
 *     (`local + cloud.position + scene render offset`). `localPosition`
 *     is the cloud-local form for downstream tools that prefer it.
 */

const KNN_K = 24;
const WORLD_RADIUS_PIXEL_SLACK = 3.0;
const FALLBACK_DEPTH_HINT = 50;

const RAY_LOCAL_ORIGIN = new Vector3();
const RAY_LOCAL_DIR = new Vector3();
const SCRATCH_LOCAL = new Vector3();
const SCRATCH_SCENE = new Vector3();
const SCRATCH_NDC = new Vector3();
const QUERY_POINT = new Vector3();
const PROJECTED_PREV = new Vector3();
const SCRATCH_PT = new Vector3();
const SCRATCH_PLANE_HIT = new Vector3();
const SCRATCH_NODE_BB_MIN = new Vector3();
const SCRATCH_NODE_BB_MAX = new Vector3();
const SCRATCH_NODE_BB = new Box3();
const SCRATCH_QUERY_SPHERE = new Sphere();

/**
 * k-best buffer reused across queries. Indexed pairs: index i*2 = pointIndex
 * encoded as (nodeIdx<<24 | localIdx), index i*2+1 = distanceSq. We walk it
 * as a flat array to avoid per-query Object allocations.
 */
const KNN_BUFFER = new Float64Array(KNN_K * 2);
const KNN_POINTS: Vector3[] = Array.from({ length: KNN_K }, () => new Vector3());

export interface PotreeSnapAdapter {
  /**
   * Closure into the viewport that performs the GPU pick on demand.
   * Returns null if the ray misses every cloud or the pick is offline.
   * Implementation typically wraps `Potree.pick([cloud], renderer, camera, ray)`.
   */
  pickRay(ray: Ray): PickPoint | null;
  cloud: PointCloudOctree;
  layerId: string;
  entityId: EntityId;
}

export class PotreeSnapProvider implements SnapProvider {
  readonly id: string;

  constructor(private readonly adapter: PotreeSnapAdapter) {
    this.id = `${adapter.layerId}:potree-snap`;
  }

  query(input: SnapQueryInput): readonly SnapResult[] {
    const cloud = this.adapter.cloud;
    if (!cloud.visibleNodes || cloud.visibleNodes.length === 0) return [];
    const camera = input.camera;
    if (!(camera instanceof PerspectiveCamera)) return [];

    // Ray in cloud-local frame. cloud has no rotation in our setup, so the
    // direction is shared and the origin is just translated.
    RAY_LOCAL_ORIGIN.copy(input.ray.origin).sub(cloud.position);
    RAY_LOCAL_DIR.copy(input.ray.direction).normalize();

    const out: SnapResult[] = [];
    let exactHitLocal: Vector3 | null = null;

    // ── Stage 1: GPU pick ────────────────────────────────────────────
    const hit = this.adapter.pickRay(input.ray);
    if (hit && hit.position) {
      // hit.position is in scene space (the picker projects readback into
      // world coordinates of the cloud's three.js scene). Convert to
      // cloud-local for downstream uniform handling.
      SCRATCH_LOCAL.copy(hit.position).sub(cloud.position);
      const distancePx = projectPixelDistance(SCRATCH_LOCAL, cloud.position, input);
      const world = toWorld(SCRATCH_LOCAL, cloud.position, input.sceneRenderOffset);
      const candidateId = encodePickCandidateId(this.adapter.layerId, hit);
      const target = this.pointTarget(hit);
      out.push({
        position: { x: world.x, y: world.y, z: world.z },
        localPosition: { x: SCRATCH_LOCAL.x, y: SCRATCH_LOCAL.y, z: SCRATCH_LOCAL.z },
        kind: 'Point',
        entity: this.adapter.entityId,
        confidence: 0.97,
        source: 'point-cloud',
        ...(target ? { target } : {}),
        distancePx,
        stable: true,
        candidateId,
      });
      exactHitLocal = SCRATCH_LOCAL.clone();
    }

    // ── Stage 2: interpolated surface via k-NN + plane fit ───────────
    const viewportHeight = Math.max(1, input.viewportRect.height);
    const depthHint = estimateDepthHint(input, camera);
    const worldPerPixel = computeWorldPerPixel(camera, depthHint, viewportHeight);
    const queryPoint = chooseQueryPoint(exactHitLocal, RAY_LOCAL_ORIGIN, RAY_LOCAL_DIR, depthHint);
    QUERY_POINT.copy(queryPoint);

    const searchRadius = Math.max(
      worldPerPixel * input.interpolationPixelRadius * WORLD_RADIUS_PIXEL_SLACK,
      worldPerPixel * 4,
    );
    const knnCount = collectVisibleKnn(cloud.visibleNodes, QUERY_POINT, searchRadius, KNN_K);

    if (knnCount >= 3) {
      const points = KNN_POINTS.slice(0, knnCount);
      const weights = new Array<number>(knnCount);
      let sumDistSq = 0;
      for (let i = 0; i < knnCount; i++) {
        const d2 = Math.max(1e-6, KNN_BUFFER[i * 2 + 1] ?? 1);
        weights[i] = 1 / d2;
        if (d2 > sumDistSq) sumDistSq = d2;
      }
      const plane = fitPlane(points, weights);
      if (plane) {
        const localHit = intersectRayPlane(
          RAY_LOCAL_ORIGIN,
          RAY_LOCAL_DIR,
          plane,
          SCRATCH_PLANE_HIT,
        );
        if (localHit) {
          const distancePx = projectPixelDistance(localHit, cloud.position, input);
          if (distancePx <= input.interpolationPixelRadius) {
            const world = toWorld(localHit, cloud.position, input.sceneRenderOffset);
            const neighbourhoodWorldExtent = Math.sqrt(sumDistSq);
            const stable =
              neighbourhoodWorldExtent < worldPerPixel * input.interpolationPixelRadius * 1.5;
            const planarityScore = 1 - Math.min(1, plane.planarity * 8);
            const confidence = Math.max(
              0.25,
              Math.min(
                0.85,
                0.55 * planarityScore + 0.45 * (1 - distancePx / input.interpolationPixelRadius),
              ),
            );
            out.push({
              position: { x: world.x, y: world.y, z: world.z },
              localPosition: { x: localHit.x, y: localHit.y, z: localHit.z },
              kind: 'EstimatedSurface',
              entity: this.adapter.entityId,
              confidence,
              source: 'point-cloud',
              target: this.estimatedSurfaceTarget(worldPerPixel * input.interpolationPixelRadius),
              distancePx,
              stable,
              candidateId: `${this.adapter.layerId}:surface`,
            });
          }
        }
      }
    }

    return out;
  }

  private pointTarget(hit: PickPoint): GeometryTargetRef | null {
    if (typeof hit.pointIndex !== 'number') return null;
    return {
      datasetKind: 'point-cloud',
      entityId: this.adapter.entityId,
      layerId: this.adapter.layerId,
      primitive: { kind: 'point', pointIndex: hit.pointIndex },
      exact: true,
    };
  }

  private estimatedSurfaceTarget(supportRadius: number): GeometryTargetRef {
    return {
      datasetKind: 'point-cloud',
      entityId: this.adapter.entityId,
      layerId: this.adapter.layerId,
      primitive: {
        kind: 'estimated-surface',
        supportKind: 'point-cloud',
        supportRadius,
      },
      exact: false,
    };
  }
}

/**
 * Walk the cloud's currently-visible nodes, gather the k closest points
 * inside a sphere around `query` (in cloud-local coordinates). Writes
 * `KNN_POINTS[0..count]` and packs distance² into `KNN_BUFFER[i*2+1]`.
 *
 * Filters by node bounding-box first; only nodes whose AABB intersects
 * the search sphere are scanned. Typical hit count: 1–5 nodes.
 */
function collectVisibleKnn(
  visibleNodes: readonly PointCloudOctreeNode[],
  query: Vector3,
  searchRadius: number,
  k: number,
): number {
  SCRATCH_QUERY_SPHERE.center.copy(query);
  SCRATCH_QUERY_SPHERE.radius = searchRadius;

  // Heap: we keep the k-best as an unsorted array and only ever evict
  // the current worst element. For k=24 a linear max-find per insert is
  // far cheaper than maintaining a true binary heap.
  let count = 0;
  let worstIdx = -1;
  let worstD2 = -Infinity;

  for (let n = 0; n < visibleNodes.length; n++) {
    const node = visibleNodes[n];
    if (!node) continue;
    const sceneNode = node.sceneNode;
    if (!sceneNode) continue;

    // node.boundingBox is in cloud-local coordinates already (Potree
    // serializes per-node bounds relative to the cloud root).
    SCRATCH_NODE_BB_MIN.copy(node.boundingBox.min);
    SCRATCH_NODE_BB_MAX.copy(node.boundingBox.max);
    SCRATCH_NODE_BB.set(SCRATCH_NODE_BB_MIN, SCRATCH_NODE_BB_MAX);
    if (!SCRATCH_NODE_BB.intersectsSphere(SCRATCH_QUERY_SPHERE)) continue;

    const geometry = (sceneNode as Points).geometry;
    if (!geometry) continue;
    const positionAttr = geometry.getAttribute('position') as BufferAttribute | undefined;
    if (!positionAttr) continue;
    const positions = positionAttr.array as Float32Array;
    const numPoints = positionAttr.count;

    // Per-node offset: sceneNode.matrix translation. Three-loader sets
    // each node's local position so the per-vertex floats stay near the
    // origin (precision-friendly). We undo that here so the comparison
    // happens in cloud-local space.
    const off = sceneNode.position;

    const radiusSq = searchRadius * searchRadius;
    const qx = query.x;
    const qy = query.y;
    const qz = query.z;

    for (let i = 0; i < numPoints; i++) {
      const px = (positions[i * 3] ?? 0) + off.x;
      const py = (positions[i * 3 + 1] ?? 0) + off.y;
      const pz = (positions[i * 3 + 2] ?? 0) + off.z;
      const dx = px - qx;
      const dy = py - qy;
      const dz = pz - qz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > radiusSq) continue;

      if (count < k) {
        const target = KNN_POINTS[count];
        if (!target) continue;
        target.set(px, py, pz);
        KNN_BUFFER[count * 2] = (n << 24) | i;
        KNN_BUFFER[count * 2 + 1] = d2;
        if (d2 > worstD2) {
          worstD2 = d2;
          worstIdx = count;
        }
        count++;
      } else if (d2 < worstD2) {
        const target = KNN_POINTS[worstIdx];
        if (!target) continue;
        target.set(px, py, pz);
        KNN_BUFFER[worstIdx * 2] = (n << 24) | i;
        KNN_BUFFER[worstIdx * 2 + 1] = d2;
        // Re-find worst (linear; k=24 → trivial).
        worstD2 = -Infinity;
        worstIdx = -1;
        for (let j = 0; j < k; j++) {
          const d2j = KNN_BUFFER[j * 2 + 1] ?? -Infinity;
          if (d2j > worstD2) {
            worstD2 = d2j;
            worstIdx = j;
          }
        }
      }
    }
  }

  return count;
}

/**
 * Build a stable candidate id for a GPU pick hit. We don't have a global
 * point index (Potree quantizes positions per-node and doesn't surface a
 * cross-node identifier) so we use the rounded local position as the key.
 * Stable enough for the snap hierarchy cycler.
 */
function encodePickCandidateId(layerId: string, hit: PickPoint): string {
  const p = hit.position;
  const idx = typeof hit.pointIndex === 'number' ? hit.pointIndex : -1;
  return `${layerId}:pick:${idx}:${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
}

function estimateDepthHint(input: SnapQueryInput, camera: PerspectiveCamera): number {
  const prev = input.previous;
  if (prev) {
    PROJECTED_PREV.set(
      prev.position.x - input.sceneRenderOffset[0],
      prev.position.y - input.sceneRenderOffset[1],
      prev.position.z - input.sceneRenderOffset[2],
    );
    const d = camera.position.distanceTo(PROJECTED_PREV);
    if (Number.isFinite(d) && d > 1e-3) return d;
  }
  const origin = input.ray.origin;
  const dir = input.ray.direction;
  const t = -origin.dot(dir);
  if (Number.isFinite(t) && t > 1e-3) return t;
  return FALLBACK_DEPTH_HINT;
}

function computeWorldPerPixel(
  camera: PerspectiveCamera,
  depth: number,
  viewportHeight: number,
): number {
  const fovRad = (camera.fov * Math.PI) / 180;
  const screenWorldHeight = 2 * depth * Math.tan(fovRad / 2);
  return screenWorldHeight / viewportHeight;
}

function projectPixelDistance(
  layerLocal: Vector3,
  layerOffset: Vector3,
  input: SnapQueryInput,
): number {
  SCRATCH_SCENE.copy(layerLocal).add(layerOffset);
  SCRATCH_NDC.copy(SCRATCH_SCENE).project(input.camera);
  if (SCRATCH_NDC.z < -1 || SCRATCH_NDC.z > 1) return Number.POSITIVE_INFINITY;
  const px = ((SCRATCH_NDC.x + 1) / 2) * window.innerWidth;
  const py = ((1 - SCRATCH_NDC.y) / 2) * window.innerHeight;
  const dx = px - input.pointerClient.x;
  const dy = py - input.pointerClient.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function toWorld(
  layerLocal: Vector3,
  layerOffset: Vector3,
  sceneRenderOffset: [number, number, number],
): Vector3 {
  return new Vector3(
    layerLocal.x + layerOffset.x + sceneRenderOffset[0],
    layerLocal.y + layerOffset.y + sceneRenderOffset[1],
    layerLocal.z + layerOffset.z + sceneRenderOffset[2],
  );
}

function chooseQueryPoint(
  exactHitLocal: Vector3 | null,
  rayLocalOrigin: Vector3,
  rayLocalDir: Vector3,
  depthHint: number,
): Vector3 {
  if (exactHitLocal) return exactHitLocal;
  return SCRATCH_PT.copy(rayLocalDir).multiplyScalar(depthHint).add(rayLocalOrigin);
}
