/**
 * Kernel side of sketches: detected regions (`sketch/regions.ts`) → OCCT
 * faces in the sketch frame, their tessellation for display/picking, and
 * the per-piece naming of extruded side faces. Runs in the kernel worker
 * and in Node tests; the solver is never needed here because a sketch
 * feature stores its last solved positions.
 */
import * as R from 'replicad';

import {
  framePoint,
  frameUv,
  type SketchFeature,
  type SketchFrame,
  type Vec3,
} from '../model/document.js';
import {
  closestOnCurve,
  isFullCircle,
  pointAt,
  sampleCurve,
  sketchCurves,
} from '../sketch/geometry.js';
import {
  detectRegions,
  loopPolygon,
  type RegionLoop,
  type SketchRegion,
} from '../sketch/regions.js';
import type { EvaluatedSketch } from './types.js';

function edgeOf(frame: SketchFrame, piece: RegionLoop['pieces'][number]): R.Edge {
  const curve = piece.curve;
  const p = (t: number): Vec3 => {
    const [u, v] = pointAt(curve, t);
    return framePoint(frame, u, v);
  };
  if (curve.kind === 'line') return R.makeLine(p(0), p(1));
  if (isFullCircle(curve)) {
    return R.makeCircle(curve.r, framePoint(frame, curve.c[0], curve.c[1]), frame.normal);
  }
  return R.makeThreePointArc(p(0), p(0.5), p(1));
}

function wireOf(frame: SketchFrame, loop: RegionLoop): R.Wire {
  return R.assembleWire(loop.pieces.map((piece) => edgeOf(frame, piece)));
}

/** Planar OCCT face of a region (outer loop with its holes) in world coordinates. */
export function regionFace(frame: SketchFrame, region: SketchRegion): R.Face {
  return R.makeFace(
    wireOf(frame, region.outer),
    region.holes.map((hole) => wireOf(frame, hole)),
  );
}

/**
 * Detects the regions of a sketch feature and describes them (and every
 * curve) in world coordinates for the viewport.
 */
export function evaluateSketchGeometry(
  feature: SketchFeature,
  frame: SketchFrame,
): { evaluated: EvaluatedSketch; regions: SketchRegion[] } {
  const regions = detectRegions(feature);
  const toWorld = (points: readonly [number, number][]): Vec3[] =>
    points.map(([u, v]) => framePoint(frame, u, v));
  const profiles = regions.map((region) => {
    const face = regionFace(frame, region);
    const mesh = face.mesh({ tolerance: 0.02, angularTolerance: 0.1 });
    const triangles: number[] = [];
    for (const index of mesh.triangles) {
      triangles.push(
        mesh.vertices[index * 3]!,
        mesh.vertices[index * 3 + 1]!,
        mesh.vertices[index * 3 + 2]!,
      );
    }
    face.delete();
    return {
      key: region.key,
      outline: toWorld(loopPolygon(region.outer)),
      holes: region.holes.map((hole) => toWorld(loopPolygon(hole))),
      triangles,
      center: framePoint(frame, region.sample[0], region.sample[1]),
      area: region.area,
    };
  });
  const curves = sketchCurves(feature, { includeConstruction: true }).map((c) => ({
    entityId: c.id,
    construction: c.entity.construction === true,
    points: toWorld(sampleCurve(c.curve)),
  }));
  return { evaluated: { featureId: feature.id, frame, profiles, curves }, regions };
}

/**
 * Naming key of an extruded side face: the boundary piece (sketch entity)
 * nearest to `pointOnFace` (a point of the face's surface, e.g. its
 * parametric middle — not the centroid, which lies off curved faces),
 * `~k` for the k-th piece of the same entity in one region.
 * `profileIndex` is the region's position in the extrude's profile list.
 */
export function sideFaceKey(
  featureId: string,
  profileIndex: number,
  frame: SketchFrame,
  region: SketchRegion,
  pointOnFace: Vec3,
): string {
  const { u, v } = frameUv(frame, pointOnFace);
  const pieces = [region.outer, ...region.holes].flatMap((loop) => loop.pieces);
  let best = 0;
  let bestDistance = Infinity;
  pieces.forEach((piece, i) => {
    const d = closestOnCurve(piece.curve, [u, v]).distance;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  const piece = pieces[best]!;
  const sameEntity = pieces.filter((p) => p.entityId === piece.entityId);
  const suffix = sameEntity.length > 1 ? `~${sameEntity.indexOf(piece)}` : '';
  return `${featureId}:side:${profileIndex}:${piece.entityId}${suffix}`;
}
