/**
 * What the camera frames for "Zoom to selection" and "Look at face": world
 * bounding boxes of selection items, pure (unit tested).
 */
import type { Body, EvaluationResult } from '../foundation/geometry-kernel/types.js';
import type { SelectionItem } from '../foundation/commands/store.js';
import type { Bounds } from './camera.js';
import type { Vec3 } from './math.js';

function boundsOfPoints(points: Iterable<Vec3>): Bounds | null {
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const p of points) {
    any = true;
    min = [Math.min(min[0], p[0]), Math.min(min[1], p[1]), Math.min(min[2], p[2])];
    max = [Math.max(max[0], p[0]), Math.max(max[1], p[1]), Math.max(max[2], p[2])];
  }
  return any ? { min, max } : null;
}

function* faceVertices(body: Body, faceKey: string): Generator<Vec3> {
  const face = body.faces.find((f) => f.key === faceKey);
  if (!face) return;
  const { positions, indices } = body.mesh;
  for (let t = face.triangleStart; t < face.triangleStart + face.triangleCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const i = indices[t * 3 + k]!;
      yield [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    }
  }
}

function* edgeVertices(body: Body, edgeKey: string): Generator<Vec3> {
  const edge = body.edges.find((e) => e.key === edgeKey);
  if (!edge) return;
  for (let i = 0; i + 2 < edge.segments.length; i += 3) {
    yield [edge.segments[i]!, edge.segments[i + 1]!, edge.segments[i + 2]!];
  }
}

/** Bounds of one planar face (for "Look at face"), or `null`. */
export function faceFrameBounds(body: Body, faceKey: string): Bounds | null {
  return boundsOfPoints(faceVertices(body, faceKey));
}

/** Bounds of every selection item that has geometry (bodies, faces, edges, sketch profiles). */
export function cameraTargetBounds(
  evaluation: {
    bodies: readonly EvaluationResult['bodies'][number][];
    sketches: readonly EvaluationResult['sketches'][number][];
    datums?: readonly {
      featureId: string;
      center: readonly [number, number, number];
      size: number;
    }[];
  },
  selection: readonly SelectionItem[],
): Bounds[] {
  const out: Bounds[] = [];
  for (const item of selection) {
    let b: Bounds | null = null;
    if (item.kind === 'body') {
      const body = evaluation.bodies.find((x) => x.id === item.bodyId);
      b = body ? { min: body.min, max: body.max } : null;
    } else if (item.kind === 'face' || item.kind === 'edge') {
      const body = evaluation.bodies.find((x) => x.id === item.bodyId);
      if (body) {
        b =
          item.kind === 'face'
            ? faceFrameBounds(body, item.faceKey)
            : boundsOfPoints(edgeVertices(body, item.edgeKey));
      }
    } else if (item.kind === 'sketchProfile') {
      const sketch = evaluation.sketches.find((s) => s.featureId === item.featureId);
      const profiles =
        sketch?.profiles.filter((p) => item.regionKey === undefined || p.key === item.regionKey) ??
        [];
      b = boundsOfPoints(profiles.flatMap((p) => p.outline));
    } else if (item.kind === 'datum') {
      // A construction plane/axis: the cube around its drawn square/segment.
      const datum = evaluation.datums?.find((d) => d.featureId === item.featureId);
      if (datum) {
        const [x, y, z] = datum.center;
        const s = datum.size;
        b = { min: [x - s, y - s, z - s], max: [x + s, y + s, z + s] };
      }
    }
    if (b) out.push(b);
  }
  return out;
}
