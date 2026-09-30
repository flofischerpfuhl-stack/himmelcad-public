/**
 * Measuring sketch geometry for dimensions (current value of a new
 * dimension, label text) and the screen layout of dimension annotations
 * and constraint glyphs. Pure; sketch (u, v) millimetres.
 */
import {
  add,
  closestOnCurve,
  dist,
  dot,
  entityCurve,
  normalize,
  pointAt,
  scale,
  sub,
} from './geometry.js';
import {
  entityMap,
  isCurve,
  pointPos,
  radiusOf,
  type SketchConstraint,
  type SketchData,
  type SketchDimension,
  type SketchDimensionKind,
  type SketchEntity,
  type Vec2,
} from './types.js';

function lineEnds(map: ReadonlyMap<string, SketchEntity>, id: string): [Vec2, Vec2] | null {
  const e = map.get(id);
  if (e?.kind !== 'line') return null;
  const a = pointPos(map, e.a);
  const b = pointPos(map, e.b);
  return a && b ? [a, b] : null;
}

function twoPoints(
  map: ReadonlyMap<string, SketchEntity>,
  refs: readonly string[],
): [Vec2, Vec2] | null {
  if (refs.length === 1) return lineEnds(map, refs[0]!);
  const a = pointPos(map, refs[0]!);
  const b = pointPos(map, refs[1]!);
  return a && b ? [a, b] : null;
}

/**
 * The segment a `distance` dimension measures: a line's ends, two points,
 * a point and its foot on a line, or a point of the first line and its foot
 * on the second (parallel lines).
 */
function distancePair(
  map: ReadonlyMap<string, SketchEntity>,
  refs: readonly string[],
): [Vec2, Vec2] | null {
  const pp = twoPoints(map, refs);
  if (pp) return pp;
  const [r0 = '', r1 = ''] = refs;
  const foot = (p: Vec2, l: [Vec2, Vec2]): Vec2 => {
    const dir = normalize(sub(l[1], l[0]));
    return add(l[0], scale(dir, dot(sub(p, l[0]), dir)));
  };
  const l0 = lineEnds(map, r0);
  const l1 = lineEnds(map, r1);
  const p0 = pointPos(map, r0);
  const p1 = pointPos(map, r1);
  if (p0 && l1) return [foot(p0, l1), p0];
  if (l0 && p1) return [foot(p1, l0), p1];
  if (l0 && l1) return [foot(l0[0], l1), l0[0]];
  return null;
}

/** Current value of a dimension of `kind` on `refs` (mm or degrees), or `null` if not measurable. */
export function measure(
  sketch: SketchData,
  kind: SketchDimensionKind,
  refs: readonly string[],
): number | null {
  const map = entityMap(sketch);
  switch (kind) {
    case 'distance': {
      const pair = distancePair(map, refs);
      return pair ? dist(pair[0], pair[1]) : null;
    }
    case 'horizontalDistance':
    case 'verticalDistance': {
      const pp = twoPoints(map, refs);
      if (!pp) return null;
      const axis = kind === 'horizontalDistance' ? 0 : 1;
      return Math.abs(pp[1][axis] - pp[0][axis]);
    }
    case 'radius':
    case 'diameter': {
      const e = map.get(refs[0] ?? '');
      if (e?.kind !== 'circle' && e?.kind !== 'arc') return null;
      const r = radiusOf(map, e);
      return kind === 'radius' ? r : 2 * r;
    }
    case 'angle': {
      const l1 = lineEnds(map, refs[0] ?? '');
      const l2 = lineEnds(map, refs[1] ?? '');
      if (!l1 || !l2) return null;
      const d1 = normalize(sub(l1[1], l1[0]));
      const d2 = normalize(sub(l2[1], l2[0]));
      return (Math.acos(Math.max(-1, Math.min(1, dot(d1, d2)))) * 180) / Math.PI;
    }
  }
}

/** Display text of a dimension value. */
export function formatDimension(d: Pick<SketchDimension, 'kind' | 'value'>): string {
  const v = Math.round(d.value * 100) / 100;
  if (d.kind === 'angle') return `${v}°`;
  if (d.kind === 'diameter') return `Ø ${v}`;
  if (d.kind === 'radius') return `R ${v}`;
  return `${v}`;
}

export interface DimensionLayout {
  /** Label centre. */
  anchor: Vec2;
  /** Extension and dimension line segments. */
  lines: [Vec2, Vec2][];
}

/**
 * Where to draw a dimension: linear dimensions offset perpendicular to the
 * measured segment (by `offset`, default `defaultOffset`), radial ones on
 * the circle, angles near the vertex. Screen-independent (mm).
 */
export function dimensionLayout(
  sketch: SketchData,
  d: SketchDimension,
  defaultOffset: number,
): DimensionLayout | null {
  const map = entityMap(sketch);
  const offset = d.offset ?? defaultOffset;
  if (d.kind === 'radius' || d.kind === 'diameter') {
    const e = map.get(d.refs[0] ?? '');
    if (!isCurve(e) || e.kind === 'line') return null;
    const curve = entityCurve(map, e);
    if (!curve || curve.kind !== 'arc') return null;
    // `along`: where on the circle/arc the leader sits; `offset`: label distance outside it.
    const at = pointAt(curve, d.along ?? (e.kind === 'arc' ? 0.5 : 0.125));
    const dir = normalize(sub(at, curve.c));
    const from = d.kind === 'diameter' ? sub(curve.c, scale(dir, curve.r)) : curve.c;
    const out = d.offset ?? Math.abs(defaultOffset) * 0.8;
    const anchor = add(at, scale(dir, out));
    return { anchor, lines: out > 0 ? [[from, anchor]] : [[from, at]] };
  }
  if (d.kind === 'angle') {
    const a = map.get(d.refs[0] ?? '');
    const b = map.get(d.refs[1] ?? '');
    if (a?.kind !== 'line' || b?.kind !== 'line') return null;
    const la = [pointPos(map, a.a)!, pointPos(map, a.b)!] as const;
    const lb = [pointPos(map, b.a)!, pointPos(map, b.b)!] as const;
    const shared = [la[0], la[1]].find((p) => dist(p, lb[0]) < 1e-6 || dist(p, lb[1]) < 1e-6);
    const vertex = shared ?? scale(add(add(la[0], la[1]), add(lb[0], lb[1])), 0.25);
    const mid = scale(add(add(la[0], la[1]), add(lb[0], lb[1])), 0.25);
    const dir = dist(mid, vertex) > 1e-9 ? normalize(sub(mid, vertex)) : ([1, 0] as Vec2);
    const reach = d.offset ?? Math.abs(defaultOffset) * 2;
    const rotated = d.along !== undefined ? rotateVec(dir, (d.along - 0.5) * Math.PI) : dir;
    return { anchor: add(vertex, scale(rotated, reach)), lines: [] };
  }
  const pair = d.kind === 'distance' ? distancePair(map, d.refs) : twoPoints(map, d.refs);
  if (!pair) return null;
  const a = pair[0];
  let b = pair[1];
  if (d.kind === 'horizontalDistance') b = [b[0], a[1]];
  if (d.kind === 'verticalDistance') b = [a[0], b[1]];
  const dir = dist(a, b) > 1e-9 ? normalize(sub(b, a)) : ([1, 0] as Vec2);
  const n: Vec2 = [-dir[1], dir[0]];
  const a2 = add(a, scale(n, offset));
  const b2 = add(b, scale(n, offset));
  const lines: [Vec2, Vec2][] = [
    [pair[0], a2],
    [pair[1], add(pair[1], sub(b2, b))],
    [a2, b2],
  ];
  const along = d.along ?? 0.5;
  const anchor = add(a2, scale(sub(b2, a2), along));
  // A label moved beyond the ends gets its dimension line extended to it.
  if (along < 0) lines.push([anchor, a2]);
  if (along > 1) lines.push([b2, anchor]);
  return { anchor, lines };
}

function rotateVec(v: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}

/**
 * Label layout (`offset`, `along`) that puts a dimension's label at
 * `anchor` (sketch mm) — the inverse of {@link dimensionLayout}, used when
 * the label is Shift+dragged.
 */
export function layoutForAnchor(
  sketch: SketchData,
  d: SketchDimension,
  anchor: Vec2,
): { offset: number; along: number } | null {
  const map = entityMap(sketch);
  if (d.kind === 'radius' || d.kind === 'diameter') {
    const e = map.get(d.refs[0] ?? '');
    if (!isCurve(e) || e.kind === 'line') return null;
    const curve = entityCurve(map, e);
    if (!curve || curve.kind !== 'arc') return null;
    const angle = Math.atan2(anchor[1] - curve.c[1], anchor[0] - curve.c[0]);
    const onCurve: Vec2 = [
      curve.c[0] + curve.r * Math.cos(angle),
      curve.c[1] + curve.r * Math.sin(angle),
    ];
    const along = closestOnCurve(curve, onCurve).t;
    return { offset: Math.max(0, dist(anchor, curve.c) - curve.r), along };
  }
  if (d.kind === 'angle') {
    const base = dimensionLayout(sketch, { ...d, offset: 1, along: 0.5 }, 1);
    if (!base) return null;
    // `base.anchor` is one unit from the vertex along the bisector.
    const a = map.get(d.refs[0] ?? '');
    const b = map.get(d.refs[1] ?? '');
    if (a?.kind !== 'line' || b?.kind !== 'line') return null;
    const la = [pointPos(map, a.a)!, pointPos(map, a.b)!] as const;
    const lb = [pointPos(map, b.a)!, pointPos(map, b.b)!] as const;
    const shared = [la[0], la[1]].find((p) => dist(p, lb[0]) < 1e-6 || dist(p, lb[1]) < 1e-6);
    const vertex = shared ?? scale(add(add(la[0], la[1]), add(lb[0], lb[1])), 0.25);
    const bisector = normalize(sub(base.anchor, vertex));
    const rel = sub(anchor, vertex);
    const turn = Math.atan2(bisector[0] * rel[1] - bisector[1] * rel[0], dot(bisector, rel));
    return { offset: Math.max(1e-3, Math.hypot(rel[0], rel[1])), along: turn / Math.PI + 0.5 };
  }
  const pair = d.kind === 'distance' ? distancePair(map, d.refs) : twoPoints(map, d.refs);
  if (!pair) return null;
  const a = pair[0];
  let b = pair[1];
  if (d.kind === 'horizontalDistance') b = [b[0], a[1]];
  if (d.kind === 'verticalDistance') b = [a[0], b[1]];
  const length = dist(a, b);
  const dir = length > 1e-9 ? normalize(sub(b, a)) : ([1, 0] as Vec2);
  const n: Vec2 = [-dir[1], dir[0]];
  const rel = sub(anchor, a);
  return { offset: dot(rel, n), along: length > 1e-9 ? dot(rel, dir) / length : 0.5 };
}

/** Anchor position of a constraint glyph (near the constrained geometry). */
export function constraintAnchor(sketch: SketchData, c: SketchConstraint): Vec2 | null {
  const map = entityMap(sketch);
  const anchors: Vec2[] = [];
  for (const ref of c.refs.slice(0, 2)) {
    const p = pointPos(map, ref);
    if (p) {
      anchors.push(p);
      continue;
    }
    const e = map.get(ref);
    if (!isCurve(e)) continue;
    const curve = entityCurve(map, e);
    if (curve) anchors.push(pointAt(curve, e.kind === 'circle' ? 0.375 : 0.5));
  }
  if (anchors.length === 0) return null;
  return anchors.length === 1 || c.kind === 'coincident' || c.kind === 'fixed'
    ? anchors[0]!
    : scale(add(anchors[0]!, anchors[1]!), 0.5);
}
