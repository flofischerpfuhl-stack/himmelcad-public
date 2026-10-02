/**
 * Tool before selection (Shapr3D, modelling research §1: "Auswahl vor dem
 * Werkzeug und Werkzeug vor der Auswahl"; interaction research §7: "während
 * eines Tools zeigen oben Status und Referenz-Badges, was noch benötigt
 * wird"). A command started without (enough of) its selection opens a pick
 * session: the tool pill asks for the missing references step by step,
 * each pick becomes a reference badge (× removes it, Swap exchanges the
 * target/tool roles of a boolean), and when every required step is filled
 * the command starts exactly as if the references had been selected first.
 *
 * Pure data + reducers (no store, no registry): the store keeps the session
 * as a `pick` tool (`store.ts`), `pickSessionRunner.ts` finishes it.
 */
import type { EvaluationResult } from '../geometry-kernel/types.js';
import { baseEdgeKey, baseFaceKey } from '../geometry-kernel/naming.js';
import type { Body } from '../geometry-kernel/types.js';
import type { SelectionItem } from './store.js';

const findFace = (body: Body, key: string) =>
  body.faces.find((f) => f.key === key) ??
  body.faces.find((f) => f.aliases.includes(key)) ??
  body.faces.find((f) => baseFaceKey(f.key) === baseFaceKey(key));
const findEdge = (body: Body, key: string) =>
  body.edges.find((e) => e.key === key) ??
  body.edges.find((e) => baseEdgeKey(e.key) === baseEdgeKey(key));

/** One reference step of a pick plan. */
export interface PickStep {
  /** Badge label ("Profile", "Edges", "Target", "Tools"). */
  role: string;
  /** Prompt while this step is current. */
  prompt: string;
  min: number;
  /** `Infinity` for "one or more". */
  max: number;
  /** `null` if `item` fits this step (given the picks so far), else why not. */
  accept: (
    item: SelectionItem,
    picks: readonly SelectionItem[][],
    ctx: PickContext,
  ) => string | null;
  /**
   * What a pick becomes (a face or edge clicked for a body step stands for its body).
   * Default: the item itself.
   */
  normalize?: (item: SelectionItem) => SelectionItem | null;
}

export interface PickPlan {
  label: string;
  shortcut?: string;
  steps: PickStep[];
  /** Two steps whose picks Swap exchanges (boolean target/tools). */
  swap?: [number, number];
}

export interface PickContext {
  evaluation: EvaluationResult;
}

/** The session state kept as the `pick` tool. */
export interface PickSessionState {
  commandId: string;
  step: number;
  picks: SelectionItem[][];
  problem: string | null;
}

// ---- accept helpers -----------------------------------------------------------------------

const face = (ctx: PickContext, item: SelectionItem) => {
  if (item.kind !== 'face') return null;
  const body = ctx.evaluation.bodies.find((b) => b.id === item.bodyId);
  return body ? (findFace(body, item.faceKey) ?? null) : null;
};

const edge = (ctx: PickContext, item: SelectionItem) => {
  if (item.kind !== 'edge') return null;
  const body = ctx.evaluation.bodies.find((b) => b.id === item.bodyId);
  return body ? (findEdge(body, item.edgeKey) ?? null) : null;
};

const bodyOfItem = (item: SelectionItem): string | null =>
  item.kind === 'body' || item.kind === 'face' || item.kind === 'edge' ? item.bodyId : null;

const asBody = (item: SelectionItem): SelectionItem | null => {
  const id = bodyOfItem(item);
  return id ? { kind: 'body', bodyId: id } : null;
};

const profileOrPlanarFace: PickStep['accept'] = (item, _picks, ctx) => {
  if (item.kind === 'sketchProfile') return null;
  const f = face(ctx, item);
  if (f) return f.surface === 'plane' ? null : 'Only planar faces work as a profile.';
  return 'Click a sketch profile or a planar face.';
};

const sameBody =
  (kind: 'edge' | 'face', what: string): PickStep['accept'] =>
  (item, picks, ctx) => {
    if (item.kind !== kind) return `Click ${what}.`;
    if (kind === 'edge' && !edge(ctx, item)) return 'That edge is not evaluated.';
    if (kind === 'face' && !face(ctx, item)) return 'That face is not evaluated.';
    const first = picks.flat().find((p) => p.kind === kind);
    if (first && bodyOfItem(first) !== bodyOfItem(item)) return `All ${what} must be on one body.`;
    return null;
  };

const anyBody: PickStep['accept'] = (item) =>
  bodyOfItem(item) ? null : 'Click a body (or a face of it).';

const otherBody =
  (step: number): PickStep['accept'] =>
  (item, picks) => {
    const id = bodyOfItem(item);
    if (!id) return 'Click a body (or a face of it).';
    const taken = picks[step]?.some((p) => bodyOfItem(p) === id);
    return taken ? 'That body is already the target.' : null;
  };

const planeRef: PickStep['accept'] = (item, _picks, ctx) => {
  if (item.kind === 'datum') {
    return ctx.evaluation.datums?.find((d) => d.featureId === item.featureId)?.kind === 'plane'
      ? null
      : 'Click a construction plane, not an axis.';
  }
  const f = face(ctx, item);
  if (f) return f.surface === 'plane' ? null : 'Click a planar face or a construction plane.';
  return 'Click a planar face or a construction plane.';
};

const axisRef: PickStep['accept'] = (item, _picks, ctx) => {
  if (item.kind === 'datum') {
    return ctx.evaluation.datums?.find((d) => d.featureId === item.featureId)?.kind === 'axis'
      ? null
      : 'Click a construction axis, not a plane.';
  }
  const e = edge(ctx, item);
  if (e)
    return e.curve === 'line' || e.curve === 'circle'
      ? null
      : 'The axis must be straight or circular.';
  return 'Click a straight edge or a construction axis.';
};

/** Align references (MOD-22): planar, cylindrical, conical, spherical faces; straight or round edges. */
const alignable = (ctx: PickContext, item: SelectionItem): string | null => {
  const f = face(ctx, item);
  if (f) {
    return ['plane', 'cylinder', 'cone', 'sphere'].includes(f.surface)
      ? null
      : 'Click a planar, cylindrical, conical or spherical face.';
  }
  const e = edge(ctx, item);
  if (e)
    return e.curve === 'line' || e.curve === 'circle' ? null : 'Click a straight or round edge.';
  return 'Click a face or an edge.';
};

const profiles: PickStep = {
  role: 'Profile',
  prompt: 'Click a sketch profile or a planar face.',
  min: 1,
  max: 1,
  accept: profileOrPlanarFace,
};

const booleanPlan = (label: string, shortcut: string): PickPlan => ({
  label,
  shortcut,
  steps: [
    {
      role: 'Target',
      prompt: 'Click the target body (it is kept).',
      min: 1,
      max: 1,
      accept: anyBody,
      normalize: asBody,
    },
    {
      role: 'Tools',
      prompt: 'Click the tool bodies, then Next.',
      min: 1,
      max: Infinity,
      accept: otherBody(0),
      normalize: asBody,
    },
  ],
  swap: [0, 1],
});

/**
 * Pick plans of the commands that can start before their selection: the
 * plans of the core-era commands below, plus the plans modules register
 * for their own commands ({@link registerPickPlan}).
 */
const PLANS: Record<string, PickPlan> = {
  'tools.extrude': { label: 'Extrude', shortcut: 'E', steps: [profiles] },
  'tools.filletChamfer': {
    label: 'Fillet',
    shortcut: 'F',
    steps: [
      {
        role: 'Edges',
        prompt: 'Click the edges to round, then Next.',
        min: 1,
        max: Infinity,
        accept: sameBody('edge', 'edges'),
      },
    ],
  },
  'tools.chamfer': {
    label: 'Chamfer',
    steps: [
      {
        role: 'Edges',
        prompt: 'Click the edges to bevel, then Next.',
        min: 1,
        max: Infinity,
        accept: sameBody('edge', 'edges'),
      },
    ],
  },
  'tools.shell': {
    label: 'Shell',
    shortcut: 'H',
    steps: [
      {
        role: 'Faces to open',
        prompt: 'Click the faces to open, then Next.',
        min: 1,
        max: Infinity,
        accept: sameBody('face', 'faces'),
      },
    ],
  },
  'tools.union': booleanPlan('Union', 'Ctrl+U'),
  'tools.subtract': booleanPlan('Subtract', 'Ctrl+B'),
  'tools.intersect': booleanPlan('Intersect', 'Ctrl+I'),
  'tools.revolve': {
    label: 'Revolve',
    shortcut: 'V',
    steps: [
      profiles,
      {
        role: 'Axis',
        prompt: 'Click the axis (an edge or construction axis), or Next for the default axis.',
        min: 0,
        max: 1,
        accept: axisRef,
      },
    ],
  },
  'tools.sweep': {
    label: 'Sweep',
    shortcut: 'W',
    steps: [
      profiles,
      {
        role: 'Path',
        prompt: 'Click the path edges, or Next for a straight path.',
        min: 0,
        max: Infinity,
        accept: (item) => (item.kind === 'edge' ? null : 'Click path edges.'),
      },
    ],
  },
  'tools.loft': {
    label: 'Loft',
    steps: [
      {
        role: 'Profiles',
        prompt: 'Click two or more profiles in order, then Next.',
        min: 2,
        max: Infinity,
        accept: profileOrPlanarFace,
      },
    ],
  },
  'transform.mirror': {
    label: 'Mirror',
    steps: [
      {
        role: 'Objects',
        prompt: 'Click the bodies or sketches to mirror, then Next.',
        min: 1,
        max: Infinity,
        accept: (item) =>
          item.kind === 'body' || item.kind === 'sketchProfile'
            ? null
            : 'Click a body (double-click) or a sketch.',
        normalize: (item) =>
          item.kind === 'face' || item.kind === 'edge'
            ? { kind: 'body', bodyId: item.bodyId }
            : item,
      },
      {
        role: 'Plane',
        prompt: 'Click the mirror plane (a planar face or construction plane), or Next for YZ.',
        min: 0,
        max: 1,
        accept: planeRef,
      },
    ],
  },
  'transform.pattern': {
    label: 'Pattern',
    steps: [
      {
        role: 'Bodies',
        prompt: 'Click the bodies to pattern, then Next.',
        min: 1,
        max: Infinity,
        accept: anyBody,
        normalize: asBody,
      },
      {
        role: 'Direction',
        prompt: 'Click a direction or axis (edge or construction axis), or Next for X.',
        min: 0,
        max: 1,
        accept: axisRef,
      },
    ],
  },
  'tools.split': {
    label: 'Split Body',
    steps: [
      {
        role: 'Body',
        prompt: 'Click the body to split.',
        min: 1,
        max: 1,
        accept: anyBody,
        normalize: asBody,
      },
      {
        role: 'Plane',
        prompt: 'Click the splitting plane (a planar face or construction plane), or Next.',
        min: 0,
        max: 1,
        accept: planeRef,
      },
    ],
  },
  'transform.rotateAxis': {
    label: 'Rotate Around Axis',
    steps: [
      {
        role: 'Bodies',
        prompt: 'Click the bodies to rotate, then Next.',
        min: 1,
        max: Infinity,
        accept: anyBody,
        normalize: asBody,
      },
      {
        role: 'Axis',
        prompt: 'Click the axis (an edge or construction axis), or Next for Z.',
        min: 0,
        max: 1,
        accept: axisRef,
      },
    ],
  },
  'transform.align': {
    label: 'Align',
    steps: [
      {
        role: 'Moving reference',
        prompt: 'Click a face or an edge on the body to move.',
        min: 1,
        max: 1,
        accept: (item, _p, ctx) => alignable(ctx, item),
      },
      {
        role: 'Target',
        prompt: 'Click a face or edge on the target body, or a construction plane or axis.',
        min: 1,
        max: 1,
        accept: (item, picks, ctx) => {
          if (item.kind !== 'datum') {
            const problem = alignable(ctx, item);
            if (problem) return problem;
          }
          const moving = picks[0]?.[0];
          return moving && bodyOfItem(moving) === bodyOfItem(item)
            ? 'Pick the target on another body.'
            : null;
        },
      },
    ],
  },
  'tools.offsetFace': {
    label: 'Offset Face',
    steps: [
      {
        role: 'Faces',
        prompt: 'Click the faces to offset, then Next.',
        min: 1,
        max: Infinity,
        accept: sameBody('face', 'faces'),
      },
    ],
  },
  'tools.deleteFace': {
    label: 'Delete Face',
    steps: [
      {
        role: 'Faces',
        prompt: 'Click the faces to remove, then Next.',
        min: 1,
        max: Infinity,
        accept: sameBody('face', 'faces'),
      },
    ],
  },
  'transform.moveRotate': {
    label: 'Move/Rotate',
    shortcut: 'M',
    steps: [
      {
        role: 'Object',
        prompt: 'Click a body (double-click), a face, an edge or a sketch profile to move.',
        min: 1,
        max: 1,
        accept: (item) =>
          item.kind === 'body' ||
          item.kind === 'face' ||
          item.kind === 'edge' ||
          item.kind === 'sketchProfile'
            ? null
            : 'Click a body, a face, an edge or a sketch profile.',
      },
    ],
  },
  'tools.hole': {
    label: 'Hole',
    steps: [
      {
        role: 'Face',
        prompt: 'Click the planar face to drill.',
        min: 1,
        max: 1,
        accept: (item, _p, ctx) =>
          face(ctx, item)?.surface === 'plane' ? null : 'Click a planar face.',
      },
    ],
  },
  'tools.draft': {
    label: 'Draft',
    steps: [
      {
        role: 'Faces',
        prompt: 'Click the side faces to draft, then Next.',
        min: 1,
        max: Infinity,
        accept: sameBody('face', 'faces'),
      },
    ],
  },
  'tools.thicken': {
    label: 'Thicken',
    steps: [
      {
        role: 'Faces',
        prompt: 'Click the faces to thicken, then Next.',
        min: 1,
        max: Infinity,
        accept: sameBody('face', 'faces'),
      },
    ],
  },
};

/** Pick plans by command id (read-only view; modules add theirs with {@link registerPickPlan}). */
export const PICK_PLANS: Readonly<Record<string, PickPlan>> = PLANS;

/** Registers the pick plan of a module's command (once per command id). */
export function registerPickPlan(commandId: string, plan: PickPlan): void {
  const known = PLANS[commandId];
  if (known && known !== plan) throw new Error(`Pick plan of "${commandId}" is registered twice`);
  PLANS[commandId] = plan;
}

/** Accept rule of a body step: a body, or a face or edge standing for its body. */
export const acceptAnyBody: PickStep['accept'] = anyBody;
/** Normalizes a face or edge pick to its body. */
export const normalizeToBody: NonNullable<PickStep['normalize']> = asBody;

// ---- reducers ---------------------------------------------------------------------------

/** A new session for `commandId`, prefilled from the fitting part of `selection`. */
export function startSession(
  commandId: string,
  selection: readonly SelectionItem[],
  ctx: PickContext,
): PickSessionState | null {
  const plan = PICK_PLANS[commandId];
  if (!plan) return null;
  let session: PickSessionState = {
    commandId,
    step: 0,
    picks: plan.steps.map(() => []),
    problem: null,
  };
  for (const item of selection) {
    const next = addPick(session, item, ctx);
    if (next.problem === null) session = next;
  }
  return { ...session, problem: null };
}

/**
 * Whether `commandId` can start a pick session from `selection`: it has a
 * plan and every selected item fits one of its steps (an empty selection
 * always fits — the tool asks for everything).
 */
export function canStartPickSession(
  commandId: string,
  selection: readonly SelectionItem[],
  ctx: PickContext,
): boolean {
  const session = startSession(commandId, selection, ctx);
  if (!session) return false;
  return sessionSelection(session).length === selection.length;
}

function sameItem(a: SelectionItem, b: SelectionItem): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Applies a click: toggles the item in the current step (a second click on a
 * badge's geometry removes it) and moves on once a single-pick step is
 * filled. A click that does not fit the current step but fits a later one
 * goes there (the user may click "ahead").
 */
export function addPick(
  session: PickSessionState,
  raw: SelectionItem,
  ctx: PickContext,
): PickSessionState {
  const plan = PICK_PLANS[session.commandId];
  if (!plan) return session;
  const tryStep = (index: number): PickSessionState | string => {
    const step = plan.steps[index]!;
    const item = step.normalize ? step.normalize(raw) : raw;
    if (!item) return step.prompt;
    const current = session.picks[index]!;
    const present = current.findIndex((p) => sameItem(p, item));
    if (present >= 0) {
      const picks = session.picks.map((list, i) =>
        i === index ? list.filter((_, j) => j !== present) : list,
      );
      return { ...session, step: index, picks, problem: null };
    }
    const reason = step.accept(item, session.picks, ctx);
    if (reason) return reason;
    const list = step.max === 1 ? [item] : [...current, item];
    if (list.length > step.max) return `At most ${step.max} for ${step.role}.`;
    const picks = session.picks.map((l, i) => (i === index ? list : l));
    const filledSingle = step.max === 1 && list.length === 1;
    return {
      ...session,
      picks,
      step: filledSingle ? Math.min(index + 1, plan.steps.length) : index,
      problem: null,
    };
  };
  const first = tryStep(Math.min(session.step, plan.steps.length - 1));
  if (typeof first !== 'string') return first;
  for (let i = session.step + 1; i < plan.steps.length; i += 1) {
    // Earlier required steps must be complete before jumping ahead.
    if (plan.steps.slice(0, i).some((s, k) => session.picks[k]!.length < s.min)) break;
    const later = tryStep(i);
    if (typeof later !== 'string') return later;
  }
  return { ...session, problem: first };
}

export function removePick(
  session: PickSessionState,
  step: number,
  index: number,
): PickSessionState {
  const picks = session.picks.map((list, i) =>
    i === step ? list.filter((_, j) => j !== index) : list,
  );
  return { ...session, picks, step: Math.min(session.step, step), problem: null };
}

export function swapPicks(session: PickSessionState): PickSessionState {
  const plan = PICK_PLANS[session.commandId];
  if (!plan?.swap) return session;
  const [a, b] = plan.swap;
  const picksA = session.picks[a]!;
  const picksB = session.picks[b]!;
  if (picksB.length === 0) return session;
  // One target: the first tool becomes the target, the old target a tool.
  const nextA = picksB.slice(0, plan.steps[a]!.max === 1 ? 1 : picksB.length);
  const nextB = [...picksA, ...picksB.slice(nextA.length)];
  const picks = session.picks.map((list, i) => (i === a ? nextA : i === b ? nextB : list));
  return { ...session, picks, problem: null };
}

/** The first step still below its minimum, or `null` when every step is satisfied. */
export function missingStep(session: PickSessionState): number | null {
  const plan = PICK_PLANS[session.commandId];
  if (!plan) return null;
  const index = plan.steps.findIndex((s, i) => session.picks[i]!.length < s.min);
  return index >= 0 ? index : null;
}

/** "Next": moves past the current step if it is satisfied; `done` when nothing is left. */
export function nextStep(session: PickSessionState): { session: PickSessionState; done: boolean } {
  const plan = PICK_PLANS[session.commandId];
  if (!plan) return { session, done: false };
  const current = plan.steps[session.step];
  if (current && session.picks[session.step]!.length < current.min) {
    return { session: { ...session, problem: current.prompt }, done: false };
  }
  const missing = missingStep(session);
  if (missing !== null && missing > session.step) {
    return { session: { ...session, step: missing, problem: null }, done: false };
  }
  if (missing !== null) return { session: { ...session, step: missing }, done: false };
  if (session.step + 1 < plan.steps.length) {
    return { session: { ...session, step: session.step + 1, problem: null }, done: false };
  }
  return { session, done: true };
}

/** `true` once every required step is filled and the last step is reached (auto-finish). */
export function readyToFinish(session: PickSessionState): boolean {
  const plan = PICK_PLANS[session.commandId];
  return !!plan && missingStep(session) === null && session.step >= plan.steps.length;
}

/** The selection the command starts from: every pick in step order. */
export function sessionSelection(session: PickSessionState): SelectionItem[] {
  return session.picks.flat();
}
