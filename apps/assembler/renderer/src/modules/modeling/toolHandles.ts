/**
 * Handles, value chips and guides of the modelling-feature tools and of the
 * Move/Rotate gizmo's rings and pivot, derived from the store state (pure,
 * no React/GL) and shared by the render loop, the pointer handlers and the
 * chip overlay — all three always agree. Values are written back through
 * {@link applyToolHandleValue}.
 */
import { opsAffine } from '../../foundation/geometry-kernel/features/rigid.js';
import { WORLD_AXES, gizmoOps, isWorldAxes } from './moveGizmo.js';
import type { Body } from '../../foundation/geometry-kernel/types.js';
import { profileSamples } from './featureTools.js';
import {
  draftGuides,
  draftHandles,
  draftModifiedBodyIds,
  type DraftGuides,
  type DraftHandle,
  type HandleUnit,
} from '../../foundation/commands/featureDrafts.js';
import {
  useAssemblerStore,
  type AssemblerState,
  type MoveTool,
} from '../../foundation/commands/store.js';
import { transformBody } from '../../platform/viewport/bodyTransform.js';
import type { Vec3 } from '../../platform/viewport/math.js';
import type { ToolHandleKind } from '../../platform/viewport/picking.js';
import type { AngleHandleState } from '../../platform/viewport/scene.js';
import type { AxisHandle } from './toolAnchors.js';

/** Rotation-ring radius relative to the move arrows (40 mm). */
const RING_RADIUS_MM = 28;
const DRAG_STEP_MM = 0.1;
/** Angle drags snap to this unless Shift is held (then 0.1°). */
export const ANGLE_SNAP_DEG = 15;

export interface ToolChip {
  handle: ToolHandleKind;
  label: string;
  prefix?: string;
  unit: HandleUnit;
  value: number;
  /** World anchor of the chip. */
  at: Vec3;
}

export interface ToolHandleSet {
  axis: AxisHandle[];
  angles: Omit<AngleHandleState, 'hovered'>[];
  chips: ToolChip[];
  guides: DraftGuides | null;
  pivot: Vec3 | null;
}

const EMPTY: ToolHandleSet = { axis: [], angles: [], chips: [], guides: null, pivot: null };

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

/** Handles of the running feature tool. */
function featureHandles(state: AssemblerState, handles: DraftHandle[]): ToolHandleSet {
  const out: ToolHandleSet = { ...EMPTY, axis: [], angles: [], chips: [] };
  for (const h of handles) {
    const handle: ToolHandleKind = `feature:${h.id}`;
    const chip = {
      handle,
      label: h.label,
      unit: h.unit,
      value: h.value,
      ...(h.prefix ? { prefix: h.prefix } : {}),
    };
    if (h.kind === 'linear') {
      out.axis.push({
        handle,
        base: h.base,
        dir: h.dir,
        length: h.length,
        dragDir: h.dir,
        value: h.value,
      });
      out.chips.push({
        ...chip,
        at: [
          h.base[0] + h.dir[0] * h.length,
          h.base[1] + h.dir[1] * h.length,
          h.base[2] + h.dir[2] * h.length,
        ],
      });
    } else if (h.kind === 'angle') {
      out.angles.push({
        handle,
        center: h.center,
        axis: h.axis,
        ref: h.ref,
        radius: h.radius,
        value: h.value,
        ring: false,
        color: null,
      });
      // Beside the arc's middle, so the chip never covers the knob being dragged.
      out.chips.push({ ...chip, at: angleAt({ ...h, radius: h.radius * 1.25 }, h.value / 2) });
    } else {
      out.chips.push({ ...chip, at: h.at });
    }
  }
  void state;
  return out;
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
  if (tool?.kind === 'feature') {
    const set = featureHandles(state, draftHandles(tool.draft, state.evaluation, state.features));
    set.guides = draftGuides(tool.draft, state.evaluation, state.features);
    return set;
  }
  if (tool?.kind === 'move') return ringHandles(tool, ringColors);
  if (tool?.kind === 'extrude') return extrudeHandles(state);
  return EMPTY;
}

/**
 * Extrude extras: the second side's arrow (two sides) and the start-offset
 * chip, next to the main distance arrow the viewport draws itself.
 */
function extrudeHandles(state: AssemblerState): ToolHandleSet {
  const tool = state.activeTool;
  if (tool?.kind !== 'extrude') return EMPTY;
  const samples = profileSamples(state.evaluation, tool.profile);
  if (!samples) return EMPTY;
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
  return out;
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

/** Bodies a feature tool changes in place (accent) — re-exported for the scene model. */
export { draftModifiedBodyIds };

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
  if (handle === 'extrude2' || handle === 'extrudeStart') {
    let value = snap ? Math.round(raw / DRAG_STEP_MM) * DRAG_STEP_MM : raw;
    value = Math.round(value * 1000) / 1000;
    if (handle === 'extrude2') s.setExtrudeOptions({ distance2: Math.max(0, value) });
    else s.setExtrudeOptions({ startOffset: value === 0 ? undefined : value });
    return true;
  }
  if (!handle.startsWith('feature:')) return false;
  const tool = s.activeTool;
  if (tool?.kind !== 'feature') return true;
  const id = handle.slice('feature:'.length);
  const h = draftHandles(tool.draft, s.evaluation, s.features).find((x) => x.id === id);
  if (!h) return true;
  let value = raw;
  if (snap && h.unit === 'mm') value = Math.round(raw / DRAG_STEP_MM) * DRAG_STEP_MM;
  if (h.unit === 'count') value = Math.round(raw);
  value = Math.round(value * 1000) / 1000;
  s.updateFeatureDraft((draft) => h.apply(draft, value));
  return true;
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
