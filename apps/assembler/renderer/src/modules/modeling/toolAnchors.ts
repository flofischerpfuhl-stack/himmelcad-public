/**
 * Where the fillet/chamfer and shell drag handles sit and which way they
 * point (`AxisHandle`s of the viewport, `platform/viewport/section.ts`).
 * Pure (no React/GL): shared by the render loop, the pointer handlers and
 * the dimension chips, so all three always agree on the same geometry.
 */
import type { Body } from '../../foundation/geometry-kernel/types.js';
import { findEdge, findFace } from '../../foundation/commands/store.js';
import type { EdgeBlendTool, ShellTool } from './tools.js';
import type { AxisHandle } from '../../platform/viewport/section.js';
import type { Vec3 } from '../../platform/viewport/math.js';

/** Visual stem added to value-sized arrows so a 0.5 mm radius still has a grabbable arrow. */
const STEM_MM = 8;
/** Arrow on the tool's first edge, pointing away from the body (between the two faces' normals). */
export function blendHandle(tool: EdgeBlendTool, bodies: readonly Body[]): AxisHandle | null {
  const body = bodies.find((b) => b.id === tool.bodyId);
  const ref = tool.edges[0];
  const edge = body && ref ? findEdge(body, ref.key) : undefined;
  if (!body || !edge) return null;
  const normals = edge.faceIndices
    .map((i) => body.faces[i]?.normal ?? null)
    .filter((n): n is [number, number, number] => n !== null);
  let dir: Vec3 | null = null;
  if (normals.length === 2) {
    const sum: Vec3 = [
      normals[0]![0] + normals[1]![0],
      normals[0]![1] + normals[1]![1],
      normals[0]![2] + normals[1]![2],
    ];
    if (Math.hypot(...sum) > 1e-6) dir = normalize(sum);
  }
  if (!dir) {
    // Curved neighbour: away from the body centre, perpendicular to a straight edge.
    const centre = boxCentre(body.min, body.max);
    let away = sub(edge.midpoint, centre);
    if (edge.direction) away = sub(away, scale(edge.direction, dot(away, edge.direction)));
    dir = Math.hypot(...away) > 1e-6 ? normalize(away) : [0, 0, 1];
  }
  return {
    handle: 'blend',
    base: edge.midpoint,
    dir,
    length: STEM_MM + Math.max(0, tool.size),
    dragDir: dir,
    value: tool.size,
  };
}

/** Arrow from the first opened face into the material (the direction the walls grow). */
export function shellHandle(tool: ShellTool, bodies: readonly Body[]): AxisHandle | null {
  const body = bodies.find((b) => b.id === tool.bodyId);
  const ref = tool.faces[0];
  const face = body && ref ? findFace(body, ref.key) : undefined;
  if (!body || !face) return null;
  const dir: Vec3 = face.normal
    ? [-face.normal[0], -face.normal[1], -face.normal[2]]
    : normalize(sub(boxCentre(body.min, body.max), face.centroid));
  return {
    handle: 'shell',
    base: face.centroid,
    dir,
    length: STEM_MM + Math.max(0, tool.thickness),
    dragDir: dir,
    value: tool.thickness,
  };
}

function boxCentre(min: Vec3, max: Vec3): Vec3 {
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(a: Vec3): Vec3 {
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}
