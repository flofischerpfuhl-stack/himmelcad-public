import type { AppJournalPage, AppJournalReadRequest, AppDocumentSnapshot, AppProtocolExtensions, AppProtocolRequest, AppProtocolRequestEnvelope, AppProtocolResponseEnvelope, CanonicalCommandTransaction, CanonicalJournalEntry, CanonicalRepresentationAdmission, GeometryResource, MultiEntityPropertyEditRequest, PropertyNamespaceSchema, PropertyQueryRequest, PropertyQueryResult } from './canonicalProtocol.js';
import type { AppProtocolMethods, JsonValue, NegotiatedSession, RpcMethodDefinition, RpcRequestOptions, RpcTransport } from './protocol.js';
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
export type RegistrationRecipeMethod = {
    readonly kind: 'sourceCoordinates';
    readonly frozenTransformSha256?: string;
} | {
    readonly kind: 'originAndProjectNorth';
    readonly sourceOrigin: RegistrationPoint;
    readonly targetOrigin: RegistrationPoint;
    readonly projectNorthDegrees: number;
    readonly scale: number;
} | {
    readonly kind: 'manualPlacement';
    readonly transform: RegistrationSimilarity3d;
} | {
    readonly kind: 'pointPairs';
    readonly model: 'translation3D' | 'rigid3D' | 'similarity3D';
    readonly robust: RegistrationRobustFitOptions;
    readonly offerIcpRefinement: boolean;
} | {
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
export type RegistrationPhase = 'staged' | 'awaitingFreshInteraction' | 'previewing' | 'readyToCommit' | 'committing' | 'completed' | 'cancelled' | 'failed';
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
        readonly request: {
            readonly projectRoot: string;
        };
        readonly response: AppDocumentSnapshot;
    };
    readonly 'canonical.project.close': {
        readonly request: Record<string, never>;
        readonly response: {
            readonly closed: boolean;
        };
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
        readonly request: {
            readonly operationId: string;
        };
        readonly response: IoOperationStatus;
    };
    readonly 'io.operation.cancel': {
        readonly request: {
            readonly operationId: string;
        };
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
        readonly request: {
            readonly sessionId: string;
        };
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
        readonly request: {
            readonly sessionId: string;
            readonly maximumSamples: number;
        };
        readonly response: RegistrationSourceSamples;
    };
    readonly 'registration.samples.projectPointCloud': {
        readonly request: {
            readonly datasetId: string;
            readonly maximumSamples: number;
        };
        readonly response: RegistrationSourceSamples;
    };
    readonly 'registration.import.commit': {
        readonly request: {
            readonly sessionId: string;
        };
        readonly response: IoImportCommit;
    };
    readonly 'registration.session.cancel': {
        readonly request: {
            readonly sessionId: string;
        };
        readonly response: {
            readonly schemaVersion: 1;
            readonly sessionId: string;
            readonly cancellationRequested: boolean;
        };
    };
    readonly 'registration.siteCalibration.inspect': {
        readonly request: {
            readonly path: string;
        };
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
type AppFacadeTransport = RpcTransport<AppFacadeMethods & {
    readonly [Key in keyof AppFacadeMethods]: RpcMethodDefinition;
}>;
export declare class CanonicalProjectClient {
    private readonly transport;
    constructor(transport: AppFacadeTransport);
    open(projectRoot: string, options?: RpcRequestOptions): Promise<AppDocumentSnapshot>;
    close(options?: RpcRequestOptions): Promise<boolean>;
}
export declare class ResidencyClient {
    private readonly transport;
    private readonly session;
    constructor(transport: AppFacadeTransport, session: NegotiatedSession);
    bootstrap(options?: RpcRequestOptions): Promise<CanonicalResidencyBootstrap>;
}
export declare class DocumentClient {
    private readonly transport;
    private readonly session;
    private readonly createRequestId;
    constructor(transport: AppFacadeTransport, session: NegotiatedSession, options?: {
        readonly createRequestId?: () => string;
    });
    /** Low-level lossless exchange for extensions and forward-compatible relays. */
    exchange(request: AppProtocolRequest, options?: AppCallOptions): Promise<AppProtocolResponseEnvelope>;
    snapshot(options?: AppCallOptions): Promise<AppDocumentSnapshot>;
    readJournalPage(request: AppJournalReadRequest, options?: AppCallOptions): Promise<AppJournalPage>;
    listAllJournalEntries(options?: CollectJournalOptions): Promise<readonly CanonicalJournalEntry[]>;
    readPropertySchemas(options?: AppCallOptions): Promise<PropertyNamespaceSchema[]>;
    queryProperties(request: PropertyQueryRequest, options?: AppCallOptions): Promise<PropertyQueryResult>;
    compilePropertyEdit(request: MultiEntityPropertyEditRequest, options?: AppCallOptions): Promise<CanonicalCommandTransaction>;
    executeCanonicalTransaction(transaction: CanonicalCommandTransaction, options?: AppCallOptions): Promise<CanonicalJournalEntry>;
    private expect;
}
/** Version-frozen provider discovery, execution and operation control. */
export declare class IoClient {
    private readonly transport;
    private readonly session;
    constructor(transport: AppFacadeTransport, session: NegotiatedSession);
    listFormatsPage(request: PageRequest, options?: RpcRequestOptions): Promise<Page<IoFormatDescriptor>>;
    listAllFormats(options?: CollectPagesOptions): Promise<readonly IoFormatDescriptor[]>;
    probe(request: IoProbeRequest, options?: RpcRequestOptions): Promise<IoImportProviderSelection>;
    executeImport(request: IoImportExecuteRequest, options?: RpcRequestOptions): Promise<IoImportCommit>;
    planExport(request: IoExportPlanRequest, options?: RpcRequestOptions): Promise<IoExportPlanEnvelope>;
    executeExport(operationId: string, acceptedPlan: IoExportPlanEnvelope, options?: RpcRequestOptions): Promise<IoExportExecuteResult>;
    operationStatus(operationId: string, options?: RpcRequestOptions): Promise<IoOperationStatus>;
    cancelOperation(operationId: string, options?: RpcRequestOptions): Promise<boolean>;
}
/** Interactive pre-commit registration over provider-staged canonical imports. */
export declare class RegistrationClient {
    private readonly transport;
    private readonly session;
    constructor(transport: AppFacadeTransport, session: NegotiatedSession);
    stage(request: AppFacadeMethods['registration.import.stage']['request'], options?: RpcRequestOptions): Promise<ImportRegistrationState>;
    state(sessionId: string, options?: RpcRequestOptions): Promise<ImportRegistrationState>;
    previewPointPairs(sessionId: string, pairs: readonly RegistrationPointPair[], options?: RpcRequestOptions): Promise<ImportRegistrationState>;
    previewIcp(request: AppFacadeMethods['registration.preview.icp']['request'], options?: RpcRequestOptions): Promise<ImportRegistrationState>;
    sourceSamples(sessionId: string, maximumSamples?: number, options?: RpcRequestOptions): Promise<RegistrationSourceSamples>;
    projectPointCloudSamples(datasetId: string, maximumSamples?: number, options?: RpcRequestOptions): Promise<RegistrationSourceSamples>;
    commit(sessionId: string, options?: RpcRequestOptions): Promise<IoImportCommit>;
    cancel(sessionId: string, options?: RpcRequestOptions): Promise<boolean>;
    inspectSiteCalibration(path: string, options?: RpcRequestOptions): Promise<SiteCalibrationInspection>;
}
export {};
//# sourceMappingURL=clients.d.ts.map