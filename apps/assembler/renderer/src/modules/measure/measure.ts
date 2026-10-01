/**
 * Measure panel logic (interaction research §5: a movable panel with the
 * current and pinned measurements). Pure: what a set of references
 * measures, from the kernel's exact B-rep data where it has it
 * (`FaceInfo`/`EdgeInfo`: areas, lengths, radii, normals, the exact body
 * volume) and from the evaluated meshes where it does not (circle centres
 * from the edge polyline, reference meshes). Minimum distances come from
 * the kernel (`BRepExtrema_DistShapeShape`, exact) through
 * {@link MeasureContext.distance}; without it (reference meshes, kernel
 * unavailable) {@link meshMinDistance} gives a mesh-based value that is
 * always labelled "approx.".
 *
 * Values are millimetres, mm², mm³, degrees and grams; the panel formats
 * them in the user's display unit.
 */
import type { Body, EdgeInfo, FaceInfo } from '../../foundation/geometry-kernel/types.js';
import {
  DEFAULT_DENSITY_MATERIAL,
  materialPreset,
  type MaterialId,
} from '../../platform/viewport/displayModes.js';
import type { ReferenceMesh } from '../../foundation/commands/referenceMesh.js';
import { referenceMeshToBody } from '../../foundation/commands/referenceMesh.js';
import type { SelectionItem } from '../../foundation/commands/store.js';

export type Vec3 = [number, number, number];

/** What a measurement refers to: selection items or a picked point. */
export type MeasureRef =
  | { kind: 'body'; bodyId: string }
  | { kind: 'face'; bodyId: string; faceKey: string }
  | { kind: 'edge'; bodyId: string; edgeKey: string }
  | { kind: 'mesh'; meshId: string }
  | { kind: 'point'; point: Vec3; label: string };

export type ValueKind = 'length' | 'area' | 'volume' | 'angle' | 'mass' | 'count';

export interface MeasureValue {
  label: string;
  kind: ValueKind;
  value: number;
  /** Mesh-based estimate (not from the exact B-rep). */
  approx?: boolean;
  /** Secondary read-out (shown smaller, not drawn in the viewport). */
  secondary?: boolean;
}

/** World-space geometry drawn for a measurement (pinned ones in the viewport). */
export type MeasureGraphic =
  /** A dimension line; the first value's label sits at its middle. */
  | { kind: 'segment'; a: Vec3; b: Vec3 }
  /** Label anchor only (face area at the centroid). */
  | { kind: 'point'; at: Vec3 };

export interface Measurement {
  title: string;
  /** What was measured, e.g. "Body 1 · 2 faces". */
  subject: string;
  values: MeasureValue[];
  graphics: MeasureGraphic[];
  /** A kernel query for this measurement is still running. */
  pending?: boolean;
  /** Why nothing could be measured (shown instead of values). */
  note?: string;
}

/** Exact minimum distance between two references, from the kernel. */
export interface DistanceResult {
  distance: number;
  pointA: Vec3;
  pointB: Vec3;
  approx: boolean;
}

export interface MeasureContext {
  bodies: readonly Body[];
  referenceMeshes?: readonly ReferenceMesh[];
  /** Display names (Items renames), by body id. */
  bodyName?: (body: Body) => string;
  /** Material per body id (mass density). */
  materials?: ReadonlyMap<string, MaterialId>;
  /**
   * Minimum distance of two references: a result, `'pending'` while the
   * kernel computes, or `null` when the kernel cannot answer (then a mesh
   * estimate is used).
   */
  distance?: (a: MeasureRef, b: MeasureRef) => DistanceResult | 'pending' | null;
}

export function selectionToRefs(selection: readonly SelectionItem[]): MeasureRef[] {
  const out: MeasureRef[] = [];
  for (const item of selection) {
    if (item.kind === 'body') out.push({ kind: 'body', bodyId: item.bodyId });
    else if (item.kind === 'face')
      out.push({ kind: 'face', bodyId: item.bodyId, faceKey: item.faceKey });
    else if (item.kind === 'edge')
      out.push({ kind: 'edge', bodyId: item.bodyId, edgeKey: item.edgeKey });
    else if (item.kind === 'mesh') out.push({ kind: 'mesh', meshId: item.meshId });
  }
  return out;
}

/** The references the current measurement uses: picked points first, else the selection. */
export function currentRefs(
  selection: readonly SelectionItem[],
  points: readonly MeasureRef[],
): MeasureRef[] {
  if (points.length > 0) return [...points];
  return selectionToRefs(selection);
}

/** Stable text key of a reference (caches, equality). */
export function refKey(ref: MeasureRef): string {
  switch (ref.kind) {
    case 'body':
      return `body|${ref.bodyId}`;
    case 'face':
      return `face|${ref.bodyId}|${ref.faceKey}`;
    case 'edge':
      return `edge|${ref.bodyId}|${ref.edgeKey}`;
    case 'mesh':
      return `mesh|${ref.meshId}`;
    case 'point':
      return `point|${ref.point.map((v) => v.toFixed(6)).join(',')}`;
  }
}

// ---- vector helpers -----------------------------------------------------------------------

const sub = (a: readonly number[], b: readonly number[]): Vec3 => [
  a[0]! - b[0]!,
  a[1]! - b[1]!,
  a[2]! - b[2]!,
];
const dot = (a: readonly number[], b: readonly number[]) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const len = (a: readonly number[]) => Math.hypot(a[0]!, a[1]!, a[2]!);
const add = (a: readonly number[], b: readonly number[], s = 1): Vec3 => [
  a[0]! + b[0]! * s,
  a[1]! + b[1]! * s,
  a[2]! + b[2]! * s,
];
const unit = (a: readonly number[]): Vec3 => {
  const l = len(a) || 1;
  return [a[0]! / l, a[1]! / l, a[2]! / l];
};

/** Angle between two directions, degrees (0..180). */
export function angleBetween(a: readonly number[], b: readonly number[]): number {
  const c = dot(unit(a), unit(b));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

/** Points of an edge polyline (segment pairs → consecutive points). */
export function edgePoints(edge: EdgeInfo): Vec3[] {
  const s = edge.segments;
  const out: Vec3[] = [];
  for (let i = 0; i + 5 < s.length; i += 6) {
    if (out.length === 0) out.push([s[i]!, s[i + 1]!, s[i + 2]!]);
    out.push([s[i + 3]!, s[i + 4]!, s[i + 5]!]);
  }
  return out;
}

/** Circle through three points (centre, radius, unit normal), or `null` if collinear. */
export function circleThrough(
  a: Vec3,
  b: Vec3,
  c: Vec3,
): { center: Vec3; radius: number; normal: Vec3 } | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const n2 = dot(n, n);
  if (n2 < 1e-18) return null;
  // centre = a + ((|ac|² (n × ab)) + (|ab|² (ac × n))) / (2 |n|²)
  const t1 = cross(n, ab);
  const t2 = cross(ac, n);
  const ab2 = dot(ab, ab);
  const ac2 = dot(ac, ac);
  const center: Vec3 = [
    a[0] + (ac2 * t1[0] + ab2 * t2[0]) / (2 * n2),
    a[1] + (ac2 * t1[1] + ab2 * t2[1]) / (2 * n2),
    a[2] + (ac2 * t1[2] + ab2 * t2[2]) / (2 * n2),
  ];
  return { center, radius: len(sub(a, center)), normal: unit(n) };
}

/** Centre and axis of a circular edge, from its polyline (three well-spread points). */
export function circleOfEdge(
  edge: EdgeInfo,
): { center: Vec3; radius: number; normal: Vec3 } | null {
  if (edge.curve !== 'circle') return null;
  const points = edgePoints(edge);
  if (points.length < 3) return null;
  const n = points.length;
  const closed = len(sub(points[0]!, points[n - 1]!)) < 1e-6;
  const last = closed ? n - 1 : n;
  return circleThrough(
    points[0]!,
    points[Math.floor(last / 3)]!,
    points[Math.floor((2 * last) / 3)]!,
  );
}

export function isFullCircle(edge: EdgeInfo): boolean {
  return (
    !!edge.radius && Math.abs(edge.length - 2 * Math.PI * edge.radius) < 1e-6 * edge.length + 1e-6
  );
}

// ---- resolution -----------------------------------------------------------------------------

interface Resolved {
  ref: MeasureRef;
  body: Body | null;
  face?: FaceInfo;
  edge?: EdgeInfo;
  point?: Vec3;
  name: string;
}

function resolve(ref: MeasureRef, ctx: MeasureContext): Resolved | null {
  const nameOf = (b: Body) => ctx.bodyName?.(b) ?? b.name;
  if (ref.kind === 'point') return { ref, body: null, point: ref.point, name: ref.label };
  if (ref.kind === 'mesh') {
    const mesh = ctx.referenceMeshes?.find((m) => m.id === ref.meshId);
    if (!mesh) return null;
    return { ref, body: referenceMeshToBody(mesh), name: mesh.name };
  }
  const body = ctx.bodies.find((b) => b.id === ref.bodyId);
  if (!body) return null;
  if (ref.kind === 'body') return { ref, body, name: nameOf(body) };
  if (ref.kind === 'face') {
    const face = body.faces.find((f) => f.key === ref.faceKey || f.aliases.includes(ref.faceKey));
    return face ? { ref, body, face, name: `${nameOf(body)} · face` } : null;
  }
  const edge = body.edges.find((e) => e.key === ref.edgeKey);
  return edge ? { ref, body, edge, name: `${nameOf(body)} · edge` } : null;
}

function massValue(volume: number, material: MaterialId | undefined, approx = false): MeasureValue {
  const preset = materialPreset(material ?? DEFAULT_DENSITY_MATERIAL);
  return {
    label: `Mass (${preset.label.split(' ')[0]}, solid)`,
    kind: 'mass',
    // g/cm³ × mm³ / 1000 = g
    value: (volume * preset.density) / 1000,
    ...(approx ? { approx } : {}),
  };
}

/** Signed volume of a closed triangle mesh (divergence theorem); an estimate for reference meshes. */
export function meshVolume(positions: Float32Array, indices: Uint32Array): number {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    v +=
      (positions[a]! *
        (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!) -
        positions[a + 1]! *
          (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!) +
        positions[a + 2]! *
          (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!)) /
      6;
  }
  return Math.abs(v);
}

function boxGraphics(min: readonly number[], max: readonly number[]): MeasureGraphic[] {
  // The three box extents from the minimum corner (W, D, H dimension lines).
  const o: Vec3 = [min[0]!, min[1]!, min[2]!];
  return [
    { kind: 'segment', a: o, b: [max[0]!, min[1]!, min[2]!] },
    { kind: 'segment', a: o, b: [min[0]!, max[1]!, min[2]!] },
    { kind: 'segment', a: o, b: [min[0]!, min[1]!, max[2]!] },
  ];
}

function measureBody(r: Resolved, ctx: MeasureContext): Measurement {
  const body = r.body!;
  const isMesh = r.ref.kind === 'mesh';
  const size = [0, 1, 2].map((i) => body.max[i]! - body.min[i]!);
  const volume = isMesh ? meshVolume(body.mesh.positions, body.mesh.indices) : body.volume;
  const area = body.faces.reduce((sum, f) => sum + f.area, 0);
  const values: MeasureValue[] = [
    { label: 'Width (X)', kind: 'length', value: size[0]! },
    { label: 'Depth (Y)', kind: 'length', value: size[1]! },
    { label: 'Height (Z)', kind: 'length', value: size[2]! },
    { label: 'Volume', kind: 'volume', value: volume, ...(isMesh ? { approx: true } : {}) },
    massValue(volume, isMesh ? undefined : ctx.materials?.get(body.id), isMesh),
  ];
  if (!isMesh) values.push({ label: 'Surface area', kind: 'area', value: area, secondary: true });
  return {
    title: isMesh ? 'Reference mesh' : 'Body',
    subject: r.name,
    values,
    graphics: boxGraphics(body.min, body.max),
  };
}

function measureEdge(r: Resolved): Measurement {
  const edge = r.edge!;
  const points = edgePoints(edge);
  if (edge.curve === 'circle' && edge.radius) {
    const circle = circleOfEdge(edge);
    const full = isFullCircle(edge);
    const values: MeasureValue[] = full
      ? [
          { label: 'Diameter', kind: 'length', value: edge.radius * 2 },
          { label: 'Radius', kind: 'length', value: edge.radius },
          { label: 'Circumference', kind: 'length', value: edge.length, secondary: true },
        ]
      : [
          { label: 'Radius', kind: 'length', value: edge.radius },
          { label: 'Arc length', kind: 'length', value: edge.length },
          {
            label: 'Arc angle',
            kind: 'angle',
            value: ((edge.length / edge.radius) * 180) / Math.PI,
            secondary: true,
          },
        ];
    const graphics: MeasureGraphic[] = [];
    if (circle) {
      const onCircle = full
        ? add(circle.center, unit(sub(points[0]!, circle.center)), circle.radius)
        : edge.midpoint;
      if (full) {
        const opposite = add(circle.center, unit(sub(points[0]!, circle.center)), -circle.radius);
        graphics.push({ kind: 'segment', a: opposite, b: onCircle });
      } else {
        graphics.push({ kind: 'segment', a: circle.center, b: onCircle });
      }
    }
    return { title: full ? 'Circle' : 'Arc', subject: r.name, values, graphics };
  }
  const a = points[0];
  const b = points[points.length - 1];
  const values: MeasureValue[] = [{ label: 'Length', kind: 'length', value: edge.length }];
  if (edge.curve === 'line' && a && b) {
    const d = sub(b, a);
    values.push(
      { label: 'ΔX', kind: 'length', value: Math.abs(d[0]), secondary: true },
      { label: 'ΔY', kind: 'length', value: Math.abs(d[1]), secondary: true },
      { label: 'ΔZ', kind: 'length', value: Math.abs(d[2]), secondary: true },
    );
  }
  return {
    title: edge.curve === 'line' ? 'Edge' : 'Curve',
    subject: r.name,
    values,
    graphics: a && b && edge.curve === 'line' ? [{ kind: 'segment', a, b }] : [],
  };
}

/** Circle edges bounding a cylindrical face give its radius. */
function cylinderRadius(body: Body, face: FaceInfo): number | null {
  for (const i of face.edgeIndices) {
    const edge = body.edges[i];
    if (edge?.curve === 'circle' && edge.radius) return edge.radius;
  }
  return null;
}

function measureFace(r: Resolved): Measurement {
  const face = r.face!;
  const values: MeasureValue[] = [{ label: 'Area', kind: 'area', value: face.area }];
  let title = 'Face';
  if (face.surface === 'plane') title = 'Planar face';
  if (face.surface === 'cylinder') {
    title = 'Cylindrical face';
    const radius = cylinderRadius(r.body!, face);
    if (radius !== null) {
      values.push(
        { label: 'Diameter', kind: 'length', value: radius * 2 },
        { label: 'Radius', kind: 'length', value: radius, secondary: true },
      );
    }
  }
  return { title, subject: r.name, values, graphics: [{ kind: 'point', at: face.centroid }] };
}

/** Where a reference sits, for point-based measurements (point, circle centre, vertex-like). */
function anchorPoint(r: Resolved): Vec3 | null {
  if (r.point) return r.point;
  if (r.edge?.curve === 'circle') return circleOfEdge(r.edge)?.center ?? null;
  return null;
}

function lineOf(r: Resolved): { point: Vec3; dir: Vec3 } | null {
  if (r.edge?.curve !== 'line' || !r.edge.direction) return null;
  return { point: r.edge.midpoint, dir: unit(r.edge.direction) };
}

function planeOf(r: Resolved): { point: Vec3; normal: Vec3 } | null {
  if (r.face?.surface !== 'plane' || !r.face.normal) return null;
  return { point: r.face.centroid, normal: unit(r.face.normal) };
}

const PARALLEL_TOLERANCE_DEG = 1e-4;

/**
 * The X/Y/Z components of a distance from `a` to `b` (absolute, world axes;
 * secondary read-outs, Shapr3D "X/Y/Z components").
 */
export function componentValues(a: Vec3, b: Vec3, approx = false): MeasureValue[] {
  const d = sub(b, a);
  return (['X', 'Y', 'Z'] as const).map((axis, i) => ({
    label: `Δ${axis}`,
    kind: 'length' as const,
    value: Math.abs(d[i]!),
    secondary: true,
    ...(approx ? { approx: true } : {}),
  }));
}

/**
 * Sums over several items (Shapr3D: lengths of several edges, areas of
 * several faces, volumes/masses of several bodies). One value per kind that
 * occurs at least twice; `secondary` when they accompany a pair measurement.
 */
function totalValues(
  items: readonly Pick<Resolved, 'ref' | 'edge' | 'face' | 'body'>[],
  ctx: Pick<MeasureContext, 'materials'>,
  secondary = false,
): MeasureValue[] {
  const edges = items.filter((r) => r.edge);
  const faces = items.filter((r) => r.face);
  const bodies = items.filter((r) => !r.edge && !r.face && r.body);
  const out: MeasureValue[] = [];
  const flag = secondary ? { secondary: true } : {};
  if (edges.length >= 2) {
    const total = edges.reduce((sum, r) => sum + r.edge!.length, 0);
    out.push({
      label: `Total length (${edges.length} edges)`,
      kind: 'length',
      value: total,
      ...flag,
    });
  }
  if (faces.length >= 2) {
    const total = faces.reduce((sum, r) => sum + r.face!.area, 0);
    out.push({ label: `Total area (${faces.length} faces)`, kind: 'area', value: total, ...flag });
  }
  if (bodies.length >= 2) {
    let volume = 0;
    let mass = 0;
    let approx = false;
    for (const r of bodies) {
      const isMesh = r.ref.kind === 'mesh';
      const v = isMesh ? meshVolume(r.body!.mesh.positions, r.body!.mesh.indices) : r.body!.volume;
      approx ||= isMesh;
      volume += v;
      mass += massValue(v, isMesh ? undefined : ctx.materials?.get(r.body!.id)).value;
    }
    const a = approx ? { approx } : {};
    out.push(
      { label: 'Total volume', kind: 'volume', value: volume, ...a, ...flag },
      { label: 'Total mass (solid)', kind: 'mass', value: mass, ...a, ...flag },
    );
  }
  return out;
}

function measurePair(a: Resolved, b: Resolved, ctx: MeasureContext): Measurement {
  const pair = measurePairOnly(a, b, ctx);
  // Two edges / two faces also show their sum (secondary), like several items do.
  const totals = pair.pending || pair.note ? [] : totalValues([a, b], ctx, true);
  return totals.length > 0 ? { ...pair, values: [...pair.values, ...totals] } : pair;
}

function measurePairOnly(a: Resolved, b: Resolved, ctx: MeasureContext): Measurement {
  const subject = `${a.name} → ${b.name}`;
  const pa = anchorPoint(a);
  const pb = anchorPoint(b);
  // Two points / circle centres: exact distance and its components.
  if (pa && pb) {
    const d = sub(pb, pa);
    const bothCircles = a.edge && b.edge;
    return {
      title: bothCircles ? 'Centre distance' : 'Point to point',
      subject,
      values: [{ label: 'Distance', kind: 'length', value: len(d) }, ...componentValues(pa, pb)],
      graphics: [{ kind: 'segment', a: pa, b: pb }],
    };
  }
  const values: MeasureValue[] = [];
  const graphics: MeasureGraphic[] = [];
  let title = 'Minimum distance';
  const planeA = planeOf(a);
  const planeB = planeOf(b);
  const lineA = lineOf(a);
  const lineB = lineOf(b);
  if (planeA && planeB) {
    const angle = angleBetween(planeA.normal, planeB.normal);
    const parallel = angle < PARALLEL_TOLERANCE_DEG || 180 - angle < PARALLEL_TOLERANCE_DEG;
    if (parallel) {
      const distance = Math.abs(dot(planeA.normal, sub(planeB.point, planeA.point)));
      const foot = add(
        planeB.point,
        planeA.normal,
        -dot(planeA.normal, sub(planeB.point, planeA.point)),
      );
      return {
        title: 'Parallel faces',
        subject,
        values: [
          { label: 'Distance', kind: 'length', value: distance },
          ...componentValues(foot, planeB.point),
        ],
        graphics: [{ kind: 'segment', a: foot, b: planeB.point }],
      };
    }
    title = 'Angle';
    values.push(
      { label: 'Angle', kind: 'angle', value: angle },
      { label: 'Supplement', kind: 'angle', value: 180 - angle, secondary: true },
    );
  } else if (lineA && lineB) {
    const raw = angleBetween(lineA.dir, lineB.dir);
    const angle = Math.min(raw, 180 - raw);
    if (angle < PARALLEL_TOLERANCE_DEG) {
      const w = sub(lineB.point, lineA.point);
      const perp = sub(w, lineA.dir.map((v) => v * dot(w, lineA.dir)) as Vec3);
      return {
        title: 'Parallel edges',
        subject,
        values: [
          { label: 'Distance', kind: 'length', value: len(perp) },
          ...componentValues(sub(lineB.point, perp), lineB.point),
        ],
        graphics: [{ kind: 'segment', a: sub(lineB.point, perp), b: lineB.point }],
      };
    }
    title = 'Angle';
    values.push(
      { label: 'Angle', kind: 'angle', value: angle },
      { label: 'Supplement', kind: 'angle', value: 180 - angle, secondary: true },
    );
  } else if ((lineA && planeB) || (planeA && lineB)) {
    const line = (lineA ?? lineB)!;
    const plane = (planeA ?? planeB)!;
    const toNormal = angleBetween(line.dir, plane.normal);
    const angle = Math.abs(90 - Math.min(toNormal, 180 - toNormal));
    if (angle < PARALLEL_TOLERANCE_DEG) {
      const distance = Math.abs(dot(plane.normal, sub(line.point, plane.point)));
      const foot = add(line.point, plane.normal, -dot(plane.normal, sub(line.point, plane.point)));
      return {
        title: 'Edge parallel to face',
        subject,
        values: [
          { label: 'Distance', kind: 'length', value: distance },
          ...componentValues(foot, line.point),
        ],
        graphics: [{ kind: 'segment', a: foot, b: line.point }],
      };
    }
    title = 'Angle';
    values.push({ label: 'Angle to face', kind: 'angle', value: angle });
  }
  // Minimum distance (exact from the kernel, else a mesh estimate).
  const kernel = ctx.distance?.(a.ref, b.ref) ?? null;
  if (kernel === 'pending') {
    return { title, subject, values, graphics, pending: true };
  }
  const result = kernel ?? approxDistance(a, b);
  if (result) {
    values.unshift(
      {
        label: 'Minimum distance',
        kind: 'length',
        value: result.distance,
        ...(result.approx ? { approx: true } : {}),
      },
      ...componentValues(result.pointA, result.pointB, result.approx),
    );
    graphics.unshift({ kind: 'segment', a: result.pointA, b: result.pointB });
  }
  if (values.length === 0) {
    return { title, subject, values, graphics, note: 'Nothing to measure between these.' };
  }
  return { title, subject, values, graphics };
}

/** Mesh-based minimum distance between two resolved references (always approx.). */
function approxDistance(a: Resolved, b: Resolved): DistanceResult | null {
  const soupA = soupOf(a);
  const soupB = soupOf(b);
  if (!soupA || !soupB) return null;
  return meshMinDistance(soupA, soupB);
}

/** Triangles (or a point, or a polyline) a reference covers. */
export interface Soup {
  /** Flat xyz triangle list (9 floats per triangle); may be empty. */
  triangles: Float32Array;
  /** Extra points (vertices of a polyline, a single point). */
  points: Vec3[];
}

function soupOf(r: Resolved): Soup | null {
  if (r.point) return { triangles: new Float32Array(0), points: [r.point] };
  const body = r.body;
  if (!body) return null;
  if (r.edge) return { triangles: new Float32Array(0), points: edgePoints(r.edge) };
  const { positions, indices, triangleFaces } = body.mesh;
  const faceIndex = r.face ? body.faces.indexOf(r.face) : -1;
  const tris: number[] = [];
  for (let t = 0; t < indices.length / 3; t += 1) {
    if (faceIndex >= 0 && triangleFaces[t] !== faceIndex) continue;
    for (let k = 0; k < 3; k += 1) {
      const v = indices[t * 3 + k]! * 3;
      tris.push(positions[v]!, positions[v + 1]!, positions[v + 2]!);
    }
  }
  return { triangles: new Float32Array(tris), points: [] };
}

/** Closest point on triangle `abc` to `p` (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return add(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

interface TriNode {
  min: Vec3;
  max: Vec3;
  /** Leaf: triangle indices; inner: two children. */
  tris?: number[];
  left?: TriNode;
  right?: TriNode;
}

function buildTree(tris: Float32Array, ids: number[]): TriNode {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of ids) {
    for (let k = 0; k < 9; k += 1) {
      const axis = k % 3;
      const v = tris[t * 9 + k]!;
      if (v < min[axis]!) min[axis] = v;
      if (v > max[axis]!) max[axis] = v;
    }
  }
  if (ids.length <= 8) return { min, max, tris: ids };
  const extent = sub(max, min);
  const axis =
    extent[0] >= extent[1] && extent[0] >= extent[2] ? 0 : extent[1] >= extent[2] ? 1 : 2;
  const centre = (t: number) =>
    (tris[t * 9 + axis]! + tris[t * 9 + 3 + axis]! + tris[t * 9 + 6 + axis]!) / 3;
  const sorted = [...ids].sort((p, q) => centre(p) - centre(q));
  const mid = sorted.length >> 1;
  return {
    min,
    max,
    left: buildTree(tris, sorted.slice(0, mid)),
    right: buildTree(tris, sorted.slice(mid)),
  };
}

function boxDistance2(p: Vec3, node: TriNode): number {
  let d = 0;
  for (let i = 0; i < 3; i += 1) {
    const v =
      p[i]! < node.min[i]! ? node.min[i]! - p[i]! : p[i]! > node.max[i]! ? p[i]! - node.max[i]! : 0;
    d += v * v;
  }
  return d;
}

function nearestOnTree(
  tris: Float32Array,
  node: TriNode,
  p: Vec3,
  best: { d2: number; point: Vec3 | null },
): void {
  if (boxDistance2(p, node) >= best.d2) return;
  if (node.tris) {
    for (const t of node.tris) {
      const o = t * 9;
      const q = closestPointOnTriangle(
        p,
        [tris[o]!, tris[o + 1]!, tris[o + 2]!],
        [tris[o + 3]!, tris[o + 4]!, tris[o + 5]!],
        [tris[o + 6]!, tris[o + 7]!, tris[o + 8]!],
      );
      const d = sub(q, p);
      const d2 = dot(d, d);
      if (d2 < best.d2) {
        best.d2 = d2;
        best.point = q;
      }
    }
    return;
  }
  const first =
    boxDistance2(p, node.left!) <= boxDistance2(p, node.right!) ? node.left! : node.right!;
  const second = first === node.left ? node.right! : node.left!;
  nearestOnTree(tris, first, p, best);
  nearestOnTree(tris, second, p, best);
}

function soupVertices(soup: Soup): Vec3[] {
  const out: Vec3[] = [...soup.points];
  for (let i = 0; i < soup.triangles.length; i += 3) {
    out.push([soup.triangles[i]!, soup.triangles[i + 1]!, soup.triangles[i + 2]!]);
  }
  return out;
}

/**
 * Mesh-based minimum distance: every vertex of each side against the other
 * side's triangles (an AABB tree) and points. Exact for the meshes' vertex
 * set; misses edge-to-edge closest pairs and the gap between the mesh and
 * the true surface — hence always `approx`.
 */
export function meshMinDistance(a: Soup, b: Soup): DistanceResult | null {
  let best: DistanceResult | null = null;
  const consider = (from: Vec3, to: Vec3, swap: boolean) => {
    const d = len(sub(to, from));
    if (!best || d < best.distance) {
      best = swap
        ? { distance: d, pointA: to, pointB: from, approx: true }
        : { distance: d, pointA: from, pointB: to, approx: true };
    }
  };
  const run = (from: Soup, to: Soup, swap: boolean) => {
    const vertices = soupVertices(from);
    const triCount = to.triangles.length / 9;
    const tree = triCount > 0 ? buildTree(to.triangles, [...Array(triCount).keys()]) : null;
    const targets = to.triangles.length > 0 ? [] : soupVertices(to);
    for (const p of vertices) {
      if (tree) {
        const hit = {
          d2: best ? best.distance * best.distance : Infinity,
          point: null as Vec3 | null,
        };
        nearestOnTree(to.triangles, tree, p, hit);
        if (hit.point) consider(p, hit.point, swap);
      }
      for (const q of targets) consider(p, q, swap);
    }
  };
  run(a, b, false);
  run(b, a, true);
  return best;
}

// ---- entry point -------------------------------------------------------------------------------

/** The measurement for a set of references, or `null` when there is nothing to show. */
export function measure(refs: readonly MeasureRef[], ctx: MeasureContext): Measurement | null {
  if (refs.length === 0) return null;
  const resolved = refs.map((r) => resolve(r, ctx));
  if (resolved.some((r) => r === null)) {
    return {
      title: 'Measurement',
      subject: '',
      values: [],
      graphics: [],
      note: 'A referenced item no longer exists.',
    };
  }
  const items = resolved as Resolved[];
  if (items.length === 1) {
    const r = items[0]!;
    if (r.ref.kind === 'body' || r.ref.kind === 'mesh') return measureBody(r, ctx);
    if (r.edge) return measureEdge(r);
    if (r.face) return measureFace(r);
    if (r.point) {
      return {
        title: 'Point',
        subject: r.name,
        values: [
          { label: 'X', kind: 'length', value: r.point[0] },
          { label: 'Y', kind: 'length', value: r.point[1] },
          { label: 'Z', kind: 'length', value: r.point[2] },
        ],
        graphics: [{ kind: 'point', at: r.point }],
      };
    }
    return null;
  }
  if (items.length === 2) return measurePair(items[0]!, items[1]!, ctx);
  if (items.every((r) => r.ref.kind === 'body' || r.ref.kind === 'mesh')) {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const r of items) {
      const body = r.body!;
      for (let i = 0; i < 3; i += 1) {
        min[i] = Math.min(min[i]!, body.min[i]!);
        max[i] = Math.max(max[i]!, body.max[i]!);
      }
    }
    return {
      title: `${items.length} bodies`,
      subject: items.map((r) => r.name).join(', '),
      values: [
        { label: 'Width (X)', kind: 'length', value: max[0] - min[0] },
        { label: 'Depth (Y)', kind: 'length', value: max[1] - min[1] },
        { label: 'Height (Z)', kind: 'length', value: max[2] - min[2] },
        ...totalValues(items, ctx),
      ],
      graphics: boxGraphics(min, max),
    };
  }
  // Several edges / faces (and bodies): their sums, per kind (Shapr3D "sums over several items").
  const totals = totalValues(items, ctx);
  if (totals.length > 0) {
    const kinds = [
      ['edge', items.filter((r) => r.edge).length],
      ['face', items.filter((r) => r.face).length],
      ['body', items.filter((r) => !r.edge && !r.face && r.body).length],
      ['point', items.filter((r) => r.point).length],
    ] as const;
    const parts = kinds
      .filter(([, n]) => n > 0)
      .map(
        ([kind, n]) =>
          `${n} ${kind === 'body' ? (n === 1 ? 'body' : 'bodies') : n === 1 ? kind : `${kind}s`}`,
      );
    const graphics: MeasureGraphic[] = [];
    for (const r of items) {
      if (r.face) graphics.push({ kind: 'point', at: r.face.centroid });
      else if (r.edge) graphics.push({ kind: 'point', at: r.edge.midpoint });
    }
    return {
      title: `${items.length} items`,
      subject: parts.join(', '),
      values: totals,
      graphics: graphics.slice(0, 1),
    };
  }
  return {
    title: 'Measurement',
    subject: `${items.length} items`,
    values: [],
    graphics: [],
    note: 'Select one or two items, or several edges, faces or bodies to sum them.',
  };
}

// ---- point snapping ------------------------------------------------------------------------------

export interface SnapCandidate {
  point: Vec3;
  label: string;
}

/**
 * Snap targets of the given bodies' edges: vertices (edge end points), line
 * midpoints and circle/arc centres — what a measured point snaps to near
 * the pointer.
 */
export function snapPoints(bodies: readonly Body[]): SnapCandidate[] {
  const out: SnapCandidate[] = [];
  const seen = new Set<string>();
  const push = (point: Vec3, label: string) => {
    const key = `${label}|${point.map((v) => v.toFixed(5)).join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ point, label });
  };
  for (const body of bodies) {
    for (const edge of body.edges) {
      const points = edgePoints(edge);
      if (points.length === 0) continue;
      push(points[0]!, 'Vertex');
      push(points[points.length - 1]!, 'Vertex');
      if (edge.curve === 'line') push(edge.midpoint, 'Midpoint');
      const circle = circleOfEdge(edge);
      if (circle) push(circle.center, 'Centre');
    }
  }
  return out;
}

/**
 * Picks the snap target nearest to the pointer within `tolerancePx`
 * (screen distance), else the surface point under the pointer.
 */
export function snapMeasurePoint(
  candidates: readonly SnapCandidate[],
  project: (p: Vec3) => [number, number] | null,
  pointer: [number, number],
  tolerancePx: number,
  surfacePoint: Vec3 | null,
): SnapCandidate | null {
  let best: SnapCandidate | null = null;
  let bestD = tolerancePx;
  for (const c of candidates) {
    const s = project(c.point);
    if (!s) continue;
    const d = Math.hypot(s[0] - pointer[0], s[1] - pointer[1]);
    // Vertices and centres win ties over midpoints.
    const bias = c.label === 'Midpoint' ? 1.5 : 0;
    if (d + bias < bestD) {
      bestD = d + bias;
      best = c;
    }
  }
  if (best) return best;
  return surfacePoint ? { point: surfacePoint, label: 'Point on face' } : null;
}
