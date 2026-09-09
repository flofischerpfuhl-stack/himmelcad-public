import {
  CanonicalProjectClient,
  DocumentClient,
  IoClient,
  PROPERTY_EDIT_REQUEST_SCHEMA_ID,
  PROPERTY_QUERY_REQUEST_SCHEMA_ID,
  RegistrationClient,
  createJournalMirror,
  negotiateAppProtocol,
  reduceJournalMirror,
  type AppFacadeMethods,
  type AppDocumentSnapshot,
  type CanonicalJournalEntry,
  type JournalMirror,
  type PropertyAssignment,
  type PropertyQueryResult,
  type JsonValue,
  type RegistrationPoint,
  type RpcRequestOptions,
  type RpcTransport,
  type RegistrationRecipe,
  type RegistrationPointPair,
  type RegistrationTargetSample,
  type RegistrationSimilarity3d,
  type RegistrationIcpOptions,
  type PointCloudDisplayStyle,
  type CanonicalEntity,
} from '@himmelcad/app';
import type { PhotoLabProductProvenanceV1, ProjectSnapshot } from '@himmelcad/data';
import type { MeasurementV1 } from '@himmelcad/data/canonical';
import type { PointAcquisitionV1, Position } from '@himmelcad/data/canonical';
import type { DrawCurveWrite, DrawCurveWriteResult, DrawRole } from '@himmelcad/app';
import type { KernelFenceVolume } from '@himmelcad/viewer/kernel';
import type { CanonicalRepresentationAdmission } from '@himmelcad/viewer/kernel';

import { projectSnapshotFromJournalMirror } from './projectProjection.js';
import type { BuilderDurabilityStatus } from './durabilityPolling.js';

export { projectSnapshotFromJournalMirror } from './projectProjection.js';
export { startDurabilityPolling } from './durabilityPolling.js';
export type { BuilderDurabilityStatus } from './durabilityPolling.js';

type SidecarCall = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export interface BuilderSnapshotSummary {
  readonly entityId: string;
  readonly name: string;
  readonly marker: {
    readonly schemaId: 'hcad.snapshot-marker@1';
    readonly schemaVersion: 1;
    readonly markedGeneration: number;
    readonly markerKind: 'manual' | 'session_start' | 'pre_restore';
    readonly createdAt: string;
    readonly origin: 'ui' | 'sdk' | 'agent' | 'system';
    readonly restoreOf?: string | null;
  };
}

export interface BuilderViewBookmarkSummary {
  readonly entityId: string;
  readonly revision: number;
  readonly name: string;
  readonly state: unknown;
}

export interface BuilderViewingBoxSummary {
  readonly entityId: string;
  readonly revision: number;
  readonly name: string;
  readonly state: unknown;
}

export interface BuilderPhotoLabProvenanceSummary {
  readonly entityId: string;
  readonly componentSha256: string;
  readonly provenance: PhotoLabProductProvenanceV1;
}

export interface BuilderMeasurementSummary {
  readonly entityId: string;
  readonly revision: number;
  readonly name: string;
  readonly measurement: MeasurementV1;
}

export interface BuilderDrawCurveSummary {
  readonly entityId: string;
  readonly revision: number;
  readonly name: string;
  readonly role: DrawRole;
  readonly closed: boolean;
  readonly vertices: readonly Position[];
  readonly acquisitions: readonly PointAcquisitionV1[];
  readonly admission: CanonicalRepresentationAdmission;
}

export const GROUND_ALGORITHM_ID = 'hcad.pointcloud.ground-progressive@1' as const;

export interface GroundExtractionParameters {
  readonly cellSizeM: number;
  readonly slope: number;
  readonly maxWindowM: number;
  readonly initialDistanceM: number;
}

export interface GroundExtractionScope {
  readonly viewingBox?: {
    readonly center: readonly [number, number, number];
    readonly halfExtents: readonly [number, number, number];
    readonly rotation: readonly [number, number, number, number];
    readonly keepInside: boolean;
  } | null;
  readonly visibleClasses: readonly number[];
}

export interface GroundResidualSummary {
  readonly count: number;
  readonly meanM: number;
  readonly standardDeviationM: number;
  readonly minimumM: number;
  readonly maximumM: number;
}

export interface GroundExtractionSummary {
  readonly sourcePoints: number;
  readonly scopedPoints: number;
  readonly groundPoints: number;
  readonly ratio: number;
  readonly residuals: GroundResidualSummary;
  readonly membershipSha256: string;
}

export interface GroundPreviewResult {
  readonly schemaId: 'hcad.pointcloud.ground-preview-result@1';
  readonly algorithmId: typeof GROUND_ALGORITHM_ID;
  readonly source: {
    readonly id: string;
    readonly revision: number;
    readonly versionHash: string;
  };
  readonly preview: {
    readonly sampledPoints: number;
    readonly groundPoints: number;
    readonly ratio: number;
    readonly residuals: GroundResidualSummary;
    readonly points: readonly {
      readonly position: readonly [number, number, number];
      readonly classification: 'ground' | 'non_ground';
    }[];
  };
}

export interface GroundExtractionResult {
  readonly schemaId: 'hcad.pointcloud.ground-result@1';
  readonly algorithmId: typeof GROUND_ALGORITHM_ID;
  readonly summary: GroundExtractionSummary;
  readonly source: {
    readonly entityId: string;
    readonly revision: number;
    readonly datasetId: string;
    readonly classification: 2;
  };
  readonly groundCloud: {
    readonly entityId: string;
    readonly revision: number;
    readonly datasetId: string;
    readonly entityType: 'PointCloud';
    readonly isDgm: false;
    readonly meshSourceRole: 'ground_cloud';
  };
  readonly journalEntry: CanonicalJournalEntry;
}

export interface PointCloudSegmentResult {
  readonly schemaId: 'hcad.pointcloud.segment-result@1';
  readonly algorithmId: 'hcad.pointcloud.segment@1';
  readonly side: 'keep_inside' | 'remove_inside';
  readonly volume: KernelFenceVolume;
  readonly revisions: readonly {
    readonly entityId: string;
    readonly revision: number;
    readonly datasetId: string;
    readonly retainedPoints: number;
    readonly removedPoints: number;
  }[];
  readonly journalEntry: CanonicalJournalEntry;
}

export const SAMPLE_ALGORITHM_ID = 'hcad.pointcloud.sample@1' as const;
export const RASTERIZE_ALGORITHM_ID = 'hcad.pointcloud.rasterize-height@1' as const;

export interface PointcloudSampleParameters {
  readonly method: 'distance' | 'grid' | 'random';
  readonly spacingM: number;
  readonly percentage: number;
  readonly originX?: number;
  readonly originY?: number;
}

export interface PointcloudRasterizeParameters {
  readonly cellSizeM: number;
  readonly originX?: number;
  readonly originY?: number;
  readonly aggregation: 'mean' | 'min' | 'max' | 'count';
  readonly emptyCellPolicy:
    | { readonly kind: 'no_data' }
    | { readonly kind: 'fill'; readonly value: number };
}

export interface PointcloudSampleResult {
  readonly schemaId: 'hcad.pointcloud.sample-result@1';
  readonly algorithmId: typeof SAMPLE_ALGORITHM_ID;
  readonly source: { readonly id: string; readonly revision: number; readonly versionHash: string };
  readonly sampledCloud: {
    readonly entityId: string;
    readonly revision: number;
    readonly datasetId: string;
    readonly entityType: 'PointCloud';
  };
  readonly summary: {
    readonly sourcePoints: number;
    readonly scopedPoints: number;
    readonly sampledPoints: number;
    readonly method: PointcloudSampleParameters['method'];
    readonly spacingM?: number;
    readonly percentage?: number;
    readonly stableTieRule: string;
    readonly selectionSha256: string;
  };
  readonly journalEntry: CanonicalJournalEntry;
}

export interface PointcloudRasterizeResult {
  readonly schemaId: 'hcad.pointcloud.rasterize-result@1';
  readonly algorithmId: typeof RASTERIZE_ALGORITHM_ID;
  readonly source: { readonly id: string; readonly revision: number; readonly versionHash: string };
  readonly grid: {
    readonly entityId: string;
    readonly revision: number;
    readonly datasetId: string;
    readonly entityType: 'hcad.elevation-surface@1' | 'hcad.raster-image@1';
    readonly meshSourceRole?: 'grid_source' | null;
  };
  readonly summary: {
    readonly sourcePoints: number;
    readonly scopedPoints: number;
    readonly width: number;
    readonly height: number;
    readonly cellSizeM: number;
    readonly origin: readonly [number, number];
    readonly aggregation: PointcloudRasterizeParameters['aggregation'];
    readonly emptyCellPolicy: PointcloudRasterizeParameters['emptyCellPolicy'];
    readonly emptyCells: number;
    readonly emptyRatio: number;
    readonly cellSha256: string;
    readonly meshEligible: boolean;
  };
  readonly journalEntry: CanonicalJournalEntry;
}

export type SurfaceSourceRole = 'points' | 'breakline' | 'form_line' | 'outer_boundary' | 'hole';

export interface SurfaceRules {
  readonly maximumEdgeLength: number;
  readonly thinCloudSpacing: number;
  readonly xyTolerance: number;
  readonly zTolerance: number;
  readonly excludeOutsideBoundary: boolean;
  readonly breaklineExclusionDistance: number | null;
  readonly autoBoundary: boolean;
  readonly cropPolyline: readonly (readonly [number, number])[];
}

export interface SurfaceSourceInput {
  readonly entityId: string;
  readonly role: SurfaceSourceRole;
  readonly visibleClasses?: readonly number[];
}

export interface SurfaceCheckError {
  readonly errorId: string;
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'notice';
  readonly message: string;
  readonly sourceIds: readonly string[];
  readonly location: readonly [number, number, number] | null;
  readonly fixes: readonly ('drop' | 'snap' | 'split' | 'exclude')[];
  readonly blocksPublish: boolean;
}

export interface SurfaceCheckResult {
  readonly errors: readonly SurfaceCheckError[];
  readonly fixable: number;
  readonly blocking: number;
  readonly sourcePoints: number;
  readonly admittedPoints: number;
}

export interface SurfaceDraftResult {
  readonly schemaId: 'hcad.mesh.surface-draft-result@1';
  readonly draftId: string;
  readonly sources: readonly {
    readonly entityId: string;
    readonly name: string;
    readonly role: SurfaceSourceRole;
    readonly count: number;
  }[];
  readonly checkpoint: 'captured';
}

export interface SurfacePublishResult {
  readonly schemaId: 'hcad.mesh.surface-result@1';
  readonly algorithmId: 'hcad.mesh.surface-cdt@1';
  readonly draftId: string;
  readonly entityId: string;
  readonly revision: number;
  readonly datasetId: string;
  readonly triangles: number;
  readonly area: number;
  readonly zRange: readonly [number, number];
  readonly residual: {
    readonly count: number;
    readonly meanAbsolute: number;
    readonly maximumAbsolute: number;
  };
  readonly journalEntry: CanonicalJournalEntry;
}

export type SurfaceEditRegionSource = 'fence' | 'boundary_polyline';
export type SurfaceSmoothFilter = 'gaussian' | 'median';

export interface SurfaceEditRegion {
  readonly source: SurfaceEditRegionSource;
  readonly polygon: readonly (readonly [number, number])[];
}

export interface SurfaceEditMetrics {
  readonly verticesBefore: number;
  readonly verticesAfter: number;
  readonly trianglesBefore: number;
  readonly trianglesAfter: number;
  readonly affectedTriangles: number;
  readonly regionArea: number;
  readonly error: {
    readonly metric: 'continuous_piecewise_linear_vertical_overlay';
    readonly sampleCount: number;
    readonly maximumVerticalError: number;
    readonly rmsVerticalError: number;
    readonly targetVerticalError: number | null;
    readonly certified: boolean;
  };
  readonly outsideIdentityHash: string;
  readonly resultHash: string;
}

export interface SurfaceEditRegionResult {
  readonly schemaId: 'hcad.mesh.edit-region-result@1';
  readonly editId: string;
  readonly targetEntityId: string;
  readonly targetRevision: number;
  readonly summary: {
    readonly vertices: number;
    readonly triangles: number;
    readonly protectedSegments: number;
    readonly area: number;
  };
  readonly checkpoint: 'region_selected';
}

export interface SurfaceEditPreview {
  readonly schemaId: 'hcad.mesh.surface-edit-preview@1';
  readonly editId: string;
  readonly algorithmId: 'hcad.mesh.smooth-region@1' | 'hcad.mesh.simplify-terrain@1';
  readonly metrics: SurfaceEditMetrics;
  readonly positions: readonly (readonly [number, number, number])[];
  readonly indices: readonly number[];
  readonly constrainedEdges: readonly (readonly [number, number])[];
}

export interface SurfaceEditBakeResult {
  readonly schemaId: 'hcad.mesh.surface-edit-result@1';
  readonly editId: string;
  readonly algorithmId: 'hcad.mesh.smooth-region@1' | 'hcad.mesh.simplify-terrain@1';
  readonly sourceEntityId: string;
  readonly entityId: string;
  readonly revision: number;
  readonly datasetId: string;
  readonly metrics: SurfaceEditMetrics;
  readonly journalEntry: CanonicalJournalEntry;
}

/** Typed renderer adapter over the single Electron/sidecar RPC boundary. */
export class BuilderSidecarTransport implements RpcTransport<AppFacadeMethods> {
  constructor(private readonly call: SidecarCall) {}

  request<Key extends keyof AppFacadeMethods>(
    method: Key,
    request: AppFacadeMethods[Key]['request'],
    options?: RpcRequestOptions,
  ): Promise<AppFacadeMethods[Key]['response']> {
    return withAbort(
      this.call<AppFacadeMethods[Key]['response']>(method, request),
      options?.signal,
    );
  }
}

/**
 * Owns the Builder's read model. Canonical state is never mutated here: a
 * committed journal entry advances the mirror, while gaps fail closed to a
 * complete snapshot refresh.
 */
export class BuilderCanonicalProjectSession {
  private constructor(
    private readonly document: DocumentClient,
    private readonly io: IoClient,
    private readonly registration: RegistrationClient,
    private readonly call: SidecarCall,
    private mirror: JournalMirror,
  ) {}

  static async open(
    projectRoot: string,
    call: SidecarCall,
  ): Promise<BuilderCanonicalProjectSession> {
    const transport = new BuilderSidecarTransport(call);
    const negotiated = await negotiateAppProtocol(transport, {
      clientName: 'himmelcad-builder',
      supportedVersions: [1],
      optionalCapabilities: ['io.formats.read', 'io.export'],
      requiredCapabilities: [
        'document.read',
        'document.write',
        'journal.read',
        'residency.read',
        'io.probe',
        'registration.import',
      ],
    });
    const snapshot = await new CanonicalProjectClient(transport).open(projectRoot);
    return new BuilderCanonicalProjectSession(
      new DocumentClient(transport, negotiated),
      new IoClient(transport, negotiated),
      new RegistrationClient(transport, negotiated),
      call,
      createJournalMirror(snapshot),
    );
  }

  projectSnapshot(): ProjectSnapshot {
    return projectSnapshotFromJournalMirror(this.mirror);
  }

  durabilityStatus(): Promise<BuilderDurabilityStatus> {
    return this.call('canonical.project.durability', {});
  }

  flushAndSnapshot(): Promise<BuilderDurabilityStatus> {
    return this.call('project.flush', {});
  }

  async undoDocument(): Promise<ProjectSnapshot> {
    const entry = await this.call<CanonicalJournalEntry>('project.undo', {
      commandId: `builder/document-undo/${crypto.randomUUID()}`,
    });
    return this.acceptCommittedEntry(entry);
  }

  async redoDocument(): Promise<ProjectSnapshot> {
    const entry = await this.call<CanonicalJournalEntry>('project.redo', {
      commandId: `builder/document-redo/${crypto.randomUUID()}`,
    });
    return this.acceptCommittedEntry(entry);
  }

  createSnapshot(name: string): Promise<BuilderSnapshotSummary> {
    return this.call('snapshot.create', { name });
  }

  listSnapshots(): Promise<readonly BuilderSnapshotSummary[]> {
    return this.call('snapshot.list', {});
  }

  async restoreSnapshot(entityId: string): Promise<ProjectSnapshot> {
    const result = await this.call<{
      readonly snapshot: BuilderSnapshotSummary;
      readonly journalEntry: CanonicalJournalEntry;
    }>('snapshot.restore', { entityId });
    return this.acceptCommittedEntry(result.journalEntry);
  }

  async createViewBookmark(name: string, state: unknown): Promise<BuilderViewBookmarkSummary> {
    const result = await this.call<{
      readonly bookmark: BuilderViewBookmarkSummary;
      readonly journalEntry: CanonicalJournalEntry;
    }>('view.bookmark.create', {
      commandId: `builder/view-bookmark/${crypto.randomUUID()}`,
      entityId: `view-bookmark-${crypto.randomUUID()}`,
      name,
      state,
    });
    await this.acceptCommittedEntry(result.journalEntry);
    return result.bookmark;
  }

  listViewBookmarks(): Promise<readonly BuilderViewBookmarkSummary[]> {
    return this.call('view.bookmark.list', {});
  }

  async restoreViewBookmark(
    entityId: string,
    expectedRevision: number,
  ): Promise<BuilderViewBookmarkSummary> {
    const result = await this.call<{
      readonly bookmark: BuilderViewBookmarkSummary;
      readonly journalEntry: CanonicalJournalEntry;
    }>('view.bookmark.restore', {
      commandId: `builder/view-bookmark-restore/${crypto.randomUUID()}`,
      entityId,
      expectedRevision,
    });
    await this.acceptCommittedEntry(result.journalEntry);
    return result.bookmark;
  }

  async putViewingBox(
    entityId: string,
    expectedRevision: number | null,
    name: string,
    state: unknown,
  ): Promise<BuilderViewingBoxSummary> {
    const result = await this.call<{
      readonly viewingBox: BuilderViewingBoxSummary;
      readonly journalEntry: CanonicalJournalEntry;
    }>('canonical.viewing_box.put', {
      commandId: `builder/viewing-box/${crypto.randomUUID()}`,
      entityId,
      name,
      expectedRevision,
      state,
    });
    await this.acceptCommittedEntry(result.journalEntry);
    return result.viewingBox;
  }

  listViewingBoxes(): Promise<readonly BuilderViewingBoxSummary[]> {
    return this.call('canonical.viewing_box.list', {});
  }

  canonicalEntity(entityId: string): CanonicalEntity | null {
    return this.mirror.entities[entityId] ?? null;
  }

  async createMeasurement(
    entityId: string,
    name: string,
    measurement: MeasurementV1,
  ): Promise<BuilderMeasurementSummary> {
    const result = await this.call<{
      readonly measurement: BuilderMeasurementSummary;
      readonly journalEntry: CanonicalJournalEntry;
    }>('measurement.create', {
      commandId: `builder/measurement-create/${crypto.randomUUID()}`,
      entityId,
      name,
      measurement,
    });
    await this.acceptCommittedEntry(result.journalEntry);
    return result.measurement;
  }

  listMeasurements(): Promise<readonly BuilderMeasurementSummary[]> {
    return this.call('measurement.list', {});
  }

  getMeasurement(entityId: string): Promise<BuilderMeasurementSummary> {
    return this.call('measurement.get', { entityId });
  }

  async deleteMeasurement(entityId: string, expectedRevision: number): Promise<void> {
    const result = await this.call<{ readonly journalEntry: CanonicalJournalEntry }>(
      'measurement.remove',
      {
        commandId: `builder/measurement-delete/${crypto.randomUUID()}`,
        entityId,
        expectedRevision,
      },
    );
    await this.acceptCommittedEntry(result.journalEntry);
  }

  async putDrawCurve(input: DrawCurveWrite): Promise<{
    readonly summary: BuilderDrawCurveSummary;
    readonly result: DrawCurveWriteResult;
  }> {
    const commandId = `builder/draw-curve/${crypto.randomUUID()}`;
    const response = await this.call<{
      readonly curve: BuilderDrawCurveSummary;
      readonly journalEntry: CanonicalJournalEntry;
    }>('draw.curve.put', { commandId, input });
    await this.acceptCommittedEntry(response.journalEntry);
    return {
      summary: response.curve,
      result: {
        entityId: response.curve.entityId,
        revision: response.curve.revision,
        commandId,
      },
    };
  }

  listDrawCurves(): Promise<readonly BuilderDrawCurveSummary[]> {
    return this.call('draw.curve.list', {});
  }

  async undoDrawCurve(
    targetCommandId: string,
  ): Promise<{ readonly entityId: string; readonly revision: number | null }> {
    const entry = await this.call<CanonicalJournalEntry>('draw.curve.undo', {
      commandId: `builder/draw-curve-undo/${crypto.randomUUID()}`,
      targetCommandId,
    });
    await this.acceptCommittedEntry(entry);
    const effect = entry.effects.find((candidate) => candidate.entityId !== 'default-layer');
    if (!effect) throw new Error('Draw undo returned no entity effect.');
    return { entityId: effect.entityId, revision: effect.after?.revision ?? null };
  }

  async deleteViewingBox(entityId: string, expectedRevision: number): Promise<void> {
    const result = await this.call<{ readonly journalEntry: CanonicalJournalEntry }>(
      'canonical.viewing_box.delete',
      {
        commandId: `builder/viewing-box-delete/${crypto.randomUUID()}`,
        entityId,
        expectedRevision,
      },
    );
    await this.acceptCommittedEntry(result.journalEntry);
  }

  async close(): Promise<boolean> {
    const result = await this.call<{ readonly closed: boolean }>('canonical.project.close', {});
    return result.closed;
  }

  async acceptCommittedEntry(entry: CanonicalJournalEntry): Promise<ProjectSnapshot> {
    this.mirror = reduceJournalMirror(this.mirror, entry);
    if (this.mirror.status === 'refresh-required') await this.refresh();
    return this.projectSnapshot();
  }

  async catchUp(): Promise<ProjectSnapshot | null> {
    const entries = await this.document.listAllJournalEntries({
      afterSequence: this.mirror.appliedThroughSequence,
    });
    if (entries.length === 0) return null;
    for (const entry of entries) {
      this.mirror = reduceJournalMirror(this.mirror, entry);
      if (this.mirror.status === 'refresh-required') return this.refresh();
    }
    return this.projectSnapshot();
  }

  async refresh(): Promise<ProjectSnapshot> {
    const snapshot = await this.document.snapshot();
    this.mirror = createJournalMirror(snapshot);
    return this.projectSnapshot();
  }

  async queryProperties(entityIds: readonly string[]): Promise<PropertyQueryResult> {
    const entities = this.exactEntityVersions(entityIds);
    return this.document.queryProperties({
      schemaId: PROPERTY_QUERY_REQUEST_SCHEMA_ID,
      entities,
      properties: [],
    });
  }

  productProvenance(
    entityIds: readonly string[],
  ): Promise<readonly BuilderPhotoLabProvenanceSummary[]> {
    return this.call('product.import.provenance', { entityIds });
  }

  async listIoFormats() {
    return this.io.listAllFormats();
  }

  async probeImport(sourcePath: string) {
    return this.io.probe({ sourcePath });
  }

  async stageRegisteredImport(
    sourcePath: string,
    recipe: RegistrationRecipe,
    options: JsonValue = {},
    requestedSessionId?: string,
  ) {
    const selection = await this.probeImport(sourcePath);
    const sessionId = requestedSessionId ?? `registration-${crypto.randomUUID()}`;
    const commandId = `builder-import-${crypto.randomUUID()}`;
    return this.registration.stage({
      sessionId,
      commandId,
      sourcePath,
      selection,
      options,
      recipe,
    });
  }

  async previewRegistrationPointPairs(sessionId: string, pairs: readonly RegistrationPointPair[]) {
    return this.registration.previewPointPairs(sessionId, pairs);
  }

  async previewRegistrationIcp(input: {
    readonly sessionId: string;
    readonly source: readonly RegistrationPoint[];
    readonly target: readonly RegistrationTargetSample[];
    readonly initial: RegistrationSimilarity3d;
    readonly mode: 'pointToPoint' | 'pointToPlane';
    readonly options: RegistrationIcpOptions;
  }) {
    return this.registration.previewIcp(input);
  }

  async registrationSourceSamples(sessionId: string, maximumSamples = 2_048) {
    return this.registration.sourceSamples(sessionId, maximumSamples);
  }

  async registrationProjectPointCloudSamples(datasetId: string, maximumSamples = 2_048) {
    return this.registration.projectPointCloudSamples(datasetId, maximumSamples);
  }

  async inspectRegistrationTransform(path: string) {
    return this.registration.inspectSiteCalibration(path);
  }

  async commitRegisteredImport(sessionId: string): Promise<ProjectSnapshot> {
    const commit = await this.registration.commit(sessionId);
    return this.acceptCommittedEntry(commit.journalEntry);
  }

  async cancelRegisteredImport(sessionId: string): Promise<boolean> {
    return this.registration.cancel(sessionId);
  }

  async setPointCloudDisplay(
    entityIds: readonly string[],
    display: PointCloudDisplayStyle,
  ): Promise<ProjectSnapshot> {
    const entry = await this.call<CanonicalJournalEntry>('pointcloud.display.set', {
      commandId: `builder/pointcloud-display/${crypto.randomUUID()}`,
      entities: this.exactEntityVersions(entityIds),
      display,
    });
    return this.acceptCommittedEntry(entry);
  }

  previewGround(input: {
    readonly operationId: string;
    readonly progressKey: string;
    readonly sourceEntityId: string;
    readonly parameters: GroundExtractionParameters;
    readonly scope: GroundExtractionScope;
    readonly sampleLimit?: number;
  }): Promise<GroundPreviewResult> {
    return this.call('pointcloud.ground.preview', {
      operationId: input.operationId,
      progressKey: input.progressKey,
      algorithmId: GROUND_ALGORITHM_ID,
      source: this.exactEntityVersions([input.sourceEntityId])[0],
      parameters: input.parameters,
      scope: input.scope,
      sampleLimit: input.sampleLimit ?? 20_000,
    });
  }

  async extractGround(input: {
    readonly operationId: string;
    readonly progressKey: string;
    readonly sourceEntityId: string;
    readonly groundEntityId: string;
    readonly outputName: string;
    readonly parameters: GroundExtractionParameters;
    readonly scope: GroundExtractionScope;
  }): Promise<GroundExtractionResult> {
    const result = await this.call<GroundExtractionResult>('pointcloud.ground.extract', {
      operationId: input.operationId,
      progressKey: input.progressKey,
      commandId: `builder/pointcloud-ground-extract/${crypto.randomUUID()}`,
      algorithmId: GROUND_ALGORITHM_ID,
      source: this.exactEntityVersions([input.sourceEntityId])[0],
      groundEntityId: input.groundEntityId,
      outputName: input.outputName,
      parameters: input.parameters,
      scope: input.scope,
    });
    await this.acceptCommittedEntry(result.journalEntry);
    return result;
  }

  cancelGround(operationId: string): Promise<{
    readonly operationId: string;
    readonly cancellationRequested: boolean;
  }> {
    return this.call('pointcloud.ground.cancel', { operationId });
  }

  createSurfaceDraft(input: {
    readonly operationId: string;
    readonly progressKey: string;
    readonly draftId: string;
    readonly name: string;
    readonly sources: readonly SurfaceSourceInput[];
    readonly rules: SurfaceRules;
  }): Promise<SurfaceDraftResult> {
    return this.call('mesh.surface.draft.create', {
      operationId: input.operationId,
      progressKey: input.progressKey,
      draftId: input.draftId,
      name: input.name,
      sources: input.sources.map((item) => ({
        source: this.exactEntityVersions([item.entityId])[0],
        role: item.role,
        visibleClasses: item.visibleClasses ?? [],
      })),
      rules: input.rules,
    });
  }

  checkSurface(draftId: string): Promise<SurfaceCheckResult> {
    return this.call('mesh.surface.check', { draftId });
  }

  fixSurface(
    draftId: string,
    errorId: string,
    fix: 'drop' | 'snap' | 'split' | 'exclude',
    authoritySourceId?: string,
  ): Promise<{ readonly check: SurfaceCheckResult }> {
    return this.call('mesh.surface.draft.apply_fix', {
      draftId,
      errorId,
      fix,
      authoritySourceId,
    });
  }

  async publishSurface(input: {
    readonly operationId: string;
    readonly progressKey: string;
    readonly draftId: string;
    readonly outputEntityId: string;
  }): Promise<SurfacePublishResult> {
    const result = await this.call<SurfacePublishResult>('mesh.surface.create', {
      ...input,
      commandId: `builder/mesh-surface-create/${crypto.randomUUID()}`,
    });
    await this.acceptCommittedEntry(result.journalEntry);
    return result;
  }

  cancelSurface(
    operationId: string,
  ): Promise<{ readonly operationId: string; readonly cancellationRequested: boolean }> {
    return this.call('mesh.surface.cancel', { operationId });
  }

  selectSurfaceEditRegion(
    editId: string,
    targetEntityId: string,
    region: SurfaceEditRegion,
  ): Promise<SurfaceEditRegionResult> {
    return this.call('mesh.edit.region.select', {
      editId,
      target: this.exactEntityVersions([targetEntityId])[0],
      region,
    });
  }

  previewSurfaceSmooth(
    operationId: string,
    editId: string,
    filter: SurfaceSmoothFilter,
    radius: number,
  ): Promise<SurfaceEditPreview> {
    return this.call('mesh.edit.smooth.preview', {
      operationId,
      progressKey: operationId,
      editId,
      parameters: { filter, radius },
    });
  }

  previewSurfaceDownsample(
    operationId: string,
    editId: string,
    maximumVerticalError: number,
  ): Promise<SurfaceEditPreview> {
    return this.call('mesh.edit.downsample.preview', {
      operationId,
      progressKey: operationId,
      editId,
      parameters: { maximumVerticalError },
    });
  }

  async bakeSurfaceEdit(input: {
    readonly kind: 'smooth' | 'downsample';
    readonly operationId: string;
    readonly editId: string;
    readonly outputEntityId: string;
    readonly outputName: string;
    readonly smooth?: { readonly filter: SurfaceSmoothFilter; readonly radius: number };
    readonly downsample?: { readonly maximumVerticalError: number };
  }): Promise<SurfaceEditBakeResult> {
    const result = await this.call<SurfaceEditBakeResult>(`mesh.edit.${input.kind}`, {
      operationId: input.operationId,
      progressKey: input.operationId,
      commandId: `builder/mesh-edit-${input.kind}/${crypto.randomUUID()}`,
      editId: input.editId,
      outputEntityId: input.outputEntityId,
      outputName: input.outputName,
      smooth: input.smooth,
      downsample: input.downsample,
    });
    await this.acceptCommittedEntry(result.journalEntry);
    return result;
  }

  cancelSurfaceEdit(
    operationId: string,
  ): Promise<{ readonly operationId: string; readonly cancellationRequested: boolean }> {
    return this.call('mesh.edit.cancel', { operationId });
  }

  async segmentPointClouds(input: {
    readonly operationId: string;
    readonly progressKey: string;
    readonly sourceEntityIds: readonly string[];
    readonly volume: KernelFenceVolume;
    readonly side: 'keep_inside' | 'remove_inside';
    readonly scopes: ReadonlyMap<string, GroundExtractionScope>;
  }): Promise<PointCloudSegmentResult> {
    const result = await this.call<PointCloudSegmentResult>(`pointcloud.segment.${input.side}`, {
      operationId: input.operationId,
      progressKey: input.progressKey,
      commandId: `builder/pointcloud-segment/${crypto.randomUUID()}`,
      algorithmId: 'hcad.pointcloud.segment@1',
      sources: this.exactEntityVersions(input.sourceEntityIds).map((source) => ({
        source,
        scope: input.scopes.get(source.id),
      })),
      volume: input.volume,
      side: input.side,
    });
    await this.acceptCommittedEntry(result.journalEntry);
    return result;
  }

  cancelSegmentation(operationId: string): Promise<{
    readonly operationId: string;
    readonly cancellationRequested: boolean;
  }> {
    return this.call('pointcloud.segment.cancel', { operationId });
  }

  async samplePointCloud(input: {
    readonly operationId: string;
    readonly progressKey: string;
    readonly sourceEntityId: string;
    readonly outputEntityId: string;
    readonly outputName: string;
    readonly parameters: PointcloudSampleParameters;
    readonly scope: GroundExtractionScope;
  }): Promise<PointcloudSampleResult> {
    const result = await this.call<PointcloudSampleResult>('pointcloud.sample', {
      operationId: input.operationId,
      progressKey: input.progressKey,
      commandId: `builder/pointcloud-sample/${crypto.randomUUID()}`,
      algorithmId: SAMPLE_ALGORITHM_ID,
      source: this.exactEntityVersions([input.sourceEntityId])[0],
      outputEntityId: input.outputEntityId,
      outputName: input.outputName,
      parameters: input.parameters,
      scope: input.scope,
    });
    await this.acceptCommittedEntry(result.journalEntry);
    return result;
  }

  async rasterizePointCloud(input: {
    readonly operationId: string;
    readonly progressKey: string;
    readonly sourceEntityId: string;
    readonly outputEntityId: string;
    readonly outputName: string;
    readonly parameters: PointcloudRasterizeParameters;
    readonly scope: GroundExtractionScope;
  }): Promise<PointcloudRasterizeResult> {
    const result = await this.call<PointcloudRasterizeResult>('pointcloud.rasterize', {
      operationId: input.operationId,
      progressKey: input.progressKey,
      commandId: `builder/pointcloud-rasterize/${crypto.randomUUID()}`,
      algorithmId: RASTERIZE_ALGORITHM_ID,
      source: this.exactEntityVersions([input.sourceEntityId])[0],
      outputEntityId: input.outputEntityId,
      outputName: input.outputName,
      parameters: input.parameters,
      scope: input.scope,
    });
    await this.acceptCommittedEntry(result.journalEntry);
    return result;
  }

  cancelPointcloudProcessing(operationId: string): Promise<{
    readonly operationId: string;
    readonly cancellationRequested: boolean;
  }> {
    return this.call('pointcloud.processing.cancel', { operationId });
  }

  async planExport(request: Parameters<IoClient['planExport']>[0]) {
    return this.io.planExport(request);
  }

  async listFormats() {
    return this.io.listAllFormats();
  }

  async executeExport(
    operationId: string,
    acceptedPlan: Awaited<ReturnType<IoClient['planExport']>>,
  ) {
    return this.io.executeExport(operationId, acceptedPlan);
  }

  exportStatus(operationId: string) {
    return this.io.operationStatus(operationId);
  }

  cancelExport(operationId: string) {
    return this.io.cancelOperation(operationId);
  }

  /** Compiles and executes one atomic, undoable edit over the exact queried revisions. */
  async assignProperty(
    query: PropertyQueryResult,
    assignment: PropertyAssignment,
  ): Promise<ProjectSnapshot> {
    const transaction = await this.document.compilePropertyEdit({
      schemaId: PROPERTY_EDIT_REQUEST_SCHEMA_ID,
      commandId: `builder/property/${crypto.randomUUID()}`,
      entities: query.entities,
      assignments: [assignment],
    });
    const committed = await this.document.executeCanonicalTransaction(transaction);
    return this.acceptCommittedEntry(committed);
  }

  private exactEntityVersions(entityIds: readonly string[]) {
    const unique = [...new Set(entityIds)].sort();
    if (unique.length === 0) throw new Error('property query requires a selection');
    return unique.map((entityId) => {
      const entity = this.mirror.entities[entityId];
      if (!entity) throw new Error(`selected canonical entity is no longer live: ${entityId}`);
      return { id: entity.id, revision: entity.revision, versionHash: entity.versionHash };
    });
  }
}

export function projectSnapshotFromDocument(snapshot: AppDocumentSnapshot): ProjectSnapshot {
  return projectSnapshotFromJournalMirror(createJournalMirror(snapshot));
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}
