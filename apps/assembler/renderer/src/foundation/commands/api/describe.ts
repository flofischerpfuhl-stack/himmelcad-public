/**
 * Read-model projections of the kernel's evaluation for the agent contract:
 * readable names and geometric descriptors of faces/edges (keyed by the
 * stable naming keys of `kernel/naming.ts`), body summaries, and the
 * CadQuery-style selector language used by `faces.list`/`edges.list` and by
 * `{bodyId, select}` reference inputs. Pure functions; no store access.
 */
import type { Body, EdgeInfo, EvaluationResult, FaceInfo } from '../../geometry-kernel/types.js';
import type { Feature, Vec3 } from '../../document/document.js';
import { ApiError } from './errors.js';

export interface FaceDescriptor {
  bodyId: string;
  key: string;
  aliases: string[];
  name: string;
  surface: FaceInfo['surface'];
  normal: Vec3 | null;
  centroid: Vec3;
  area: number;
  adjacentFaces: number;
  edgeKeys: string[];
}

export interface EdgeDescriptor {
  bodyId: string;
  key: string;
  name: string;
  curve: EdgeInfo['curve'];
  midpoint: Vec3;
  length: number;
  direction: Vec3 | null;
  radius: number | null;
  faceKeys: string[];
}

export interface BodyDescriptor {
  id: string;
  name: string;
  color: string;
  createdBy: string;
  valid: boolean;
  volume: number;
  area: number;
  bbox: { min: Vec3; max: Vec3; size: Vec3 };
  faceCount: number;
  edgeCount: number;
  /** Assembly folder path of an imported STEP part. */
  itemPath?: string[];
}

export function round(value: number, digits = 2): number {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}

/** Rounds away float noise (1e-9 mm) for JSON output while keeping full practical precision. */
function clean(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function cleanVec(v: readonly number[]): Vec3 {
  return [clean(v[0]!), clean(v[1]!), clean(v[2]!)];
}

function featureLabel(key: string, features: readonly Feature[]): string {
  const [featureId = key, role = ''] = key.split(':');
  const name = features.find((f) => f.id === featureId)?.name ?? featureId;
  return role ? `${name} ${role}` : name;
}

export function axisName(normal: readonly number[] | null): string {
  if (!normal) return '';
  const labels = ['X', 'Y', 'Z'];
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(Math.abs(normal[i]!) - 1) < 1e-6) {
      return `${normal[i]! > 0 ? '+' : '-'}${labels[i]}`;
    }
  }
  return `(${normal.map((n) => round(n, 3)).join(', ')})`;
}

/** `"Extrude 1 end · plane +Z at 40, 25, 6 · 4000 mm²"`. */
export function describeFaceName(face: FaceInfo, features: readonly Feature[]): string {
  const where = face.normal
    ? `${axisName(face.normal)} at ${face.centroid.map((c) => round(c)).join(', ')}`
    : `at ${face.centroid.map((c) => round(c)).join(', ')}`;
  return `${featureLabel(face.key, features)} · ${face.surface} ${where} · ${round(face.area)} mm²`;
}

/** `"Circle Ø6 at 40, 20, 6"`, `"Line +X 80 mm at 40, 42, 6"`. */
export function describeEdgeName(edge: EdgeInfo): string {
  const at = edge.midpoint.map((c) => round(c)).join(', ');
  if (edge.curve === 'circle' && edge.radius) {
    const full = Math.abs(edge.length - 2 * Math.PI * edge.radius) < 1e-6 * edge.length + 1e-6;
    return full
      ? `Circle Ø${round(edge.radius * 2)} at ${at}`
      : `Arc R${round(edge.radius)} at ${at}`;
  }
  if (edge.curve === 'line') {
    return `Line ${axisName(edge.direction)} ${round(edge.length)} mm at ${at}`;
  }
  return `${edge.curve} ${round(edge.length)} mm at ${at}`;
}

export function describeFace(
  body: Body,
  face: FaceInfo,
  features: readonly Feature[],
): FaceDescriptor {
  return {
    bodyId: body.id,
    key: face.key,
    aliases: [...face.aliases],
    name: describeFaceName(face, features),
    surface: face.surface,
    normal: face.normal ? cleanVec(face.normal) : null,
    centroid: cleanVec(face.centroid),
    area: clean(face.area),
    adjacentFaces: face.adjacentFaces,
    edgeKeys: face.edgeIndices.map((i) => body.edges[i]?.key ?? '?'),
  };
}

export function describeEdge(body: Body, edge: EdgeInfo): EdgeDescriptor {
  return {
    bodyId: body.id,
    key: edge.key,
    name: describeEdgeName(edge),
    curve: edge.curve,
    midpoint: cleanVec(edge.midpoint),
    length: clean(edge.length),
    direction: edge.direction ? cleanVec(edge.direction) : null,
    radius: edge.radius ?? null,
    faceKeys: edge.faceIndices.map((i) => body.faces[i]?.key ?? '?'),
  };
}

export function describeBody(body: Body): BodyDescriptor {
  const min = cleanVec(body.min);
  const max = cleanVec(body.max);
  return {
    id: body.id,
    name: body.name,
    color: body.color,
    createdBy: body.createdBy,
    valid: body.valid,
    volume: clean(body.volume),
    area: clean(body.faces.reduce((sum, f) => sum + f.area, 0)),
    bbox: { min, max, size: cleanVec([max[0] - min[0], max[1] - min[1], max[2] - min[2]]) },
    faceCount: body.faces.length,
    edgeCount: body.edges.length,
    ...(body.itemPath && body.itemPath.length > 0 ? { itemPath: [...body.itemPath] } : {}),
  };
}

export function findBody(evaluation: EvaluationResult, bodyId: string): Body {
  const body = evaluation.bodies.find((b) => b.id === bodyId);
  if (!body) {
    throw new ApiError('notFound', `No body "${bodyId}"`, {
      hint: 'List bodies with bodies.list; body ids are "body:<creating feature id>".',
      details: { candidates: evaluation.bodies.map((b) => ({ id: b.id, name: b.name })) },
    });
  }
  return body;
}

// ---- selectors ----------------------------------------------------------------------

const AXES: Record<string, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const PARALLEL = 1 - 1e-6;
const PERPENDICULAR = 1e-6;

interface Selectable {
  surfaceOrCurve: string;
  /** Planar face normal or line direction. */
  direction: Vec3 | null;
  /** `true` for faces (normal sign matters), `false` for edges (direction sign is arbitrary). */
  signed: boolean;
  position: Vec3;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function parseAxis(token: string, text: string): Vec3 {
  const axis = AXES[token.toUpperCase()];
  if (!axis) {
    throw new ApiError('invalidParams', `Selector "${text}": unknown axis "${token}"`, {
      hint: 'Axes are X, Y or Z, e.g. ">Z", "+X", "|Y".',
    });
  }
  return axis;
}

/**
 * Applies a selector to `items` (already projected to {@link Selectable}).
 * Terms combine with " and " left to right; `>`/`<` pick the extreme among
 * the items remaining at that point (ties within 1e-6 of the body size kept).
 */
function applySelector<T>(items: T[], project: (item: T) => Selectable, text: string): T[] {
  const terms = text
    .split(/\s+and\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);
  if (terms.length === 0) {
    throw new ApiError('invalidParams', 'Empty selector');
  }
  let current = items;
  for (const term of terms) {
    const op = term[0]!;
    const rest = term.slice(1).trim();
    if (op === '%') {
      const kind = rest.toLowerCase();
      current = current.filter((item) => project(item).surfaceOrCurve === kind);
      continue;
    }
    const axis = parseAxis(rest, text);
    if (op === '+' || op === '-') {
      const want: Vec3 = op === '+' ? axis : [-axis[0], -axis[1], -axis[2]];
      current = current.filter((item) => {
        const p = project(item);
        if (!p.direction) return false;
        const d = dot(p.direction, want);
        return p.signed ? d > PARALLEL : Math.abs(d) > PARALLEL;
      });
    } else if (op === '|') {
      current = current.filter((item) => {
        const d = project(item).direction;
        return d !== null && Math.abs(dot(d, axis)) > PARALLEL;
      });
    } else if (op === '#') {
      current = current.filter((item) => {
        const d = project(item).direction;
        return d !== null && Math.abs(dot(d, axis)) < PERPENDICULAR;
      });
    } else if (op === '>' || op === '<') {
      if (current.length === 0) continue;
      const values = current.map((item) => dot(project(item).position, axis));
      const extreme = op === '>' ? Math.max(...values) : Math.min(...values);
      const span = Math.max(...values) - Math.min(...values);
      const tol = Math.max(1e-6, span * 1e-9);
      current = current.filter((_, i) => Math.abs(values[i]! - extreme) <= tol);
    } else {
      throw new ApiError('invalidParams', `Selector "${text}": unknown operator "${op}"`, {
        hint: 'Use +Z/-Z, |Z, #Z, >Z, <Z, %PLANE, %CYLINDER, %LINE or %CIRCLE, joined by " and ".',
      });
    }
  }
  return current;
}

export function selectFaces(body: Body, text: string): FaceInfo[] {
  return applySelector(
    body.faces,
    (face) => ({
      surfaceOrCurve: face.surface,
      direction: face.normal,
      signed: true,
      position: face.centroid,
    }),
    text,
  );
}

export function selectEdges(body: Body, text: string): EdgeInfo[] {
  return applySelector(
    body.edges,
    (edge) => ({
      surfaceOrCurve: edge.curve,
      direction: edge.curve === 'line' ? edge.direction : null,
      signed: false,
      position: edge.midpoint,
    }),
    text,
  );
}
