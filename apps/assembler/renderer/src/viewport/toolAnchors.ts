/**
 * Where the fillet/chamfer, shell and section drag handles sit, which way
 * they point, and the bounded section-plane outline. Pure (no React/GL):
 * shared by the render loop, the pointer handlers and the dimension chips,
 * so all three always agree on the same geometry.
 *
 * Handles are dragged **relatively**: the value is `start + Δt`, where `t`
 * is the pointer ray's closest point on the drag line — the tip therefore
 * follows the cursor 1:1 because the arrow grows with its value.
 */
import type { Body } from '../foundation/geometry-kernel/types.js';
import type { Bounds3 } from '../model/modeling.js';
import {
  findEdge,
  findFace,
  type EdgeBlendTool,
  type SectionAxis,
  type ShellTool,
} from '../foundation/commands/store.js';
import type { ToolHandleKind } from './picking.js';
import type { Vec3 } from './math.js';

export interface AxisHandle {
  handle: ToolHandleKind;
  /** Arrow start (world). */
  base: Vec3;
  /** Unit direction the arrow is drawn in. */
  dir: Vec3;
  /** Arrow length (world mm). */
  length: number;
  /** Unit direction a drag is measured along (value grows along it). */
  dragDir: Vec3;
  /** Current value (radius, thickness, offset). */
  value: number;
}

/** Visual stem added to value-sized arrows so a 0.5 mm radius still has a grabbable arrow. */
const STEM_MM = 8;

const AXIS_UNIT: Record<SectionAxis, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const AXIS_INDEX: Record<SectionAxis, 0 | 1 | 2> = { X: 0, Y: 1, Z: 2 };

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

export interface SectionView {
  axis: SectionAxis;
  offset: number;
  flipped: boolean;
  /**
   * Face-aligned plane: replaces `axis`; `offset` is then the distance from
   * `origin` along `normal` (unit).
   */
  plane?: { normal: Vec3; origin: Vec3 } | null;
}

/** Unit normal of the section's plane before Flip (the axis or the face normal). */
function planeUnit(section: SectionView): Vec3 {
  return section.plane ? section.plane.normal : AXIS_UNIT[section.axis];
}

/** Unit normal of the clip plane: material on its positive side is cut away. */
export function sectionNormal(section: SectionView): Vec3 {
  const unit = planeUnit(section);
  if (!section.flipped) return unit;
  return [-unit[0] || 0, -unit[1] || 0, -unit[2] || 0]; // no -0 components
}

/** `dot(p, planeUnit)` of points on the (unflipped) section plane. */
export function sectionPlaneDistance(section: SectionView): number {
  return section.plane
    ? dot(section.plane.normal, section.plane.origin) + section.offset
    : section.offset;
}

/** The clip for `gl.ts`: material with `dot(p, normal) > offset` is cut away. */
export function sectionClip(section: SectionView): { normal: Vec3; offset: number } {
  const sign = section.flipped ? -1 : 1;
  return { normal: sectionNormal(section), offset: sectionPlaneDistance(section) * sign };
}

/** Handle at the centre of the (bounded) section plane, pointing to the removed side. */
export function sectionHandle(section: SectionView, bounds: Bounds3 | null): AxisHandle {
  const centre = sectionCentre(section, bounds);
  const extent = bounds ? Math.hypot(...sub(bounds.max, bounds.min)) : 100;
  return {
    handle: 'section',
    base: centre,
    dir: sectionNormal(section),
    length: Math.max(12, extent * 0.22),
    dragDir: planeUnit(section),
    value: section.offset,
  };
}

function sectionCentre(section: SectionView, bounds: Bounds3 | null): Vec3 {
  const centre: [number, number, number] = bounds
    ? [...boxCentre(bounds.min, bounds.max)]
    : [0, 0, 0];
  if (section.plane) {
    // The model centre projected onto the plane.
    const n = section.plane.normal;
    const d = sectionPlaneDistance(section) - dot(centre, n);
    return [centre[0] + n[0] * d, centre[1] + n[1] * d, centre[2] + n[2] * d];
  }
  centre[AXIS_INDEX[section.axis]] = section.offset;
  return centre;
}

/** Offsets the section handle may be dragged to: the model's extent along the plane normal plus a margin. */
export function sectionOffsetRange(section: SectionView, bounds: Bounds3 | null): [number, number] {
  if (!bounds) return [-100, 100];
  const n = planeUnit(section);
  const base = section.plane ? dot(section.plane.normal, section.plane.origin) : 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const corner of boxCorners(bounds)) {
    const d = dot(corner, n) - base;
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  const margin = Math.max(1, (hi - lo) * 0.05);
  return [lo - margin, hi + margin];
}

/**
 * Corners of the section plane's outline: the model's extent in the two
 * in-plane axes plus a margin (10 % of the largest extent, at least 5 mm) —
 * not a screen-spanning rectangle.
 */
export function sectionOutline(
  section: SectionView,
  bounds: Bounds3 | null,
): [Vec3, Vec3, Vec3, Vec3] {
  if (section.plane) return planeOutline(section, bounds);
  const min: [number, number, number] = bounds ? [...bounds.min] : [-50, -50, -50];
  const max: [number, number, number] = bounds ? [...bounds.max] : [50, 50, 50];
  const largest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const margin = Math.max(5, largest * 0.1);
  const a = AXIS_INDEX[section.axis];
  const [u, v] = ([0, 1, 2] as const).filter((i) => i !== a) as [0 | 1 | 2, 0 | 1 | 2];
  const corner = (cu: number, cv: number): Vec3 => {
    const p: [number, number, number] = [0, 0, 0];
    p[a] = section.offset;
    p[u] = cu;
    p[v] = cv;
    return p;
  };
  const u0 = min[u] - margin;
  const u1 = max[u] + margin;
  const v0 = min[v] - margin;
  const v1 = max[v] + margin;
  return [corner(u0, v0), corner(u1, v0), corner(u1, v1), corner(u0, v1)];
}

/** Outline of a face-aligned plane: the model's box projected into the plane, plus a margin. */
function planeOutline(section: SectionView, bounds: Bounds3 | null): [Vec3, Vec3, Vec3, Vec3] {
  const n = section.plane!.normal;
  const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(ref, n));
  const v = cross(n, u);
  const d = sectionPlaneDistance(section);
  const corners = bounds ? boxCorners(bounds) : [[-50, -50, -50] as Vec3, [50, 50, 50] as Vec3];
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const c of corners) {
    u0 = Math.min(u0, dot(c, u));
    u1 = Math.max(u1, dot(c, u));
    v0 = Math.min(v0, dot(c, v));
    v1 = Math.max(v1, dot(c, v));
  }
  const margin = Math.max(5, Math.max(u1 - u0, v1 - v0) * 0.1);
  const at = (cu: number, cv: number): Vec3 => [
    n[0] * d + u[0] * cu + v[0] * cv,
    n[1] * d + u[1] * cu + v[1] * cv,
    n[2] * d + u[2] * cu + v[2] * cv,
  ];
  return [
    at(u0 - margin, v0 - margin),
    at(u1 + margin, v0 - margin),
    at(u1 + margin, v1 + margin),
    at(u0 - margin, v1 + margin),
  ];
}

function boxCorners(bounds: Bounds3): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]])
    for (const y of [bounds.min[1], bounds.max[1]])
      for (const z of [bounds.min[2], bounds.max[2]]) out.push([x, y, z]);
  return out;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Arrow tip (where the value chip sits). */
export function handleTip(handle: AxisHandle): Vec3 {
  return [
    handle.base[0] + handle.dir[0] * handle.length,
    handle.base[1] + handle.dir[1] * handle.length,
    handle.base[2] + handle.dir[2] * handle.length,
  ];
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
