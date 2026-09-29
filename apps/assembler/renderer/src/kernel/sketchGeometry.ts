/**
 * Kernel side of sketches: detected regions (`sketch/regions.ts`) → OCCT
 * faces in the sketch frame, their tessellation for display/picking, and
 * the per-piece naming of extruded side faces. Runs in the kernel worker
 * and in Node tests; the solver is never needed here because a sketch
 * feature stores its last solved positions.
 */
import './occtArena.js';
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
  isClosedCurve,
  isFullCircle,
  pointAt,
  sampleCurve,
  sketchCurves,
  type Curve2,
} from '../sketch/geometry.js';
import {
  detectRegions,
  loopPolygon,
  type RegionLoop,
  type SketchRegion,
} from '../sketch/regions.js';
import type { EvaluatedSketch } from './types.js';

/**
 * One cubic B-spline edge for a whole Bézier chain (the segments elevated
 * to cubics, joined with triple knots): one edge — and so one extruded side
 * face — per region piece, whatever the number of segments.
 */
function bezierChainEdge(segs: readonly (readonly Vec3[])[]): R.Edge {
  const oc = R.getOC();
  const cubic = segs.map((seg) => elevate3(seg));
  const poles: Vec3[] = [];
  cubic.forEach((seg, i) => {
    if (i === 0) poles.push(seg[0]!);
    poles.push(seg[1]!, seg[2]!, seg[3]!);
  });
  const n = cubic.length;
  const polesArray = new oc.NCollection_Array1_gp_Pnt(1, poles.length);
  const knots = new oc.NCollection_Array1_double(1, n + 1);
  const mults = new oc.NCollection_Array1_int(1, n + 1);
  const pnts = poles.map((p) => new oc.gp_Pnt(p[0], p[1], p[2]));
  try {
    pnts.forEach((p, i) => polesArray.SetValue(i + 1, p));
    for (let i = 0; i <= n; i += 1) {
      knots.SetValue(i + 1, i);
      mults.SetValue(i + 1, i === 0 || i === n ? 4 : 3);
    }
    const curve = new oc.Geom_BSplineCurve(polesArray, knots, mults, 3, false);
    const builder = new oc.BRepBuilderAPI_MakeEdge(curve as never);
    try {
      return new R.Edge(builder.Edge());
    } finally {
      builder.delete();
    }
  } finally {
    for (const p of pnts) p.delete();
    polesArray.delete();
    knots.delete();
    mults.delete();
  }
}

/** Degree elevation of a line/quadratic Bézier (3D control points) to a cubic. */
function elevate3(seg: readonly Vec3[]): Vec3[] {
  if (seg.length === 4) return [...seg];
  const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  if (seg.length === 2)
    return [seg[0]!, lerp(seg[0]!, seg[1]!, 1 / 3), lerp(seg[0]!, seg[1]!, 2 / 3), seg[1]!];
  return [seg[0]!, lerp(seg[0]!, seg[1]!, 2 / 3), lerp(seg[2]!, seg[1]!, 2 / 3), seg[2]!];
}

/** Unit-length cross product (frame normal as u × v, so ellipse angles run like the sketch's). */
function crossUnit(a: Vec3, b: Vec3): Vec3 {
  const c: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const l = Math.hypot(c[0], c[1], c[2]) || 1;
  return [c[0] / l, c[1] / l, c[2] / l];
}

/** Edges of an elliptical arc/ellipse piece (OCCT needs major ≥ minor: swap axes when needed). */
function ellipseEdges(
  frame: SketchFrame,
  curve: Extract<Curve2, { kind: 'ellipse' }>,
  pinned: boolean,
): R.Edge[] {
  let { rx, ry, rot, a0 } = curve;
  if (rx < ry) {
    [rx, ry] = [ry, rx];
    rot += Math.PI / 2;
    a0 -= Math.PI / 2;
  }
  const axis: Vec3 = [
    frame.u[0] * Math.cos(rot) + frame.v[0] * Math.sin(rot),
    frame.u[1] * Math.cos(rot) + frame.v[1] * Math.sin(rot),
    frame.u[2] * Math.cos(rot) + frame.v[2] * Math.sin(rot),
  ];
  const normal = crossUnit(frame.u, frame.v);
  const center = framePoint(frame, curve.c[0], curve.c[1]);
  if (isClosedCurve(curve) && !pinned) return [R.makeEllipse(rx, ry, center, normal, axis)];
  const from = Math.min(a0, a0 + curve.sweep);
  const to = Math.max(a0, a0 + curve.sweep);
  if (isClosedCurve(curve)) {
    // A whole ellipse touching the rest of the loop at one vertex: two halves through it.
    const mid = (from + to) / 2;
    return [
      R.makeEllipseArc(rx, ry, from, mid, center, normal, axis),
      R.makeEllipseArc(rx, ry, mid, to, center, normal, axis),
    ];
  }
  return [R.makeEllipseArc(rx, ry, from, to, center, normal, axis)];
}

function edgesOf(frame: SketchFrame, piece: RegionLoop['pieces'][number]): R.Edge[] {
  const curve = piece.curve;
  const p = (t: number): Vec3 => {
    const [u, v] = pointAt(curve, t);
    return framePoint(frame, u, v);
  };
  // Ends at the shared region vertices (not re-evaluated per curve), so wires close exactly.
  const start = piece.start ? framePoint(frame, piece.start[0], piece.start[1]) : p(0);
  const end = piece.end ? framePoint(frame, piece.end[0], piece.end[1]) : p(1);
  if (curve.kind === 'line') return [R.makeLine(start, end)];
  if (curve.kind === 'ellipse') return ellipseEdges(frame, curve, !!piece.start);
  if (curve.kind === 'bezier') {
    const segs = curve.segs.map((seg) => seg.map(([u, v]) => framePoint(frame, u, v)));
    if (segs.length === 0) return [];
    segs[0]![0] = start;
    const last = segs[segs.length - 1]!;
    last[last.length - 1] = end;
    if (segs.length === 1 && segs[0]!.length === 2) return [R.makeLine(start, end)];
    return [bezierChainEdge(segs)];
  }
  if (isFullCircle(curve)) {
    // A whole circle touching the rest of the loop at one vertex: two halves through it.
    if (piece.start) {
      return [
        R.makeThreePointArc(start, p(0.25), p(0.5)),
        R.makeThreePointArc(p(0.5), p(0.75), end),
      ];
    }
    return [R.makeCircle(curve.r, framePoint(frame, curve.c[0], curve.c[1]), frame.normal)];
  }
  return [R.makeThreePointArc(start, p(0.5), end)];
}

function wireOf(frame: SketchFrame, loop: RegionLoop): R.Wire {
  return R.assembleWire(loop.pieces.flatMap((piece) => edgesOf(frame, piece)));
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
): { evaluated: EvaluatedSketch; regions: SketchRegion[]; warnings: string[] } {
  const detected = detectRegions(feature);
  const toWorld = (points: readonly [number, number][]): Vec3[] =>
    points.map(([u, v]) => framePoint(frame, u, v));
  // A region the kernel cannot turn into a face is skipped (with a warning), not the whole sketch.
  const warnings: string[] = [];
  const regions: SketchRegion[] = [];
  const faces: R.Face[] = [];
  for (const region of detected) {
    try {
      faces.push(regionFace(frame, region));
      regions.push(region);
    } catch (error) {
      warnings.push(
        `Profile ${region.key} could not be built (${error instanceof Error ? error.message : 'kernel error'})`,
      );
    }
  }
  const profiles = regions.map((region, i) => {
    const face = faces[i]!;
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
    entityId: c.entityId,
    kind: c.entity.kind,
    construction: c.entity.construction === true,
    points: toWorld(sampleCurve(c.curve)),
  }));
  return { evaluated: { featureId: feature.id, frame, profiles, curves }, regions, warnings };
}

/**
 * Name of the region boundary piece nearest to `point` (world): the sketch
 * entity id, with `~k` for the k-th piece of the same entity in one region.
 * Names the faces a profile edge generates (extrude/revolve/sweep sides).
 */
export function regionPieceName(frame: SketchFrame, region: SketchRegion, point: Vec3): string {
  const { u, v } = frameUv(frame, point);
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
  return `${piece.entityId}${suffix}`;
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
  return `${featureId}:side:${profileIndex}:${regionPieceName(frame, region, pointOnFace)}`;
}
