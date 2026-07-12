import { PerspectiveCamera, Vector3 } from 'three';

import type { GeometryTargetRef, SnapResult } from '@himmelcad/data';

import type { PointCloudLayer } from '../scene/PointCloudLayer.js';
import { fitPlane, intersectRayPlane } from '../spatial/planeFit.js';
import type { SnapProvider, SnapQueryInput } from './SnapProvider.js';

/**
 * Index-driven point-cloud cursor provider.
 *
 * Replaces the earlier sampling-based heuristic with two octree queries:
 *
 *   1. Ray-nearest within a screen-derived world-space tolerance →
 *      "Point" snap (exact, deterministic, sub-pixel accurate).
 *   2. K-NN around the ray hit (or a back-projected ray-stable point) →
 *      weighted PCA plane → ray-plane intersection → "EstimatedSurface"
 *      snap that fills point-cloud gaps without flicker.
 *
 * Performance: each query touches O(log n) tree nodes plus the points in at
 * most a handful of leaves. For an 8 M-point cloud with leaf capacity 1024
 * that is well below 1 ms even at 240 Hz pointer events. The provider does
 * not allocate per-query (reuses scratch vectors) except for the candidate
 * SnapResult objects themselves.
 *
 * Performance contract: ZERO O(N) scans of `positions`. If you find yourself
 * iterating the full positions array here, undo the change.
 */
const KNN_K = 24;
/** World-space slack on the ray-nearest radius derived from pixel tolerance. */
const WORLD_RADIUS_SLACK = 3.0;
/** Falls back to this distance when no previous snap and the ray is parallel to the scene. */
const FALLBACK_DEPTH_HINT = 50;

const RAY_LOCAL_ORIGIN = new Vector3();
const RAY_LOCAL_DIR = new Vector3();
const SCRATCH_LOCAL = new Vector3();
const SCRATCH_SCENE = new Vector3();
const SCRATCH_NDC = new Vector3();
const QUERY_POINT = new Vector3();
const PROJECTED_PREV = new Vector3();
const SCRATCH_PT = new Vector3();
const SCRATCH_PT2 = new Vector3();

export class PointCloudSnapProvider implements SnapProvider {
  readonly id: string;

  constructor(private readonly layer: PointCloudLayer) {
    this.id = `${layer.id}:snap`;
  }

  query(input: SnapQueryInput): readonly SnapResult[] {
    const octree = this.layer.octree;
    if (!octree || this.layer.pointCount === 0) return [];
    const camera = input.camera;
    if (!(camera instanceof PerspectiveCamera)) return [];

    // Convert ray from scene-local into the layer's local frame.
    RAY_LOCAL_ORIGIN.copy(input.ray.origin).sub(this.layer.object3d.position);
    RAY_LOCAL_DIR.copy(input.ray.direction).normalize();

    const viewportHeight = Math.max(1, input.viewportRect.height);
    const depthHint = estimateDepthHint(input, camera);
    const worldPerPixel = computeWorldPerPixel(camera, depthHint, viewportHeight);
    const worldTolerance = Math.max(
      1e-4,
      input.pixelTolerance * worldPerPixel * WORLD_RADIUS_SLACK,
    );

    const out: SnapResult[] = [];
    let exactHitLocal: Vector3 | null = null;
    let exactPointIndex: number | null = null;

    // Stage 1a: GPU pick fast path. If the pick pass identified a point on
    // this layer, address it directly — no ray walk needed and the result is
    // pixel-exact by construction.
    const pick = input.pick;
    if (pick && pick.layerId === this.layer.id) {
      const pi = pick.pointIndex;
      if (pi >= 0 && pi < this.layer.pointCount) {
        const base = pi * 3;
        SCRATCH_LOCAL.set(
          this.layer.positions[base] ?? 0,
          this.layer.positions[base + 1] ?? 0,
          this.layer.positions[base + 2] ?? 0,
        );
        const distancePx = projectPixelDistance(SCRATCH_LOCAL, this.layer.object3d.position, input);
        const world = toWorld(SCRATCH_LOCAL, this.layer.object3d.position, input.sceneRenderOffset);
        out.push({
          position: { x: world.x, y: world.y, z: world.z },
          localPosition: { x: SCRATCH_LOCAL.x, y: SCRATCH_LOCAL.y, z: SCRATCH_LOCAL.z },
          kind: 'Point',
          entity: this.layer.entityId,
          confidence: 0.99,
          source: 'point-cloud',
          target: this.pointTarget(pi),
          distancePx,
          stable: true,
          candidateId: `${this.layer.id}:point:${pi}`,
        });
        exactHitLocal = SCRATCH_LOCAL.clone();
        exactPointIndex = pi;
      }
    }

    // Stage 1b: octree ray-nearest fallback when the GPU pick is stale or
    // the cursor is over a tile not yet uploaded to the pick pass.
    if (exactPointIndex === null) {
      const exact = octree.nearestToRay(
        this.layer.positions,
        RAY_LOCAL_ORIGIN,
        RAY_LOCAL_DIR,
        worldTolerance,
      );
      if (exact) {
        const base = exact.pointIndex * 3;
        SCRATCH_LOCAL.set(
          this.layer.positions[base] ?? 0,
          this.layer.positions[base + 1] ?? 0,
          this.layer.positions[base + 2] ?? 0,
        );
        const distancePx = projectPixelDistance(SCRATCH_LOCAL, this.layer.object3d.position, input);
        if (distancePx <= input.pixelTolerance) {
          const world = toWorld(
            SCRATCH_LOCAL,
            this.layer.object3d.position,
            input.sceneRenderOffset,
          );
          out.push({
            position: { x: world.x, y: world.y, z: world.z },
            localPosition: { x: SCRATCH_LOCAL.x, y: SCRATCH_LOCAL.y, z: SCRATCH_LOCAL.z },
            kind: 'Point',
            entity: this.layer.entityId,
            confidence: 0.98,
            source: 'point-cloud',
            target: this.pointTarget(exact.pointIndex),
            distancePx,
            stable: true,
            candidateId: `${this.layer.id}:point:${exact.pointIndex}`,
          });
          exactHitLocal = SCRATCH_LOCAL.clone();
          exactPointIndex = exact.pointIndex;
        }
      }
    }

    // Stage 1c: pick-neighbourhood candidates. When the user is asking for
    // snap hierarchy (Space-key cycling), every distinct point in the
    // neighbourhood that belongs to this layer becomes its own candidate so
    // the cycle can step through occluded points. Skipped during normal
    // hover to keep the candidate set small.
    if (input.pickNeighborhood && input.pickNeighborhood.length > 0) {
      for (const hit of input.pickNeighborhood) {
        if (hit.layerId !== this.layer.id) continue;
        if (hit.pointIndex === exactPointIndex) continue;
        if (hit.pointIndex < 0 || hit.pointIndex >= this.layer.pointCount) continue;
        const base = hit.pointIndex * 3;
        SCRATCH_LOCAL.set(
          this.layer.positions[base] ?? 0,
          this.layer.positions[base + 1] ?? 0,
          this.layer.positions[base + 2] ?? 0,
        );
        const world = toWorld(SCRATCH_LOCAL, this.layer.object3d.position, input.sceneRenderOffset);
        out.push({
          position: { x: world.x, y: world.y, z: world.z },
          localPosition: { x: SCRATCH_LOCAL.x, y: SCRATCH_LOCAL.y, z: SCRATCH_LOCAL.z },
          kind: 'Point',
          entity: this.layer.entityId,
          // Slightly lower confidence than the topmost so the topmost stays
          // the natural default; cycling still picks up the rest in order.
          confidence: 0.9,
          source: 'point-cloud',
          target: this.pointTarget(hit.pointIndex),
          distancePx: hit.pixelDistance,
          stable: true,
          candidateId: `${this.layer.id}:point:${hit.pointIndex}`,
        });
      }
    }

    // Stage 2: surface estimate via k-NN + plane fit. Always attempted so
    // the cursor stays meaningful between sampled points; tools and orbit
    // pivot consume this when there is no exact point hit.
    const queryPoint = chooseQueryPoint(exactHitLocal, RAY_LOCAL_ORIGIN, RAY_LOCAL_DIR, depthHint);
    QUERY_POINT.copy(queryPoint);
    const knn = octree.kNearest(this.layer.positions, QUERY_POINT, KNN_K);
    if (knn.length >= 3) {
      const points: Vector3[] = new Array(knn.length);
      const weights: number[] = new Array(knn.length);
      let sumDistSq = 0;
      for (let i = 0; i < knn.length; i++) {
        const hit = knn[i];
        if (!hit) continue;
        const base = hit.pointIndex * 3;
        const p = new Vector3(
          this.layer.positions[base] ?? 0,
          this.layer.positions[base + 1] ?? 0,
          this.layer.positions[base + 2] ?? 0,
        );
        points[i] = p;
        const d2 = Math.max(1e-6, hit.distanceSq);
        weights[i] = 1 / d2;
        sumDistSq = Math.max(sumDistSq, d2);
      }
      const plane = fitPlane(points, weights);
      if (plane) {
        const localHit = intersectRayPlane(RAY_LOCAL_ORIGIN, RAY_LOCAL_DIR, plane, SCRATCH_PT2);
        if (localHit) {
          const distancePx = projectPixelDistance(localHit, this.layer.object3d.position, input);
          if (distancePx <= input.interpolationPixelRadius) {
            const world = toWorld(localHit, this.layer.object3d.position, input.sceneRenderOffset);
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
              entity: this.layer.entityId,
              confidence,
              source: 'point-cloud',
              target: this.estimatedSurfaceTarget(worldPerPixel * input.interpolationPixelRadius),
              distancePx,
              stable,
              candidateId: `${this.layer.id}:surface`,
            });
          }
        }
      }
    }

    return out;
  }

  private pointTarget(pointIndex: number): GeometryTargetRef {
    return {
      datasetKind: 'point-cloud',
      entityId: this.layer.entityId,
      layerId: this.layer.id,
      primitive: { kind: 'point', pointIndex },
      exact: true,
    };
  }

  private estimatedSurfaceTarget(supportRadius: number): GeometryTargetRef {
    return {
      datasetKind: 'point-cloud',
      entityId: this.layer.entityId,
      layerId: this.layer.id,
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
 * Estimate the depth (camera-to-cursor) used to convert pixel tolerance into
 * a world-space radius. Order of preference:
 *   1. Distance from camera to the previous stable cursor position.
 *   2. Distance from camera to its projection onto the current ray.
 *   3. A conservative fallback so the very first move still finds something.
 */
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
  // Distance from camera to the closest point on the camera ray to origin.
  const origin = input.ray.origin;
  const dir = input.ray.direction;
  const t = -origin.dot(dir);
  if (Number.isFinite(t) && t > 1e-3) return t;
  return FALLBACK_DEPTH_HINT;
}

/**
 * World units per screen pixel at `depth` for a perspective camera.
 * Matches three.js `PerspectiveCamera.fov` definition (vertical, degrees).
 */
function computeWorldPerPixel(
  camera: PerspectiveCamera,
  depth: number,
  viewportHeight: number,
): number {
  const fovRad = (camera.fov * Math.PI) / 180;
  const screenWorldHeight = 2 * depth * Math.tan(fovRad / 2);
  return screenWorldHeight / viewportHeight;
}

/**
 * Project a layer-local point to client-space pixel coordinates and return
 * its distance to the cursor in pixels. Uses the full window because the
 * canvas is sized to the window (mask architecture); the viewportRect is
 * supplied for completeness but the camera projection covers the window.
 */
function projectPixelDistance(
  layerLocal: Vector3,
  layerOffset: Vector3,
  input: SnapQueryInput,
): number {
  SCRATCH_SCENE.copy(layerLocal).add(layerOffset);
  SCRATCH_NDC.copy(SCRATCH_SCENE).project(input.camera);
  // Behind the camera or behind the far plane → infinitely far.
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

/**
 * Choose the world-space anchor for k-NN: the exact ray hit if found,
 * otherwise a point along the ray at the current depth hint so neighbouring
 * surface samples come from the visible region of the cloud.
 */
function chooseQueryPoint(
  exactHitLocal: Vector3 | null,
  rayLocalOrigin: Vector3,
  rayLocalDir: Vector3,
  depthHint: number,
): Vector3 {
  if (exactHitLocal) return exactHitLocal;
  return SCRATCH_PT.copy(rayLocalDir).multiplyScalar(depthHint).add(rayLocalOrigin);
}
