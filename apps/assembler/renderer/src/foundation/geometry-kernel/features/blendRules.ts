/**
 * Helpers of the Fillet/Chamfer variants (`model/blendOptions.ts`):
 *
 * - edge rules: all edges of a face, all concave or convex edges of a body,
 *   re-evaluated on every replay;
 * - edge convexity from two point classifications
 *   (`BRepExtrema_DistShapeShape::InnerSolution`) on either side of the
 *   edge, along the difference of the two face normals: both points inside
 *   the material = concave (valley), both outside = convex (ridge);
 * - which face an asymmetric chamfer measures its first distance on;
 * - the failing edges of a blend OCCT could not build (each edge alone).
 *
 * Pure functions over the evaluator's kit; no body state is changed here.
 */
import '../occtArena.js';
import * as R from 'replicad';

import type { Vec3 } from '../../document/document.js';
import type { EdgeRule } from '../../document/blendOptions.js';
import { baseFaceKey, type KeyedFace } from '../naming.js';
import { isFatalKernelError } from '../fatal.js';
import { blendWithHistory, type BlendOptions, type RawShape } from '../occt.js';
import type { BodyStateLike, FeatureKit, Shape3D, TopologyLike } from './kit.js';
import { add, length, normalize, scale, sub } from './rigid.js';

export type EdgeConvexity = 'convex' | 'concave' | 'smooth';

/** Outward unit normal of `face` at (the projection of) `point`. */
export function faceNormalAt(kit: FeatureKit, face: R.Face, geom: KeyedFace, point: Vec3): Vec3 {
  if (geom.surface === 'plane' && geom.normal) return geom.normal;
  const oc = kit.oc;
  const vertex = R.makeVertex(point);
  const dist = new oc.BRepExtrema_DistShapeShape(
    vertex.wrapped as never,
    face.wrapped as never,
    1e-7,
  );
  const props = new oc.BRepGProp_Face(face.wrapped as never, false);
  const p = new oc.gp_Pnt();
  const n = new oc.gp_Vec();
  try {
    if (!dist.IsDone() || dist.NbSolution() < 1) return geom.normal ?? [0, 0, 1];
    const uv = dist.ParOnFaceS2(1, 0, 0);
    props.Normal(uv.u, uv.v, p, n);
    return normalize([n.X(), n.Y(), n.Z()]);
  } catch {
    return geom.normal ?? [0, 0, 1];
  } finally {
    n.delete();
    p.delete();
    props.delete();
    dist.delete();
    vertex.delete();
  }
}

/** Solids of a body shape (a body may be a compound of one or more solids). */
function solidsOf(kit: FeatureKit, shape: Shape3D): RawShape[] {
  const oc = kit.oc;
  const out: RawShape[] = [];
  const explorer = new oc.TopExp_Explorer(
    shape.wrapped as never,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID as never,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never,
  );
  try {
    for (; explorer.More(); explorer.Next()) out.push(explorer.Current() as RawShape);
  } finally {
    explorer.delete();
  }
  return out;
}

/** `true` if `point` lies inside one of `solids` (OCCT solid classification). */
function insideAny(kit: FeatureKit, solids: readonly RawShape[], point: Vec3): boolean {
  const oc = kit.oc;
  const vertex = R.makeVertex(point);
  try {
    return solids.some((solid) => {
      const dist = new oc.BRepExtrema_DistShapeShape(vertex.wrapped as never, solid as never, 1e-7);
      try {
        return dist.IsDone() && dist.InnerSolution();
      } finally {
        dist.delete();
      }
    });
  } finally {
    vertex.delete();
  }
}

/** Convexity of every edge of `body` (smooth for seams, free edges and tangent joins). */
export function edgeConvexities(kit: FeatureKit, body: BodyStateLike): EdgeConvexity[] {
  const topology = kit.topologyOf(body.shape);
  const solids = solidsOf(kit, body.shape);
  const diagonal = kit.diagonalOf(body.shape);
  try {
    return topology.edgeGeoms.map((g, e) => {
      const faces = topology.edgeFaces[e] ?? [];
      if (faces.length !== 2 || faces[0] === faces[1]) return 'smooth';
      const [a, b] = faces as [number, number];
      const p = g.midpoint;
      const na = faceNormalAt(kit, topology.faces[a]!, body.faces[a]!, p);
      const nb = faceNormalAt(kit, topology.faces[b]!, body.faces[b]!, p);
      const diff = sub(na, nb);
      if (length(diff) < 2e-3) return 'smooth';
      const d = normalize(diff);
      const eps = Math.max(1e-4, Math.min(0.02, g.length * 0.05, diagonal * 1e-3));
      const plus = insideAny(kit, solids, add(p, scale(d, eps)));
      const minus = insideAny(kit, solids, add(p, scale(d, -eps)));
      if (plus && minus) return 'concave';
      if (!plus && !minus) return 'convex';
      return 'smooth';
    });
  } finally {
    for (const solid of solids) solid.delete();
  }
}

/**
 * Edge indices the rules select on `body` (deduplicated, shape order).
 * A `faceEdges` rule resolves its face like any face reference.
 */
export function ruleEdgeIndices(
  kit: FeatureKit,
  body: BodyStateLike,
  rules: readonly EdgeRule[],
  warn: (message: string) => void,
): number[] {
  const topology = kit.topologyOf(body.shape);
  const out = new Set<number>();
  let convexity: EdgeConvexity[] | null = null;
  for (const rule of rules) {
    if (rule.kind === 'faceEdges') {
      if (rule.face.bodyId !== body.id)
        kit.fail('All edges of one feature must belong to the same body');
      const { index } = kit.resolveFace(body, rule.face, warn);
      for (const e of topology.faceEdges[index] ?? []) {
        const faces = topology.edgeFaces[e] ?? [];
        // Seams of round faces are not edges between two faces.
        if (faces.length === 2 && faces[0] !== faces[1]) out.add(e);
      }
      continue;
    }
    if (rule.bodyId !== body.id) kit.fail('All edges of one feature must belong to the same body');
    convexity ??= edgeConvexities(kit, body);
    convexity.forEach((c, e) => {
      if (c === rule.kind) out.add(e);
    });
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The face each edge's first chamfer distance is measured on: the adjacent
 * face with the smaller naming key (deterministic across edits), the other
 * one with `flip`.
 */
export function chamferReferenceFaces(
  topology: TopologyLike,
  faces: readonly KeyedFace[],
  edgeIndices: readonly number[],
  flip: boolean,
): R.Face[] {
  return edgeIndices.map((e) => {
    const adjacent = [...(topology.edgeFaces[e] ?? [])].sort((a, b) => {
      const ka = baseFaceKey(faces[a]!.key);
      const kb = baseFaceKey(faces[b]!.key);
      return ka < kb ? -1 : ka > kb ? 1 : a - b;
    });
    const pick = flip ? (adjacent[1] ?? adjacent[0]) : adjacent[0];
    return topology.faces[pick ?? 0]!;
  });
}

/**
 * Edges (indices into `edgeIndices`) that fail on their own; used only
 * after the whole blend failed, to point at the culprit. Bounded to the
 * first 24 edges so a failing blend on a big selection stays responsive.
 */
export function failingBlendEdges(
  kit: FeatureKit,
  kind: 'fillet' | 'chamfer',
  shape: Shape3D,
  edges: readonly R.Edge[],
  size: number,
  options: BlendOptions,
): number[] {
  const failing: number[] = [];
  edges.slice(0, 24).forEach((edge, i) => {
    try {
      const built = blendWithHistory(kit.oc, kind, shape, [edge], size, {
        ...options,
        ...(options.faces ? { faces: [options.faces[i]!] } : {}),
      });
      built.history.delete();
      built.shape.delete();
    } catch (error) {
      if (isFatalKernelError(error)) throw error;
      failing.push(i);
    }
  });
  return failing;
}
