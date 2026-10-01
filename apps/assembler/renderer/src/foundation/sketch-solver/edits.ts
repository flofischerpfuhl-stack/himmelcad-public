/**
 * Pure sketch edits used by the tools and commands: resolving a snapped
 * position into a point (reusing or constraining), garbage collection of
 * dangling points/constraints, deletion, construction toggling, trimming
 * and offsetting. Every function returns new {@link SketchData}; nothing
 * here solves — the session runs the solver on the result.
 */
import {
  add,
  circleThrough,
  closestOnCurve,
  cross,
  curvatureAt,
  curveBox,
  dist,
  entityCurve,
  intersectCurves,
  isClosedCurve,
  isFullCircle,
  normalize,
  paramOf,
  pointAt,
  pointInPolygon,
  reverseCurve,
  sampleCurve,
  scale,
  sketchCurves,
  sub,
  subCurve,
  tangentAt,
  type Curve2,
} from './geometry.js';
import { beziersToBspline } from './spline.js';
import {
  curveEnds,
  curvePointIds,
  entityMap,
  idAllocator,
  isCurve,
  ORIGIN_ID,
  pointPos,
  type SketchConstraint,
  type SketchConstraintKind,
  type SketchData,
  type SketchEntity,
  type Vec2,
} from './types.js';

/** Where a click landed after snapping/inference (see `inference.ts`). */
export interface SnapTarget {
  pos: Vec2;
  /** An existing point (or {@link ORIGIN_ID}) the click snapped to. */
  pointId?: string;
  /** The click lies on this curve (point-on-object). */
  curveId?: string;
  /** The click is the midpoint of this line. */
  midpointOf?: string;
}

/** A sketch being edited plus bookkeeping for the session. */
export interface EditResult {
  sketch: SketchData;
  /**
   * Automatically inferred constraints: dropped (instead of rejecting the
   * edit) when they turn out redundant or conflicting.
   */
  optional: string[];
  /** Ids to select after the edit. */
  select?: string[];
  /**
   * Constraints that only steer this solve (e.g. the item that stays put
   * when a constraint is added): removed from the solved sketch.
   */
  transient?: string[];
}

/** Mutable edit builder: accumulates entities/constraints with fresh ids. */
export class SketchBuilder {
  private readonly alloc: (prefix: string) => string;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
  dimensions: SketchData['dimensions'];
  readonly optional: string[] = [];
  /** Projections and region memory, carried through unchanged. */
  private readonly extras: Pick<SketchData, 'projections' | 'regionMemory'>;
  /** Pattern records (edited by the pattern operations). */
  patterns: NonNullable<SketchData['patterns']>;

  constructor(sketch: SketchData) {
    this.alloc = idAllocator(sketch);
    this.entities = [...sketch.entities];
    this.constraints = [...sketch.constraints];
    this.dimensions = [...sketch.dimensions];
    this.patterns = [...(sketch.patterns ?? [])];
    this.extras = {
      ...(sketch.projections ? { projections: sketch.projections } : {}),
      ...(sketch.regionMemory ? { regionMemory: sketch.regionMemory } : {}),
    };
  }

  get data(): SketchData {
    return {
      ...this.extras,
      entities: this.entities,
      constraints: this.constraints,
      dimensions: this.dimensions,
      ...(this.patterns.length > 0 ? { patterns: this.patterns } : {}),
    };
  }

  id(prefix: string): string {
    return this.alloc(prefix);
  }

  addPoint(pos: Vec2): string {
    const id = this.alloc('p');
    this.entities.push({ id, kind: 'point', x: pos[0], y: pos[1] });
    return id;
  }

  addLine(a: string, b: string, construction = false): string {
    const id = this.alloc('l');
    this.entities.push({ id, kind: 'line', a, b, ...(construction ? { construction } : {}) });
    return id;
  }

  addCircle(center: string, radius: number, construction = false): string {
    const id = this.alloc('c');
    this.entities.push({
      id,
      kind: 'circle',
      center,
      radius,
      ...(construction ? { construction } : {}),
    });
    return id;
  }

  addArc(center: string, start: string, end: string, construction = false): string {
    const id = this.alloc('a');
    this.entities.push({
      id,
      kind: 'arc',
      center,
      start,
      end,
      ...(construction ? { construction } : {}),
    });
    return id;
  }

  constrain(kind: SketchConstraintKind, refs: string[], optional = false): string {
    const id = this.alloc('k');
    this.constraints.push({ id, kind, refs });
    if (optional) this.optional.push(id);
    return id;
  }

  /**
   * Point for a snapped click: the snapped existing point itself, else a
   * new point constrained to what it snapped to (origin → coincident,
   * midpoint → midpoint, curve → point-on-object).
   */
  pointFor(snap: SnapTarget): string {
    if (snap.pointId && snap.pointId !== ORIGIN_ID) return snap.pointId;
    const id = this.addPoint(snap.pos);
    if (snap.pointId === ORIGIN_ID) this.constrain('coincident', [id, ORIGIN_ID]);
    else if (snap.midpointOf) this.constrain('midpoint', [id, snap.midpointOf]);
    else if (snap.curveId) this.constrain('pointOnObject', [id, snap.curveId]);
    return id;
  }

  result(select?: string[]): EditResult {
    return {
      sketch: removeDangling(this.data),
      optional: this.optional,
      ...(select ? { select } : {}),
    };
  }
}

/**
 * Removes constraints/dimensions whose references are gone and points that
 * neither a curve uses nor a constraint ties to a curve (e.g. a rectangle's
 * centre point on its diagonal stays; a point only coincident with the
 * origin is dropped with its constraint).
 */
export function removeDangling(sketch: SketchData): SketchData {
  let current = sketch;
  for (;;) {
    const curveIds = new Set(current.entities.filter(isCurve).map((e) => e.id));
    const used = new Set<string>();
    for (const e of current.entities)
      if (isCurve(e)) for (const id of curvePointIds(e)) used.add(id);
    for (const c of current.constraints) {
      // Pattern constraints tie copies to their base/centre points: those points stay.
      const pattern = c.kind === 'translate' || c.kind === 'rotate';
      if (pattern || c.refs.some((r) => curveIds.has(r))) for (const r of c.refs) used.add(r);
    }
    // A pattern record keeps its centre and patterned loose points while its copies are rebuilt.
    for (const p of current.patterns ?? []) {
      if (p.center) used.add(p.center);
      for (const id of p.sources) used.add(id);
    }
    const entities = current.entities.filter((e) => e.kind !== 'point' || used.has(e.id));
    const alive = new Set(entities.map((e) => e.id));
    alive.add(ORIGIN_ID);
    const constraints = current.constraints.filter((c) => c.refs.every((r) => alive.has(r)));
    const dimensions = current.dimensions.filter((d) => d.refs.every((r) => alive.has(r)));
    const next: SketchData = { ...current, entities, constraints, dimensions };
    if (current.projections) {
      // A projection keeps the entities that still exist; one without any is removed.
      const projections = current.projections
        .map((p) => ({ ...p, entities: p.entities.filter((id) => alive.has(id)) }))
        .filter((p) => p.entities.length > 0);
      if (projections.length > 0) next.projections = projections;
      else delete next.projections;
    }
    if (current.patterns) {
      // A pattern stays editable while its sources and its direction lines / centre exist.
      const patterns = current.patterns
        .map((p) => ({
          ...p,
          sources: p.sources.filter((id) => alive.has(id)),
          created: p.created.filter((id) => alive.has(id)),
        }))
        .filter(
          (p) =>
            p.sources.length > 0 &&
            (p.lines ?? []).every((id) => alive.has(id)) &&
            (p.center === undefined || alive.has(p.center)),
        );
      if (patterns.length > 0) next.patterns = patterns;
      else delete next.patterns;
    }
    if (
      entities.length === current.entities.length &&
      constraints.length === current.constraints.length &&
      dimensions.length === current.dimensions.length
    ) {
      return next;
    }
    current = next;
  }
}

/** Deletes entities (curves drop their now-unused points), constraints and dimensions by id. */
export function deleteItems(sketch: SketchData, ids: readonly string[]): SketchData {
  const remove = new Set(ids);
  // Deleting a point deletes the curves using it.
  for (const e of sketch.entities) {
    if (isCurve(e) && curvePointIds(e).some((p) => remove.has(p))) remove.add(e.id);
  }
  return removeDangling({
    ...sketch,
    entities: sketch.entities.filter((e) => !remove.has(e.id)),
    constraints: sketch.constraints.filter((c) => !remove.has(c.id)),
    dimensions: sketch.dimensions.filter((d) => !remove.has(d.id)),
  });
}

/** Toggles construction on the given curves (all become construction unless all already are). */
export function toggleConstruction(sketch: SketchData, ids: readonly string[]): SketchData {
  const targets = sketch.entities.filter((e) => isCurve(e) && ids.includes(e.id));
  const makeConstruction = !targets.every((e) => e.construction);
  return {
    ...sketch,
    entities: sketch.entities.map((e) => {
      if (!isCurve(e) || !ids.includes(e.id)) return e;
      if (makeConstruction) return { ...e, construction: true };
      const { construction: _c, ...rest } = e;
      return rest as SketchEntity;
    }),
  };
}

// ---- trim ------------------------------------------------------------------------------

/**
 * Shapr3D Trim: removes the piece of curve `curveId` between the
 * intersections (with every other curve) around `at`. Lines and arcs
 * split into up to two parts (the first keeps the entity id); a circle
 * becomes an arc (same id). New end points are attached to the curve they
 * were cut at with (optional) point-on-object constraints. A curve without
 * intersections is deleted.
 */
export function trimAt(sketch: SketchData, curveId: string, at: Vec2): EditResult | null {
  const map = entityMap(sketch);
  const entity = map.get(curveId);
  if (!isCurve(entity) || entity.kind === 'text') return null;
  const curve = entityCurve(map, entity);
  if (!curve) return null;
  const cuts: { t: number; point: Vec2; by: string }[] = [];
  for (const other of sketchCurves(sketch, { includeConstruction: true, includeText: false })) {
    if (other.id === curveId) continue;
    for (const hit of intersectCurves(curve, other.curve))
      cuts.push({ t: hit.t1, point: hit.point, by: other.id });
  }
  if (entity.kind === 'ellipse' || entity.kind === 'ellipticArc' || entity.kind === 'spline') {
    return trimGeneric(sketch, entity, curve, cuts, at);
  }
  const full = isFullCircle(curve);
  const inner = cuts
    .filter((c) => full || (c.t > 1e-9 && c.t < 1 - 1e-9))
    .sort((a, b) => a.t - b.t)
    .filter((c, i, list) => i === 0 || c.t - list[i - 1]!.t > 1e-9);
  if (inner.length === 0 || (full && inner.length < 2)) {
    return { sketch: deleteItems(sketch, [curveId]), optional: [] };
  }
  const t = closestOnCurve(curve, at).t;
  const b = new SketchBuilder(sketch);

  const cutPoint = (cut: { point: Vec2; by: string }): string => {
    // Reuse an existing point at the cut (e.g. an endpoint of the cutting curve).
    for (const e of b.entities) {
      if (e.kind === 'point' && dist([e.x, e.y], cut.point) < 1e-6) return e.id;
    }
    const id = b.addPoint(cut.point);
    b.constrain('pointOnObject', [id, cut.by], true);
    b.constrain('pointOnObject', [id, curveId], true);
    return id;
  };

  if (full && entity.kind === 'circle') {
    // Remove the piece between the cuts around t (cyclic); the rest becomes an arc.
    let k = inner.findIndex((c) => c.t > t);
    if (k < 0) k = 0;
    const end = inner[(k - 1 + inner.length) % inner.length]!; // cut before t
    const start = inner[k]!; // cut after t
    const startId = cutPoint(start);
    const endId = cutPoint(end);
    b.entities = b.entities.map((e) =>
      e.id === curveId
        ? {
            id: curveId,
            kind: 'arc',
            center: entity.center,
            start: startId,
            end: endId,
            ...(entity.construction ? { construction: true } : {}),
          }
        : e,
    );
    // Circle-only constraints/dimensions still apply to the arc (radius, tangent, equal).
    return b.result();
  }

  const before = [...inner].reverse().find((c) => c.t < t);
  const after = inner.find((c) => c.t > t);
  if (entity.kind !== 'line' && entity.kind !== 'arc') return null;
  const last = entity.kind === 'line' ? entity.b : entity.end;
  const replace = (patch: Partial<SketchEntity>) => {
    b.entities = b.entities.map((e) =>
      e.id === curveId ? ({ ...e, ...patch } as SketchEntity) : e,
    );
  };
  if (!before && !after) return { sketch: deleteItems(sketch, [curveId]), optional: [] };
  if (!before) {
    // Remove [0, after]: the curve now starts at the cut.
    const p = cutPoint(after!);
    replace(entity.kind === 'line' ? { a: p } : { start: p });
    return b.result();
  }
  if (!after) {
    const p = cutPoint(before);
    replace(entity.kind === 'line' ? { b: p } : { end: p });
    return b.result();
  }
  // Split: [0, before] keeps the id, [after, 1] is new.
  const p0 = cutPoint(before);
  const p1 = cutPoint(after);
  replace(entity.kind === 'line' ? { b: p0 } : { end: p0 });
  if (entity.kind === 'line') b.addLine(p1, last, entity.construction === true);
  else b.addArc(entity.center, p1, last, entity.construction === true);
  return b.result();
}

/** A point at a trim cut: an existing point there, else a new one attached to the cutter and the curve. */
function cutPointFor(b: SketchBuilder, cut: { point: Vec2; by: string }): string {
  for (const e of b.entities) {
    if (e.kind === 'point' && dist([e.x, e.y], cut.point) < 1e-6) return e.id;
  }
  const id = b.addPoint(cut.point);
  // Text glyph contours (`t1.3`) and splines are no point-on targets; the trimmed curve's
  // own ends lie on it by construction (arc rules, poles).
  const cutter = b.entities.find((e) => e.id === cut.by);
  if (!cut.by.includes('.') && cutter?.kind !== 'spline') {
    b.constrain('pointOnObject', [id, cut.by], true);
  }
  return id;
}

/**
 * Trim of ellipses, elliptical arcs and splines: the kept parameter ranges
 * become elliptical arcs on the same axis points, or control-point splines
 * (exact: the kept Bézier pieces as a degree-3 spline with triple knots).
 */
function trimGeneric(
  sketch: SketchData,
  entity: Extract<SketchEntity, { kind: 'ellipse' | 'ellipticArc' | 'spline' }>,
  curve: Curve2,
  cuts: { t: number; point: Vec2; by: string }[],
  at: Vec2,
): EditResult | null {
  const closed = isClosedCurve(curve);
  const inner = cuts
    .filter((c) => closed || (c.t > 1e-9 && c.t < 1 - 1e-9))
    .sort((a, b) => a.t - b.t)
    .filter((c, i, list) => i === 0 || c.t - list[i - 1]!.t > 1e-9);
  if (inner.length === 0 || (closed && inner.length < 2)) {
    return { sketch: deleteItems(sketch, [entity.id]), optional: [] };
  }
  const t = closestOnCurve(curve, at).t;
  const b = new SketchBuilder(sketch);
  const ends = curveEnds(entity);
  const ranges: { t0: number; t1: number; start: string; end: string }[] = [];
  if (closed) {
    let k = inner.findIndex((c) => c.t > t);
    if (k < 0) k = 0;
    const startCut = inner[k]!;
    const endCut = inner[(k - 1 + inner.length) % inner.length]!;
    const t1 = endCut.t <= startCut.t ? endCut.t + 1 : endCut.t;
    ranges.push({
      t0: startCut.t,
      t1,
      start: cutPointFor(b, startCut),
      end: cutPointFor(b, endCut),
    });
  } else {
    const before = [...inner].reverse().find((c) => c.t < t);
    const after = inner.find((c) => c.t > t);
    if (!ends) return null;
    if (before) ranges.push({ t0: 0, t1: before.t, start: ends[0], end: cutPointFor(b, before) });
    if (after) ranges.push({ t0: after.t, t1: 1, start: cutPointFor(b, after), end: ends[1] });
  }
  if (ranges.length === 0) return { sketch: deleteItems(sketch, [entity.id]), optional: [] };
  const construction = entity.construction === true;
  const pieces: SketchEntity[] = ranges.map((range, i) => {
    const id = i === 0 ? entity.id : b.id(entity.kind === 'spline' ? 's' : 'ea');
    if (entity.kind === 'spline') {
      const part = subCurve(curve, range.t0, range.t1);
      const segs = part.kind === 'bezier' ? part.segs : [];
      const { poles, knots, degree } = beziersToBspline(segs);
      const points = poles.map((p, k) =>
        k === 0 ? range.start : k === poles.length - 1 ? range.end : b.addPoint(p),
      );
      return {
        id,
        kind: 'spline',
        mode: 'control',
        points,
        degree,
        knots,
        ...(construction ? { construction } : {}),
      };
    }
    return {
      id,
      kind: 'ellipticArc',
      center: entity.center,
      major: entity.major,
      minor: entity.minor,
      start: range.start,
      end: range.end,
      ...(construction ? { construction } : {}),
    };
  });
  b.entities = b.entities.flatMap((e) => (e.id === entity.id ? pieces : [e]));
  return b.result();
}

// ---- offset ----------------------------------------------------------------------------

/**
 * The chain of curves connected to `curveId` through points shared by
 * exactly two curves, in traversal order, each with its traversal
 * direction (`reversed` = walked end → start).
 */
export function curveChain(
  sketch: SketchData,
  curveId: string,
): { id: string; reversed: boolean }[] {
  const map = entityMap(sketch);
  const start = map.get(curveId);
  const ends = (e: SketchEntity): [string, string] | null => {
    const pair = curveEnds(e);
    // A closed spline (first point = last point) is a chain of its own.
    return pair && pair[0] !== pair[1] ? pair : null;
  };
  if (!isCurve(start) || start.kind === 'text') return [];
  if (!ends(start)) return [{ id: curveId, reversed: false }];
  const users = new Map<string, string[]>();
  for (const e of sketch.entities) {
    const pair = ends(e);
    if (!pair || e.construction !== start.construction) continue;
    for (const p of pair) users.set(p, [...(users.get(p) ?? []), e.id]);
  }
  const chain: { id: string; reversed: boolean }[] = [{ id: curveId, reversed: false }];
  const seen = new Set([curveId]);
  // Walk forward from the end, then backward from the start.
  const walk = (fromPoint: string, forward: boolean) => {
    let point = fromPoint;
    for (;;) {
      const next = (users.get(point) ?? []).filter((id) => !seen.has(id));
      if ((users.get(point) ?? []).length !== 2 || next.length !== 1) return;
      const id = next[0]!;
      const pair = ends(map.get(id)!)!;
      seen.add(id);
      const reversed = forward ? pair[1] === point : pair[0] === point;
      if (forward) chain.push({ id, reversed });
      else chain.unshift({ id, reversed });
      point = forward ? (reversed ? pair[0] : pair[1]) : reversed ? pair[1] : pair[0];
    }
  };
  const [a, b] = ends(start)!;
  walk(b, true);
  walk(a, false);
  return chain;
}

/**
 * One offset piece: a line or arc stays exact; any other curve (ellipse,
 * elliptical arc, spline) becomes sample points of its true offset, later
 * stored as a fit spline through them (the offset of an ellipse or a spline
 * is no ellipse/spline itself) — `tangents` are the end directions.
 */
type OffsetPiece =
  | { kind: 'exact'; curve: Extract<Curve2, { kind: 'line' | 'arc' }> }
  | { kind: 'sampled'; points: Vec2[]; closed: boolean; tangents: [Vec2, Vec2] };

/** Left normal of a direction. */
function leftOf(d: Vec2): Vec2 {
  return [-d[1], d[0]];
}

/** Sample count for a sampled offset: enough for the curve's turning (fit-spline error ≪ 1 µm per mm). */
function offsetSamples(curve: Curve2): number {
  let turning = 0;
  let previous = tangentAt(curve, 0);
  for (let i = 1; i <= 96; i += 1) {
    const t = tangentAt(curve, i / 96);
    turning += Math.abs(Math.atan2(cross(previous, t), previous[0] * t[0] + previous[1] * t[1]));
    previous = t;
  }
  return Math.max(12, Math.min(96, Math.ceil(turning / (Math.PI / 24)) + 4));
}

function offsetPiece(curve: Curve2, d: number): OffsetPiece | null {
  if (curve.kind === 'line') {
    const n = leftOf(normalize(sub(curve.b, curve.a)));
    return {
      kind: 'exact',
      curve: { kind: 'line', a: add(curve.a, scale(n, d)), b: add(curve.b, scale(n, d)) },
    };
  }
  if (curve.kind === 'arc') {
    // Left of a counter-clockwise arc points to the centre.
    const r = curve.r - Math.sign(curve.sweep || 1) * d;
    if (r <= 1e-9) return null;
    return { kind: 'exact', curve: { ...curve, r } };
  }
  const closed = isClosedCurve(curve);
  const n = offsetSamples(curve);
  const points: Vec2[] = [];
  for (let i = 0; i <= (closed ? n - 1 : n); i += 1) {
    const t = i / n;
    // Towards a centre of curvature closer than the distance the offset folds over: refuse.
    if (d * curvatureAt(curve, t) >= 1 - 1e-6) return null;
    points.push(add(pointAt(curve, t), scale(leftOf(tangentAt(curve, t)), d)));
  }
  return { kind: 'sampled', points, closed, tangents: [tangentAt(curve, 0), tangentAt(curve, 1)] };
}

function pieceStart(piece: OffsetPiece): Vec2 {
  return piece.kind === 'exact' ? pointAt(piece.curve, 0) : piece.points[0]!;
}

function pieceEnd(piece: OffsetPiece): Vec2 {
  return piece.kind === 'exact'
    ? pointAt(piece.curve, 1)
    : piece.closed
      ? piece.points[0]!
      : piece.points[piece.points.length - 1]!;
}

function lineIntersection(
  l1: Extract<Curve2, { kind: 'line' }>,
  l2: Extract<Curve2, { kind: 'line' }>,
): Vec2 | null {
  const d1 = sub(l1.b, l1.a);
  const d2 = sub(l2.b, l2.a);
  const denom = cross(d1, d2);
  if (Math.abs(denom) < 1e-12) return null;
  const t = cross(sub(l2.a, l1.a), d2) / denom;
  return add(l1.a, scale(d1, t));
}

/**
 * A fit spline through `points` from point `startId` to `endId` (the joints)
 * with its end handles along the given tangents.
 */
function addSampledSpline(
  b: SketchBuilder,
  startId: string,
  endId: string,
  points: readonly Vec2[],
  tangents: [Vec2, Vec2],
): string {
  const map = new Map(b.entities.map((e) => [e.id, e]));
  const startPos = pointPos(map, startId)!;
  const endPos = pointPos(map, endId)!;
  const inner = points.slice(1, -1);
  const all = [startPos, ...inner, endPos];
  const h0 = dist(all[0]!, all[1]!) / 3;
  const h1 = dist(all[all.length - 2]!, all[all.length - 1]!) / 3;
  const ids = [startId, ...inner.map((p) => b.addPoint(p)), endId];
  const handles: [string, string] = [
    b.addPoint(add(startPos, scale(tangents[0], h0))),
    b.addPoint(sub(endPos, scale(tangents[1], h1))),
  ];
  const id = b.id('s');
  b.entities.push({ id, kind: 'spline', mode: 'fit', points: ids, handles });
  return id;
}

/**
 * Offsets the chain through `curveId` by `distance` (positive = to the left
 * of the clicked curve's own direction; see {@link offsetSide}). Lines and
 * arcs offset exactly; ellipses, elliptical arcs and splines become fit
 * splines through points of their true offset (tangent end handles; closed
 * curves stay closed). Adjacent offset lines meet at their intersection;
 * other joints meet where the offset ends coincide. `null` when the offset
 * folds over (a distance beyond a radius of curvature on that side).
 */
export function offsetChain(
  sketch: SketchData,
  curveId: string,
  distance: number,
): EditResult | null {
  return offsetChains(sketch, [{ curveId, distance }]);
}

/**
 * Several chains offset in one edit (Shapr3D Offset Edge with per-loop
 * direction arrows): each `{curveId, distance}` as in {@link offsetChain};
 * `single` offsets only that curve, not its chain.
 * `null` when any of them cannot be offset.
 */
export function offsetChains(
  sketch: SketchData,
  loops: readonly { curveId: string; distance: number; single?: boolean }[],
): EditResult | null {
  if (loops.length === 0 || loops.some((l) => Math.abs(l.distance) < 1e-6)) return null;
  const map = entityMap(sketch);
  const builder = new SketchBuilder(sketch);
  const created: string[] = [];
  for (const loop of loops) {
    const chain = loop.single
      ? [{ id: loop.curveId, reversed: false }]
      : curveChain(sketch, loop.curveId);
    if (chain.length === 0 || !isCurve(map.get(loop.curveId))) return null;
    const clicked = chain.find((c) => c.id === loop.curveId)!;
    const d = clicked.reversed ? -loop.distance : loop.distance;
    const pieces: OffsetPiece[] = [];
    for (const { id, reversed } of chain) {
      const curve = entityCurve(map, map.get(id) as never);
      if (!curve) return null;
      const piece = offsetPiece(reversed ? reverseCurve(curve) : curve, d);
      if (!piece) return null;
      pieces.push(piece);
    }
    const ids = addOffsetPieces(builder, pieces, chain.length >= 2 && isChainClosed(sketch, chain));
    if (!ids) return null;
    created.push(...ids);
  }
  return builder.result(created);
}

/** The polyline of a piece and its end tangents. */
function piecePolyline(piece: OffsetPiece): Vec2[] {
  if (piece.kind === 'exact') return sampleCurve(piece.curve);
  return piece.closed ? [...piece.points, piece.points[0]!] : piece.points;
}

function pieceTangents(piece: OffsetPiece): [Vec2, Vec2] {
  return piece.kind === 'exact'
    ? [tangentAt(piece.curve, 0), tangentAt(piece.curve, 1)]
    : piece.tangents;
}

function segmentHit(p: Vec2, p2: Vec2, q: Vec2, q2: Vec2): Vec2 | null {
  const r = sub(p2, p);
  const s = sub(q2, q);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-15) return null;
  const t = cross(sub(q, p), s) / denom;
  const u = cross(sub(q, p), r) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return add(p, scale(r, t));
}

/**
 * Joint of pieces `ia` → `ib` when one of them is sampled: where their
 * polylines cross near the joint (both trimmed there), else where their end
 * tangents meet ahead of `a` and behind `b` (both extended), else halfway.
 * Sampled pieces in `work` are updated in place.
 */
function sampledJoint(work: OffsetPiece[], ia: number, ib: number): Vec2 {
  const a = work[ia]!;
  const b = work[ib]!;
  const pa = piecePolyline(a);
  const pb = piecePolyline(b);
  const end = pieceEnd(a);
  const start = pieceStart(b);
  if (dist(end, start) < 1e-9) return end;
  // Crossing near the joint: scan outward from it over half of each polyline.
  const na = pa.length - 1;
  const nb = pb.length - 1;
  for (let reach = 0; reach < Math.max(na, nb); reach += 1) {
    for (let k = 0; k <= reach; k += 1) {
      const i = na - 1 - k;
      const j = reach - k;
      if (i < Math.floor(na / 2) || j >= Math.ceil(nb / 2) || i < 0 || j >= nb) continue;
      const x = segmentHit(pa[i]!, pa[i + 1]!, pb[j]!, pb[j + 1]!);
      if (!x) continue;
      if (a.kind === 'sampled') {
        const kept = a.points.slice(0, i + 1);
        work[ia] = {
          ...a,
          points: [...kept, x],
          tangents: [a.tangents[0], normalize(sub(x, kept[kept.length - 1]!))],
        };
      }
      if (b.kind === 'sampled') {
        const kept = b.points.slice(j + 1);
        work[ib] = {
          ...b,
          points: [x, ...kept],
          tangents: [normalize(sub(kept[0]!, x)), b.tangents[1]],
        };
      }
      return x;
    }
  }
  // A gap: extend both along their end tangents to where they meet.
  const ta = pieceTangents(a)[1];
  const tb = pieceTangents(b)[0];
  const denom = cross(ta, tb);
  if (Math.abs(denom) > 1e-9) {
    const s = cross(sub(start, end), tb) / denom;
    const t = cross(sub(start, end), ta) / denom;
    if (s >= 0 && t <= 0) {
      const m = add(end, scale(ta, s));
      if (a.kind === 'sampled') work[ia] = { ...a, points: [...a.points, m] };
      if (b.kind === 'sampled') work[ib] = { ...b, points: [m, ...b.points] };
      return m;
    }
  }
  return [(end[0] + start[0]) / 2, (end[1] + start[1]) / 2];
}

/** Adds the offset pieces of one chain; the created curve ids. */
function addOffsetPieces(
  builder: SketchBuilder,
  input: readonly OffsetPiece[],
  closed: boolean,
): string[] | null {
  let pieces = input;
  const count = pieces.length;
  const only = pieces[0]!;
  if (count === 1 && only.kind === 'exact' && isFullCircle(only.curve)) {
    const c = only.curve as Extract<Curve2, { kind: 'arc' }>;
    const center = builder.addPoint(c.c);
    return [builder.addCircle(center, c.r)];
  }
  if (count === 1 && only.kind === 'sampled' && only.closed) {
    // A full ellipse or closed spline: a closed fit spline on its first point.
    const first = builder.addPoint(only.points[0]!);
    return [
      addSampledSpline(builder, first, first, [...only.points, only.points[0]!], only.tangents),
    ];
  }
  // Joint positions between consecutive pieces.
  const joints: Vec2[] = [];
  const jointCount = closed ? count : count - 1;
  const work = pieces.map((p) => (p.kind === 'sampled' ? { ...p, points: [...p.points] } : p));
  for (let i = 0; i < jointCount; i += 1) {
    const a = work[i]!;
    const b = work[(i + 1) % count]!;
    const hit =
      a.kind === 'exact' && b.kind === 'exact' && a.curve.kind === 'line' && b.curve.kind === 'line'
        ? lineIntersection(a.curve, b.curve)
        : null;
    if (hit) joints.push(hit);
    else if (a.kind === 'exact' && b.kind === 'exact') joints.push(pieceEnd(a));
    // A sampled piece is trimmed where it crosses its neighbour, or extended along the
    // end tangents until they meet (a mitre), like two lines.
    else joints.push(sampledJoint(work, i, (i + 1) % count));
  }
  pieces = work;
  const pointIds: string[] = [];
  const startPos = closed ? joints[count - 1]! : pieceStart(pieces[0]!);
  pointIds.push(builder.addPoint(startPos));
  for (let i = 0; i < count; i += 1) {
    const endPos = i < joints.length ? joints[i]! : pieceEnd(pieces[i]!);
    if (closed && i === count - 1) pointIds.push(pointIds[0]!);
    else pointIds.push(builder.addPoint(endPos));
  }
  const created: string[] = [];
  pieces.forEach((piece, i) => {
    const a = pointIds[i]!;
    const b = pointIds[i + 1]!;
    if (piece.kind === 'sampled') {
      created.push(addSampledSpline(builder, a, b, piece.points, piece.tangents));
      return;
    }
    const c = piece.curve;
    if (c.kind === 'line') created.push(builder.addLine(a, b));
    else {
      const center = builder.addPoint(c.c);
      created.push(c.sweep >= 0 ? builder.addArc(center, a, b) : builder.addArc(center, b, a));
    }
  });
  return created;
}

function isChainClosed(sketch: SketchData, chain: { id: string; reversed: boolean }[]): boolean {
  const map = entityMap(sketch);
  const endOf = (c: { id: string; reversed: boolean }, atEnd: boolean): string | null => {
    const pair = curveEnds(map.get(c.id));
    if (!pair) return null;
    return atEnd !== c.reversed ? pair[1] : pair[0];
  };
  return endOf(chain[0]!, false) === endOf(chain[chain.length - 1]!, true);
}

/**
 * Signed offset distance for a cursor position relative to the clicked
 * curve (left of its direction = positive): lines exactly, circles/arcs by
 * radius, other curves by the cursor's side at its closest point.
 */
export function offsetSide(sketch: SketchData, curveId: string, cursor: Vec2): number {
  const map = entityMap(sketch);
  const e = map.get(curveId);
  if (!isCurve(e)) return 0;
  const curve = entityCurve(map, e);
  if (!curve) return 0;
  if (curve.kind === 'line') {
    const dir = normalize(sub(curve.b, curve.a));
    return cross(dir, sub(cursor, curve.a));
  }
  // Arcs/circles (counter-clockwise): left = towards the centre.
  if (curve.kind === 'arc') return curve.r - dist(cursor, curve.c);
  const { t, point } = closestOnCurve(curve, cursor);
  const side = cross(tangentAt(curve, t), sub(cursor, point));
  return (Math.sign(side) || 1) * dist(cursor, point);
}

/**
 * Whether a positive offset of the chain through `curveId` (to the left of
 * that curve) moves a closed chain outwards (`1`), inwards (`-1`), or the
 * chain is open (`0`) — so several loops can be offset to the same side.
 */
export function offsetOutwardSign(sketch: SketchData, curveId: string, single = false): -1 | 0 | 1 {
  const map = entityMap(sketch);
  const chain = single ? [{ id: curveId, reversed: false }] : curveChain(sketch, curveId);
  const alone = chain.length === 1 ? entityCurve(map, map.get(chain[0]!.id) as never) : null;
  const closed =
    chain.length >= 2 ? isChainClosed(sketch, chain) : alone ? isClosedCurve(alone) : false;
  if (!closed) return 0;
  const polygon: Vec2[] = [];
  for (const { id, reversed } of chain) {
    const curve = entityCurve(map, map.get(id) as never);
    if (!curve) return 0;
    polygon.push(...sampleCurve(reversed ? reverseCurve(curve) : curve));
  }
  const curve = entityCurve(map, map.get(curveId) as never);
  if (!curve) return 0;
  const p = pointAt(curve, 0.5);
  const box = curveBox(curve);
  const probe = 1e-4 * Math.max(1, box[2] - box[0], box[3] - box[1]);
  const left = add(p, scale(leftOf(tangentAt(curve, 0.5)), probe));
  return pointInPolygon(left, polygon) ? -1 : 1;
}

/** Where a loop's direction arrow sits: the middle of its curve and the unit left normal there. */
export function offsetArrowAt(
  sketch: SketchData,
  curveId: string,
): { at: Vec2; left: Vec2 } | null {
  const map = entityMap(sketch);
  const curve = entityCurve(map, map.get(curveId) as never);
  if (!curve) return null;
  return { at: pointAt(curve, 0.5), left: leftOf(tangentAt(curve, 0.5)) };
}

/** The chain (loop) a curve belongs to, as the set of its curve ids. */
export function chainIds(sketch: SketchData, curveId: string): Set<string> {
  return new Set(curveChain(sketch, curveId).map((c) => c.id));
}

// ---- arcs ------------------------------------------------------------------------------

/**
 * Adds an arc through three points (start, a point on the arc, end) as a
 * counter-clockwise arc entity. Returns `null` for collinear points.
 */
export function addThreePointArc(
  builder: SketchBuilder,
  start: SnapTarget,
  through: Vec2,
  end: SnapTarget,
): string | null {
  const circle = circleThrough(start.pos, through, end.pos);
  if (!circle) return null;
  const s = builder.pointFor(start);
  const e = builder.pointFor(end);
  const center = builder.addPoint(circle.c);
  // A left turn start → through → end means the arc runs counter-clockwise from start to end.
  const ccw = cross(sub(through, start.pos), sub(end.pos, through)) > 0;
  return ccw ? builder.addArc(center, s, e) : builder.addArc(center, e, s);
}

/**
 * Centre and orientation of the arc leaving `start` along `tangent` and
 * ending at `end`, or `null` when `end` is straight ahead.
 */
export function tangentArc(
  start: Vec2,
  tangent: Vec2,
  end: Vec2,
): { center: Vec2; ccw: boolean } | null {
  const t = normalize(tangent);
  const n: Vec2 = [-t[1], t[0]];
  const se = sub(start, end);
  const denom = 2 * (n[0] * se[0] + n[1] * se[1]);
  if (Math.abs(denom) < 1e-9) return null;
  const k = -(se[0] * se[0] + se[1] * se[1]) / denom;
  return { center: add(start, scale(n, k)), ccw: k > 0 };
}

/** Parameter of `p` on curve `id` (for hit testing / trimming previews). */
export function paramOnEntity(sketch: SketchData, id: string, p: Vec2): number | null {
  const map = entityMap(sketch);
  const e = map.get(id);
  if (!isCurve(e)) return null;
  const curve = entityCurve(map, e);
  return curve ? paramOf(curve, p) : null;
}

/** Position of a point entity or the origin. */
export function positionOf(sketch: SketchData, id: string): Vec2 | null {
  return pointPos(entityMap(sketch), id);
}
