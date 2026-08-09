import type {
  AppJournalPage,
  AppJournalReadRequest,
  AppDocumentSnapshot,
  AppProtocolExtensions,
  AppProtocolRequest,
  AppProtocolRequestEnvelope,
  AppProtocolResponse,
  AppProtocolResponseEnvelope,
  CanonicalCommandTransaction,
  CanonicalJournalEntry,
  CanonicalRepresentationAdmission,
  GeometryResource,
  MultiEntityPropertyEditRequest,
  PropertyNamespaceSchema,
  PropertyQueryRequest,
  PropertyQueryResult,
} from './canonicalProtocol.js';
import { APP_PROTOCOL_MAX_JOURNAL_PAGE_SIZE, APP_PROTOCOL_SCHEMA_ID } from './canonicalProtocol.js';
import { ContractValidationError, createRemoteError } from './errors.js';
import type {
  AppProtocolMethods,
  JsonValue,
  NegotiatedSession,
  RpcMethodDefinition,
  RpcRequestOptions,
  RpcTransport,
} from './protocol.js';
import { requireCapability } from './protocol.js';

export interface PageRequest {
  readonly cursor?: string;
  readonly limit: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export type IoCapability = 'import' | 'export';

export interface IoProviderOptionContract {
  readonly schema: JsonValue;
  readonly defaults: JsonValue;
}

/** Exact read-only provider metadata from the shared canonical I/O registry. */
export interface IoFormatDescriptor {
  readonly schemaVersion: number;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly displayName: string;
  readonly formatIds: readonly string[];
  readonly extensions: readonly string[];
  readonly mediaTypes: readonly string[];
  readonly capabilities: readonly IoCapability[];
  readonly importOptions: IoProviderOptionContract | null;
  readonly exportOptions: IoProviderOptionContract | null;
}

export interface IoImportProviderSelection {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly formatId: string;
  readonly confidence: number;
}

export interface IoProbeRequest {
  /** Host-owned source capability. Never persist this path as project truth. */
  readonly sourcePath: string;
  readonly mediaType?: string;
}

export interface IoImportExecuteRequest {
  readonly operationId: string;
  readonly commandId: string;
  /** Host-owned source capability. */
  readonly sourcePath: string;
  readonly selection: IoImportProviderSelection;
  readonly options: JsonValue;
}

export interface IoImportCommit {
  readonly journalEntry: CanonicalJournalEntry;
  readonly inventory: JsonValue;
}

export interface RegistrationPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface RegistrationSimilarity3d {
  readonly tx: number;
  readonly ty: number;
  readonly tz: number;
  readonly rxRadians: number;
  readonly ryRadians: number;
  readonly rzRadians: number;
  readonly scale: number;
}

export interface RegistrationRobustFitOptions {
  readonly maximumIterations: number;
  readonly huberDeltaMeters: number;
  readonly convergenceEpsilon: number;
}

export interface RegistrationIcpOptions {
  readonly maximumIterations: number;
  readonly maximumCorrespondenceDistance: number;
  readonly convergenceTranslationMeters: number;
  readonly convergenceRotationRadians: number;
  readonly minimumOverlapRatio: number;
  readonly huberDeltaMeters: number;
}

export type RegistrationRecipeMethod =
  | { readonly kind: 'sourceCoordinates'; readonly frozenTransformSha256?: string }
  | {
      readonly kind: 'originAndProjectNorth';
      readonly sourceOrigin: RegistrationPoint;
      readonly targetOrigin: RegistrationPoint;
      readonly projectNorthDegrees: number;
      readonly scale: number;
    }
  | { readonly kind: 'manualPlacement'; readonly transform: RegistrationSimilarity3d }
  | {
      readonly kind: 'pointPairs';
      readonly model: 'translation3D' | 'rigid3D' | 'similarity3D';
      readonly robust: RegistrationRobustFitOptions;
      readonly offerIcpRefinement: boolean;
    }
  | {
      readonly kind: 'icp';
      readonly mode: 'pointToPoint' | 'pointToPlane';
      readonly options: RegistrationIcpOptions;
    };

/** Persistable registration template. It intentionally has no viewport picks. */
export interface RegistrationRecipe {
  readonly schemaVersion: 1;
  readonly recipeId: string;
  readonly label: string;
  readonly method: RegistrationRecipeMethod;
}

export interface RegistrationPointPair {
  readonly pairId: string;
  readonly source: RegistrationPoint;
  readonly target: RegistrationPoint;
  readonly weight?: number;
}

export interface RegistrationTargetSample {
  readonly position: RegistrationPoint;
  readonly normal?: RegistrationPoint;
}

export interface RegistrationSourceSamples {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly datasetId: string;
  readonly samplingMethod: string;
  readonly sourceTransform: readonly number[] | null;
  readonly resourceHashes: readonly string[];
  readonly points: readonly RegistrationPoint[];
}

export interface RegistrationResidualSummary {
  readonly count: number;
  readonly rmsHorizontalMeters: number;
  readonly rmsVerticalMeters: number;
  readonly rmsSpatialMeters: number;
  readonly maxSpatialMeters: number;
}

export interface RegistrationPreview {
  readonly transform: RegistrationSimilarity3d;
  readonly residuals: RegistrationResidualSummary;
  readonly iterations: number;
  readonly matchedSamples: number;
  readonly overlapRatio: number;
  readonly converged: boolean;
  readonly accepted: boolean;
  readonly warnings: readonly string[];
}

export type RegistrationPhase =
  | 'staged'
  | 'awaitingFreshInteraction'
  | 'previewing'
  | 'readyToCommit'
  | 'committing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface ImportRegistrationState {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly commandId: string;
  readonly recipe: RegistrationRecipe;
  readonly phase: RegistrationPhase;
  readonly sourceEntityCount: number;
  readonly sourcePreview: JsonValue;
  readonly preview?: RegistrationPreview;
  readonly message?: string;
}

export interface SiteCalibrationInspection {
  readonly schemaVersion: 1;
  readonly sourceSha256: string;
  readonly format: 'himmelcadJson' | 'explicitText';
  readonly transform: RegistrationSimilarity3d;
  readonly warnings: readonly string[];
}

export interface IoExportOutput {
  readonly relativePath: string;
  readonly mediaType: string;
}

export interface IoCanonicalExportPlan {
  readonly formatId: string;
  readonly outputs: readonly IoExportOutput[];
  readonly semanticLosses: readonly string[];
}

export interface IoExportPlanRequest {
  readonly commandId: string;
  readonly providerId: string;
  readonly providerVersion: string;
  /** Host-owned destination capability. */
  readonly targetPath: string;
  readonly formatId: string;
  readonly options: JsonValue;
}

export interface IoExportPlanEnvelope {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly targetPath: string;
  readonly formatId: string;
  readonly options: JsonValue;
  readonly plan: IoCanonicalExportPlan;
}

export type IoOperationState = 'running' | 'completed' | 'cancelled' | 'failed';

export interface IoProviderProgress {
  readonly phase: string;
  readonly completed: number;
  readonly total: number | null;
  readonly message: string;
}

export interface IoOperationStatus {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly state: IoOperationState;
  readonly progress?: IoProviderProgress;
  readonly message?: string;
}

export interface IoExportExecuteResult {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly outputs: readonly IoExportOutput[];
}

export interface CanonicalResidencyArtifact {
  readonly relativePath: string;
  readonly resource: GeometryResource;
}

export interface CanonicalResidencyDataset {
  readonly datasetId: string;
  readonly formatId: string;
  readonly entityId: string;
  readonly representationSlot: string;
  readonly rootMetadata: GeometryResource;
  readonly artifacts: readonly CanonicalResidencyArtifact[];
}

export interface CanonicalResidencyEntry {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly admission: CanonicalRepresentationAdmission;
  readonly dataset: CanonicalResidencyDataset | null;
}

export interface CanonicalResidencyBootstrap {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly entries: readonly CanonicalResidencyEntry[];
}

export interface AppFacadeMethods extends AppProtocolMethods {
  readonly 'app.protocol': {
    readonly request: AppProtocolRequestEnvelope;
    readonly response: AppProtocolResponseEnvelope;
  };
  readonly 'canonical.project.open': {
    readonly request: { readonly projectRoot: string };
    readonly response: AppDocumentSnapshot;
  };
  readonly 'canonical.project.close': {
    readonly request: Record<string, never>;
    readonly response: { readonly closed: boolean };
  };
  readonly 'canonical.residency.bootstrap': {
    readonly request: Record<string, never>;
    readonly response: CanonicalResidencyBootstrap;
  };
  readonly 'io.formats.page': {
    readonly request: PageRequest;
    readonly response: Page<IoFormatDescriptor>;
  };
  readonly 'io.probe': {
    readonly request: IoProbeRequest;
    readonly response: IoImportProviderSelection;
  };
  readonly 'io.import.execute': {
    readonly request: IoImportExecuteRequest;
    readonly response: IoImportCommit;
  };
  readonly 'io.export.plan': {
    readonly request: IoExportPlanRequest;
    readonly response: IoExportPlanEnvelope;
  };
  readonly 'io.export.execute': {
    readonly request: {
      readonly operationId: string;
      readonly acceptedPlan: IoExportPlanEnvelope;
    };
    readonly response: IoExportExecuteResult;
  };
  readonly 'io.operation.status': {
    readonly request: { readonly operationId: string };
    readonly response: IoOperationStatus;
  };
  readonly 'io.operation.cancel': {
    readonly request: { readonly operationId: string };
    readonly response: {
      readonly schemaVersion: 1;
      readonly operationId: string;
      readonly cancellationRequested: boolean;
    };
  };
  readonly 'registration.import.stage': {
    readonly request: {
      readonly sessionId: string;
      readonly commandId: string;
      readonly sourcePath: string;
      readonly selection: IoImportProviderSelection;
      readonly options: JsonValue;
      readonly recipe: RegistrationRecipe;
    };
    readonly response: ImportRegistrationState;
  };
  readonly 'registration.session.state': {
    readonly request: { readonly sessionId: string };
    readonly response: ImportRegistrationState;
  };
  readonly 'registration.preview.pointPairs': {
    readonly request: {
      readonly sessionId: string;
      readonly pairs: readonly RegistrationPointPair[];
    };
    readonly response: ImportRegistrationState;
  };
  readonly 'registration.preview.icp': {
    readonly request: {
      readonly sessionId: string;
      readonly source: readonly RegistrationPoint[];
      readonly target: readonly RegistrationTargetSample[];
      readonly initial: RegistrationSimilarity3d;
      readonly mode: 'pointToPoint' | 'pointToPlane';
      readonly options: RegistrationIcpOptions;
    };
    readonly response: ImportRegistrationState;
  };
  readonly 'registration.samples.source': {
    readonly request: { readonly sessionId: string; readonly maximumSamples: number };
    readonly response: RegistrationSourceSamples;
  };
  readonly 'registration.import.commit': {
    readonly request: { readonly sessionId: string };
    readonly response: IoImportCommit;
  };
  readonly 'registration.session.cancel': {
    readonly request: { readonly sessionId: string };
    readonly response: {
      readonly schemaVersion: 1;
      readonly sessionId: string;
      readonly cancellationRequested: boolean;
    };
  };
  readonly 'registration.siteCalibration.inspect': {
    readonly request: { readonly path: string };
    readonly response: SiteCalibrationInspection;
  };
}

export interface AppCallOptions extends RpcRequestOptions {
  readonly requestId?: string;
  readonly extensions?: AppProtocolExtensions;
}

export interface CollectJournalOptions {
  readonly afterSequence?: number;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly signal?: AbortSignal;
}

export interface CollectPagesOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly signal?: AbortSignal;
}

type AppFacadeTransport = RpcTransport<
  AppFacadeMethods & { readonly [Key in keyof AppFacadeMethods]: RpcMethodDefinition }
>;

export class CanonicalProjectClient {
  constructor(private readonly transport: AppFacadeTransport) {}

  async open(projectRoot: string, options?: RpcRequestOptions): Promise<AppDocumentSnapshot> {
    if (projectRoot.trim().length === 0) {
      throw new ContractValidationError('must not be empty', 'projectRoot');
    }
    return this.transport.request('canonical.project.open', { projectRoot }, options);
  }

  async close(options?: RpcRequestOptions): Promise<boolean> {
    return (await this.transport.request('canonical.project.close', {}, options)).closed;
  }
}

export class ResidencyClient {
  constructor(
    private readonly transport: AppFacadeTransport,
    private readonly session: NegotiatedSession,
  ) {}

  async bootstrap(options?: RpcRequestOptions): Promise<CanonicalResidencyBootstrap> {
    requireCapability(this.session, 'residency.read');
    const result = await this.transport.request('canonical.residency.bootstrap', {}, options);
    if (
      result.schemaVersion !== 1 ||
      !Number.isSafeInteger(result.generation) ||
      result.generation < 0 ||
      !Array.isArray(result.entries)
    ) {
      throw new ContractValidationError(
        'server returned an invalid residency bootstrap',
        'response',
      );
    }
    return result;
  }
}

export class DocumentClient {
  private readonly createRequestId: () => string;

  constructor(
    private readonly transport: AppFacadeTransport,
    private readonly session: NegotiatedSession,
    options: { readonly createRequestId?: () => string } = {},
  ) {
    this.createRequestId = options.createRequestId ?? defaultRequestId;
  }

  /** Low-level lossless exchange for extensions and forward-compatible relays. */
  async exchange(
    request: AppProtocolRequest,
    options: AppCallOptions = {},
  ): Promise<AppProtocolResponseEnvelope> {
    const requestId = options.requestId ?? this.createRequestId();
    validateRequestId(requestId);
    const envelope: AppProtocolRequestEnvelope = {
      schemaId: APP_PROTOCOL_SCHEMA_ID,
      requestId,
      request,
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    };
    const response = await this.transport.request(
      'app.protocol',
      envelope,
      signalOption(options.signal),
    );
    validateResponseEnvelope(response, requestId);
    return response;
  }

  async snapshot(options?: AppCallOptions) {
    requireCapability(this.session, 'document.read');
    return this.expect(
      await this.exchange({ method: 'readDocumentSnapshot' }, options),
      'documentSnapshot',
    ).payload;
  }

  async readJournalPage(
    request: AppJournalReadRequest,
    options?: AppCallOptions,
  ): Promise<AppJournalPage> {
    requireCapability(this.session, 'journal.read');
    validateJournalRequest(request);
    return this.expect(
      await this.exchange({ method: 'readJournal', params: request }, options),
      'journalPage',
    ).payload;
  }

  async listAllJournalEntries(
    options: CollectJournalOptions = {},
  ): Promise<readonly CanonicalJournalEntry[]> {
    requireCapability(this.session, 'journal.read');
    const pageSize = options.pageSize ?? 250;
    const maxPages = options.maxPages ?? 10_000;
    let afterSequence = options.afterSequence ?? 0;
    validateJournalRequest({ afterSequence, limit: pageSize });
    validateMaxPages(maxPages);

    const entries: CanonicalJournalEntry[] = [];
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await this.readJournalPage(
        { afterSequence, limit: pageSize },
        signalOption(options.signal),
      );
      validateJournalPage(page, afterSequence);
      entries.push(...page.entries);
      if (!page.hasMore) return entries;
      const last = page.entries.at(-1);
      if (last === undefined || last.sequence <= afterSequence) {
        throw new ContractValidationError(
          'server did not advance a journal page marked hasMore',
          'response.entries',
        );
      }
      afterSequence = last.sequence;
    }
    throw new ContractValidationError(
      'pagination exceeded the configured page limit',
      'options.maxPages',
    );
  }

  async readPropertySchemas(options?: AppCallOptions): Promise<PropertyNamespaceSchema[]> {
    requireCapability(this.session, 'document.read');
    return this.expect(
      await this.exchange({ method: 'readPropertySchemas' }, options),
      'propertySchemas',
    ).payload;
  }

  async queryProperties(
    request: PropertyQueryRequest,
    options?: AppCallOptions,
  ): Promise<PropertyQueryResult> {
    requireCapability(this.session, 'document.read');
    return this.expect(
      await this.exchange({ method: 'queryProperties', params: request }, options),
      'propertyQuery',
    ).payload;
  }

  async compilePropertyEdit(
    request: MultiEntityPropertyEditRequest,
    options?: AppCallOptions,
  ): Promise<CanonicalCommandTransaction> {
    requireCapability(this.session, 'document.write');
    return this.expect(
      await this.exchange({ method: 'compilePropertyEdit', params: request }, options),
      'compiledTransaction',
    ).payload;
  }

  async executeCanonicalTransaction(
    transaction: CanonicalCommandTransaction,
    options?: AppCallOptions,
  ): Promise<CanonicalJournalEntry> {
    requireCapability(this.session, 'document.write');
    if (transaction.commandId.trim().length === 0 || transaction.mutations.length === 0) {
      throw new ContractValidationError(
        'commandId and at least one canonical mutation are required',
        'transaction',
      );
    }
    return this.expect(
      await this.exchange({ method: 'executeCanonicalTransaction', params: transaction }, options),
      'transactionAccepted',
    ).payload;
  }

  private expect<Kind extends Exclude<AppProtocolResponse['kind'], 'error'>>(
    envelope: AppProtocolResponseEnvelope,
    kind: Kind,
  ): Extract<AppProtocolResponse, { readonly kind: Kind }> {
    if (envelope.response.kind === 'error') {
      throw createRemoteError({
        ...envelope.response.payload,
        retryable: false,
      });
    }
    if (envelope.response.kind !== kind) {
      throw new ContractValidationError(
        `expected ${kind}, received ${envelope.response.kind}`,
        'response.kind',
      );
    }
    return envelope.response as Extract<AppProtocolResponse, { readonly kind: Kind }>;
  }
}

/** Version-frozen provider discovery, execution and operation control. */
export class IoClient {
  constructor(
    private readonly transport: AppFacadeTransport,
    private readonly session: NegotiatedSession,
  ) {}

  async listFormatsPage(
    request: PageRequest,
    options?: RpcRequestOptions,
  ): Promise<Page<IoFormatDescriptor>> {
    requireCapability(this.session, 'io.formats.read');
    validatePageRequest(request);
    return this.transport.request('io.formats.page', request, options);
  }

  async listAllFormats(options: CollectPagesOptions = {}): Promise<readonly IoFormatDescriptor[]> {
    requireCapability(this.session, 'io.formats.read');
    return collectPages(
      (request) => this.listFormatsPage(request, signalOption(options.signal)),
      options,
    );
  }

  async probe(
    request: IoProbeRequest,
    options?: RpcRequestOptions,
  ): Promise<IoImportProviderSelection> {
    requireCapability(this.session, 'io.probe');
    validateHostPath(request.sourcePath, 'sourcePath');
    const selection = await this.transport.request('io.probe', request, options);
    validateImportSelection(selection);
    return selection;
  }

  async executeImport(
    request: IoImportExecuteRequest,
    options?: RpcRequestOptions,
  ): Promise<IoImportCommit> {
    requireCapability(this.session, 'io.import.execute');
    validatePortableIdentity(request.operationId, 'operationId');
    validatePortableIdentity(request.commandId, 'commandId');
    validateHostPath(request.sourcePath, 'sourcePath');
    validateImportSelection(request.selection);
    return this.transport.request('io.import.execute', request, options);
  }

  async planExport(
    request: IoExportPlanRequest,
    options?: RpcRequestOptions,
  ): Promise<IoExportPlanEnvelope> {
    requireCapability(this.session, 'io.export');
    validatePortableIdentity(request.commandId, 'commandId');
    validateRegistryId(request.providerId, 'providerId');
    validateHostPath(request.targetPath, 'targetPath');
    const accepted = await this.transport.request('io.export.plan', request, options);
    validateExportPlanEnvelope(accepted);
    return accepted;
  }

  async executeExport(
    operationId: string,
    acceptedPlan: IoExportPlanEnvelope,
    options?: RpcRequestOptions,
  ): Promise<IoExportExecuteResult> {
    requireCapability(this.session, 'io.export');
    requireCapability(this.session, 'io.operation');
    validatePortableIdentity(operationId, 'operationId');
    validateExportPlanEnvelope(acceptedPlan);
    return this.transport.request('io.export.execute', { operationId, acceptedPlan }, options);
  }

  async operationStatus(
    operationId: string,
    options?: RpcRequestOptions,
  ): Promise<IoOperationStatus> {
    requireCapability(this.session, 'io.operation');
    validatePortableIdentity(operationId, 'operationId');
    return this.transport.request('io.operation.status', { operationId }, options);
  }

  async cancelOperation(operationId: string, options?: RpcRequestOptions): Promise<boolean> {
    requireCapability(this.session, 'io.operation');
    validatePortableIdentity(operationId, 'operationId');
    return (await this.transport.request('io.operation.cancel', { operationId }, options))
      .cancellationRequested;
  }
}

/** Interactive pre-commit registration over provider-staged canonical imports. */
export class RegistrationClient {
  constructor(
    private readonly transport: AppFacadeTransport,
    private readonly session: NegotiatedSession,
  ) {}

  async stage(
    request: AppFacadeMethods['registration.import.stage']['request'],
    options?: RpcRequestOptions,
  ): Promise<ImportRegistrationState> {
    requireCapability(this.session, 'registration.import');
    validatePortableIdentity(request.sessionId, 'sessionId');
    validatePortableIdentity(request.commandId, 'commandId');
    validateHostPath(request.sourcePath, 'sourcePath');
    validateImportSelection(request.selection);
    validateRegistrationRecipe(request.recipe);
    return this.transport.request('registration.import.stage', request, options);
  }

  async state(sessionId: string, options?: RpcRequestOptions): Promise<ImportRegistrationState> {
    requireCapability(this.session, 'registration.import');
    validatePortableIdentity(sessionId, 'sessionId');
    return this.transport.request('registration.session.state', { sessionId }, options);
  }

  async previewPointPairs(
    sessionId: string,
    pairs: readonly RegistrationPointPair[],
    options?: RpcRequestOptions,
  ): Promise<ImportRegistrationState> {
    requireCapability(this.session, 'registration.import');
    validatePortableIdentity(sessionId, 'sessionId');
    if (
      pairs.length < 3 ||
      pairs.some(
        (pair) => !validRegistrationPoint(pair.source) || !validRegistrationPoint(pair.target),
      )
    ) {
      throw new ContractValidationError(
        'at least three finite source/target pairs are required',
        'pairs',
      );
    }
    return this.transport.request('registration.preview.pointPairs', { sessionId, pairs }, options);
  }

  async previewIcp(
    request: AppFacadeMethods['registration.preview.icp']['request'],
    options?: RpcRequestOptions,
  ): Promise<ImportRegistrationState> {
    requireCapability(this.session, 'registration.import');
    validatePortableIdentity(request.sessionId, 'sessionId');
    if (
      request.source.length < 3 ||
      request.target.length < 3 ||
      request.source.length > 2_048 ||
      request.target.length > 2_048
    ) {
      throw new ContractValidationError(
        'ICP requires 3..2048 prepared samples per side',
        'samples',
      );
    }
    return this.transport.request('registration.preview.icp', request, options);
  }

  async sourceSamples(
    sessionId: string,
    maximumSamples = 2_048,
    options?: RpcRequestOptions,
  ): Promise<RegistrationSourceSamples> {
    requireCapability(this.session, 'registration.import');
    validatePortableIdentity(sessionId, 'sessionId');
    if (!Number.isSafeInteger(maximumSamples) || maximumSamples < 3 || maximumSamples > 2_048) {
      throw new ContractValidationError('source sample limit must be from 3 through 2048', 'limit');
    }
    return this.transport.request(
      'registration.samples.source',
      { sessionId, maximumSamples },
      options,
    );
  }

  async commit(sessionId: string, options?: RpcRequestOptions): Promise<IoImportCommit> {
    requireCapability(this.session, 'registration.import');
    validatePortableIdentity(sessionId, 'sessionId');
    return this.transport.request('registration.import.commit', { sessionId }, options);
  }

  async cancel(sessionId: string, options?: RpcRequestOptions): Promise<boolean> {
    requireCapability(this.session, 'registration.import');
    validatePortableIdentity(sessionId, 'sessionId');
    return (await this.transport.request('registration.session.cancel', { sessionId }, options))
      .cancellationRequested;
  }

  async inspectSiteCalibration(
    path: string,
    options?: RpcRequestOptions,
  ): Promise<SiteCalibrationInspection> {
    requireCapability(this.session, 'registration.import');
    validateHostPath(path, 'path');
    return this.transport.request('registration.siteCalibration.inspect', { path }, options);
  }
}

function validateRegistrationRecipe(recipe: RegistrationRecipe): void {
  validatePortableIdentity(recipe.recipeId, 'recipe.recipeId');
  if (recipe.schemaVersion !== 1 || recipe.label.trim().length === 0) {
    throw new ContractValidationError('unsupported or empty registration recipe', 'recipe');
  }
}

function validRegistrationPoint(point: RegistrationPoint): boolean {
  return [point.x, point.y, point.z].every(Number.isFinite);
}

function validateImportSelection(selection: IoImportProviderSelection): void {
  validateRegistryId(selection.providerId, 'selection.providerId');
  if (selection.providerVersion.trim().length === 0) {
    throw new ContractValidationError('must not be empty', 'selection.providerVersion');
  }
  validateRegistryId(selection.formatId, 'selection.formatId');
  if (
    !Number.isSafeInteger(selection.confidence) ||
    selection.confidence < 1 ||
    selection.confidence > 100
  ) {
    throw new ContractValidationError(
      'must be an integer from 1 through 100',
      'selection.confidence',
    );
  }
}

function validateExportPlanEnvelope(envelope: IoExportPlanEnvelope): void {
  if (envelope.schemaVersion !== 1) {
    throw new ContractValidationError('unsupported schema version', 'acceptedPlan.schemaVersion');
  }
  validatePortableIdentity(envelope.commandId, 'acceptedPlan.commandId');
  validateRegistryId(envelope.providerId, 'acceptedPlan.providerId');
  validateHostPath(envelope.targetPath, 'acceptedPlan.targetPath');
  validateRegistryId(envelope.formatId, 'acceptedPlan.formatId');
  if (
    envelope.plan.formatId !== envelope.formatId ||
    envelope.plan.outputs.length === 0 ||
    envelope.plan.outputs.some(
      (output) => output.relativePath.length === 0 || output.mediaType.length === 0,
    )
  ) {
    throw new ContractValidationError(
      'plan does not match its frozen request',
      'acceptedPlan.plan',
    );
  }
}

function validatePortableIdentity(value: string, path: string): void {
  if (value.length === 0 || value.length > 160 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new ContractValidationError('must be a bounded portable identity', path);
  }
}

function validateRegistryId(value: string, path: string): void {
  if (value.length === 0 || value.length > 160 || !/^[a-z0-9._+@-]+$/.test(value)) {
    throw new ContractValidationError('must be a bounded namespaced registry identity', path);
  }
}

function validateHostPath(value: string, path: string): void {
  if (value.trim().length === 0 || value.includes('\0')) {
    throw new ContractValidationError('must be a non-empty host path capability', path);
  }
}

async function collectPages<T>(
  requestPage: (request: PageRequest) => Promise<Page<T>>,
  options: CollectPagesOptions,
): Promise<readonly T[]> {
  const pageSize = options.pageSize ?? 250;
  const maxPages = options.maxPages ?? 10_000;
  validatePageRequest({ limit: pageSize });
  validateMaxPages(maxPages);

  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const request: PageRequest =
      cursor === undefined ? { limit: pageSize } : { cursor, limit: pageSize };
    const page = await requestPage(request);
    if (!Array.isArray(page.items)) {
      throw new ContractValidationError('page.items must be an array', 'page.items');
    }
    items.push(...page.items);
    // Wire JSON often serializes absent Option as null; treat null like undefined.
    const nextCursor = page.nextCursor ?? undefined;
    if (nextCursor === undefined) return items;
    if (nextCursor.length === 0 || cursors.has(nextCursor)) {
      throw new ContractValidationError(
        'server returned a repeated or empty cursor',
        'page.nextCursor',
      );
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new ContractValidationError(
    'pagination exceeded the configured page limit',
    'options.maxPages',
  );
}

function validateJournalRequest(request: AppJournalReadRequest): void {
  if (!Number.isSafeInteger(request.afterSequence) || request.afterSequence < 0) {
    throw new ContractValidationError('must be a non-negative safe integer', 'afterSequence');
  }
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > APP_PROTOCOL_MAX_JOURNAL_PAGE_SIZE
  ) {
    throw new ContractValidationError(
      `must be an integer from 1 through ${APP_PROTOCOL_MAX_JOURNAL_PAGE_SIZE}`,
      'limit',
    );
  }
}

function validateJournalPage(page: AppJournalPage, afterSequence: number): void {
  if (page.afterSequence !== afterSequence) {
    throw new ContractValidationError(
      'server changed the journal cursor',
      'response.afterSequence',
    );
  }
  let previous = afterSequence;
  for (const entry of page.entries) {
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence !== previous + 1) {
      throw new ContractValidationError(
        'journal entries must be contiguous and ordered',
        'response.entries',
      );
    }
    previous = entry.sequence;
  }
  if (
    !Number.isSafeInteger(page.journalHeadSequence) ||
    page.journalHeadSequence < previous ||
    page.hasMore !== previous < page.journalHeadSequence
  ) {
    throw new ContractValidationError('journal head metadata is inconsistent', 'response');
  }
}

function validateResponseEnvelope(response: AppProtocolResponseEnvelope, requestId: string): void {
  if (response.schemaId !== APP_PROTOCOL_SCHEMA_ID) {
    throw new ContractValidationError('server returned an unsupported schema', 'response.schemaId');
  }
  if (response.requestId !== requestId) {
    throw new ContractValidationError('server changed the request identity', 'response.requestId');
  }
}

function validateRequestId(requestId: string): void {
  if (requestId.trim().length === 0 || requestId.includes('\0')) {
    throw new ContractValidationError('must be non-empty and contain no null byte', 'requestId');
  }
}

function validatePageRequest(request: PageRequest): void {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
    throw new ContractValidationError('must be an integer from 1 through 1000', 'request.limit');
  }
  if (request.cursor?.length === 0) {
    throw new ContractValidationError('must not be empty', 'request.cursor');
  }
}

function validateMaxPages(maxPages: number): void {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new ContractValidationError('must be a positive safe integer', 'options.maxPages');
  }
}

function signalOption(signal: AbortSignal | undefined): RpcRequestOptions | undefined {
  return signal === undefined ? undefined : { signal };
}

function defaultRequestId(): string {
  return globalThis.crypto.randomUUID();
}
