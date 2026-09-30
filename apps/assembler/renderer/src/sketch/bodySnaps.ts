/**
 * 3D snapping while sketching (Shapr3D Snapping Options, interaction
 * research §5): body points — vertices, edge midpoints, circle (hole)
 * centres — and, in an orthographic view, edges away from the sketch
 * plane, all seen along the sketch normal (the sketch camera looks straight
 * at the plane). Suggestions only: a snapped point is placed there, no
 * link to the body is created (Project `P` makes associative geometry).
 * Pure: bodies and the sketch frame in, sketch (u, v) targets out.
 */
import type { Body } from '../foundation/geometry-kernel/types.js';
import { frameUv, type SketchFrame, type Vec3 } from '../foundation/document/document.js';
import type { Vec2 } from '../foundation/sketch-solver/types.js';

export type BodySnapKind = 'vertex' | 'edgeMidpoint' | 'circleCenter';

export interface BodySnapPoint {
  pos: Vec2;
  kind: BodySnapKind;
  /** Height above the sketch plane (0 = on it), mm. */
  height: number;
}

export interface BodySnapTargets {
  points: BodySnapPoint[];
  /** Edges out of the sketch plane, projected: segment pairs in (u, v). */
  farEdges: [Vec2, Vec2][];
}

/** Distance under which an edge lies in the sketch plane (not "far"), mm. */
const IN_PLANE_MM = 1e-3;
/** Cap on the far-edge segments handed to the snapper (large imports), per body. */
const MAX_FAR_SEGMENTS = 4000;

function circleCenter(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
  if (nn < 1e-12) return null;
  const t1: Vec3 = [
    n[1] * ab[2] - n[2] * ab[1],
    n[2] * ab[0] - n[0] * ab[2],
    n[0] * ab[1] - n[1] * ab[0],
  ];
  const t2: Vec3 = [
    ac[1] * n[2] - ac[2] * n[1],
    ac[2] * n[0] - ac[0] * n[2],
    ac[0] * n[1] - ac[1] * n[0],
  ];
  const dab = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const dac = ac[0] * ac[0] + ac[1] * ac[1] + ac[2] * ac[2];
  const k = 1 / (2 * nn);
  return [
    a[0] + (t1[0] * dac + t2[0] * dab) * k,
    a[1] + (t1[1] * dac + t2[1] * dab) * k,
    a[2] + (t1[2] * dac + t2[2] * dab) * k,
  ];
}

/**
 * Snap targets of `bodies` for a sketch in `frame`. `farEdges` only when
 * `orthographic` (Shapr3D: "entfernte Kanten … in orthogonaler Sicht").
 */
export function bodySnapTargets(
  bodies: readonly Body[],
  frame: SketchFrame,
  options: { orthographic: boolean },
): BodySnapTargets {
  const points: BodySnapPoint[] = [];
  const farEdges: [Vec2, Vec2][] = [];
  const n = frame.normal;
  const height = (p: Vec3) =>
    (p[0] - frame.origin[0]) * n[0] +
    (p[1] - frame.origin[1]) * n[1] +
    (p[2] - frame.origin[2]) * n[2];
  const uv = (p: Vec3): Vec2 => {
    const { u, v } = frameUv(frame, p);
    return [u, v];
  };
  const seen = new Set<string>();
  // Mesh samples are single precision: targets are rounded to 0.01 µm (no 40.0000002 points).
  const round = (v: number) => Math.round(v * 1e5) / 1e5;
  const add = (p: Vec3, kind: BodySnapKind) => {
    const raw = uv(p);
    const pos: Vec2 = [round(raw[0]), round(raw[1])];
    const key = `${kind}:${pos[0].toFixed(4)}:${pos[1].toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push({ pos, kind, height: height(p) });
  };
  for (const body of bodies) {
    let farBudget = MAX_FAR_SEGMENTS;
    for (const edge of body.edges) {
      const s = edge.segments;
      const count = s.length / 3;
      if (count < 2) continue;
      const at = (i: number): Vec3 => [s[i * 3]!, s[i * 3 + 1]!, s[i * 3 + 2]!];
      const first = at(0);
      const last = at(count - 1);
      const closed = Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]) < 1e-6;
      if (edge.curve === 'circle') {
        const c = circleCenter(first, at(Math.floor(count / 3)), at(Math.floor((2 * count) / 3)));
        if (c) add(c, 'circleCenter');
        if (!closed) {
          add(first, 'vertex');
          add(last, 'vertex');
        }
      } else {
        add(first, 'vertex');
        add(last, 'vertex');
        if (edge.curve === 'line') add(edge.midpoint, 'edgeMidpoint');
      }
      if (!options.orthographic || farBudget <= 0) continue;
      // Segment pairs (x0 y0 z0 x1 y1 z1 …) of edges that leave the sketch plane.
      const inPlane =
        Math.abs(height(first)) < IN_PLANE_MM &&
        Math.abs(height(last)) < IN_PLANE_MM &&
        Math.abs(height(edge.midpoint)) < IN_PLANE_MM;
      if (inPlane) continue;
      for (let i = 0; i + 1 < count && farBudget > 0; i += 2) {
        const a = uv(at(i));
        const b = uv(at(i + 1));
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) continue;
        farEdges.push([a, b]);
        farBudget -= 1;
      }
    }
  }
  return { points, farEdges };
}
