/**
 * Check kinds and their evaluation (assembler/CHECKS.md, MODULES.md §3
 * `checkKinds`). A stored check (`document/checks.ts`) names a kind; the
 * module that owns the measurement registers the kind here — measure
 * (distance, angle, length, clearance, volume, mass), print (printable,
 * wall thickness, build volume), checks (body count) — so no domain module
 * imports another. {@link runChecks} evaluates a document's checks against
 * one evaluation: incrementally (a check whose bodies did not change keeps
 * its result), cheapest first, cancellable between checks, each kernel or
 * worker check within a time budget. The checks module runs it in the
 * background after rebuilds, for `checks.run` and, through the
 * document-checks hook (`documentChecks.ts`), on each sample of a
 * parameter sweep.
 */
import type { Feature, Vec3 } from '../document/document.js';
import { newCheckId, normalizeStoredCheck, type StoredCheck } from '../document/checks.js';
import type { KernelAdapter } from '../geometry-kernel/adapter.js';
import type { Body, EvaluationResult } from '../geometry-kernel/types.js';
import { API_DEFS } from './api/registry.js';
import { validateSchema, type JsonSchema } from './api/validate.js';
import { isReferenceMeshBodyId } from './referenceMesh.js';
import { useAssemblerStore, type SelectionItem } from './store.js';

/** An inclusive range; a missing bound is open. */
export interface CheckRange {
  min?: number;
  max?: number;
}

/** The verdict of one evaluated check. */
export type CheckStatus = 'pass' | 'fail' | 'error';

/**
 * Where a result points (click a failed check → select and frame it):
 * bodies, or faces/edges of them, and an optional spot to mark (the closest
 * points of a clearance, the centre of an overlap).
 */
export interface CheckLocation {
  bodyIds: string[];
  faces?: { bodyId: string; faceKey: string }[];
  edges?: { bodyId: string; edgeKey: string }[];
  segment?: [Vec3, Vec3];
  point?: Vec3;
  /** Short text for the marker ("0.12 mm", "overlap 3.4 mm³"). */
  label?: string;
}

export interface CheckOutcome {
  status: CheckStatus;
  /** The measured value the requirement is about (`null`: nothing to measure). */
  value?: number | null;
  /** `mm`, `deg`, `mm³`, `g`, `` (counts). */
  unit?: string;
  /** The requirement as a range (absent for yes/no checks). */
  expected?: CheckRange;
  /** One line for people: "0.12 mm — needs at least 0.30 mm". */
  message: string;
  locations?: CheckLocation[];
  /** Kind-specific structured data for agents (pairs, findings …). */
  details?: Record<string, unknown>;
}

/** What a check kind evaluates against. */
export interface CheckEnv {
  /** The evaluation the checks run on (committed, staged or a sweep variant). */
  evaluation: EvaluationResult;
  /** The (active) features `evaluation` came from: kernel queries replay them. */
  features: readonly Feature[];
  /** For exact queries (distances, clearance); `null` when unavailable. */
  kernel: KernelAdapter | null;
  /** Display name of a body (Items renames). */
  bodyName(bodyId: string): string;
  /** `true` once the run is superseded: long kinds stop early. */
  cancelled(): boolean;
  /** Kernel/worker time one check may use, ms. */
  budgetMs: number;
}

/** A numeric parameter the Checks panel edits. */
export interface CheckField {
  key: string;
  label: string;
  unit: string;
  /** May be left empty (an open range bound). */
  optional?: boolean;
  /** Smallest allowed value. */
  min?: number;
  integer?: boolean;
}

export type CheckCost = 'instant' | 'kernel' | 'worker';

export interface CheckKindDefinition {
  kind: string;
  /** Owning module id (`modules.json`). */
  module: string;
  /** Short label ("Clearance"). */
  label: string;
  /** One sentence for agents (`checks.kinds`). */
  summary: string;
  /** Short line for the Checks panel's Add list. */
  hint: string;
  /** JSON schema of `params` (closed; `$ref`s resolve against the agent-API `$defs`). */
  paramsSchema: JsonSchema;
  /** Semantic problems beyond the schema (min > max, …), or `null`. */
  problem?(params: Record<string, unknown>): string | null;
  /** One line from the parameters: "Lid ↔ Base ≥ 0.3 mm". */
  describe(params: Record<string, unknown>, bodyName: (bodyId: string) => string): string;
  /** Bodies the result depends on; `null`: every body (body count, all-pairs clearance). */
  dependsOn(params: Record<string, unknown>): readonly string[] | null;
  /** Extra input of the result besides the bodies' geometry (e.g. materials), for reuse. */
  fingerprint?(params: Record<string, unknown>, env: CheckEnv): string;
  /** `instant`: from the evaluation on the calling thread; else the kernel / a worker (background). */
  cost: CheckCost;
  /** Numeric parameters the Checks panel edits. */
  fields: readonly CheckField[];
  /** Parameters from the current selection, or why the selection does not fit. */
  fromSelection?(
    selection: readonly SelectionItem[],
    evaluation: EvaluationResult,
  ): Record<string, unknown> | string;
  evaluate(params: Record<string, unknown>, env: CheckEnv): CheckOutcome | Promise<CheckOutcome>;
}

const kinds = new Map<string, CheckKindDefinition>();

/** Registers a module's check kind (once per kind; a second registration throws). */
export function registerCheckKind(definition: CheckKindDefinition): void {
  const known = kinds.get(definition.kind);
  if (known) {
    if (known === definition) return;
    throw new Error(
      `Check kind "${definition.kind}" is registered twice (${known.module}, ${definition.module})`,
    );
  }
  kinds.set(definition.kind, definition);
}

export function checkKind(kind: string): CheckKindDefinition | undefined {
  return kinds.get(kind);
}

/** Every registered kind, in registration order. */
export function checkKinds(): readonly CheckKindDefinition[] {
  return [...kinds.values()];
}

// ---- parameters ------------------------------------------------------------------------------

/**
 * Problems of `params` for `definition`, path-qualified (`params.min: …`).
 * `lenient` (stored files): keys this build does not know are allowed and
 * kept, so a file from a newer app with extra parameters still opens.
 */
export function checkParamsProblems(
  definition: CheckKindDefinition,
  params: unknown,
  options: { lenient?: boolean } = {},
): string[] {
  const schema =
    options.lenient && definition.paramsSchema.additionalProperties === false
      ? { ...definition.paramsSchema, additionalProperties: true }
      : definition.paramsSchema;
  const problems = validateSchema(params, schema, { $defs: API_DEFS }, 'params');
  if (problems.length > 0) return problems;
  const semantic = definition.problem?.(params as Record<string, unknown>);
  return semantic ? [`params: ${semantic}`] : [];
}

/** JSON schema of a range: `min`/`max` with an optional unit hint. */
export function rangeProperties(unit: string): Record<string, JsonSchema> {
  return {
    min: { type: 'number', description: `Lower bound (inclusive), ${unit}.` },
    max: { type: 'number', description: `Upper bound (inclusive), ${unit}.` },
  };
}

/** `min ≤ max` and at least one bound. */
export function rangeProblem(params: Record<string, unknown>): string | null {
  const { min, max } = params as CheckRange;
  if (min === undefined && max === undefined) return 'give min, max or both';
  if (min !== undefined && max !== undefined && min > max) return 'min is greater than max';
  return null;
}

export function rangeOf(params: Record<string, unknown>): CheckRange {
  const out: CheckRange = {};
  if (typeof params.min === 'number') out.min = params.min;
  if (typeof params.max === 'number') out.max = params.max;
  return out;
}

/** Tolerance of a range comparison (float noise of exact kernel values), relative + absolute. */
function slack(bound: number): number {
  return 1e-9 + Math.abs(bound) * 1e-9;
}

export function inRange(value: number, range: CheckRange): boolean {
  if (range.min !== undefined && value < range.min - slack(range.min)) return false;
  if (range.max !== undefined && value > range.max + slack(range.max)) return false;
  return true;
}

/** "12.3 mm", "90°", "4 bodies": a value for messages. */
export function formatCheckValue(value: number, unit: string): string {
  const digits = unit === 'mm³' || unit === 'g' ? 2 : unit === '' ? 0 : 3;
  const text = Number(value.toFixed(digits)).toString();
  if (unit === 'deg') return `${text}°`;
  return unit ? `${text} ${unit}` : text;
}

export function formatRange(range: CheckRange, unit: string): string {
  const f = (v: number) => formatCheckValue(v, unit);
  if (range.min !== undefined && range.max !== undefined) {
    return range.min === range.max ? f(range.min) : `${f(range.min)} – ${f(range.max)}`;
  }
  if (range.min !== undefined) return `≥ ${f(range.min)}`;
  if (range.max !== undefined) return `≤ ${f(range.max)}`;
  return 'any';
}

/** The usual outcome of "value within range". */
export function rangeOutcome(
  value: number,
  range: CheckRange,
  unit: string,
  locations?: CheckLocation[],
  details?: Record<string, unknown>,
): CheckOutcome {
  const pass = inRange(value, range);
  return {
    status: pass ? 'pass' : 'fail',
    value,
    unit,
    expected: range,
    message: pass
      ? `${formatCheckValue(value, unit)} (required ${formatRange(range, unit)})`
      : `${formatCheckValue(value, unit)} — needs ${formatRange(range, unit)}`,
    ...(locations && locations.length > 0 ? { locations } : {}),
    ...(details ? { details } : {}),
  };
}

/** An `error` outcome (a reference that is gone, a kernel failure …). */
export function errorOutcome(message: string, locations?: CheckLocation[]): CheckOutcome {
  return { status: 'error', message, ...(locations ? { locations } : {}) };
}

// ---- evaluation ------------------------------------------------------------------------------

export type CheckState = CheckStatus | 'disabled' | 'unsupported';

export interface CheckResult {
  id: string;
  kind: string;
  /** Display name (the user's label or the kind's description). */
  name: string;
  state: CheckState;
  outcome?: CheckOutcome;
  /** Evaluation time, ms (0 when reused). */
  ms: number;
  /** Inputs the result was computed from; equal fingerprints reuse a result. */
  fingerprint: string;
  /** Reused from an earlier run (the inputs did not change). */
  reused?: boolean;
}

/** Display name of a check. */
export function checkDisplayName(check: StoredCheck, bodyName: (id: string) => string): string {
  if (check.name) return check.name;
  const definition = kinds.get(check.kind);
  if (!definition) return check.kind;
  try {
    const text = definition.describe(check.params, bodyName);
    return text.charAt(0).toUpperCase() + text.slice(1);
  } catch {
    return definition.label;
  }
}

function bodyKey(body: Body | undefined): string {
  if (!body) return '-';
  // `meshId` names the tessellation of one exact shape; older kernels: the shape's measures.
  return (
    body.meshId ??
    `${body.volume.toPrecision(12)}/${body.min.join(',')}/${body.max.join(',')}/${body.faces.length}`
  );
}

/** What a check's result depends on: its definition and the geometry of its bodies. */
export function checkFingerprint(
  check: StoredCheck,
  definition: CheckKindDefinition,
  env: CheckEnv,
): string {
  const ids = definition.dependsOn(check.params);
  const bodies = ids
    ? ids.map((id) => `${id}=${bodyKey(env.evaluation.bodies.find((b) => b.id === id))}`)
    : env.evaluation.bodies.map((b) => `${b.id}=${bodyKey(b)}`);
  const extra = definition.fingerprint?.(check.params, env) ?? '';
  return `${check.kind}|${JSON.stringify(check.params)}|${bodies.join(';')}|${extra}`;
}

const COST_ORDER: Record<CheckCost, number> = { instant: 0, kernel: 1, worker: 2 };

/** Evaluates one check (no reuse). Never throws: failures are `error` results. */
export async function evaluateCheck(check: StoredCheck, env: CheckEnv): Promise<CheckResult> {
  const name = checkDisplayName(check, env.bodyName);
  const definition = kinds.get(check.kind);
  if (!definition) {
    return {
      id: check.id,
      kind: check.kind,
      name,
      state: 'unsupported',
      outcome: errorOutcome(`This app does not know the check kind "${check.kind}".`),
      ms: 0,
      fingerprint: '',
    };
  }
  const fingerprint = checkFingerprint(check, definition, env);
  if (check.enabled === false) {
    return { id: check.id, kind: check.kind, name, state: 'disabled', ms: 0, fingerprint };
  }
  const problems = checkParamsProblems(definition, check.params, { lenient: true });
  if (problems.length > 0) {
    return {
      id: check.id,
      kind: check.kind,
      name,
      state: 'error',
      outcome: errorOutcome(`Invalid parameters: ${problems[0]}`),
      ms: 0,
      fingerprint,
    };
  }
  const missing = (definition.dependsOn(check.params) ?? []).filter(
    (id) => !env.evaluation.bodies.some((b) => b.id === id),
  );
  if (missing.length > 0) {
    return {
      id: check.id,
      kind: check.kind,
      name,
      state: 'error',
      outcome: errorOutcome(
        `${missing.length === 1 ? 'A body it refers to no longer exists' : 'Bodies it refers to no longer exist'} (${missing.join(', ')}).`,
      ),
      ms: 0,
      fingerprint,
    };
  }
  const started = clock();
  let outcome: CheckOutcome;
  try {
    outcome = await definition.evaluate(check.params, env);
  } catch (error) {
    outcome = errorOutcome(
      `Could not evaluate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    id: check.id,
    kind: check.kind,
    name,
    state: outcome.status,
    outcome,
    ms: clock() - started,
    fingerprint,
  };
}

export interface RunChecksOptions {
  /** Results of an earlier run, by check id: a result with the same fingerprint is reused. */
  previous?: ReadonlyMap<string, CheckResult>;
  /** Called after every check (progress, partial results). */
  onResult?: (result: CheckResult, done: number, total: number) => void;
  /**
   * Waits before each kernel/worker check (the app waits until the kernel is
   * idle so a background check never delays an edit's evaluation).
   */
  beforeBackgroundCheck?: () => Promise<void>;
}

/**
 * Evaluates `checks` against `env` (see the module comment). Results come
 * back in the order of `checks`. When `env.cancelled()` turns true the run
 * stops before the next check and returns what it has (the rest missing).
 */
export async function runChecks(
  checks: readonly StoredCheck[],
  env: CheckEnv,
  options: RunChecksOptions = {},
): Promise<CheckResult[]> {
  const order = checks
    .map((check, index) => ({
      check,
      index,
      cost: kinds.get(check.kind)?.cost ?? 'instant',
    }))
    .sort((a, b) => COST_ORDER[a.cost] - COST_ORDER[b.cost] || a.index - b.index);
  const results: (CheckResult | undefined)[] = new Array(checks.length);
  let done = 0;
  for (const { check, index, cost } of order) {
    if (env.cancelled()) break;
    const definition = kinds.get(check.kind);
    const previous = options.previous?.get(check.id);
    let result: CheckResult | null = null;
    if (definition && previous && check.enabled !== false) {
      const fingerprint = checkFingerprint(check, definition, env);
      if (previous.fingerprint === fingerprint && previous.state !== 'disabled') {
        result = {
          ...previous,
          name: checkDisplayName(check, env.bodyName),
          ms: 0,
          reused: true,
        };
      }
    }
    if (!result) {
      if (cost !== 'instant' && check.enabled !== false) await options.beforeBackgroundCheck?.();
      if (env.cancelled()) break;
      result = await evaluateCheck(check, env);
    }
    results[index] = result;
    done += 1;
    options.onResult?.(result, done, checks.length);
  }
  return results.filter((r): r is CheckResult => r !== undefined);
}

/** Counts of a set of results. */
export function summarizeResults(results: readonly CheckResult[]): {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  disabled: number;
} {
  return {
    total: results.length,
    passed: results.filter((r) => r.state === 'pass').length,
    failed: results.filter((r) => r.state === 'fail').length,
    errors: results.filter((r) => r.state === 'error' || r.state === 'unsupported').length,
    disabled: results.filter((r) => r.state === 'disabled').length,
  };
}

function clock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// ---- editing the stored checks -------------------------------------------------------------------

export class CheckEditError extends Error {
  constructor(
    message: string,
    readonly code: 'invalidParams' | 'notFound' | 'busy',
  ) {
    super(message);
    this.name = 'CheckEditError';
  }
}

/** A new stored check of `kind` (validated strictly, as the API does); throws {@link CheckEditError}. */
export function newStoredCheck(
  kind: string,
  params: Record<string, unknown>,
  existing: readonly StoredCheck[],
  options: { name?: string; enabled?: boolean } = {},
): StoredCheck {
  const definition = kinds.get(kind);
  if (!definition) {
    throw new CheckEditError(
      `Unknown check kind "${kind}" (known: ${[...kinds.keys()].join(', ')})`,
      'invalidParams',
    );
  }
  const problems = checkParamsProblems(definition, params);
  if (problems.length > 0) throw new CheckEditError(problems[0]!, 'invalidParams');
  return normalizeStoredCheck({
    id: newCheckId(existing),
    kind,
    params,
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.enabled === false ? { enabled: false } : {}),
  });
}

/** `check` with `patch` applied (params replaced as a whole, `name: null` clears the label); validated. */
export function patchedStoredCheck(
  check: StoredCheck,
  patch: { params?: Record<string, unknown>; name?: string | null; enabled?: boolean },
): StoredCheck {
  const next: StoredCheck = {
    ...check,
    ...(patch.params ? { params: patch.params } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  };
  if (patch.name === null) delete next.name;
  else if (patch.name !== undefined) next.name = patch.name;
  const definition = kinds.get(next.kind);
  if (definition && patch.params) {
    const problems = checkParamsProblems(definition, next.params);
    if (problems.length > 0) throw new CheckEditError(problems[0]!, 'invalidParams');
  }
  return normalizeStoredCheck(next);
}

/**
 * Commits a new check list as one undo step (`AssemblerState.commitChecks`);
 * throws `busy` while a tool or a sketch session owns the undo history.
 */
export function commitStoredChecks(next: StoredCheck[]): void {
  if (!useAssemblerStore.getState().commitChecks(next)) {
    throw new CheckEditError('Finish or cancel the active tool or sketch first.', 'busy');
  }
}

/** Adds a check to the document (one undo step) and returns it; throws {@link CheckEditError}. */
export function addStoredCheck(
  kind: string,
  params: Record<string, unknown>,
  options: { name?: string; enabled?: boolean } = {},
): StoredCheck {
  const checks = useAssemblerStore.getState().checks;
  const check = newStoredCheck(kind, params, checks, options);
  commitStoredChecks([...checks, check]);
  return check;
}

/** Where the UI shows a check for editing (the checks module installs its panel). */
let checkEditorSink: ((checkId: string) => void) | null = null;

export function setCheckEditorSink(sink: ((checkId: string) => void) | null): void {
  checkEditorSink = sink;
}

/** Opens the Checks panel with `checkId` in edit mode (no-op without a UI). */
export function openCheckEditor(checkId: string): void {
  checkEditorSink?.(checkId);
}

// ---- helpers for kinds -------------------------------------------------------------------------

/** The bodies a kind's optional `bodies` parameter names, or every body. */
export function bodiesOf(params: Record<string, unknown>, evaluation: EvaluationResult): Body[] {
  const ids = Array.isArray(params.bodies) ? (params.bodies as string[]) : null;
  if (!ids) return evaluation.bodies.filter((b) => !isReferenceMeshBodyId(b.id));
  return ids.map((id) => evaluation.bodies.find((b) => b.id === id)).filter((b): b is Body => !!b);
}

/** Body ids of the selection (bodies, and the bodies of selected faces/edges), without duplicates. */
export function selectedBodyIds(selection: readonly SelectionItem[]): string[] {
  const out: string[] = [];
  for (const item of selection) {
    if (item.kind === 'body' || item.kind === 'face' || item.kind === 'edge') {
      if (!out.includes(item.bodyId)) out.push(item.bodyId);
    }
  }
  return out;
}

/** `{ bodies }` of the selected bodies, or `{}` (all bodies) when nothing is selected. */
export function bodiesParamFromSelection(
  selection: readonly SelectionItem[],
): Record<string, unknown> {
  const ids = selectedBodyIds(selection);
  return ids.length > 0 ? { bodies: ids } : {};
}

/** "Lid, Base" / "all bodies". */
export function bodiesLabel(
  params: Record<string, unknown>,
  bodyName: (bodyId: string) => string,
): string {
  const ids = Array.isArray(params.bodies) ? (params.bodies as string[]) : null;
  if (!ids) return 'all bodies';
  if (ids.length > 2) return `${ids.length} bodies`;
  return ids.map(bodyName).join(', ');
}

export const BODIES_PARAM: JsonSchema = {
  type: 'array',
  items: { type: 'string', minLength: 1 },
  minItems: 1,
  description: 'Body ids (default: every body).',
};
