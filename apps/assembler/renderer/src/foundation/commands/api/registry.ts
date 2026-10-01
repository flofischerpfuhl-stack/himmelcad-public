/**
 * The agent-API registry (assembler/MODULES.md §3): methods, `$defs` and
 * feature-kind schemas contributed by the modules, merged into the one
 * `hcasm.agent-api@1` contract. Contributions come in blocks with an
 * `order`, so the published schema keeps a stable key order whichever
 * module registers first — `test/api/contract.test.ts` compares it byte for
 * byte with `apps/assembler/api/agent-api-v1.schema.json`.
 *
 * {@link API_METHODS}, {@link API_DEFS} and {@link API_FEATURE_KINDS} are
 * live objects, rebuilt in place on every registration.
 */
import type { ApiContext, FeatureKindSpec, Json, MethodSpec } from './contract.js';
import type { JsonSchema } from './validate.js';

/** Runs one method; throws `ApiError`. `params` are already schema-validated. */
export type ApiHandler = (ctx: ApiContext, params: Json, method: string) => unknown;

export interface ApiMethod {
  spec: MethodSpec;
  /** Absent for methods the session implements itself (the agent-api module's core). */
  handler?: ApiHandler;
}

export interface ApiContribution {
  methods?: readonly { order: number; methods: Readonly<Record<string, ApiMethod>> }[];
  defs?: readonly { order: number; defs: Readonly<Record<string, JsonSchema>> }[];
  featureKinds?: readonly { order: number; kinds: Readonly<Record<string, FeatureKindSpec>> }[];
}

/**
 * Block orders of the published schema. `$defs`, feature kinds and methods
 * each have their own sequence; keep gaps for new blocks.
 */
export const API_ORDER = {
  defs: {
    coreHead: 100,
    printSettings: 110,
    coreMid: 120,
    measure: 122,
    coreSketch: 124,
    parameter: 130,
    coreTail: 140,
    printFeatures: 900,
  },
  featureKinds: {
    core: 100,
    modeling: 200,
    construction: 300,
    modelingTail: 400,
    directEdit: 500,
    printFeatures: 900,
  },
  methods: {
    coreHead: 100,
    sketchesList: 110,
    datumsList: 120,
    coreSelection: 130,
    parameters: 200,
    measure: 250,
    coreFeatures: 300,
    sketchEdits: 310,
    coreTail: 320,
    importStep: 330,
    coreProject: 340,
    print: 400,
    interop: 500,
  },
} as const;

interface Block<T> {
  order: number;
  sequence: number;
  module: string;
  entries: Readonly<Record<string, T>>;
}

const methodBlocks: Block<ApiMethod>[] = [];
const defBlocks: Block<JsonSchema>[] = [];
const kindBlocks: Block<FeatureKindSpec>[] = [];

/** Every method of this build, in contract order (live). */
export const API_METHODS: Record<string, MethodSpec> = {};
/** Every `$defs` entry, in contract order (live). */
export const API_DEFS: Record<string, JsonSchema> = {};
/** Every feature-kind parameter schema, in contract order (live). */
export const API_FEATURE_KINDS: Record<string, FeatureKindSpec> = {};
const handlers = new Map<string, ApiHandler>();

/** Throws if a key of `added` is already registered (in `blocks` or earlier in `added`). */
function assertUnique<T>(
  blocks: readonly Block<T>[],
  added: readonly Block<T>[],
  what: string,
): void {
  const seen = new Map<string, string>();
  for (const block of [...blocks, ...added]) {
    for (const key of Object.keys(block.entries)) {
      const owner = seen.get(key);
      if (owner)
        throw new Error(`API ${what} "${key}" is registered twice (${owner}, ${block.module})`);
      seen.set(key, block.module);
    }
  }
}

function merge<T, R>(blocks: Block<T>[], target: Record<string, R>, map: (entry: T) => R): void {
  blocks.sort((a, b) => a.order - b.order || a.sequence - b.sequence);
  for (const key of Object.keys(target)) delete target[key];
  for (const block of blocks) {
    for (const [key, entry] of Object.entries(block.entries)) target[key] = map(entry);
  }
}

function blocksOf<T>(
  module: string,
  list: readonly { order: number; entries: Readonly<Record<string, T>> }[],
  existing: readonly Block<T>[],
): Block<T>[] {
  return list.map((block, i) => ({
    order: block.order,
    sequence: existing.length + i,
    module,
    entries: block.entries,
  }));
}

/**
 * Registers a module's methods (with their handlers), `$defs` and
 * feature-kind schemas. A name registered twice throws and leaves the
 * registry unchanged.
 */
export function registerApiContribution(module: string, contribution: ApiContribution): void {
  const methods = blocksOf(
    module,
    (contribution.methods ?? []).map((b) => ({ order: b.order, entries: b.methods })),
    methodBlocks,
  );
  const defs = blocksOf(
    module,
    (contribution.defs ?? []).map((b) => ({ order: b.order, entries: b.defs })),
    defBlocks,
  );
  const kinds = blocksOf(
    module,
    (contribution.featureKinds ?? []).map((b) => ({ order: b.order, entries: b.kinds })),
    kindBlocks,
  );
  assertUnique(methodBlocks, methods, 'method');
  assertUnique(defBlocks, defs, '$defs entry');
  assertUnique(kindBlocks, kinds, 'feature kind');
  methodBlocks.push(...methods);
  defBlocks.push(...defs);
  kindBlocks.push(...kinds);
  merge(methodBlocks, API_METHODS, (m) => m.spec);
  merge(defBlocks, API_DEFS, (d) => d);
  merge(kindBlocks, API_FEATURE_KINDS, (k) => k);
  for (const block of methods) {
    for (const [name, method] of Object.entries(block.entries)) {
      if (method.handler) handlers.set(name, method.handler);
    }
  }
}

/** The handler a module registered for `method`, or `undefined` (session-implemented or unknown). */
export function apiMethodHandler(method: string): ApiHandler | undefined {
  return handlers.get(method);
}
