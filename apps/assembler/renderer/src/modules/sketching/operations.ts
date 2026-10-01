/**
 * Sketch operations on existing geometry (Shapr3D sketch Mirror, Pattern,
 * Fillet/Chamfer): pure edits returning {@link EditResult}s whose copies
 * stay tied to their originals by constraints (symmetric about the mirror
 * line; `translate`/`rotate` pattern constraints; tangent/coincident at a
 * rounded corner), so later dimension edits keep them consistent.
 */
import {
  deleteItems,
  SketchBuilder,
  type EditResult,
  type SnapTarget,
} from '../../foundation/sketch-solver/edits.js';
import {
  add,
  cross,
  dist,
  dot,
  normalize,
  scale,
  sub,
} from '../../foundation/sketch-solver/geometry.js';
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
  type SketchPattern,
  type Vec2,
} from '../../foundation/sketch-solver/types.js';

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

/** One direction of a linear pattern. */
export interface PatternDirection {
  direction: Vec2;
  spacing: number;
  horizontal?: boolean;
  vertical?: boolean;
}

/** The second direction of a linear pattern (Shapr3D: linear in 1–2 directions). */
export interface SecondDirection extends PatternDirection {
  count: number;
}

const MAX_PATTERN_COUNT = 200;
/** Upper bound of copies per pattern (count × count2), so a grid cannot explode the sketch. */
const MAX_PATTERN_INSTANCES = 400;

/** The curve ids among `ids` (what a pattern selects after it was made). */
function curveIdsAmong(b: SketchBuilder, ids: readonly string[]): string[] {
  const curves = new Set(b.entities.filter((e) => e.kind !== 'point').map((e) => e.id));
  return ids.filter((id) => curves.has(id));
}

/** The patterned points (no origin) and copyable curves (no text) of a selection. */
function patternGeometry(
  sketch: SketchData,
  ids: readonly string[],
): { curves: SketchCurve[]; pointIds: string[] } {
  const { curves, points } = selectionGeometry(sketch, ids);
  return {
    curves: curves.filter((c) => c.kind !== 'text'),
    pointIds: points.filter((p) => p !== ORIGIN_ID),
  };
}

/**
 * Adds the copies of a linear pattern: instance (i, j) of every point sits
 * at `point + i·step1 + j·step2`, tied to the previous instance along its
 * direction by a `translate` constraint over that direction's line
 * (`base → h1`, `base → h2`). Returns the created point and curve ids.
 */
function addLinearCopies(
  b: SketchBuilder,
  geometry: { curves: SketchCurve[]; pointIds: string[] },
  positions: ReadonlyMap<string, Vec2>,
  base: string,
  dirs: { handle: string; step: Vec2; count: number }[],
): string[] {
  const [d1, d2] = dirs as [(typeof dirs)[number], (typeof dirs)[number] | undefined];
  const count2 = d2?.count ?? 1;
  const created: string[] = [];
  const identity = new Map(geometry.pointIds.map((p) => [p, p]));
  // instances[i][j]: point id → its copy in instance (i, j).
  const instances: Map<string, string>[][] = [];
  for (let i = 0; i < d1.count; i += 1) {
    instances.push([]);
    for (let j = 0; j < count2; j += 1) {
      if (i === 0 && j === 0) {
        instances[0]!.push(identity);
        continue;
      }
      const previous = j === 0 ? instances[i - 1]![0]! : instances[i]![j - 1]!;
      const handle = j === 0 ? d1.handle : d2!.handle;
      const current = new Map<string, string>();
      for (const p of geometry.pointIds) {
        // The base point's first copy along a direction is that direction's handle itself
        // (a separate point there would make the next translate degenerate for the solver).
        if (p === base && i + j === 1) {
          current.set(p, handle);
          continue;
        }
        const pos = positions.get(p)!;
        const at: Vec2 = add(add(pos, scale(d1.step, i)), d2 ? scale(d2.step, j) : [0, 0]);
        const copy = b.addPoint(at);
        current.set(p, copy);
        created.push(copy);
        b.constrain('translate', [previous.get(p)!, copy, base, handle]);
      }
      instances[i]!.push(current);
      for (const curve of geometry.curves) {
        const id = copyCurve(b, curve, (pid) => current.get(pid) ?? pid, false);
        if (!id) continue;
        created.push(id);
        if (curve.kind === 'circle') b.constrain('equal', [curve.id, id]);
      }
    }
  }
  return created;
}

/** A construction direction line from `base` to a new handle point, with its spacing dimension. */
function addDirectionLine(
  b: SketchBuilder,
  base: string,
  basePos: Vec2,
  dir: PatternDirection,
): { line: string; handle: string; step: Vec2 } {
  const step = scale(normalize(dir.direction), dir.spacing);
  const handle = b.addPoint(add(basePos, step));
  const line = b.addLine(base, handle, true);
  if (dir.horizontal) b.constrain('horizontal', [line], true);
  else if (dir.vertical) b.constrain('vertical', [line], true);
  b.dimensions.push({
    id: b.id('m'),
    name: nextDimensionName(b.data),
    kind: 'distance',
    refs: [line],
    value: dir.spacing,
  });
  return { line, handle, step };
}

/**
 * Linear sketch pattern: `count` instances (the selection included) along
 * `direction`, `spacing` apart — and, with `second`, a grid of
 * `count × second.count` instances along two directions. The first defining
 * point of the selection is the base of a construction line per direction
 * carrying the spacing dimension; every copy is tied to the previous
 * instance by `translate` constraints over that line, so the spacing
 * dimensions and the lines' directions drive the whole pattern. Circles keep
 * an Equal radius. The pattern is recorded (`SketchData.patterns`) so its
 * counts stay editable ({@link editPattern}).
 */
export function linearPattern(
  sketch: SketchData,
  ids: readonly string[],
  count: number,
  direction: Vec2,
  spacing: number,
  options: { horizontal?: boolean; vertical?: boolean; second?: SecondDirection } = {},
): EditResult | null {
  const n = Math.round(count);
  const n2 = options.second ? Math.round(options.second.count) : 1;
  if (n < 2 || n > MAX_PATTERN_COUNT || !(spacing > 0)) return null;
  if (options.second && (n2 < 2 || n2 > MAX_PATTERN_COUNT || !(options.second.spacing > 0))) {
    return null;
  }
  if (n * n2 > MAX_PATTERN_INSTANCES) return null;
  const map = entityMap(sketch);
  const geometry = patternGeometry(sketch, ids);
  if (geometry.pointIds.length === 0) return null;
  const valid = (d: Vec2) => Math.hypot(d[0], d[1]) > 0;
  if (!valid(direction) || (options.second && !valid(options.second.direction))) return null;
  if (options.second) {
    const a = normalize(direction);
    const c = normalize(options.second.direction);
    if (Math.abs(cross(a, c)) < 1e-6) return null; // the two directions must differ
  }
  const b = new SketchBuilder(sketch);
  const base = geometry.pointIds[0]!;
  const positions = new Map(geometry.pointIds.map((p) => [p, pointPos(map, p)!]));
  const basePos = positions.get(base)!;
  const first = addDirectionLine(b, base, basePos, {
    direction,
    spacing,
    ...(options.horizontal ? { horizontal: true } : {}),
    ...(options.vertical ? { vertical: true } : {}),
  });
  const second = options.second ? addDirectionLine(b, base, basePos, options.second) : null;
  const created = addLinearCopies(b, geometry, positions, base, [
    { handle: first.handle, step: first.step, count: n },
    ...(second ? [{ handle: second.handle, step: second.step, count: n2 }] : []),
  ]);
  const record: SketchPattern = {
    id: b.id('pat'),
    kind: 'linear',
    sources: [...ids].filter((id) => map.has(id)),
    count: n,
    ...(second ? { count2: n2 } : {}),
    lines: second ? [first.line, second.line] : [first.line],
    created,
  };
  b.patterns.push(record);
  return b.result([...curveIdsAmong(b, created), first.line, ...(second ? [second.line] : [])]);
}

/** Step angle of a circular pattern: a full turn divides by `count`, less spreads first to last. */
function circularStep(count: number, total: number): number {
  const full = Math.abs(Math.abs(total) - 360) < 1e-9;
  return full ? total / count : total / (count - 1);
}

/** Adds the copies of a circular pattern about point `c`; returns the created ids. */
function addCircularCopies(
  b: SketchBuilder,
  geometry: { curves: SketchCurve[]; pointIds: string[] },
  positions: ReadonlyMap<string, Vec2>,
  c: string,
  cPos: Vec2,
  count: number,
  total: number,
  /** Ties patterned points that lie on the centre to it (only when the pattern is made). */
  tieCentre = true,
): string[] {
  const stepAngle = circularStep(count, total);
  const created: string[] = [];
  let previous = new Map(geometry.pointIds.map((p) => [p, p]));
  for (let k = 1; k < count; k += 1) {
    const current = new Map<string, string>();
    for (const p of geometry.pointIds) {
      const pos = positions.get(p)!;
      if (p === c || dist(pos, cPos) < 1e-9) {
        current.set(p, p === c ? p : c);
        if (p !== c && k === 1 && tieCentre) b.constrain('coincident', [p, c]);
        continue;
      }
      const copy = b.addPoint(rotateAbout(pos, cPos, stepAngle * k));
      current.set(p, copy);
      created.push(copy);
      b.constraints.push({
        id: b.id('k'),
        kind: 'rotate',
        refs: [previous.get(p)!, copy, c],
        value: stepAngle,
      });
    }
    for (const curve of geometry.curves) {
      const id = copyCurve(b, curve, (pid) => current.get(pid) ?? pid, false);
      if (!id) continue;
      created.push(id);
      if (curve.kind === 'circle') b.constrain('equal', [curve.id, id]);
    }
    previous = current;
  }
  return created;
}

/**
 * Circular sketch pattern: `count` instances about `center` spread over
 * `total` degrees (360 = full turn, instances `total / count` apart; less
 * than 360 spreads them from first to last). Copies are tied to the
 * previous instance by `rotate` constraints. Points on the centre are
 * shared. Recorded like {@link linearPattern} (count and angle editable).
 */
export function circularPattern(
  sketch: SketchData,
  ids: readonly string[],
  count: number,
  center: SnapTarget,
  total = 360,
): EditResult | null {
  const n = Math.round(count);
  if (n < 2 || n > MAX_PATTERN_COUNT || !(Math.abs(total) > 0) || Math.abs(total) > 360) {
    return null;
  }
  const map = entityMap(sketch);
  const geometry = patternGeometry(sketch, ids);
  if (geometry.pointIds.length === 0 && geometry.curves.length === 0) return null;
  const b = new SketchBuilder(sketch);
  const c = b.pointFor(center);
  const positions = new Map(geometry.pointIds.map((p) => [p, pointPos(map, p)!]));
  const created = addCircularCopies(b, geometry, positions, c, center.pos, n, total);
  b.patterns.push({
    id: b.id('pat'),
    kind: 'circular',
    sources: [...ids].filter((id) => map.has(id)),
    count: n,
    center: c,
    angle: total,
    created,
  });
  return b.result(curveIdsAmong(b, created));
}

/** The pattern a sketch item belongs to (a source, a copy or a direction line), if any. */
export function patternOf(sketch: SketchData, id: string): SketchPattern | null {
  for (const pattern of sketch.patterns ?? []) {
    if (
      pattern.sources.includes(id) ||
      pattern.created.includes(id) ||
      (pattern.lines ?? []).includes(id)
    ) {
      return pattern;
    }
  }
  return null;
}

/** What can change on an existing pattern. */
export interface PatternPatch {
  count?: number;
  count2?: number;
  /** Circular: total angle, degrees. */
  angle?: number;
}

/**
 * Changes a recorded pattern (Shapr3D: selecting a pattern element brings
 * its badges back): the copies are removed and rebuilt from the sources'
 * current geometry with the new count / second count / total angle; the
 * direction lines, their spacing dimensions and the centre stay. Copies'
 * own extra constraints and geometry attached to removed copies go with
 * them. A reason when the patch does not apply.
 */
export function editPattern(
  sketch: SketchData,
  patternId: string,
  patch: PatternPatch,
): EditResult | { reason: string } {
  const record = (sketch.patterns ?? []).find((p) => p.id === patternId);
  if (!record) return { reason: 'That pattern no longer exists.' };
  const count = patch.count !== undefined ? Math.round(patch.count) : record.count;
  const count2 =
    patch.count2 !== undefined ? Math.round(patch.count2) : (record.count2 ?? undefined);
  if (!(count >= 2 && count <= MAX_PATTERN_COUNT)) return { reason: 'Use 2 to 200 instances.' };
  if (count2 !== undefined) {
    if (record.kind !== 'linear' || (record.lines ?? []).length < 2) {
      return { reason: 'This pattern has one direction.' };
    }
    if (!(count2 >= 2 && count2 <= MAX_PATTERN_COUNT)) return { reason: 'Use 2 to 200 instances.' };
  }
  if (count * (count2 ?? 1) > MAX_PATTERN_INSTANCES) {
    return { reason: `At most ${MAX_PATTERN_INSTANCES} instances per pattern.` };
  }
  const angle = patch.angle ?? record.angle;
  if (
    record.kind === 'circular' &&
    !(angle !== undefined && angle !== 0 && Math.abs(angle) <= 360)
  ) {
    return { reason: 'Use an angle above 0 and up to 360°.' };
  }
  // Remove the old copies (geometry hanging on them goes too), keep the record's frame.
  const cleared = deleteItems(sketch, record.created);
  const map = entityMap(cleared);
  const geometry = patternGeometry(cleared, record.sources);
  if (geometry.pointIds.length === 0 && geometry.curves.length === 0) {
    return { reason: 'The pattern has nothing left to repeat.' };
  }
  const positions = new Map(geometry.pointIds.map((p) => [p, pointPos(map, p)!]));
  const b = new SketchBuilder(cleared);
  let created: string[];
  if (record.kind === 'linear') {
    const lines = (record.lines ?? []).map((id) => map.get(id));
    if (lines.length === 0 || lines.some((l) => l?.kind !== 'line')) {
      return { reason: 'The pattern direction line was deleted.' };
    }
    const [l1, l2] = lines as Extract<SketchEntity, { kind: 'line' }>[];
    const base = l1!.a;
    const basePos = pointPos(map, base);
    if (!basePos || !geometry.pointIds.includes(base)) {
      return { reason: 'The pattern base point is no longer patterned.' };
    }
    const dirOf = (line: Extract<SketchEntity, { kind: 'line' }>, n: number) => ({
      handle: line.b,
      step: sub(pointPos(map, line.b)!, basePos),
      count: n,
    });
    created = addLinearCopies(b, geometry, positions, base, [
      dirOf(l1!, count),
      ...(l2 && count2 !== undefined ? [dirOf(l2, count2)] : []),
    ]);
  } else {
    const centerPos = pointPos(map, record.center!);
    if (!centerPos) return { reason: 'The pattern centre was deleted.' };
    created = addCircularCopies(
      b,
      geometry,
      positions,
      record.center!,
      centerPos,
      count,
      angle!,
      false,
    );
  }
  const index = b.patterns.findIndex((p) => p.id === record.id);
  const next: SketchPattern = {
    ...record,
    sources: record.sources.filter((id) => map.has(id)),
    count,
    ...(count2 !== undefined ? { count2 } : {}),
    ...(record.kind === 'circular' ? { angle: angle! } : {}),
    created,
  };
  if (index >= 0) b.patterns[index] = next;
  else b.patterns.push(next);
  return b.result([...record.sources.filter((id) => map.has(id))]);
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
