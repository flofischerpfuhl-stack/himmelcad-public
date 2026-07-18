import { PerspectiveCamera, Vector3 } from 'three';

import type { SnapResult } from '@himmelcad/data';

import type { CameraImageRectangle } from '../Viewport.js';
import type { SnapProvider, SnapQueryInput } from './SnapProvider.js';

const RAY_POINT = new Vector3();
const SEGMENT_POINT = new Vector3();
const START = new Vector3();
const END = new Vector3();
const PROJECTED = new Vector3();

interface LocalCameraRectangle {
  readonly source: CameraImageRectangle;
  readonly points: readonly [Vector3, Vector3, Vector3, Vector3, Vector3];
}

const EDGES = [
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 1],
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
] as const;

/**
 * Makes PhotoLab camera frusta first-class cursor geometry. The visible
 * LineSegments object cannot participate in the normal GPU pick pass, so this
 * provider evaluates the same centre/corners/edges directly in scene-local
 * coordinates. Returned coordinates are absolute project coordinates.
 */
export class CameraSnapProvider implements SnapProvider {
  readonly id = 'photolab:camera-snap';
  private rectangles: LocalCameraRectangle[] = [];

  update(
    rectangles: readonly CameraImageRectangle[],
    renderOffset: readonly [number, number, number],
  ): void {
    this.rectangles = rectangles.filter(isValidCameraRectangle).map((source) => ({
      source,
      points: [source.cameraCenter, ...source.corners].map(
        (point) =>
          new Vector3(
            point[0] - renderOffset[0],
            point[1] - renderOffset[1],
            point[2] - renderOffset[2],
          ),
      ) as unknown as readonly [Vector3, Vector3, Vector3, Vector3, Vector3],
    }));
  }

  query(input: SnapQueryInput): readonly SnapResult[] {
    if (!(input.camera instanceof PerspectiveCamera) || this.rectangles.length === 0) return [];
    const candidates: SnapResult[] = [];
    const tolerance = Math.max(8, input.pixelTolerance * 1.35);

    for (const rectangle of this.rectangles) {
      for (let vertexIndex = 0; vertexIndex < rectangle.points.length; vertexIndex += 1) {
        const point = rectangle.points[vertexIndex];
        if (!point) continue;
        const distancePx = projectPixelDistance(point, input);
        if (distancePx <= tolerance) {
          candidates.push(
            makeCandidate(rectangle, point, input, distancePx, 'Vertex', vertexIndex, true),
          );
        }
      }

      for (let edgeIndex = 0; edgeIndex < EDGES.length; edgeIndex += 1) {
        const edge = EDGES[edgeIndex];
        if (!edge) continue;
        const start = rectangle.points[edge[0]];
        const end = rectangle.points[edge[1]];
        if (!start || !end) continue;
        START.copy(start);
        END.copy(end);
        input.ray.distanceSqToSegment(START, END, RAY_POINT, SEGMENT_POINT);
        const distancePx = projectPixelDistance(SEGMENT_POINT, input);
        if (distancePx <= tolerance) {
          candidates.push(
            makeCandidate(rectangle, SEGMENT_POINT, input, distancePx, 'Edge', edgeIndex, false),
          );
        }
      }
    }

    candidates.sort(
      (left, right) =>
        (left.distancePx ?? Number.POSITIVE_INFINITY) -
        (right.distancePx ?? Number.POSITIVE_INFINITY),
    );
    return candidates.slice(0, 8);
  }
}

function makeCandidate(
  rectangle: LocalCameraRectangle,
  scenePoint: Vector3,
  input: SnapQueryInput,
  distancePx: number,
  kind: 'Vertex' | 'Edge',
  primitiveIndex: number,
  vertex: boolean,
): SnapResult {
  const worldX = scenePoint.x + input.sceneRenderOffset[0];
  const worldY = scenePoint.y + input.sceneRenderOffset[1];
  const worldZ = scenePoint.z + input.sceneRenderOffset[2];
  return {
    position: { x: worldX, y: worldY, z: worldZ },
    localPosition: { x: scenePoint.x, y: scenePoint.y, z: scenePoint.z },
    kind,
    entity: rectangle.source.entityId,
    confidence: vertex ? 0.99 : 0.94,
    source: 'camera',
    distancePx,
    stable: true,
    candidateId: `camera:${rectangle.source.entityId}:${vertex ? 'vertex' : 'edge'}:${primitiveIndex}`,
    target: {
      datasetKind: 'camera',
      entityId: rectangle.source.entityId,
      layerId: 'photolab:cameras',
      primitive: vertex
        ? { kind: 'vertex', vertexIndex: primitiveIndex }
        : { kind: 'edge', edgeIndex: primitiveIndex },
      exact: true,
    },
  };
}

function projectPixelDistance(scenePoint: Vector3, input: SnapQueryInput): number {
  PROJECTED.copy(scenePoint).project(input.camera);
  if (PROJECTED.z < -1 || PROJECTED.z > 1) return Number.POSITIVE_INFINITY;
  const px = ((PROJECTED.x + 1) / 2) * window.innerWidth;
  const py = ((1 - PROJECTED.y) / 2) * window.innerHeight;
  return Math.hypot(px - input.pointerClient.x, py - input.pointerClient.y);
}

function isValidCameraRectangle(rectangle: CameraImageRectangle): boolean {
  return [rectangle.cameraCenter, ...rectangle.corners].every((point) =>
    point.every(Number.isFinite),
  );
}
