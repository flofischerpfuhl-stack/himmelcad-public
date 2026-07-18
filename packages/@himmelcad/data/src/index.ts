/**
 * Hand-written contract types for the renderer.
 * Generated counterparts (from Rust via ts-rs) will land in src/generated/
 * and re-export through this barrel. Until the Rust contract crate ships,
 * these definitions are authoritative for the renderer-only skeleton.
 */

export type EntityId = string & { readonly __brand: 'EntityId' };

export type ObjectHash = string & { readonly __brand: 'ObjectHash' };

export type EntityKind =
  | 'ProjectRoot'
  | 'Group'
  | 'Layer'
  | 'Survey'
  | 'ImageCollection'
  | 'CameraImage'
  | 'CameraCalibration'
  | 'ProcessingSet'
  | 'AlignmentRun'
  | 'DepthMap'
  | 'GroundControlPoint'
  | 'Orthomosaic'
  | 'DigitalElevationModel'
  | 'PointCloud'
  | 'PointCloudSegment'
  | 'SinglePoint'
  | 'Polyline3D'
  | 'Mesh'
  | 'TexturedMesh'
  | 'Surface'
  | 'Solid'
  | 'Object'
  | 'GaussianSplatCloud'
  | 'Text'
  | 'Axis'
  | 'AlignmentElement'
  | 'IfcElement'
  | 'Pipe'
  | 'Manhole'
  | 'SimulationOverlay';

export type AlignmentQualityProfile = 'qualityHybrid' | 'maximumRobustness' | 'fast';

export type SparseMatchingBackend = 'alikedN32LightGlue' | 'siftLightGlue';

export type MatchingScope = 'allCandidatePairs' | 'qualityGated';

export type PairGraphMode = 'referenceSequenceRetrieval' | 'expandedReferenceSequenceRetrieval';

export interface ResolveAlignmentProfileRequest {
  profile: AlignmentQualityProfile;
  imageCount: number;
  maxImageEdgeOverride?: number;
}

/** Complete core-resolved settings persisted by a queued Photolab run. */
export interface ResolvedAlignmentConfig {
  schemaVersion: number;
  profile: AlignmentQualityProfile;
  imageCount: number;
  offlineRequired: boolean;
  pairGraphMode: PairGraphMode;
  sparseBackends: SparseMatchingBackend[];
  learnedSparseScope: MatchingScope;
  siftScope: MatchingScope;
  largeBackend: 'dedodeV2G';
  largeBackendScope: MatchingScope;
  denseRescueEnabled: boolean;
  maxImageEdge: number;
  keypointsPerMegapixel: number;
  checkpointPairBlockSize: number;
  cancellationCheckPairInterval: number;
  configHash: ObjectHash;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

export interface VisibilityState {
  visible: boolean;
  locked: boolean;
}

export interface EntitySnapshot {
  id: EntityId;
  kind: EntityKind;
  name: string;
  parent: EntityId | null;
  children: EntityId[];
  visibility: VisibilityState;
  versionHash: ObjectHash;
  bounds: Bounds3 | null;
}

export interface ProjectSnapshot {
  formatVersion: number;
  projectId: string;
  name: string;
  rootEntity: EntityId;
  entities: Record<string, EntitySnapshot>;
  renderOffset: Vec3;
}

export interface PhotolabProjectManifest {
  formatVersion: number;
  projectId: string;
  name: string;
  createdUnixMs: number;
  modifiedUnixMs: number;
  autosaveGeneration: number;
  commandSequence: number;
  cleanShutdown: boolean;
  rootEntity: EntityId;
  entities: Record<string, EntitySnapshot>;
  renderOffset: Vec3;
  referenceFrame?: {
    target: unknown;
    establishedByTransformationSha256: ObjectHash;
  };
  activeRuns: string[];
}

export interface ProjectSessionSummary {
  sessionId: string;
  sourcePath: string;
  workingPath: string;
  usesLocalWorkingCopy: boolean;
  recoveryAvailable: boolean;
  readOnly: boolean;
  autosaveGeneration: number;
  lastSavedGeneration: number;
}

export interface OpenPhotolabProjectResult {
  session: ProjectSessionSummary;
  manifest: PhotolabProjectManifest;
}

export type JournalCommandState = 'started' | 'committed' | 'cancelled' | 'failed';

export interface PhotolabJournalEntry {
  sequence: number;
  commandId: string;
  commandKind: string;
  timestampUnixMs: number;
  state: JournalCommandState;
  payload: unknown;
  affectedEntities: EntityId[];
  beforeRefs: ObjectHash[];
  afterRefs: ObjectHash[];
  message?: string;
}

export type PhotolabJobKind =
  | 'alignPhotos'
  | 'optimizeAlignment'
  | 'buildDepthMaps'
  | 'buildDensePointCloud'
  | 'buildDem'
  | 'buildOrthomosaic'
  | 'buildMesh'
  | 'buildGaussianSplat'
  | 'exportProduct'
  | 'batch';

export interface ProcessingSetRecord {
  schemaVersion: 1;
  entityId: EntityId;
  name: string;
  cameraEntityIds: EntityId[];
  membershipSha256: ObjectHash;
}

export type PhotolabStageKind =
  | 'preparing'
  | 'candidatePairSelection'
  | 'featureExtraction'
  | 'featureMatching'
  | 'geometricVerification'
  | 'sparseReconstruction'
  | 'bundleAdjustment'
  | 'depthEstimation'
  | 'denseFusion'
  | 'rasterization'
  | 'meshing'
  | 'splatOptimization'
  | 'finalizing';

export type PhotolabJobState =
  | { kind: 'queued' }
  | { kind: 'running' }
  | { kind: 'pauseRequested' }
  | { kind: 'paused' }
  | { kind: 'cancelRequested' }
  | { kind: 'cancelled' }
  | { kind: 'completed' }
  | { kind: 'failed'; code: string; message: string };

export interface PhotolabJobProgress {
  stage: {
    kind: PhotolabStageKind;
    index: number;
    stageCount: number;
    label: string;
  };
  metrics: {
    completedUnits: number;
    totalUnits?: number;
    completedBytes: number;
    totalBytes?: number;
  };
}

export interface PhotolabJob {
  schemaVersion: number;
  id: string;
  kind: PhotolabJobKind;
  configHash: ObjectHash;
  inputHash: ObjectHash;
  state: PhotolabJobState;
  progress: PhotolabJobProgress;
  createdAtUnixMs: number;
  startedAtUnixMs?: number;
  finishedAtUnixMs?: number;
  lastCheckpointSequence?: number;
}

export interface HardwareCapabilities {
  operatingSystem: 'windows' | 'linux';
  ramBytes: number;
  dedicatedVramBytes?: number;
  cpu: {
    physicalCores: number;
    logicalCores: number;
    supportsAvx2: boolean;
  };
  vulkan?: {
    apiVersion: string;
    deviceName: string;
  };
  cuda?: {
    deviceName: string;
    computeCapability: { major: number; minor: number };
  };
}

export type PhotoFormat =
  | 'jpeg'
  | 'tiff'
  | 'dng'
  | 'png'
  | 'heic'
  | 'heif'
  | 'avif'
  | 'canonCr3'
  | 'fujifilmRaf'
  | 'phaseOneIiq';

export interface ImportedHeight {
  meters: number;
  semanticReference: 'unknown';
}

export interface ExifGpsPosition {
  latitudeDegrees: number;
  longitudeDegrees: number;
  altitude?: ImportedHeight;
}

export interface DjiAttitudeDegrees {
  yaw?: number;
  pitch?: number;
  roll?: number;
}

export interface PhotoMetadata {
  exif: {
    make?: string;
    model?: string;
    lensModel?: string;
    focalLengthMm?: number;
    dimensions?: { widthPixels: number; heightPixels: number };
    orientation?:
      | 'normal'
      | 'mirrorHorizontal'
      | 'rotate180'
      | 'mirrorVertical'
      | 'mirrorHorizontalRotate270Clockwise'
      | 'rotate90Clockwise'
      | 'mirrorHorizontalRotate90Clockwise'
      | 'rotate270Clockwise';
    capturedAt?: {
      value: string;
      reference: 'embeddedUtcOffset' | 'unknownLocalTime';
    };
    gps?: ExifGpsPosition;
  };
  djiXmp: {
    latitudeDegrees?: number;
    longitudeDegrees?: number;
    groundAltitude?: ImportedHeight;
    absoluteAltitude?: ImportedHeight;
    relativeAltitude?: ImportedHeight;
    flightAttitude?: DjiAttitudeDegrees;
    gimbalAttitude?: DjiAttitudeDegrees;
    rtk?: {
      flag?: string;
      standardDeviationLongitudeMeters?: number;
      standardDeviationLatitudeMeters?: number;
      standardDeviationHeightMeters?: number;
    };
    calibratedFocalLengthPixels?: number;
    calibratedOpticalCenterXPixels?: number;
    calibratedOpticalCenterYPixels?: number;
  };
}

export interface DiscoveredPhoto {
  sourcePath: string;
  format: PhotoFormat;
  byteSize: number;
  sha256: ObjectHash;
  metadata: PhotoMetadata;
  duplicateOf?: string;
}

export type ImageImportWarningCode =
  | 'pathUnavailable'
  | 'directoryReadFailed'
  | 'symlinkSkipped'
  | 'unsupportedFormat'
  | 'fileReadFailed'
  | 'exifParseFailed'
  | 'exifEntryInvalid'
  | 'metadataValueInvalid'
  | 'xmpScanLimitReached'
  | 'xmpMalformed'
  | 'xmpUnsafeXmlIgnored'
  | 'duplicateContent';

export interface ImageImportWarning {
  sourcePath: string;
  code: ImageImportWarningCode;
  message: string;
}

export interface PhotoImportBatch {
  photos: DiscoveredPhoto[];
  warnings: ImageImportWarning[];
}

export type ImageProductTag =
  | 'qualityWarning'
  | 'aligned'
  | 'alignmentStale'
  | 'depthReady'
  | 'depthStale'
  | 'masked'
  | 'rtkFixed';

export interface ProjectedPhotoReference {
  sourceLatitudeDegrees: number;
  sourceLongitudeDegrees: number;
  sourceHeightMeters?: number;
  easting: number;
  northing: number;
  transformedHeightMeters?: number;
  transformationDecisionSha256: ObjectHash;
}

export interface ProjectCameraImageRecord {
  entityId: EntityId;
  name: string;
  metadataObjectHash: ObjectHash;
  metadata: {
    schemaVersion: number;
    sourceObjectHash: ObjectHash;
    transformationObjectHash: ObjectHash;
    inspectedPhoto: DiscoveredPhoto;
    projectedReference?: ProjectedPhotoReference;
    statusTags: ImageProductTag[];
  };
}

export type GcpRole =
  | 'controlXyz'
  | 'controlXy'
  | 'controlZ'
  | 'checkpointXyz'
  | 'checkpointXy'
  | 'checkpointZ'
  | 'disabled';

export type CsvColumnSelector =
  | { kind: 'header'; value: string }
  | { kind: 'index'; value: number };

export interface GcpCsvImportMapping {
  delimiter: string;
  decimalSeparator: 'point' | 'comma';
  hasHeader: boolean;
  name: CsvColumnSelector;
  east: CsvColumnSelector;
  north: CsvColumnSelector;
  height: CsvColumnSelector;
  horizontalStddev?: CsvColumnSelector;
  heightStddev?: CsvColumnSelector;
  role?: CsvColumnSelector;
  defaultRole: GcpRole;
  defaultUncertainty: {
    horizontalStddevMeters: number;
    heightStddevMeters: number;
  };
}

export interface GcpPoint {
  id: string;
  name: string;
  coordinate: { eastMeters: number; northMeters: number; heightMeters: number };
  uncertainty: { horizontalStddevMeters: number; heightStddevMeters: number };
  role: GcpRole;
}

export interface GcpCsvPreview {
  sourcePath: string;
  sourceSha256: ObjectHash;
  sourceBytes: number;
  header: string[];
  previewRows: { sourceLine: number; point: GcpPoint }[];
  validPointCount: number;
  dataRowCount: number;
  errors: { sourceLine: number; field: string; message: string }[];
  previewTruncated: boolean;
  requiresCrsDecision: boolean;
}

export interface GcpCollectionRecord {
  schemaVersion: number;
  previousCollectionSha256?: ObjectHash;
  points: {
    point: GcpPoint;
    sourceCsvSha256: ObjectHash;
    transformationSha256: ObjectHash;
  }[];
  observations: GcpObservation[];
}

export interface GcpImageCoordinate {
  xPixels: number;
  yPixels: number;
}

export type GcpObservationState =
  | { state: 'manual'; coordinate: GcpImageCoordinate }
  | { state: 'automatic'; coordinate: GcpImageCoordinate; confidencePerMille: number }
  | {
      state: 'predicted';
      coordinate: GcpImageCoordinate;
      confidencePerMille: number;
      source: string;
    }
  | { state: 'blocked'; predictedCoordinate?: GcpImageCoordinate; reason: string };

export interface GcpObservation {
  pointId: string;
  imageId: number;
  state: GcpObservationState;
}

export type GcpObservationEdit =
  | { action: 'block'; coordinate: GcpImageCoordinate; reason: string }
  | { action: 'unblock' }
  | { action: 'remove' };

export interface EditGcpObservationResult {
  operationId: string;
  collectionSha256: ObjectHash;
  restoredState?: GcpObservationState;
  autosaveGeneration: number;
  journalSequence: number;
}

export interface GcpOptimizationSnapshotResult {
  operationId: string;
  collectionSha256: ObjectHash;
  snapshotSha256: ObjectHash;
  residualScopeSha256: ObjectHash;
  residualScope: {
    schemaVersion: number;
    label: string;
    collectionSha256: ObjectHash;
    optimizationSnapshotSha256: ObjectHash;
    controlPointIds: string[];
    checkpointPointIds: string[];
    cameraReferenceImageIds: number[];
  };
  autosaveGeneration: number;
  journalSequence: number;
}

export interface GcpResidualStatistics {
  pointCount: number;
  eastRmsMeters?: number;
  northRmsMeters?: number;
  horizontalRmsMeters?: number;
  heightRmsMeters?: number;
  spatial3dRmsMeters?: number;
  activeComponentRmsMeters: number;
  reprojectionRmsPixels: number;
  maxActiveComponentMeters: number;
  maxReprojectionPixels: number;
}

export interface GcpOptimizationPublicationRecord {
  schemaVersion: number;
  operationId: string;
  inputSha256: ObjectHash;
  artifactSha256: ObjectHash;
  snapshotSha256: ObjectHash;
  artifact: {
    schemaVersion: number;
    solver: string;
    inputSha256: ObjectHash;
    snapshotSha256: ObjectHash;
    result: {
      transform: {
        scale: number;
        rotation: [number, number, number, number, number, number, number, number, number];
        translationMeters: [number, number, number];
      };
      effectiveMode: 'auto' | 'translationOnly' | 'similarity7';
      cameras: {
        imageId: number;
        widthPixels: number;
        heightPixels: number;
        focalXPixels: number;
        focalYPixels: number;
        principalXPixels: number;
        principalYPixels: number;
        radialDistortion: [number, number, number];
        tangentialDistortion: [number, number];
        cameraToWorldRotation: [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        centerWorldMeters: [number, number, number];
      }[];
      residuals: {
        pointId: string;
        role: Exclude<GcpRole, 'disabled'>;
        eastMeters?: number;
        northMeters?: number;
        heightMeters?: number;
        horizontalMeters?: number;
        spatial3dMeters?: number;
        activeComponentNormMeters: number;
        reprojectionRmsPixels: number;
        reprojectionMaxPixels: number;
      }[];
      points: { pointId: string; observationCount: number }[];
      statistics: {
        control?: GcpResidualStatistics;
        checkpoint?: GcpResidualStatistics;
      };
      projections: {
        pointId: string;
        imageId: number;
        coordinate: GcpImageCoordinate;
        uncertainty: {
          semiMajorPixels: number;
          semiMinorPixels: number;
          angleDegrees: number;
        };
      }[];
      iterations: number;
      converged: boolean;
      finalObjective: number;
    };
  };
  sourceAlignmentEntityId?: EntityId;
  processingSetId?: EntityId;
}

export interface AlignedGcpCameraRecord {
  imageId: number;
  entityId: EntityId;
  imageName: string;
  sourceObjectHash: ObjectHash;
  camera: {
    imageId: number;
    widthPixels: number;
    heightPixels: number;
    focalXPixels: number;
    focalYPixels: number;
    principalXPixels: number;
    principalYPixels: number;
    radialDistortion: [number, number, number];
    tangentialDistortion: [number, number];
    cameraToReconstructionRotation: [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    centerReconstruction: [number, number, number];
  };
}

export type SnapKind = 'Point' | 'Vertex' | 'Edge' | 'Face' | 'Grid' | 'EstimatedSurface' | 'Free';

export type GeometryDatasetKind =
  | 'camera'
  | 'point-cloud'
  | 'mesh'
  | 'textured-mesh'
  | 'surface'
  | 'dgm'
  | 'splat'
  | 'cad'
  | 'grid'
  | 'fallback';

export type SnapSource = GeometryDatasetKind;

export type GeometryPrimitiveRef =
  | {
      kind: 'point';
      pointIndex: number;
    }
  | {
      kind: 'vertex';
      vertexIndex: number;
      ownerFaceIndex?: number;
    }
  | {
      kind: 'edge';
      edgeIndex?: number;
      vertexA?: number;
      vertexB?: number;
      ownerFaceIndex?: number;
    }
  | {
      kind: 'face';
      faceIndex: number;
      triangleIndex?: number;
      barycentric?: Vec3;
    }
  | {
      kind: 'splat';
      splatIndex: number;
    }
  | {
      kind: 'grid';
      cellX?: number;
      cellY?: number;
    }
  | {
      kind: 'estimated-surface';
      supportKind: GeometryDatasetKind;
      supportRadius?: number;
    }
  | {
      kind: 'free';
    };

/**
 * Addressable geometry target behind a cursor snap.
 *
 * Renderer providers may produce approximate targets for hover/pivot use.
 * Commands that mutate CAD state must require `exact: true` and revalidate the
 * referenced entity/tile/primitive in the Rust core before writing.
 */
export interface GeometryTargetRef {
  datasetKind: GeometryDatasetKind;
  entityId: EntityId | null;
  layerId?: string;
  tileId?: string;
  primitive: GeometryPrimitiveRef;
  exact: boolean;
}

export interface SnapTargetMask {
  kinds?: Partial<Record<SnapKind, boolean>>;
  sources?: Partial<Record<SnapSource, boolean>>;
}

export interface SnapResult {
  position: Vec3;
  kind: SnapKind;
  entity: EntityId | null;
  confidence: number;
  /** Renderer-internal position before adding the scene render offset. */
  localPosition?: Vec3;
  /** Candidate source used for ranking and display. */
  source?: SnapSource;
  /** Stable reference used by future commands for exact core-side refinement. */
  target?: GeometryTargetRef;
  /** Pointer-to-candidate distance in screen pixels. */
  distancePx?: number;
  /** Stable candidates are safe for drawing tools and future camera pivots. */
  stable?: boolean;
  /** Stable key used for snap hierarchy cycling. */
  candidateId?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  level: LogLevel;
  source: 'renderer' | 'sidecar' | 'electron';
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
  /** 0..1 progress fraction. When set, the console renders an inline bar. */
  progress?: number;
  /** Stable key so the console can update an existing progress line in-place. */
  progressKey?: string;
}

export type CommandKind =
  | 'CreateProject'
  | 'OpenProject'
  | 'ImportPointCloudBatch'
  | 'RenameEntity'
  | 'SetEntityVisibility'
  | 'SetEntityStyle'
  | 'CreateSelectionMask'
  | 'ExtractPointCloudSegment'
  | 'SetPanelState'
  | 'ResolvePhotolabAlignmentProfile';

export interface CommandRequest<P = unknown> {
  kind: CommandKind;
  payload: P;
}

export interface CommandResult {
  ok: boolean;
  affectedEntities: EntityId[];
  message?: string;
}
