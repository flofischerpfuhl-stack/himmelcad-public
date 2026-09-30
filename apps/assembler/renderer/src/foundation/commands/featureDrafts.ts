/**
 * Per-kind tool drafts of the generic feature tool (assembler/MODULES.md §3
 * `tools`): the store runs one `feature` tool session whose references and
 * parameters are a {@link FeatureDraft}; what a draft of a kind means — how
 * it starts from the selection, what a viewport click does, the feature it
 * previews and commits, its pill prompt, option badges, drag handles and
 * guides — is registered by the module that owns the kind:
 *
 * ```ts
 * declare module '…/foundation/commands/featureDrafts.js' {
 *   interface FeatureDraftMap { offsetFace: OffsetFaceDraft }
 * }
 * registerFeatureDraft({ kind: 'offsetFace', module: 'direct-edit', create, toFeature, meta, … });
 * ```
 *
 * The store, the tool pill (`ToolSession.tsx`), the viewport and the
 * commands only call the dispatch functions below, so no core file names a
 * feature kind's tool. Pure data + functions; no store access, no DOM.
 */
import type { EvaluationResult } from '../geometry-kernel/types.js';
import type { Feature, Vec3 } from '../document/document.js';
import { referencedDatumIds } from '../document/datums.js';
import type { SelectionItem } from './store.js';

/**
 * Draft types by kind. Empty here: every module that registers a draft adds
 * its type with a `declare module` augmentation (see the file comment).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type
export interface FeatureDraftMap {}

/** Every draft kind of this build. */
export type FeatureDraftKind = keyof FeatureDraftMap & string;

/** A running feature tool's references and parameters (any registered kind). */
export type FeatureDraft = FeatureDraftMap[keyof FeatureDraftMap];

/** The draft type of one kind. */
export type FeatureDraftOf<K extends FeatureDraftKind> = FeatureDraftMap[K];

/** What a draft can be started from. */
export interface DraftContext {
  selection: readonly SelectionItem[];
  evaluation: EvaluationResult;
  features: readonly Feature[];
}

export type DraftStart<D = FeatureDraft> = { ok: true; draft: D } | { ok: false; reason: string };

/** A viewport click while a feature tool runs. */
export type ToolPick =
  | { kind: 'body'; bodyId: string }
  /**
   * `point`: where the face was clicked (world), when the viewport knows it;
   * `ray`: the pointer ray (tools that place things on their own plane, e.g. Hole).
   */
  | {
      kind: 'face';
      bodyId: string;
      faceKey: string;
      point?: Vec3;
      ray?: { origin: Vec3; direction: Vec3 };
    }
  /** `ray`: the pointer ray, when the viewport knows it (which end of the edge was clicked). */
  | { kind: 'edge'; bodyId: string; edgeKey: string; ray?: { origin: Vec3; direction: Vec3 } }
  | { kind: 'sketchProfile'; featureId: string; regionKey?: string }
  /** A straight sketch line (construction lines included): an axis or direction. */
  | { kind: 'sketchLine'; featureId: string; entityId: string }
  /** A construction plane or axis. */
  | { kind: 'datum'; featureId: string };

/** The tool pill's title, shortcut and prompt. */
export interface DraftMeta {
  label: string;
  shortcut: string;
  prompt: string;
}

/** An option badge of the tool pill. */
export interface DraftBadge {
  ariaLabel: string;
  value: string;
  options: { value: string; label: string }[];
  apply: (draft: FeatureDraft, value: string, evaluation: EvaluationResult) => FeatureDraft;
}

/** Value unit of a handle chip. */
export type HandleUnit = 'mm' | 'deg' | 'count';

export interface HandleBase {
  id: string;
  label: string;
  prefix?: string;
  unit: HandleUnit;
  value: number;
  /** Returns the draft with the new value (already validated/clamped). */
  apply: (draft: FeatureDraft, value: number) => FeatureDraft;
}

/** Arrow dragged along `dir`; the value grows by the drag distance. */
export interface LinearHandle extends HandleBase {
  kind: 'linear';
  base: Vec3;
  dir: Vec3;
  /** Drawn arrow length (mm). */
  length: number;
}

/** Arc about `axis` through `center`, from `ref` by `value` degrees; dragged around. */
export interface AngleHandle extends HandleBase {
  kind: 'angle';
  center: Vec3;
  axis: Vec3;
  ref: Vec3;
  radius: number;
}

/** A value chip without a drag handle (e.g. a pattern count). */
export interface ChipHandle extends HandleBase {
  kind: 'chip';
  at: Vec3;
}

export type DraftHandle = LinearHandle | AngleHandle | ChipHandle;

export interface DraftGuides {
  /** Axis lines (world segments). */
  lines: [Vec3, Vec3][];
  /** Planes as closed quads. */
  planes: [Vec3, Vec3, Vec3, Vec3][];
}

/** What a module registers for one draft kind. */
export interface FeatureDraftDefinition<K extends FeatureDraftKind = FeatureDraftKind> {
  kind: K;
  /** Owning module id (`apps/assembler/modules.json`), for diagnostics. */
  module: string;
  /** Starts the tool from the selection, or explains what is missing (the command's disabled reason). */
  create(ctx: DraftContext): DraftStart<FeatureDraftOf<K>>;
  /** Applies a viewport click (unchanged draft = the click did not apply). Absent: clicks do nothing. */
  acceptPick?(
    draft: FeatureDraftOf<K>,
    pick: ToolPick,
    evaluation: EvaluationResult,
    features: readonly Feature[],
  ): FeatureDraft;
  /** The feature the draft stands for, or `null` while it is incomplete. */
  toFeature(draft: FeatureDraftOf<K>, base: { id: string; name: string }): Feature | null;
  meta(draft: FeatureDraftOf<K>): DraftMeta;
  /** Option badges; `evaluation` (the edited document) lets a badge offer only what applies. */
  badges?(draft: FeatureDraftOf<K>, evaluation?: EvaluationResult): DraftBadge[];
  /** Drag handles and value chips (evaluated against the committed model). */
  handles?(
    draft: FeatureDraftOf<K>,
    evaluation: EvaluationResult,
    features: readonly Feature[],
  ): DraftHandle[];
  /** Reference geometry shown while the tool runs (axes, planes). */
  guides?(
    draft: FeatureDraftOf<K>,
    evaluation: EvaluationResult,
    features: readonly Feature[],
  ): DraftGuides;
  /** Bodies the tool modifies in place (preview accent). */
  modifiedBodyIds?(draft: FeatureDraftOf<K>): string[];
  /** Whether sketch lines are pickable while the tool runs (it takes an axis or a line). */
  picksSketchLines?(draft: FeatureDraftOf<K>): boolean;
  /** Whether the modified bodies' old place is shown as a ghost (they move: Align, Mirror in place). */
  ghostsModifiedBodies?(draft: FeatureDraftOf<K>): boolean;
  /**
   * A click on empty space (no pick) with the pointer ray, before it
   * finishes the tool: return a changed draft to consume it (Hole: a click
   * into a through hole removes that hole).
   */
  acceptEmptyClick?(
    draft: FeatureDraftOf<K>,
    ray: { origin: Vec3; direction: Vec3 },
    evaluation: EvaluationResult,
    features: readonly Feature[],
  ): FeatureDraft;
}

const definitions = new Map<string, FeatureDraftDefinition>();

/** Registers a draft kind. A kind is registered once; a second registration throws. */
export function registerFeatureDraft<K extends FeatureDraftKind>(
  definition: FeatureDraftDefinition<K>,
): void {
  const existing = definitions.get(definition.kind);
  if (existing) {
    if (existing === (definition as unknown as FeatureDraftDefinition)) return;
    throw new Error(
      `Feature draft "${definition.kind}" is registered twice (${existing.module}, ${definition.module})`,
    );
  }
  definitions.set(definition.kind, definition as unknown as FeatureDraftDefinition);
}

function definitionOf(kind: string): FeatureDraftDefinition {
  const definition = definitions.get(kind);
  if (!definition) throw new Error(`No tool is registered for feature kind "${kind}"`);
  return definition;
}

/** Whether a tool is registered for `kind`. */
export function isFeatureDraftKind(kind: string): kind is FeatureDraftKind {
  return definitions.has(kind);
}

/** Starts `kind` from the selection, or explains what is missing (the command's disabled reason). */
export function createDraft(kind: FeatureDraftKind, ctx: DraftContext): DraftStart {
  if (!definitions.has(kind)) return { ok: false, reason: `The ${kind} tool is not available.` };
  return definitionOf(kind).create(ctx) as DraftStart;
}

/** Applies a viewport click to the draft (unchanged draft = the click did not apply). */
export function acceptPick(
  draft: FeatureDraft,
  pick: ToolPick,
  evaluation: EvaluationResult,
  features: readonly Feature[] = [],
): FeatureDraft {
  const accept = definitionOf(draft.kind).acceptPick;
  return accept ? accept(draft, pick, evaluation, features) : draft;
}

/** The feature a draft stands for, or `null` while it is incomplete. */
export function draftToFeature(
  draft: FeatureDraft,
  base: { id: string; name: string },
): Feature | null {
  return definitionOf(draft.kind).toFeature(draft, base);
}

export function draftMeta(draft: FeatureDraft): DraftMeta {
  return definitionOf(draft.kind).meta(draft);
}

/**
 * The running tool's option badges. `evaluation` (the document the tool
 * edits) lets a badge offer only what the picked geometry supports (Offset
 * Face modes); without it those badges are left out.
 */
export function draftBadges(draft: FeatureDraft, evaluation?: EvaluationResult): DraftBadge[] {
  return definitionOf(draft.kind).badges?.(draft, evaluation) ?? [];
}

/** Drag handles and value chips of the draft (evaluated against the committed model). */
export function draftHandles(
  draft: FeatureDraft,
  evaluation: EvaluationResult,
  features: readonly Feature[] = [],
): DraftHandle[] {
  return definitionOf(draft.kind).handles?.(draft, evaluation, features) ?? [];
}

/** Reference geometry the tool shows while it runs: the revolve/pattern axis, the mirror/split plane. */
export function draftGuides(
  draft: FeatureDraft,
  evaluation: EvaluationResult,
  features: readonly Feature[] = [],
): DraftGuides {
  return (
    definitionOf(draft.kind).guides?.(draft, evaluation, features) ?? { lines: [], planes: [] }
  );
}

/** Bodies the running tool modifies in place (shown with the preview accent). */
export function draftModifiedBodyIds(draft: FeatureDraft): string[] {
  return definitionOf(draft.kind).modifiedBodyIds?.(draft) ?? [];
}

/** Whether the running tool takes sketch lines (they become pickable in the viewport). */
export function draftPicksSketchLines(draft: FeatureDraft): boolean {
  return definitionOf(draft.kind).picksSketchLines?.(draft) ?? false;
}

/** Whether the running tool shows the old place of the bodies it modifies. */
export function draftGhostsModifiedBodies(draft: FeatureDraft): boolean {
  return definitionOf(draft.kind).ghostsModifiedBodies?.(draft) ?? false;
}

/** A click on empty space while the tool runs (unchanged draft = not consumed). */
export function draftAcceptEmptyClick(
  draft: FeatureDraft,
  ray: { origin: Vec3; direction: Vec3 },
  evaluation: EvaluationResult,
  features: readonly Feature[],
): FeatureDraft {
  const accept = definitionOf(draft.kind).acceptEmptyClick;
  return accept ? accept(draft, ray, evaluation, features) : draft;
}

/** Construction planes/axes a draft references (highlighted while the tool runs). */
export function draftDatumIds(draft: FeatureDraft): string[] {
  return referencedDatumIds(draft);
}
