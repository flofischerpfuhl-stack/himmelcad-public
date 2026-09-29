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

export type SketchCurve = SketchLine | SketchCircle | SketchArc;
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
  | 'pointOnObject';

export interface SketchConstraint {
  id: string;
  kind: SketchConstraintKind;
  refs: string[];
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
}

/** The solver-relevant content of a sketch feature. */
export interface SketchData {
  entities: SketchEntity[];
  constraints: SketchConstraint[];
  dimensions: SketchDimension[];
}

export const EMPTY_SKETCH: SketchData = { entities: [], constraints: [], dimensions: [] };

export function isCurve(entity: SketchEntity | undefined): entity is SketchCurve {
  return entity?.kind === 'line' || entity?.kind === 'circle' || entity?.kind === 'arc';
}

export function isRound(entity: SketchEntity | undefined): entity is SketchCircle | SketchArc {
  return entity?.kind === 'circle' || entity?.kind === 'arc';
}

/** Point ids a curve is defined by (vertex + centre points). */
export function curvePointIds(entity: SketchCurve): string[] {
  if (entity.kind === 'line') return [entity.a, entity.b];
  if (entity.kind === 'circle') return [entity.center];
  return [entity.center, entity.start, entity.end];
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
 * Prefixes in use: `p` point, `l` line, `c` circle, `a` arc, `k`
 * constraint, `m` dimension.
 */
export function idAllocator(sketch: SketchData): (prefix: string) => string {
  const next = new Map<string, number>();
  const all = [...sketch.entities, ...sketch.constraints, ...sketch.dimensions];
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
