/**
 * DXF ↔ sketch geometry.
 *
 * Import (`dxfToSketchData`): DXF entities become sketch entities in the
 * sketch's (u, v) coordinates, scaled to millimetres — lines, circles,
 * arcs (polyline bulges become arcs), ellipses/elliptical arcs, B-splines
 * (non-rational, clamped: kept exactly as control-point splines; fit-point
 * splines as fit splines; rational or periodic ones are sampled into a fit
 * spline and counted as approximated) and points. With `connect`
 * (default) curve end points closer than the weld tolerance share one
 * point entity — the sketch's own representation of a coincident
 * constraint, so closed outlines become profiles. No other constraints or
 * dimensions are invented; the imported geometry is under-constrained.
 *
 * Export (`sketchToDxfEntities`, `faceOutlineToDxfEntities`): sketch curves
 * (text glyphs included, construction geometry on layer `CONSTRUCTION`) or a
 * planar face's boundary edges, in the sketch/face frame, as DXF entities.
 */
import type { Body } from '../../foundation/geometry-kernel/types.js';
import { frameForFace, frameUv, type SketchFrame } from '../../foundation/document/document.js';
import {
  circleThrough,
  sketchCurves,
  type Curve2,
} from '../../foundation/sketch-solver/geometry.js';
import { beziersToBspline, validKnots } from '../../foundation/sketch-solver/spline.js';
import {
  EMPTY_SKETCH,
  idAllocator,
  type SketchData,
  type SketchEntity,
  type Vec2 as SketchVec2,
} from '../../foundation/sketch-solver/types.js';
import { sampleEntity, type DxfEntity, type Vec2 } from './dxf.js';

export interface DxfImportOptions {
  /** Millimetres per drawing unit. */
  scaleToMm: number;
  /** Share end points closer than the weld tolerance (coincident). Default true. */
  connect?: boolean;
  /** Offset added after scaling (mm), e.g. to move the drawing's origin. Default none. */
  offset?: Vec2;
}

export interface DxfImportStats {
  curves: number;
  points: number;
  /** End points merged into shared points. */
  connected: number;
  /** Splines that had to be sampled (rational/periodic). */
  approximated: number;
  /** Zero-length or degenerate entities dropped. */
  dropped: number;
}

const TAU = Math.PI * 2;

/** Converts DXF entities to sketch data (appended to `base`, default an empty sketch). */
export function dxfToSketchData(
  entities: readonly DxfEntity[],
  options: DxfImportOptions,
  base: SketchData = EMPTY_SKETCH,
): { sketch: SketchData; stats: DxfImportStats } {
  const k = options.scaleToMm;
  const [ox, oy] = options.offset ?? [0, 0];
  const tr = (p: Vec2): SketchVec2 => [p[0] * k + ox, p[1] * k + oy];
  const connect = options.connect !== false;
  const alloc = idAllocator(base);
  const out: SketchEntity[] = [];
  const stats: DxfImportStats = { curves: 0, points: 0, connected: 0, approximated: 0, dropped: 0 };

  // Weld tolerance: 1e-6 of the drawing's extent, at least 1e-6 mm.
  let extent = 0;
  for (const e of entities) {
    for (const p of anchorPoints(e))
      extent = Math.max(extent, Math.abs(p[0] * k), Math.abs(p[1] * k));
  }
  const tol = Math.max(1e-6, extent * 1e-6);
  const welded = new Map<string, string>();
  const point = (p: SketchVec2, weld: boolean): string => {
    if (weld && connect) {
      const key = `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)}`;
      const existing = welded.get(key);
      if (existing) {
        stats.connected += 1;
        return existing;
      }
      const id = alloc('p');
      out.push({ id, kind: 'point', x: p[0], y: p[1] });
      welded.set(key, id);
      return id;
    }
    const id = alloc('p');
    out.push({ id, kind: 'point', x: p[0], y: p[1] });
    return id;
  };
  const line = (a: SketchVec2, b: SketchVec2) => {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= tol) {
      stats.dropped += 1;
      return;
    }
    out.push({ id: alloc('l'), kind: 'line', a: point(a, true), b: point(b, true) });
    stats.curves += 1;
  };
  const arc = (c: SketchVec2, r: number, start: number, end: number) => {
    if (!(r > tol)) {
      stats.dropped += 1;
      return;
    }
    let sweep = end - start;
    while (sweep <= 0) sweep += TAU;
    while (sweep > TAU) sweep -= TAU;
    if (sweep >= TAU - 1e-9) {
      out.push({ id: alloc('c'), kind: 'circle', center: point(c, false), radius: r });
      stats.curves += 1;
      return;
    }
    const s: SketchVec2 = [c[0] + r * Math.cos(start), c[1] + r * Math.sin(start)];
    const e: SketchVec2 = [c[0] + r * Math.cos(start + sweep), c[1] + r * Math.sin(start + sweep)];
    const center = point(c, false);
    out.push({ id: alloc('a'), kind: 'arc', center, start: point(s, true), end: point(e, true) });
    stats.curves += 1;
  };
  const fitSpline = (pts: SketchVec2[]) => {
    const clean = pts.filter(
      (p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1]![0], p[1] - pts[i - 1]![1]) > tol,
    );
    if (clean.length < 2) {
      stats.dropped += 1;
      return;
    }
    const ids = clean.map((p, i) => point(p, i === 0 || i === clean.length - 1));
    out.push({ id: alloc('s'), kind: 'spline', mode: 'fit', points: ids, handles: [null, null] });
    stats.curves += 1;
  };

  for (const e of entities) {
    switch (e.kind) {
      case 'line':
        line(tr(e.a), tr(e.b));
        break;
      case 'circle':
        arc(tr(e.center), e.radius * k, 0, TAU);
        break;
      case 'arc':
        arc(tr(e.center), e.radius * k, e.start, e.end);
        break;
      case 'polyline': {
        const n = e.points.length;
        const segments = e.closed ? n : n - 1;
        for (let i = 0; i < segments; i += 1) {
          const p = tr(e.points[i]!);
          const q = tr(e.points[(i + 1) % n]!);
          const bulge = e.bulges[i] ?? 0;
          if (Math.abs(bulge) < 1e-12) {
            line(p, q);
            continue;
          }
          const chord = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (chord <= tol) {
            stats.dropped += 1;
            continue;
          }
          const theta = 4 * Math.atan(Math.abs(bulge));
          const r = chord / (2 * Math.sin(theta / 2));
          const h = chord / 2 / Math.tan(theta / 2);
          const mid: SketchVec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
          const left: SketchVec2 = [-(q[1] - p[1]) / chord, (q[0] - p[0]) / chord];
          const sign = bulge > 0 ? 1 : -1;
          const c: SketchVec2 = [mid[0] + sign * left[0] * h, mid[1] + sign * left[1] * h];
          const [from, to] = bulge > 0 ? [p, q] : [q, p];
          arc(
            c,
            r,
            Math.atan2(from[1] - c[1], from[0] - c[0]),
            Math.atan2(to[1] - c[1], to[0] - c[0]),
          );
        }
        break;
      }
      case 'ellipse': {
        const c = tr(e.center);
        const major: SketchVec2 = [e.major[0] * k, e.major[1] * k];
        const rx = Math.hypot(major[0], major[1]);
        if (!(rx > tol) || !(e.ratio > 0)) {
          stats.dropped += 1;
          break;
        }
        const minor: SketchVec2 = [-major[1] * e.ratio, major[0] * e.ratio];
        const majorPt: SketchVec2 = [c[0] + major[0], c[1] + major[1]];
        const minorPt: SketchVec2 = [c[0] + minor[0], c[1] + minor[1]];
        let sweep = e.end - e.start;
        while (sweep <= 0) sweep += TAU;
        if (sweep >= TAU - 1e-9) {
          out.push({
            id: alloc('e'),
            kind: 'ellipse',
            center: point(c, false),
            major: point(majorPt, false),
            minor: point(minorPt, false),
          });
        } else {
          const at = (u: number): SketchVec2 => [
            c[0] + major[0] * Math.cos(u) + minor[0] * Math.sin(u),
            c[1] + major[1] * Math.cos(u) + minor[1] * Math.sin(u),
          ];
          out.push({
            id: alloc('ea'),
            kind: 'ellipticArc',
            center: point(c, false),
            major: point(majorPt, false),
            minor: point(minorPt, false),
            start: point(at(e.start), true),
            end: point(at(e.start + sweep), true),
          });
        }
        stats.curves += 1;
        break;
      }
      case 'spline': {
        const n = e.controlPoints.length;
        const clamped =
          n >= e.degree + 1 &&
          e.degree >= 1 &&
          e.knots.length === n + e.degree + 1 &&
          validKnots(e.knots, n, e.degree);
        if (clamped && !e.weights) {
          const u0 = e.knots[0]!;
          const u1 = e.knots[e.knots.length - 1]!;
          const knots = e.knots.map((u) => (u - u0) / (u1 - u0));
          const pts = e.controlPoints.map(tr);
          const ids = pts.map((p, i) => point(p, i === 0 || i === n - 1));
          out.push({
            id: alloc('s'),
            kind: 'spline',
            mode: 'control',
            points: ids,
            degree: e.degree,
            knots,
          });
          stats.curves += 1;
        } else if (e.fitPoints.length >= 2 && !e.weights) {
          fitSpline(e.fitPoints.map(tr));
        } else if (n >= 2) {
          const sampled = sampleEntity(e, 12);
          fitSpline((sampled.length >= 2 ? sampled : e.controlPoints).map(tr));
          stats.approximated += 1;
        } else stats.dropped += 1;
        break;
      }
      case 'point':
        point(tr(e.p), false);
        stats.points += 1;
        break;
    }
  }
  return {
    sketch: {
      ...base,
      entities: [...base.entities, ...out],
    },
    stats,
  };
}

function anchorPoints(e: DxfEntity): Vec2[] {
  switch (e.kind) {
    case 'line':
      return [e.a, e.b];
    case 'circle':
    case 'arc':
      return [
        [e.center[0] + e.radius, e.center[1] + e.radius],
        [e.center[0] - e.radius, e.center[1] - e.radius],
      ];
    case 'polyline':
      return e.points;
    case 'spline':
      return [...e.controlPoints, ...e.fitPoints];
    case 'ellipse':
      return [e.center, [e.center[0] + e.major[0], e.center[1] + e.major[1]]];
    case 'point':
      return [e.p];
  }
}

// ---- export -------------------------------------------------------------------------------

function curveToDxf(curve: Curve2, layer: string | undefined): DxfEntity[] {
  const withLayer = <T extends DxfEntity>(e: T): T => (layer ? { ...e, layer } : e);
  switch (curve.kind) {
    case 'line':
      return [withLayer({ kind: 'line', a: curve.a, b: curve.b })];
    case 'arc':
      if (Math.abs(curve.sweep) >= TAU - 1e-9) {
        return [withLayer({ kind: 'circle', center: curve.c, radius: curve.r })];
      }
      return [
        withLayer({
          kind: 'arc',
          center: curve.c,
          radius: curve.r,
          start: curve.sweep >= 0 ? curve.a0 : curve.a0 + curve.sweep,
          end: curve.sweep >= 0 ? curve.a0 + curve.sweep : curve.a0,
        }),
      ];
    case 'ellipse': {
      // DXF: the major axis is the longer one (ratio ≤ 1).
      const swap = curve.ry > curve.rx;
      const rot = swap ? curve.rot + Math.PI / 2 : curve.rot;
      const a = swap ? curve.ry : curve.rx;
      const ratio = swap ? curve.rx / curve.ry : curve.ry / curve.rx;
      const shift = swap ? -Math.PI / 2 : 0;
      const full = Math.abs(curve.sweep) >= TAU - 1e-9;
      const start = full ? 0 : curve.a0 + shift;
      return [
        withLayer({
          kind: 'ellipse',
          center: curve.c,
          major: [a * Math.cos(rot), a * Math.sin(rot)],
          ratio,
          start,
          end: full ? TAU : start + curve.sweep,
        }),
      ];
    }
    case 'bezier': {
      const { poles, knots, degree } = beziersToBspline(curve.segs);
      return [
        withLayer({
          kind: 'spline',
          degree,
          controlPoints: poles,
          knots,
          weights: null,
          fitPoints: [],
          closed: false,
        }),
      ];
    }
  }
}

/** DXF entities of a sketch (sketch coordinates, mm). */
export function sketchToDxfEntities(
  sketch: Pick<SketchData, 'entities'>,
  options: { includeConstruction?: boolean } = {},
): DxfEntity[] {
  const out: DxfEntity[] = [];
  for (const { entity, curve } of sketchCurves(sketch, {
    includeConstruction: options.includeConstruction ?? true,
    includeText: true,
  })) {
    out.push(...curveToDxf(curve, entity.construction ? 'CONSTRUCTION' : undefined));
  }
  // Free points (not part of any curve): sketch points the user placed.
  const used = new Set<string>();
  for (const e of sketch.entities) {
    if (e.kind === 'point') continue;
    for (const v of Object.values(e)) {
      if (typeof v === 'string') used.add(v);
      else if (Array.isArray(v)) for (const item of v) if (typeof item === 'string') used.add(item);
    }
  }
  for (const e of sketch.entities) {
    if (e.kind !== 'point' || used.has(e.id)) continue;
    if (e.construction && options.includeConstruction === false) continue;
    out.push({
      kind: 'point',
      p: [e.x, e.y],
      ...(e.construction ? { layer: 'CONSTRUCTION' } : {}),
    });
  }
  return out;
}

/** The sketch frame a planar face gets (same as a sketch placed on that face). */
export function faceFrame(face: Body['faces'][number]): SketchFrame | null {
  if (face.surface !== 'plane' || !face.normal) return null;
  return frameForFace(face.normal, face.centroid);
}

/**
 * DXF entities of a planar face's boundary edges, in the face's sketch
 * frame: straight edges as LINE, circular edges as CIRCLE/ARC (centre and
 * radius from the kernel's edge polyline), other curves as polylines.
 */
export function faceOutlineToDxfEntities(body: Body, faceIndex: number): DxfEntity[] {
  const face = body.faces[faceIndex];
  if (!face) throw new Error('Face not found');
  const frame = faceFrame(face);
  if (!frame) throw new Error('Only planar faces can be exported as a DXF outline');
  const out: DxfEntity[] = [];
  for (const edgeIndex of face.edgeIndices) {
    const edge = body.edges[edgeIndex];
    if (!edge || edge.segments.length < 6) continue;
    const pts: Vec2[] = [];
    const s = edge.segments;
    for (let i = 0; i < s.length; i += 6) {
      const uv = frameUv(frame, [s[i]!, s[i + 1]!, s[i + 2]!]);
      pts.push([uv.u, uv.v]);
    }
    const last = frameUv(frame, [s[s.length - 3]!, s[s.length - 2]!, s[s.length - 1]!]);
    pts.push([last.u, last.v]);
    const first = pts[0]!;
    const end = pts[pts.length - 1]!;
    const closed = Math.hypot(end[0] - first[0], end[1] - first[1]) < 1e-6;
    if (edge.curve === 'line') {
      out.push({ kind: 'line', a: first, b: end });
      continue;
    }
    if (edge.curve === 'circle' && pts.length >= 3) {
      const i1 = Math.floor(pts.length / 3);
      const i2 = Math.floor((2 * pts.length) / 3);
      const circle = closed
        ? circleThrough(pts[0]!, pts[i1]!, pts[i2]!)
        : circleThrough(first, pts[Math.floor(pts.length / 2)]!, end);
      if (circle) {
        const r = edge.radius ?? circle.r;
        if (closed) {
          out.push({ kind: 'circle', center: circle.c, radius: r });
          continue;
        }
        const mid = pts[Math.floor(pts.length / 2)]!;
        const ccw =
          (mid[0] - first[0]) * (end[1] - first[1]) - (mid[1] - first[1]) * (end[0] - first[0]) > 0;
        const angle = (p: Vec2) => Math.atan2(p[1] - circle.c[1], p[0] - circle.c[0]);
        out.push({
          kind: 'arc',
          center: circle.c,
          radius: r,
          start: ccw ? angle(first) : angle(end),
          end: ccw ? angle(end) : angle(first),
        });
        continue;
      }
    }
    out.push({ kind: 'polyline', points: pts, bulges: pts.map(() => 0), closed: false });
  }
  if (out.length === 0) throw new Error('The face has no boundary edges to export');
  return out;
}
