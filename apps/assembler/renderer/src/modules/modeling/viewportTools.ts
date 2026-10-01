/**
 * What the viewport shows and does for the modelling tools
 * (`platform/viewport/toolViews.ts`): Extrude's arrow and value chips,
 * the Move/Rotate gizmo (arrows, plane tiles, rings, centre), the
 * fillet/chamfer and shell arrows, the preview accents and ghosts, their
 * drags, typed values and clicks. Registered by `module.ui.tsx`.
 */
import { MIN_FEATURE_SIZE_MM } from '../../foundation/document/document.js';
import {
  findFace,
  isPreviewTool,
  makeFaceRef,
  PREVIEW_FEATURE_ID,
  useAssemblerStore,
  type AssemblerState,
} from '../../foundation/commands/store.js';
import { emptyClickFinishes } from '../../foundation/commands/toolFinish.js';
import type { Body, EvaluatedSketch } from '../../foundation/geometry-kernel/types.js';
import {
  closestPointOnLineToRay,
  rayPlaneIntersect,
  type Vec3,
} from '../../platform/viewport/math.js';
import type { PickTarget, ToolHandleKind } from '../../platform/viewport/picking.js';
import { handleTip } from '../../platform/viewport/section.js';
import type {
  ToolDrag,
  ToolLabel,
  ToolView,
  ToolViewInput,
  ViewportToolProvider,
} from '../../platform/viewport/toolViews.js';
import { WORLD_AXES, axesForPick, deltaAlong, isWorldAxes, withDeltaAlong } from './moveGizmo.js';
import { blendHandle, shellHandle } from './toolAnchors.js';
import {
  applyToolHandleValue,
  movePreviewBodies,
  pivotSnapPoint,
  toolHandleSet,
} from './toolHandles.js';
import type { ExtrudeTool, MoveTool } from './tools.js';

/** Matches `scene.ts`'s `MOVE_HANDLE_LENGTH_MM`. */
const HANDLE_LENGTH_MM = 40;
/** Drag values (fillet radius, shell thickness) snap to this step, mm. */
const HANDLE_STEP_MM = 0.1;
/** Pixel offsets probed when the gizmo centre is dragged (edges win within ~6 px). */
const PIVOT_PROBE: readonly [number, number][] = [
  [0, 0],
  ...[3, 6].flatMap((r) =>
    [0, 1, 2, 3, 4, 5, 6, 7].map((k): [number, number] => [
      Math.round(Math.cos((k * Math.PI) / 4) * r),
      Math.round(Math.sin((k * Math.PI) / 4) * r),
    ]),
  ),
];

function snap(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function previewErrorOf(state: AssemblerState): string | null {
  const tool = state.activeTool;
  return isPreviewTool(tool) ? tool.previewError : null;
}

/** Where the extrude arrow starts and points (the profile's centre on the start offset). */
export function extrudeAnchor(
  tool: ExtrudeTool,
  bodies: readonly Body[],
  sketches: readonly EvaluatedSketch[],
): { origin: Vec3; normal: Vec3 } | null {
  const { profile } = tool;
  // The arrow starts where the extrude starts (Start offset).
  const s = tool.startOffset ?? 0;
  const at = (p: Vec3, n: Vec3): Vec3 => [p[0] + n[0] * s, p[1] + n[1] * s, p[2] + n[2] * s];
  if (profile.kind === 'face') {
    const body = bodies.find((b) => b.id === profile.face.bodyId);
    const face = body ? findFace(body, profile.face.key) : undefined;
    if (!face?.normal) return null;
    return { origin: at(face.centroid, face.normal), normal: face.normal };
  }
  const sketch = sketches.find((s) => s.featureId === profile.featureId);
  if (!sketch) return null;
  const regions = profile.regions;
  const profiles = regions
    ? sketch.profiles.filter((p) => regions.includes(p.key))
    : sketch.profiles;
  if (profiles.length === 0) return null;
  const origin: [number, number, number] = [0, 0, 0];
  for (const p of profiles) {
    for (let i = 0; i < 3; i += 1) origin[i] = origin[i]! + p.center[i]! / profiles.length;
  }
  return { origin: at(origin, sketch.frame.normal), normal: sketch.frame.normal };
}

/** The gizmo centre before translation, or `null` when the moved body is gone. */
function moveAnchor(tool: MoveTool, bodies: readonly Body[]): Vec3 | null {
  if (tool.sketch) return tool.pivot;
  if (!bodies.some((b) => b.id === tool.bodyId)) return null;
  return tool.pivot;
}

/** Chips of the extra handles (second side, rings) as value labels. */
function chipLabels(state: AssemblerState): ToolLabel[] {
  return toolHandleSet(state).chips.map((chip) => ({
    key: chip.handle,
    label: chip.label,
    ...(chip.prefix ? { prefix: chip.prefix } : {}),
    unit: chip.unit,
    value: chip.value,
    at: chip.at,
    handle: chip.handle,
  }));
}

// ---- Extrude ------------------------------------------------------------------------------------

function extrudeView({ state, preview }: ToolViewInput): ToolView {
  const tool = state.activeTool;
  if (tool?.kind !== 'extrude') return {};
  const anchor = extrudeAnchor(tool, state.evaluation.bodies, state.evaluation.sketches);
  const view: ToolView = {
    handles: toolHandleSet(state),
    arrow: anchor ? { ...anchor, distance: tool.distance } : null,
    shownSketchIds: tool.profile.kind === 'sketch' ? [tool.profile.featureId] : [],
    typedValue: { negative: true },
    labels: [],
  };
  if (preview) {
    const before = new Set(state.evaluation.bodies.map((b) => b.id));
    const created = preview.bodies.find((b) => !before.has(b.id));
    view.extrudePreviewBodyId =
      created?.id ??
      (tool.profile.kind === 'face' ? tool.profile.face.bodyId : (tool.targetBodyId ?? null));
  }
  // Through All / To Object: the distance only gives the direction (no value chip).
  if (anchor && (tool.extent ?? 'distance') === 'distance') {
    view.labels!.push({
      key: 'extrude',
      label: 'Extrude distance',
      value: tool.distance,
      at: [
        anchor.origin[0] + anchor.normal[0] * tool.distance,
        anchor.origin[1] + anchor.normal[1] * tool.distance,
        anchor.origin[2] + anchor.normal[2] * tool.distance,
      ],
      invalid: tool.previewError !== null,
      takesTyping: true,
      commit: (value) => useAssemblerStore.getState().setDistance(value),
    });
  }
  view.labels!.push(...chipLabels(state));
  return view;
}

const extrudeTool: ViewportToolProvider = {
  kinds: ['extrude'],
  view: extrudeView,
  beginDrag: (pick, _pointer, state) => {
    const tool = state.activeTool;
    if (pick.kind !== 'extrudeHandle' || tool?.kind !== 'extrude') return null;
    const anchor = extrudeAnchor(tool, state.evaluation.bodies, state.evaluation.sketches);
    if (!anchor) return null;
    return {
      move: ({ ray }) => {
        if (!ray) return;
        const t = closestPointOnLineToRay(anchor.origin, anchor.normal, ray.origin, ray.direction);
        useAssemblerStore.getState().setDistance(t);
      },
    };
  },
  applyHandleValue: (handle, value, snapDrag) =>
    handle === 'extrude2' || handle === 'extrudeStart'
      ? applyToolHandleValue(handle, value, snapDrag)
      : false,
  click: ({ state, item }) => {
    const tool = state.activeTool;
    // Extrude "To Object": a clicked face (double-click: body) becomes the object.
    if (tool?.kind !== 'extrude' || tool.extent !== 'toObject') return false;
    if (item?.kind === 'face') {
      const face = makeFaceRef(state.evaluation, item.bodyId, item.faceKey);
      if (face) state.setExtrudeOptions({ extentTarget: { kind: 'face', face } });
    } else if (item?.kind === 'body') {
      state.setExtrudeOptions({ extentTarget: { kind: 'body', bodyId: item.bodyId } });
    }
    return true;
  },
};

// ---- Move/Rotate -----------------------------------------------------------------------------------

function moveView({ state }: ToolViewInput): ToolView {
  const tool = state.activeTool;
  if (tool?.kind !== 'move') return {};
  const view: ToolView = {
    bodies: (bodies) => movePreviewBodies(tool, bodies),
    handles: toolHandleSet(state),
    labels: [],
  };
  // Moving a sketch profile: its outline follows the gizmo (the commit re-evaluates it).
  const moved = tool.sketch;
  if (moved) {
    const d = tool.delta;
    const shift = (p: readonly number[]): [number, number, number] => [
      p[0]! + d.dx,
      p[1]! + d.dy,
      p[2]! + d.dz,
    ];
    view.sketches = (sketches) =>
      sketches.map((sketch) => {
        if (sketch.featureId !== moved.featureId) return sketch;
        const hit = (key: string) => moved.regionKey === undefined || key === moved.regionKey;
        return {
          ...sketch,
          profiles: sketch.profiles.map((p) =>
            hit(p.key)
              ? {
                  ...p,
                  outline: p.outline.map(shift),
                  holes: p.holes.map((h) => h.map(shift)),
                  center: shift(p.center),
                  triangles: p.triangles.map((v, i) =>
                    i % 3 === 0 ? v + d.dx : i % 3 === 1 ? v + d.dy : v + d.dz,
                  ),
                }
              : p,
          ),
          curves:
            moved.regionKey === undefined
              ? sketch.curves.map((c) => ({ ...c, points: c.points.map(shift) }))
              : sketch.curves,
        };
      });
  }
  const anchor = moveAnchor(tool, state.evaluation.bodies);
  if (anchor) {
    view.gizmo = {
      origin: anchor,
      delta: tool.delta,
      ...(tool.axes ? { axes: tool.axes } : {}),
      // A sketch profile moves in its plane: no normal arrow, one tile (the sketch plane).
      ...(tool.sketch ? { hiddenAxes: [2], tiles: [2] } : { tiles: [0, 1, 2] }),
    };
    const centre: Vec3 = [
      anchor[0] + tool.delta.dx,
      anchor[1] + tool.delta.dy,
      anchor[2] + tool.delta.dz,
    ];
    const hiddenAxes: number[] = tool.sketch ? [2] : [];
    const oriented = !isWorldAxes(tool.axes);
    for (const axis of [0, 1, 2] as const) {
      if (hiddenAxes.includes(axis)) continue;
      const unit = (tool.axes ?? WORLD_AXES)[axis]!;
      view.labels!.push({
        key: `move:${axis}`,
        label: oriented
          ? ['Axis 1 offset', 'Axis 2 offset', 'Normal offset'][axis]!
          : ['X offset', 'Y offset', 'Z offset'][axis]!,
        value: deltaAlong(tool, axis),
        at: [
          centre[0] + unit[0] * HANDLE_LENGTH_MM,
          centre[1] + unit[1] * HANDLE_LENGTH_MM,
          centre[2] + unit[2] * HANDLE_LENGTH_MM,
        ],
        commit: (value) => {
          const s = useAssemblerStore.getState();
          const current = s.activeTool;
          if (current?.kind !== 'move') return;
          const next = withDeltaAlong(current, axis, value);
          s.setDelta(next.dx, next.dy, next.dz);
        },
      });
    }
  }
  view.labels!.push(...chipLabels(state));
  return view;
}

/** Drags the gizmo centre onto geometry (edge centres/midpoints win, else the face below). */
function pivotDrag(): ToolDrag {
  return {
    hidesGizmo: true,
    move: ({ clientX, clientY, pickAt }) => {
      const store = useAssemblerStore.getState();
      const tool = store.activeTool;
      let target: PickTarget | null = null;
      for (const [ox, oy] of PIVOT_PROBE) {
        const pick = pickAt(clientX + ox, clientY + oy);
        if (pick?.kind === 'edge') {
          target = pick;
          break;
        }
        if (!target && pick?.kind === 'face') target = pick;
      }
      const point = pivotSnapPoint(target, store.evaluation.bodies);
      if (tool?.kind !== 'move' || !point) return;
      store.setPivot([
        point[0] - tool.delta.dx,
        point[1] - tool.delta.dy,
        point[2] - tool.delta.dz,
      ]);
      // Auto-orientation (Shapr3D gizmo): the gizmo takes the axes of the geometry below it.
      if (tool.autoOrient !== false && !tool.sketch) {
        const axes = axesForPick(target, store.evaluation.bodies);
        if (axes) store.setMoveAxes(axes);
      }
    },
  };
}

const moveTool: ViewportToolProvider = {
  kinds: ['move'],
  view: moveView,
  beginDrag: (pick, pointer, state) => {
    const tool = state.activeTool;
    if (pick.kind === 'toolHandle' && pick.handle === 'pivot') return pivotDrag();
    if (tool?.kind !== 'move') return null;
    const anchor = moveAnchor(tool, state.evaluation.bodies);
    if (!anchor) return null;
    const startDelta = tool.delta;
    if (pick.kind === 'moveHandle') {
      // The component along the (possibly oriented) axis follows the pointer; the rest stays.
      const unit = (tool.axes ?? WORLD_AXES)[pick.axis]!;
      return {
        move: ({ ray }) => {
          if (!ray) return;
          const t = closestPointOnLineToRay(anchor, unit, ray.origin, ray.direction);
          const d = startDelta;
          const k = t - (d.dx * unit[0] + d.dy * unit[1] + d.dz * unit[2]);
          useAssemblerStore
            .getState()
            .setDelta(d.dx + unit[0] * k, d.dy + unit[1] * k, d.dz + unit[2] * k);
        },
      };
    }
    if (pick.kind === 'moveTile') {
      // A plane tile: the move follows the pointer in the plane normal to the gizmo axis.
      const normal = (tool.axes ?? WORLD_AXES)[pick.plane]!;
      const centre: Vec3 = [
        anchor[0] + startDelta.dx,
        anchor[1] + startDelta.dy,
        anchor[2] + startDelta.dz,
      ];
      const ray = pointer.ray;
      const hit0 = ray ? rayPlaneIntersect(ray.origin, ray.direction, centre, normal) : null;
      if (!hit0) return null;
      return {
        move: ({ ray: now }) => {
          const hit = now ? rayPlaneIntersect(now.origin, now.direction, centre, normal) : null;
          if (!hit) return;
          const step = (v: number) => Math.round(v * 1000) / 1000;
          useAssemblerStore
            .getState()
            .setDelta(
              step(startDelta.dx + hit[0] - hit0[0]),
              step(startDelta.dy + hit[1] - hit0[1]),
              step(startDelta.dz + hit[2] - hit0[2]),
            );
        },
      };
    }
    return null;
  },
  applyHandleValue: (handle, value, snapDrag) =>
    handle.startsWith('ring:') ? applyToolHandleValue(handle, value, snapDrag) : false,
};

// ---- Fillet/Chamfer, Shell, Booleans --------------------------------------------------------------

function blendShellView({ state, preview }: ToolViewInput): ToolView {
  const tool = state.activeTool;
  if (tool?.kind !== 'edgeBlend' && tool?.kind !== 'shell') return {};
  const handle =
    tool.kind === 'edgeBlend'
      ? blendHandle(tool, state.evaluation.bodies)
      : shellHandle(tool, state.evaluation.bodies);
  const chamfer = tool.kind === 'edgeBlend' && tool.blend === 'chamfer';
  const handleKind: ToolHandleKind = tool.kind === 'edgeBlend' ? 'blend' : 'shell';
  return {
    handles: { axis: handle ? [handle] : [], angles: [], chips: [], guides: null, pivot: null },
    typedValue: { negative: false },
    ...(preview
      ? { previewAccentBodyIds: [tool.bodyId], previewFaceKeyPrefix: `${PREVIEW_FEATURE_ID}:` }
      : {}),
    labels: handle
      ? [
          {
            key: handleKind,
            label:
              tool.kind === 'shell'
                ? 'Wall thickness'
                : chamfer
                  ? 'Chamfer distance'
                  : 'Fillet radius',
            prefix: tool.kind === 'shell' ? 'T' : chamfer ? 'D' : 'R',
            value: handle.value,
            at: handleTip(handle),
            invalid: previewErrorOf(state) !== null,
            takesTyping: true,
            commit: (value) => applyBlendShellValue(handleKind, value),
          },
        ]
      : [],
  };
}

function applyBlendShellValue(handle: ToolHandleKind, raw: number): boolean {
  const s = useAssemblerStore.getState();
  if (handle === 'blend') {
    s.setBlendSize(Math.max(HANDLE_STEP_MM, snap(raw, HANDLE_STEP_MM)));
    return true;
  }
  if (handle === 'shell') {
    s.setShellThickness(Math.max(MIN_FEATURE_SIZE_MM, snap(raw, HANDLE_STEP_MM)));
    return true;
  }
  return false;
}

const blendShellTool: ViewportToolProvider = {
  kinds: ['edgeBlend', 'shell'],
  view: blendShellView,
  applyHandleValue: (handle, value) => applyBlendShellValue(handle, value),
  click: ({ state, pick }) => {
    const tool = state.activeTool;
    if (tool?.kind !== 'edgeBlend' && tool?.kind !== 'shell') return false;
    // Adaptive tools: clicking empty space finishes (Shapr3D; `emptyClickFinishes`,
    // shown in the tool pill); edges add/remove, faces to open are added/removed.
    if (!pick) {
      if (emptyClickFinishes(tool)) state.commit();
    } else if (pick.kind === 'edge' && tool.kind === 'edgeBlend') {
      state.toggleBlendEdge(pick.bodyId, pick.edgeKey);
    } else if (pick.kind === 'face' && tool.kind === 'shell') {
      state.toggleShellFace(pick.bodyId, pick.faceKey);
    }
    return true;
  },
};

const booleanTool: ViewportToolProvider = {
  kinds: ['boolean'],
  view: ({ state, preview }) => {
    const tool = state.activeTool;
    if (tool?.kind !== 'boolean' || !preview) return {};
    return {
      previewAccentBodyIds: [tool.targetBodyId],
      ghostBodies: state.evaluation.bodies.filter((b) => tool.toolBodyIds.includes(b.id)),
    };
  },
  click: ({ state, pick }) => {
    const tool = state.activeTool;
    if (tool?.kind !== 'boolean') return false;
    if (!pick) {
      if (emptyClickFinishes(tool)) state.commit();
    } else if (pick.kind === 'face' || pick.kind === 'edge') {
      state.toggleBooleanTool(pick.bodyId);
    }
    return true;
  },
};

/** The modelling tools' viewport providers (`defineModuleUi({ viewportTools })`). */
export const MODELING_VIEWPORT_TOOLS: readonly ViewportToolProvider[] = [
  extrudeTool,
  moveTool,
  blendShellTool,
  booleanTool,
];
