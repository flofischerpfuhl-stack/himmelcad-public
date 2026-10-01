/**
 * The Scale and Translate tools (Shapr3D Transform › Scale / Translate;
 * GAP-INVENTORY MOD-19, MOD-18, UI-17) as drafts of the generic feature
 * tool (`foundation/commands/draftTools.ts`, registered in `drafts.ts`).
 *
 * - **Scale**: bodies, a centre (bounding-box base centre by default; a
 *   click on a face, edge or vertex moves it there), uniform or per world
 *   axis, Scale or Copy. Arrows give the scaled size in mm (type a target
 *   size); a chip gives the factor.
 * - **Translate**: point to point with a Next step between the targets and
 *   the points (Bodies › Start point › End point); clicks on faces/edges
 *   snap to vertices, midpoints, centres (`pointSnap.ts`); Move or Copy;
 *   chips edit the resulting move per axis.
 *
 * Pure data + functions; no store access, no DOM.
 */
import type { Feature, Vec3 } from '../../foundation/document/document.js';
import {
  defineDraftTool,
  type DraftPick,
  type DraftToolBadge,
  type DraftToolContext,
  type DraftToolHandle,
  type DraftToolStart,
} from '../../foundation/commands/draftTools.js';
import type { SelectionItem } from '../../foundation/commands/store.js';
import type { Body, EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import { MAX_SCALE_FACTOR, MIN_SCALE_FACTOR } from './features.js';
import { snapPickPoint } from './pointSnap.js';

export interface ScaleDraft {
  kind: 'scale';
  bodyIds: string[];
  factor: number;
  /** Per-axis factors (world X, Y, Z); absent: uniform. */
  factors?: Vec3;
  center: Vec3;
  copy: boolean;
}

export interface TranslateDraft {
  kind: 'translate';
  bodyIds: string[];
  from: Vec3 | null;
  to: Vec3 | null;
  copy: boolean;
  /** 0 bodies, 1 start point, 2 end point (clicks go to this step). */
  step: 0 | 1 | 2;
  /** What the last point snapped to (shown in the prompt). */
  snapped?: string;
}

declare module '../../foundation/commands/draftTools.js' {
  interface DraftToolMap {
    scale: ScaleDraft;
    translate: TranslateDraft;
  }
}

type TransformDraft = ScaleDraft | TranslateDraft;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const round = (v: number) => Math.round(v * 1000) / 1000;

function bodiesOfSelection(selection: readonly SelectionItem[]): string[] {
  const ids: string[] = [];
  for (const item of selection) {
    const id =
      item.kind === 'body' || item.kind === 'face' || item.kind === 'edge' ? item.bodyId : null;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function unionBounds(bodies: readonly Body[]): { min: Vec3; max: Vec3 } | null {
  if (bodies.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i]!, b.min[i]!);
      max[i] = Math.max(max[i]!, b.max[i]!);
    }
  }
  return { min, max };
}

function boundsOf(evaluation: EvaluationResult, ids: readonly string[]) {
  return unionBounds(evaluation.bodies.filter((b) => ids.includes(b.id)));
}

/** The base centre of the bodies' box: scaling about it keeps a part standing on the plate. */
function baseCentre(evaluation: EvaluationResult, ids: readonly string[]): Vec3 {
  const box = boundsOf(evaluation, ids);
  if (!box) return [0, 0, 0];
  return [
    round((box.min[0] + box.max[0]) / 2),
    round((box.min[1] + box.max[1]) / 2),
    round(box.min[2]),
  ];
}

function toggle(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** A small 3D cross at `p` (guide lines marking a point). */
function cross3(p: Vec3, r: number): [Vec3, Vec3][] {
  return [0, 1, 2].map((i) => {
    const a = [...p] as Vec3;
    const b = [...p] as Vec3;
    a[i] = p[i]! - r;
    b[i] = p[i]! + r;
    return [a, b];
  });
}

const clampFactor = (v: number) =>
  Math.min(MAX_SCALE_FACTOR, Math.max(MIN_SCALE_FACTOR, Number.isFinite(v) ? v : 1));

// ---- Scale -------------------------------------------------------------------------------

function createScale(ctx: DraftToolContext): DraftToolStart<ScaleDraft> {
  const bodyIds = bodiesOfSelection(ctx.selection);
  if (bodyIds.length === 0) return { ok: false, reason: 'Select the bodies to scale.' };
  return {
    ok: true,
    draft: {
      kind: 'scale',
      bodyIds,
      factor: 1,
      center: baseCentre(ctx.evaluation, bodyIds),
      copy: false,
    },
  };
}

function scalePick(draft: ScaleDraft, pick: DraftPick, evaluation: EvaluationResult): ScaleDraft {
  // A body (double-click) is added or removed; a face, edge or vertex click moves the centre.
  if (pick.kind === 'body') {
    const bodyIds = toggle(draft.bodyIds, pick.bodyId);
    return bodyIds.length > 0 ? { ...draft, bodyIds } : draft;
  }
  const snapped = snapPickPoint(evaluation, pick);
  return snapped ? { ...draft, center: snapped.point.map(round) as Vec3 } : draft;
}

function scaleFactors(draft: ScaleDraft): Vec3 {
  return draft.factors ?? [draft.factor, draft.factor, draft.factor];
}

function scaleHandles(
  draft: ScaleDraft,
  evaluation: EvaluationResult,
): DraftToolHandle<ScaleDraft>[] {
  const box = boundsOf(evaluation, draft.bodyIds);
  if (!box) return [];
  const size: Vec3 = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const f = scaleFactors(draft);
  const c = draft.center;
  const axes: Vec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const sizeHandle = (i: 0 | 1 | 2): DraftToolHandle<ScaleDraft> => ({
    kind: 'linear',
    id: `size${i}`,
    label: `Scaled size ${'XYZ'[i]}`,
    prefix: 'XYZ'[i]!,
    unit: 'mm',
    value: round(size[i]! * f[i]!),
    base: c,
    dir: axes[i]!,
    // Past the scaled box on that side, so the arrow head is outside the body.
    length: Math.max(8, (box.max[i]! - c[i]!) * f[i]! + 6),
    apply: (d, value) => {
      if (d.kind !== 'scale' || !(size[i]! > 1e-9)) return d;
      const k = clampFactor(round(value / size[i]!) || f[i]!);
      if (!d.factors) return { ...d, factor: k };
      const next = [...d.factors] as Vec3;
      next[i] = k;
      return { ...d, factors: next };
    },
  });
  if (draft.factors) return [sizeHandle(0), sizeHandle(1), sizeHandle(2)];
  // Uniform: the largest size as the arrow, the factor as a chip.
  const main = (size.indexOf(Math.max(...size)) as 0 | 1 | 2) ?? 2;
  return [
    sizeHandle(main),
    {
      kind: 'chip',
      id: 'factor',
      label: 'Scale factor',
      prefix: '×',
      unit: 'ratio',
      value: draft.factor,
      at: [c[0], c[1], c[2] - 6],
      apply: (d, value) => (d.kind === 'scale' ? { ...d, factor: clampFactor(value) } : d),
    },
  ];
}

/** Which preset centre draft.center is ('' for a picked point). */
function centrePreset(draft: ScaleDraft, evaluation: EvaluationResult | undefined): string {
  const c = draft.center;
  if (c.every((v) => Math.abs(v) < 1e-9)) return 'origin';
  const box = evaluation ? boundsOf(evaluation, draft.bodyIds) : null;
  if (!box) return '';
  const mid = (i: number) => round((box.min[i]! + box.max[i]!) / 2);
  const same = (p: number[]) => p.every((v, i) => Math.abs(v - c[i]!) < 1e-6);
  if (same([mid(0), mid(1), round(box.min[2])])) return 'base';
  if (same([mid(0), mid(1), mid(2)])) return 'middle';
  return '';
}

function scaleBadges(
  draft: ScaleDraft,
  evaluation: EvaluationResult | undefined,
): DraftToolBadge<ScaleDraft>[] {
  return [
    {
      ariaLabel: 'Scaling',
      value: draft.factors ? 'axes' : 'uniform',
      options: [
        { value: 'uniform', label: 'Uniform' },
        { value: 'axes', label: 'Per axis' },
      ],
      apply: (d, value) => {
        if (value === 'axes')
          return d.factors ? d : { ...d, factors: [d.factor, d.factor, d.factor] };
        const { factors, ...rest } = d;
        return { ...rest, factor: factors?.[2] ?? d.factor };
      },
    },
    {
      ariaLabel: 'Scale centre',
      value: centrePreset(draft, evaluation),
      options: [
        { value: 'base', label: 'Base centre' },
        { value: 'middle', label: 'Box centre' },
        { value: 'origin', label: 'Origin' },
      ],
      apply: (d, value, evaluation) => {
        const box = boundsOf(evaluation, d.bodyIds);
        if (value === 'origin' || !box) return { ...d, center: [0, 0, 0] };
        const mid = (i: number) => round((box.min[i]! + box.max[i]!) / 2);
        return { ...d, center: [mid(0), mid(1), value === 'base' ? round(box.min[2]) : mid(2)] };
      },
    },
    {
      ariaLabel: 'Scale or copy',
      value: draft.copy ? 'copy' : 'move',
      options: [
        { value: 'move', label: 'Scale' },
        { value: 'copy', label: 'Copy' },
      ],
      apply: (d, value) => ({ ...d, copy: value === 'copy' }),
    },
  ];
}

export const SCALE_DRAFT_TOOL = defineDraftTool<ScaleDraft>({
  module: 'modeling',
  kinds: ['scale'],
  createDraft: (_kind, ctx) => createScale(ctx),
  acceptPick: (draft, pick, evaluation) => scalePick(draft, pick, evaluation),
  toFeature: (draft, base): Feature | null => {
    if (draft.bodyIds.length === 0) return null;
    return {
      id: base.id,
      name: base.name,
      suppressed: false,
      kind: 'scale',
      bodyIds: draft.bodyIds,
      factor: draft.factor,
      ...(draft.factors ? { factors: draft.factors } : {}),
      center: draft.center,
      copy: draft.copy,
    };
  },
  meta: (draft) => ({
    label: 'Scale',
    shortcut: '',
    prompt: `${plural(draft.bodyIds.length, 'body', 'bodies')}. Drag an arrow or type a size or factor; click a face, edge or vertex for the centre.`,
  }),
  badges: (draft, evaluation) => scaleBadges(draft, evaluation),
  handles: (draft, evaluation) => scaleHandles(draft, evaluation),
  guides: (draft) => ({ lines: cross3(draft.center, 3), planes: [] }),
  modifiedBodyIds: (draft) => (draft.copy ? [] : draft.bodyIds),
  ghostsModifiedBodies: (draft) => !draft.copy,
});

// ---- Translate -------------------------------------------------------------------------------

function createTranslate(ctx: DraftToolContext): DraftToolStart<TranslateDraft> {
  const bodyIds = bodiesOfSelection(ctx.selection);
  // Without a selection the tool asks for the bodies first (tool before selection).
  return {
    ok: true,
    draft: {
      kind: 'translate',
      bodyIds,
      from: null,
      to: null,
      copy: false,
      step: bodyIds.length > 0 ? 1 : 0,
    },
  };
}

function translatePick(
  draft: TranslateDraft,
  pick: DraftPick,
  evaluation: EvaluationResult,
): TranslateDraft {
  if (draft.step === 0) {
    const id =
      pick.kind === 'body' || pick.kind === 'face' || pick.kind === 'edge' ? pick.bodyId : null;
    return id ? { ...draft, bodyIds: toggle(draft.bodyIds, id) } : draft;
  }
  const snapped = snapPickPoint(evaluation, pick);
  if (!snapped) return draft;
  const point = snapped.point.map(round) as Vec3;
  if (draft.step === 1) return { ...draft, from: point, step: 2, snapped: snapped.snap };
  return { ...draft, to: point, snapped: snapped.snap };
}

function translateHandles(draft: TranslateDraft): DraftToolHandle<TranslateDraft>[] {
  const { from, to } = draft;
  if (!from || !to) return [];
  return ([0, 1, 2] as const).map((i) => ({
    kind: 'chip' as const,
    id: `d${i}`,
    label: `Move ${'XYZ'[i]}`,
    prefix: `Δ${'XYZ'[i]}`,
    unit: 'mm' as const,
    value: round(to[i]! - from[i]!),
    at: [to[0], to[1], to[2] + 4 + 5 * (2 - i)] as Vec3,
    apply: (d: TranslateDraft, value: number) => {
      if (d.kind !== 'translate' || !d.from || !d.to) return d;
      const next = [...d.to] as Vec3;
      next[i] = round(d.from[i]! + value);
      return { ...d, to: next };
    },
  }));
}

const TRANSLATE_STEPS = ['Bodies', 'Start point', 'End point'] as const;

export const TRANSLATE_DRAFT_TOOL = defineDraftTool<TranslateDraft>({
  module: 'modeling',
  kinds: ['translate'],
  createDraft: (_kind, ctx) => createTranslate(ctx),
  acceptPick: (draft, pick, evaluation) => translatePick(draft, pick, evaluation),
  toFeature: (draft, base): Feature | null => {
    if (draft.bodyIds.length === 0 || !draft.from || !draft.to) return null;
    return {
      id: base.id,
      name: base.name,
      suppressed: false,
      kind: 'translate',
      bodyIds: draft.bodyIds,
      from: draft.from,
      to: draft.to,
      copy: draft.copy,
    };
  },
  meta: (draft) => ({
    label: 'Translate',
    shortcut: '',
    prompt:
      draft.step === 0
        ? `Click the bodies to move (${plural(draft.bodyIds.length, 'body', 'bodies')}), then Next.`
        : draft.step === 1
          ? 'Click the start point: a vertex, an edge midpoint or centre, or a point on a face.'
          : draft.to
            ? `Moved to a ${draft.snapped ?? 'point'}. Type a value, click another end point, or Done.`
            : `Start: ${draft.snapped ?? 'point'}. Click the end point.`,
  }),
  badges: (draft) => [
    {
      ariaLabel: 'Move or copy',
      value: draft.copy ? 'copy' : 'move',
      options: [
        { value: 'move', label: 'Move' },
        { value: 'copy', label: 'Copy' },
      ],
      apply: (d, value) => ({ ...d, copy: value === 'copy' }),
    },
  ],
  handles: (draft) => translateHandles(draft),
  // The picked points as small crosses, joined by the move.
  guides: (draft) => ({
    lines: [
      ...(draft.from ? cross3(draft.from, 1.5) : []),
      ...(draft.to ? cross3(draft.to, 1.5) : []),
      ...(draft.from && draft.to ? [[draft.from, draft.to] as [Vec3, Vec3]] : []),
    ],
    planes: [],
  }),
  modifiedBodyIds: (draft) => (draft.copy ? [] : draft.bodyIds),
  ghostsModifiedBodies: (draft) => !draft.copy,
  steps: (draft) => ({
    labels: TRANSLATE_STEPS,
    current: draft.step,
    go: (d, step) => {
      const s = Math.max(0, Math.min(2, step)) as 0 | 1 | 2;
      // Points need bodies; the end point needs a start point.
      if (s > 0 && d.bodyIds.length === 0) return d;
      if (s === 2 && !d.from) return d;
      return { ...d, step: s };
    },
  }),
});

export type { TransformDraft };
