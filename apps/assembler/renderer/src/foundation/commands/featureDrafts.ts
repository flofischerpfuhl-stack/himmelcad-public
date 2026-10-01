/**
 * The generic feature tool (assembler/MODULES.md §3 `draftTools`): the
 * store runs one `feature` tool session whose references and parameters are
 * a {@link FeatureDraft}; every kind's meaning — its start from the
 * selection, clicks, the feature it previews and commits, pill prompt,
 * badges, drag handles and guides — comes from the module that registered
 * the kind's draft tool (`draftTools.ts`, `defineAssemblerModule({ draftTools })`).
 *
 * The store, the tool pill (`ToolSession.tsx`), the viewport and the
 * commands only call the dispatch functions below, so no core file names a
 * feature kind's tool. Pure data + functions; no store access, no DOM.
 */
import type { EvaluationResult } from '../geometry-kernel/types.js';
import { referencedDatumIds } from '../geometry-kernel/datums.js';
import type { Feature, Vec3 } from '../document/document.js';
import {
  draftToolFor,
  isRegisteredDraftKind,
  type DraftPick,
  type DraftTool,
  type DraftToolBadge,
  type DraftToolContext,
  type DraftToolGuides,
  type DraftToolHandle,
  type DraftToolMeta,
  type DraftToolStart,
  type RegisteredDraft,
} from './draftTools.js';

/**
 * The generic feature tool's hooks beyond the draft tool contract, which a
 * module's draft tool may add (all optional).
 */
declare module './draftTools.js' {
  interface DraftTool<D extends { kind: string } = RegisteredDraft> {
    /** Whether sketch lines are pickable while the tool runs (it takes an axis or a line). */
    picksSketchLines?(draft: D): boolean;
    /** Whether the modified bodies' old place is shown as a ghost (they move: Align, Mirror in place). */
    ghostsModifiedBodies?(draft: D): boolean;
    /**
     * A click on empty space (no pick) with the pointer ray, before it
     * finishes the tool: return a changed draft to consume it (Hole: a click
     * into a through hole removes that hole).
     */
    acceptEmptyClick?(
      draft: D,
      ray: { origin: Vec3; direction: Vec3 },
      evaluation: EvaluationResult,
      features: readonly Feature[],
    ): D;
  }
}

/** A running feature tool's references and parameters (any registered kind). */
export type FeatureDraft = RegisteredDraft;

/** Every draft kind of this build. */
export type FeatureDraftKind = RegisteredDraft['kind'];

/** A viewport click while a feature tool runs. */
export type ToolPick = DraftPick;
/** What a draft can be started from. */
export type DraftContext = DraftToolContext;
export type DraftStart<D = FeatureDraft> = DraftToolStart<D>;
/** The tool pill's title, shortcut and prompt. */
export type DraftMeta = DraftToolMeta;
/** An option badge of the tool pill. */
export type DraftBadge = DraftToolBadge<FeatureDraft>;
/** A drag handle with its value chip. */
export type DraftHandle = DraftToolHandle<FeatureDraft>;
/** The fields every handle has (id, label, unit, value, `apply`). */
export type HandleBase = Omit<Extract<DraftHandle, { kind: 'chip' }>, 'kind' | 'at'>;
/** Value unit of a handle chip. */
export type HandleUnit = DraftHandle['unit'];
export type DraftGuides = DraftToolGuides;

function toolOf(kind: string): DraftTool {
  const tool = draftToolFor(kind);
  if (!tool) throw new Error(`No draft tool is registered for "${kind}"`);
  return tool;
}

/** Only drafts of the tool that made a value (a badge, a handle) take it. */
function sameTool(tool: DraftTool, draft: FeatureDraft): boolean {
  return draftToolFor(draft.kind) === tool;
}

/** Whether a tool is registered for `kind`. */
export function isFeatureDraftKind(kind: string): kind is FeatureDraftKind {
  return isRegisteredDraftKind(kind);
}

/** Starts `kind` from the selection, or explains what is missing (the command's disabled reason). */
export function createDraft(kind: FeatureDraftKind, ctx: DraftContext): DraftStart {
  const tool = draftToolFor(kind);
  if (!tool) return { ok: false, reason: `The ${kind} tool is not available.` };
  return tool.createDraft(kind, ctx);
}

/** Applies a viewport click to the draft (unchanged draft = the click did not apply). */
export function acceptPick(
  draft: FeatureDraft,
  pick: ToolPick,
  evaluation: EvaluationResult,
  features: readonly Feature[] = [],
): FeatureDraft {
  return toolOf(draft.kind).acceptPick(draft, pick, evaluation, features);
}

/** The feature a draft stands for, or `null` while it is incomplete. */
export function draftToFeature(
  draft: FeatureDraft,
  base: { id: string; name: string },
): Feature | null {
  return toolOf(draft.kind).toFeature(draft, base);
}

export function draftMeta(draft: FeatureDraft): DraftMeta {
  return toolOf(draft.kind).meta(draft);
}

/**
 * The running tool's option badges. `evaluation` (the document the tool
 * edits) lets a badge offer only what the picked geometry supports (Offset
 * Face modes); without it those badges are left out.
 */
export function draftBadges(draft: FeatureDraft, evaluation?: EvaluationResult): DraftBadge[] {
  const tool = toolOf(draft.kind);
  return (tool.badges?.(draft, evaluation) ?? []).map((badge) => ({
    ...badge,
    apply: (d, value, evaluation) => (sameTool(tool, d) ? badge.apply(d, value, evaluation) : d),
  }));
}

/** Drag handles and value chips of the draft (evaluated against the committed model). */
export function draftHandles(
  draft: FeatureDraft,
  evaluation: EvaluationResult,
  features: readonly Feature[] = [],
): DraftHandle[] {
  const tool = toolOf(draft.kind);
  return (tool.handles?.(draft, evaluation, features) ?? []).map((h) => ({
    ...h,
    apply: (d: FeatureDraft, value: number) => (sameTool(tool, d) ? h.apply(d, value) : d),
  }));
}

/** Reference geometry the tool shows while it runs: the revolve/pattern axis, the mirror/split plane. */
export function draftGuides(
  draft: FeatureDraft,
  evaluation: EvaluationResult,
  features: readonly Feature[] = [],
): DraftGuides {
  return toolOf(draft.kind).guides?.(draft, evaluation, features) ?? { lines: [], planes: [] };
}

/** Bodies the running tool modifies in place (shown with the preview accent). */
export function draftModifiedBodyIds(draft: FeatureDraft): string[] {
  return toolOf(draft.kind).modifiedBodyIds?.(draft) ?? [];
}

/** Whether the running tool takes sketch lines (they become pickable in the viewport). */
export function draftPicksSketchLines(draft: FeatureDraft): boolean {
  return toolOf(draft.kind).picksSketchLines?.(draft) ?? false;
}

/** Whether the running tool shows the old place of the bodies it modifies. */
export function draftGhostsModifiedBodies(draft: FeatureDraft): boolean {
  return toolOf(draft.kind).ghostsModifiedBodies?.(draft) ?? false;
}

/** A click on empty space while the tool runs (unchanged draft = not consumed). */
export function draftAcceptEmptyClick(
  draft: FeatureDraft,
  ray: { origin: Vec3; direction: Vec3 },
  evaluation: EvaluationResult,
  features: readonly Feature[],
): FeatureDraft {
  const accept = toolOf(draft.kind).acceptEmptyClick;
  return accept ? accept(draft, ray, evaluation, features) : draft;
}

/** Construction planes/axes a draft references (highlighted while the tool runs). */
export function draftDatumIds(draft: FeatureDraft): string[] {
  return referencedDatumIds(draft);
}
