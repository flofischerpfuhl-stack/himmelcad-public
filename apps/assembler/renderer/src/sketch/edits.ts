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
  dist,
  entityCurve,
  intersectCurves,
  isFullCircle,
  normalize,
  paramOf,
  pointAt,
  scale,
  sketchCurves,
  sub,
  type Curve2,
} from './geometry.js';
import {
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
}

/** Mutable edit builder: accumulates entities/constraints with fresh ids. */
export class SketchBuilder {
  private readonly alloc: (prefix: string) => string;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
  dimensions: SketchData['dimensions'];
  readonly optional: string[] = [];

  constructor(sketch: SketchData) {
    this.alloc = idAllocator(sketch);
    this.entities = [...sketch.entities];
    this.constraints = [...sketch.constraints];
    this.dimensions = [...sketch.dimensions];
  }

  get data(): SketchData {
    return { entities: this.entities, constraints: this.constraints, dimensions: this.dimensions };
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
      if (c.refs.some((r) => curveIds.has(r))) for (const r of c.refs) used.add(r);
    }
    const entities = current.entities.filter((e) => e.kind !== 'point' || used.has(e.id));
    const alive = new Set(entities.map((e) => e.id));
    alive.add(ORIGIN_ID);
    const constraints = current.constraints.filter((c) => c.refs.every((r) => alive.has(r)));
    const dimensions = current.dimensions.filter((d) => d.refs.every((r) => alive.has(r)));
    const next = { entities, constraints, dimensions };
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
  if (!isCurve(entity)) return null;
  const curve = entityCurve(map, entity);
  if (!curve) return null;
  const cuts: { t: number; point: Vec2; by: string }[] = [];
  for (const other of sketchCurves(sketch, { includeConstruction: true })) {
    if (other.id === curveId) continue;
    for (const hit of intersectCurves(curve, other.curve))
      cuts.push({ t: hit.t1, point: hit.point, by: other.id });
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
  if (entity.kind === 'circle') return null;
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
  if (!isCurve(start) || start.kind === 'circle')
    return isCurve(start) ? [{ id: curveId, reversed: false }] : [];
  const ends = (e: SketchEntity): [string, string] | null =>
    e.kind === 'line' ? [e.a, e.b] : e.kind === 'arc' ? [e.start, e.end] : null;
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

function offsetCurve(curve: Curve2, d: number): Curve2 | null {
  if (curve.kind === 'line') {
    const dir = normalize(sub(curve.b, curve.a));
    const n: Vec2 = [-dir[1], dir[0]];
    return { kind: 'line', a: add(curve.a, scale(n, d)), b: add(curve.b, scale(n, d)) };
  }
  // Left of a counter-clockwise arc points to the centre.
  const r = curve.r - Math.sign(curve.sweep || 1) * d;
  if (r <= 1e-9) return null;
  return { ...curve, r };
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
 * Offsets the chain through `curveId` by `distance` (positive = to the left
 * of the clicked curve's own direction; see {@link offsetSide}). Adjacent
 * offset lines meet at their intersection; other joints meet where the
 * offset ends coincide.
 */
export function offsetChain(
  sketch: SketchData,
  curveId: string,
  distance: number,
): EditResult | null {
  if (Math.abs(distance) < 1e-6) return null;
  const map = entityMap(sketch);
  const chain = curveChain(sketch, curveId);
  if (chain.length === 0) return null;
  const clicked = chain.find((c) => c.id === curveId)!;
  const d = clicked.reversed ? -distance : distance;
  const oriented = chain.map(({ id, reversed }) => {
    const curve = entityCurve(map, map.get(id) as never)!;
    const c = reversed ? reverseOf(curve) : curve;
    return { id, curve: offsetCurve(c, d) };
  });
  if (oriented.some((o) => !o.curve)) return null;
  const curves = oriented.map((o) => o.curve!);
  const closed = chain.length >= 2 && isChainClosed(sketch, chain);
  // Joint positions between consecutive curves.
  const joints: Vec2[] = [];
  const count = curves.length;
  const jointCount = closed ? count : count - 1;
  for (let i = 0; i < jointCount; i += 1) {
    const a = curves[i]!;
    const b = curves[(i + 1) % count]!;
    const hit = a.kind === 'line' && b.kind === 'line' ? lineIntersection(a, b) : null;
    joints.push(hit ?? pointAt(a, 1));
  }
  const builder = new SketchBuilder(sketch);
  if (count === 1 && isFullCircle(curves[0]!)) {
    const c = curves[0] as Extract<Curve2, { kind: 'arc' }>;
    const center = builder.addPoint(c.c);
    const id = builder.addCircle(center, c.r);
    return builder.result([id]);
  }
  const pointIds: string[] = [];
  const startPos = closed ? joints[count - 1]! : pointAt(curves[0]!, 0);
  pointIds.push(builder.addPoint(startPos));
  for (let i = 0; i < count; i += 1) {
    const endPos = i < joints.length ? joints[i]! : pointAt(curves[i]!, 1);
    if (closed && i === count - 1) pointIds.push(pointIds[0]!);
    else pointIds.push(builder.addPoint(endPos));
  }
  const created: string[] = [];
  curves.forEach((c, i) => {
    const a = pointIds[i]!;
    const b = pointIds[i + 1]!;
    if (c.kind === 'line') created.push(builder.addLine(a, b));
    else {
      const center = builder.addPoint(c.c);
      created.push(c.sweep >= 0 ? builder.addArc(center, a, b) : builder.addArc(center, b, a));
    }
  });
  return builder.result(created);
}

function isChainClosed(sketch: SketchData, chain: { id: string; reversed: boolean }[]): boolean {
  const map = entityMap(sketch);
  const endOf = (c: { id: string; reversed: boolean }, atEnd: boolean): string | null => {
    const e = map.get(c.id);
    if (e?.kind === 'line') return atEnd !== c.reversed ? e.b : e.a;
    if (e?.kind === 'arc') return atEnd !== c.reversed ? e.end : e.start;
    return null;
  };
  return endOf(chain[0]!, false) === endOf(chain[chain.length - 1]!, true);
}

function reverseOf(curve: Curve2): Curve2 {
  if (curve.kind === 'line') return { kind: 'line', a: curve.b, b: curve.a };
  return { ...curve, a0: curve.a0 + curve.sweep, sweep: -curve.sweep };
}

/** Signed offset distance for a cursor position relative to the clicked curve (left of its direction = positive). */
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
  return curve.r - dist(cursor, curve.c);
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
