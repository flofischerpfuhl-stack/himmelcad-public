/**
 * The parameters module's part of the application store: planning and
 * committing parameter edits (create, change, rename, delete) as exactly
 * one undo step, installed into `useAssemblerStore` by the product
 * composition (`defineAssemblerModule({ storeSlice })`). The parameter list
 * itself is document state and stays in the store core (it is part of every
 * undo snapshot); this slice only adds the actions.
 */
import type { StoreCore, StoreSliceCreator } from '../../foundation/commands/store.js';
import type { EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import {
  findParameterDependents,
  findParameterUsages,
  type ParameterUnit,
  type ParameterUsage,
} from '../../foundation/document/parameters.js';
import {
  planParameterChange,
  type ParameterChange,
  type ParameterEditResult,
  type ParameterPlan,
} from './parameterEdits.js';

export interface ParametersSlice {
  /**
   * Plans a parameter change (create/edit/rename/delete) against the current
   * document without changing it: the new parameters, every sketch whose
   * dimensions read a changed value re-solved, every `*Expression` field
   * re-resolved (`parameterEdits.ts`). Refusals are all-or-nothing.
   */
  planParameterChange: (change: ParameterChange) => Promise<ParameterPlan>;
  /**
   * Commits a plan as exactly one undo step (parameters + re-solved
   * sketches + re-resolved features). Refused when a tool is active or the
   * document changed since the plan was made. `evaluation` (the agent API
   * validated the plan's features already) seeds the result cache.
   */
  applyParameterPlan: (
    plan: ParameterPlan,
    options?: { evaluation?: EvaluationResult },
  ) => ParameterEditResult;
  /** Plans and commits one parameter change (UI entry point; re-plans if the document moved). */
  editParameter: (change: ParameterChange) => Promise<ParameterEditResult>;
  /**
   * Creates (`id` omitted) or edits (`id` given) one parameter via
   * {@link ParametersSlice.editParameter}: a formula wins over `value`; a
   * `value` alone replaces a formula.
   */
  upsertParameter: (input: {
    id?: string;
    name: string;
    unit: ParameterUnit;
    value?: number;
    expression?: string;
  }) => Promise<ParameterEditResult>;
  /** Renames a parameter and rewrites every expression that references it (by name, not value). */
  renameParameter: (id: string, name: string) => Promise<ParameterEditResult>;
  /** Refused (`ok: false`, `usages`) when any sketch dimension or feature field still references it. */
  deleteParameter: (id: string) => Promise<ParameterEditResult>;
  /** Every place in the document that reads `paramId`'s name, for a "used by" listing before delete. */
  parameterUsages: (paramId: string) => ParameterUsage[];
}

declare module '../../foundation/commands/store.js' {
  // Declaration merging adds the slice to the store's state type.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AssemblerStateExtensions extends ParametersSlice {}
}

/**
 * Evaluates a parameter plan before it is committed and refuses it when a
 * feature that evaluates cleanly now would fail with the new values — the
 * same rule as the agent API's `parameter.edit` (`featureFailed`). Only the
 * steps above the History rollback bar are checked (what the viewport
 * shows); the returned evaluation is reusable only without a rollback.
 */
async function checkParameterPlan(
  core: StoreCore,
  plan: Extract<ParameterPlan, { ok: true }>,
): Promise<{ ok: true; evaluation: EvaluationResult | null } | { ok: false; message: string }> {
  if (!core.hasKernel()) return { ok: true, evaluation: null };
  const get = core.getState;
  await get().whenSettled();
  const state = get();
  const before = state.evaluation;
  const marker = state.rollbackBefore
    ? plan.features.findIndex((f) => f.id === state.rollbackBefore)
    : -1;
  const active = marker >= 0 ? plan.features.slice(0, marker) : plan.features;
  const outcome = await core.evaluateCheck(active);
  if (outcome.kind === 'failed') {
    return { ok: false, message: `The CAD kernel failed: ${outcome.message}` };
  }
  if (outcome.kind === 'busy') return { ok: false, message: 'The CAD kernel is busy; try again.' };
  const evaluated = outcome.result;
  const failing = active.filter((f) => evaluated.errors[f.id] && !before.errors[f.id]);
  if (failing.length > 0) {
    const first = failing[0]!;
    const more = failing.length > 1 ? ` (and ${failing.length - 1} more)` : '';
    return {
      ok: false,
      message: `${first.name} would fail: ${evaluated.errors[first.id]}${more}. Nothing was changed.`,
    };
  }
  return { ok: true, evaluation: marker >= 0 ? null : evaluated };
}

export const createParametersSlice: StoreSliceCreator<ParametersSlice> = (_set, get, core) => ({
  parameterUsages: (paramId) => {
    const state = get();
    const param = state.parameters.find((p) => p.id === paramId);
    if (!param) return [];
    return [
      ...findParameterDependents(state.parameters, param.name),
      ...findParameterUsages(state.features, param.name),
    ];
  },
  planParameterChange: (change) => {
    const state = get();
    return planParameterChange(
      { features: state.features, parameters: state.parameters },
      change,
      () => {
        const taken = new Set(get().parameters.map((p) => p.id));
        let id = `param-${Math.random().toString(36).slice(2, 10)}`;
        while (taken.has(id)) id = `param-${Math.random().toString(36).slice(2, 10)}`;
        return id;
      },
    );
  },
  applyParameterPlan: (plan, options) => {
    if (!plan.ok) return plan;
    const state = get();
    if (state.activeTool !== null) {
      return { ok: false, message: 'Finish or cancel the active tool first.' };
    }
    if (state.features !== plan.base.features || state.parameters !== plan.base.parameters) {
      return { ok: false, message: 'The document changed meanwhile; try again.' };
    }
    if (options?.evaluation) core.seedEvaluation(plan.features, options.evaluation);
    // Same length: the History rollback bar stays where it is.
    core.commitDocument({ features: plan.features, parameters: plan.parameters });
    return {
      ok: true,
      id: plan.id,
      resolvedSketchIds: plan.resolvedSketchIds,
      changedFeatureIds: plan.changedFeatureIds,
    };
  },
  editParameter: async (change) => {
    // A concurrent edit (another panel field, an agent) makes the plan stale: plan again.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const plan = await get().planParameterChange(change);
      if (!plan.ok) return plan;
      // Like `parameter.edit` in the agent API: a feature that newly fails refuses the edit.
      const check = await checkParameterPlan(core, plan);
      if (!check.ok) return check;
      const applied = get().applyParameterPlan(
        plan,
        check.evaluation ? { evaluation: check.evaluation } : undefined,
      );
      if (applied.ok || !/changed meanwhile/.test(applied.message)) return applied;
    }
    return { ok: false, message: 'The document keeps changing; try again.' };
  },
  upsertParameter: (input) =>
    get().editParameter({
      ...(input.id !== undefined ? { id: input.id } : {}),
      name: input.name,
      unit: input.unit,
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.expression !== undefined ? { expression: input.expression } : {}),
    }),
  renameParameter: (id, name) => get().editParameter({ id, name }),
  deleteParameter: (id) => get().editParameter({ delete: id }),
});
