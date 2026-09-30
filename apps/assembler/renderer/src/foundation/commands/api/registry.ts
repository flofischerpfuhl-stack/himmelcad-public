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
  /**
   * Handlers of methods whose schema another module's block still publishes
   * (phase B: a module takes over the handlers first; the schema's owner
   * hands the specs over later without changing the published order). A
   * method has at most one handler.
   */
  handlers?: Readonly<Record<string, ApiHandler>>;
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
    parameter: 130,
    coreTail: 140,
    printFeatures: 900,
  },
  featureKinds: { core: 100, printFeatures: 900 },
  methods: { coreHead: 100, parameters: 200, coreTail: 300, print: 400, interop: 500 },
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
const handlerOwners = new Map<string, string>();

function merge<T, R>(
  blocks: Block<T>[],
  target: Record<string, R>,
  what: string,
  map: (entry: T) => R,
): void {
  const seen = new Map<string, string>();
  for (const block of blocks) {
    for (const key of Object.keys(block.entries)) {
      const owner = seen.get(key);
      if (owner)
        throw new Error(`API ${what} "${key}" is registered twice (${owner}, ${block.module})`);
      seen.set(key, block.module);
    }
  }
  blocks.sort((a, b) => a.order - b.order || a.sequence - b.sequence);
  for (const key of Object.keys(target)) delete target[key];
  for (const block of blocks) {
    for (const [key, entry] of Object.entries(block.entries)) target[key] = map(entry);
  }
}

/** Registers a module's methods, `$defs` and feature-kind schemas. */
export function registerApiContribution(module: string, contribution: ApiContribution): void {
  for (const block of contribution.methods ?? []) {
    methodBlocks.push({
      order: block.order,
      sequence: methodBlocks.length,
      module,
      entries: block.methods,
    });
  }
  for (const block of contribution.defs ?? []) {
    defBlocks.push({ order: block.order, sequence: defBlocks.length, module, entries: block.defs });
  }
  for (const block of contribution.featureKinds ?? []) {
    kindBlocks.push({
      order: block.order,
      sequence: kindBlocks.length,
      module,
      entries: block.kinds,
    });
  }
  merge(methodBlocks, API_METHODS, 'method', (m) => m.spec);
  merge(defBlocks, API_DEFS, '$defs entry', (d) => d);
  merge(kindBlocks, API_FEATURE_KINDS, 'feature kind', (k) => k);
  const setHandler = (name: string, handler: ApiHandler) => {
    const owner = handlerOwners.get(name);
    if (owner !== undefined && owner !== module)
      throw new Error(`API method "${name}" has two handlers (${owner}, ${module})`);
    handlerOwners.set(name, module);
    handlers.set(name, handler);
  };
  for (const block of contribution.methods ?? []) {
    for (const [name, method] of Object.entries(block.methods)) {
      if (method.handler) setHandler(name, method.handler);
    }
  }
  for (const [name, handler] of Object.entries(contribution.handlers ?? {})) {
    setHandler(name, handler);
  }
}

/** The handler a module registered for `method`, or `undefined` (session-implemented or unknown). */
export function apiMethodHandler(method: string): ApiHandler | undefined {
  return handlers.get(method);
}
