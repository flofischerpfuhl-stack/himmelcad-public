/**
 * The viewport side of the store's generic feature tool (Revolve, Hole,
 * Offset Face, construction planes, …): its handles, chips, guides,
 * accents and ghosts, all read from the kind's registered draft
 * (`foundation/commands/featureDrafts.ts`) — no tool is named here. Pure
 * (no React/GL), shared by the render loop, the pointer handlers and the
 * chips.
 */
import {
  draftDatumIds,
  draftGhostsModifiedBodies,
  draftGuides,
  draftHandles,
  draftModifiedBodyIds,
  draftPicksSketchLines,
  type DraftHandle,
} from '../../foundation/commands/featureDrafts.js';
import {
  PREVIEW_FEATURE_ID,
  useAssemblerStore,
  type AssemblerState,
} from '../../foundation/commands/store.js';
import type { Vec3 } from './math.js';
import type { ToolHandleKind } from './picking.js';
import {
  EMPTY_TOOL_HANDLES,
  type ToolHandleSet,
  type ToolView,
  type ToolViewInput,
} from './toolViews.js';

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

/** The draft's handles as viewport handles (arrows, arcs, chips). */
export function draftHandleSet(handles: readonly DraftHandle[]): ToolHandleSet {
  const out: ToolHandleSet = { ...EMPTY_TOOL_HANDLES, axis: [], angles: [], chips: [] };
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
        ...(h.drag ? { drag: h.drag } : {}),
        ...(h.lever !== undefined ? { lever: h.lever } : {}),
        ...(h.snapDeg !== undefined ? { snapDeg: h.snapDeg } : {}),
      });
      // Beside the arc's middle, so the chip never covers the knob being dragged.
      out.chips.push({ ...chip, at: angleAt({ ...h, radius: h.radius * 1.25 }, h.value / 2) });
    } else {
      out.chips.push({ ...chip, at: h.at });
    }
  }
  return out;
}

/** Handles and guides of the running feature tool (empty without one). */
export function featureToolHandles(state: AssemblerState): ToolHandleSet {
  const tool = state.activeTool;
  if (tool?.kind !== 'feature') return EMPTY_TOOL_HANDLES;
  const set = draftHandleSet(draftHandles(tool.draft, state.evaluation, state.features));
  set.guides = draftGuides(tool.draft, state.evaluation, state.features);
  return set;
}

/** What the viewport shows for the running feature tool. */
export function featureToolView({ state, preview }: ToolViewInput): ToolView {
  const tool = state.activeTool;
  if (tool?.kind !== 'feature') return {};
  const handles = featureToolHandles(state);
  const view: ToolView = {
    handles,
    datumIds: draftDatumIds(tool.draft),
    pickSketchLines: draftPicksSketchLines(tool.draft),
    typedValue: handles.axis.length + handles.chips.length > 0 ? { negative: true } : null,
    labels: handles.chips.map((chip, index) => ({
      key: chip.handle,
      label: chip.label,
      ...(chip.prefix ? { prefix: chip.prefix } : {}),
      unit: chip.unit,
      value: chip.value,
      at: chip.at,
      handle: chip.handle,
      invalid: tool.previewError !== null,
      takesTyping: index === 0,
    })),
  };
  if (preview) {
    const before = new Set(state.evaluation.bodies.map((b) => b.id));
    const modified = draftModifiedBodyIds(tool.draft);
    view.previewNewBodyIds = preview.bodies.filter((b) => !before.has(b.id)).map((b) => b.id);
    view.previewAccentBodyIds = modified;
    view.previewFaceKeyPrefix = `${PREVIEW_FEATURE_ID}:`;
    if (draftGhostsModifiedBodies(tool.draft)) {
      view.ghostBodies = state.evaluation.bodies.filter((b) => modified.includes(b.id));
    }
  }
  return view;
}

/**
 * Writes a dragged or typed value of a feature-tool handle (`feature:<id>`).
 * `snap` applies the drag step (0.1 mm, whole counts). `false` for other handles.
 */
export function applyFeatureHandleValue(
  handle: ToolHandleKind,
  raw: number,
  snap: boolean,
): boolean {
  if (!handle.startsWith('feature:')) return false;
  const s = useAssemblerStore.getState();
  if (!Number.isFinite(raw)) return true;
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

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
