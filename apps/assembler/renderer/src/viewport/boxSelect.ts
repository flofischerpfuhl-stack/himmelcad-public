/**
 * Box (rectangle) selection, pure: no DOM, no WebGL (unit tested).
 *
 * Shapr3D semantics (interaction research §2): dragging left → right is a
 * *window* that selects only entities lying completely inside the
 * rectangle; right → left is a *crossing* box that selects everything it
 * touches. While the box is dragged, Tab cycles the filter (All, Bodies,
 * Faces, Edges) and B/F/E pick one directly.
 *
 * Occlusion: without Select Through only visible geometry counts. The
 * viewport passes the pick targets whose ids appear in the picking buffer
 * (`visibleKeys` anywhere on screen, `touchedKeys` inside the rectangle);
 * with Select Through the test is purely geometric (hidden geometry too).
 */
import { referenceMeshIdOf } from '../model/referenceMesh.js';
import type { Body, EvaluatedSketch } from '../foundation/geometry-kernel/types.js';
import type { SelectionItem } from '../foundation/commands/store.js';
import type { Vec3 } from './math.js';
import type { PickTarget } from './picking.js';

export type BoxFilter = 'all' | 'bodies' | 'faces' | 'edges';
export const BOX_FILTERS: readonly BoxFilter[] = ['all', 'bodies', 'faces', 'edges'];
export const BOX_FILTER_LABEL: Record<BoxFilter, string> = {
  all: 'All items',
  bodies: 'Bodies only',
  faces: 'Faces only',
  edges: 'Edges only',
};

/** `window` = left → right, fully enclosed; `crossing` = right → left, touched. */
export type BoxMode = 'window' | 'crossing';

export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type ScreenPoint = readonly [number, number];

export function nextBoxFilter(filter: BoxFilter, backwards = false): BoxFilter {
  const index = BOX_FILTERS.indexOf(filter);
  const step = backwards ? BOX_FILTERS.length - 1 : 1;
  return BOX_FILTERS[(index + step) % BOX_FILTERS.length]!;
}

/** B/F/E (and A for all) set the filter directly while a box is dragged. */
export function boxFilterForKey(key: string): BoxFilter | null {
  switch (key.toLowerCase()) {
    case 'a':
      return 'all';
    case 'b':
      return 'bodies';
    case 'f':
      return 'faces';
    case 'e':
      return 'edges';
    default:
      return null;
  }
}

export function boxModeFor(startX: number, currentX: number): BoxMode {
  return currentX >= startX ? 'window' : 'crossing';
}

export function normalizeRect(ax: number, ay: number, bx: number, by: number): ScreenRect {
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

export function pointInRect(p: ScreenPoint, r: ScreenRect): boolean {
  return p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1;
}

function segmentsIntersect(
  a: ScreenPoint,
  b: ScreenPoint,
  c: ScreenPoint,
  d: ScreenPoint,
): boolean {
  const cross = (o: ScreenPoint, p: ScreenPoint, q: ScreenPoint) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0);
}

/** `true` if segment `a`-`b` has any point inside the rectangle. */
export function segmentTouchesRect(a: ScreenPoint, b: ScreenPoint, r: ScreenRect): boolean {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const corners: ScreenPoint[] = [
    [r.x0, r.y0],
    [r.x1, r.y0],
    [r.x1, r.y1],
    [r.x0, r.y1],
  ];
  for (let i = 0; i < 4; i += 1) {
    if (segmentsIntersect(a, b, corners[i]!, corners[(i + 1) % 4]!)) return true;
  }
  return false;
}

function pointInTriangle(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint, c: ScreenPoint): boolean {
  const s = (p0: ScreenPoint, p1: ScreenPoint, p2: ScreenPoint) =>
    (p0[0] - p2[0]) * (p1[1] - p2[1]) - (p1[0] - p2[0]) * (p0[1] - p2[1]);
  const d1 = s(p, a, b);
  const d2 = s(p, b, c);
  const d3 = s(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

export function triangleTouchesRect(
  a: ScreenPoint,
  b: ScreenPoint,
  c: ScreenPoint,
  r: ScreenRect,
): boolean {
  if (segmentTouchesRect(a, b, r) || segmentTouchesRect(b, c, r) || segmentTouchesRect(c, a, r)) {
    return true;
  }
  // The rectangle lies completely inside the triangle.
  return pointInTriangle([r.x0, r.y0], a, b, c);
}

/** `true` if the rectangle's corner lies inside a closed polygon (the box is inside a region). */
function rectInsidePolygon(r: ScreenRect, polygon: readonly ScreenPoint[]): boolean {
  const [x, y] = [r.x0, r.y0];
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Stable string key of a pick target / selection item (faces/edges by naming key). */
export function targetKey(t: PickTarget | SelectionItem): string {
  switch (t.kind) {
    case 'body':
      return `body|${t.bodyId}`;
    case 'mesh':
      return `mesh|${t.meshId}`;
    case 'face':
      return `face|${t.bodyId}|${t.faceKey}`;
    case 'edge':
      return `edge|${t.bodyId}|${t.edgeKey}`;
    case 'sketchProfile':
      return `sketch|${t.featureId}|${t.regionKey ?? ''}`;
    case 'feature':
      return `feature|${t.featureId}`;
    case 'sketchLine':
      return `sketchLine|${t.featureId}|${t.entityId}`;
    case 'datum':
      return `datum|${t.featureId}`;
    case 'extrudeHandle':
      return 'handle|extrude';
    case 'moveHandle':
      return `handle|move|${t.axis}`;
    case 'moveTile':
      return `handle|tile|${t.plane}`;
    case 'toolHandle':
      return `handle|${t.handle}`;
  }
}

/** Projects a world point to viewport CSS pixels, `null` when behind the camera. */
export type Projector = (p: Vec3) => ScreenPoint | null;

export interface BoxSelectInput {
  rect: ScreenRect;
  mode: BoxMode;
  filter: BoxFilter;
  /** Bodies shown (hidden/isolated-away bodies already removed). */
  bodies: readonly Body[];
  sketches: readonly EvaluatedSketch[];
  project: Projector;
  /** Keys ({@link targetKey}) of pick targets visible anywhere in the picking buffer. */
  visibleKeys: ReadonlySet<string>;
  /** Keys of pick targets visible inside the rectangle. */
  touchedKeys: ReadonlySet<string>;
  /** Hidden (occluded) geometry counts too. */
  selectThrough: boolean;
}

function projectAll(points: Iterable<Vec3>, project: Projector): ScreenPoint[] | null {
  const out: ScreenPoint[] = [];
  for (const p of points) {
    const s = project(p);
    if (!s) return null;
    out.push(s);
  }
  return out;
}

function* meshVertices(body: Body, triangleStart = 0, triangleCount?: number): Generator<Vec3> {
  const { positions, indices } = body.mesh;
  const end = triangleCount === undefined ? indices.length / 3 : triangleStart + triangleCount;
  for (let t = triangleStart; t < end; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const i = indices[t * 3 + k]!;
      yield [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    }
  }
}

function* segmentPoints(segments: Float32Array): Generator<Vec3> {
  for (let i = 0; i + 2 < segments.length; i += 3) {
    yield [segments[i]!, segments[i + 1]!, segments[i + 2]!];
  }
}

function enclosed(points: readonly ScreenPoint[] | null, rect: ScreenRect): boolean {
  return points !== null && points.length > 0 && points.every((p) => pointInRect(p, rect));
}

function segmentsTouch(points: readonly ScreenPoint[] | null, rect: ScreenRect): boolean {
  if (!points) return false;
  for (let i = 0; i + 1 < points.length; i += 2) {
    if (segmentTouchesRect(points[i]!, points[i + 1]!, rect)) return true;
  }
  return false;
}

function trianglesTouch(points: readonly ScreenPoint[] | null, rect: ScreenRect): boolean {
  if (!points) return false;
  for (let i = 0; i + 2 < points.length; i += 3) {
    if (triangleTouchesRect(points[i]!, points[i + 1]!, points[i + 2]!, rect)) return true;
  }
  return false;
}

/**
 * The selection a box yields. `all` selects whole items (bodies and sketch
 * profiles) — the useful unit for Move, Isolate, Hide or Delete; the other
 * filters select only that kind.
 */
export function boxSelect(input: BoxSelectInput): SelectionItem[] {
  const { rect, mode, filter, project, selectThrough } = input;
  const out: SelectionItem[] = [];
  const visible = (key: string) => selectThrough || input.visibleKeys.has(key);

  for (const body of input.bodies) {
    // A reference mesh (imported STL) is only ever selected whole: it takes part
    // in body boxes, never in face/edge boxes (it has no B-rep faces or edges).
    const meshId = referenceMeshIdOf(body.id);
    if (meshId !== null && filter !== 'all' && filter !== 'bodies') continue;
    const bodyVisible =
      selectThrough ||
      body.faces.some((f) =>
        input.visibleKeys.has(targetKey({ kind: 'face', bodyId: body.id, faceKey: f.key })),
      ) ||
      body.edges.some((e) =>
        input.visibleKeys.has(targetKey({ kind: 'edge', bodyId: body.id, edgeKey: e.key })),
      );

    if (filter === 'all' || filter === 'bodies') {
      let hit = false;
      if (mode === 'window') {
        hit = bodyVisible && enclosed(projectAll(meshVertices(body), project), rect);
      } else if (selectThrough) {
        hit = trianglesTouch(projectAll(meshVertices(body), project), rect);
      } else {
        hit =
          body.faces.some((f) =>
            input.touchedKeys.has(targetKey({ kind: 'face', bodyId: body.id, faceKey: f.key })),
          ) ||
          body.edges.some((e) =>
            input.touchedKeys.has(targetKey({ kind: 'edge', bodyId: body.id, edgeKey: e.key })),
          );
      }
      if (hit)
        out.push(meshId !== null ? { kind: 'mesh', meshId } : { kind: 'body', bodyId: body.id });
      continue;
    }

    if (filter === 'faces') {
      for (const face of body.faces) {
        const item: SelectionItem = { kind: 'face', bodyId: body.id, faceKey: face.key };
        const key = targetKey(item);
        let hit: boolean;
        if (mode === 'window') {
          hit =
            visible(key) &&
            enclosed(
              projectAll(meshVertices(body, face.triangleStart, face.triangleCount), project),
              rect,
            );
        } else if (selectThrough) {
          hit = trianglesTouch(
            projectAll(meshVertices(body, face.triangleStart, face.triangleCount), project),
            rect,
          );
        } else {
          hit = input.touchedKeys.has(key);
        }
        if (hit) out.push(item);
      }
      continue;
    }

    for (const edge of body.edges) {
      const item: SelectionItem = { kind: 'edge', bodyId: body.id, edgeKey: edge.key };
      const key = targetKey(item);
      const points = () => projectAll(segmentPoints(edge.segments), project);
      let hit: boolean;
      if (mode === 'window') hit = visible(key) && enclosed(points(), rect);
      else if (selectThrough) hit = segmentsTouch(points(), rect);
      else hit = input.touchedKeys.has(key);
      if (hit) out.push(item);
    }
  }

  if (filter === 'all') {
    for (const sketch of input.sketches) {
      for (const profile of sketch.profiles) {
        const item: SelectionItem = {
          kind: 'sketchProfile',
          featureId: sketch.featureId,
          regionKey: profile.key,
        };
        // Sketch profiles are flat overlays drawn on top: tested geometrically in both modes.
        const outline = projectAll(profile.outline, project);
        const hit =
          mode === 'window'
            ? enclosed(outline, rect)
            : input.touchedKeys.has(targetKey(item)) ||
              (outline !== null &&
                outline.some((p, i) =>
                  segmentTouchesRect(p, outline[(i + 1) % outline.length]!, rect),
                )) ||
              (outline !== null && rectInsidePolygon(rect, outline));
        if (hit) out.push(item);
      }
    }
  }
  return out;
}

/** Merges a box result into the current selection (Shift adds; otherwise it replaces). */
export function mergeSelection(
  current: readonly SelectionItem[],
  result: readonly SelectionItem[],
  additive: boolean,
): SelectionItem[] {
  if (!additive) return [...result];
  const keys = new Set(current.map(targetKey));
  return [...current, ...result.filter((item) => !keys.has(targetKey(item)))];
}
