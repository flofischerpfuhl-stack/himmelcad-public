/**
 * Parameter sweep ("Test range", `parameters.sweep`): evaluates the model at
 * a parameter's min / nominal / max, or at N evenly spaced values, for one
 * parameter or several (one at a time, or every combination), and reports
 * per sample whether the model rebuilds — with the failing feature and the
 * kernel's reason — and the results of the document's stored checks
 * (`foundation/commands/documentChecks.ts`).
 *
 * Never mutates the document: every sample is planned with the same planner
 * as a parameter edit (`parameterEdits.ts`: sketches re-solved, feature
 * formulas re-resolved) on a copy and evaluated on the kernel's `background`
 * channel (lowest priority; the kernel and the sketch solver run in workers,
 * so the UI thread only orchestrates). The sample count is bounded
 * ({@link MAX_SWEEP_SAMPLES}); a run reports progress and stops at the next
 * sample (or at once, when the running kernel job is cancelled) on cancel.
 */
import type { Feature } from '../../foundation/document/document.js';
import {
  describeParameterRange,
  resolveParameterRanges,
  resolveParameterValues,
  type Parameter,
  type ParameterRange,
} from '../../foundation/document/parameters.js';
import type { DocumentCheckResult } from '../../foundation/commands/documentChecks.js';
import type { EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import { planParameterChange } from './parameterEdits.js';

/** Upper bound of the samples one sweep evaluates. */
export const MAX_SWEEP_SAMPLES = 64;
/** Upper bound of the parameters one sweep varies. */
export const MAX_SWEEP_PARAMETERS = 4;
/** Upper bound of `samples` per parameter in `samples` mode. */
export const MAX_SAMPLES_PER_PARAMETER = 16;

/** One swept parameter; `min`/`max`/`values` override (and must lie within) its own range. */
export interface SweepAxisInput {
  /** Parameter id or name. */
  parameter: string;
  min?: number;
  max?: number;
  /** Explicit values instead of min/nominal/max or the samples. */
  values?: number[];
}

export interface SweepSpec {
  parameters: SweepAxisInput[];
  /** `range`: min, nominal, max; `samples`: `samples` values evenly spaced from min to max. */
  mode?: 'range' | 'samples';
  samples?: number;
  /** `each`: one parameter at a time (the others nominal); `all`: every combination. */
  combine?: 'each' | 'all';
}

/** One swept parameter with its values (in the order they are tried). */
export interface SweepAxis {
  parameterId: string;
  name: string;
  unit: Parameter['unit'];
  nominal: number;
  values: number[];
}

export interface SweepFeatureError {
  featureId: string;
  featureName: string;
  message: string;
}

export interface SweepSampleResult {
  index: number;
  /** Swept parameter name → value. */
  values: Record<string, number>;
  /** `true` when every swept value equals its nominal. */
  nominal: boolean;
  /** `rebuilt`: evaluated (see `errors`); `refused`: the planner refused the values (`reason`). */
  outcome: 'rebuilt' | 'refused' | 'failed';
  ok: boolean;
  errors: SweepFeatureError[];
  /** Why a sample was refused (a sketch the values cannot satisfy, a formula out of range) or failed. */
  reason?: string;
  /** Feature the refusal points at, when known. */
  featureId?: string;
  featureName?: string;
  bodies: number;
  /** Sum of the solid bodies' volumes, mm³. */
  volume: number;
  /** The stored checks on this sample; `null` when no checks module is installed. */
  checks: DocumentCheckResult[] | null;
  ms: number;
}

export interface SweepReport {
  axes: SweepAxis[];
  samples: SweepSampleResult[];
  /** Samples that rebuilt without an error and passed every check. */
  passed: number;
  failed: number;
  total: number;
  cancelled: boolean;
  /** Whether a checks module ran the stored checks. */
  checksAvailable: boolean;
}

export type SweepPlan =
  | { ok: true; axes: SweepAxis[]; samples: Record<string, number>[] }
  | { ok: false; message: string };

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function find(parameters: readonly Parameter[], key: string): Parameter | undefined {
  return parameters.find((p) => p.id === key || p.name === key);
}

/**
 * The samples of `spec` against the document's parameters, or the reason
 * the request cannot run (unknown parameter, no range, values outside the
 * parameter's range, too many samples). Pure.
 */
export function planSweep(parameters: readonly Parameter[], spec: SweepSpec): SweepPlan {
  const inputs = spec.parameters;
  if (inputs.length === 0) return { ok: false, message: 'Choose at least one parameter to test.' };
  if (inputs.length > MAX_SWEEP_PARAMETERS) {
    return {
      ok: false,
      message: `At most ${MAX_SWEEP_PARAMETERS} parameters can be tested at once.`,
    };
  }
  const resolved = resolveParameterValues(parameters);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  const ranges = resolveParameterRanges(parameters, resolved.values);
  if (!ranges.ok) return { ok: false, message: ranges.message };
  const mode = spec.mode ?? 'range';
  const count = spec.samples ?? 5;
  if (
    mode === 'samples' &&
    !(Number.isInteger(count) && count >= 2 && count <= MAX_SAMPLES_PER_PARAMETER)
  ) {
    return {
      ok: false,
      message: `samples must be a whole number from 2 to ${MAX_SAMPLES_PER_PARAMETER}.`,
    };
  }
  const axes: SweepAxis[] = [];
  for (const input of inputs) {
    const p = find(parameters, input.parameter);
    if (!p) return { ok: false, message: `No parameter "${input.parameter}".` };
    if (axes.some((a) => a.parameterId === p.id)) {
      return { ok: false, message: `${p.name} is listed twice.` };
    }
    if (p.expression !== undefined) {
      return {
        ok: false,
        message: `${p.name} is computed from a formula (${p.expression}); test the parameters it reads instead.`,
      };
    }
    const own: ParameterRange = ranges.ranges.get(p.id) ?? {};
    const nominal = resolved.values.get(p.name) ?? p.value;
    const outside = (v: number) =>
      (own.min !== undefined && v < own.min - 1e-9) ||
      (own.max !== undefined && v > own.max + 1e-9);
    let values: number[];
    if (input.values && input.values.length > 0) {
      if (!input.values.every(Number.isFinite)) {
        return { ok: false, message: `${p.name}: every value must be a finite number.` };
      }
      values = input.values.map(round);
    } else {
      const min = input.min ?? own.min;
      const max = input.max ?? own.max;
      if (min === undefined || max === undefined) {
        return {
          ok: false,
          message: `${p.name} has no range: set its min and max first (or give them for this test).`,
        };
      }
      if (!(Number.isFinite(min) && Number.isFinite(max)) || min > max) {
        return { ok: false, message: `${p.name}: the test range ${min}…${max} is empty.` };
      }
      if (mode === 'range') {
        values = [min, nominal, max];
      } else {
        values = Array.from({ length: count }, (_, i) =>
          i === count - 1 ? max : min + ((max - min) * i) / (count - 1),
        );
      }
      values = values.map(round);
    }
    const bad = values.find(outside);
    if (bad !== undefined) {
      return {
        ok: false,
        message: `${p.name} = ${bad} lies outside its range ${describeParameterRange(own, p.unit)}.`,
      };
    }
    values = [...new Set(values)].sort((a, b) => a - b);
    axes.push({ parameterId: p.id, name: p.name, unit: p.unit, nominal: round(nominal), values });
  }

  const nominalSample = Object.fromEntries(axes.map((a) => [a.name, a.nominal]));
  let samples: Record<string, number>[];
  if ((spec.combine ?? 'each') === 'all') {
    const total = axes.reduce((n, a) => n * a.values.length, 1);
    if (total > MAX_SWEEP_SAMPLES) {
      return {
        ok: false,
        message: `Every combination would be ${total} samples; at most ${MAX_SWEEP_SAMPLES}. Use fewer values or test one parameter at a time.`,
      };
    }
    samples = [{}];
    for (const axis of axes) {
      samples = samples.flatMap((s) => axis.values.map((v) => ({ ...s, [axis.name]: v })));
    }
  } else {
    // One at a time: the nominal state once, then each parameter's other values.
    samples = [nominalSample];
    for (const axis of axes) {
      for (const v of axis.values) {
        if (v !== axis.nominal) samples.push({ ...nominalSample, [axis.name]: v });
      }
    }
    if (samples.length > MAX_SWEEP_SAMPLES) {
      return {
        ok: false,
        message: `The test would be ${samples.length} samples; at most ${MAX_SWEEP_SAMPLES}.`,
      };
    }
  }
  return { ok: true, axes, samples };
}

/** What a sweep needs from its environment (the app store or an agent session). */
export interface SweepServices {
  /** Evaluates a feature list without touching the document (kernel `background` channel). */
  evaluate(
    features: Feature[],
  ): Promise<
    | { kind: 'done'; result: EvaluationResult }
    | { kind: 'failed'; message: string }
    | { kind: 'cancelled' }
  >;
  /** The stored checks on a sample, or `null` without a checks module. */
  runChecks?:
    | ((input: {
        features: readonly Feature[];
        parameters: readonly Parameter[];
        evaluation: EvaluationResult;
      }) => Promise<DocumentCheckResult[]>)
    | null;
  /** The History rollback marker: steps from it on are not evaluated (as in the viewport). */
  rollbackBefore?: string | null;
  signal?: { readonly aborted: boolean };
  onProgress?(done: number, total: number, last: SweepSampleResult | null): void;
}

function clock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function activeSteps(features: Feature[], rollbackBefore: string | null | undefined): Feature[] {
  if (!rollbackBefore) return features;
  const index = features.findIndex((f) => f.id === rollbackBefore);
  return index >= 0 ? features.slice(0, index) : features;
}

/**
 * Runs a planned sweep on `doc` (never changed). Samples run one after the
 * other; a cancelled run returns the samples finished so far with
 * `cancelled: true`.
 */
export async function runSweep(
  doc: { features: readonly Feature[]; parameters: readonly Parameter[] },
  plan: Extract<SweepPlan, { ok: true }>,
  services: SweepServices,
): Promise<SweepReport> {
  const results: SweepSampleResult[] = [];
  const total = plan.samples.length;
  let cancelled = false;
  const checksAvailable = !!services.runChecks;
  services.onProgress?.(0, total, null);
  for (const [index, values] of plan.samples.entries()) {
    if (services.signal?.aborted) {
      cancelled = true;
      break;
    }
    const t0 = clock();
    const nominal = plan.axes.every((a) => values[a.name] === a.nominal);
    const base: Omit<SweepSampleResult, 'outcome' | 'ok' | 'ms'> = {
      index,
      values,
      nominal,
      errors: [],
      bodies: 0,
      volume: 0,
      checks: null,
    };
    // The sample's document: each swept value applied with the edit planner.
    let current: { features: readonly Feature[]; parameters: readonly Parameter[] } = doc;
    let refusal: { reason: string; featureId?: string; featureName?: string } | null = null;
    for (const axis of plan.axes) {
      const value = values[axis.name]!;
      const p = current.parameters.find((x) => x.id === axis.parameterId);
      if (!p || p.value === value) continue;
      const step = await planParameterChange(current, { id: axis.parameterId, value }, () => {
        throw new Error('a sweep never creates parameters');
      });
      if (!step.ok) {
        const conflict = step.conflicts?.[0];
        refusal = {
          reason: step.message.replace(/ Nothing was changed\.$/, ''),
          ...(conflict ? { featureId: conflict.featureId, featureName: conflict.featureName } : {}),
        };
        break;
      }
      current = { features: step.features, parameters: step.parameters };
    }
    if (services.signal?.aborted) {
      cancelled = true;
      break;
    }
    if (refusal) {
      const result: SweepSampleResult = {
        ...base,
        outcome: 'refused',
        ok: false,
        ...refusal,
        ms: clock() - t0,
      };
      results.push(result);
      services.onProgress?.(results.length, total, result);
      continue;
    }
    const features = activeSteps([...current.features], services.rollbackBefore);
    const outcome = await services.evaluate(features);
    if (outcome.kind === 'cancelled') {
      cancelled = true;
      break;
    }
    if (outcome.kind === 'failed') {
      const result: SweepSampleResult = {
        ...base,
        outcome: 'failed',
        ok: false,
        reason: outcome.message,
        ms: clock() - t0,
      };
      results.push(result);
      services.onProgress?.(results.length, total, result);
      continue;
    }
    const evaluation = outcome.result;
    const names = new Map(features.map((f) => [f.id, f.name]));
    const errors = Object.entries(evaluation.errors).map(([featureId, message]) => ({
      featureId,
      featureName: names.get(featureId) ?? featureId,
      message,
    }));
    let checks: DocumentCheckResult[] | null = null;
    if (services.runChecks) {
      try {
        checks = await services.runChecks({
          features,
          parameters: current.parameters,
          evaluation,
        });
      } catch (error) {
        checks = [
          {
            checkId: '',
            name: 'Checks',
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          },
        ];
      }
    }
    const result: SweepSampleResult = {
      ...base,
      outcome: 'rebuilt',
      ok: errors.length === 0 && (checks ?? []).every((c) => c.status === 'pass'),
      errors,
      bodies: evaluation.bodies.length,
      volume: round(evaluation.bodies.reduce((sum, b) => sum + (b.volume ?? 0), 0)),
      checks,
      ms: clock() - t0,
    };
    results.push(result);
    services.onProgress?.(results.length, total, result);
  }
  const passed = results.filter((r) => r.ok).length;
  return {
    axes: plan.axes,
    samples: results,
    passed,
    failed: results.length - passed,
    total,
    cancelled,
    checksAvailable,
  };
}
