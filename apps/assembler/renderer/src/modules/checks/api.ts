/**
 * The checks module's part of the agent contract (`hcasm.agent-api@1`,
 * assembler/CHECKS.md): `checks.kinds`, `checks.list`, `checks.add`,
 * `checks.update`, `checks.remove` and `checks.run`. Edits are one undo
 * step each, like the Checks panel's (same validation, same store path);
 * `checks.run` evaluates the checks on the committed or the staged
 * document and returns structured results (status, value, unit, expected
 * range, message, locations with body/face/edge ids). Agents always get
 * full results, whatever the user's workspace settings.
 *
 * Contract for other modules (the parameter sweep): `checks.run` with
 * `scope: "staged"` evaluates against an open transaction's state; code in
 * the same process calls `runChecks` (`foundation/commands/checks.ts`) with
 * its own evaluation instead.
 */
import {
  checkDisplayName,
  checkKind,
  checkKinds,
  CheckEditError,
  commitStoredChecks,
  newStoredCheck,
  patchedStoredCheck,
  runChecks,
  summarizeResults,
  type CheckResult,
} from '../../foundation/commands/checks.js';
import {
  schemaObject as obj,
  schemaRevision,
  schemaScope,
  schemaString as str,
  type ApiContext,
  type Json,
  type MethodSpec,
} from '../../foundation/commands/api/contract.js';
import { ApiError } from '../../foundation/commands/api/errors.js';
import {
  API_ORDER,
  type ApiContribution,
  type ApiHandler,
} from '../../foundation/commands/api/registry.js';
import type { StoredCheck } from '../../foundation/document/checks.js';
import { useCheckResults } from './checksStore.js';
import { bodyNamer, CHECK_BUDGET_MS, resultsStale } from './runner.js';

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** A result as agents read it. */
export function resultJson(result: CheckResult): Json {
  const o = result.outcome;
  return {
    id: result.id,
    kind: result.kind,
    name: result.name,
    status: result.state,
    ...(o?.value !== undefined ? { value: o.value === null ? null : round(o.value) } : {}),
    ...(o?.unit !== undefined ? { unit: o.unit } : {}),
    ...(o?.expected ? { expected: o.expected } : {}),
    ...(o ? { message: o.message } : {}),
    ...(o?.locations ? { locations: o.locations } : {}),
    ...(o?.details ? { details: o.details } : {}),
    ms: Math.round(result.ms * 10) / 10,
  };
}

function checkJson(check: StoredCheck, bodyName: (id: string) => string): Json {
  return {
    id: check.id,
    kind: check.kind,
    ...(check.name ? { name: check.name } : {}),
    displayName: checkDisplayName(check, bodyName),
    params: check.params,
    enabled: check.enabled !== false,
    ...(checkKind(check.kind) ? {} : { supported: false }),
  };
}

function findCheck(ctx: ApiContext, checkId: string): StoredCheck {
  const check = ctx.state().checks.find((c) => c.id === checkId || c.name === checkId);
  if (!check) {
    throw new ApiError('notFound', `No check "${checkId}"`, {
      hint: 'checks.list returns every check with its id.',
      details: { candidates: ctx.state().checks.map((c) => c.id) },
    });
  }
  return check;
}

function editError(error: unknown): never {
  if (error instanceof CheckEditError) {
    throw new ApiError(error.code, error.message, {
      ...(error.code === 'invalidParams'
        ? { hint: 'checks.kinds lists every kind with its parameter schema.' }
        : {}),
    });
  }
  throw error;
}

/** Checks are document edits outside the feature list: not inside a transaction, one undo step. */
function beforeEdit(ctx: ApiContext, method: string): void {
  if (ctx.transactionOpen()) {
    throw new ApiError('transactionState', `${method} is not available inside a transaction`, {
      hint: 'Commit or cancel the transaction first; a check edit is one undo step on its own.',
    });
  }
  ctx.ensureWritable();
}

/** Evaluates `checks` on the read scope of `p` (fresh; nothing reused). */
async function evaluate(ctx: ApiContext, p: Json, checks: readonly StoredCheck[]) {
  const evaluation = await ctx.readEvaluation(p);
  if (checks.some((c) => checkKind(c.kind)?.cost === 'kernel')) await ctx.kernelReady();
  return runChecks(checks, {
    evaluation,
    features: ctx.activeFeatures(p),
    kernel: ctx.kernel,
    bodyName: bodyNamer(evaluation),
    cancelled: () => false,
    budgetMs: typeof p.budgetMs === 'number' ? p.budgetMs : CHECK_BUDGET_MS,
  });
}

const RESULT =
  '{id, kind, name, status: "pass"|"fail"|"error"|"disabled"|"unsupported", value?, unit?, expected?: {min?, max?}, message, locations?: [{bodyIds, faces?: [{bodyId, faceKey}], edges?: [{bodyId, edgeKey}], segment?, point?, label?}], details?, ms}';

const SPECS: Record<string, MethodSpec> = {
  'checks.kinds': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'The check kinds this build evaluates (distance, angle, length, clearance, volume, mass, bodyCount, printable, wallThickness, buildVolume …), each with its parameter schema.',
    params: obj({}),
    result:
      '[{kind, label, summary, module, cost: "instant"|"kernel"|"worker", params: JSONSchema}]',
  },
  'checks.list': {
    kind: 'query',
    capability: 'document.read',
    summary:
      "The document's stored checks (requirements evaluated after every rebuild) with the app's latest background result when it is current (`checks.run` evaluates afresh).",
    params: obj({}),
    result: `{revision, checks: [{id, kind, name?, displayName, params, enabled, supported?, lastResult?: ${RESULT}}]}`,
  },
  'checks.add': {
    kind: 'command',
    capability: 'document.write',
    summary:
      'Adds a stored check (one undo step; not inside a transaction) and evaluates it at once on the committed document. `params` follow the kind’s schema (checks.kinds); body ids from bodies.list, faces/edges as FaceInput/EdgeInput inside MeasureTarget.',
    params: obj(
      {
        kind: str,
        params: { type: 'object', description: 'The kind’s parameters (checks.kinds).' },
        name: {
          type: 'string',
          minLength: 1,
          description: 'Label (default: described from the parameters).',
        },
        enabled: { type: 'boolean', default: true },
        expectedRevision: schemaRevision,
      },
      ['kind', 'params'],
    ),
    result: `{check, revision, result: ${RESULT}}`,
  },
  'checks.update': {
    kind: 'command',
    capability: 'document.write',
    summary:
      'Changes a check’s parameters (replaced as a whole), label (`name: null` clears it) or enabled flag: one undo step, then evaluates it.',
    params: obj(
      {
        checkId: str,
        params: { type: 'object' },
        name: { anyOf: [str, { type: 'null' }] },
        enabled: { type: 'boolean' },
        expectedRevision: schemaRevision,
      },
      ['checkId'],
    ),
    result: `{check, revision, result: ${RESULT}}`,
  },
  'checks.remove': {
    kind: 'command',
    capability: 'document.write',
    summary: 'Removes a check (one undo step).',
    params: obj({ checkId: str, expectedRevision: schemaRevision }, ['checkId']),
    result: '{checkId, revision}',
  },
  'checks.run': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Evaluates the document\'s checks (or `ids`) now on the committed document or, with `scope: "staged"`, on the open transaction\'s state, and returns structured results: status, measured value, unit, expected range, message and locations (body ids, face/edge keys, closest points). `passed` is true when no check fails or errs.',
    params: obj({
      ids: { type: 'array', items: str, minItems: 1 },
      budgetMs: {
        type: 'integer',
        minimum: 1,
        default: CHECK_BUDGET_MS,
        description: 'Kernel/worker time per check, ms.',
      },
      scope: schemaScope,
    }),
    result: `{revision, scope, passed, summary: {total, passed, failed, errors, disabled}, results: [${RESULT}]}`,
  },
};

const kindsHandler: ApiHandler = () =>
  checkKinds().map((k) => ({
    kind: k.kind,
    label: k.label,
    summary: k.summary,
    module: k.module,
    cost: k.cost,
    params: k.paramsSchema,
  }));

const list: ApiHandler = (ctx) => {
  const state = ctx.state();
  const names = bodyNamer(state.evaluation);
  const current = !resultsStale();
  const results = useCheckResults.getState().results;
  return {
    revision: ctx.revision(),
    checks: state.checks.map((check) => {
      const last = current ? results[check.id] : undefined;
      return { ...checkJson(check, names), ...(last ? { lastResult: resultJson(last) } : {}) };
    }),
  };
};

async function afterEdit(ctx: ApiContext, check: StoredCheck): Promise<Json> {
  await ctx.state().whenSettled();
  const [result] = await evaluate(ctx, { scope: 'committed' }, [check]);
  return {
    check: checkJson(check, bodyNamer(ctx.state().evaluation)),
    revision: ctx.revision(),
    ...(result ? { result: resultJson(result) } : {}),
  };
}

const add: ApiHandler = async (ctx, p) => {
  beforeEdit(ctx, 'checks.add');
  const checks = ctx.state().checks;
  let check: StoredCheck;
  try {
    check = newStoredCheck(String(p.kind), p.params as Json, checks, {
      ...(typeof p.name === 'string' ? { name: p.name } : {}),
      ...(p.enabled === false ? { enabled: false } : {}),
    });
    commitStoredChecks([...checks, check]);
  } catch (error) {
    editError(error);
  }
  return afterEdit(ctx, check);
};

const update: ApiHandler = async (ctx, p) => {
  beforeEdit(ctx, 'checks.update');
  const existing = findCheck(ctx, String(p.checkId));
  let check: StoredCheck;
  try {
    check = patchedStoredCheck(existing, {
      ...(p.params !== undefined ? { params: p.params as Json } : {}),
      ...(p.name !== undefined ? { name: p.name as string | null } : {}),
      ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
    });
    commitStoredChecks(ctx.state().checks.map((c) => (c.id === existing.id ? check : c)));
  } catch (error) {
    editError(error);
  }
  return afterEdit(ctx, check);
};

const remove: ApiHandler = async (ctx, p) => {
  beforeEdit(ctx, 'checks.remove');
  const existing = findCheck(ctx, String(p.checkId));
  try {
    commitStoredChecks(ctx.state().checks.filter((c) => c.id !== existing.id));
  } catch (error) {
    editError(error);
  }
  await ctx.state().whenSettled();
  return { checkId: existing.id, revision: ctx.revision() };
};

const run: ApiHandler = async (ctx, p) => {
  const all = ctx.state().checks;
  const ids = Array.isArray(p.ids) ? (p.ids as string[]) : null;
  const chosen = ids ? ids.map((id) => findCheck(ctx, id)) : all;
  const results = await evaluate(ctx, p, chosen);
  const summary = summarizeResults(results);
  return {
    revision: ctx.revision(),
    scope: ctx.transactionOpen() && p.scope !== 'committed' ? 'staged' : 'committed',
    passed: summary.failed === 0 && summary.errors === 0,
    summary,
    results: results.map(resultJson),
  };
};

const HANDLERS: Record<string, ApiHandler> = {
  'checks.kinds': kindsHandler,
  'checks.list': list,
  'checks.add': add,
  'checks.update': update,
  'checks.remove': remove,
  'checks.run': run,
};

export const CHECKS_API: ApiContribution = {
  methods: [
    {
      order: API_ORDER.methods.checks,
      methods: Object.fromEntries(
        Object.entries(SPECS).map(([name, spec]) => [name, { spec, handler: HANDLERS[name]! }]),
      ),
    },
  ],
};
