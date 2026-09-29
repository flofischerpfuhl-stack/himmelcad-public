/**
 * Sketch data model of HimmelCAD Assembler (Shapr3D-style constrained 2D
 * sketches). A sketch is plain, structured-clone-safe data stored inside a
 * `sketch` feature (`model/document.ts`): entities in the sketch frame's
 * (u, v) coordinates in millimetres, geometric constraints and driving
 * dimensions. Entity positions are always the **last solved state**; the
 * CAD kernel consumes them as they are and never runs the solver, so a
 * document evaluates deterministically without the solver being loaded.
 *
 * Design and limits: `assembler/SKETCHING.md`.
 */
import type { EdgeRef, FaceRef } from '../model/document.js';

/** A point in sketch (u, v) coordinates, millimetres. */
export type Vec2 = [number, number];

/**
 * Reserved point id of the sketch origin (u = 0, v = 0). Constraints and
 * dimensions may reference it; it is never stored as an entity and never
 * moves.
 */
export const ORIGIN_ID = 'origin';

interface EntityBase {
  /** Unique within the sketch; never reused, never derived from position. */
  id: string;
  /** Construction geometry is a reference only: it never bounds a profile. */
  construction?: boolean;
}

/** A point: a curve vertex (line end, arc end/centre, circle centre) or a free point. */
export interface SketchPoint extends EntityBase {
  kind: 'point';
  x: number;
  y: number;
}

/** A straight segment between two point entities. */
export interface SketchLine extends EntityBase {
  kind: 'line';
  a: string;
  b: string;
}

/** A full circle around a centre point entity. */
export interface SketchCircle extends EntityBase {
  kind: 'circle';
  center: string;
  radius: number;
}

/**
 * A circular arc, counter-clockwise from `start` to `end` around `center`.
 * The radius is `|start - center|`; the solver keeps `|end - center|` equal.
 */
export interface SketchArc extends EntityBase {
  kind: 'arc';
  center: string;
  start: string;
  end: string;
}

/**
 * A full ellipse: `major` is a point at the end of the major (first) axis,
 * `minor` a point at the end of the minor axis (the solver keeps it
 * perpendicular). Radii are `|major - center|` and `|minor - center|`.
 */
export interface SketchEllipse extends EntityBase {
  kind: 'ellipse';
  center: string;
  major: string;
  minor: string;
}

/**
 * An elliptical arc, counter-clockwise (in the ellipse's own frame) from
 * `start` to `end` on the ellipse defined by `center`, `major`, `minor`.
 */
export interface SketchEllipticArc extends EntityBase {
  kind: 'ellipticArc';
  center: string;
  major: string;
  minor: string;
  start: string;
  end: string;
}

/**
 * A cubic spline (Shapr3D "Spline").
 *
 * - `mode: 'control'`: `points` are the control polygon (poles) of a clamped
 *   B-spline of `degree` (default 3, capped by the pole count); `knots`
 *   (full clamped knot vector) is present only after a trim split the
 *   spline — absent means uniform. The curve starts at the first and ends
 *   at the last pole.
 * - `mode: 'fit'`: the curve passes through `points` (C2 cubic
 *   interpolation, chord-length parameters). `handles` are the tangent
 *   handles at the start/end: the first/last Bézier control point of the
 *   curve (the end tangent is `handle - end`), or `null` for a natural end.
 */
export interface SketchSpline extends EntityBase {
  kind: 'spline';
  mode: 'control' | 'fit';
  points: string[];
  degree?: number;
  knots?: number[];
  handles?: [string | null, string | null];
}

/**
 * Text as sketch geometry. `anchor` is the start of the baseline; the
 * glyph outlines are stored (normalized: `1` = `height`, the cap height)
 * so a document evaluates without the font. `outline` is SVG path data
 * (M/L/Q/C/Z) in those units, baseline start at the origin, v up.
 * Every closed glyph contour is a profile curve (region keys `<id>.<n>`).
 */
export interface SketchText extends EntityBase {
  kind: 'text';
  anchor: string;
  text: string;
  /** Cap height, mm. */
  height: number;
  /** Rotation of the baseline, degrees counter-clockwise. */
  angle: number;
  /** Font id (see `sketch/text/fonts.ts`). */
  font: string;
  outline: string;
}

export type SketchCurve =
  | SketchLine
  | SketchCircle
  | SketchArc
  | SketchEllipse
  | SketchEllipticArc
  | SketchSpline
  | SketchText;
export type SketchEntity = SketchPoint | SketchCurve;

/**
 * Geometric constraint kinds (Shapr3D's constraint set plus FreeCAD's
 * point-on-object). `refs` interpretation per kind:
 *
 * | kind            | refs                                                        |
 * | --------------- | ----------------------------------------------------------- |
 * | `coincident`    | two points                                                  |
 * | `horizontal`    | one line, or two points                                     |
 * | `vertical`      | one line, or two points                                     |
 * | `parallel`      | two lines                                                   |
 * | `perpendicular` | two lines                                                   |
 * | `tangent`       | two curves (line/circle/arc; at least one circle or arc)    |
 * | `equal`         | two lines (length) or two circles/arcs (radius)             |
 * | `fixed`         | one point or curve (locks it where it is)                   |
 * | `midpoint`      | a point and a line                                          |
 * | `symmetric`     | two points and a line or point (the symmetry axis/centre)   |
 * | `concentric`    | two circles/arcs                                            |
 * | `pointOnObject` | a point and a curve                                         |
 * | `translate`     | points p, q, a, b: `q - p = b - a` (linear sketch pattern)  |
 * | `rotate`        | points p, q, c: q is p rotated by `value`° about c (circular pattern) |
 *
 * Splines take `coincident` on their end points (the first/last pole or
 * fit point) and `tangent` with a line, arc or spline sharing an end point
 * (the tangent handle / second pole is kept on the tangent direction).
 */
export type SketchConstraintKind =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'tangent'
  | 'equal'
  | 'fixed'
  | 'midpoint'
  | 'symmetric'
  | 'concentric'
  | 'pointOnObject'
  | 'translate'
  | 'rotate';

export interface SketchConstraint {
  id: string;
  kind: SketchConstraintKind;
  refs: string[];
  /** Parameter of the constraint: the angle of `rotate`, degrees. */
  value?: number;
}

/**
 * Driving dimension kinds. `refs` per kind:
 *
 * - `distance`: one line (its length), two points, a point and a line
 *   (perpendicular distance), or two parallel lines;
 * - `horizontalDistance` / `verticalDistance`: one line or two points
 *   (the u / v extent, sign kept from the geometry when created);
 * - `radius` / `diameter`: one circle or arc;
 * - `angle`: two lines, degrees between their directions (0..180).
 */
export type SketchDimensionKind =
  | 'distance'
  | 'horizontalDistance'
  | 'verticalDistance'
  | 'radius'
  | 'diameter'
  | 'angle';

export interface SketchDimension {
  id: string;
  /** Short unique name used in expressions of other dimensions (`d1`, `d2`, …). */
  name: string;
  kind: SketchDimensionKind;
  refs: string[];
  /** Resolved value: millimetres, or degrees for `angle`. Always positive. */
  value: number;
  /**
   * The expression the user typed, if it is not a plain number, e.g.
   * `"d1 / 2 + 3"`. `value` is its last evaluated result.
   */
  expression?: string;
  /** Signed offset of the label from its geometry, mm (layout only). */
  offset?: number;
  /**
   * Reference (driven) dimension: it does not constrain the sketch, it
   * shows the current measurement (in parentheses) and follows every edit.
   * Not editable; other dimensions' expressions may not use it.
   */
  driven?: boolean;
  /** Label position along the measured segment, `0..1` from its start (layout only; default 0.5). */
  along?: number;
}

/**
 * Body geometry projected into the sketch (Shapr3D "Project"): the source
 * edge or face (its boundary) is projected along the sketch normal. The
 * created entities (`entities`, construction by default) are reference
 * geometry: fixed for the solver and re-derived by the kernel from the
 * source on every evaluation (associative). When the source cannot be
 * resolved the stored geometry stays as it was (frozen) and the sketch gets
 * a warning.
 */
export interface SketchProjection {
  id: string;
  source: { kind: 'edge'; ref: EdgeRef } | { kind: 'face'; ref: FaceRef };
  /** Curve entity ids created from the source, in source order. */
  entities: string[];
}

/**
 * Geometric fingerprint of a region at the last sketch commit (centre of
 * its sample point, area), kept for keys that vanished so a reference to a
 * redrawn profile re-binds by geometry (`kernel/regionRebind.ts`).
 */
export interface RegionSignature {
  key: string;
  sample: Vec2;
  area: number;
  /** Bounding box `[minU, minV, maxU, maxV]`. */
  box: [number, number, number, number];
}

/** The solver-relevant content of a sketch feature. */
export interface SketchData {
  entities: SketchEntity[];
  constraints: SketchConstraint[];
  dimensions: SketchDimension[];
  /** Projected body geometry (absent = none). */
  projections?: SketchProjection[];
  /** Region fingerprints for geometric re-binding (absent = none recorded). */
  regionMemory?: RegionSignature[];
}

export const EMPTY_SKETCH: SketchData = { entities: [], constraints: [], dimensions: [] };

export function isCurve(entity: SketchEntity | undefined): entity is SketchCurve {
  return entity !== undefined && entity.kind !== 'point';
}

export function isRound(entity: SketchEntity | undefined): entity is SketchCircle | SketchArc {
  return entity?.kind === 'circle' || entity?.kind === 'arc';
}

export function isElliptic(
  entity: SketchEntity | undefined,
): entity is SketchEllipse | SketchEllipticArc {
  return entity?.kind === 'ellipse' || entity?.kind === 'ellipticArc';
}

/** Point ids a curve is defined by (vertex, centre, axis, pole, handle and anchor points). */
export function curvePointIds(entity: SketchCurve): string[] {
  switch (entity.kind) {
    case 'line':
      return [entity.a, entity.b];
    case 'circle':
      return [entity.center];
    case 'arc':
      return [entity.center, entity.start, entity.end];
    case 'ellipse':
      return [entity.center, entity.major, entity.minor];
    case 'ellipticArc':
      return [entity.center, entity.major, entity.minor, entity.start, entity.end];
    case 'spline': {
      const handles: string[] = [];
      for (const h of entity.handles ?? []) if (h !== null) handles.push(h);
      return [...entity.points, ...handles];
    }
    case 'text':
      return [entity.anchor];
  }
}

/** The two end point ids of an open curve (line, arc, elliptical arc, spline), else `null`. */
export function curveEnds(entity: SketchEntity | undefined): [string, string] | null {
  if (entity?.kind === 'line') return [entity.a, entity.b];
  if (entity?.kind === 'arc' || entity?.kind === 'ellipticArc') return [entity.start, entity.end];
  if (entity?.kind === 'spline' && entity.points.length >= 2) {
    return [entity.points[0]!, entity.points[entity.points.length - 1]!];
  }
  return null;
}

/** Id → entity lookup. */
export function entityMap(sketch: Pick<SketchData, 'entities'>): Map<string, SketchEntity> {
  return new Map(sketch.entities.map((e) => [e.id, e]));
}

/** Position of a point entity (or the origin), `null` if it is missing. */
export function pointPos(map: ReadonlyMap<string, SketchEntity>, id: string): Vec2 | null {
  if (id === ORIGIN_ID) return [0, 0];
  const e = map.get(id);
  return e?.kind === 'point' ? [e.x, e.y] : null;
}

/** Radius of a circle or arc. */
export function radiusOf(
  map: ReadonlyMap<string, SketchEntity>,
  entity: SketchCircle | SketchArc,
): number {
  if (entity.kind === 'circle') return entity.radius;
  const c = pointPos(map, entity.center);
  const s = pointPos(map, entity.start);
  return c && s ? Math.hypot(s[0] - c[0], s[1] - c[1]) : 0;
}

/**
 * Id allocator for one edit: `alloc('l')` returns `l<n>` with `n` above
 * every id of that prefix already in the sketch or handed out before.
 * Prefixes in use: `p` point, `l` line, `c` circle, `a` arc, `e`
 * ellipse, `ea` elliptical arc, `s` spline, `t` text, `k` constraint,
 * `m` dimension, `j` projection.
 */
export function idAllocator(sketch: SketchData): (prefix: string) => string {
  const next = new Map<string, number>();
  const all = [
    ...sketch.entities,
    ...sketch.constraints,
    ...sketch.dimensions,
    ...(sketch.projections ?? []),
  ];
  return (prefix) => {
    let n = next.get(prefix);
    if (n === undefined) {
      n = 0;
      const re = new RegExp(`^${prefix}(\\d+)$`);
      for (const item of all) {
        const m = re.exec(item.id);
        if (m) n = Math.max(n, Number(m[1]));
      }
    }
    n += 1;
    next.set(prefix, n);
    return `${prefix}${n}`;
  };
}

/** Next free dimension name `d<n>`. */
export function nextDimensionName(sketch: SketchData): string {
  let max = 0;
  for (const d of sketch.dimensions) {
    const m = /^d(\d+)$/.exec(d.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `d${max + 1}`;
}
