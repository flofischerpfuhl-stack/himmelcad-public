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
import type { KernelAdapter } from '../../foundation/geometry-kernel/adapter.js';
import {
  MESH_RESOLUTIONS,
  type MeshResolution,
} from '../../foundation/geometry-kernel/meshExport.js';
import { stlAsciiForMeshes, stlBytes } from '../../kernel/stlExport.js';
import { buildThreeMf } from '../../kernel/threeMf.js';
import type { Body, EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import type { Feature } from '../../foundation/document/document.js';
import type { SketchFeature } from '../../foundation/sketch-solver/sketchFeature.js';
import { parseMirroredSketchId, type TransformFeature } from '../../model/features.js';
import { referenceMeshIdOf } from '../../model/referenceMesh.js';
import {
  analyzePrintability,
  bodyToPrintInput,
  type PrintBodyInput,
  type PrintReport,
} from '../../print/analysis.js';
import {
  placementFor,
  rankOrientations,
  rotationToDown,
  type OrientationCandidate,
  type OrientationMesh,
  type PlacementTransform,
} from '../../print/orientation.js';
import {
  orientationInput,
  orientFeatureName,
  placeOnPlateFeature,
  placementFeature,
  PlacementError,
} from '../../print/placement.js';
import {
  DEFAULT_PRINT_SETTINGS,
  MATERIAL_PRESETS,
  sanitizePrintSettings,
  type PrintSettings,
} from '../../print/settings.js';
import { candidateJson, printReportJson } from '../../api/printApi.js';
import { resolveFaceInput } from '../../foundation/commands/api/references.js';
import { consumedSketchIds } from '../../model/modeling.js';
import { resolveParameterValues } from '../../foundation/document/parameters.js';
import type { ParameterChange } from '../../model/parameterEdits.js';
import { runMeasureQuery } from '../../api/measureApi.js';
import {
  exportDxf,
  importDxf,
  importMesh,
  importStep as importStepCommand,
  importIges,
  IGES_UNAVAILABLE,
  interopFormats,
  meshToSolid,
  stepExportOptions,
} from '../../api/interopApi.js';
import { stepAssemblyFromItems } from '../../interop/stepTree.js';
import { useItemsStore } from '../shell-ui/items.js';
import {
  ProjectFormatError,
  loadProjectFile,
  saveProjectFile,
} from '../../foundation/document/format.js';
import type { SelectionItem } from '../../foundation/commands/store.js';
import { rememberRegions } from '../../foundation/sketch-solver/regionMemory.js';
import { ADVANCED_SKETCH_METHODS, advancedSketchEdit } from '../../api/sketchAdvancedApi.js';
import {
  describeBody,
  describeEdge,
  describeFace,
  findBody,
  selectEdges,
  selectFaces,
} from '../../foundation/commands/api/describe.js';
import { ApiError } from '../../foundation/commands/api/errors.js';
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
} from '../../api/sketchApi.js';
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
import type {
  SketchConstraintKind,
  SketchData,
  SketchDimensionKind,
  Vec2,
} from '../../foundation/sketch-solver/types.js';

export type { SessionHost, StoreApi } from '../../foundation/commands/api/contract.js';

/**
 * Host services of the print methods (moves to the print module with them):
 * app only, the print worker and the Printability panel's settings.
 */
declare module '../../foundation/commands/api/contract.js' {
  interface SessionHostExtensions {
    /**
     * App only: runs printability jobs off the UI thread (the print worker).
     * Without it (headless) they run in-process.
     */
    printability?: {
      analyze(bodies: PrintBodyInput[], settings: PrintSettings): Promise<PrintReport>;
      orient(
        mesh: OrientationMesh,
        thresholdDeg: number,
        faceLabels: string[],
      ): Promise<OrientationCandidate[]>;
    };
    /** App only: the user's print settings (Printability panel), the defaults for agent queries. */
    printSettings?: () => PrintSettings;
  }
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

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeParameter(p: {
  id: string;
  name: string;
  unit: string;
  value: number;
  expression?: string;
}): Json {
  return {
    id: p.id,
    name: p.name,
    unit: p.unit,
    value: p.value,
    ...(p.expression !== undefined ? { expression: p.expression } : {}),
  };
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
      case 'sketches.list':
        return this.listSketches(p);
      case 'datums.list':
        return this.listDatums(p);
      case 'selection.get':
        return this.store.getState().selection;
      case 'selection.set':
        return this.setSelection(p);
      case 'measure.get':
      case 'measure.distance':
      case 'measure.angle':
      case 'measure.area':
      case 'measure.volume':
        return runMeasureQuery(method, p, {
          evaluation: await this.readEvaluation(p),
          features: this.activeFeatures(p),
          kernel: this.kernel,
        });
      case 'parameters.list':
        return this.store.getState().parameters.map(describeParameter);
      case 'parameter.create':
        return this.createParameter(p);
      case 'parameter.edit':
        return this.editParameter(p);
      case 'parameter.delete':
        return this.deleteParameter(p);
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
      case 'sketch.addSpline':
      case 'sketch.addEllipse':
      case 'sketch.addSlot':
      case 'sketch.addPolygon':
      case 'sketch.addText':
      case 'sketch.mirror':
      case 'sketch.pattern':
      case 'sketch.roundCorner':
      case 'sketch.project':
      case 'sketch.setReference':
        return this.write(method, (f, e) => this.editSketch(method, p, f, e));
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
      case 'export.iges':
        return this.exportBodies(method, p);
      case 'export.meshStats':
        return this.meshStats(p);
      case 'print.analyze':
        return this.printAnalyze(p);
      case 'print.orientations':
        return this.printOrientations(p);
      case 'print.placeOnPlate':
        return this.write('print.placeOnPlate', (f, e) => this.placeOnPlate(p, f, e));
      case 'print.orient':
        return this.write('print.orient', (f, e) => this.printOrient(p, f, e));
      case 'import.step':
        return importStepCommand(this.interop(), p);
      case 'import.iges':
        return importIges(this.interop(), p);
      case 'interop.formats':
        return interopFormats(this.interop());
      case 'import.mesh':
        return importMesh(this.interop(), p);
      case 'import.dxf':
        return importDxf(this.interop(), p);
      case 'export.dxf':
        return exportDxf(this.interop(), p);
      case 'mesh.toSolid':
        return meshToSolid(this.interop(), p);
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

  private async listSketches(p: Json): Promise<Json[]> {
    const features = this.readFeatures(p);
    const evaluation = await this.readEvaluation(p);
    const consumed = consumedSketchIds(features);
    return features
      .filter((f): f is SketchFeature => f.kind === 'sketch')
      .map((sketch): Json => {
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
      })
      .concat(
        // Mirrored sketches and faces (Mirror steps): profiles only, referenced by their id.
        evaluation.sketches
          .filter((s) => parseMirroredSketchId(s.featureId) !== null)
          .map((s) => {
            const mirror = features.find(
              (f) => f.id === parseMirroredSketchId(s.featureId)!.mirrorId,
            );
            return {
              featureId: s.featureId,
              name: `${mirror?.name ?? 'Mirror'} sketch ${parseMirroredSketchId(s.featureId)!.index + 1}`,
              derivedFrom: mirror?.id ?? null,
              frame: s.frame,
              consumed: consumed.has(s.featureId),
              regions: s.profiles.map((profile) => ({
                key: profile.key,
                area: profile.area,
                center: profile.center,
              })),
            };
          }),
      );
  }

  private async listDatums(p: Json): Promise<Json[]> {
    const features = this.readFeatures(p);
    const evaluation = await this.readEvaluation(p);
    return features
      .filter((f) => f.kind === 'constructionPlane' || f.kind === 'constructionAxis')
      .map((f) => {
        const datum = evaluation.datums?.find((d) => d.featureId === f.id);
        return {
          featureId: f.id,
          name: f.name,
          kind: f.kind === 'constructionPlane' ? 'plane' : 'axis',
          frame: datum?.frame ?? null,
          center: datum?.center ?? null,
          size: datum?.size ?? null,
          ...(evaluation.errors[f.id] ? { error: evaluation.errors[f.id] } : {}),
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

  // ---- parameters --------------------------------------------------------------------

  /**
   * One parameter change through the store's planner (`model/parameterEdits.ts`,
   * the same path as the Parameters panel): dependent sketches re-solved,
   * `*Expression` fields re-resolved, kernel-validated, committed as ONE undo
   * step. Refused as a whole (nothing changes) on an invalid name/expression,
   * a sketch the solver cannot satisfy (`sketchConflict`), a feature that
   * newly fails in the kernel (`featureFailed`), or inside a transaction
   * (parameters are not staged; `transactionState`).
   */
  private async changeParameter(change: ParameterChange): Promise<{ id: string; result: Json }> {
    if (this.tx) {
      throw new ApiError('transactionState', 'Parameters cannot be changed inside a transaction', {
        hint: 'Commit or roll back the transaction first; a parameter edit is one undo step on its own.',
      });
    }
    this.ensureWritable();
    const store = this.store.getState();
    const plan = await store.planParameterChange(change);
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
    const before = await this.committedEvaluation();
    const evaluation = await this.evaluate(plan.features);
    const newlyFailing = plan.features
      .map((f) => f.id)
      .filter((id) => evaluation.errors[id] && !before.errors[id]);
    this.assertNoFeatureErrors(newlyFailing, evaluation);
    const applied = this.store.getState().applyParameterPlan(plan, { evaluation });
    if (!applied.ok) {
      throw new ApiError('conflict', applied.message, { hint: 'Re-read the document and retry.' });
    }
    await this.store.getState().whenSettled();
    return {
      id: applied.id,
      result: {
        committed: true,
        revision: this.revision,
        resolvedSketchIds: applied.resolvedSketchIds,
        changedFeatureIds: applied.changedFeatureIds,
        ...this.evaluationSummary(this.store.getState().evaluation),
      },
    };
  }

  private async createParameter(p: Json): Promise<Json> {
    const { id, result } = await this.changeParameter({
      name: String(p.name),
      unit: (typeof p.unit === 'string' ? p.unit : 'mm') as 'mm' | 'deg' | '',
      ...(typeof p.value === 'number' ? { value: p.value } : {}),
      ...(typeof p.expression === 'string' ? { expression: p.expression } : {}),
    });
    return { parameter: describeParameter(this.findParameter(id)), ...result };
  }

  /** Rename, unit, value and formula in one call are one undo step. */
  private async editParameter(p: Json): Promise<Json> {
    const existing = this.findParameter(String(p.parameterId));
    const { id, result } = await this.changeParameter({
      id: existing.id,
      ...(typeof p.name === 'string' ? { name: p.name } : {}),
      ...(typeof p.unit === 'string' ? { unit: p.unit as 'mm' | 'deg' | '' } : {}),
      ...(typeof p.value === 'number' ? { value: p.value } : {}),
      ...(typeof p.expression === 'string' ? { expression: p.expression } : {}),
      ...(p.expression === null ? { expression: null } : {}),
    });
    return { parameter: describeParameter(this.findParameter(id)), ...result };
  }

  private async deleteParameter(p: Json): Promise<Json> {
    const existing = this.findParameter(String(p.parameterId));
    const { result } = await this.changeParameter({ delete: existing.id });
    return { parameterId: existing.id, ...result };
  }
  private findParameter(parameterId: string): {
    id: string;
    name: string;
    unit: 'mm' | 'deg' | '';
    value: number;
    expression?: string;
  } {
    const parameter = this.store
      .getState()
      .parameters.find((p) => p.id === parameterId || p.name === parameterId);
    if (!parameter) {
      throw new ApiError('notFound', `No parameter "${parameterId}"`, {
        hint: 'parameters.list returns every parameter with its id and name.',
      });
    }
    return parameter;
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
  private async editSketch(
    method: string,
    p: Json,
    features: Feature[],
    evaluation: EvaluationResult,
  ): Promise<WriteOutcome> {
    const existing = this.findFeature(features, String(p.featureId));
    if (existing.kind !== 'sketch') {
      throw new ApiError('invalidParams', `"${existing.name}" is a ${existing.kind}, not a sketch`);
    }
    const data = sketchDataOf(existing);
    let next: SketchData;
    let result: Json = {};
    if ((ADVANCED_SKETCH_METHODS as readonly string[]).includes(method)) {
      const edit = await advancedSketchEdit(method, p, data, {
        featureId: existing.id,
        evaluation,
        features,
      });
      next = edit.sketch;
      result = edit.result;
    } else
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
    if (method === 'export.stl' || method === 'export.3mf') {
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

  private async meshStats(p: Json): Promise<Json> {
    const evaluation = await this.readEvaluation(p);
    const ids = Array.isArray(p.bodyIds) ? (p.bodyIds as string[]) : null;
    for (const id of ids ?? []) findBody(evaluation, id);
    const bodyIds = ids ?? evaluation.bodies.map((b) => b.id);
    if (bodyIds.length === 0) {
      throw new ApiError('invalidParams', 'There are no bodies', {
        hint: 'Create a body first (e.g. a sketch and an extrude).',
      });
    }
    const meshes = await this.exportMeshes(p, bodyIds);
    const counts = meshes.map((m) => ({
      id: m.id,
      name: evaluation.bodies.find((b) => b.id === m.id)?.name ?? m.name,
      triangles: m.mesh.indices.length / 3,
    }));
    const triangles = counts.reduce((s, c) => s + c.triangles, 0);
    return {
      resolution: (p.resolution as string | undefined) ?? 'current',
      bodies: counts,
      triangles,
      stlBinaryBytes: 84 + triangles * 50,
      stlAsciiBytes: stlAsciiForMeshes(meshes.map((m) => ({ name: m.name, mesh: m.mesh })))
        .byteLength,
    };
  }

  private printSettings(input: unknown): PrintSettings {
    const base = this.host.printSettings?.() ?? DEFAULT_PRINT_SETTINGS;
    return sanitizePrintSettings({
      ...base,
      ...(isRecord(input) ? input : {}),
      ...(isRecord(input) && typeof input.material === 'string' && input.density === undefined
        ? {
            density: MATERIAL_PRESETS.find((m) => m.id === input.material)?.density,
            costPerKg:
              input.costPerKg ?? MATERIAL_PRESETS.find((m) => m.id === input.material)?.costPerKg,
          }
        : {}),
    });
  }

  private async printAnalyze(p: Json): Promise<Json> {
    const evaluation = await this.readEvaluation(p);
    const ids = Array.isArray(p.bodyIds) ? (p.bodyIds as string[]) : null;
    for (const id of ids ?? []) findBody(evaluation, id);
    const bodies = (ids ? evaluation.bodies.filter((b) => ids.includes(b.id)) : evaluation.bodies)
      .filter((b) => referenceMeshIdOf(b.id) === null)
      .map(bodyToPrintInput);
    const settings = this.printSettings(p.settings);
    const report = this.host.printability
      ? await this.host.printability.analyze(bodies, settings)
      : analyzePrintability(bodies, settings);
    return printReportJson(report);
  }

  private async rankedOrientations(
    p: Json,
    evaluation: EvaluationResult,
    features: readonly Feature[],
  ): Promise<OrientationCandidate[]> {
    const bodyId = String(p.bodyId);
    findBody(evaluation, bodyId);
    const threshold =
      typeof p.overhangAngleDeg === 'number'
        ? p.overhangAngleDeg
        : this.printSettings(undefined).overhangAngleDeg;
    const input = orientationInput(evaluation, features, bodyId);
    return this.host.printability
      ? this.host.printability.orient(input.mesh, threshold, input.faceLabels)
      : rankOrientations(input.mesh, threshold, {
          faceLabel: (_key, index) => input.faceLabels[index] ?? `Face ${index + 1} down`,
        });
  }

  private async printOrientations(p: Json): Promise<Json[]> {
    const evaluation = await this.readEvaluation(p);
    const candidates = await this.rankedOrientations(p, evaluation, this.readFeatures(p));
    const limit = typeof p.limit === 'number' ? p.limit : 3;
    return candidates.slice(0, limit).map(candidateJson);
  }

  private placeOnPlate(p: Json, features: Feature[], evaluation: EvaluationResult): WriteOutcome {
    const [face] = resolveFaceInput(p.face, evaluation, features, 'face', { single: true });
    if (!face) throw new ApiError('invalidParams', 'face: no face given');
    const id = this.store.getState().allocateFeatureId('transform', this.reservedIds());
    let feature: TransformFeature;
    try {
      feature = placeOnPlateFeature(evaluation, features, face.bodyId, face.key, id);
    } catch (error) {
      if (error instanceof PlacementError) {
        throw new ApiError('invalidParams', error.message, {
          hint: 'Use a planar face ("%PLANE" selector, or faces.list with surface "plane").',
        });
      }
      throw error;
    }
    if (typeof p.name === 'string') feature = { ...feature, name: p.name };
    return {
      features: [...features, feature],
      touched: [id],
      selection: [{ kind: 'body', bodyId: face.bodyId }],
      result: { featureId: id, bodyId: face.bodyId, transform: paramsOf(feature) },
    };
  }

  private async printOrient(
    p: Json,
    features: Feature[],
    evaluation: EvaluationResult,
  ): Promise<WriteOutcome> {
    const bodyId = String(p.bodyId);
    const body = findBody(evaluation, bodyId);
    if (referenceMeshIdOf(bodyId) !== null) {
      throw new ApiError('invalidParams', 'Reference meshes cannot be oriented');
    }
    let transform: PlacementTransform;
    let candidate: OrientationCandidate | null = null;
    if (typeof p.rank === 'number') {
      const candidates = await this.rankedOrientations(p, evaluation, features);
      candidate = candidates[p.rank - 1] ?? null;
      if (!candidate) {
        throw new ApiError(
          'invalidParams',
          `rank ${p.rank}: there are ${candidates.length} candidates`,
        );
      }
      transform = candidate.transform;
    } else {
      const down = p.down as [number, number, number];
      if (Math.hypot(down[0], down[1], down[2]) < 1e-9) {
        throw new ApiError('invalidParams', 'down: must not be the zero vector');
      }
      transform = placementFor(
        { positions: body.mesh.positions, min: body.min, max: body.max },
        rotationToDown(down),
      );
    }
    const id = this.store.getState().allocateFeatureId('transform', this.reservedIds());
    const feature = placementFeature(
      bodyId,
      transform,
      id,
      typeof p.name === 'string' ? p.name : orientFeatureName(features),
    );
    return {
      features: [...features, feature],
      touched: [id],
      selection: [{ kind: 'body', bodyId }],
      result: {
        featureId: id,
        bodyId,
        transform: paramsOf(feature),
        ...(candidate ? { candidate: candidateJson(candidate) } : {}),
      },
    };
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
    };
  }

  /** The import/export handlers (`interopApi.ts`) run on the general session services. */
  private interop(): ApiContext {
    return this.context();
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
    else {
      this.store.getState().loadDocument(project.features, {
        projectName: project.projectName,
        parameters: project.parameters,
      });
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
  const failing = /^Cannot export: (.*)$/s.exec(message);
  if (failing) {
    return new ApiError('featureFailed', `${what} needs every step to evaluate: ${failing[1]}`, {
      hint: 'Fix, suppress or delete the failing step (features.list shows its error), then export again; export.stl/export.3mf without a resolution use the display meshes.',
      details: { featureError: failing[1] },
    });
  }
  return new ApiError('internal', `${what} failed: ${message}`);
}
