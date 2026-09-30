/**
 * Programmatic sketch construction: rectangles, circles and polylines with
 * their Shapr3D-style constraints and (optionally) full dimensions. Used by
 * the drawing tools, the demo document, the v1 → v2 project migration and
 * tests. Pure functions returning new {@link SketchData}.
 */
import { naturalHandles } from './spline.js';
import {
  idAllocator,
  nextDimensionName,
  ORIGIN_ID,
  type SketchConstraint,
  type SketchData,
  type SketchDimension,
  type SketchDimensionKind,
  type SketchEntity,
  type Vec2,
} from './types.js';

export interface BuildOptions {
  /** Mark new curves as construction geometry. */
  construction?: boolean;
  /** Add size dimensions (rectangle width/height, circle diameter). */
  size?: boolean;
  /** Add position dimensions from the sketch origin (rectangle corner, circle centre). */
  position?: boolean;
}

function pushDimension(
  sketch: SketchData,
  alloc: (prefix: string) => string,
  kind: SketchDimensionKind,
  refs: string[],
  value: number,
): SketchData {
  const dimension: SketchDimension = {
    id: alloc('m'),
    name: nextDimensionName(sketch),
    kind,
    refs,
    value: Math.abs(value),
  };
  return { ...sketch, dimensions: [...sketch.dimensions, dimension] };
}

/**
 * Adds an axis-aligned rectangle with corners `(x0, y0)` and `(x1, y1)`:
 * four points, four lines in counter-clockwise order starting at the
 * bottom (-v) side, two horizontal and two vertical constraints.
 */
export function addRectangle(
  sketch: SketchData,
  corner0: Vec2,
  corner1: Vec2,
  options: BuildOptions = {},
): { sketch: SketchData; pointIds: string[]; lineIds: string[] } {
  const alloc = idAllocator(sketch);
  const x0 = Math.min(corner0[0], corner1[0]);
  const x1 = Math.max(corner0[0], corner1[0]);
  const y0 = Math.min(corner0[1], corner1[1]);
  const y1 = Math.max(corner0[1], corner1[1]);
  const corners: Vec2[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const pointIds = corners.map(() => alloc('p'));
  const lineIds = corners.map(() => alloc('l'));
  const construction = options.construction ? { construction: true } : {};
  const entities: SketchEntity[] = [
    ...corners.map(
      (c, i): SketchEntity => ({
        id: pointIds[i]!,
        kind: 'point',
        x: c[0],
        y: c[1],
        ...construction,
      }),
    ),
    ...lineIds.map(
      (id, i): SketchEntity => ({
        id,
        kind: 'line',
        a: pointIds[i]!,
        b: pointIds[(i + 1) % 4]!,
        ...construction,
      }),
    ),
  ];
  const constraints: SketchConstraint[] = [
    { id: alloc('k'), kind: 'horizontal', refs: [lineIds[0]!] },
    { id: alloc('k'), kind: 'vertical', refs: [lineIds[1]!] },
    { id: alloc('k'), kind: 'horizontal', refs: [lineIds[2]!] },
    { id: alloc('k'), kind: 'vertical', refs: [lineIds[3]!] },
  ];
  let next: SketchData = {
    entities: [...sketch.entities, ...entities],
    constraints: [...sketch.constraints, ...constraints],
    dimensions: sketch.dimensions,
  };
  if (options.position) {
    next = pushDimension(next, alloc, 'horizontalDistance', [ORIGIN_ID, pointIds[0]!], x0);
    next = pushDimension(next, alloc, 'verticalDistance', [ORIGIN_ID, pointIds[0]!], y0);
  }
  if (options.size) {
    next = pushDimension(next, alloc, 'distance', [lineIds[0]!], x1 - x0);
    next = pushDimension(next, alloc, 'distance', [lineIds[1]!], y1 - y0);
  }
  return { sketch: next, pointIds, lineIds };
}

/** Adds a circle (centre point + circle), optionally with diameter/position dimensions. */
export function addCircle(
  sketch: SketchData,
  center: Vec2,
  radius: number,
  options: BuildOptions = {},
): { sketch: SketchData; centerId: string; circleId: string } {
  const alloc = idAllocator(sketch);
  const centerId = alloc('p');
  const circleId = alloc('c');
  const construction = options.construction ? { construction: true } : {};
  let next: SketchData = {
    ...sketch,
    entities: [
      ...sketch.entities,
      { id: centerId, kind: 'point', x: center[0], y: center[1] },
      { id: circleId, kind: 'circle', center: centerId, radius, ...construction },
    ],
  };
  if (options.position) {
    next = pushDimension(next, alloc, 'horizontalDistance', [ORIGIN_ID, centerId], center[0]);
    next = pushDimension(next, alloc, 'verticalDistance', [ORIGIN_ID, centerId], center[1]);
  }
  if (options.size) next = pushDimension(next, alloc, 'diameter', [circleId], radius * 2);
  return { sketch: next, centerId, circleId };
}

/**
 * Adds a polyline through `points` (consecutive lines share their vertex
 * points). `closed` connects the last point back to the first.
 */
export function addPolyline(
  sketch: SketchData,
  points: readonly Vec2[],
  options: BuildOptions & { closed?: boolean } = {},
): { sketch: SketchData; pointIds: string[]; lineIds: string[] } {
  const alloc = idAllocator(sketch);
  const pointIds = points.map(() => alloc('p'));
  const count = options.closed ? points.length : points.length - 1;
  const lineIds = Array.from({ length: Math.max(0, count) }, () => alloc('l'));
  const construction = options.construction ? { construction: true } : {};
  const entities: SketchEntity[] = [
    ...points.map((p, i): SketchEntity => ({ id: pointIds[i]!, kind: 'point', x: p[0], y: p[1] })),
    ...lineIds.map(
      (id, i): SketchEntity => ({
        id,
        kind: 'line',
        a: pointIds[i]!,
        b: pointIds[(i + 1) % points.length]!,
        ...construction,
      }),
    ),
  ];
  return {
    sketch: { ...sketch, entities: [...sketch.entities, ...entities] },
    pointIds,
    lineIds,
  };
}

/**
 * Adds an ellipse (centre, major-axis end, minor-axis end points). `rx` is
 * the radius along `angle` (degrees), `ry` perpendicular to it. With
 * `arc: [start°, end°]` (parametric angles, counter-clockwise) an
 * elliptical arc is added instead.
 */
export function addEllipse(
  sketch: SketchData,
  center: Vec2,
  rx: number,
  ry: number,
  angle = 0,
  options: BuildOptions & { arc?: [number, number] } = {},
): { sketch: SketchData; entityId: string; pointIds: string[] } {
  const alloc = idAllocator(sketch);
  const a = (angle * Math.PI) / 180;
  const u: Vec2 = [Math.cos(a), Math.sin(a)];
  const v: Vec2 = [-u[1], u[0]];
  const at = (theta: number): Vec2 => [
    center[0] + u[0] * rx * Math.cos(theta) + v[0] * ry * Math.sin(theta),
    center[1] + u[1] * rx * Math.cos(theta) + v[1] * ry * Math.sin(theta),
  ];
  const ids = { c: alloc('p'), m: alloc('p'), n: alloc('p') };
  const entities: SketchEntity[] = [
    { id: ids.c, kind: 'point', x: center[0], y: center[1] },
    { id: ids.m, kind: 'point', x: at(0)[0], y: at(0)[1] },
    { id: ids.n, kind: 'point', x: at(Math.PI / 2)[0], y: at(Math.PI / 2)[1] },
  ];
  const construction = options.construction ? { construction: true } : {};
  let entityId: string;
  const pointIds = [ids.c, ids.m, ids.n];
  if (options.arc) {
    const s = alloc('p');
    const e = alloc('p');
    const ps = at((options.arc[0] * Math.PI) / 180);
    const pe = at((options.arc[1] * Math.PI) / 180);
    entities.push(
      { id: s, kind: 'point', x: ps[0], y: ps[1] },
      { id: e, kind: 'point', x: pe[0], y: pe[1] },
    );
    entityId = alloc('ea');
    entities.push({
      id: entityId,
      kind: 'ellipticArc',
      center: ids.c,
      major: ids.m,
      minor: ids.n,
      start: s,
      end: e,
      ...construction,
    });
    pointIds.push(s, e);
  } else {
    entityId = alloc('e');
    entities.push({
      id: entityId,
      kind: 'ellipse',
      center: ids.c,
      major: ids.m,
      minor: ids.n,
      ...construction,
    });
  }
  return { sketch: { ...sketch, entities: [...sketch.entities, ...entities] }, entityId, pointIds };
}

/**
 * Adds a spline through `points` (`fit`, with tangent handles unless
 * `handles: false`) or with `points` as its control polygon (`control`).
 * `endpoints` reuses existing point ids for the first/last point.
 */
export function addSpline(
  sketch: SketchData,
  points: readonly Vec2[],
  options: BuildOptions & {
    mode?: 'fit' | 'control';
    handles?: boolean | [Vec2 | null, Vec2 | null];
    endpoints?: [string | null, string | null];
  } = {},
): { sketch: SketchData; entityId: string; pointIds: string[]; handleIds: (string | null)[] } {
  const alloc = idAllocator(sketch);
  const mode = options.mode ?? 'fit';
  const entities: SketchEntity[] = [];
  const pointIds = points.map((p, i) => {
    const reuse =
      i === 0 ? options.endpoints?.[0] : i === points.length - 1 ? options.endpoints?.[1] : null;
    if (reuse) return reuse;
    const id = alloc('p');
    entities.push({ id, kind: 'point', x: p[0], y: p[1] });
    return id;
  });
  let handleIds: (string | null)[] = [];
  if (mode === 'fit' && options.handles !== false) {
    const given = Array.isArray(options.handles) ? options.handles : naturalHandles(points);
    handleIds = [0, 1].map((k) => {
      const h = given?.[k];
      if (!h) return null;
      const id = alloc('p');
      entities.push({ id, kind: 'point', x: h[0], y: h[1] });
      return id;
    });
  }
  const entityId = alloc('s');
  entities.push({
    id: entityId,
    kind: 'spline',
    mode,
    points: pointIds,
    ...(mode === 'control' ? { degree: 3 } : {}),
    ...(handleIds.length === 2
      ? { handles: [handleIds[0]!, handleIds[1]!] as [string | null, string | null] }
      : {}),
    ...(options.construction ? { construction: true } : {}),
  });
  return {
    sketch: { ...sketch, entities: [...sketch.entities, ...entities] },
    entityId,
    pointIds,
    handleIds,
  };
}

/** Adds a text entity (anchor point + stored outline). */
export function addText(
  sketch: SketchData,
  anchor: Vec2,
  text: { text: string; height: number; angle?: number; font: string; outline: string },
  options: BuildOptions = {},
): { sketch: SketchData; entityId: string; anchorId: string } {
  const alloc = idAllocator(sketch);
  const anchorId = alloc('p');
  const entityId = alloc('t');
  const entities: SketchEntity[] = [
    { id: anchorId, kind: 'point', x: anchor[0], y: anchor[1] },
    {
      id: entityId,
      kind: 'text',
      anchor: anchorId,
      text: text.text,
      height: text.height,
      angle: text.angle ?? 0,
      font: text.font,
      outline: text.outline,
      ...(options.construction ? { construction: true } : {}),
    },
  ];
  return { sketch: { ...sketch, entities: [...sketch.entities, ...entities] }, entityId, anchorId };
}

/** Appends constraints (ids allocated here). */
export function withConstraints(
  sketch: SketchData,
  constraints: readonly Omit<SketchConstraint, 'id'>[],
): SketchData {
  const alloc = idAllocator(sketch);
  return {
    ...sketch,
    constraints: [...sketch.constraints, ...constraints.map((c) => ({ ...c, id: alloc('k') }))],
  };
}

/** Appends one dimension (id and `d<n>` name allocated here). */
export function withDimension(
  sketch: SketchData,
  kind: SketchDimensionKind,
  refs: string[],
  value: number,
  extra: Partial<Pick<SketchDimension, 'expression' | 'offset'>> = {},
): { sketch: SketchData; dimensionId: string } {
  const alloc = idAllocator(sketch);
  const next = pushDimension(sketch, alloc, kind, refs, value);
  const dimension = next.dimensions[next.dimensions.length - 1]!;
  if (extra.expression !== undefined) dimension.expression = extra.expression;
  if (extra.offset !== undefined) dimension.offset = extra.offset;
  return { sketch: next, dimensionId: dimension.id };
}

// ---- legacy (schema v1) profiles ---------------------------------------------------

/** Schema v1 sketch profile shape (rectangle or circle), kept for migration only. */
export type LegacySketchProfile =
  | { kind: 'rectangle'; x: number; y: number; width: number; height: number }
  | { kind: 'circle'; cx: number; cy: number; radius: number };

/**
 * Converts v1 rectangle/circle profiles into a fully dimensioned v2 sketch
 * (position from the origin + size, so editing a size keeps the lower-left
 * corner / centre where it was, like the v1 parameters did).
 * `segmentEntities[i][s]` is the entity id that replaces legacy segment `s`
 * of profile `i` (rectangle: 0 bottom, 1 right, 2 top, 3 left; circle: 0).
 */
export function sketchFromLegacyProfiles(profiles: readonly LegacySketchProfile[]): {
  sketch: SketchData;
  segmentEntities: string[][];
} {
  let sketch: SketchData = { entities: [], constraints: [], dimensions: [] };
  const segmentEntities: string[][] = [];
  for (const profile of profiles) {
    if (profile.kind === 'rectangle') {
      const x0 = profile.width >= 0 ? profile.x : profile.x + profile.width;
      const y0 = profile.height >= 0 ? profile.y : profile.y + profile.height;
      const w = Math.abs(profile.width);
      const h = Math.abs(profile.height);
      const built = addRectangle(sketch, [x0, y0], [x0 + w, y0 + h], {
        position: true,
        size: true,
      });
      sketch = built.sketch;
      segmentEntities.push(built.lineIds);
    } else {
      const built = addCircle(sketch, [profile.cx, profile.cy], profile.radius, {
        position: true,
        size: true,
      });
      sketch = built.sketch;
      segmentEntities.push([built.circleId]);
    }
  }
  return { sketch, segmentEntities };
}

/** `true` if `point` lies inside a legacy profile's area. */
export function legacyProfileContains(profile: LegacySketchProfile, point: Vec2): boolean {
  if (profile.kind === 'circle') {
    return Math.hypot(point[0] - profile.cx, point[1] - profile.cy) < profile.radius;
  }
  const x0 = Math.min(profile.x, profile.x + profile.width);
  const x1 = Math.max(profile.x, profile.x + profile.width);
  const y0 = Math.min(profile.y, profile.y + profile.height);
  const y1 = Math.max(profile.y, profile.y + profile.height);
  return point[0] > x0 && point[0] < x1 && point[1] > y0 && point[1] < y1;
}
