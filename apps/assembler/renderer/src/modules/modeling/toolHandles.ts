/**
 * Handles and value chips of the modelling tools: the Move/Rotate gizmo's
 * rings and centre, the extrude extras (second side, start offset), the
 * Move/Rotate preview bodies and the gizmo-centre snapping — derived from
 * the store state (pure, no React/GL) and shared by the render loop, the
 * pointer handlers and the chip overlay (`viewportTools.ts`). Values are
 * written back through {@link applyToolHandleValue}.
 */
import { MAX_EXTRUDE_TAPER, frameForFace } from '../../foundation/document/document.js';
import { opsAffine } from '../../foundation/geometry-kernel/features/rigid.js';
import { WORLD_AXES, gizmoOps, isWorldAxes } from './moveGizmo.js';
import type { Body } from '../../foundation/geometry-kernel/types.js';
import { profileSamples } from './featureTools.js';
import { useAssemblerStore, type AssemblerState } from '../../foundation/commands/store.js';
import type { MoveTool } from './tools.js';
import { transformBody } from '../../platform/viewport/bodyTransform.js';
import {
  applyFeatureHandleValue,
  featureToolHandles,
} from '../../platform/viewport/featureToolView.js';
import type { Vec3 } from '../../platform/viewport/math.js';
import type { ToolHandleKind } from '../../platform/viewport/picking.js';
import {
  EMPTY_TOOL_HANDLES,
  type ToolChip,
  type ToolHandleSet,
} from '../../platform/viewport/toolViews.js';
/** Rotation-ring radius relative to the move arrows (40 mm). */
const RING_RADIUS_MM = 28;
const DRAG_STEP_MM = 0.1;

function angleAt(
  h: { center: Vec3; axis: Vec3; ref: Vec3; radius: number },
  degrees: number,
): Vec3 {
  const u = normalize(h.ref);
  const v = normalize(cross(h.axis, u));
  const a = (degrees * Math.PI) / 180;
  return [
    h.center[0] + (u[0] * Math.cos(a) + v[0] * Math.sin(a)) * h.radius,
    h.center[1] + (u[1] * Math.cos(a) + v[1] * Math.sin(a)) * h.radius,
    h.center[2] + (u[2] * Math.cos(a) + v[2] * Math.sin(a)) * h.radius,
  ];
}

/** Displayed gizmo centre: the pivot carried along by the translation. */
export function movePivotShown(tool: MoveTool): Vec3 {
  return [
    tool.pivot[0] + tool.delta.dx,
    tool.pivot[1] + tool.delta.dy,
    tool.pivot[2] + tool.delta.dz,
  ];
}

function ringHandles(tool: MoveTool, colors: [Vec3, Vec3, Vec3] | null): ToolHandleSet {
  const center = movePivotShown(tool);
  // A sketch profile only moves (no rings); the gizmo keeps its centre handle.
  if (tool.sketch) return { axis: [], angles: [], chips: [], guides: null, pivot: center };
  const axes: Vec3[] = tool.axes ? [...tool.axes] : [...WORLD_AXES];
  // Each ring's zero direction: the next axis (X ring from Y, Y from Z, Z from X).
  const refs: Vec3[] = [axes[1]!, axes[2]!, axes[0]!];
  const values = [tool.rotation.rx, tool.rotation.ry, tool.rotation.rz];
  const angles = ([0, 1, 2] as const).map((i) => ({
    handle: `ring:${i}` as const,
    center,
    axis: axes[i]!,
    ref: refs[i]!,
    radius: RING_RADIUS_MM,
    value: values[i]!,
    ring: true,
    color: colors ? colors[i]! : null,
  }));
  const chips: ToolChip[] = angles.map((a, i) => ({
    handle: a.handle,
    label:
      tool.axes && !isWorldAxes(tool.axes) ? `Rotate about axis ${i + 1}` : `Rotate ${'XYZ'[i]}`,
    prefix: tool.axes && !isWorldAxes(tool.axes) ? `R${i + 1}` : `${'XYZ'[i]}`,
    unit: 'deg',
    value: a.value,
    // In the quadrant between the negative arrows, so ring chips never sit on an arrow chip.
    at: angleAt({ ...a, radius: a.radius * 1.5 }, -45),
  }));
  return { axis: [], angles, chips, guides: null, pivot: center };
}

/** All tool handles for the current state (empty without a tool that has any). */
export function toolHandleSet(
  state: AssemblerState,
  ringColors: [Vec3, Vec3, Vec3] | null = null,
): ToolHandleSet {
  const tool = state.activeTool;
  if (tool?.kind === 'feature') return featureToolHandles(state);
  if (tool?.kind === 'move') return ringHandles(tool, ringColors);
  if (tool?.kind === 'extrude') return extrudeHandles(state);
  return EMPTY_TOOL_HANDLES;
}

/**
 * Extrude extras: the second side's arrow (two sides) and the start-offset
 * chip, next to the main distance arrow the viewport draws itself.
 */
function extrudeHandles(state: AssemblerState): ToolHandleSet {
  const tool = state.activeTool;
  if (tool?.kind !== 'extrude') return EMPTY_TOOL_HANDLES;
  const samples = profileSamples(state.evaluation, tool.profile);
  if (!samples) return EMPTY_TOOL_HANDLES;
  const n = samples.normal;
  const s = tool.startOffset ?? 0;
  const base: Vec3 = [
    samples.center[0] + n[0] * s,
    samples.center[1] + n[1] * s,
    samples.center[2] + n[2] * s,
  ];
  const out: ToolHandleSet = { axis: [], angles: [], chips: [], guides: null, pivot: null };
  if (tool.sides === 'two') {
    const sign = tool.distance < 0 ? 1 : -1;
    const dir: Vec3 = [n[0] * sign, n[1] * sign, n[2] * sign];
    const length = Math.max(tool.distance2 ?? 0, 8);
    out.axis.push({
      handle: 'extrude2',
      base,
      dir,
      length,
      dragDir: dir,
      value: tool.distance2 ?? 0,
    });
    out.chips.push({
      handle: 'extrude2',
      label: 'Second side distance',
      unit: 'mm',
      value: tool.distance2 ?? 0,
      at: [base[0] + dir[0] * length, base[1] + dir[1] * length, base[2] + dir[2] * length],
    });
  }
  const taper = taperHandle(tool, samples, base);
  if (taper) {
    out.angles.push(taper);
    out.chips.push({
      handle: 'extrudeTaper',
      label: 'Taper angle',
      prefix: '∠',
      unit: 'deg',
      value: tool.taper ?? 0,
      at: angleAt({ ...taper, radius: taper.radius * 1.35 }, (tool.taper ?? 0) + 12),
    });
  }
  return out;
}

/**
 * The taper (draft) handle of a distance extrude: an arc at the wall
 * farthest along the profile's first in-plane axis, swinging from the
 * extrude direction (0°) inwards (positive) or outwards (negative).
 */
function taperHandle(
  tool: Extract<AssemblerState['activeTool'], { kind: 'extrude' }>,
  samples: { center: Vec3; normal: Vec3; outline: Vec3[] },
  base: Vec3,
): ToolHandleSet['angles'][number] | null {
  if ((tool.extent ?? 'distance') !== 'distance' || tool.distance === 0) return null;
  const n = samples.normal;
  const side = frameForFace(n, [0, 0, 0]).u;
  const pts = samples.outline;
  if (pts.length < 2) return null;
  // The wall point: the outline segment midpoint farthest along the in-plane axis.
  let wall: Vec3 | null = null;
  let best = -Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const m: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const along = dot(sub(m, samples.center), side);
    if (along > best) {
      best = along;
      wall = m;
    }
  }
  if (!wall) return null;
  const rel = sub(wall, samples.center);
  const out = normalize(sub(rel, scale(n, dot(rel, n))));
  const travel = scale(n, tool.distance < 0 ? -1 : 1);
  const center: Vec3 = [base[0] + rel[0], base[1] + rel[1], base[2] + rel[2]];
  // About `out × travel`, so a positive angle turns the extrude direction inwards (−out).
  return {
    handle: 'extrudeTaper',
    center,
    axis: cross(out, travel),
    ref: travel,
    radius: Math.min(20, Math.max(6, Math.abs(tool.distance) * 0.6)),
    value: tool.taper ?? 0,
    ring: false,
    color: null,
    // Draft angles are small: whole degrees (Shift: free).
    snapDeg: 1,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

/** Bodies of the Move/Rotate preview: the body moved (or a moved copy added), the original as ghost. */
export function movePreviewBodies(
  tool: MoveTool,
  bodies: readonly Body[],
): { bodies: Body[]; newIds: string[]; ghosts: Body[] } {
  const body = bodies.find((b) => b.id === tool.bodyId);
  if (!body) return { bodies: [...bodies], newIds: [], ghosts: [] };
  const affine = opsAffine(gizmoOps(tool));
  if (tool.copy) {
    const copy = transformBody(body, affine, `${body.id}::copy`);
    return { bodies: [...bodies, copy], newIds: [copy.id], ghosts: [] };
  }
  const moved = transformBody(body, affine);
  const still =
    tool.delta.dx === 0 &&
    tool.delta.dy === 0 &&
    tool.delta.dz === 0 &&
    tool.rotation.rx === 0 &&
    tool.rotation.ry === 0 &&
    tool.rotation.rz === 0;
  return {
    bodies: bodies.map((b) => (b.id === body.id ? moved : b)),
    newIds: [],
    ghosts: still ? [] : [body],
  };
}

/**
 * Writes a dragged or typed value of a tool handle to the store. `snap`
 * applies the drag step (0.1 mm, whole counts; angles are snapped by the
 * caller). Returns `false` if the handle is not one of these.
 */
export function applyToolHandleValue(handle: ToolHandleKind, raw: number, snap: boolean): boolean {
  const s = useAssemblerStore.getState();
  if (!Number.isFinite(raw)) return true;
  if (handle.startsWith('ring:')) {
    const tool = s.activeTool;
    if (tool?.kind !== 'move') return true;
    const i = Number(handle.slice(5));
    const r = [tool.rotation.rx, tool.rotation.ry, tool.rotation.rz];
    r[i] = Math.round(raw * 1000) / 1000;
    s.setRotation(r[0]!, r[1]!, r[2]!);
    return true;
  }
  if (handle === 'extrudeTaper') {
    // Drags snap to whole degrees (Shift-free dragging is the viewport's).
    const value = snap ? Math.round(raw) : Math.round(raw * 1000) / 1000;
    const clamped = Math.max(-MAX_EXTRUDE_TAPER, Math.min(MAX_EXTRUDE_TAPER, value));
    s.setExtrudeOptions({ taper: clamped === 0 ? undefined : clamped });
    return true;
  }
  if (handle === 'extrude2' || handle === 'extrudeStart') {
    let value = snap ? Math.round(raw / DRAG_STEP_MM) * DRAG_STEP_MM : raw;
    value = Math.round(value * 1000) / 1000;
    if (handle === 'extrude2') s.setExtrudeOptions({ distance2: Math.max(0, value) });
    else s.setExtrudeOptions({ startOffset: value === 0 ? undefined : value });
    return true;
  }
  return applyFeatureHandleValue(handle, raw, snap);
}

/**
 * Where the gizmo centre snaps when dragged onto geometry: a face's
 * centroid (on a hole's axis for a cylinder), an edge's midpoint or a
 * circular edge's centre. `null` for anything else.
 */
export function pivotSnapPoint(
  pick: { kind: string; bodyId?: string; faceKey?: string; edgeKey?: string } | null,
  bodies: readonly Body[],
): Vec3 | null {
  if (!pick?.bodyId) return null;
  const body = bodies.find((b) => b.id === pick.bodyId);
  if (!body) return null;
  if (pick.kind === 'face') return body.faces.find((f) => f.key === pick.faceKey)?.centroid ?? null;
  if (pick.kind !== 'edge') return null;
  const edge = body.edges.find((e) => e.key === pick.edgeKey);
  if (!edge) return null;
  const s = edge.segments;
  if (edge.curve === 'circle' && s.length >= 18) {
    const n = s.length / 3;
    const p = (i: number): Vec3 => [s[i * 3]!, s[i * 3 + 1]!, s[i * 3 + 2]!];
    const centre = circleCenter(p(0), p(Math.floor(n / 3)), p(Math.floor((2 * n) / 3)));
    if (centre) return centre;
  }
  return edge.midpoint;
}

function circleCenter(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = cross(ab, ac);
  const nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
  if (nn < 1e-12) return null;
  const dab = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const dac = ac[0] * ac[0] + ac[1] * ac[1] + ac[2] * ac[2];
  const t1 = cross(n, ab);
  const t2 = cross(ac, n);
  const k = 1 / (2 * nn);
  return [
    a[0] + (t1[0] * dac + t2[0] * dab) * k,
    a[1] + (t1[1] * dac + t2[1] * dab) * k,
    a[2] + (t1[2] * dac + t2[2] * dab) * k,
  ];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
