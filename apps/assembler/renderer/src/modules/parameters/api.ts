/**
 * The parameters module's part of the agent contract (`hcasm.agent-api@1`):
 * the `Parameter` schema and `parameters.list`, `parameter.create`,
 * `parameter.edit`, `parameter.delete` with their handlers. They run the
 * same planner as the Parameters panel (`slice.ts`, `parameterEdits.ts`),
 * so UI, agents and Python share one path.
 */
import type { ApiContribution, ApiHandler } from '../../foundation/commands/api/registry.js';
import { API_ORDER } from '../../foundation/commands/api/registry.js';
import {
  schemaNumber as num,
  schemaObject as obj,
  schemaRevision as revision,
  schemaString as str,
  type ApiContext,
  type Json,
  type MethodSpec,
} from '../../foundation/commands/api/contract.js';
import { ApiError } from '../../foundation/commands/api/errors.js';
import type { JsonSchema } from '../../foundation/commands/api/validate.js';
import type { Parameter } from '../../foundation/document/parameters.js';
import { documentCheckRunner } from '../../foundation/commands/documentChecks.js';
import type { ParameterChange, ParameterEdit } from './parameterEdits.js';
import {
  MAX_SAMPLES_PER_PARAMETER,
  MAX_SWEEP_PARAMETERS,
  MAX_SWEEP_SAMPLES,
  planSweep,
  runSweep,
  type SweepSpec,
} from './sweep.js';

const PARAMETER_DEF: JsonSchema = obj(
  {
    id: str,
    name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
    unit: { enum: ['mm', 'deg', ''] },
    value: num,
    expression: str,
    min: num,
    max: num,
    step: { type: 'number', exclusiveMinimum: 0 },
    minExpression: str,
    maxExpression: str,
    stepExpression: str,
  },
  ['id', 'name', 'unit', 'value'],
  'Document parameter ("variable"): `value` is always the last resolved value; `expression` (e.g. "wall * 2") is the source formula when the value is computed from other parameters. Usable from sketch dimension expressions and the numeric fields of extrude (distance), fillet (radius, radius2), chamfer (distance, distance2), shell/rib/thicken (thickness), hole (diameter) and draft (angle) via `<field>Expression`. Optional range: `min`/`max` bound the value (an edit outside them is refused, never clamped), `step` is the slider increment (not a constraint); each may come from a formula (`minExpression`, …) and is then its last resolved value.',
);

/** A range bound or step in a create/edit call: a number, a formula/text with a unit, or `null` to remove. */
const RANGE_INPUT: JsonSchema = {
  anyOf: [num, str, { type: 'null' }],
  description: 'A number, a formula or text with a unit ("wall * 2", "5 mm"), or null to remove.',
};

/** Result of parameter.create / parameter.edit. */
const RESULT_PARAMETER_EDIT =
  '{parameter: Parameter, revision, committed, resolvedSketchIds (sketches re-solved), changedFeatureIds, errors, warnings, bodies}';

const SPECS: Record<string, MethodSpec> = {
  'parameters.list': {
    kind: 'query',
    capability: 'document.read',
    summary: 'Document parameters ("variables"), in creation order.',
    params: obj({}),
    result: '[Parameter]',
  },
  'parameter.create': {
    kind: 'command',
    capability: 'document.write',
    summary:
      'Adds a document parameter (one undo step; not inside a transaction). Exactly one of `value`/`expression` is normally given; `expression` is resolved immediately (cycle/unknown-name errors reject with nothing changed).',
    params: obj(
      {
        name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
        unit: { enum: ['mm', 'deg', ''], default: 'mm' },
        value: num,
        expression: str,
        min: RANGE_INPUT,
        max: RANGE_INPUT,
        step: RANGE_INPUT,
        expectedRevision: revision,
      },
      ['name'],
    ),
    result: RESULT_PARAMETER_EDIT,
  },
  'parameter.edit': {
    kind: 'command',
    capability: 'document.write',
    summary:
      "Changes a parameter's name, unit, value, expression and/or range as ONE undo step (not inside a transaction). A new value re-solves every sketch whose dimensions use the parameter (directly or through other parameters) and re-resolves every feature `*Expression` field; dependent features re-evaluate. All-or-nothing: a sketch the solver cannot satisfy rejects with `sketchConflict` (details.conflicts), a feature that newly fails in the kernel with `featureFailed`, a value outside the parameter's `min`/`max` (its own or a dependent one) with `invalidParams` (details.outOfRange) — nothing changes, nothing is clamped. `value` alone replaces a formula; `expression: null` removes it; `min`/`max`/`step: null` removes that bound. Renaming rewrites every expression that references it.",
    params: obj(
      {
        parameterId: str,
        name: str,
        unit: { enum: ['mm', 'deg', ''] },
        value: num,
        expression: { anyOf: [str, { type: 'null' }] },
        min: RANGE_INPUT,
        max: RANGE_INPUT,
        step: RANGE_INPUT,
        expectedRevision: revision,
      },
      ['parameterId'],
    ),
    result: RESULT_PARAMETER_EDIT,
  },
  'parameter.delete': {
    kind: 'command',
    capability: 'document.write',
    summary:
      'Removes a parameter. Refused with `conflict` and the list of users when a sketch dimension or feature field still references it by name.',
    params: obj({ parameterId: str, expectedRevision: revision }, ['parameterId']),
    result: '{parameterId, revision, committed, errors, warnings, bodies}',
  },
  'parameters.sweep': {
    kind: 'query',
    capability: 'document.read',
    summary: `Tests a parameter range without changing the document: evaluates the model at each parameter's min / nominal / max (\`mode: "range"\`) or at \`samples\` evenly spaced values (\`mode: "samples"\`), one parameter at a time (\`combine: "each"\`, the others nominal) or every combination (\`combine: "all"\`), at most ${MAX_SWEEP_SAMPLES} samples. Each sample is planned like \`parameter.edit\` (sketches re-solved, formulas re-resolved) and rebuilt by the kernel at background priority. Per sample: \`outcome\` (\`rebuilt\` | \`refused\` — the values cannot be applied, e.g. a sketch conflict, see \`reason\`/\`featureId\` | \`failed\` — the kernel failed), \`errors\` (featureId, featureName, message of every failing step), \`bodies\`, \`volume\` and \`checks\` (the document's stored checks on that sample; null when no checks module is installed). Parameters without a stored range need \`min\`/\`max\` here; values must lie within a stored range. Steps below the History rollback bar are not evaluated.`,
    params: obj(
      {
        parameters: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_SWEEP_PARAMETERS,
          items: obj(
            {
              parameterId: str,
              min: num,
              max: num,
              values: { type: 'array', minItems: 1, maxItems: MAX_SWEEP_SAMPLES, items: num },
            },
            ['parameterId'],
          ),
        },
        mode: { enum: ['range', 'samples'], default: 'range' },
        samples: {
          type: 'integer',
          minimum: 2,
          maximum: MAX_SAMPLES_PER_PARAMETER,
          default: 5,
          description: 'Values per parameter in `samples` mode, min and max included.',
        },
        combine: { enum: ['each', 'all'], default: 'each' },
      },
      ['parameters'],
    ),
    result:
      '{axes: [{parameterId, name, unit, nominal, values}], samples: [{index, values: {name: value}, nominal, outcome, ok, errors: [{featureId, featureName, message}], reason?, featureId?, featureName?, bodies, volume, checks, ms}], passed, failed, total, cancelled, checksAvailable}',
  },
};

function describeParameter(p: Parameter): Json {
  return {
    id: p.id,
    name: p.name,
    unit: p.unit,
    value: p.value,
    ...(p.expression !== undefined ? { expression: p.expression } : {}),
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    ...(p.step !== undefined ? { step: p.step } : {}),
    ...(p.minExpression !== undefined ? { minExpression: p.minExpression } : {}),
    ...(p.maxExpression !== undefined ? { maxExpression: p.maxExpression } : {}),
    ...(p.stepExpression !== undefined ? { stepExpression: p.stepExpression } : {}),
  };
}

/** The range part of a create/edit call (`undefined` = keep, `null` = remove). */
function rangeChange(p: Json): Pick<ParameterEdit, 'min' | 'max' | 'step'> {
  const out: Pick<ParameterEdit, 'min' | 'max' | 'step'> = {};
  for (const field of ['min', 'max', 'step'] as const) {
    const v = p[field];
    if (typeof v === 'number' || typeof v === 'string' || v === null) out[field] = v;
  }
  return out;
}

function findParameter(ctx: ApiContext, parameterId: string): Parameter {
  const parameter = ctx
    .state()
    .parameters.find((p) => p.id === parameterId || p.name === parameterId);
  if (!parameter) {
    throw new ApiError('notFound', `No parameter "${parameterId}"`, {
      hint: 'parameters.list returns every parameter with its id and name.',
    });
  }
  return parameter;
}

/**
 * One parameter change through the store's planner (`parameterEdits.ts`,
 * the same path as the Parameters panel): dependent sketches re-solved,
 * `*Expression` fields re-resolved, kernel-validated, committed as ONE undo
 * step. Refused as a whole (nothing changes) on an invalid name/expression,
 * a sketch the solver cannot satisfy (`sketchConflict`), a feature that
 * newly fails in the kernel (`featureFailed`), or inside a transaction
 * (parameters are not staged; `transactionState`).
 */
async function changeParameter(
  ctx: ApiContext,
  change: ParameterChange,
): Promise<{ id: string; result: Json }> {
  if (ctx.transactionOpen()) {
    throw new ApiError('transactionState', 'Parameters cannot be changed inside a transaction', {
      hint: 'Commit or roll back the transaction first; a parameter edit is one undo step on its own.',
    });
  }
  ctx.ensureWritable();
  const plan = await ctx.state().planParameterChange(change);
  if (!plan.ok) {
    if (plan.conflicts) {
      throw new ApiError('sketchConflict', plan.message, {
        hint: 'Choose a value the dependent sketches can satisfy; nothing was changed.',
        details: { conflicts: plan.conflicts, committed: false },
      });
    }
    if (plan.usages) {
      throw new ApiError('conflict', plan.message, { details: { usages: plan.usages } });
    }
    if (plan.outOfRange) {
      throw new ApiError('invalidParams', plan.message, {
        hint: 'Choose a value within the range, or change the range first (min/max); values are never clamped.',
        details: { outOfRange: plan.outOfRange, committed: false },
      });
    }
    if (/^No parameter/.test(plan.message)) {
      throw new ApiError('notFound', plan.message, {
        hint: 'parameters.list returns every parameter with its id and name.',
      });
    }
    throw new ApiError('invalidParams', plan.message);
  }
  const before = await ctx.committedEvaluation();
  const evaluation = await ctx.evaluate(plan.features);
  const newlyFailing = plan.features
    .map((f) => f.id)
    .filter((id) => evaluation.errors[id] && !before.errors[id]);
  ctx.assertNoFeatureErrors(newlyFailing, evaluation);
  const applied = ctx.state().applyParameterPlan(plan, { evaluation });
  if (!applied.ok) {
    throw new ApiError('conflict', applied.message, { hint: 'Re-read the document and retry.' });
  }
  await ctx.state().whenSettled();
  return {
    id: applied.id,
    result: {
      committed: true,
      revision: ctx.revision(),
      resolvedSketchIds: applied.resolvedSketchIds,
      changedFeatureIds: applied.changedFeatureIds,
      ...ctx.evaluationSummary(ctx.state().evaluation),
    },
  };
}

const list: ApiHandler = (ctx) => ctx.state().parameters.map(describeParameter);

const create: ApiHandler = async (ctx, p) => {
  const { id, result } = await changeParameter(ctx, {
    name: String(p.name),
    unit: (typeof p.unit === 'string' ? p.unit : 'mm') as 'mm' | 'deg' | '',
    ...(typeof p.value === 'number' ? { value: p.value } : {}),
    ...(typeof p.expression === 'string' ? { expression: p.expression } : {}),
    ...rangeChange(p),
  });
  return { parameter: describeParameter(findParameter(ctx, id)), ...result };
};

/** Rename, unit, value and formula in one call are one undo step. */
const edit: ApiHandler = async (ctx, p) => {
  const existing = findParameter(ctx, String(p.parameterId));
  const { id, result } = await changeParameter(ctx, {
    id: existing.id,
    ...(typeof p.name === 'string' ? { name: p.name } : {}),
    ...(typeof p.unit === 'string' ? { unit: p.unit as 'mm' | 'deg' | '' } : {}),
    ...(typeof p.value === 'number' ? { value: p.value } : {}),
    ...(typeof p.expression === 'string' ? { expression: p.expression } : {}),
    ...(p.expression === null ? { expression: null } : {}),
    ...rangeChange(p),
  });
  return { parameter: describeParameter(findParameter(ctx, id)), ...result };
};

/**
 * `parameters.sweep`: plans the samples (`sweep.ts`), then rebuilds each on
 * the kernel's background channel; the document is never changed. The
 * stored checks run through the checks module's runner when one is
 * installed (`documentChecks.ts`).
 */
const sweep: ApiHandler = async (ctx, p) => {
  const state = ctx.state();
  const features = ctx.readFeatures(p);
  const spec: SweepSpec = {
    parameters: (p.parameters as Json[]).map((entry) => ({
      parameter: String(entry.parameterId),
      ...(typeof entry.min === 'number' ? { min: entry.min } : {}),
      ...(typeof entry.max === 'number' ? { max: entry.max } : {}),
      ...(Array.isArray(entry.values) ? { values: entry.values as number[] } : {}),
    })),
    mode: p.mode === 'samples' ? 'samples' : 'range',
    ...(typeof p.samples === 'number' ? { samples: p.samples } : {}),
    combine: p.combine === 'all' ? 'all' : 'each',
  };
  const plan = planSweep(state.parameters, spec);
  if (!plan.ok) {
    if (/^No parameter/.test(plan.message)) {
      throw new ApiError('notFound', plan.message, {
        hint: 'parameters.list returns every parameter with its id and name.',
      });
    }
    throw new ApiError('invalidParams', plan.message);
  }
  await ctx.kernelReady();
  const runner = documentCheckRunner();
  const signal = { aborted: false };
  let revision = 0;
  const report = await runSweep({ features, parameters: state.parameters }, plan, {
    rollbackBefore: state.rollbackBefore,
    signal,
    evaluate: async (list) => {
      revision += 1;
      const outcome = await ctx.kernel.evaluate({ channel: 'background', revision, features: list })
        .outcome;
      if (outcome.kind === 'done') return { kind: 'done', result: outcome.result };
      if (outcome.kind === 'failed') {
        if (outcome.code === 'kernelTimeout') {
          return { kind: 'failed', message: `The CAD kernel timed out: ${outcome.message}` };
        }
        return { kind: 'failed', message: outcome.message };
      }
      return { kind: 'cancelled' };
    },
    runChecks: runner ? (input) => runner.run({ ...input, kernel: ctx.kernel, signal }) : null,
  });
  return report as unknown as Json;
};

const remove: ApiHandler = async (ctx, p) => {
  const existing = findParameter(ctx, String(p.parameterId));
  const { result } = await changeParameter(ctx, { delete: existing.id });
  return { parameterId: existing.id, ...result };
};

const HANDLERS: Record<string, ApiHandler> = {
  'parameters.list': list,
  'parameter.create': create,
  'parameter.edit': edit,
  'parameter.delete': remove,
  'parameters.sweep': sweep,
};

export const PARAMETERS_API: ApiContribution = {
  defs: [{ order: API_ORDER.defs.parameter, defs: { Parameter: PARAMETER_DEF } }],
  methods: [
    {
      order: API_ORDER.methods.parameters,
      methods: Object.fromEntries(
        Object.entries(SPECS).map(([name, spec]) => [name, { spec, handler: HANDLERS[name]! }]),
      ),
    },
  ],
};
