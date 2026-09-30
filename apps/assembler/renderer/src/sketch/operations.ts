/**
 * Sketch operations on existing geometry (Shapr3D sketch Mirror, Pattern,
 * Fillet/Chamfer): pure edits returning {@link EditResult}s whose copies
 * stay tied to their originals by constraints (symmetric about the mirror
 * line; `translate`/`rotate` pattern constraints; tangent/coincident at a
 * rounded corner), so later dimension edits keep them consistent.
 */
import {
  SketchBuilder,
  type EditResult,
  type SnapTarget,
} from '../foundation/sketch-solver/edits.js';
import {
  add,
  cross,
  dist,
  dot,
  normalize,
  scale,
  sub,
} from '../foundation/sketch-solver/geometry.js';
import { rotateAbout } from './shapes.js';
import {
  curvePointIds,
  entityMap,
  isCurve,
  nextDimensionName,
  ORIGIN_ID,
  pointPos,
  type SketchCurve,
  type SketchData,
  type SketchEntity,
  type Vec2,
} from '../foundation/sketch-solver/types.js';

/** Curves and loose points of a selection (curves bring their defining points). */
function selectionGeometry(
  sketch: SketchData,
  ids: readonly string[],
): { curves: SketchCurve[]; points: string[] } {
  const map = entityMap(sketch);
  const curves: SketchCurve[] = [];
  const points = new Set<string>();
  for (const id of ids) {
    const e = map.get(id);
    if (isCurve(e)) {
      curves.push(e);
      for (const p of curvePointIds(e)) points.add(p);
    } else if (e?.kind === 'point') points.add(e.id);
  }
  return { curves, points: [...points] };
}

/** A copy of a curve on mapped point ids (`flip` swaps arc ends: a reflection reverses orientation). */
function copyCurve(
  b: SketchBuilder,
  curve: SketchCurve,
  mapPoint: (id: string) => string,
  flip: boolean,
): string | null {
  const construction = curve.construction ? { construction: true } : {};
  switch (curve.kind) {
    case 'line':
      return b.addLine(mapPoint(curve.a), mapPoint(curve.b), curve.construction === true);
    case 'circle':
      return b.addCircle(mapPoint(curve.center), curve.radius, curve.construction === true);
    case 'arc':
      return flip
        ? b.addArc(
            mapPoint(curve.center),
            mapPoint(curve.end),
            mapPoint(curve.start),
            curve.construction === true,
          )
        : b.addArc(
            mapPoint(curve.center),
            mapPoint(curve.start),
            mapPoint(curve.end),
            curve.construction === true,
          );
    case 'ellipse': {
      const id = b.id('e');
      b.entities.push({
        id,
        kind: 'ellipse',
        center: mapPoint(curve.center),
        major: mapPoint(curve.major),
        minor: mapPoint(curve.minor),
        ...construction,
      });
      return id;
    }
    case 'ellipticArc': {
      const id = b.id('ea');
      b.entities.push({
        id,
        kind: 'ellipticArc',
        center: mapPoint(curve.center),
        major: mapPoint(curve.major),
        minor: mapPoint(curve.minor),
        start: mapPoint(flip ? curve.end : curve.start),
        end: mapPoint(flip ? curve.start : curve.end),
        ...construction,
      });
      return id;
    }
    case 'spline': {
      const id = b.id('s');
      b.entities.push({
        ...curve,
        id,
        points: curve.points.map(mapPoint),
        ...(curve.handles
          ? {
              handles: curve.handles.map((h) => (h ? mapPoint(h) : null)) as [
                string | null,
                string | null,
              ],
            }
          : {}),
      });
      return id;
    }
    case 'text':
      return null;
  }
}

// ---- mirror ----------------------------------------------------------------------------

function reflect(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const d = normalize(sub(b, a));
  const rel = sub(p, a);
  const along = scale(d, dot(rel, d));
  const perp = sub(rel, along);
  return add(a, sub(along, perp));
}

/**
 * Mirrors the selected geometry about line `axisId`: every point gets a
 * copy constrained symmetric to it about the line (points on the line are
 * reused), curves are copied on the mirrored points (circles keep an Equal
 * radius). Text is not mirrored. `null` when nothing can be mirrored.
 */
export function mirrorGeometry(
  sketch: SketchData,
  ids: readonly string[],
  axisId: string,
): EditResult | null {
  const map = entityMap(sketch);
  const axis = map.get(axisId);
  if (axis?.kind !== 'line') return null;
  const a = pointPos(map, axis.a);
  const bPos = pointPos(map, axis.b);
  if (!a || !bPos || dist(a, bPos) < 1e-9) return null;
  const { curves, points } = selectionGeometry(
    sketch,
    ids.filter((id) => id !== axisId),
  );
  const mirrored = curves.filter((c) => c.kind !== 'text');
  if (mirrored.length === 0 && points.length === 0) return null;
  const b = new SketchBuilder(sketch);
  const tol = 1e-6 * Math.max(1, dist(a, bPos));
  const copies = new Map<string, string>();
  const mapPoint = (id: string): string => {
    const known = copies.get(id);
    if (known) return known;
    const p = pointPos(map, id);
    if (!p || id === ORIGIN_ID) return id;
    const d = normalize(sub(bPos, a));
    const off = Math.abs(cross(d, sub(p, a)));
    if (off < tol || id === axis.a || id === axis.b) {
      copies.set(id, id);
      return id;
    }
    const copy = b.addPoint(reflect(p, a, bPos));
    b.constrain('symmetric', [id, copy, axisId]);
    copies.set(id, copy);
    return copy;
  };
  const created: string[] = [];
  const usedPoints = new Set(mirrored.flatMap((c) => curvePointIds(c)));
  for (const p of points) if (!usedPoints.has(p)) created.push(mapPoint(p));
  for (const curve of mirrored) {
    const id = copyCurve(b, curve, mapPoint, true);
    if (!id) continue;
    created.push(id);
    if (curve.kind === 'circle') b.constrain('equal', [curve.id, id]);
  }
  return b.result(created);
}

// ---- patterns --------------------------------------------------------------------------

/**
 * Linear sketch pattern: `count` instances (the selection included) along
 * `direction`, `spacing` apart. The first defining point of the selection
 * and its first copy span a construction line carrying the spacing
 * dimension; every copy is tied to the previous instance by `translate`
 * constraints over that line, so the spacing dimension and the line's
 * direction drive the whole pattern. Circles keep an Equal radius.
 */
export function linearPattern(
  sketch: SketchData,
  ids: readonly string[],
  count: number,
  direction: Vec2,
  spacing: number,
  options: { horizontal?: boolean; vertical?: boolean } = {},
): EditResult | null {
  const n = Math.round(count);
  if (n < 2 || !(spacing > 0)) return null;
  const map = entityMap(sketch);
  const { curves, points } = selectionGeometry(sketch, ids);
  const copyable = curves.filter((c) => c.kind !== 'text');
  const pointIds = points.filter((p) => p !== ORIGIN_ID);
  if (pointIds.length === 0) return null;
  const d = normalize(direction);
  if (!(Math.hypot(d[0], d[1]) > 0)) return null;
  const b = new SketchBuilder(sketch);
  const base = pointIds[0]!;
  const step = scale(d, spacing);
  // Instance k of every point; instance 0 is the original.
  const instances: Map<string, string>[] = [new Map(pointIds.map((p) => [p, p]))];
  const created: string[] = [];
  for (let k = 1; k < n; k += 1) {
    const current = new Map<string, string>();
    for (const p of pointIds) {
      const pos = pointPos(map, p)!;
      current.set(p, b.addPoint(add(pos, scale(step, k))));
    }
    instances.push(current);
  }
  // The direction line: from the base point to its first copy.
  const handle = instances[1]!.get(base)!;
  const line = b.addLine(base, handle, true);
  if (options.horizontal) b.constrain('horizontal', [line], true);
  else if (options.vertical) b.constrain('vertical', [line], true);
  const spacingId = b.id('m');
  b.dimensions.push({
    id: spacingId,
    name: nextDimensionName(b.data),
    kind: 'distance',
    refs: [line],
    value: spacing,
  });
  for (let k = 1; k < n; k += 1) {
    for (const p of pointIds) {
      if (k === 1 && p === base) continue; // the handle itself
      b.constrain('translate', [instances[k - 1]!.get(p)!, instances[k]!.get(p)!, base, handle]);
    }
    for (const curve of copyable) {
      const id = copyCurve(b, curve, (pid) => instances[k]!.get(pid) ?? pid, false);
      if (!id) continue;
      created.push(id);
      if (curve.kind === 'circle') b.constrain('equal', [curve.id, id]);
    }
  }
  return b.result([...created, line]);
}

/**
 * Circular sketch pattern: `count` instances about `center` spread over
 * `total` degrees (360 = full turn, instances `total / count` apart; less
 * than 360 spreads them from first to last). Copies are tied to the
 * previous instance by `rotate` constraints. Points on the centre are
 * shared.
 */
export function circularPattern(
  sketch: SketchData,
  ids: readonly string[],
  count: number,
  center: SnapTarget,
  total = 360,
): EditResult | null {
  const n = Math.round(count);
  if (n < 2 || !(Math.abs(total) > 0)) return null;
  const map = entityMap(sketch);
  const { curves, points } = selectionGeometry(sketch, ids);
  const copyable = curves.filter((c) => c.kind !== 'text');
  const pointIds = points.filter((p) => p !== ORIGIN_ID);
  if (pointIds.length === 0 && copyable.length === 0) return null;
  const full = Math.abs(Math.abs(total) - 360) < 1e-9;
  const stepAngle = full ? total / n : total / (n - 1);
  const b = new SketchBuilder(sketch);
  const c = b.pointFor(center);
  const cPos = center.pos;
  const created: string[] = [];
  let previous = new Map(pointIds.map((p) => [p, p]));
  for (let k = 1; k < n; k += 1) {
    const current = new Map<string, string>();
    for (const p of pointIds) {
      const pos = pointPos(map, p)!;
      if (p === c || dist(pos, cPos) < 1e-9) {
        current.set(p, p === c ? p : c);
        if (p !== c) b.constrain('coincident', [p, c]);
        continue;
      }
      const copy = b.addPoint(rotateAbout(pos, cPos, stepAngle * k));
      current.set(p, copy);
      b.constraints.push({
        id: b.id('k'),
        kind: 'rotate',
        refs: [previous.get(p)!, copy, c],
        value: stepAngle,
      });
    }
    for (const curve of copyable) {
      const id = copyCurve(b, curve, (pid) => current.get(pid) ?? pid, false);
      if (!id) continue;
      created.push(id);
      if (curve.kind === 'circle') b.constrain('equal', [curve.id, id]);
    }
    previous = current;
  }
  return b.result(created);
}

// ---- fillet / chamfer ------------------------------------------------------------------

/** The two lines meeting at a corner point, with their far ends, or a reason why not. */
export function cornerLines(
  sketch: SketchData,
  pointId: string,
): { l1: string; l2: string; a: string; b: string } | { reason: string } {
  const map = entityMap(sketch);
  const users = sketch.entities.filter(
    (e): e is SketchEntity & { kind: 'line' } =>
      e.kind === 'line' && (e.a === pointId || e.b === pointId),
  );
  const others = sketch.entities.filter(
    (e) => isCurve(e) && e.kind !== 'line' && curvePointIds(e).includes(pointId),
  );
  if (users.length !== 2 || others.length > 0) {
    return { reason: 'Click a corner where exactly two lines meet.' };
  }
  const [l1, l2] = users as [
    Extract<SketchEntity, { kind: 'line' }>,
    Extract<SketchEntity, { kind: 'line' }>,
  ];
  const a = l1.a === pointId ? l1.b : l1.a;
  const b = l2.a === pointId ? l2.b : l2.a;
  const v = pointPos(map, pointId)!;
  const u1 = normalize(sub(pointPos(map, a)!, v));
  const u2 = normalize(sub(pointPos(map, b)!, v));
  if (Math.abs(cross(u1, u2)) < 1e-6) return { reason: 'The lines are collinear.' };
  return { l1: l1.id, l2: l2.id, a, b };
}

/** Largest fillet radius / chamfer distance that fits the corner (the shorter line). */
export function cornerLimit(
  sketch: SketchData,
  pointId: string,
  mode: 'fillet' | 'chamfer',
): number {
  const lines = cornerLines(sketch, pointId);
  if ('reason' in lines) return 0;
  const map = entityMap(sketch);
  const v = pointPos(map, pointId)!;
  const pa = pointPos(map, lines.a)!;
  const pb = pointPos(map, lines.b)!;
  const shortest = Math.min(dist(v, pa), dist(v, pb));
  if (mode === 'chamfer') return shortest;
  const theta = Math.acos(
    Math.max(-1, Math.min(1, dot(normalize(sub(pa, v)), normalize(sub(pb, v))))),
  );
  return shortest * Math.tan(theta / 2);
}

/**
 * Rounds (`fillet`, radius `size`) or bevels (`chamfer`, setback `size`)
 * the corner at `pointId` between two lines. The lines are shortened to the
 * new tangent/set-back points; the corner point stays as a virtual sharp
 * (on both lines' extensions) so dimensions to it survive. Fillet: an arc
 * tangent to both lines with a radius dimension. Chamfer: a line with
 * equal construction set-backs and a set-back dimension.
 */
export function roundCorner(
  sketch: SketchData,
  pointId: string,
  size: number,
  mode: 'fillet' | 'chamfer',
): EditResult | { reason: string } {
  const lines = cornerLines(sketch, pointId);
  if ('reason' in lines) return lines;
  if (!(size > 0)) return { reason: 'Enter a size above 0.' };
  const map = entityMap(sketch);
  const v = pointPos(map, pointId)!;
  const pa = pointPos(map, lines.a)!;
  const pb = pointPos(map, lines.b)!;
  const u1 = normalize(sub(pa, v));
  const u2 = normalize(sub(pb, v));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  const setback = mode === 'fillet' ? size / Math.tan(theta / 2) : size;
  if (setback >= dist(v, pa) - 1e-6 || setback >= dist(v, pb) - 1e-6) {
    return {
      reason: `Too large for this corner (at most ${Math.round(cornerLimit(sketch, pointId, mode) * 100) / 100} mm).`,
    };
  }
  const b = new SketchBuilder(sketch);
  const t1 = b.addPoint(add(v, scale(u1, setback)));
  const t2 = b.addPoint(add(v, scale(u2, setback)));
  const construction = (id: string) =>
    sketch.entities.find((e) => e.id === id)?.construction === true;
  b.entities = b.entities.map((e) => {
    if (e.id === lines.l1 && e.kind === 'line')
      return e.a === pointId ? { ...e, a: t1 } : { ...e, b: t1 };
    if (e.id === lines.l2 && e.kind === 'line')
      return e.a === pointId ? { ...e, a: t2 } : { ...e, b: t2 };
    return e;
  });
  // The corner stays as the virtual sharp on both line extensions.
  b.constrain('pointOnObject', [pointId, lines.l1]);
  b.constrain('pointOnObject', [pointId, lines.l2]);
  // A length dimension of a shortened line keeps measuring the edge up to the virtual sharp.
  b.dimensions = b.dimensions.map((d) => {
    const linear =
      d.kind === 'distance' || d.kind === 'horizontalDistance' || d.kind === 'verticalDistance';
    if (!linear || d.refs.length !== 1) return d;
    if (d.refs[0] === lines.l1) return { ...d, refs: [lines.a, pointId] };
    if (d.refs[0] === lines.l2) return { ...d, refs: [lines.b, pointId] };
    return d;
  });
  const created: string[] = [];
  const bothConstruction = construction(lines.l1) && construction(lines.l2);
  if (mode === 'fillet') {
    const bisector = normalize(add(u1, u2));
    const center = add(v, scale(bisector, size / Math.sin(theta / 2)));
    const c = b.addPoint(center);
    const ccw =
      cross(sub(add(v, scale(u1, setback)), center), sub(add(v, scale(u2, setback)), center)) > 0;
    const arc = ccw ? b.addArc(c, t1, t2, bothConstruction) : b.addArc(c, t2, t1, bothConstruction);
    b.constrain('tangent', [lines.l1, arc]);
    b.constrain('tangent', [lines.l2, arc]);
    b.dimensions.push({
      id: b.id('m'),
      name: nextDimensionName(b.data),
      kind: 'radius',
      refs: [arc],
      value: size,
    });
    created.push(arc);
  } else {
    const bevel = b.addLine(t1, t2, bothConstruction);
    const s1 = b.addLine(pointId, t1, true);
    const s2 = b.addLine(pointId, t2, true);
    b.constrain('equal', [s1, s2]);
    b.dimensions.push({
      id: b.id('m'),
      name: nextDimensionName(b.data),
      kind: 'distance',
      refs: [s1],
      value: size,
    });
    created.push(bevel);
  }
  return b.result(created);
}
