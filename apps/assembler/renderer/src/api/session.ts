/**
 * The canonical command layer: executes `hcasm.agent-api@1` methods
 * against the application store. The same class serves the headless CLI
 * (in-process OCCT) and the in-app loopback endpoint (OCCT worker), so both
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
import type { KernelAdapter } from '../kernel/adapter.js';
import { exportAllBodiesStl, stlBufferForMeshes } from '../kernel/stlExport.js';
import { buildThreeMf } from '../kernel/threeMf.js';
import type { EvaluationResult } from '../kernel/types.js';
import type { Feature, SketchFeature } from '../model/document.js';
import { consumedSketchIds } from '../model/modeling.js';
import { ProjectFormatError, loadProjectFile, saveProjectFile } from '../model/project/format.js';
import type { AssemblerState, SelectionItem } from '../model/store.js';
import { rememberRegions } from '../sketch/regionMemory.js';
import {
  describeBody,
  describeEdge,
  describeFace,
  findBody,
  selectEdges,
  selectFaces,
} from './describe.js';
import { ApiError } from './errors.js';
import {
  addArcShape,
  addConstraint,
  addDimension,
  addPolylineShape,
  addShape,
  deleteSketchItems,
  describeRegions,
  findDimension,
  setDimension,
  sketchDataOf,
  solveSketch,
  type ShapeResult,
  type SketchShape,
} from './sketchApi.js';
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
  type Capability,
} from './schema.js';
import { validateSchema, type JsonSchema } from './validate.js';
import type {
  SketchConstraintKind,
  SketchData,
  SketchDimensionKind,
  Vec2,
} from '../sketch/types.js';

type Json = Record<string, unknown>;

/** The part of the zustand store API the session needs. */
export interface StoreApi {
  getState(): AssemblerState;
  subscribe(listener: (state: AssemblerState, previous: AssemblerState) => void): () => void;
}

/** What the embedding process allows and provides. */
export interface SessionHost {
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

interface WriteOutcome {
  features: Feature[];
  touched: string[];
  selection?: SelectionItem[];
  result: Json;
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
      if (state.features !== previous.features) this.revision += 1;
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
      case 'sketches.list':
        return this.listSketches(p);
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
      case 'sketch.addProfile':
      case 'sketch.addPolyline':
      case 'sketch.addArc':
      case 'sketch.addConstraint':
      case 'sketch.addDimension':
      case 'sketch.setDimension':
      case 'sketch.deleteItems':
        return this.write(method, (f) => this.editSketch(method, p, f));
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
      case 'export.step':
        return this.exportBodies(method, p);
      case 'import.step':
        return this.importStep(p);
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
  private async evaluate(features: Feature[]): Promise<EvaluationResult> {
    await this.kernelReady();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      this.evalRevision += 1;
      const job = this.kernel.evaluate({
        channel: 'preview',
        revision: this.evalRevision,
        features,
      });
      const outcome = await job.outcome;
      if (outcome.kind === 'done') return outcome.result;
      if (outcome.kind === 'failed') {
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

  private async listSketches(p: Json): Promise<Json[]> {
    const features = this.readFeatures(p);
    const evaluation = await this.readEvaluation(p);
    const consumed = consumedSketchIds(features);
    return features
      .filter((f): f is SketchFeature => f.kind === 'sketch')
      .map((sketch) => {
        const evaluated = evaluation.sketches.find((s) => s.featureId === sketch.id);
        return {
          featureId: sketch.id,
          name: sketch.name,
          plane: sketch.plane,
          frame: evaluated?.frame ?? null,
          consumed: consumed.has(sketch.id),
          ...(evaluation.errors[sketch.id] ? { error: evaluation.errors[sketch.id] } : {}),
          entities: sketch.entities,
          constraints: sketch.constraints,
          dimensions: sketch.dimensions,
          regions: describeRegions(sketch, evaluated),
        };
      });
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
      const evaluation = await this.evaluate(outcome.features);
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
    const evaluation = await this.evaluate(outcome.features);
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
      .map((id) => ({ featureId: id, error: evaluation.errors[id]! }));
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
    const { sketch, dof } = await solveSketch(data);
    // Region fingerprints, like a sketch commit in the app (geometric re-binding of profiles).
    const stored = validateStored({
      ...feature,
      ...rememberRegions(sketch, feature),
    }) as SketchFeature;
    return { feature: stored, dof };
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

  /** The `sketch.*` commands: one edit of one sketch, re-solved, validated and committed as one step. */
  private async editSketch(method: string, p: Json, features: Feature[]): Promise<WriteOutcome> {
    const existing = this.findFeature(features, String(p.featureId));
    if (existing.kind !== 'sketch') {
      throw new ApiError('invalidParams', `"${existing.name}" is a ${existing.kind}, not a sketch`);
    }
    const data = sketchDataOf(existing);
    let next: SketchData;
    let result: Json = {};
    switch (method) {
      case 'sketch.addProfile': {
        const added = addShape(data, p.profile as SketchShape);
        next = added.sketch;
        result = { shape: added.added };
        break;
      }
      case 'sketch.addPolyline': {
        const added = addPolylineShape(data, p.points as Vec2[], {
          closed: p.closed === true,
          construction: p.construction === true,
          autoConstrain: p.autoConstrain !== false,
        });
        next = added.sketch;
        result = { pointIds: added.pointIds, lineIds: added.lineIds };
        break;
      }
      case 'sketch.addArc': {
        const added = addArcShape(
          data,
          p.center as Vec2,
          p.start as Vec2,
          p.end as Vec2,
          p.construction === true,
        );
        next = added.sketch;
        result = { entityIds: added.entityIds };
        break;
      }
      case 'sketch.addConstraint': {
        const added = addConstraint(data, p.kind as SketchConstraintKind, p.refs as string[]);
        next = added.sketch;
        result = { constraintId: added.constraintId };
        break;
      }
      case 'sketch.addDimension': {
        const added = addDimension(data, p.kind as SketchDimensionKind, p.refs as string[], {
          ...(typeof p.value === 'number' ? { value: p.value } : {}),
          ...(typeof p.expression === 'string' ? { expression: p.expression } : {}),
          ...(typeof p.name === 'string' ? { name: p.name } : {}),
        });
        next = added.sketch;
        result = { dimensionId: added.dimension.id, name: added.dimension.name };
        break;
      }
      case 'sketch.setDimension': {
        const dimension = findDimension(data, String(p.dimension));
        next = setDimension(data, dimension.id, {
          ...(typeof p.value === 'number' ? { value: p.value } : {}),
          ...(typeof p.expression === 'string' ? { expression: p.expression } : {}),
        });
        result = { dimensionId: dimension.id, name: dimension.name };
        break;
      }
      default:
        next = deleteSketchItems(data, p.ids as string[]);
        break;
    }
    const solved = await this.solved(existing, next);
    const dimensionId = result.dimensionId;
    if (typeof dimensionId === 'string') {
      result.value = solved.feature.dimensions.find((d) => d.id === dimensionId)?.value ?? null;
    }
    return {
      features: features.map((f) => (f.id === existing.id ? solved.feature : f)),
      touched: [existing.id],
      result: {
        featureId: existing.id,
        ...result,
        dof: solved.dof,
        // World-space centres come with the next evaluation (sketches.list).
        regions: describeRegions(solved.feature, undefined),
      },
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
    const ids = Array.isArray(p.bodyIds) ? (p.bodyIds as string[]) : null;
    for (const id of ids ?? []) findBody(evaluation, id);
    const bodies = ids ? evaluation.bodies.filter((b) => ids.includes(b.id)) : evaluation.bodies;
    if (bodies.length === 0) {
      throw new ApiError('invalidParams', 'There are no bodies to export', {
        hint: 'Create a body first (e.g. a sketch and an extrude).',
      });
    }
    const invalid = bodies.filter((b) => !b.valid).map((b) => b.id);
    let bytes: Uint8Array;
    let mediaType: string;
    if (method === 'export.stl') {
      bytes = new Uint8Array(
        ids ? stlBufferForMeshes(bodies.map((b) => b.mesh)) : exportAllBodiesStl(bodies),
      );
      mediaType = 'model/stl';
    } else if (method === 'export.3mf') {
      bytes = buildThreeMf(bodies);
      mediaType = 'model/3mf';
    } else {
      await this.kernelReady();
      bytes = await this.kernel.exportStep(this.readFeatures(p), ids ?? undefined);
      mediaType = 'model/step';
    }
    return {
      ...(await this.deliver(bytes, mediaType, p.path)),
      bodyIds: bodies.map((b) => b.id),
      ...(invalid.length ? { invalidBodyIds: invalid } : {}),
    };
  }

  private async importStep(p: Json): Promise<Json> {
    let data: string;
    let fileName: string;
    if (typeof p.path === 'string') {
      this.requireCapability('filesystem.read', 'Reading a file');
      const bytes = await this.host.readFile!(p.path);
      data = toBase64(bytes);
      fileName =
        typeof p.fileName === 'string'
          ? p.fileName
          : (p.path.split(/[\\/]/).pop() ?? 'import.step');
    } else {
      data = String(p.data);
      fileName = String(p.fileName);
    }
    const result = await this.write('import.step', (features, evaluation) =>
      this.createFeature({ kind: 'importStep', params: { data, fileName } }, features, evaluation),
    );
    const featureId = result.featureId as string;
    const bodies = (result.bodies as { id: string; createdBy: string }[]) ?? [];
    return {
      ...result,
      createdBodyIds: bodies.filter((b) => b.createdBy === featureId).map((b) => b.id),
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
    else this.store.getState().loadDocument([], { projectName: name });
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
    else this.store.getState().loadDocument(project.features, { projectName: project.projectName });
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
          projectName: typeof p.name === 'string' ? p.name : state.projectName,
          features: state.features,
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
