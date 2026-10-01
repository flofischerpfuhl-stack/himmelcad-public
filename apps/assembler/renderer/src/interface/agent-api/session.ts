/**
 * The canonical command layer: executes `hcasm.agent-api@1` methods
 * against the application store. The same class serves the headless CLI
 * (OCCT in a worker thread) and the in-app loopback endpoint (OCCT Web Worker), so both
 * transports have identical semantics.
 *
 * Invariants:
 *
 * - **One commit path.** Every state change ends in a store action the UI
 *   uses too: `commitDocumentChange` (the UI tools' `commitFeatures`),
 *   `undo`/`redo`, `loadDocument`, `select`. The API never writes
 *   `features` any other way, so undo, dirty tracking, recovery and the
 *   viewport behave exactly as for UI edits.
 * - **Validate before commit.** A write is evaluated by the kernel first
 *   (preview channel); if a feature it creates or edits fails, nothing is
 *   committed (`featureFailed`). The committed evaluation reuses that result.
 * - **Transactions.** `transaction.begin` stages following writes on a
 *   private copy of the feature list; `transaction.commit` commits the
 *   staged list as exactly one undo step, `transaction.cancel` drops it —
 *   the store is never touched before commit, so cancel leaves no trace.
 * - **Serialized.** Requests of a session run strictly one after another.
 *   In the app, writes are rejected (`busy`) while a UI tool session is
 *   active, and a transaction commit fails with `conflict` if the document
 *   changed since `begin` (no silent merge with the user's edits).
 */
import type { KernelAdapter } from '../../foundation/geometry-kernel/adapter.js';
import {
  isKernelTimeout,
  type KernelTimeoutError,
} from '../../foundation/geometry-kernel/timeout.js';
import {
  MESH_RESOLUTIONS,
  type MeshResolution,
} from '../../foundation/geometry-kernel/meshExport.js';
import { stlBytes } from '../../foundation/geometry-kernel/stlExport.js';
import { buildThreeMf } from '../../foundation/geometry-kernel/threeMf.js';
import { objBytes } from '../../foundation/geometry-kernel/objExport.js';
import type { Body, EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import type { Feature } from '../../foundation/document/document.js';
import type { SketchFeature } from '../../foundation/sketch-solver/sketchFeature.js';
import { resolveParameterValues } from '../../foundation/document/parameters.js';
import { IGES_UNAVAILABLE, stepExportOptions } from '../../modules/interop/interopApi.js';
import { stepAssemblyFromItems } from '../../modules/interop/stepTree.js';
import { useItemsStore, withDisplayNames } from '../../foundation/commands/items.js';
import {
  collectProjectSections,
  loadProjectSections,
} from '../../foundation/document/projectSections.js';
import {
  ProjectFormatError,
  loadProjectFile,
  saveProjectFile,
} from '../../foundation/document/format.js';
import type { SelectionItem } from '../../foundation/commands/store.js';
import {
  describeBody,
  describeEdge,
  describeFace,
  findBody,
  selectEdges,
  selectFaces,
} from '../../foundation/commands/api/describe.js';
import { ApiError } from '../../foundation/commands/api/errors.js';
import { sketchDataOf, type ShapeResult } from '../../modules/sketching/sketchApi.js';
import { solvedSketchFeature } from '../../modules/sketching/api.js';
import {
  buildEditedFeature,
  buildNewFeature,
  featureLabel,
  idSegment,
  nextFeatureName,
  paramsOf,
  validateStored,
} from './featureKinds.js';
import {
  AGENT_API_SCHEMA,
  API_ID,
  API_VERSION,
  DEFS,
  FEATURE_KIND_SCHEMAS,
  METHODS,
} from './schema.js';
import { validateSchema, type JsonSchema } from '../../foundation/commands/api/validate.js';
import type {
  ApiContext,
  Json,
  SessionHost,
  StoreApi,
  WriteOutcome,
  Capability,
} from '../../foundation/commands/api/contract.js';
import { apiMethodHandler } from '../../foundation/commands/api/registry.js';
import type { SketchData } from '../../foundation/sketch-solver/types.js';

export type { SessionHost, StoreApi } from '../../foundation/commands/api/contract.js';

export const HEADLESS_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'document.read',
  'document.write',
  'view.write',
  'filesystem.read',
  'filesystem.write',
]);

/** In-app endpoint: no filesystem paths — the client writes returned bytes itself. */
export const APP_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'document.read',
  'document.write',
  'view.write',
]);

export const APP_VERSION = '0.1.0-phase1';
const SCHEMA_ROOT: JsonSchema = { $defs: DEFS };
/** Inline export payload limit (base64 in JSON); larger results need a `path` (headless). */
export const MAX_INLINE_EXPORT_BYTES = 64 * 1024 * 1024;

interface Transaction {
  id: string;
  label: string;
  baseFeatures: Feature[];
  baseRevision: number;
  staged: Feature[];
  evaluation: EvaluationResult | null;
  commands: string[];
  touched: Set<string>;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export class AgentSession {
  private readonly store: StoreApi;
  private readonly kernel: KernelAdapter;
  private readonly host: SessionHost;
  private revision = 0;
  private evalRevision = 0;
  private tx: Transaction | null = null;
  private txCounter = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: () => void;

  constructor(options: { store: StoreApi; kernel: KernelAdapter; host: SessionHost }) {
    this.store = options.store;
    this.kernel = options.kernel;
    this.host = options.host;
    this.unsubscribe = this.store.subscribe((state, previous) => {
      if (state.features !== previous.features || state.parameters !== previous.parameters) {
        this.revision += 1;
      }
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.tx = null;
  }

  /** Current document revision (bumped on every committed feature-list change, including undo/redo). */
  get documentRevision(): number {
    return this.revision;
  }

  get transactionOpen(): boolean {
    return this.tx !== null;
  }

  /** Executes one method; calls are serialized. Throws {@link ApiError}. */
  handle(method: string, params: unknown): Promise<unknown> {
    const run = this.queue.then(() => this.dispatch(method, params));
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---- dispatch ------------------------------------------------------------------

  private async dispatch(method: string, rawParams: unknown): Promise<unknown> {
    const spec = METHODS[method];
    if (!spec) {
      throw new ApiError('methodNotFound', `Unknown method "${method}"`, {
        hint: 'api.describe lists every method.',
        details: { candidates: similarMethods(method) },
      });
    }
    if (!this.host.capabilities.has(spec.capability)) {
      throw new ApiError('permissionDenied', `"${method}" needs capability ${spec.capability}`);
    }
    const params = rawParams === undefined || rawParams === null ? {} : rawParams;
    const problems = validateSchema(params, spec.params, SCHEMA_ROOT);
    if (problems.length > 0) {
      throw new ApiError('invalidParams', `${method}: ${problems[0]}`, {
        details: { problems },
      });
    }
    const p = params as Json;
    if (spec.kind === 'command' && spec.capability === 'document.write') {
      if (method !== 'transaction.begin') this.checkRevision(p);
    }
    try {
      return await this.run(method, p);
    } catch (error) {
      // A kernel job stopped by its time budget, wherever it ran (module handlers included).
      if (!(error instanceof ApiError) && isKernelTimeout(error)) {
        throw kernelTimeoutError(
          error instanceof Error ? error.message : String(error),
          (error as KernelTimeoutError).budgetMs,
        );
      }
      throw error;
    }
  }

  private async run(method: string, p: Json): Promise<unknown> {
    // Methods a module registered with a handler (`foundation/commands/api/registry.ts`).
    const handler = apiMethodHandler(method);
    if (handler) return handler(this.context(), p, method);
    switch (method) {
      case 'api.hello':
        return this.hello();
      case 'api.describe':
        return AGENT_API_SCHEMA;
      case 'document.get':
        return this.documentInfo();
      case 'features.list':
        return this.listFeatures(p);
      case 'feature.get':
        return this.getFeature(p);
      case 'bodies.list':
        return (await this.readEvaluation(p)).bodies.map(describeBody);
      case 'body.get':
        return describeBody(findBody(await this.readEvaluation(p), String(p.bodyId)));
      case 'faces.list':
        return this.listFaces(p);
      case 'edges.list':
        return this.listEdges(p);
      case 'selection.get':
        return this.store.getState().selection;
      case 'selection.set':
        return this.setSelection(p);
      case 'feature.create':
        return this.write('feature.create', (f, e) => this.createFeature(p, f, e));
      case 'feature.edit':
        return this.write('feature.edit', (f, e) => this.editFeature(p, f, e));
      case 'feature.delete':
        return this.write('feature.delete', (f) => this.deleteFeature(p, f));
      case 'feature.suppress':
        return this.write('feature.suppress', (f) =>
          this.patchFeature(f, String(p.featureId), { suppressed: Boolean(p.suppressed) }),
        );
      case 'feature.rename':
        return this.write('feature.rename', (f) =>
          this.patchFeature(f, String(p.featureId), { name: String(p.name) }),
        );
      case 'transaction.begin':
        return this.beginTransaction(p);
      case 'transaction.preview':
        return this.previewTransaction();
      case 'transaction.commit':
        return this.commitTransaction(p);
      case 'transaction.cancel':
        return this.cancelTransaction();
      case 'history.undo':
      case 'history.redo':
        return this.undoRedo(method === 'history.undo');
      case 'export.stl':
      case 'export.3mf':
      case 'export.obj':
      case 'export.step':
      case 'export.iges':
        return this.exportBodies(method, p);
      case 'project.new':
        return this.newProject(p);
      case 'project.open':
        return this.openProject(p);
      case 'project.save':
        return this.saveProject(p);
      default:
        throw new ApiError('internal', `Method "${method}" has no handler`);
    }
  }

  // ---- shared helpers ------------------------------------------------------------

  private hello(): Json {
    return {
      api: API_ID,
      version: API_VERSION,
      server: this.host.server,
      capabilities: [...this.host.capabilities],
      units: 'mm',
      featureKinds: Object.keys(FEATURE_KIND_SCHEMAS),
      methods: Object.keys(METHODS),
    };
  }

  private checkRevision(p: Json): void {
    if (typeof p.expectedRevision === 'number' && p.expectedRevision !== this.revision) {
      throw new ApiError(
        'conflict',
        `Document revision is ${this.revision}, expected ${p.expectedRevision}`,
        {
          hint: 'Re-read the document (document.get / features.list) and retry against the current revision.',
          details: { revision: this.revision },
        },
      );
    }
  }

  private async kernelReady(): Promise<void> {
    if (this.kernel.status.status === 'ready') return;
    if (this.kernel.status.status === 'error') {
      throw new ApiError('internal', this.kernel.status.message);
    }
    await new Promise<void>((resolve, reject) => {
      const off = this.kernel.onStatus((status) => {
        if (status.status === 'ready') {
          queueMicrotask(() => off());
          resolve();
        } else if (status.status === 'error') {
          queueMicrotask(() => off());
          reject(new ApiError('internal', status.message));
        }
      });
    });
  }

  /** Evaluates a feature list on the kernel's preview channel (never touches the store). */
  /**
   * Evaluates `features`. `commitCheck`: the features a write commits (created or
   * edited) — their boolean results get the full B-rep check and an invalid one is
   * a feature error (`featureFailed`, nothing committed).
   */
  private async evaluate(
    features: Feature[],
    commitCheck?: readonly string[],
  ): Promise<EvaluationResult> {
    await this.kernelReady();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      this.evalRevision += 1;
      const job = this.kernel.evaluate({
        channel: 'preview',
        revision: this.evalRevision,
        features,
        ...(commitCheck && commitCheck.length > 0 ? { commitCheck } : {}),
      });
      const outcome = await job.outcome;
      if (outcome.kind === 'done') return outcome.result;
      if (outcome.kind === 'failed') {
        if (outcome.code === 'kernelTimeout') throw kernelTimeoutError(outcome.message);
        throw new ApiError('internal', `CAD kernel failed: ${outcome.message}`);
      }
      // superseded/cancelled by a UI preview: try again.
    }
    throw new ApiError('busy', 'The CAD kernel is busy with UI previews', {
      hint: 'Retry when the UI tool session has ended.',
    });
  }

  private async committedEvaluation(): Promise<EvaluationResult> {
    await this.kernelReady();
    await this.store.getState().whenSettled();
    return this.store.getState().evaluation;
  }

  private useStaged(p: Json): boolean {
    const scope = (p.scope as string | undefined) ?? 'auto';
    if (scope === 'staged' && !this.tx) {
      throw new ApiError('transactionState', 'No transaction is open (scope "staged")');
    }
    return this.tx !== null && scope !== 'committed';
  }

  private readFeatures(p: Json): Feature[] {
    return this.useStaged(p) ? this.tx!.staged : this.store.getState().features;
  }

  /** The steps the read evaluation comes from (above the History rollback bar when rolled back). */
  private activeFeatures(p: Json): Feature[] {
    if (this.useStaged(p)) return this.tx!.staged;
    const { features, rollbackBefore } = this.store.getState();
    const marker = rollbackBefore ? features.findIndex((f) => f.id === rollbackBefore) : -1;
    return marker >= 0 ? features.slice(0, marker) : features;
  }

  private async readEvaluation(p: Json): Promise<EvaluationResult> {
    if (this.useStaged(p)) return this.stagedEvaluation();
    return this.committedEvaluation();
  }

  private async stagedEvaluation(): Promise<EvaluationResult> {
    const tx = this.tx!;
    tx.evaluation ??= await this.evaluate(tx.staged);
    return tx.evaluation;
  }

  private documentInfo(): Json {
    const state = this.store.getState();
    return {
      api: API_ID,
      version: API_VERSION,
      projectName: state.projectName,
      revision: this.revision,
      units: 'mm',
      featureCount: state.features.length,
      bodyCount: state.evaluation.bodies.length,
      canUndo: state.history.canUndo,
      canRedo: state.history.canRedo,
      uiToolActive: state.activeTool !== null,
      kernel: { status: state.kernelStatus, message: state.kernelMessage },
      transaction: this.tx
        ? {
            id: this.tx.id,
            label: this.tx.label,
            commands: [...this.tx.commands],
            baseRevision: this.tx.baseRevision,
          }
        : null,
    };
  }

  private featureSummary(feature: Feature, evaluation: EvaluationResult | null): Json {
    const error = evaluation?.errors[feature.id];
    const warning = evaluation?.warnings[feature.id];
    return {
      id: feature.id,
      name: feature.name,
      kind: feature.kind,
      suppressed: feature.suppressed,
      params: paramsOf(feature),
      ...(error ? { error } : {}),
      ...(warning ? { warning } : {}),
    };
  }

  private async listFeatures(p: Json): Promise<Json[]> {
    const features = this.readFeatures(p);
    const evaluation = await this.readEvaluation(p);
    return features.map((f) => this.featureSummary(f, evaluation));
  }

  private findFeature(features: readonly Feature[], featureId: string): Feature {
    const feature = features.find((f) => f.id === featureId);
    if (!feature) {
      throw new ApiError('notFound', `No feature "${featureId}"`, {
        hint: 'features.list returns the history with ids.',
        details: { candidates: features.map((f) => ({ id: f.id, name: f.name, kind: f.kind })) },
      });
    }
    return feature;
  }

  private async getFeature(p: Json): Promise<Json> {
    const feature = this.findFeature(this.readFeatures(p), String(p.featureId));
    return this.featureSummary(feature, await this.readEvaluation(p));
  }

  private async listFaces(p: Json): Promise<Json[]> {
    const evaluation = await this.readEvaluation(p);
    const body = findBody(evaluation, String(p.bodyId));
    const features = this.readFeatures(p);
    const faces = typeof p.select === 'string' ? selectFaces(body, p.select) : body.faces;
    return faces.map((face) => ({ ...describeFace(body, face, features) }));
  }

  private async listEdges(p: Json): Promise<Json[]> {
    const evaluation = await this.readEvaluation(p);
    const body = findBody(evaluation, String(p.bodyId));
    const edges = typeof p.select === 'string' ? selectEdges(body, p.select) : body.edges;
    return edges.map((edge) => ({ ...describeEdge(body, edge) }));
  }

  private setSelection(p: Json): Json {
    const items = p.items as SelectionItem[];
    const state = this.store.getState();
    if (items.length === 0) state.clearSelection();
    items.forEach((item, i) => this.store.getState().select(item, { additive: i > 0 }));
    return { selection: this.store.getState().selection };
  }

  // ---- writes ----------------------------------------------------------------------

  private ensureWritable(): void {
    const state = this.store.getState();
    if (state.activeTool !== null) {
      throw new ApiError('busy', `A UI tool (${state.activeTool.kind}) is active`, {
        hint: 'The user is in the middle of a tool session; retry after they finish or cancel it.',
      });
    }
    if (state.kernelStatus === 'error') {
      throw new ApiError('internal', `CAD kernel unavailable: ${state.kernelMessage}`);
    }
  }

  /**
   * Runs a document mutation: outside a transaction it is validated by the
   * kernel and committed as one undo step; inside one it is staged.
   */
  private async write(
    method: string,
    mutate: (
      features: Feature[],
      evaluation: EvaluationResult,
    ) => WriteOutcome | Promise<WriteOutcome>,
  ): Promise<Json> {
    if (this.tx) {
      const tx = this.tx;
      const outcome = await mutate(tx.staged, await this.stagedEvaluation());
      const evaluation = await this.evaluate(outcome.features, outcome.touched);
      this.assertNoFeatureErrors(outcome.touched, evaluation);
      tx.staged = outcome.features;
      tx.evaluation = evaluation;
      tx.commands.push(method);
      for (const id of outcome.touched) tx.touched.add(id);
      return {
        ...outcome.result,
        committed: false,
        transactionId: tx.id,
        ...this.evaluationSummary(evaluation),
      };
    }
    this.ensureWritable();
    const base = this.store.getState().features;
    const outcome = await mutate(base, await this.committedEvaluation());
    const evaluation = await this.evaluate(outcome.features, outcome.touched);
    this.assertNoFeatureErrors(outcome.touched, evaluation);
    this.commit(base, outcome.features, evaluation, outcome.selection);
    await this.store.getState().whenSettled();
    return {
      ...outcome.result,
      committed: true,
      revision: this.revision,
      ...this.evaluationSummary(this.store.getState().evaluation),
    };
  }

  private commit(
    base: Feature[],
    next: Feature[],
    evaluation: EvaluationResult,
    selection?: SelectionItem[],
  ): void {
    this.ensureWritable();
    if (this.store.getState().features !== base) {
      throw new ApiError('conflict', 'The document changed while the command was evaluated', {
        hint: 'Re-read the document and retry.',
      });
    }
    const ok = this.store.getState().commitDocumentChange(next, {
      evaluation,
      ...(selection ? { selection } : {}),
    });
    if (!ok) throw new ApiError('busy', 'A UI tool became active; nothing was committed');
  }

  private assertNoFeatureErrors(touched: readonly string[], evaluation: EvaluationResult): void {
    const failures = touched
      .filter((id) => evaluation.errors[id])
      .map((id) => ({
        featureId: id,
        error: evaluation.errors[id]!,
        // The geometry the error points at (e.g. `edgeKeys` a fillet fails on).
        ...(evaluation.errorRefs?.[id] ? { refs: evaluation.errorRefs[id] } : {}),
      }));
    if (failures.length === 0) return;
    const first = failures[0]!;
    throw new ApiError('featureFailed', `The kernel rejected the feature: ${first.error}`, {
      hint: hintForKernelError(first.error),
      details: { failures, committed: false },
    });
  }

  private evaluationSummary(evaluation: EvaluationResult): Json {
    return {
      errors: { ...evaluation.errors },
      warnings: { ...evaluation.warnings },
      bodies: evaluation.bodies.map(describeBody),
    };
  }

  private reservedIds(): Set<string> {
    return new Set(this.tx ? this.tx.staged.map((f) => f.id) : []);
  }

  /** Current document parameter values, for a `*Expression` field. Empty when the parameters themselves fail to resolve (a pre-existing document problem, reported by `parameters.list`/`parameter.*`). */
  private currentParamValues(): ReadonlyMap<string, number> {
    const resolved = resolveParameterValues(this.store.getState().parameters);
    return resolved.ok ? resolved.values : new Map();
  }

  private async createFeature(
    p: Json,
    features: Feature[],
    evaluation: EvaluationResult,
  ): Promise<WriteOutcome> {
    const kind = String(p.kind);
    const params = isRecord(p.params) ? p.params : {};
    const id = this.store.getState().allocateFeatureId(idSegment(kind), this.reservedIds());
    const name =
      typeof p.name === 'string' ? p.name : nextFeatureName(featureLabel(kind, params), features);
    const created: { shapes?: ShapeResult[] } = {};
    let feature = buildNewFeature({
      id,
      name,
      kind,
      params,
      evaluation,
      features,
      onShapes: (s) => (created.shapes = s),
      paramValues: this.currentParamValues(),
    });
    let sketchInfo: Json = {};
    if (feature.kind === 'sketch') {
      const solved = await this.solved(feature, sketchDataOf(feature));
      feature = solved.feature;
      sketchInfo = { dof: solved.dof, ...(created.shapes ? { shapes: created.shapes } : {}) };
    }
    const next = [...features, feature];
    const selection: SelectionItem[] =
      kind === 'sketch'
        ? [{ kind: 'sketchProfile', featureId: id }]
        : kind === 'extrude'
          ? []
          : [{ kind: 'feature', featureId: id }];
    return {
      features: next,
      touched: [id],
      selection,
      result: { featureId: id, name, kind, ...sketchInfo },
    };
  }

  private async editFeature(
    p: Json,
    features: Feature[],
    evaluation: EvaluationResult,
  ): Promise<WriteOutcome> {
    const existing = this.findFeature(features, String(p.featureId));
    const params = isRecord(p.params) ? p.params : {};
    const created: { shapes?: ShapeResult[] } = {};
    let edited = buildEditedFeature({
      existing,
      params,
      evaluation,
      features,
      onShapes: (s) => (created.shapes = s),
      paramValues: this.currentParamValues(),
    });
    let sketchInfo: Json = {};
    const geometryChanged = ['entities', 'constraints', 'dimensions', 'profiles'].some(
      (key) => key in params,
    );
    if (edited.kind === 'sketch' && geometryChanged) {
      const solved = await this.solved(edited, sketchDataOf(edited));
      edited = solved.feature;
      sketchInfo = { dof: solved.dof, ...(created.shapes ? { shapes: created.shapes } : {}) };
    }
    return {
      features: features.map((f) => (f.id === existing.id ? edited : f)),
      touched: [existing.id],
      result: { featureId: existing.id, ...sketchInfo },
    };
  }

  /** Solves `data` for sketch `feature` and returns the stored (validated) solved feature. */
  private async solved(
    feature: SketchFeature,
    data: SketchData,
  ): Promise<{ feature: SketchFeature; dof: number }> {
    return solvedSketchFeature({ validateStored }, feature, data);
  }

  private deleteFeature(p: Json, features: Feature[]): WriteOutcome {
    const existing = this.findFeature(features, String(p.featureId));
    return {
      features: features.filter((f) => f.id !== existing.id),
      touched: [],
      result: { featureId: existing.id },
    };
  }

  private patchFeature(
    features: Feature[],
    featureId: string,
    patch: { suppressed?: boolean; name?: string },
  ): WriteOutcome {
    const existing = this.findFeature(features, featureId);
    return {
      features: features.map((f) => (f.id === featureId ? ({ ...f, ...patch } as Feature) : f)),
      // Unsuppressing must evaluate cleanly; suppressing/renaming cannot fail.
      touched: patch.suppressed === false ? [featureId] : [],
      result: { featureId: existing.id },
    };
  }

  // ---- transactions --------------------------------------------------------------

  private beginTransaction(p: Json): Json {
    if (this.tx) {
      throw new ApiError('transactionState', `Transaction ${this.tx.id} is already open`, {
        hint: 'Commit or cancel it first; transactions do not nest.',
      });
    }
    this.checkRevision(p);
    this.ensureWritable();
    this.txCounter += 1;
    const features = this.store.getState().features;
    this.tx = {
      id: `tx-${this.txCounter}`,
      label: typeof p.label === 'string' ? p.label : `Agent transaction ${this.txCounter}`,
      baseFeatures: features,
      baseRevision: this.revision,
      staged: features,
      evaluation: null,
      commands: [],
      touched: new Set(),
    };
    return { transactionId: this.tx.id, baseRevision: this.revision };
  }

  private requireTx(): Transaction {
    if (!this.tx) {
      throw new ApiError('transactionState', 'No transaction is open', {
        hint: 'Call transaction.begin first.',
      });
    }
    return this.tx;
  }

  private async previewTransaction(): Promise<Json> {
    const tx = this.requireTx();
    const evaluation = await this.stagedEvaluation();
    return {
      transactionId: tx.id,
      commands: [...tx.commands],
      ...this.evaluationSummary(evaluation),
    };
  }

  private async commitTransaction(p: Json): Promise<Json> {
    const tx = this.requireTx();
    if (this.store.getState().features !== tx.baseFeatures) {
      throw new ApiError(
        'conflict',
        'The document changed since the transaction began; nothing was committed',
        {
          hint: 'Cancel the transaction, re-read the document and stage the changes again.',
          details: { baseRevision: tx.baseRevision, revision: this.revision },
        },
      );
    }
    const evaluation = await this.stagedEvaluation();
    if (p.allowErrors !== true) this.assertNoFeatureErrors([...tx.touched], evaluation);
    const baseIds = new Set(tx.baseFeatures.map((f) => f.id));
    const featureIds = tx.staged.filter((f) => !baseIds.has(f.id)).map((f) => f.id);
    if (tx.staged !== tx.baseFeatures) this.commit(tx.baseFeatures, tx.staged, evaluation, []);
    this.tx = null;
    await this.store.getState().whenSettled();
    return {
      transactionId: tx.id,
      revision: this.revision,
      featureIds,
      commands: tx.commands,
      ...this.evaluationSummary(this.store.getState().evaluation),
    };
  }

  private cancelTransaction(): Json {
    const tx = this.requireTx();
    this.tx = null;
    return { transactionId: tx.id, cancelled: true };
  }

  private async undoRedo(undo: boolean): Promise<Json> {
    if (this.tx) {
      throw new ApiError('transactionState', 'Undo/redo is not available inside a transaction', {
        hint: 'Cancel the transaction to discard staged changes.',
      });
    }
    this.ensureWritable();
    const state = this.store.getState();
    if (undo ? !state.history.canUndo : !state.history.canRedo) {
      throw new ApiError('invalidParams', undo ? 'Nothing to undo' : 'Nothing to redo');
    }
    if (undo) state.undo();
    else state.redo();
    await this.store.getState().whenSettled();
    const after = this.store.getState();
    return {
      revision: this.revision,
      canUndo: after.history.canUndo,
      canRedo: after.history.canRedo,
      featureCount: after.features.length,
    };
  }

  // ---- files ------------------------------------------------------------------------

  private requireCapability(capability: Capability, what: string): void {
    if (!this.host.capabilities.has(capability)) {
      throw new ApiError(
        'permissionDenied',
        `${what} needs capability ${capability}`,
        this.host.server === 'app'
          ? {
              hint: 'The in-app endpoint never touches file paths; omit "path" and write/read the bytes in the client.',
            }
          : {},
      );
    }
  }

  private async deliver(bytes: Uint8Array, mediaType: string, path: unknown): Promise<Json> {
    if (typeof path === 'string') {
      this.requireCapability('filesystem.write', 'Writing a file');
      const written = await this.host.writeFile!(path, bytes);
      return { mediaType, byteLength: bytes.byteLength, path: written };
    }
    if (bytes.byteLength > MAX_INLINE_EXPORT_BYTES) {
      throw new ApiError('invalidParams', `Export is ${bytes.byteLength} bytes; too large inline`, {
        hint: 'Use the headless CLI with "path".',
      });
    }
    return { mediaType, byteLength: bytes.byteLength, data: toBase64(bytes) };
  }

  private async exportBodies(method: string, p: Json): Promise<Json> {
    const evaluation = await this.readEvaluation(p);
    let ids = Array.isArray(p.bodyIds) ? (p.bodyIds as string[]) : null;
    for (const id of ids ?? []) findBody(evaluation, id);
    if ((method === 'export.step' || method === 'export.iges') && p.visibleOnly === true) {
      const hidden = new Set(this.store.getState().hiddenBodyIds);
      ids = (ids ?? evaluation.bodies.map((b) => b.id)).filter((id) => !hidden.has(id));
    }
    const bodies = ids ? evaluation.bodies.filter((b) => ids.includes(b.id)) : evaluation.bodies;
    if (bodies.length === 0) {
      throw new ApiError('invalidParams', 'There are no bodies to export', {
        hint: 'Create a body first (e.g. a sketch and an extrude).',
      });
    }
    const invalid = bodies.filter((b) => !b.valid).map((b) => b.id);
    let bytes: Uint8Array;
    let mediaType: string;
    let triangles: number | undefined;
    if (method === 'export.stl' || method === 'export.3mf' || method === 'export.obj') {
      const meshes = await this.exportMeshes(
        p,
        bodies.map((b) => b.id),
      );
      triangles = meshes.reduce((s, m) => s + m.mesh.indices.length / 3, 0);
      const byId = new Map(meshes.map((m) => [m.id, m.mesh]));
      const meshed = bodies.map((b) => ({ ...b, mesh: byId.get(b.id) ?? b.mesh }));
      if (method === 'export.stl') {
        bytes = stlBytes(
          meshed.map((b) => ({ name: b.name, mesh: b.mesh })),
          p.format === 'ascii' ? 'ascii' : 'binary',
        );
        mediaType = 'model/stl';
      } else if (method === 'export.obj') {
        bytes = objBytes(withDisplayNames(meshed, useItemsStore.getState()));
        mediaType = 'model/obj';
      } else {
        bytes = buildThreeMf(meshed, { title: this.store.getState().projectName });
        mediaType = 'model/3mf';
      }
    } else if (method === 'export.iges') {
      await this.kernelReady();
      if (!this.kernel.status.capabilities?.igesWrite) {
        throw new ApiError('unsupported', IGES_UNAVAILABLE, {
          hint: 'interop.formats reports which formats the loaded kernel supports; use STEP instead.',
        });
      }
      try {
        bytes = await this.kernel.exportIges(
          this.activeFeatures(p),
          bodies.map((b) => b.id),
          {
            ...(p.unit === 'mm' || p.unit === 'cm' || p.unit === 'm' || p.unit === 'in'
              ? { unit: p.unit }
              : {}),
            ...(p.mode === 'brep' || p.mode === 'faces' ? { mode: p.mode } : {}),
          },
        );
      } catch (error) {
        throw exportFailure('IGES export', error);
      }
      mediaType = 'model/iges';
    } else {
      await this.kernelReady();
      const items = useItemsStore.getState();
      const assembly =
        p.structure === 'folders'
          ? stepAssemblyFromItems(
              this.store.getState().projectName,
              bodies.map((b) => b.id),
              items,
            )
          : undefined;
      try {
        bytes = await this.kernel.exportStep(
          this.activeFeatures(p),
          bodies.map((b) => b.id),
          stepExportOptions(p, items.names, assembly),
        );
      } catch (error) {
        throw exportFailure('STEP export', error);
      }
      mediaType = 'model/step';
    }
    return {
      ...(await this.deliver(bytes, mediaType, p.path)),
      bodyIds: bodies.map((b) => b.id),
      ...(triangles !== undefined ? { triangles } : {}),
      ...(invalid.length ? { invalidBodyIds: invalid } : {}),
    };
  }

  // ---- 3D printing -----------------------------------------------------------------

  /** Export meshes of `bodyIds` at `p.resolution` (default: the evaluated display meshes). */
  private async exportMeshes(
    p: Json,
    bodyIds: string[],
  ): Promise<{ id: string; name: string; mesh: Body['mesh'] }[]> {
    const resolution = (p.resolution as MeshResolution | undefined) ?? 'current';
    const evaluation = await this.readEvaluation(p);
    if (resolution === 'current') {
      return evaluation.bodies
        .filter((b) => bodyIds.includes(b.id))
        .map((b) => ({ id: b.id, name: b.name, mesh: b.mesh }));
    }
    await this.kernelReady();
    const preset = MESH_RESOLUTIONS[resolution];
    try {
      return await this.kernel.exportMesh(this.activeFeatures(p), {
        bodyIds,
        tolerance: preset.tolerance,
        angularTolerance: preset.angularTolerance,
      });
    } catch (error) {
      throw exportFailure('Tessellation', error);
    }
  }

  /** The session services every registered method handler runs on (`api/contract.ts`). */
  private context(): ApiContext {
    return {
      store: this.store,
      kernel: this.kernel,
      host: this.host,
      revision: () => this.revision,
      transactionOpen: () => this.tx !== null,
      state: () => this.store.getState(),
      ensureWritable: () => this.ensureWritable(),
      ensureNoTx: (what) => this.ensureNoTx(what),
      requireCapability: (capability, what) => this.requireCapability(capability, what),
      kernelReady: () => this.kernelReady(),
      capabilities: () => this.kernel.status.capabilities ?? null,
      evaluate: (features, commitCheck) => this.evaluate(features, commitCheck),
      committedEvaluation: () => this.committedEvaluation(),
      readEvaluation: (p) => this.readEvaluation(p),
      readFeatures: (p) => this.readFeatures(p),
      activeFeatures: (p) => this.activeFeatures(p),
      write: (method, mutate) => this.write(method, mutate),
      assertNoFeatureErrors: (touched, evaluation) =>
        this.assertNoFeatureErrors(touched, evaluation),
      evaluationSummary: (evaluation) => this.evaluationSummary(evaluation),
      exportMeshes: (p, bodyIds) => this.exportMeshes(p, bodyIds),
      deliver: (bytes, mediaType, path) => this.deliver(bytes, mediaType, path),
      readFile: async (p, fallbackName) => {
        if (typeof p.path === 'string') {
          this.requireCapability('filesystem.read', 'Reading a file');
          const bytes = await this.host.readFile!(p.path);
          const fileName =
            typeof p.fileName === 'string'
              ? p.fileName
              : (p.path.split(/[\\/]/).pop() ?? fallbackName);
          return { bytes, fileName };
        }
        const binary = atob(String(p.data));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return { bytes, fileName: String(p.fileName) };
      },
      allocateFeatureId: (kind) =>
        this.store.getState().allocateFeatureId(kind, this.reservedIds()),
      nextFeatureName: (prefix, features) => nextFeatureName(prefix, features),
      findFeature: (features, featureId) => this.findFeature(features, featureId),
      validateStored: (feature) => validateStored(feature),
    };
  }

  private ensureNoTx(what: string): void {
    if (this.tx) {
      throw new ApiError('transactionState', `${what} is not available inside a transaction`, {
        hint: 'Commit or cancel the transaction first.',
      });
    }
  }

  private guardDiscard(what: string): void {
    if (this.host.hasUnsavedChanges?.()) {
      throw new ApiError(
        'confirmationRequired',
        `${what} would discard unsaved changes in the app`,
        {
          hint: 'Ask the user to save (or discard) in the app first; agents cannot bypass this.',
        },
      );
    }
  }

  private async newProject(p: Json): Promise<Json> {
    this.ensureNoTx('project.new');
    this.ensureWritable();
    this.guardDiscard('Starting a new project');
    const name = typeof p.name === 'string' ? p.name : 'Untitled';
    if (this.host.project) this.host.project.newProject(name);
    else {
      this.store.getState().loadDocument([], { projectName: name });
      loadProjectSections(null);
    }
    await this.store.getState().whenSettled();
    return { projectName: name, revision: this.revision };
  }

  private async openProject(p: Json): Promise<Json> {
    this.ensureNoTx('project.open');
    this.ensureWritable();
    let text: string;
    if (typeof p.path === 'string') {
      this.requireCapability('filesystem.read', 'Reading a file');
      text = new TextDecoder().decode(await this.host.readFile!(p.path));
    } else {
      text = String(p.text);
    }
    let project;
    try {
      project = loadProjectFile(text);
    } catch (error) {
      if (error instanceof ProjectFormatError) {
        throw new ApiError('invalidParams', error.message);
      }
      throw error;
    }
    this.guardDiscard('Opening a project');
    if (this.host.project) await this.host.project.open(text);
    else {
      this.store.getState().loadDocument(project.features, {
        projectName: project.projectName,
        parameters: project.parameters,
      });
      // Headless: the modules' top-level fields (e.g. reference-image pictures) too.
      loadProjectSections(project);
    }
    await this.store.getState().whenSettled();
    const evaluation = this.store.getState().evaluation;
    return {
      projectName: project.projectName,
      featureCount: project.features.length,
      revision: this.revision,
      ...this.evaluationSummary(evaluation),
    };
  }

  private async saveProject(p: Json): Promise<Json> {
    this.ensureNoTx('project.save');
    const state = this.store.getState();
    const text = this.host.project
      ? await this.host.project.text(typeof p.name === 'string' ? p.name : undefined)
      : saveProjectFile({
          // Headless: the modules' top-level fields (e.g. reference-image pictures), no view state.
          ...(await collectProjectSections()).fields,
          projectName: typeof p.name === 'string' ? p.name : state.projectName,
          features: state.features,
          parameters: state.parameters,
          appVersion: APP_VERSION,
          createdAt: new Date().toISOString(),
        });
    const bytes = new TextEncoder().encode(text);
    if (typeof p.path === 'string') {
      this.requireCapability('filesystem.write', 'Writing a file');
      const path = await this.host.writeFile!(p.path, bytes);
      return { path, byteLength: bytes.byteLength, revision: this.revision };
    }
    return { text, byteLength: bytes.byteLength, revision: this.revision };
  }
}

function similarMethods(method: string): string[] {
  const [head] = method.split('.');
  const all = Object.keys(METHODS);
  const sameFamily = all.filter((m) => m.startsWith(`${head}.`));
  return sameFamily.length > 0 ? sameFamily : all;
}

/**
 * The kernel stopped a computation that exceeded its time budget (F13,
 * `foundation/geometry-kernel/timeout.ts`): nothing was committed.
 */
function kernelTimeoutError(message: string, budgetMs?: number): ApiError {
  return new ApiError('kernelTimeout', message, {
    hint: 'The kernel was restarted and the document is unchanged. Change the parameters (e.g. a smaller fillet radius or a different edge set), or split the operation, and retry.',
    details: { committed: false, ...(budgetMs !== undefined ? { budgetMs } : {}) },
  });
}

function hintForKernelError(error: string): string {
  if (error.startsWith('Missing reference')) {
    return 'A face/edge/body reference no longer exists; re-list faces/edges and pass current keys.';
  }
  if (/fillet|chamfer/i.test(error)) {
    return 'Try a smaller radius/distance (it must fit the adjacent faces), or fewer edges.';
  }
  if (/shell/i.test(error)) return 'Try a thinner wall or open different faces.';
  if (/too small|at least/i.test(error)) return 'Increase the dimension (minimum 0.1 mm).';
  if (/Nothing to cut/.test(error)) return 'Cut needs an existing body; use operation "new" first.';
  return 'Check the parameters against features.list / bodies.list and retry.';
}

/**
 * An exact export (STEP, IGES, a mesh at a resolution preset) replays the whole
 * document; a step that fails there is the document's state, not a kernel
 * failure: `featureFailed` with the step's error (fuzzer finding F7,
 * `assembler/ROBUSTNESS.md`). Anything else stays `internal`.
 */
function exportFailure(what: string, error: unknown): ApiError {
  const message = error instanceof Error ? error.message : String(error);
  if (isKernelTimeout(error)) {
    return kernelTimeoutError(`${what}: ${message}`, (error as KernelTimeoutError).budgetMs);
  }
  const failing = /^Cannot export: (.*)$/s.exec(message);
  if (failing) {
    return new ApiError('featureFailed', `${what} needs every step to evaluate: ${failing[1]}`, {
      hint: 'Fix, suppress or delete the failing step (features.list shows its error), then export again; export.stl/export.3mf without a resolution use the display meshes.',
      details: { featureError: failing[1] },
    });
  }
  return new ApiError('internal', `${what} failed: ${message}`);
}
