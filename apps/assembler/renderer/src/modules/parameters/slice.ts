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
import type { Feature } from '../../foundation/document/document.js';
import { documentCheckRunner } from '../../foundation/commands/documentChecks.js';
import {
  findParameterDependents,
  findParameterUsages,
  type Parameter,
  type ParameterUnit,
  type ParameterUsage,
} from '../../foundation/document/parameters.js';
import {
  planParameterChange,
  type ParameterChange,
  type ParameterEditResult,
  type ParameterPlan,
} from './parameterEdits.js';
import {
  planSweep,
  runSweep,
  type SweepReport,
  type SweepSampleResult,
  type SweepSpec,
} from './sweep.js';

/** A parameter slider being dragged: the value shown live and the preview's state. */
export interface ParameterSliderState {
  parameterId: string;
  value: number;
  /** A newer value than the shown preview is being computed. */
  pending: boolean;
  /** Why the current value cannot be previewed (the last valid preview stays). */
  error: string | null;
}

/** A running or finished "Test range" (one at a time). */
export interface ParameterSweepState {
  spec: SweepSpec;
  running: boolean;
  done: number;
  total: number;
  samples: SweepSampleResult[];
  report: SweepReport | null;
  /** Why the test could not start or stopped (not a failing sample). */
  error: string | null;
}

export interface ParametersSlice {
  /** The slider being dragged, or `null`. */
  parameterSlider: ParameterSliderState | null;
  /**
   * Live preview while a slider is dragged (Parameters panel): plans the
   * value like an edit and evaluates it on the kernel's preview channel
   * (incremental, preview tessellation), at most one request in flight and
   * always the newest value next; the viewport shows the result
   * (`documentPreview`). Nothing is committed.
   */
  previewParameterValue: (parameterId: string, value: number) => void;
  /**
   * Ends a slider drag: `commit` applies the value as ONE undo step through
   * {@link ParametersSlice.editParameter} (refused like a typed value when the
   * model would break), otherwise the preview is dropped.
   */
  endParameterPreview: (commit: boolean) => Promise<ParameterEditResult | null>;
  /** The last or running "Test range", or `null`. */
  parameterSweep: ParameterSweepState | null;
  /**
   * Runs a parameter sweep (`sweep.ts`) on the current document without
   * changing it: progress in {@link ParametersSlice.parameterSweep},
   * cancellable with {@link ParametersSlice.cancelParameterSweep}.
   */
  runParameterSweep: (spec: SweepSpec) => Promise<SweepReport | null>;
  cancelParameterSweep: () => void;
  clearParameterSweep: () => void;
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
    /** Range bounds and slider step (see `ParameterEdit`); absent keeps them. */
    min?: number | string | null;
    max?: number | string | null;
    step?: number | string | null;
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

/** Steps above the History rollback bar (what the viewport shows). */
function activeSteps(features: Feature[], rollbackBefore: string | null): Feature[] {
  if (!rollbackBefore) return features;
  const index = features.findIndex((f) => f.id === rollbackBefore);
  return index >= 0 ? features.slice(0, index) : features;
}

function newParameterId(): string {
  throw new Error('a preview never creates parameters');
}

export const createParametersSlice: StoreSliceCreator<ParametersSlice> = (set, get, core) => {
  /** The running slider drag (one at a time); a newer drag or the end replaces it. */
  let drag: {
    parameterId: string;
    base: { features: readonly Feature[]; parameters: readonly Parameter[] };
    latest: number | null;
    running: boolean;
    cancel: (() => void) | null;
  } | null = null;

  const setSlider = (patch: Partial<ParameterSliderState> | null) => {
    const current = get().parameterSlider;
    if (patch === null) {
      if (current) set({ parameterSlider: null });
      return;
    }
    if (!current && !patch.parameterId) return;
    set({
      parameterSlider: {
        ...(current ?? { pending: false, error: null, value: 0, parameterId: '' }),
        ...patch,
      },
    });
  };

  /** Plans and evaluates the newest value until none is waiting (throttled to kernel speed). */
  const pumpPreview = async (d: NonNullable<typeof drag>): Promise<void> => {
    d.running = true;
    try {
      while (drag === d && d.latest !== null) {
        const value = d.latest;
        d.latest = null;
        const plan = await planParameterChange(
          d.base,
          { id: d.parameterId, value },
          newParameterId,
        );
        if (drag !== d) return;
        if (!plan.ok) {
          setSlider({
            error: plan.message.replace(/ Nothing was changed\.$/, ''),
            pending: d.latest !== null,
          });
          continue;
        }
        const job = core.evaluateDetached(activeSteps(plan.features, get().rollbackBefore), {
          channel: 'preview',
        });
        if (!job) return;
        d.cancel = job.cancel;
        const outcome = await job.outcome;
        d.cancel = null;
        if (drag !== d) return;
        if (outcome.kind === 'done') {
          const feature = plan.features.find((f) => outcome.result.errors[f.id]);
          core.setDocumentPreview(outcome.result);
          setSlider({
            error: feature ? `${feature.name}: ${outcome.result.errors[feature.id]}` : null,
            pending: d.latest !== null,
          });
        } else if (outcome.kind === 'failed') {
          setSlider({ error: outcome.message, pending: d.latest !== null });
        } else if (outcome.kind === 'superseded' && d.latest === null) {
          // Another preview took the channel's waiting slot: send this value again.
          d.latest = value;
        }
      }
    } finally {
      d.running = false;
      if (drag === d) setSlider({ pending: false });
    }
  };

  let sweepAbort: { aborted: boolean; cancelJob: (() => void) | null } | null = null;

  return {
    parameterSlider: null,
    previewParameterValue: (parameterId, value) => {
      const state = get();
      if (state.activeTool !== null || !Number.isFinite(value)) return;
      if (
        !drag ||
        drag.parameterId !== parameterId ||
        drag.base.features !== state.features ||
        drag.base.parameters !== state.parameters
      ) {
        drag?.cancel?.();
        drag = {
          parameterId,
          base: { features: state.features, parameters: state.parameters },
          latest: value,
          running: false,
          cancel: null,
        };
        set({ parameterSlider: { parameterId, value, pending: true, error: null } });
      } else {
        drag.latest = value;
        setSlider({ value, pending: true });
      }
      if (!drag.running) void pumpPreview(drag);
    },
    endParameterPreview: async (commit) => {
      const d = drag;
      const slider = get().parameterSlider;
      drag = null;
      d?.cancel?.();
      if (!commit || !d || !slider) {
        core.setDocumentPreview(null);
        setSlider(null);
        return null;
      }
      const outcome = await get().editParameter({ id: d.parameterId, value: slider.value });
      // A commit replaced the document (and ended the preview); a refusal leaves the old one.
      core.setDocumentPreview(null);
      setSlider(null);
      return outcome;
    },
    parameterSweep: null,
    runParameterSweep: async (spec) => {
      if (get().parameterSweep?.running) return null;
      const state = get();
      const doc = { features: state.features, parameters: state.parameters };
      const plan = planSweep(doc.parameters, spec);
      if (!plan.ok) {
        set({
          parameterSweep: {
            spec,
            running: false,
            done: 0,
            total: 0,
            samples: [],
            report: null,
            error: plan.message,
          },
        });
        return null;
      }
      if (!core.hasKernel()) {
        set({
          parameterSweep: {
            spec,
            running: false,
            done: 0,
            total: plan.samples.length,
            samples: [],
            report: null,
            error: 'The CAD kernel is not available.',
          },
        });
        return null;
      }
      const abort: { aborted: boolean; cancelJob: (() => void) | null } = {
        aborted: false,
        cancelJob: null,
      };
      sweepAbort = abort;
      set({
        parameterSweep: {
          spec,
          running: true,
          done: 0,
          total: plan.samples.length,
          samples: [],
          report: null,
          error: null,
        },
      });
      const checks = documentCheckRunner();
      const report = await runSweep(doc, plan, {
        rollbackBefore: state.rollbackBefore,
        signal: abort,
        evaluate: async (features) => {
          const job = core.evaluateDetached(features, { channel: 'background' });
          if (!job) return { kind: 'failed', message: 'The CAD kernel is not available.' };
          abort.cancelJob = job.cancel;
          const outcome = await job.outcome;
          abort.cancelJob = null;
          if (outcome.kind === 'done') return { kind: 'done', result: outcome.result };
          if (outcome.kind === 'failed') return { kind: 'failed', message: outcome.message };
          if (abort.aborted) return { kind: 'cancelled' };
          // A background job is never superseded by other channels; treat anything else as cancelled.
          return { kind: 'cancelled' };
        },
        runChecks: checks
          ? (input) => checks.run({ ...input, kernel: core.kernel(), signal: abort })
          : null,
        onProgress: (done, total, last) => {
          if (sweepAbort !== abort) return;
          const current = get().parameterSweep;
          if (!current) return;
          set({
            parameterSweep: {
              ...current,
              done,
              total,
              samples: last ? [...current.samples, last] : current.samples,
            },
          });
        },
      });
      if (sweepAbort === abort) sweepAbort = null;
      const current = get().parameterSweep;
      set({
        parameterSweep: {
          spec,
          running: false,
          done: report.samples.length,
          total: report.total,
          samples: report.samples,
          report,
          error: current?.error ?? null,
        },
      });
      return report;
    },
    cancelParameterSweep: () => {
      const abort = sweepAbort;
      if (!abort) return;
      abort.aborted = true;
      abort.cancelJob?.();
    },
    clearParameterSweep: () => {
      if (get().parameterSweep?.running) get().cancelParameterSweep();
      set({ parameterSweep: null });
    },
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
        ...(input.min !== undefined ? { min: input.min } : {}),
        ...(input.max !== undefined ? { max: input.max } : {}),
        ...(input.step !== undefined ? { step: input.step } : {}),
      }),
    renameParameter: (id, name) => get().editParameter({ id, name }),
    deleteParameter: (id) => get().editParameter({ delete: id }),
  };
};
