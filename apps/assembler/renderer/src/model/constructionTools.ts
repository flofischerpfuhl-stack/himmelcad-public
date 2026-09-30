/**
 * Construct tools (Shapr3D "Construct" menu, modelling research §2): the
 * construction plane and axis steps of `construction.ts` as feature-tool
 * drafts. A draft starts with whatever the selection offers and asks for
 * the rest step by step (the pill prompt names the missing reference), so
 * a Construct tool works before or after the selection. Pure (no store),
 * delegated to by `featureTools.ts`.
 */
import { baseEdgeKey, baseFaceKey, edgeSignatureOf, faceSignatureOf } from '../kernel/naming.js';
import type { Body, EvaluationResult } from '../kernel/types.js';
import {
  AXIS_DEF_LABEL,
  PLANE_DEF_LABEL,
  constructionAxisLine,
  datumRef,
  planeRefFrame,
  planeRefPlane,
  type ConstructionAxisDef,
  type ConstructionPlaneDef,
  type PointRef,
} from './construction.js';
import {
  frameForFace,
  frameForPlane,
  type EdgeRef,
  type FaceRef,
  type Feature,
  type Plane,
  type Vec3,
} from './document.js';
import { worldAxisVector, type AxisRef, type PlaneRef, type WorldAxis } from './features.js';
import type { SelectionItem } from './store.js';

export type PlaneMode = ConstructionPlaneDef['kind'];
export type AxisMode = ConstructionAxisDef['kind'];

export type ConstructionDraft =
  | {
      kind: 'constructionPlane';
      mode: PlaneMode;
      base: PlaneRef | null;
      axis: AxisRef | null;
      points: PointRef[];
      a: PlaneRef | null;
      b: PlaneRef | null;
      face: FaceRef | null;
      distance: number;
      angle: number;
      flip: boolean;
    }
  | {
      kind: 'constructionAxis';
      mode: AxisMode;
      edge: EdgeRef | null;
      points: PointRef[];
      face: FaceRef | null;
      a: PlaneRef | null;
      b: PlaneRef | null;
      flip: boolean;
    };

export function isConstructionDraftKind(kind: string): kind is ConstructionDraft['kind'] {
  return kind === 'constructionPlane' || kind === 'constructionAxis';
}

export const DEFAULT_PLANE_OFFSET_MM = 10;
export const DEFAULT_PLANE_ANGLE = 45;

/** A pick while the tool runs (the feature tools' `ToolPick`, structurally). */
export type ConstructionPick =
  | { kind: 'body'; bodyId: string }
  | {
      kind: 'face';
      bodyId: string;
      faceKey: string;
      point?: Vec3;
      ray?: { origin: Vec3; direction: Vec3 };
    }
  | { kind: 'edge'; bodyId: string; edgeKey: string; ray?: { origin: Vec3; direction: Vec3 } }
  | { kind: 'sketchProfile'; featureId: string; regionKey?: string }
  | { kind: 'sketchLine'; featureId: string; entityId: string }
  | { kind: 'datum'; featureId: string };

// ---- references ---------------------------------------------------------------------------

function bodyOf(evaluation: EvaluationResult, id: string): Body | undefined {
  return evaluation.bodies.find((b) => b.id === id);
}

function faceRefOf(evaluation: EvaluationResult, bodyId: string, key: string): FaceRef | null {
  const body = bodyOf(evaluation, bodyId);
  const face =
    body?.faces.find((f) => f.key === key) ??
    body?.faces.find((f) => f.aliases.includes(key)) ??
    body?.faces.find((f) => baseFaceKey(f.key) === baseFaceKey(key));
  return face ? { bodyId, key: face.key, signature: faceSignatureOf(face) } : null;
}

function edgeRefOf(evaluation: EvaluationResult, bodyId: string, key: string): EdgeRef | null {
  const body = bodyOf(evaluation, bodyId);
  const edge =
    body?.edges.find((e) => e.key === key) ??
    body?.edges.find((e) => baseEdgeKey(e.key) === baseEdgeKey(key));
  return edge ? { bodyId, key: edge.key, signature: edgeSignatureOf(edge) } : null;
}

function planarFaceRef(evaluation: EvaluationResult, pick: ConstructionPick): PlaneRef | null {
  if (pick.kind === 'face') {
    const ref = faceRefOf(evaluation, pick.bodyId, pick.faceKey);
    return ref?.signature.normal ? { kind: 'face', face: ref } : null;
  }
  if (pick.kind === 'datum') {
    const ref = datumRef(evaluation, pick.featureId);
    return ref && 'frame' in ref ? ref : null;
  }
  return null;
}

function axisRefOf(evaluation: EvaluationResult, pick: ConstructionPick): AxisRef | null {
  if (pick.kind === 'edge') {
    const ref = edgeRefOf(evaluation, pick.bodyId, pick.edgeKey);
    return ref && (ref.signature.curve === 'line' || ref.signature.curve === 'circle')
      ? { kind: 'edge', edge: ref }
      : null;
  }
  if (pick.kind === 'datum') {
    const ref = datumRef(evaluation, pick.featureId);
    return ref && 'line' in ref ? ref : null;
  }
  if (pick.kind === 'sketchLine') {
    return { kind: 'sketchLine', featureId: pick.featureId, entityId: pick.entityId };
  }
  return null;
}

/** Distance of `p` from the ray (for "which end of the edge was clicked"). */
function rayDistance(ray: { origin: Vec3; direction: Vec3 }, p: Vec3): number {
  const d = normalize(ray.direction);
  const rel = sub(p, ray.origin);
  const along = dot(rel, d);
  return Math.hypot(...sub(rel, scale(d, along)));
}

/** A point from an edge pick: a circle's centre, else the end nearest the pointer (else the midpoint). */
function pointRefOf(evaluation: EvaluationResult, pick: ConstructionPick): PointRef | null {
  if (pick.kind !== 'edge') return null;
  const ref = edgeRefOf(evaluation, pick.bodyId, pick.edgeKey);
  if (!ref) return null;
  if (ref.signature.curve === 'circle') return { kind: 'circleCenter', edge: ref };
  const body = bodyOf(evaluation, pick.bodyId);
  const edge = body?.edges.find((e) => e.key === ref.key);
  const s = edge?.segments;
  if (!pick.ray || !s || s.length < 6) return { kind: 'edgeMid', edge: ref };
  const first: Vec3 = [s[0]!, s[1]!, s[2]!];
  const last: Vec3 = [s[s.length - 3]!, s[s.length - 2]!, s[s.length - 1]!];
  const mid = ref.signature.midpoint;
  const candidates: { near: Vec3 | null; d: number }[] = [
    { near: first, d: rayDistance(pick.ray, first) },
    { near: last, d: rayDistance(pick.ray, last) },
    { near: null, d: rayDistance(pick.ray, mid) },
  ];
  candidates.sort((x, y) => x.d - y.d);
  const best = candidates[0]!;
  return best.near
    ? { kind: 'edgeEnd', edge: ref, near: best.near }
    : { kind: 'edgeMid', edge: ref };
}

function cylinderFaceRef(evaluation: EvaluationResult, pick: ConstructionPick): FaceRef | null {
  if (pick.kind !== 'face') return null;
  const ref = faceRefOf(evaluation, pick.bodyId, pick.faceKey);
  return ref?.signature.surface === 'cylinder' ? ref : null;
}

/**
 * Axis (unit, sign-normalised like the kernel's `cylinderId`), centre and
 * radius of a cylindrical face, from its circular boundary edges.
 */
export function cylinderOf(
  evaluation: EvaluationResult,
  ref: FaceRef,
): { axis: Vec3; center: Vec3; radius: number } | null {
  const body = bodyOf(evaluation, ref.bodyId);
  const face = body?.faces.find((f) => f.key === ref.key || f.aliases.includes(ref.key));
  if (!body || !face) return null;
  for (const e of face.edgeIndices) {
    const edge = body.edges[e];
    if (!edge || edge.curve !== 'circle' || edge.segments.length < 18) continue;
    const s = edge.segments;
    const n = s.length / 3;
    const p = (i: number): Vec3 => [s[i * 3]!, s[i * 3 + 1]!, s[i * 3 + 2]!];
    const a = p(0);
    const b = p(Math.floor(n / 3));
    const c = p(Math.floor((2 * n) / 3));
    const normal = cross(sub(b, a), sub(c, a));
    if (Math.hypot(...normal) < 1e-12) continue;
    let axis = normalize(normal);
    const lead = Math.abs(axis[0]) > 1e-9 ? axis[0] : Math.abs(axis[1]) > 1e-9 ? axis[1] : axis[2];
    if (lead < 0) axis = scale(axis, -1);
    const center = circleCenter(a, b, c);
    if (!center) continue;
    return { axis, center, radius: Math.hypot(...sub(a, center)) };
  }
  return null;
}

/** Angle (degrees) of `point` around the cylinder, measured like the kernel's `radialAt`. */
function angleAround(cyl: { axis: Vec3; center: Vec3 }, point: Vec3): number {
  const frame = frameForFace(cyl.axis, [0, 0, 0]);
  const rel = sub(point, cyl.center);
  const deg = (Math.atan2(dot(rel, frame.v), dot(rel, frame.u)) * 180) / Math.PI;
  return Math.round(deg * 10) / 10;
}

// ---- start ----------------------------------------------------------------------------------

function selectionPicks(selection: readonly SelectionItem[]): ConstructionPick[] {
  return selection.filter(
    (s): s is Exclude<SelectionItem, { kind: 'feature' } | { kind: 'mesh' }> =>
      s.kind !== 'feature' && s.kind !== 'mesh',
  );
}

export function emptyPlaneDraft(
  mode: PlaneMode,
): Extract<ConstructionDraft, { kind: 'constructionPlane' }> {
  return {
    kind: 'constructionPlane',
    mode,
    base: null,
    axis: null,
    points: [],
    a: null,
    b: null,
    face: null,
    distance: DEFAULT_PLANE_OFFSET_MM,
    angle: mode === 'tangent' ? 0 : DEFAULT_PLANE_ANGLE,
    flip: false,
  };
}

export function emptyAxisDraft(
  mode: AxisMode,
): Extract<ConstructionDraft, { kind: 'constructionAxis' }> {
  return {
    kind: 'constructionAxis',
    mode,
    edge: null,
    points: [],
    face: null,
    a: null,
    b: null,
    flip: false,
  };
}

/** A Construct tool in `mode`, prefilled from the selection (it always starts). */
export function createConstructionDraft(
  kind: ConstructionDraft['kind'],
  mode: PlaneMode | AxisMode,
  selection: readonly SelectionItem[],
  evaluation: EvaluationResult,
): ConstructionDraft {
  let draft: ConstructionDraft =
    kind === 'constructionPlane'
      ? emptyPlaneDraft(mode as PlaneMode)
      : emptyAxisDraft(mode as AxisMode);
  for (const pick of selectionPicks(selection)) {
    draft = acceptConstructionPick(draft, pick, evaluation);
  }
  return draft;
}

// ---- picks -------------------------------------------------------------------------------------

export function acceptConstructionPick(
  draft: ConstructionDraft,
  pick: ConstructionPick,
  evaluation: EvaluationResult,
): ConstructionDraft {
  if (draft.kind === 'constructionPlane') {
    switch (draft.mode) {
      case 'offset': {
        const base = planarFaceRef(evaluation, pick);
        return base ? { ...draft, base } : draft;
      }
      case 'angle': {
        const axis = axisRefOf(evaluation, pick);
        if (axis && pick.kind !== 'datum') return { ...draft, axis };
        if (axis) return { ...draft, axis };
        const base = planarFaceRef(evaluation, pick);
        return base ? { ...draft, base } : draft;
      }
      case 'threePoints': {
        const point = pointRefOf(evaluation, pick);
        if (!point) return draft;
        const points = [...draft.points, point].slice(-3);
        return { ...draft, points };
      }
      case 'midplane': {
        const plane = planarFaceRef(evaluation, pick);
        if (!plane) return draft;
        if (!draft.a) return { ...draft, a: plane };
        if (!draft.b) return { ...draft, b: plane };
        return { ...draft, a: draft.b, b: plane };
      }
      case 'tangent': {
        const face = cylinderFaceRef(evaluation, pick);
        if (!face) return draft;
        const cyl = cylinderOf(evaluation, face);
        const angle =
          cyl && pick.kind === 'face' && pick.point ? angleAround(cyl, pick.point) : draft.angle;
        return { ...draft, face, angle };
      }
    }
  }
  switch (draft.mode) {
    case 'edge': {
      if (pick.kind !== 'edge') return draft;
      const edge = edgeRefOf(evaluation, pick.bodyId, pick.edgeKey);
      return edge && (edge.signature.curve === 'line' || edge.signature.curve === 'circle')
        ? { ...draft, edge }
        : draft;
    }
    case 'twoPoints': {
      const point = pointRefOf(evaluation, pick);
      if (!point) return draft;
      return { ...draft, points: [...draft.points, point].slice(-2) };
    }
    case 'cylinder': {
      const face = cylinderFaceRef(evaluation, pick);
      return face ? { ...draft, face } : draft;
    }
    case 'planes': {
      const plane = planarFaceRef(evaluation, pick);
      if (!plane) return draft;
      if (!draft.a) return { ...draft, a: plane };
      if (!draft.b) return { ...draft, b: plane };
      return { ...draft, a: draft.b, b: plane };
    }
  }
}

// ---- feature ----------------------------------------------------------------------------------

export function constructionDraftToFeature(
  draft: ConstructionDraft,
  base: { id: string; name: string },
): Feature | null {
  const common = { id: base.id, name: base.name, suppressed: false };
  const flip = draft.flip ? { flip: true } : {};
  if (draft.kind === 'constructionPlane') {
    let definition: ConstructionPlaneDef | null = null;
    switch (draft.mode) {
      case 'offset':
        definition = draft.base
          ? { kind: 'offset', base: draft.base, distance: draft.distance }
          : null;
        break;
      case 'angle':
        definition =
          draft.base && draft.axis
            ? { kind: 'angle', base: draft.base, axis: draft.axis, angle: draft.angle }
            : null;
        break;
      case 'threePoints':
        definition =
          draft.points.length === 3 ? { kind: 'threePoints', points: draft.points } : null;
        break;
      case 'midplane':
        definition = draft.a && draft.b ? { kind: 'midplane', a: draft.a, b: draft.b } : null;
        break;
      case 'tangent':
        definition = draft.face ? { kind: 'tangent', face: draft.face, angle: draft.angle } : null;
        break;
    }
    return definition ? { ...common, kind: 'constructionPlane', definition, ...flip } : null;
  }
  let definition: ConstructionAxisDef | null = null;
  switch (draft.mode) {
    case 'edge':
      definition = draft.edge ? { kind: 'edge', edge: draft.edge } : null;
      break;
    case 'twoPoints':
      definition =
        draft.points.length === 2
          ? { kind: 'twoPoints', a: draft.points[0]!, b: draft.points[1]! }
          : null;
      break;
    case 'cylinder':
      definition = draft.face ? { kind: 'cylinder', face: draft.face } : null;
      break;
    case 'planes':
      definition = draft.a && draft.b ? { kind: 'planes', a: draft.a, b: draft.b } : null;
      break;
  }
  return definition ? { ...common, kind: 'constructionAxis', definition, ...flip } : null;
}

// ---- pill ---------------------------------------------------------------------------------------

export function constructionDraftMeta(draft: ConstructionDraft): {
  label: string;
  shortcut: string;
  prompt: string;
} {
  if (draft.kind === 'constructionPlane') {
    const label = `Plane · ${PLANE_DEF_LABEL[draft.mode]}`;
    switch (draft.mode) {
      case 'offset':
        return {
          label,
          shortcut: '',
          prompt: draft.base
            ? 'Drag the arrow or type the offset; click another face or plane to change the base.'
            : 'Click a planar face or a construction plane (or pick XY/XZ/YZ) to offset from.',
        };
      case 'angle':
        return {
          label,
          shortcut: '',
          prompt: !draft.base
            ? 'Click the reference plane or planar face (or pick XY/XZ/YZ).'
            : !draft.axis
              ? 'Click the edge or axis the plane turns about (it must lie parallel to the reference).'
              : 'Drag the arc or type the angle.',
        };
      case 'threePoints':
        return {
          label,
          shortcut: '',
          prompt:
            draft.points.length < 3
              ? `Click point ${draft.points.length + 1} of 3: a vertex (near an edge end), an edge midpoint or a circle centre.`
              : 'Plane through three points. Click points again to replace the oldest.',
        };
      case 'midplane':
        return {
          label,
          shortcut: '',
          prompt: !draft.a
            ? 'Click the first of two parallel faces or planes.'
            : !draft.b
              ? 'Click the second parallel face or plane.'
              : 'Midplane between the two. Click faces to change them.',
        };
      case 'tangent':
        return {
          label,
          shortcut: '',
          prompt: draft.face
            ? 'Drag the arc or type the angle around the cylinder; click the face where the plane should touch.'
            : 'Click a cylindrical face (where the plane should touch it).',
        };
    }
  }
  const label = `Axis · ${AXIS_DEF_LABEL[draft.mode]}`;
  switch (draft.mode) {
    case 'edge':
      return {
        label,
        shortcut: '',
        prompt: draft.edge
          ? 'Axis along the edge. Click another edge to change it.'
          : 'Click a straight or circular edge.',
      };
    case 'twoPoints':
      return {
        label,
        shortcut: '',
        prompt:
          draft.points.length < 2
            ? `Click point ${draft.points.length + 1} of 2: a vertex (near an edge end), an edge midpoint or a circle centre.`
            : 'Axis through two points. Click points again to replace the oldest.',
      };
    case 'cylinder':
      return {
        label,
        shortcut: '',
        prompt: draft.face
          ? 'The cylinder axis. Click another cylindrical face to change it.'
          : 'Click a cylindrical face (a hole or a shaft).',
      };
    case 'planes':
      return {
        label,
        shortcut: '',
        prompt: !draft.a
          ? 'Click the first plane or planar face (or pick a world plane).'
          : !draft.b
            ? 'Click the second plane or planar face (not parallel to the first).'
            : 'Axis where the two planes meet.',
      };
  }
}

export interface ConstructionBadge {
  ariaLabel: string;
  value: string;
  options: { value: string; label: string }[];
  apply: (
    draft: ConstructionDraft,
    value: string,
    evaluation: EvaluationResult,
  ) => ConstructionDraft;
}

const worldPlaneOptions = (current: PlaneRef | null) => [
  { value: 'XY', label: 'XY' },
  { value: 'XZ', label: 'XZ' },
  { value: 'YZ', label: 'YZ' },
  ...(current && current.kind !== 'plane'
    ? [{ value: 'ref', label: current.kind === 'face' ? 'Face' : 'Plane' }]
    : []),
];

const worldPlane = (value: string): PlaneRef | null =>
  value === 'XY' || value === 'XZ' || value === 'YZ'
    ? { kind: 'plane', plane: value as Plane, offset: 0 }
    : null;

export function constructionDraftBadges(draft: ConstructionDraft): ConstructionBadge[] {
  const flip: ConstructionBadge = {
    ariaLabel: 'Direction',
    value: draft.flip ? 'flipped' : 'normal',
    options: [
      { value: 'normal', label: 'Normal' },
      { value: 'flipped', label: 'Flipped' },
    ],
    apply: (d, v) => ({ ...d, flip: v === 'flipped' }),
  };
  if (draft.kind === 'constructionPlane') {
    const badges: ConstructionBadge[] = [
      {
        ariaLabel: 'Plane type',
        value: draft.mode,
        options: (Object.keys(PLANE_DEF_LABEL) as PlaneMode[]).map((m) => ({
          value: m,
          label: PLANE_DEF_LABEL[m],
        })),
        apply: (d, v) =>
          d.kind === 'constructionPlane' && d.mode !== v
            ? { ...emptyPlaneDraft(v as PlaneMode), base: d.base, flip: d.flip }
            : d,
      },
    ];
    if (draft.mode === 'offset' || draft.mode === 'angle') {
      badges.push({
        ariaLabel: 'Reference plane',
        value: draft.base?.kind === 'plane' ? draft.base.plane : draft.base ? 'ref' : '',
        options: worldPlaneOptions(draft.base),
        apply: (d, v) => {
          const base = worldPlane(v);
          return base && d.kind === 'constructionPlane' ? { ...d, base } : d;
        },
      });
    }
    if (draft.mode === 'angle') {
      badges.push({
        ariaLabel: 'Turn axis',
        value: draft.axis?.kind === 'world' ? draft.axis.axis : draft.axis ? 'ref' : '',
        options: [
          { value: 'X', label: 'X' },
          { value: 'Y', label: 'Y' },
          { value: 'Z', label: 'Z' },
          ...(draft.axis && draft.axis.kind !== 'world' ? [{ value: 'ref', label: 'Edge' }] : []),
        ],
        apply: (d, v) =>
          d.kind === 'constructionPlane' && (v === 'X' || v === 'Y' || v === 'Z')
            ? { ...d, axis: { kind: 'world', axis: v as WorldAxis } }
            : d,
      });
    }
    if (draft.mode === 'midplane') {
      badges.push({
        ariaLabel: 'First plane',
        value: draft.a?.kind === 'plane' ? draft.a.plane : draft.a ? 'ref' : '',
        options: worldPlaneOptions(draft.a),
        apply: (d, v) => {
          const a = worldPlane(v);
          return a && d.kind === 'constructionPlane' ? { ...d, a } : d;
        },
      });
    }
    badges.push(flip);
    return badges;
  }
  const badges: ConstructionBadge[] = [
    {
      ariaLabel: 'Axis type',
      value: draft.mode,
      options: (Object.keys(AXIS_DEF_LABEL) as AxisMode[]).map((m) => ({
        value: m,
        label: AXIS_DEF_LABEL[m],
      })),
      apply: (d, v) =>
        d.kind === 'constructionAxis' && d.mode !== v
          ? { ...emptyAxisDraft(v as AxisMode), flip: d.flip }
          : d,
    },
  ];
  if (draft.mode === 'planes') {
    for (const which of ['a', 'b'] as const) {
      badges.push({
        ariaLabel: which === 'a' ? 'First plane' : 'Second plane',
        value:
          draft[which]?.kind === 'plane'
            ? (draft[which] as { plane: Plane }).plane
            : draft[which]
              ? 'ref'
              : '',
        options: worldPlaneOptions(draft[which]),
        apply: (d, v) => {
          const plane = worldPlane(v);
          return plane && d.kind === 'constructionAxis' ? { ...d, [which]: plane } : d;
        },
      });
    }
  }
  badges.push(flip);
  return badges;
}

// ---- handles ---------------------------------------------------------------------------------

export type ConstructionHandle =
  | {
      kind: 'linear';
      id: string;
      label: string;
      unit: 'mm';
      value: number;
      base: Vec3;
      dir: Vec3;
      length: number;
      apply: (draft: ConstructionDraft, value: number) => ConstructionDraft;
    }
  | {
      kind: 'angle';
      id: string;
      label: string;
      unit: 'deg';
      value: number;
      center: Vec3;
      axis: Vec3;
      ref: Vec3;
      radius: number;
      apply: (draft: ConstructionDraft, value: number) => ConstructionDraft;
    };

function axisLineOf(evaluation: EvaluationResult, ref: AxisRef): { point: Vec3; dir: Vec3 } | null {
  if (ref.kind === 'world')
    return { point: ref.origin ?? [0, 0, 0], dir: worldAxisVector(ref.axis) };
  if (ref.kind === 'construction') return constructionAxisLine(ref, evaluation);
  if (ref.kind === 'edge') {
    return ref.edge.signature.direction
      ? { point: ref.edge.signature.midpoint, dir: ref.edge.signature.direction }
      : null;
  }
  const sketch = evaluation.sketches.find((s) => s.featureId === ref.featureId);
  const curve = sketch?.curves.find((c) => c.entityId === ref.entityId);
  const a = curve?.points[0];
  const b = curve?.points[curve.points.length - 1];
  return a && b ? { point: a, dir: normalize(sub(b, a)) } : null;
}

export function constructionDraftHandles(
  draft: ConstructionDraft,
  evaluation: EvaluationResult,
): ConstructionHandle[] {
  if (draft.kind !== 'constructionPlane') return [];
  if (draft.mode === 'offset' && draft.base) {
    const plane = planeRefPlane(draft.base, evaluation);
    if (!plane) return [];
    return [
      {
        kind: 'linear',
        id: 'offset',
        label: 'Plane offset',
        unit: 'mm',
        value: draft.distance,
        base: plane.point,
        dir: plane.normal,
        length: Math.max(8, Math.abs(draft.distance)),
        apply: (d, v) => (d.kind === 'constructionPlane' ? { ...d, distance: v } : d),
      },
    ];
  }
  if (draft.mode === 'angle' && draft.base && draft.axis) {
    const plane = planeRefPlane(draft.base, evaluation);
    const line = axisLineOf(evaluation, draft.axis);
    if (!plane || !line) return [];
    const ref = normalize(cross(line.dir, plane.normal));
    return [
      {
        kind: 'angle',
        id: 'angle',
        label: 'Plane angle',
        unit: 'deg',
        value: draft.angle,
        center: line.point,
        axis: line.dir,
        ref: Math.hypot(...ref) > 1e-9 ? ref : frameForFace(line.dir, [0, 0, 0]).u,
        radius: 15,
        apply: (d, v) => (d.kind === 'constructionPlane' ? { ...d, angle: v } : d),
      },
    ];
  }
  if (draft.mode === 'tangent' && draft.face) {
    const cyl = cylinderOf(evaluation, draft.face);
    if (!cyl) return [];
    const frame = frameForFace(cyl.axis, [0, 0, 0]);
    return [
      {
        kind: 'angle',
        id: 'angle',
        label: 'Angle around the cylinder',
        unit: 'deg',
        value: draft.angle,
        center: cyl.center,
        axis: cyl.axis,
        ref: frame.u,
        radius: cyl.radius * 1.3,
        apply: (d, v) => (d.kind === 'constructionPlane' ? { ...d, angle: v } : d),
      },
    ];
  }
  return [];
}

/** Guides: the picked reference planes/axes/points while the tool runs. */
export function constructionDraftGuides(
  draft: ConstructionDraft,
  evaluation: EvaluationResult,
): { lines: [Vec3, Vec3][]; planes: [Vec3, Vec3, Vec3, Vec3][] } {
  const out: { lines: [Vec3, Vec3][]; planes: [Vec3, Vec3, Vec3, Vec3][] } = {
    lines: [],
    planes: [],
  };
  const plane = (ref: PlaneRef | null) => {
    if (!ref) return;
    const frame = planeRefFrame(ref, evaluation);
    const at = planeRefPlane(ref, evaluation);
    if (!frame || !at) return;
    const c = at.point;
    const s = 15;
    const corner = (a: number, b: number): Vec3 =>
      add(c, add(scale(frame.u, a * s), scale(frame.v, b * s)));
    out.planes.push([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]);
  };
  const cross3 = (p: Vec3) => {
    for (const d of [
      [2, 0, 0],
      [0, 2, 0],
      [0, 0, 2],
    ] as Vec3[]) {
      out.lines.push([sub(p, d), add(p, d)]);
    }
  };
  if (draft.kind === 'constructionPlane') {
    if (draft.mode !== 'offset') plane(draft.base);
    plane(draft.a);
    plane(draft.b);
    if (draft.axis) {
      const line = axisLineOf(evaluation, draft.axis);
      if (line)
        out.lines.push([
          add(line.point, scale(line.dir, -30)),
          add(line.point, scale(line.dir, 30)),
        ]);
    }
  } else {
    plane(draft.a);
    plane(draft.b);
  }
  for (const p of draft.points) {
    const at = pointPosition(evaluation, p);
    if (at) cross3(at);
  }
  return out;
}

/** Approximate position of a point reference in the evaluation (guides only). */
function pointPosition(evaluation: EvaluationResult, ref: PointRef): Vec3 | null {
  if (ref.kind === 'point') return ref.point;
  if (ref.kind === 'edgeEnd') return ref.near;
  if (ref.kind === 'edgeMid') return ref.edge.signature.midpoint;
  const body = bodyOf(evaluation, ref.edge.bodyId);
  const edge = body?.edges.find((e) => e.key === ref.edge.key);
  const s = edge?.segments;
  if (!s || s.length < 18) return ref.edge.signature.midpoint;
  const n = s.length / 3;
  const p = (i: number): Vec3 => [s[i * 3]!, s[i * 3 + 1]!, s[i * 3 + 2]!];
  return (
    circleCenter(p(0), p(Math.floor(n / 3)), p(Math.floor((2 * n) / 3))) ??
    ref.edge.signature.midpoint
  );
}

/** Feature ids of construction planes/axes a draft (any feature tool) references. */
export function referencedDatumIds(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>;
      if (r.kind === 'construction' && typeof r.featureId === 'string') out.push(r.featureId);
      for (const child of Object.values(r)) visit(child);
    }
  };
  visit(value);
  return out;
}

// ---- vectors -------------------------------------------------------------------------------

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
function circleCenter(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const nn = dot(n, n);
  if (nn < 1e-12) return null;
  const term = add(scale(cross(n, ab), dot(ac, ac)), scale(cross(ac, n), dot(ab, ab)));
  return add(a, scale(term, 1 / (2 * nn)));
}

/** Frame of a world plane (re-exported for tests). */
export const worldPlaneFrame = frameForPlane;
