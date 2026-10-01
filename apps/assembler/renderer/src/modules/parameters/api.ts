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
import type { ParameterChange } from './parameterEdits.js';

const PARAMETER_DEF: JsonSchema = obj(
  {
    id: str,
    name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
    unit: { enum: ['mm', 'deg', ''] },
    value: num,
    expression: str,
  },
  ['id', 'name', 'unit', 'value'],
  'Document parameter ("variable"): `value` is always the last resolved value; `expression` (e.g. "wall * 2") is the source formula when the value is computed from other parameters. Usable from sketch dimension expressions and the numeric fields of extrude (distance), fillet (radius, radius2), chamfer (distance, distance2), shell/rib/thicken (thickness), hole (diameter) and draft (angle) via `<field>Expression`.',
);

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
      "Changes a parameter's name, unit, value and/or expression as ONE undo step (not inside a transaction). A new value re-solves every sketch whose dimensions use the parameter (directly or through other parameters) and re-resolves every feature `*Expression` field; dependent features re-evaluate. All-or-nothing: a sketch the solver cannot satisfy rejects with `sketchConflict` (details.conflicts), a feature that newly fails in the kernel with `featureFailed` — nothing changes. `value` alone replaces a formula; `expression: null` removes it. Renaming rewrites every expression that references it.",
    params: obj(
      {
        parameterId: str,
        name: str,
        unit: { enum: ['mm', 'deg', ''] },
        value: num,
        expression: { anyOf: [str, { type: 'null' }] },
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
};

function describeParameter(p: Parameter): Json {
  return {
    id: p.id,
    name: p.name,
    unit: p.unit,
    value: p.value,
    ...(p.expression !== undefined ? { expression: p.expression } : {}),
  };
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
  });
  return { parameter: describeParameter(findParameter(ctx, id)), ...result };
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
