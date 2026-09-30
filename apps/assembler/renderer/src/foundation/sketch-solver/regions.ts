/**
 * Automatic profile (closed region) detection for sketches, Shapr3D-style:
 * every bounded face of the planar arrangement of the sketch's
 * non-construction curves is a region — including regions created by
 * intersecting geometry — and loops nested inside a region are its holes.
 *
 * Algorithm (pure, deterministic):
 * 1. Split every curve at all intersections with other curves (and at its
 *    own ends); merge coincident split points into vertices.
 * 2. Drop duplicate pieces (overlapping geometry) and, repeatedly, pieces
 *    with a dangling end (open curves never bound a region).
 * 3. Build a half-edge graph; at each vertex sort outgoing half-edges by
 *    tangent angle (ties by curvature) and trace faces keeping the face on
 *    the left. Counter-clockwise cycles (positive area) are bounded faces;
 *    each connected component additionally has one clockwise outer cycle.
 * 4. A component's outer cycle lying inside a bounded face of another
 *    component is a hole of the smallest such face.
 *
 * Region keys (`SketchRegion.key`) are the stable profile references
 * extrudes store: the sorted ids of the entities bounding the region's
 * outer loop, with a side signature only when two regions share that set
 * (e.g. the two halves of a circle cut by a line). A dimension change keeps
 * the key; a key only disappears when the region itself does. See
 * `assembler/SKETCHING.md` "Profiles".
 */
import {
  EPS,
  areaTerm,
  cross,
  curvatureAt,
  curveBox,
  curveLength,
  dist,
  intersectCurves,
  isClosedCurve,
  pointAt,
  pointInPolygon,
  sampleCurve,
  sketchCurves,
  sub,
  subCurve,
  tangentAt,
  reverseCurve,
  type Curve2,
} from './geometry.js';
import type { SketchData, Vec2 } from './types.js';

/**
 * One oriented piece of a region boundary, part of the curve `entityId`
 * (the sketch entity id; `<textId>.<n>` for a glyph contour of a text).
 */
export interface RegionPiece {
  entityId: string;
  /** Oriented in traversal order (arcs: negative sweep = clockwise). */
  curve: Curve2;
  /**
   * Exact shared vertex positions of the piece ends (identical for
   * consecutive pieces), so a wire built from them closes without gaps.
   * Absent for a full circle.
   */
  start?: Vec2;
  end?: Vec2;
}

export interface RegionLoop {
  pieces: RegionPiece[];
  /** Signed area (outer loops positive, holes negative as traversed). */
  area: number;
}

export interface SketchRegion {
  /** Stable profile reference (see module doc). */
  key: string;
  outer: RegionLoop;
  holes: RegionLoop[];
  /** Net area, mm². */
  area: number;
  /** A point strictly inside the region (not in a hole). */
  sample: Vec2;
}

interface Piece {
  entityId: string;
  curve: Curve2;
  v0: number;
  v1: number;
}

/** Detects the closed regions of a sketch, sorted by key. */
export function detectRegions(sketch: Pick<SketchData, 'entities'>): SketchRegion[] {
  const curves = sketchCurves(sketch);
  if (curves.length === 0) return [];
  const boxes = curves.map(({ curve }) => curveBox(curve));
  const extent = Math.max(1, ...boxes.flatMap((b) => b.map(Math.abs)));
  const eps = EPS * extent;

  // 1. Split parameters per curve.
  const params: number[][] = curves.map(({ curve }) => (isClosedCurve(curve) ? [] : [0, 1]));
  for (let i = 0; i < curves.length; i += 1) {
    for (let j = i + 1; j < curves.length; j += 1) {
      const bi = boxes[i]!;
      const bj = boxes[j]!;
      if (
        bi[0] > bj[2] + eps ||
        bj[0] > bi[2] + eps ||
        bi[1] > bj[3] + eps ||
        bj[1] > bi[3] + eps
      ) {
        continue;
      }
      for (const hit of intersectCurves(curves[i]!.curve, curves[j]!.curve, eps)) {
        params[i]!.push(hit.t1);
        params[j]!.push(hit.t2);
      }
    }
  }

  const vertices: Vec2[] = [];
  const vertexAt = (p: Vec2): number => {
    for (let i = 0; i < vertices.length; i += 1) if (dist(vertices[i]!, p) < eps * 10) return i;
    vertices.push(p);
    return vertices.length - 1;
  };

  const pieces: Piece[] = [];
  const standaloneCircles: { entityId: string; curve: Curve2 }[] = [];
  curves.forEach(({ id, curve }, index) => {
    const full = isClosedCurve(curve);
    const length = curveLength(curve);
    if (length < eps) return;
    const ts = [...params[index]!].sort((a, b) => a - b);
    const unique: number[] = [];
    for (const t of ts) {
      if (unique.length === 0 || (t - unique[unique.length - 1]!) * length > eps) unique.push(t);
    }
    if (full) {
      if (unique.length > 1 && (1 + unique[0]! - unique[unique.length - 1]!) * length <= eps)
        unique.pop();
      if (unique.length === 0) {
        standaloneCircles.push({ entityId: id, curve });
        return;
      }
      for (let k = 0; k < unique.length; k += 1) {
        const t0 = unique[k]!;
        const t1 = k + 1 < unique.length ? unique[k + 1]! : unique[0]! + 1;
        const sub = subCurve(curve, t0, t1);
        pieces.push({
          entityId: id,
          curve: sub,
          v0: vertexAt(pointAt(sub, 0)),
          v1: vertexAt(pointAt(sub, 1)),
        });
      }
      return;
    }
    for (let k = 0; k + 1 < unique.length; k += 1) {
      const sub = subCurve(curve, unique[k]!, unique[k + 1]!);
      pieces.push({
        entityId: id,
        curve: sub,
        v0: vertexAt(pointAt(sub, 0)),
        v1: vertexAt(pointAt(sub, 1)),
      });
    }
  });

  // 2. Deduplicate overlapping pieces, then prune dangling ones.
  const deduped: Piece[] = [];
  for (const piece of pieces) {
    const mid = pointAt(piece.curve, 0.5);
    const duplicate = deduped.some(
      (other) =>
        ((other.v0 === piece.v0 && other.v1 === piece.v1) ||
          (other.v0 === piece.v1 && other.v1 === piece.v0)) &&
        other.curve.kind === piece.curve.kind &&
        dist(pointAt(other.curve, 0.5), mid) < eps * 10,
    );
    if (!duplicate) deduped.push(piece);
  }
  let alive = deduped;
  for (;;) {
    const degree = new Map<number, number>();
    for (const p of alive) {
      degree.set(p.v0, (degree.get(p.v0) ?? 0) + 1);
      degree.set(p.v1, (degree.get(p.v1) ?? 0) + 1);
    }
    const next = alive.filter((p) => (degree.get(p.v0) ?? 0) > 1 && (degree.get(p.v1) ?? 0) > 1);
    if (next.length === alive.length) break;
    alive = next;
  }

  // 3. Half-edge face tracing.
  interface HalfEdge {
    piece: Piece;
    forward: boolean;
    from: number;
    to: number;
    angle: number;
    curvature: number;
  }
  const halfEdges: HalfEdge[] = [];
  for (const piece of alive) {
    const t0 = tangentAt(piece.curve, 0);
    const t1 = tangentAt(piece.curve, 1);
    halfEdges.push({
      piece,
      forward: true,
      from: piece.v0,
      to: piece.v1,
      angle: Math.atan2(t0[1], t0[0]),
      curvature: curvatureAt(piece.curve, 0),
    });
    halfEdges.push({
      piece,
      forward: false,
      from: piece.v1,
      to: piece.v0,
      angle: Math.atan2(-t1[1], -t1[0]),
      curvature: -curvatureAt(piece.curve, 1),
    });
  }
  const outgoing = new Map<number, number[]>();
  halfEdges.forEach((h, i) => {
    const list = outgoing.get(h.from) ?? [];
    list.push(i);
    outgoing.set(h.from, list);
  });
  for (const list of outgoing.values()) {
    list.sort((a, b) => {
      const ha = halfEdges[a]!;
      const hb = halfEdges[b]!;
      if (Math.abs(ha.angle - hb.angle) > 1e-9) return ha.angle - hb.angle;
      return ha.curvature - hb.curvature;
    });
  }
  const nextOf = (h: number): number => {
    const twin = h ^ 1;
    const list = outgoing.get(halfEdges[h]!.to)!;
    const index = list.indexOf(twin);
    return list[(index - 1 + list.length) % list.length]!;
  };

  interface Cycle {
    pieces: RegionPiece[];
    area: number;
    component: number;
    polygon: Vec2[];
  }
  // Components (union-find over vertices).
  const parent = vertices.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (const p of alive) parent[find(p.v0)] = find(p.v1);

  const cycles: Cycle[] = [];
  const visited = new Set<number>();
  for (let start = 0; start < halfEdges.length; start += 1) {
    if (visited.has(start)) continue;
    const loop: number[] = [];
    let h = start;
    let guard = 0;
    while (!visited.has(h) && guard < halfEdges.length + 1) {
      visited.add(h);
      loop.push(h);
      h = nextOf(h);
      guard += 1;
    }
    if (h !== start) continue; // defensive: malformed cycle
    const regionPieces = loop.map((index) => {
      const he = halfEdges[index]!;
      return {
        entityId: he.piece.entityId,
        curve: he.forward ? he.piece.curve : reverseCurve(he.piece.curve),
        start: vertices[he.from]!,
        end: vertices[he.to]!,
      };
    });
    const area = regionPieces.reduce((sum, p) => sum + areaTerm(p.curve), 0);
    cycles.push({
      pieces: regionPieces,
      area,
      component: find(halfEdges[start]!.from),
      polygon: polygonOf(regionPieces),
    });
  }
  let componentCount = vertices.length;
  for (const circle of standaloneCircles) {
    const ccw: RegionPiece[] = [{ entityId: circle.entityId, curve: circle.curve }];
    const cw: RegionPiece[] = [{ entityId: circle.entityId, curve: reverseCurve(circle.curve) }];
    const component = componentCount;
    componentCount += 1;
    cycles.push({ pieces: ccw, area: areaTerm(circle.curve), component, polygon: polygonOf(ccw) });
    cycles.push({ pieces: cw, area: -areaTerm(circle.curve), component, polygon: polygonOf(cw) });
  }

  const areaEps = eps * extent;
  const faces = cycles.filter((c) => c.area > areaEps);
  const outers = cycles.filter((c) => c.area < -areaEps);

  // 4. Holes: a component's outer cycle inside a face of another component.
  const holesOf = new Map<Cycle, Cycle[]>();
  for (const outer of outers) {
    const probe = outer.polygon[0]!;
    let best: Cycle | null = null;
    for (const face of faces) {
      if (face.component === outer.component) continue;
      if (!pointInPolygon(probe, face.polygon)) continue;
      if (!best || face.area < best.area) best = face;
    }
    if (best) {
      const list = holesOf.get(best) ?? [];
      list.push(outer);
      holesOf.set(best, list);
    }
  }

  const regions = faces.map((face) => {
    const holes = holesOf.get(face) ?? [];
    const outer: RegionLoop = { pieces: face.pieces, area: face.area };
    const holeLoops: RegionLoop[] = holes.map((h) => ({ pieces: h.pieces, area: h.area }));
    return {
      key: '',
      outer,
      holes: holeLoops,
      area: face.area + holes.reduce((sum, h) => sum + h.area, 0),
      sample: interiorPoint(
        face.polygon,
        holes.map((h) => h.polygon),
      ),
    };
  });
  // Text follows the font's fill rule: a counter (the inside of an "O") is not a profile.
  const textPolygons = new Map<string, Vec2[][]>();
  for (const c of curves) {
    if (c.id === c.entityId) continue;
    const list = textPolygons.get(c.entityId) ?? [];
    list.push(sampleCurve(c.curve));
    textPolygons.set(c.entityId, list);
  }
  const filled = regions.filter((region) => {
    const owners = new Set(
      region.outer.pieces.map((p) => (p.entityId.includes('.') ? p.entityId.split('.')[0]! : '')),
    );
    if (owners.size !== 1 || owners.has('')) return true;
    const polygons = textPolygons.get([...owners][0]!) ?? [];
    const inside = polygons.filter((poly) => pointInPolygon(region.sample, poly)).length;
    return inside % 2 === 1;
  });
  assignKeys(filled, sketch);
  return filled.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function polygonOf(pieces: readonly RegionPiece[]): Vec2[] {
  const out: Vec2[] = [];
  for (const piece of pieces) {
    const samples = sampleCurve(piece.curve);
    out.push(...samples.slice(0, -1));
  }
  return out;
}

/** Closed polyline of a region loop (for display, hit testing and triangulation checks). */
export function loopPolygon(loop: RegionLoop): Vec2[] {
  return polygonOf(loop.pieces);
}

/** A point inside `outer` and outside every hole: the middle of the widest scanline span. */
function interiorPoint(outer: readonly Vec2[], holes: readonly (readonly Vec2[])[]): Vec2 {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of outer) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  let best: { x: number; y: number; width: number } | null = null;
  for (const fraction of [0.5003, 0.2503, 0.7503, 0.1253, 0.8753]) {
    const y = minY + (maxY - minY) * fraction;
    const xs: number[] = [];
    for (const polygon of [outer, ...holes]) {
      for (let i = 0; i < polygon.length; i += 1) {
        const a = polygon[i]!;
        const b = polygon[(i + 1) % polygon.length]!;
        if (a[1] > y !== b[1] > y) xs.push(a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const width = xs[i + 1]! - xs[i]!;
      if (!best || width > best.width) best = { x: (xs[i]! + xs[i + 1]!) / 2, y, width };
    }
    if (best && best.width > 0) break;
  }
  return best ? [best.x, best.y] : (outer[0] ?? [0, 0]);
}

function assignKeys(
  regions: { key: string; outer: RegionLoop; sample: Vec2 }[],
  sketch: Pick<SketchData, 'entities'>,
): void {
  const base = regions.map((r) =>
    [...new Set(r.outer.pieces.map((p) => p.entityId))].sort().join('+'),
  );
  const groups = new Map<string, number[]>();
  base.forEach((key, i) => groups.set(key, [...(groups.get(key) ?? []), i]));
  const lines = new Map(
    sketchCurves(sketch)
      .filter((c) => c.curve.kind === 'line')
      .map((c) => [c.id, c.curve as Extract<Curve2, { kind: 'line' }>]),
  );
  for (const [key, members] of groups) {
    if (members.length === 1) {
      regions[members[0]!]!.key = key;
      continue;
    }
    // Side signature relative to every bounding line (topological, survives dimension edits).
    const ids = key.split('+').filter((id) => lines.has(id));
    const signed = members.map((i) => {
      const region = regions[i]!;
      const signs = ids
        .map((id) => {
          const l = lines.get(id)!;
          return cross(sub(l.b, l.a), sub(region.sample, l.a)) >= 0 ? 'L' : 'R';
        })
        .join('');
      return { i, signs };
    });
    const bySigns = new Map<string, number[]>();
    for (const s of signed) bySigns.set(s.signs, [...(bySigns.get(s.signs) ?? []), s.i]);
    for (const [signs, indices] of bySigns) {
      const suffix = signs ? `@${signs}` : '';
      if (indices.length === 1) {
        regions[indices[0]!]!.key = `${key}${suffix}`;
        continue;
      }
      indices
        .sort((a, b) => {
          const pa = regions[a]!.sample;
          const pb = regions[b]!.sample;
          return pa[0] - pb[0] || pa[1] - pb[1];
        })
        .forEach((index, n) => {
          regions[index]!.key = `${key}${suffix}#${n}`;
        });
    }
  }
}
