/**
 * The agent-API contract kit (`hcasm.agent-api@1`, assembler/AGENT-API.md)
 * that every module contributing methods builds on: method and feature-kind
 * spec types, JSON-schema helpers, and {@link ApiContext} — the session
 * services a method handler runs on (the same checks, transactions and
 * kernel validation for every method, whichever module registered it).
 *
 * The session itself (dispatch, transactions, transports) is the agent-api
 * interface module (`interface/agent-api/session.ts`); modules register
 * methods with `api/registry.ts`.
 */
import type { KernelAdapter } from '../../geometry-kernel/adapter.js';
import type {
  Body,
  EvaluationResult,
  KernelFormatCapabilities,
} from '../../geometry-kernel/types.js';
import type { Feature } from '../../document/document.js';
import type { AssemblerState, SelectionItem } from '../store.js';
import type { JsonSchema } from './validate.js';

export type Json = Record<string, unknown>;

export type Capability =
  | 'document.read'
  | 'document.write'
  | 'view.write'
  | 'filesystem.read'
  | 'filesystem.write';

export type MethodKind = 'meta' | 'query' | 'command';

export interface MethodSpec {
  kind: MethodKind;
  capability: Capability;
  summary: string;
  params: JsonSchema;
  /** Prose description of the result shape. */
  result: string;
  /** `true` if the command is staged when a transaction is open. */
  transactional?: boolean;
}

export interface FeatureKindSpec {
  /** History-card name prefix ("Extrude" → "Extrude 2"). */
  label: string;
  summary: string;
  /** Schema of `params` (the stored fields of this kind). */
  params: JsonSchema;
}

// ---- schema helpers ------------------------------------------------------------------

export const schemaString: JsonSchema = { type: 'string', minLength: 1 };
export const schemaNumber: JsonSchema = { type: 'number' };
export const schemaPositive: JsonSchema = { type: 'number', exclusiveMinimum: 0 };

/** The optimistic-concurrency parameter every document write accepts. */
export const schemaRevision: JsonSchema = {
  type: 'integer',
  minimum: 0,
  description:
    'Optimistic concurrency: the command fails with `conflict` unless the document revision still equals this value.',
};

/** A closed object schema (`additionalProperties: false`). */
export function schemaObject(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  description?: string,
): JsonSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
    ...(description ? { description } : {}),
  };
}

/** A reference to a `$defs` entry. */
export const schemaRef = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });

// ---- session services ----------------------------------------------------------------

/** The part of the zustand store API the session needs. */
export interface StoreApi {
  getState(): AssemblerState;
  subscribe(listener: (state: AssemblerState, previous: AssemblerState) => void): () => void;
}

/**
 * Host services a module adds for its own methods (e.g. the print worker):
 * augment with `declare module '…/contract.js' { interface SessionHostExtensions { … } }`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type
export interface SessionHostExtensions {}

/** What the embedding process allows and provides. */
export interface SessionHost extends SessionHostExtensions {
  server: 'headless' | 'app';
  capabilities: ReadonlySet<Capability>;
  readFile?: (path: string) => Promise<Uint8Array>;
  writeFile?: (path: string, bytes: Uint8Array) => Promise<string>;
  /** App only: `true` if replacing the document would discard unsaved user work. */
  hasUnsavedChanges?: () => boolean;
  /**
   * App only: the app's own project handling, so an agent's open/new/save
   * behave like File > Open/New/Save (Items names and folders, saved views,
   * view state and reference meshes are restored or written, the unsaved
   * state is reset). Without them the session works on the features alone.
   */
  project?: {
    /** Opens an already validated project text; throws with the app's message on failure. */
    open(text: string): Promise<void>;
    newProject(name: string): void;
    /** The text File > Save would write (optionally under another project name). */
    text(projectName?: string): Promise<string>;
  };
}

/** What a document mutation hands back to {@link ApiContext.write}. */
export interface WriteOutcome {
  features: Feature[];
  touched: string[];
  selection?: SelectionItem[];
  result: Json;
}

/**
 * The session services a method handler runs on. Reads honour `scope`
 * (the open transaction's staged state or the committed document); writes
 * go through {@link ApiContext.write}: validated by the kernel, staged in a
 * transaction or committed as one undo step.
 */
export interface ApiContext {
  readonly store: StoreApi;
  readonly kernel: KernelAdapter;
  readonly host: SessionHost;
  /** The current document revision (optimistic concurrency). */
  revision(): number;
  /** Whether an agent transaction is open. */
  transactionOpen(): boolean;
  /** The store state (shorthand for `store.getState()`). */
  state(): AssemblerState;
  /** Throws `busy` while a UI tool runs, `internal` when the kernel is unusable. */
  ensureWritable(): void;
  /** Throws `transactionState` inside a transaction. */
  ensureNoTx(what: string): void;
  /** Throws `permissionDenied` unless the host granted `capability`. */
  requireCapability(capability: Capability, what: string): void;
  /** Resolves once the kernel is loaded. */
  kernelReady(): Promise<void>;
  capabilities(): KernelFormatCapabilities | null;
  /** Evaluates `features` on the kernel's preview channel (never touches the store). */
  evaluate(features: Feature[], commitCheck?: readonly string[]): Promise<EvaluationResult>;
  /** The committed document's evaluation, once the store settled. */
  committedEvaluation(): Promise<EvaluationResult>;
  readEvaluation(p: Json): Promise<EvaluationResult>;
  readFeatures(p: Json): Feature[];
  /** The steps the read evaluation comes from (above the History rollback bar). */
  activeFeatures(p: Json): Feature[];
  /** Runs a document mutation (see the interface comment). */
  write(
    method: string,
    mutate: (
      features: Feature[],
      evaluation: EvaluationResult,
    ) => WriteOutcome | Promise<WriteOutcome>,
  ): Promise<Json>;
  /** Throws `featureFailed` when a touched feature has a kernel error. */
  assertNoFeatureErrors(touched: readonly string[], evaluation: EvaluationResult): void;
  /** `{errors, warnings, bodies}` of an evaluation. */
  evaluationSummary(evaluation: EvaluationResult): Json;
  /**
   * Meshes of `bodyIds` at `p.resolution` (`current`: the evaluated display
   * meshes; presets re-tessellate in the kernel).
   */
  exportMeshes(
    p: Json,
    bodyIds: string[],
  ): Promise<{ id: string; name: string; mesh: Body['mesh'] }[]>;
  /** Bytes as a file at `path` (headless) or base64 inline. */
  deliver(bytes: Uint8Array, mediaType: string, path: unknown): Promise<Json>;
  /** A file's bytes from `path` (headless) or inline `data`. */
  readFile(p: Json, fallbackName: string): Promise<{ bytes: Uint8Array; fileName: string }>;
  allocateFeatureId(kind: string): string;
  nextFeatureName(prefix: string, features: readonly Feature[]): string;
  /** The feature `featureId` of `features`; throws `notFound` (with the candidates) otherwise. */
  findFeature(features: readonly Feature[], featureId: string): Feature;
  /**
   * The feature as the `.hcasm` validator stores it (the persistence
   * contract); throws `invalidParams` naming the bad field otherwise.
   */
  validateStored(feature: Feature): Feature;
}
