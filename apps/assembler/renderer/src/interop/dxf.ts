/**
 * DXF (ASCII) reader and writer, written from Autodesk's "DXF Reference"
 * (group codes of HEADER $INSUNITS/$ACADVER and of the LINE, ARC, CIRCLE,
 * LWPOLYLINE, POLYLINE/VERTEX/SEQEND, SPLINE, ELLIPSE, POINT, INSERT and
 * BLOCK entities). No third-party DXF library is used.
 *
 * Reader: 2D geometry in the drawing's XY plane (object coordinate systems
 * with extrusion (0, 0, ±1); entities on other planes are skipped and
 * counted), block INSERTs expanded (translation, rotation, scale; nested up
 * to 8 levels). Text, dimensions, hatches, images, 3D solids/meshes, layers,
 * line types and colours are not read (Shapr3D's DWG/DXF import has the
 * same scope: geometry only). Binary DXF is refused.
 *
 * Writer: R12 (AC1009; splines and ellipses as 2D polylines, since R12 has
 * neither) or R2000 (AC1015; LINE, ARC, CIRCLE, ELLIPSE, SPLINE,
 * LWPOLYLINE with handles, owner links and the tables/objects AutoCAD
 * requires). Units: `$INSUNITS` 4 (millimetres).
 */

export type Vec2 = [number, number];

export type DxfEntity =
  | { kind: 'line'; a: Vec2; b: Vec2; layer?: string }
  | { kind: 'circle'; center: Vec2; radius: number; layer?: string }
  /** Counter-clockwise from `start` to `end` (radians). */
  | { kind: 'arc'; center: Vec2; radius: number; start: number; end: number; layer?: string }
  /** `bulges[i]` belongs to the segment from point i to i + 1 (tan of a quarter of its angle, + = CCW). */
  | { kind: 'polyline'; points: Vec2[]; bulges: number[]; closed: boolean; layer?: string }
  | {
      kind: 'spline';
      degree: number;
      controlPoints: Vec2[];
      knots: number[];
      weights: number[] | null;
      fitPoints: Vec2[];
      closed: boolean;
      layer?: string;
    }
  /** `major` is the major-axis end point relative to `center`; parameters in radians, CCW. */
  | {
      kind: 'ellipse';
      center: Vec2;
      major: Vec2;
      ratio: number;
      start: number;
      end: number;
      layer?: string;
    }
  | { kind: 'point'; p: Vec2; layer?: string };

export interface DxfDrawing {
  entities: DxfEntity[];
  /** `$INSUNITS` code (0 = unitless, 1 = in, 2 = ft, 4 = mm, 5 = cm, 6 = m, …), `null` if absent. */
  insunits: number | null;
  version: string | null;
  /** Entity type → count of entities not imported. */
  skipped: Record<string, number>;
  warnings: string[];
}

export class DxfError extends Error {}

/** Millimetres per drawing unit for a `$INSUNITS` code; `null` for unitless/unknown. */
export function insunitsToMm(code: number | null): number | null {
  const table: Record<number, number> = {
    1: 25.4,
    2: 304.8,
    3: 1_609_344,
    4: 1,
    5: 10,
    6: 1000,
    7: 1_000_000,
    8: 0.0000254,
    9: 0.0254,
    10: 914.4,
    13: 0.001,
    14: 100,
    15: 10_000,
    16: 100_000,
  };
  return code !== null && table[code] !== undefined ? table[code]! : null;
}

export const INSUNITS_NAME: Record<number, string> = {
  0: 'unitless',
  1: 'inches',
  2: 'feet',
  4: 'millimetres',
  5: 'centimetres',
  6: 'metres',
};

interface Pair {
  code: number;
  value: string;
}

function tokenize(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    if (!Number.isInteger(code)) {
      throw new DxfError(
        `Line ${i + 1}: expected a group code, got "${lines[i]!.trim().slice(0, 20)}"`,
      );
    }
    pairs.push({ code, value: lines[i + 1]!.trim() });
  }
  return pairs;
}

type Raw = { type: string; pairs: Pair[] };

/** Splits a list of pairs (from a `0` code) into entity records. */
function records(pairs: Pair[], from: number, to: number): Raw[] {
  const out: Raw[] = [];
  let current: Raw | null = null;
  for (let i = from; i < to; i += 1) {
    const p = pairs[i]!;
    if (p.code === 0) {
      current = { type: p.value.toUpperCase(), pairs: [] };
      out.push(current);
    } else current?.pairs.push(p);
  }
  return out;
}

function num(pairs: Pair[], code: number, fallback = 0): number {
  const p = pairs.find((q) => q.code === code);
  const v = p ? Number(p.value) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

function str(pairs: Pair[], code: number): string {
  return pairs.find((q) => q.code === code)?.value ?? '';
}

interface Transform {
  /** 2×3 affine: x' = a x + b y + c, y' = d x + e y + f. */
  m: [number, number, number, number, number, number];
}

const IDENTITY: Transform = { m: [1, 0, 0, 0, 1, 0] };

function apply(t: Transform, p: Vec2): Vec2 {
  const [a, b, c, d, e, f] = t.m;
  return [a * p[0] + b * p[1] + c, d * p[0] + e * p[1] + f];
}

function applyVector(t: Transform, v: Vec2): Vec2 {
  const [a, b, , d, e] = t.m;
  return [a * v[0] + b * v[1], d * v[0] + e * v[1]];
}

function composeTransform(outer: Transform, inner: Transform): Transform {
  const [a, b, c, d, e, f] = outer.m;
  const [A, B, C, D, E, F] = inner.m;
  return {
    m: [
      a * A + b * D,
      a * B + b * E,
      a * C + b * F + c,
      d * A + e * D,
      d * B + e * E,
      d * C + e * F + f,
    ],
  };
}

/**
 * Uniform scale and orientation of a transform (arcs/circles need a
 * similarity), decomposed as R(rotation) · diag(1, mirrored ? −1 : 1) · scale.
 */
function similarity(t: Transform): { scale: number; rotation: number; mirrored: boolean } | null {
  const [a, b, , d, e] = t.m;
  const sx = Math.hypot(a, d);
  const sy = Math.hypot(b, e);
  const det = a * e - b * d;
  if (Math.abs(sx - sy) > 1e-9 * Math.max(sx, sy) || Math.abs(a * b + d * e) > 1e-9 * sx * sy)
    return null;
  return { scale: sx, rotation: Math.atan2(d, a), mirrored: det < 0 };
}

export function parseDxf(text: string): DxfDrawing {
  if (text.startsWith('AutoCAD Binary DXF'))
    throw new DxfError('Binary DXF is not supported; save it as ASCII DXF');
  const pairs = tokenize(text);
  let insunits: number | null = null;
  let version: string | null = null;
  const blocks = new Map<string, { base: Vec2; records: Raw[] }>();
  let entityRecords: Raw[] = [];
  const warnings: string[] = [];
  const skipped: Record<string, number> = {};
  const skip = (type: string) => {
    skipped[type] = (skipped[type] ?? 0) + 1;
  };

  let i = 0;
  while (i < pairs.length) {
    const p = pairs[i]!;
    if (p.code === 0 && p.value === 'SECTION') {
      const name = pairs[i + 1]?.value.toUpperCase() ?? '';
      let end = i + 2;
      while (end < pairs.length && !(pairs[end]!.code === 0 && pairs[end]!.value === 'ENDSEC'))
        end += 1;
      if (name === 'HEADER') {
        for (let k = i + 2; k < end; k += 1) {
          if (pairs[k]!.code === 9 && pairs[k]!.value === '$INSUNITS')
            insunits = Number(pairs[k + 1]?.value);
          if (pairs[k]!.code === 9 && pairs[k]!.value === '$ACADVER')
            version = pairs[k + 1]?.value ?? null;
        }
      } else if (name === 'BLOCKS') {
        const recs = records(pairs, i + 2, end);
        let current: { name: string; base: Vec2; records: Raw[] } | null = null;
        for (const r of recs) {
          if (r.type === 'BLOCK') {
            current = {
              name: str(r.pairs, 2),
              base: [num(r.pairs, 10), num(r.pairs, 20)],
              records: [],
            };
          } else if (r.type === 'ENDBLK') {
            if (current) blocks.set(current.name, { base: current.base, records: current.records });
            current = null;
          } else current?.records.push(r);
        }
      } else if (name === 'ENTITIES') {
        entityRecords = records(pairs, i + 2, end);
      }
      i = end + 1;
      continue;
    }
    i += 1;
  }
  if (
    entityRecords.length === 0 &&
    pairs.length > 0 &&
    !pairs.some((q) => q.code === 0 && q.value === 'SECTION')
  ) {
    throw new DxfError('This is not a DXF file (no SECTION found)');
  }

  const entities: DxfEntity[] = [];
  const emit = (recs: Raw[], t: Transform, depth: number) => {
    for (let k = 0; k < recs.length; k += 1) {
      const r = recs[k]!;
      const layer = str(r.pairs, 8) || undefined;
      const extrusionZ = num(r.pairs, 230, 1);
      const extrusionX = num(r.pairs, 210, 0);
      const extrusionY = num(r.pairs, 220, 0);
      const planar =
        Math.abs(extrusionX) < 1e-9 &&
        Math.abs(extrusionY) < 1e-9 &&
        Math.abs(Math.abs(extrusionZ) - 1) < 1e-9;
      // OCS with extrusion (0,0,-1): the XY plane seen from below, x mirrored.
      const ocs: Transform = extrusionZ < 0 ? { m: [-1, 0, 0, 0, 1, 0] } : IDENTITY;
      const tt = composeTransform(t, ocs);
      const withLayer = <T extends DxfEntity>(e: T): T => (layer ? { ...e, layer } : e);
      switch (r.type) {
        case 'LINE': {
          const a: Vec2 = [num(r.pairs, 10), num(r.pairs, 20)];
          const b: Vec2 = [num(r.pairs, 11), num(r.pairs, 21)];
          if (!planar || num(r.pairs, 30) !== num(r.pairs, 31)) {
            skip('LINE (not in the XY plane)');
            break;
          }
          entities.push(withLayer({ kind: 'line', a: apply(t, a), b: apply(t, b) }));
          break;
        }
        case 'CIRCLE':
        case 'ARC': {
          if (!planar) {
            skip(`${r.type} (not in the XY plane)`);
            break;
          }
          const s = similarity(tt);
          if (!s) {
            skip(`${r.type} (non-uniformly scaled block)`);
            break;
          }
          const center = apply(tt, [num(r.pairs, 10), num(r.pairs, 20)]);
          const radius = num(r.pairs, 40) * s.scale;
          if (!(radius > 0)) {
            skip(r.type);
            break;
          }
          if (r.type === 'CIRCLE') {
            entities.push(withLayer({ kind: 'circle', center, radius }));
          } else {
            const a0 = (num(r.pairs, 50) * Math.PI) / 180;
            const a1 = (num(r.pairs, 51) * Math.PI) / 180;
            // tt = R(rotation) · diag(1, ±1) · scale: a mirror (y → −y) turns the arc
            // around, so the counter-clockwise arc runs from −a1 to −a0 before rotating.
            const [start, end] = s.mirrored
              ? [s.rotation - a1, s.rotation - a0]
              : [s.rotation + a0, s.rotation + a1];
            entities.push(withLayer({ kind: 'arc', center, radius, start, end }));
          }
          break;
        }
        case 'LWPOLYLINE': {
          if (!planar) {
            skip('LWPOLYLINE (not in the XY plane)');
            break;
          }
          const s = similarity(tt);
          const points: Vec2[] = [];
          const bulges: number[] = [];
          for (const q of r.pairs) {
            if (q.code === 10) {
              points.push([Number(q.value), 0]);
              bulges.push(0);
            } else if (q.code === 20 && points.length > 0)
              points[points.length - 1]![1] = Number(q.value);
            else if (q.code === 42 && bulges.length > 0)
              bulges[bulges.length - 1] = Number(q.value);
          }
          const hasBulge = bulges.some((b) => b !== 0);
          if (hasBulge && !s) {
            skip('LWPOLYLINE (arc segments in a non-uniformly scaled block)');
            break;
          }
          const flip = s?.mirrored ? -1 : 1;
          entities.push(
            withLayer({
              kind: 'polyline',
              points: points.map((pt) => apply(tt, pt)),
              bulges: bulges.map((b) => b * flip),
              closed: (num(r.pairs, 70) & 1) === 1,
            }),
          );
          break;
        }
        case 'POLYLINE': {
          const flags = num(r.pairs, 70);
          const points: Vec2[] = [];
          const bulges: number[] = [];
          let j = k + 1;
          for (; j < recs.length && recs[j]!.type === 'VERTEX'; j += 1) {
            const v = recs[j]!;
            const vflags = num(v.pairs, 70);
            if (vflags & 16) continue; // spline frame control point
            points.push([num(v.pairs, 10), num(v.pairs, 20)]);
            bulges.push(num(v.pairs, 42));
          }
          if (recs[j]?.type === 'SEQEND') j += 1;
          k = j - 1;
          if (flags & (16 | 64)) {
            skip('POLYLINE (polygon mesh / polyface)');
            break;
          }
          if (!planar || flags & 8) {
            skip('POLYLINE (3D)');
            break;
          }
          const s = similarity(tt);
          const flip = s?.mirrored ? -1 : 1;
          entities.push(
            withLayer({
              kind: 'polyline',
              points: points.map((pt) => apply(tt, pt)),
              bulges: bulges.map((b) => b * flip),
              closed: (flags & 1) === 1,
            }),
          );
          break;
        }
        case 'SPLINE': {
          const control: Vec2[] = [];
          const fit: Vec2[] = [];
          const knots: number[] = [];
          const weights: number[] = [];
          const zs = new Set<number>();
          for (const q of r.pairs) {
            if (q.code === 10) control.push([Number(q.value), 0]);
            else if (q.code === 20 && control.length > 0)
              control[control.length - 1]![1] = Number(q.value);
            else if (q.code === 30) zs.add(Number(q.value));
            else if (q.code === 11) fit.push([Number(q.value), 0]);
            else if (q.code === 21 && fit.length > 0) fit[fit.length - 1]![1] = Number(q.value);
            else if (q.code === 31) zs.add(Number(q.value));
            else if (q.code === 40) knots.push(Number(q.value));
            else if (q.code === 41) weights.push(Number(q.value));
          }
          if (zs.size > 1 || !planar) {
            skip('SPLINE (not in the XY plane)');
            break;
          }
          const flags = num(r.pairs, 70);
          entities.push(
            withLayer({
              kind: 'spline',
              degree: num(r.pairs, 71, 3),
              controlPoints: control.map((pt) => apply(tt, pt)),
              knots,
              weights:
                weights.length === control.length && weights.some((w) => Math.abs(w - 1) > 1e-12)
                  ? weights
                  : null,
              fitPoints: fit.map((pt) => apply(tt, pt)),
              closed: (flags & 1) === 1 || (flags & 2) === 2,
            }),
          );
          break;
        }
        case 'ELLIPSE': {
          if (!planar) {
            skip('ELLIPSE (not in the XY plane)');
            break;
          }
          const s = similarity(t);
          if (!s) {
            skip('ELLIPSE (non-uniformly scaled block)');
            break;
          }
          // Centre and axis are WCS; a (0,0,-1) extrusion runs the parameters clockwise.
          let start = num(r.pairs, 41, 0);
          let end = num(r.pairs, 42, 2 * Math.PI);
          const mirrored = s.mirrored !== extrusionZ < 0;
          if (mirrored) [start, end] = [-end, -start];
          const major = applyVector(t, [num(r.pairs, 11), num(r.pairs, 21)]);
          entities.push(
            withLayer({
              kind: 'ellipse',
              center: apply(t, [num(r.pairs, 10), num(r.pairs, 20)]),
              major,
              ratio: num(r.pairs, 40, 1),
              start,
              end,
            }),
          );
          break;
        }
        case 'POINT':
          entities.push(
            withLayer({ kind: 'point', p: apply(t, [num(r.pairs, 10), num(r.pairs, 20)]) }),
          );
          break;
        case 'INSERT': {
          const name = str(r.pairs, 2);
          const block = blocks.get(name);
          if (!block || depth >= 8) {
            skip(depth >= 8 ? 'INSERT (nested too deeply)' : 'INSERT (missing block)');
            break;
          }
          const sx = num(r.pairs, 41, 1);
          const sy = num(r.pairs, 42, 1);
          const rot = (num(r.pairs, 50) * Math.PI) / 180;
          const ix = num(r.pairs, 10);
          const iy = num(r.pairs, 20);
          const cos = Math.cos(rot);
          const sin = Math.sin(rot);
          const [bx, by] = block.base;
          // Block point q → ins + R(rot) · S · (q − base) in the INSERT's OCS, then the parent transform.
          const withInsert = composeTransform(tt, {
            m: [
              cos * sx,
              -sin * sy,
              ix - (cos * sx * bx - sin * sy * by),
              sin * sx,
              cos * sy,
              iy - (sin * sx * bx + cos * sy * by),
            ],
          });
          const cols = Math.max(1, num(r.pairs, 70, 1));
          const rows = Math.max(1, num(r.pairs, 71, 1));
          if (cols > 1 || rows > 1)
            warnings.push(
              `Block "${name}" is inserted as an array; only the first copy is imported`,
            );
          emit(block.records, withInsert, depth + 1);
          break;
        }
        case 'VERTEX':
        case 'SEQEND':
          break;
        default:
          skip(r.type);
      }
    }
  };
  emit(entityRecords, IDENTITY, 0);
  return { entities, insunits, version, skipped, warnings };
}

// ---- writer -----------------------------------------------------------------------------

export type DxfVersion = 'R12' | 'R2000';

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0.0';
  const r = Math.round(v * 1e9) / 1e9;
  const s = String(Object.is(r, -0) ? 0 : r);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

const deg = (rad: number) => (rad * 180) / Math.PI;

/** Point on an ellipse at parameter `u`. */
function ellipsePoint(e: Extract<DxfEntity, { kind: 'ellipse' }>, u: number): Vec2 {
  const minor: Vec2 = [-e.major[1] * e.ratio, e.major[0] * e.ratio];
  return [
    e.center[0] + e.major[0] * Math.cos(u) + minor[0] * Math.sin(u),
    e.center[1] + e.major[1] * Math.cos(u) + minor[1] * Math.sin(u),
  ];
}

/** Point on a (possibly rational) B-spline, de Boor. */
export function splinePoint(s: Extract<DxfEntity, { kind: 'spline' }>, u: number): Vec2 {
  const p = s.degree;
  const P = s.controlPoints;
  const U = s.knots;
  const w = s.weights ?? P.map(() => 1);
  let k = p;
  while (k < P.length - 1 && U[k + 1]! <= u) k += 1;
  const d: [number, number, number][] = [];
  for (let j = 0; j <= p; j += 1) {
    const i = k - p + j;
    const wi = w[i] ?? 1;
    d.push([P[i]![0] * wi, P[i]![1] * wi, wi]);
  }
  for (let r = 1; r <= p; r += 1) {
    for (let j = p; j >= r; j -= 1) {
      const i = k - p + j;
      const denom = U[i + p - r + 1]! - U[i]!;
      const a = denom === 0 ? 0 : (u - U[i]!) / denom;
      d[j] = [
        (1 - a) * d[j - 1]![0] + a * d[j]![0],
        (1 - a) * d[j - 1]![1] + a * d[j]![1],
        (1 - a) * d[j - 1]![2] + a * d[j]![2],
      ];
    }
  }
  const [x, y, ww] = d[p]!;
  return [x / ww, y / ww];
}

/** Polyline approximation of a curve entity (splines/ellipses for R12, previews). */
export function sampleEntity(e: DxfEntity, segments = 64): Vec2[] {
  switch (e.kind) {
    case 'ellipse': {
      let end = e.end;
      while (end <= e.start) end += 2 * Math.PI;
      const n = Math.max(8, Math.ceil((segments * (end - e.start)) / (2 * Math.PI)));
      return Array.from({ length: n + 1 }, (_, i) =>
        ellipsePoint(e, e.start + ((end - e.start) * i) / n),
      );
    }
    case 'spline': {
      if (
        e.controlPoints.length < e.degree + 1 ||
        e.knots.length !== e.controlPoints.length + e.degree + 1
      ) {
        return e.fitPoints.length > 0 ? e.fitPoints : e.controlPoints;
      }
      const u0 = e.knots[e.degree]!;
      const u1 = e.knots[e.knots.length - 1 - e.degree]!;
      const n = Math.max(16, segments * Math.max(1, e.controlPoints.length - e.degree));
      return Array.from({ length: n + 1 }, (_, i) => splinePoint(e, u0 + ((u1 - u0) * i) / n));
    }
    default:
      return [];
  }
}

class Writer {
  lines: string[] = [];
  private handle = 0x20;
  pair(code: number, value: string | number): void {
    this.lines.push(String(code).padStart(3, ' '), typeof value === 'number' ? fmt(value) : value);
  }
  int(code: number, value: number): void {
    this.lines.push(String(code).padStart(3, ' '), String(Math.round(value)));
  }
  nextHandle(): string {
    this.handle += 1;
    return this.handle.toString(16).toUpperCase();
  }
  get handseed(): string {
    return (this.handle + 1).toString(16).toUpperCase();
  }
}

function extents(entities: readonly DxfEntity[]): { min: Vec2; max: Vec2 } {
  const min: Vec2 = [Infinity, Infinity];
  const max: Vec2 = [-Infinity, -Infinity];
  const add = (p: Vec2, r = 0) => {
    min[0] = Math.min(min[0], p[0] - r);
    min[1] = Math.min(min[1], p[1] - r);
    max[0] = Math.max(max[0], p[0] + r);
    max[1] = Math.max(max[1], p[1] + r);
  };
  for (const e of entities) {
    if (e.kind === 'line') {
      add(e.a);
      add(e.b);
    } else if (e.kind === 'circle' || e.kind === 'arc') add(e.center, e.radius);
    else if (e.kind === 'polyline') e.points.forEach((p) => add(p));
    else if (e.kind === 'point') add(e.p);
    else sampleEntity(e, 32).forEach((p) => add(p));
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0], max: [0, 0] };
  return { min, max };
}

/** Writes entities (millimetres) as an ASCII DXF of the given version. */
export function writeDxf(entities: readonly DxfEntity[], version: DxfVersion = 'R2000'): string {
  const w = new Writer();
  const r2000 = version === 'R2000';
  const layers = [...new Set(['0', ...entities.map((e) => e.layer ?? '0')])];
  const { min, max } = extents(entities);

  // Handles that tables/blocks reference, allocated first so the header seed is known at the end.
  const h = {
    vportTable: w.nextHandle(),
    vport: w.nextHandle(),
    ltypeTable: w.nextHandle(),
    byBlock: w.nextHandle(),
    byLayer: w.nextHandle(),
    continuous: w.nextHandle(),
    layerTable: w.nextHandle(),
    layers: layers.map(() => w.nextHandle()),
    styleTable: w.nextHandle(),
    standardStyle: w.nextHandle(),
    viewTable: w.nextHandle(),
    ucsTable: w.nextHandle(),
    appidTable: w.nextHandle(),
    acadAppid: w.nextHandle(),
    dimstyleTable: w.nextHandle(),
    standardDimstyle: w.nextHandle(),
    blockRecordTable: w.nextHandle(),
    modelRecord: w.nextHandle(),
    paperRecord: w.nextHandle(),
    modelBlock: w.nextHandle(),
    modelEnd: w.nextHandle(),
    paperBlock: w.nextHandle(),
    paperEnd: w.nextHandle(),
    rootDict: w.nextHandle(),
    groupDict: w.nextHandle(),
  };

  const body = new Writer();
  // Entities first (into a separate writer) so their handles precede $HANDSEED.
  const entityHandle = () => {
    const handle = w.nextHandle();
    return handle;
  };
  const common = (type: string, layer: string, subclass: string) => {
    body.pair(0, type);
    if (r2000) {
      body.pair(5, entityHandle());
      body.pair(330, h.modelRecord);
      body.pair(100, 'AcDbEntity');
    }
    body.pair(8, layer);
    if (r2000) body.pair(100, subclass);
  };
  const polyline2d = (points: Vec2[], bulges: number[], closed: boolean, layer: string) => {
    if (r2000) {
      common('LWPOLYLINE', layer, 'AcDbPolyline');
      body.int(90, points.length);
      body.int(70, closed ? 1 : 0);
      points.forEach((p, i) => {
        body.pair(10, p[0]);
        body.pair(20, p[1]);
        if (bulges[i]) body.pair(42, bulges[i]!);
      });
      return;
    }
    body.pair(0, 'POLYLINE');
    body.pair(8, layer);
    body.int(66, 1);
    body.pair(10, 0);
    body.pair(20, 0);
    body.pair(30, 0);
    body.int(70, closed ? 1 : 0);
    points.forEach((p, i) => {
      body.pair(0, 'VERTEX');
      body.pair(8, layer);
      body.pair(10, p[0]);
      body.pair(20, p[1]);
      body.pair(30, 0);
      if (bulges[i]) body.pair(42, bulges[i]!);
    });
    body.pair(0, 'SEQEND');
    body.pair(8, layer);
  };
  for (const e of entities) {
    const layer = e.layer ?? '0';
    switch (e.kind) {
      case 'line':
        common('LINE', layer, 'AcDbLine');
        body.pair(10, e.a[0]);
        body.pair(20, e.a[1]);
        body.pair(30, 0);
        body.pair(11, e.b[0]);
        body.pair(21, e.b[1]);
        body.pair(31, 0);
        break;
      case 'circle':
        common('CIRCLE', layer, 'AcDbCircle');
        body.pair(10, e.center[0]);
        body.pair(20, e.center[1]);
        body.pair(30, 0);
        body.pair(40, e.radius);
        break;
      case 'arc':
        common('ARC', layer, 'AcDbCircle');
        body.pair(10, e.center[0]);
        body.pair(20, e.center[1]);
        body.pair(30, 0);
        body.pair(40, e.radius);
        if (r2000) body.pair(100, 'AcDbArc');
        body.pair(50, normalizeDegrees(deg(e.start)));
        body.pair(51, normalizeDegrees(deg(e.end)));
        break;
      case 'polyline':
        polyline2d(e.points, e.bulges, e.closed, layer);
        break;
      case 'point':
        common('POINT', layer, 'AcDbPoint');
        body.pair(10, e.p[0]);
        body.pair(20, e.p[1]);
        body.pair(30, 0);
        break;
      case 'ellipse':
        if (!r2000) {
          polyline2d(sampleEntity(e), [], false, layer);
          break;
        }
        common('ELLIPSE', layer, 'AcDbEllipse');
        body.pair(10, e.center[0]);
        body.pair(20, e.center[1]);
        body.pair(30, 0);
        body.pair(11, e.major[0]);
        body.pair(21, e.major[1]);
        body.pair(31, 0);
        body.pair(210, 0);
        body.pair(220, 0);
        body.pair(230, 1);
        body.pair(40, e.ratio);
        body.pair(41, e.start);
        body.pair(42, e.end);
        break;
      case 'spline': {
        const valid =
          e.controlPoints.length >= e.degree + 1 &&
          e.knots.length === e.controlPoints.length + e.degree + 1;
        if (!r2000 || !valid) {
          polyline2d(valid ? sampleEntity(e) : e.fitPoints, [], false, layer);
          break;
        }
        common('SPLINE', layer, 'AcDbSpline');
        body.pair(210, 0);
        body.pair(220, 0);
        body.pair(230, 1);
        body.int(70, 8 | (e.weights ? 4 : 0) | (e.closed ? 1 : 0));
        body.int(71, e.degree);
        body.int(72, e.knots.length);
        body.int(73, e.controlPoints.length);
        body.int(74, 0);
        body.pair(42, 1e-10);
        body.pair(43, 1e-10);
        for (const k of e.knots) body.pair(40, k);
        if (e.weights) for (const wt of e.weights) body.pair(41, wt);
        for (const p of e.controlPoints) {
          body.pair(10, p[0]);
          body.pair(20, p[1]);
          body.pair(30, 0);
        }
        break;
      }
    }
  }

  // HEADER
  w.pair(0, 'SECTION');
  w.pair(2, 'HEADER');
  w.pair(9, '$ACADVER');
  w.pair(1, r2000 ? 'AC1015' : 'AC1009');
  if (r2000) {
    w.pair(9, '$HANDSEED');
    w.pair(5, 'FFFF'); // patched below
  }
  w.pair(9, '$INSBASE');
  w.pair(10, 0);
  w.pair(20, 0);
  w.pair(30, 0);
  w.pair(9, '$EXTMIN');
  w.pair(10, min[0]);
  w.pair(20, min[1]);
  w.pair(30, 0);
  w.pair(9, '$EXTMAX');
  w.pair(10, max[0]);
  w.pair(20, max[1]);
  w.pair(30, 0);
  if (r2000) {
    w.pair(9, '$INSUNITS');
    w.int(70, 4);
  }
  w.pair(9, '$MEASUREMENT');
  w.int(70, 1);
  w.pair(0, 'ENDSEC');

  if (r2000) {
    w.pair(0, 'SECTION');
    w.pair(2, 'CLASSES');
    w.pair(0, 'ENDSEC');
  }

  // TABLES
  const table = (name: string, handle: string, count: number, entries: () => void) => {
    w.pair(0, 'TABLE');
    w.pair(2, name);
    if (r2000) {
      w.pair(5, handle);
      w.pair(330, '0');
      w.pair(100, 'AcDbSymbolTable');
    }
    w.int(70, count);
    entries();
    w.pair(0, 'ENDTAB');
  };
  const record = (type: string, handle: string, owner: string, subclass: string) => {
    w.pair(0, type);
    if (r2000) {
      w.pair(5, handle);
      w.pair(330, owner);
      w.pair(100, 'AcDbSymbolTableRecord');
      w.pair(100, subclass);
    }
  };
  w.pair(0, 'SECTION');
  w.pair(2, 'TABLES');
  table('VPORT', h.vportTable, 1, () => {
    record('VPORT', h.vport, h.vportTable, 'AcDbViewportTableRecord');
    w.pair(2, '*ACTIVE');
    w.int(70, 0);
    w.pair(10, 0);
    w.pair(20, 0);
    w.pair(11, 1);
    w.pair(21, 1);
    w.pair(12, (min[0] + max[0]) / 2);
    w.pair(22, (min[1] + max[1]) / 2);
    w.pair(40, Math.max(1, max[1] - min[1]) * 1.1);
    w.pair(41, 1.5);
  });
  table('LTYPE', h.ltypeTable, r2000 ? 3 : 1, () => {
    const ltype = (name: string, handle: string, text: string) => {
      record('LTYPE', handle, h.ltypeTable, 'AcDbLinetypeTableRecord');
      w.pair(2, name);
      w.int(70, 0);
      w.pair(3, text);
      w.int(72, 65);
      w.int(73, 0);
      w.pair(40, 0);
    };
    if (r2000) {
      ltype('ByBlock', h.byBlock, '');
      ltype('ByLayer', h.byLayer, '');
    }
    ltype(r2000 ? 'Continuous' : 'CONTINUOUS', h.continuous, 'Solid line');
  });
  table('LAYER', h.layerTable, layers.length, () => {
    layers.forEach((name, i) => {
      record('LAYER', h.layers[i]!, h.layerTable, 'AcDbLayerTableRecord');
      w.pair(2, name);
      w.int(70, 0);
      w.int(62, name === 'CONSTRUCTION' ? 8 : 7);
      w.pair(6, r2000 ? 'Continuous' : 'CONTINUOUS');
      if (r2000) {
        w.int(370, -3);
        w.pair(390, '0');
      }
    });
  });
  table('STYLE', h.styleTable, 1, () => {
    record('STYLE', h.standardStyle, h.styleTable, 'AcDbTextStyleTableRecord');
    w.pair(2, r2000 ? 'Standard' : 'STANDARD');
    w.int(70, 0);
    w.pair(40, 0);
    w.pair(41, 1);
    w.pair(50, 0);
    w.int(71, 0);
    w.pair(42, 2.5);
    w.pair(3, 'txt');
    w.pair(4, '');
  });
  table('VIEW', h.viewTable, 0, () => undefined);
  table('UCS', h.ucsTable, 0, () => undefined);
  table('APPID', h.appidTable, 1, () => {
    record('APPID', h.acadAppid, h.appidTable, 'AcDbRegAppTableRecord');
    w.pair(2, 'ACAD');
    w.int(70, 0);
  });
  table('DIMSTYLE', h.dimstyleTable, r2000 ? 1 : 0, () => {
    if (!r2000) return;
    w.pair(0, 'DIMSTYLE');
    w.pair(105, h.standardDimstyle);
    w.pair(330, h.dimstyleTable);
    w.pair(100, 'AcDbSymbolTableRecord');
    w.pair(100, 'AcDbDimStyleTableRecord');
    w.pair(2, 'Standard');
    w.int(70, 0);
  });
  if (r2000) {
    table('BLOCK_RECORD', h.blockRecordTable, 2, () => {
      record('BLOCK_RECORD', h.modelRecord, h.blockRecordTable, 'AcDbBlockTableRecord');
      w.pair(2, '*Model_Space');
      w.pair(340, '0');
      record('BLOCK_RECORD', h.paperRecord, h.blockRecordTable, 'AcDbBlockTableRecord');
      w.pair(2, '*Paper_Space');
      w.pair(340, '0');
    });
  }
  w.pair(0, 'ENDSEC');

  // BLOCKS
  w.pair(0, 'SECTION');
  w.pair(2, 'BLOCKS');
  if (r2000) {
    const block = (name: string, record: string, begin: string, end: string, paper: boolean) => {
      w.pair(0, 'BLOCK');
      w.pair(5, begin);
      w.pair(330, record);
      w.pair(100, 'AcDbEntity');
      if (paper) w.int(67, 1);
      w.pair(8, '0');
      w.pair(100, 'AcDbBlockBegin');
      w.pair(2, name);
      w.int(70, 0);
      w.pair(10, 0);
      w.pair(20, 0);
      w.pair(30, 0);
      w.pair(3, name);
      w.pair(1, '');
      w.pair(0, 'ENDBLK');
      w.pair(5, end);
      w.pair(330, record);
      w.pair(100, 'AcDbEntity');
      if (paper) w.int(67, 1);
      w.pair(8, '0');
      w.pair(100, 'AcDbBlockEnd');
    };
    block('*Model_Space', h.modelRecord, h.modelBlock, h.modelEnd, false);
    block('*Paper_Space', h.paperRecord, h.paperBlock, h.paperEnd, true);
  }
  w.pair(0, 'ENDSEC');

  // ENTITIES
  w.pair(0, 'SECTION');
  w.pair(2, 'ENTITIES');
  w.lines.push(...body.lines);
  w.pair(0, 'ENDSEC');

  if (r2000) {
    w.pair(0, 'SECTION');
    w.pair(2, 'OBJECTS');
    w.pair(0, 'DICTIONARY');
    w.pair(5, h.rootDict);
    w.pair(330, '0');
    w.pair(100, 'AcDbDictionary');
    w.int(281, 1);
    w.pair(3, 'ACAD_GROUP');
    w.pair(350, h.groupDict);
    w.pair(0, 'DICTIONARY');
    w.pair(5, h.groupDict);
    w.pair(330, h.rootDict);
    w.pair(100, 'AcDbDictionary');
    w.int(281, 1);
    w.pair(0, 'ENDSEC');
  }
  w.pair(0, 'EOF');
  if (r2000) {
    const index = w.lines.indexOf('FFFF');
    w.lines[index] = w.handseed;
  }
  return `${w.lines.join('\r\n')}\r\n`;
}

function normalizeDegrees(d: number): number {
  let v = d % 360;
  if (v < 0) v += 360;
  return v;
}
