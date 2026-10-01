/**
 * Draft tools of the modules (assembler/MODULES.md §3 "Tools"): the
 * interactive part of a feature kind as pure data + functions, so the store
 * keeps ONE generic `feature` tool session and the viewport/chrome render
 * what the tool describes, whichever module owns the kind.
 *
 * A module that owns feature kinds with an interactive tool
 *
 * 1. adds its draft types with a module augmentation (like
 *    `FeatureKindMap`):
 *
 *    ```ts
 *    declare module '../../foundation/commands/draftTools.js' {
 *      interface DraftToolMap { constructionPlane: PlaneDraft; constructionAxis: AxisDraft }
 *    }
 *    ```
 *
 * 2. registers a {@link DraftTool} for those kinds with
 *    {@link registerDraftTool} (from its `kinds.ts`/`tools.ts`, loaded by the
 *    product composition).
 *
 * The generic feature tool (`featureTools.ts` of the modelling module)
 * delegates every draft whose kind has a registered tool: start, picks,
 * feature, pill, badges, drag handles, guides, modified bodies. The value
 * shapes below are the ones the viewport and the pill already render.
 *
 * No store access, no DOM (unit tested under `node:test`).
 */
import type { Feature, Vec3 } from '../document/document.js';
import type { EvaluationResult } from '../geometry-kernel/types.js';
import type { SelectionItem } from './store.js';

/**
 * Draft types of registered tools, by kind. Empty here: every module that
 * registers a tool adds its drafts with a `declare module` augmentation.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type
export interface DraftToolMap {}

/** A draft of any registered tool. */
export type RegisteredDraft = DraftToolMap[keyof DraftToolMap];

/** A viewport click while a tool runs (the pick kinds every tool understands). */
export type DraftPick =
  | { kind: 'body'; bodyId: string }
  /**
   * `point`: where the face was clicked (world), when the viewport knows it;
   * `ray`: the pointer ray (tools that place things on their own plane).
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

/**
 * A selection item as a tool pick: a selected sketch curve (SEL-12) is a
 * `sketchLine` pick (tools check that it is a line); steps and reference
 * meshes are no picks.
 */
export function draftPickOf(item: SelectionItem): DraftPick | null {
  if (item.kind === 'feature' || item.kind === 'mesh') return null;
  if (item.kind === 'sketchCurve') {
    return { kind: 'sketchLine', featureId: item.featureId, entityId: item.entityId };
  }
  return item;
}

/** What a draft can be started from. */
export interface DraftToolContext {
  selection: readonly SelectionItem[];
  evaluation: EvaluationResult;
  features: readonly Feature[];
}

export type DraftToolStart<D> = { ok: true; draft: D } | { ok: false; reason: string };

/** The pill: tool label, shortcut hint and the prompt naming the next missing input. */
export interface DraftToolMeta {
  label: string;
  shortcut: string;
  prompt: string;
}

/** An option badge of the pill (a small select). */
export interface DraftToolBadge<D> {
  ariaLabel: string;
  value: string;
  options: { value: string; label: string }[];
  apply: (draft: D, value: string, evaluation: EvaluationResult) => D;
}

interface DraftToolHandleBase<D> {
  id: string;
  label: string;
  prefix?: string;
  /** `count`: whole numbers; `ratio`: a plain number without a unit (a scale factor, turns). */
  unit: 'mm' | 'deg' | 'count' | 'ratio';
  value: number;
  /** Returns the draft with the new value (already validated/clamped). */
  apply: (draft: D, value: number) => D;
}

/** A drag handle with its value chip (arrow along `dir`, arc about `axis`, or a plain chip). */
export type DraftToolHandle<D> =
  | (DraftToolHandleBase<D> & { kind: 'linear'; base: Vec3; dir: Vec3; length: number })
  | (DraftToolHandleBase<D> & {
      kind: 'angle';
      center: Vec3;
      axis: Vec3;
      ref: Vec3;
      radius: number;
    })
  | (DraftToolHandleBase<D> & { kind: 'chip'; at: Vec3 });

/** Reference geometry shown while the tool runs. */
export interface DraftToolGuides {
  /** Axis lines (world segments). */
  lines: [Vec3, Vec3][];
  /** Planes as closed quads. */
  planes: [Vec3, Vec3, Vec3, Vec3][];
}

/** The interactive tool of one or more feature kinds. */
export interface DraftTool<D extends { kind: string } = RegisteredDraft> {
  /** Owning module id (`apps/assembler/modules.json`), for diagnostics. */
  module: string;
  /** The draft (and feature) kinds this tool handles. */
  kinds: readonly D['kind'][];
  /** Starts `kind` from the selection, or explains what is missing. */
  createDraft(kind: D['kind'], ctx: DraftToolContext): DraftToolStart<D>;
  /** Applies a viewport click (an unchanged draft means the click did not apply). */
  acceptPick(
    draft: D,
    pick: DraftPick,
    evaluation: EvaluationResult,
    features: readonly Feature[],
  ): D;
  /** The feature to preview/commit, or `null` while a required input is missing. */
  toFeature(draft: D, base: { id: string; name: string }): Feature | null;
  meta(draft: D): DraftToolMeta;
  badges?(draft: D, evaluation?: EvaluationResult): DraftToolBadge<D>[];
  handles?(
    draft: D,
    evaluation: EvaluationResult,
    features: readonly Feature[],
  ): DraftToolHandle<D>[];
  guides?(draft: D, evaluation: EvaluationResult, features: readonly Feature[]): DraftToolGuides;
  /** Bodies the running tool modifies in place (preview accent). */
  modifiedBodyIds?(draft: D): string[];
}

/**
 * Declares a module's tool (typed on its own drafts) for
 * `defineAssemblerModule({ draftTools })`. The registry dispatches by kind,
 * so a tool only ever sees its own drafts.
 */
export function defineDraftTool<D extends RegisteredDraft>(
  tool: DraftTool<D>,
): DraftTool<RegisteredDraft> {
  return tool as unknown as DraftTool<RegisteredDraft>;
}

const tools = new Map<string, DraftTool<{ kind: string }>>();

/** Registers a module's tool. A kind has one tool; a second registration throws. */
export function registerDraftTool(tool: DraftTool<RegisteredDraft>): void {
  for (const kind of tool.kinds) {
    const existing = tools.get(kind);
    if (existing === (tool as unknown as DraftTool<{ kind: string }>)) continue;
    if (existing) {
      throw new Error(
        `Draft tool of "${kind}" is registered twice (${existing.module}, ${tool.module})`,
      );
    }
    tools.set(kind, tool as unknown as DraftTool<{ kind: string }>);
  }
}

/** The tool registered for `kind`, or `undefined`. */
export function draftToolFor(kind: string): DraftTool<RegisteredDraft> | undefined {
  return tools.get(kind) as DraftTool<RegisteredDraft> | undefined;
}

/** Whether `kind` has a registered tool. */
export function isRegisteredDraftKind(kind: string): kind is RegisteredDraft['kind'] {
  return tools.has(kind);
}

/** Whether `draft` belongs to a registered tool. */
export function isRegisteredDraft(draft: { kind: string }): draft is RegisteredDraft {
  return tools.has(draft.kind);
}
