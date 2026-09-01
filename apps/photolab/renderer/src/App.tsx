import { ManagedAgentChat, ManagedAutomationApproval } from '@himmelcad/agent';
import {
  encodeRgbaScreenshot,
  parseViewState,
  validateScreenshotRequest,
  type Quaternion,
  type ScopedClip,
  type ScreenshotRequestV1,
  type ViewStateV1,
} from '@himmelcad/app';
import { consoleStore, logEvent } from '@himmelcad/console';
import type {
  AlignmentQualityProfile,
  AlignedGcpCameraRecord,
  AlignmentMergeCandidateRecord,
  AlignmentMergeConnection,
  CameraCalibrationGroupRecord,
  CaptureGroupRecord,
  EntityId,
  GcpCollectionRecord,
  GcpLocalEstimateArtifact,
  GcpIntrinsicsPolicy,
  GcpCsvImportMapping,
  GcpCsvPreview,
  GcpOptimizationPublicationRecord,
  GcpOptimizationSnapshotResult,
  GcpObservationEdit,
  HardwareCapabilities,
  HcapImportPreview,
  EditImageMaskParams,
  EditImageMaskResult,
  ImageQualityAnalysisRecord,
  ListedImageMaskRevision,
  MergedAlignmentRunRecord,
  ObjectHash,
  OpenPhotolabProjectResult,
  PhotolabJournalEntry,
  PhotolabJob,
  PhotoImportBatch,
  ProcessingSetRecord,
  PublishedGcpOptimizationEntry,
  ProjectCameraImageRecord,
  ProjectSnapshot,
  ResolvedAlignmentConfig,
  SnapResult,
} from '@himmelcad/data';
import {
  AppShell,
  EntityTree,
  FunctionPanel,
  IslandTabs,
  OverlayChip,
  PanelToggles,
  Ribbon,
  StatusBar,
  TitleBar,
  useLayoutStore,
  type WindowControls,
} from '@himmelcad/ui';
import type {
  CanonicalRepresentationAdmission,
  KernelClipVolume,
  KernelWorldCamera,
} from '@himmelcad/viewer/kernel';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import photolabLogoUrl from '../../build/mark.png';

import { AlignmentProfilePanel } from './AlignmentProfilePanel.js';
import { AlignmentMergePanel } from './AlignmentMergePanel.js';
import {
  DEFAULT_FACTORY_ALIGNMENT_PRESET,
  defaultOverridesForProfile,
  type AlignmentPresetFile,
  type AlignmentPresetOverrides,
} from './alignmentPreset.js';
import styles from './App.module.css';
import { DefineAlignmentDialog } from './DefineAlignmentDialog.js';
import { BatchConfiguratorPanel, type BatchPipelineStep } from './BatchConfiguratorPanel.js';
import { BatchRecipeDialog } from './BatchRecipeDialog.js';
import { resolveBatchPipelineSteps } from './batchRecipe.js';
import { CaptureGroupsPanel } from './CaptureGroupsPanel.js';
import type { CaptureCalibrationDraft } from './captureGroupDraft.js';
import { ConfirmationDialog } from './ConfirmationDialog.js';
import type { GcpAccuracyReport } from './GcpAccuracyPanel.js';
import type { GcpImageMarker, GcpManualMeasurement } from './GcpImageMarkerOverlay.js';
import { GcpImportPanel } from './GcpImportPanel.js';
import { GcpImagesPanel } from './GcpImagesPanel.js';
import { GcpOptimizationPanel, type GcpOptimizationSelection } from './GcpOptimizationPanel.js';
import { GcpPropertiesPanel } from './GcpPropertiesPanel.js';
import { FloatingTaskIsland } from './FloatingTaskIsland.js';
import {
  PhotolabExternalImportDialog,
  type PhotolabRegistrationPointCloudLayer,
} from './PhotolabExternalImportDialog.js';
import { ImageImportPanel } from './ImageImportPanel.js';
import type {
  CrsOperationDiscovery,
  CrsOperationQuery,
  ImageImportProgress,
  ImageImportDecision,
  LocalGridSelection,
} from './ImageImportPanel.js';
import { ImageWorkspace, initialGcpProjection } from './ImageWorkspace.js';
import { ImagePropertiesPanel } from './ImagePropertiesPanel.js';
import { SelectionPropertiesPanel } from './SelectionPropertiesPanel.js';
import { PhotolabBottomPanel, type BottomTab } from './PhotolabBottomPanel.js';
import {
  PhotolabKernelViewport,
  type CameraImageRectangle,
  type GcpMarker,
  type PhotolabKernelViewportHandle,
  type PreparedMeshDescriptor,
} from './PhotolabKernelViewport.js';
import { ProjectDiagnosticsPanel, type ProjectDiagnosticsKind } from './ProjectDiagnosticsPanel.js';
import {
  ProductPanel,
  defaultProductConfiguration,
  type ProductOperation,
  type ProductRunConfiguration,
} from './ProductPanel.js';
import { ProjectFileOperationDialog } from './ProjectFileOperationDialog.js';
import {
  applyProjectProgress,
  createProjectFileOperation,
  failProjectFileOperation,
  requestProjectCancellation,
  type ProjectArchiveProgress,
  type ProjectFileOperationState,
  type ProjectProgressEvent,
} from './projectFileOperation.js';
import { createPhotolabProject } from './project.js';
import { PhotolabExternalImportSession } from './externalImportSession.js';
import { createPhotolabRibbonTabs } from './ribbon.js';
import {
  EntityLoadGenerationGuard,
  ProjectRefreshGuard,
  entityLoadToken,
  newlyFailedJobIds,
  requiresFullSceneReset,
  type SceneIdentity,
} from './viewerLifecycle.js';

const DEFAULT_IMAGE_COUNT = 0;
const SIDECAR_PROGRESS_PREFIX = '__HC_PROGRESS__';
type WorkspaceMode = 'scene' | 'images';
interface ProjectProductDatasetRecord {
  entityId: EntityId;
  kind: 'gaussianSplat' | 'dem' | 'orthomosaic' | 'mesh' | 'depth' | 'dense' | 'sparse';
  relativePath: string;
  format:
    | 'brushPly'
    | 'prepared'
    | 'rasterPyramid'
    | 'tiledMesh'
    | 'mvsDepth'
    | 'binaryPly'
    | 'potreeV2';
  visible: boolean;
  preparedMesh?: PreparedMeshDescriptor;
  boundsMin?: [number, number, number];
  boundsMax?: [number, number, number];
  renderOffset?: [number, number, number];
  pointCount?: number;
  versionHash?: ObjectHash;
  sourceAlignmentEntityId?: EntityId;
  processingSetId?: EntityId;
  gcpOptimizationEntityId?: EntityId;
  gcpOptimizationSnapshotSha256?: ObjectHash;
}

interface PendingProductExportConfirmation {
  token: string;
  displayName: string;
  entityName: string;
}

interface ProductLayerStatus {
  state: 'loading' | 'error';
  name: string;
  message?: string;
}

interface ExternalImportResidency {
  readonly schemaVersion: 1;
  readonly entries: readonly {
    readonly admission: unknown;
    readonly dataset: {
      readonly datasetId: string;
      readonly formatId: string;
      readonly entityId: string;
      readonly representationSlot: string;
      readonly metadataUrl: string;
    } | null;
  }[];
}

export function App(): JSX.Element {
  const [project, setProject] = useState<ProjectSnapshot>(createPhotolabProject);
  const [selected, setSelected] = useState<ReadonlySet<EntityId>>(new Set());
  const [pendingImageRemoval, setPendingImageRemoval] = useState<readonly EntityId[] | null>(null);
  const [imageRemovalBusy, setImageRemovalBusy] = useState(false);
  const [pendingProductExport, setPendingProductExport] =
    useState<PendingProductExportConfirmation | null>(null);
  const [productExportBusy, setProductExportBusy] = useState(false);
  const [productLayerStatuses, setProductLayerStatuses] = useState<
    Readonly<Record<EntityId, ProductLayerStatus>>
  >({});
  const [externalImportPaths, setExternalImportPaths] = useState<readonly string[]>([]);
  const externalImportSessionRef = useRef<PhotolabExternalImportSession | null>(null);
  const [productLayerRetryGeneration, setProductLayerRetryGeneration] = useState(0);
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [coreReady, setCoreReady] = useState(false);
  const [hardware, setHardware] = useState<HardwareCapabilities | null>(null);
  const [profile, setProfile] = useState<AlignmentQualityProfile>('qualityHybrid');
  const [alignmentOverrides, setAlignmentOverrides] = useState<AlignmentPresetOverrides>(() =>
    defaultOverridesForProfile('qualityHybrid'),
  );
  const [selectedAlignmentPreset, setSelectedAlignmentPreset] =
    useState<AlignmentPresetFile | null>(DEFAULT_FACTORY_ALIGNMENT_PRESET.preset);
  const [selectedAlignmentPresetPath, setSelectedAlignmentPresetPath] = useState<string | null>(
    DEFAULT_FACTORY_ALIGNMENT_PRESET.path,
  );
  const [defineAlignmentOpen, setDefineAlignmentOpen] = useState(false);
  const [alignmentScope, setAlignmentScope] = useState<'all' | 'selection'>('all');
  const alignmentProgressLogRef = useRef<Map<string, string>>(new Map());
  const [imageCount, setImageCount] = useState(DEFAULT_IMAGE_COUNT);
  const [, setResolved] = useState<ResolvedAlignmentConfig | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [alignmentStarting, setAlignmentStarting] = useState(false);
  const [imageQualityStarting, setImageQualityStarting] = useState(false);
  const [productStarting, setProductStarting] = useState(false);
  const [batchStarting, setBatchStarting] = useState(false);
  const [batchRecipeOpen, setBatchRecipeOpen] = useState(false);
  const [processingSetSaving, setProcessingSetSaving] = useState(false);
  const [projectReady, setProjectReady] = useState(false);
  const [projectFileOperation, setProjectFileOperation] =
    useState<ProjectFileOperationState | null>(null);
  const [autosaveGeneration, setAutosaveGeneration] = useState(0);
  const [lastSavedGeneration, setLastSavedGeneration] = useState(0);
  const [jobs, setJobs] = useState<readonly PhotolabJob[]>([]);
  const [imageImportBatch, setImageImportBatch] = useState<PhotoImportBatch | null>(null);
  const [himmelcapImport, setHimmelcapImport] = useState<HcapImportPreview | null>(null);
  const [projectImages, setProjectImages] = useState<readonly ProjectCameraImageRecord[]>([]);
  const [imageQualityAnalyses, setImageQualityAnalyses] = useState<
    readonly ImageQualityAnalysisRecord[]
  >([]);
  const [imageMasks, setImageMasks] = useState<readonly ListedImageMaskRevision[]>([]);
  const [processingSets, setProcessingSets] = useState<readonly ProcessingSetRecord[]>([]);
  const [captureGroups, setCaptureGroups] = useState<readonly CaptureGroupRecord[]>([]);
  const [calibrationGroups, setCalibrationGroups] = useState<
    readonly CameraCalibrationGroupRecord[]
  >([]);
  const [captureGroupSaving, setCaptureGroupSaving] = useState(false);
  const [alignmentMergeCandidates, setAlignmentMergeCandidates] = useState<
    readonly AlignmentMergeCandidateRecord[]
  >([]);
  const [alignmentMerges, setAlignmentMerges] = useState<readonly MergedAlignmentRunRecord[]>([]);
  const [alignmentMergeBusy, setAlignmentMergeBusy] = useState(false);
  const [gcpOptimizations, setGcpOptimizations] = useState<
    readonly PublishedGcpOptimizationEntry[]
  >([]);
  const [activeProductAlignmentId, setActiveProductAlignmentId] = useState<EntityId | null>(null);
  const [activeProcessingSetId, setActiveProcessingSetId] = useState<EntityId | null>(null);
  const [productDatasets, setProductDatasets] = useState<readonly ProjectProductDatasetRecord[]>(
    [],
  );
  const [gcpPath, setGcpPath] = useState<string | null>(null);
  const [gcpBusy, setGcpBusy] = useState(false);
  const [gcpImportError, setGcpImportError] = useState<string | null>(null);
  const [gcpImportOpen, setGcpImportOpen] = useState(false);
  const [gcpCollection, setGcpCollection] = useState<
    readonly [ObjectHash, GcpCollectionRecord] | null
  >(null);
  const [gcpOptimization, setGcpOptimization] = useState<GcpOptimizationPublicationRecord | null>(
    null,
  );
  const [gcpLocalEstimates, setGcpLocalEstimates] = useState<readonly GcpLocalEstimateArtifact[]>(
    [],
  );
  const [gcpOptimizationStarting, setGcpOptimizationStarting] = useState(false);
  const [alignedGcpCameras, setAlignedGcpCameras] = useState<readonly AlignedGcpCameraRecord[]>([]);
  const [focusedGcpId, setFocusedGcpId] = useState<string | null>(null);
  const [projectTargetCrs, setProjectTargetCrs] = useState<string | null>(null);
  const [imageImportBusy, setImageImportBusy] = useState(false);
  const [imageImportProgress, setImageImportProgress] = useState<ImageImportProgress | null>(null);
  const [gridSelectionProgress, setGridSelectionProgress] = useState<ImageImportProgress | null>(
    null,
  );
  const [imageImportError, setImageImportError] = useState<string | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>('console');
  const [rightPanelTab, setRightPanelTab] = useState<'function' | 'properties'>('function');
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('scene');
  const [sceneNavigationMode, setSceneNavigationMode] = useState<'3d' | '2d' | '2.5d'>('3d');
  const viewportRef = useRef<PhotolabKernelViewportHandle | null>(null);
  const selectedRef = useRef(selected);
  const projectRef = useRef(project);
  const navigationModeRef = useRef(sceneNavigationMode);
  const automationHiddenRef = useRef(new Set<EntityId>());
  const automationClipsRef = useRef<readonly ScopedClip[]>([]);
  selectedRef.current = selected;
  projectRef.current = project;
  navigationModeRef.current = sceneNavigationMode;
  const initialBootstrapRequested = useRef(false);
  const jobPollErrorLogged = useRef(false);
  const activeImageCommitId = useRef<string | null>(null);
  const activeImageInspectId = useRef<string | null>(null);
  const activeHimmelcapInspectId = useRef<string | null>(null);
  const himmelcapStagingOperationId = useRef<string | null>(null);
  const activeImageProgressKey = useRef<string | null>(null);
  const activeGridProgressKey = useRef<string | null>(null);
  const activeProjectFileOperation = useRef<ProjectFileOperationState | null>(null);
  const activeGcpOperationId = useRef<string | null>(null);
  const gcpCollectionRef = useRef<readonly [ObjectHash, GcpCollectionRecord] | null>(null);
  const gcpMeasurementQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastLoadedGcpOptimizationJobId = useRef<string | null>(null);
  const loadedProductIds = useRef<Set<EntityId>>(new Set());
  const loadingProductIds = useRef<Set<EntityId>>(new Set());
  const desiredProductIds = useRef<Set<EntityId>>(new Set());
  const productLoadGenerations = useRef(new EntityLoadGenerationGuard());
  const projectRefreshGuard = useRef(new ProjectRefreshGuard());
  const acceptedSceneIdentity = useRef<SceneIdentity | null>(null);
  const refreshedCompletedJobs = useRef<Set<string>>(new Set());
  const observedActiveJobs = useRef<Set<string>>(new Set());
  const observedFailedJobs = useRef<Set<string>>(new Set());
  const [autoExpandJobId, setAutoExpandJobId] = useState<string | null>(null);
  const activeFunctionId = useLayoutStore((state) => state.activeFunctionId);
  const activateStoredFunction = useLayoutStore((state) => state.activateFunction);
  const activate = useCallback(
    (functionId: string | null) => {
      if (functionId === 'alignment.define') {
        setDefineAlignmentOpen(true);
        return;
      }
      if (functionId === 'batch.configure') setBatchRecipeOpen(true);
      activateStoredFunction(functionId);
      if (functionId) setRightPanelTab('function');
    },
    [activateStoredFunction],
  );

  useEffect(() => {
    const bridge = window.himmelcad?.automationViewHost;
    if (!bridge) return;
    return bridge.register(async (method, params) => {
      const viewport = viewportRef.current;
      if (!viewport) throw new Error('PhotoLab view host is not ready.');
      if (method === 'view.screenshot.prepare') {
        const request = params as ScreenshotRequestV1;
        validateScreenshotRequest(request);
        if (!request.includeUi) {
          const capture = await viewport.captureRgba({
            width: Math.round(request.width * request.pixelRatio),
            height: Math.round(request.height * request.pixelRatio),
            transparentBackground: request.background === 'transparent',
          });
          return await encodeRgbaScreenshot(request, capture);
        }
        await viewport.waitForNextPresentedFrame();
        const captureRect = viewport.captureRectangle();
        if (!captureRect) throw new Error('PhotoLab viewport has no capture rectangle.');
        return { captureRect };
      }
      if (method === 'view.state.get') return currentPhotolabViewState();
      if (method !== 'view.state.set') throw new Error(`Unsupported view host method: ${method}`);
      const state = parseViewState(params);
      assertSupportedPhotolabPresentation(state);
      await viewport.setViewMode(state.navigationMode);
      setSceneNavigationMode(state.navigationMode);
      viewport.adoptWorldCamera(toPhotolabKernelCamera(state));

      const nextHidden = new Set(state.hiddenEntityIds as readonly EntityId[]);
      for (const id of automationHiddenRef.current) {
        if (!nextHidden.has(id)) {
          const visible = projectRef.current.entities[id]?.visibility.visible ?? true;
          viewport.setEntityVisibility([id], visible);
        }
      }
      for (const id of nextHidden) viewport.setEntityVisibility([id], false);
      automationHiddenRef.current = nextHidden;
      setSelected(new Set(state.selectedEntityIds as readonly EntityId[]));
      viewport.setAutomationClipVolumes(
        state.scopedClips.filter((clip) => clip.enabled).map(photolabScopedClipVolume),
      );
      automationClipsRef.current = state.scopedClips;
      await viewport.waitForNextPresentedFrame();
      return currentPhotolabViewState();
    });

    function currentPhotolabViewState(): ViewStateV1 {
      const camera = viewportRef.current?.worldCamera();
      if (!camera) throw new Error('PhotoLab camera is not ready.');
      const hidden = new Set<EntityId>(automationHiddenRef.current);
      for (const entity of Object.values(projectRef.current.entities)) {
        if (!entity.visibility.visible) hidden.add(entity.id);
      }
      return {
        schema: 'himmelcad.view-state',
        version: 1,
        camera: fromPhotolabKernelCamera(camera),
        navigationMode: navigationModeRef.current,
        hiddenEntityIds: [...hidden].sort(),
        selectedEntityIds: [...selectedRef.current].sort(),
        scopedClips: automationClipsRef.current,
        presentation: {
          background: 'black',
          renderStyle: 'source',
          showGrid: false,
          showAxes: false,
          showSelectionOutline: true,
        },
      };
    }
  }, []);

  useEffect(() => {
    gcpCollectionRef.current = gcpCollection;
  }, [gcpCollection]);
  const toggleBottom = useLayoutStore((state) => state.toggleBottomPanel);
  const setBottomCollapsed = useLayoutStore((state) => state.setBottomPanelCollapsed);
  const setRightCollapsed = useLayoutStore((state) => state.setRightPanelCollapsed);
  const reportPanelError = useCallback(
    (message: string) => {
      logEvent('error', 'renderer', message);
      setBottomTab('console');
      setBottomCollapsed(false);
    },
    [setBottomCollapsed],
  );
  useEffect(() => {
    activeProjectFileOperation.current = projectFileOperation;
  }, [projectFileOperation]);
  const selectedCameraIds = useMemo(
    () =>
      projectImages.filter((image) => selected.has(image.entityId)).map((image) => image.entityId),
    [projectImages, selected],
  );
  const selectedImage = useMemo(() => {
    if (selected.size !== 1) return null;
    const id = [...selected][0];
    return projectImages.find((image) => image.entityId === id) ?? null;
  }, [projectImages, selected]);
  const selectedGcp = useMemo(() => {
    if (selected.size !== 1 || !gcpCollection) return null;
    const id = [...selected][0];
    const entity = id ? project.entities[id] : undefined;
    if (entity?.kind !== 'GroundControlPoint') return null;
    return gcpCollection[1].points.find(({ point }) => point.name === entity.name)?.point ?? null;
  }, [gcpCollection, project.entities, selected]);
  const selectedAlignedCamera = useMemo(
    () => alignedGcpCameras.find((camera) => camera.entityId === selectedImage?.entityId) ?? null,
    [alignedGcpCameras, selectedImage],
  );
  const selectedImageQuality = useMemo(() => {
    if (!selectedImage) return null;
    const candidates = imageQualityAnalyses.filter(
      (analysis) => analysis.imageEntityId === selectedImage.entityId,
    );
    const projectWide = candidates.filter((analysis) => analysis.processingSetId === undefined);
    const scoped = activeProcessingSetId
      ? candidates.filter((analysis) => analysis.processingSetId === activeProcessingSetId)
      : projectWide;
    return (
      [...(scoped.length > 0 ? scoped : projectWide)].sort(
        (left, right) => right.analyzedAtUnixMs - left.analyzedAtUnixMs,
      )[0] ?? null
    );
  }, [activeProcessingSetId, imageQualityAnalyses, selectedImage]);
  const focusedGcpImages = useMemo(() => {
    if (!focusedGcpId) return [];
    const imageIds = new Set<number>();
    for (const observation of gcpCollection?.[1].observations ?? []) {
      if (observation.pointId === focusedGcpId) imageIds.add(observation.imageId);
    }
    for (const projection of gcpOptimization?.artifact.result.projections ?? []) {
      if (projection.pointId === focusedGcpId) imageIds.add(projection.imageId);
    }
    const point = gcpCollection?.[1].points.find(
      ({ point: candidate }) => candidate.id === focusedGcpId,
    )?.point;
    if (point) {
      const imagesByEntity = new Map(projectImages.map((image) => [image.entityId, image]));
      for (const camera of alignedGcpCameras) {
        const image = imagesByEntity.get(camera.entityId);
        if (image && initialGcpProjection(camera, image, point.coordinate)) {
          imageIds.add(camera.imageId);
        }
      }
    }
    const entities = new Set(
      alignedGcpCameras
        .filter((camera) => imageIds.has(camera.imageId))
        .map((camera) => camera.entityId),
    );
    return projectImages.filter((image) => entities.has(image.entityId));
  }, [alignedGcpCameras, focusedGcpId, gcpCollection, gcpOptimization, projectImages]);
  const focusedGcpName = useMemo(
    () =>
      gcpCollection?.[1].points.find(({ point }) => point.id === focusedGcpId)?.point.name ?? 'GCP',
    [focusedGcpId, gcpCollection],
  );
  const alignmentImageCount =
    alignmentScope === 'selection' ? selectedCameraIds.length : projectImages.length;
  const productAlignmentInputs = useMemo(
    () => [
      {
        id: 'latest',
        label:
          processingSets.find((set) => set.entityId === activeProcessingSetId)?.name ??
          'Latest compatible alignment',
      },
      ...alignmentMergeCandidates.map((candidate) => ({
        id: candidate.entityId,
        label: `${candidate.name} · ${candidate.cameraEntityIds.length} cameras`,
      })),
      ...alignmentMerges
        .filter((merge) => merge.state === 'published')
        .map((merge) => ({
          id: merge.entityId,
          label: `${merge.name} · merged · ${merge.cameraEntityIds.length} cameras`,
        })),
    ],
    [activeProcessingSetId, alignmentMergeCandidates, alignmentMerges, processingSets],
  );
  const activeProductProcessingSetId = useMemo(
    () =>
      alignmentMergeCandidates.find((candidate) => candidate.entityId === activeProductAlignmentId)
        ?.processingSetId ?? null,
    [activeProductAlignmentId, alignmentMergeCandidates],
  );

  const resolveProfile = useCallback(async () => {
    const api = window.himmelcad;
    if (!api) {
      setResolveError('Desktop bridge is missing. Start PhotoLab through Electron.');
      return;
    }
    setResolving(true);
    setResolveError(null);
    const started = performance.now();
    let commandId: string | null = null;
    const resolveProfileName = selectedAlignmentPreset?.profile ?? profile;
    const resolveOverrides = selectedAlignmentPreset?.overrides ?? alignmentOverrides;
    logEvent('info', 'renderer', `Resolving alignment profile ${resolveProfileName} in the core`);
    try {
      if (projectReady) {
        const journal = await api.sidecar.call<PhotolabJournalEntry>(
          'photolab.project.journal.start',
          {
            commandKind: 'ResolvePhotolabAlignmentProfile',
            payload: {
              profile: resolveProfileName,
              imageCount: alignmentImageCount,
              cameraEntityIds: alignmentScope === 'selection' ? selectedCameraIds : [],
            },
          },
        );
        commandId = journal.commandId;
        setAutosaveGeneration((generation) => generation + 1);
      }
      const config = await api.sidecar.call<ResolvedAlignmentConfig>('photolab.alignment.resolve', {
        profile: resolveProfileName,
        imageCount: alignmentImageCount,
        maxImageEdgeOverride: resolveOverrides.maxImageEdge,
        keypointsPerMegapixelOverride: resolveOverrides.keypointsPerMegapixel,
      });
      setResolved(config);
      logEvent(
        'info',
        'sidecar',
        `Alignment configuration frozen · ${config.configHash.slice(0, 16)} · edge ${config.maxImageEdge} · ${(performance.now() - started).toFixed(1)} ms`,
      );
      if (commandId) {
        await api.sidecar.call('photolab.project.journal.finish', {
          commandId,
          state: 'committed',
          afterRefs: [config.configHash],
          message: `Alignment configuration ${config.configHash}`,
        });
        setAutosaveGeneration((generation) => generation + 1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResolveError(message);
      logEvent('error', 'sidecar', `Alignment configuration rejected: ${message}`);
      if (commandId) {
        try {
          await api.sidecar.call('photolab.project.journal.finish', {
            commandId,
            state: 'failed',
            message,
          });
          setAutosaveGeneration((generation) => generation + 1);
        } catch (journalError) {
          logEvent(
            'error',
            'sidecar',
            `Failed to journal error state: ${errorMessage(journalError)}`,
          );
        }
      }
    } finally {
      setResolving(false);
    }
  }, [
    alignmentImageCount,
    alignmentOverrides,
    alignmentScope,
    profile,
    projectReady,
    selectedAlignmentPreset,
    selectedCameraIds,
  ]);

  const acceptProject = useCallback(
    (
      opened: OpenPhotolabProjectResult,
      options?: { preserveSelection: boolean; processingSetId: EntityId | null },
    ) => {
      const nextSceneIdentity: SceneIdentity = {
        projectId: opened.manifest.projectId,
        renderOffset: [
          opened.manifest.renderOffset.x,
          opened.manifest.renderOffset.y,
          opened.manifest.renderOffset.z,
        ],
      };
      const fullReset = requiresFullSceneReset(acceptedSceneIdentity.current, nextSceneIdentity);
      const refreshTicket = projectRefreshGuard.current.begin(opened.manifest.projectId);
      acceptedSceneIdentity.current = nextSceneIdentity;
      const commitIfCurrent = (commit: () => void): void => {
        if (projectRefreshGuard.current.isCurrent(refreshTicket)) commit();
      };
      if (fullReset) {
        const staleLayerIds = new Set([...loadedProductIds.current, ...loadingProductIds.current]);
        for (const entityId of staleLayerIds) viewportRef.current?.removeLayer(entityId);
        loadedProductIds.current.clear();
        loadingProductIds.current.clear();
        desiredProductIds.current.clear();
        productLoadGenerations.current.reset();
        setProductLayerStatuses({});
        viewportRef.current?.resetProjectScene(nextSceneIdentity.renderOffset);
        setProjectImages([]);
        setImageQualityAnalyses([]);
        setImageMasks([]);
        setImageCount(0);
        setProcessingSets([]);
        setCaptureGroups([]);
        setCalibrationGroups([]);
        setAlignmentMergeCandidates([]);
        setAlignmentMerges([]);
        setGcpOptimizations([]);
        setProductDatasets([]);
        setGcpCollection(null);
        setGcpOptimization(null);
        setGcpLocalEstimates([]);
        setAlignedGcpCameras([]);
        setJobs([]);
        observedActiveJobs.current.clear();
        observedFailedJobs.current.clear();
        refreshedCompletedJobs.current.clear();
        lastLoadedGcpOptimizationJobId.current = null;
        setAutoExpandJobId(null);
      }
      setProject({
        formatVersion: opened.manifest.formatVersion,
        projectId: opened.manifest.projectId,
        name: opened.manifest.name,
        rootEntity: opened.manifest.rootEntity,
        entities: opened.manifest.entities,
        renderOffset: opened.manifest.renderOffset,
      });
      setAutosaveGeneration(opened.session.autosaveGeneration);
      setLastSavedGeneration(opened.session.lastSavedGeneration);
      setProjectReady(true);
      setProjectTargetCrs(referenceFrameLabel(opened.manifest.referenceFrame));
      if (!options?.preserveSelection) {
        setSelected(new Set());
        setActiveProcessingSetId(null);
        setActiveProductAlignmentId(null);
        setFocusedGcpId(null);
      }
      const api = window.himmelcad;
      if (api) {
        void api.sidecar
          .call<ProjectCameraImageRecord[]>('photolab.images.list')
          .then((records) => {
            commitIfCurrent(() => {
              setProjectImages(records);
              setImageCount(records.length);
            });
          })
          .catch((error: unknown) => {
            commitIfCurrent(() =>
              logEvent(
                'error',
                'sidecar',
                `Image catalog could not be loaded: ${errorMessage(error)}`,
              ),
            );
          });
        void api.sidecar
          .call<ImageQualityAnalysisRecord[]>('photolab.images.quality.list')
          .then((records) => commitIfCurrent(() => setImageQualityAnalyses(records)))
          .catch((error: unknown) => {
            commitIfCurrent(() =>
              logEvent(
                'error',
                'sidecar',
                `Image-quality catalog could not be loaded: ${errorMessage(error)}`,
              ),
            );
          });
        void api.sidecar
          .call<ListedImageMaskRevision[]>('photolab.project.imageMask.list')
          .then((records) => commitIfCurrent(() => setImageMasks(records)))
          .catch((error: unknown) => {
            commitIfCurrent(() =>
              logEvent(
                'error',
                'sidecar',
                `Image masks could not be loaded: ${errorMessage(error)}`,
              ),
            );
          });
        if (
          Object.values(opened.manifest.entities).some((entity) => entity.kind === 'AlignmentRun')
        ) {
          void api.sidecar
            .call<AlignedGcpCameraRecord[]>('photolab.gcp.alignedCameras', {
              ...(options?.processingSetId ? { processingSetId: options.processingSetId } : {}),
            })
            .then((records) => commitIfCurrent(() => setAlignedGcpCameras(records)))
            .catch((error: unknown) => {
              commitIfCurrent(() =>
                logEvent(
                  'warn',
                  'sidecar',
                  `Aligned cameras are not available yet: ${errorMessage(error)}`,
                ),
              );
            });
        } else {
          commitIfCurrent(() => setAlignedGcpCameras([]));
        }
        void api.sidecar
          .call<ProjectProductDatasetRecord[]>('photolab.products.list')
          .then((records) =>
            commitIfCurrent(() =>
              setProductDatasets(
                records.map((record) => {
                  const versionHash = opened.manifest.entities[record.entityId]?.versionHash;
                  return versionHash ? { ...record, versionHash } : record;
                }),
              ),
            ),
          )
          .catch((error: unknown) => {
            commitIfCurrent(() =>
              logEvent(
                'error',
                'sidecar',
                `Product catalog could not be loaded: ${errorMessage(error)}`,
              ),
            );
          });
        void api.sidecar
          .call<ProcessingSetRecord[]>('photolab.project.processingSet.list')
          .then((records) => commitIfCurrent(() => setProcessingSets(records)))
          .catch((error: unknown) => {
            commitIfCurrent(() =>
              logEvent(
                'error',
                'sidecar',
                `Processing sets could not be loaded: ${errorMessage(error)}`,
              ),
            );
          });
        void api.sidecar
          .call<CaptureGroupRecord[]>('photolab.project.captureGroup.list')
          .then((records) => commitIfCurrent(() => setCaptureGroups(records)))
          .catch((error: unknown) => {
            commitIfCurrent(() =>
              logEvent(
                'error',
                'sidecar',
                `Capture groups could not be loaded: ${errorMessage(error)}`,
              ),
            );
          });
        void api.sidecar
          .call<CameraCalibrationGroupRecord[]>('photolab.project.calibrationGroup.list')
          .then((records) => commitIfCurrent(() => setCalibrationGroups(records)))
          .catch((error: unknown) => {
            commitIfCurrent(() =>
              logEvent(
                'error',
                'sidecar',
                `Calibration groups could not be loaded: ${errorMessage(error)}`,
              ),
            );
          });
        void api.sidecar
          .call<AlignmentMergeCandidateRecord[]>('photolab.project.alignmentMerge.candidates')
          .then((records) => commitIfCurrent(() => setAlignmentMergeCandidates(records)))
          .catch((error: unknown) => {
            commitIfCurrent(() =>
              logEvent(
                'error',
                'sidecar',
                `Merge candidates could not be loaded: ${errorMessage(error)}`,
              ),
            );
          });
        void api.sidecar
          .call<MergedAlignmentRunRecord[]>('photolab.project.alignmentMerge.list')
          .then((records) => commitIfCurrent(() => setAlignmentMerges(records)))
          .catch((error: unknown) => {
            commitIfCurrent(() =>
              logEvent(
                'error',
                'sidecar',
                `Alignment merges could not be loaded: ${errorMessage(error)}`,
              ),
            );
          });
        void api.sidecar
          .call<PublishedGcpOptimizationEntry[]>('photolab.gcp.optimization.list')
          .then((records) => commitIfCurrent(() => setGcpOptimizations(records)))
          .catch((error: unknown) => {
            commitIfCurrent(() =>
              logEvent(
                'error',
                'sidecar',
                `GCP optimization lineage could not be loaded: ${errorMessage(error)}`,
              ),
            );
          });
        void api.sidecar
          .call<readonly [ObjectHash, GcpCollectionRecord] | null>('photolab.gcp.list')
          .then((records) => commitIfCurrent(() => setGcpCollection(records)))
          .catch((error: unknown) => {
            commitIfCurrent(() =>
              logEvent(
                'error',
                'sidecar',
                `GCP catalog could not be loaded: ${errorMessage(error)}`,
              ),
            );
          });
        void api.sidecar
          .call<GcpOptimizationPublicationRecord | null>('photolab.gcp.optimization.latest', {
            ...(options?.processingSetId ? { processingSetId: options.processingSetId } : {}),
          })
          .then((record) => commitIfCurrent(() => setGcpOptimization(record)))
          .catch((error: unknown) => {
            commitIfCurrent(() =>
              logEvent(
                'error',
                'sidecar',
                `GCP optimization result could not be loaded: ${errorMessage(error)}`,
              ),
            );
          });
      }
      logEvent(
        opened.session.recoveryAvailable ? 'warn' : 'info',
        'sidecar',
        opened.session.usesLocalWorkingCopy
          ? `Project opened in local working copy · ${opened.session.workingPath}`
          : `Project opened · ${opened.session.sourcePath}`,
      );
    },
    [],
  );

  const beginProjectFileOperation = useCallback(
    (kind: ProjectFileOperationState['kind']): ProjectFileOperationState | null => {
      if (activeProjectFileOperation.current) return null;
      const operation = createProjectFileOperation(kind);
      activeProjectFileOperation.current = operation;
      setProjectFileOperation(operation);
      return operation;
    },
    [],
  );

  const finishProjectFileOperation = useCallback((archiveOperationId: string): void => {
    if (activeProjectFileOperation.current?.archiveOperationId !== archiveOperationId) return;
    activeProjectFileOperation.current = null;
    setProjectFileOperation(null);
  }, []);

  const showProjectFileOperationError = useCallback(
    (archiveOperationId: string, error: unknown): void => {
      const message = errorMessage(error);
      if (message.toLowerCase().includes('cancel')) {
        logEvent('warn', 'sidecar', 'Project operation cancelled; no archive was published');
        finishProjectFileOperation(archiveOperationId);
        return;
      }
      setProjectFileOperation((current) => {
        if (!current || current.archiveOperationId !== archiveOperationId) return current;
        const failed = failProjectFileOperation(current, message);
        activeProjectFileOperation.current = failed;
        return failed;
      });
      logEvent('error', 'sidecar', `Project operation failed: ${message}`);
    },
    [finishProjectFileOperation],
  );

  const cancelProjectFileOperation = useCallback(async () => {
    const operation = activeProjectFileOperation.current;
    const api = window.himmelcad;
    if (!operation || operation.error || operation.cancelRequested || !api) return;
    const requested = requestProjectCancellation(operation);
    activeProjectFileOperation.current = requested;
    setProjectFileOperation(requested);
    try {
      await api.project.cancelArchive(operation.archiveOperationId);
    } catch (error) {
      showProjectFileOperationError(operation.archiveOperationId, error);
    }
  }, [showProjectFileOperationError]);

  const createProject = useCallback(async () => {
    const api = window.himmelcad;
    if (!api) return;
    const operation = beginProjectFileOperation('create');
    if (!operation) return;
    try {
      const opened = await api.project.create<OpenPhotolabProjectResult>(operation);
      if (opened) {
        acceptProject(opened);
        finishProjectFileOperation(operation.archiveOperationId);
      } else finishProjectFileOperation(operation.archiveOperationId);
    } catch (error) {
      showProjectFileOperationError(operation.archiveOperationId, error);
    }
  }, [
    acceptProject,
    beginProjectFileOperation,
    finishProjectFileOperation,
    showProjectFileOperationError,
  ]);

  const openProject = useCallback(async () => {
    const api = window.himmelcad;
    if (!api) return;
    const operation = beginProjectFileOperation('open');
    if (!operation) return;
    try {
      const opened = await api.project.open<OpenPhotolabProjectResult>(operation);
      if (opened) {
        acceptProject(opened);
        finishProjectFileOperation(operation.archiveOperationId);
      } else finishProjectFileOperation(operation.archiveOperationId);
    } catch (error) {
      showProjectFileOperationError(operation.archiveOperationId, error);
    }
  }, [
    acceptProject,
    beginProjectFileOperation,
    finishProjectFileOperation,
    showProjectFileOperationError,
  ]);

  const saveProject = useCallback(async () => {
    const api = window.himmelcad;
    if (!api || !projectReady) return;
    const operation = beginProjectFileOperation('save');
    if (!operation) return;
    const started = performance.now();
    try {
      // First Save on Untitled opens Save As dialog. Returns full snapshot or null (cancel).
      const result = await api.project.save<OpenPhotolabProjectResult | null>(operation);
      if (!result) {
        finishProjectFileOperation(operation.archiveOperationId);
        return;
      }
      acceptProject(result);
      logEvent(
        'info',
        'sidecar',
        `Project saved · ${result.session.sourcePath} · ${(performance.now() - started).toFixed(1)} ms`,
      );
      finishProjectFileOperation(operation.archiveOperationId);
    } catch (error) {
      showProjectFileOperationError(operation.archiveOperationId, error);
    }
  }, [
    acceptProject,
    beginProjectFileOperation,
    finishProjectFileOperation,
    projectReady,
    showProjectFileOperationError,
  ]);

  const saveProjectAs = useCallback(async () => {
    const api = window.himmelcad;
    if (!api || !projectReady) return;
    const operation = beginProjectFileOperation('saveAs');
    if (!operation) return;
    const started = performance.now();
    try {
      const result = await api.project.saveAs<OpenPhotolabProjectResult | null>(operation);
      if (!result) {
        finishProjectFileOperation(operation.archiveOperationId);
        return;
      }
      // Full snapshot refreshes title (no more "Untitled") and keeps session paths in sync.
      acceptProject(result);
      logEvent(
        'info',
        'sidecar',
        `Project archive written · ${result.session.sourcePath} · ${(performance.now() - started).toFixed(1)} ms`,
      );
      finishProjectFileOperation(operation.archiveOperationId);
    } catch (error) {
      showProjectFileOperationError(operation.archiveOperationId, error);
    }
  }, [
    acceptProject,
    beginProjectFileOperation,
    finishProjectFileOperation,
    projectReady,
    showProjectFileOperationError,
  ]);

  const releaseHimmelcapStaging = useCallback(async () => {
    const operationId = himmelcapStagingOperationId.current;
    const api = window.himmelcad;
    if (!operationId || !api) return;
    await api.sidecar.call('photolab.himmelcap.release', { operationId });
    if (himmelcapStagingOperationId.current === operationId) {
      himmelcapStagingOperationId.current = null;
      setHimmelcapImport(null);
    }
  }, []);

  const inspectHimmelcap = useCallback(
    async (selectedPath?: string) => {
      const api = window.himmelcad;
      if (!api || imageImportBusy) return;
      const path = selectedPath ?? (await api.himmelcap.selectFile());
      if (!path) return;
      await releaseHimmelcapStaging();
      const operationId = `himmelcap-inspect-${crypto.randomUUID()}`;
      const progressKey = `image-import:${operationId}`;
      activeHimmelcapInspectId.current = operationId;
      activeImageProgressKey.current = progressKey;
      setImageImportBusy(true);
      setImageImportError(null);
      setImageImportProgress({
        fraction: 0,
        message: 'Verifying HimmelCAD Cap project…',
        phase: 'inspect',
        indeterminate: false,
      });
      const started = performance.now();
      try {
        const preview = await api.sidecar.call<HcapImportPreview>('photolab.himmelcap.inspect', {
          path,
          operationId,
          progressKey,
        });
        himmelcapStagingOperationId.current = operationId;
        setHimmelcapImport(preview);
        setImageImportBatch(preview.batch);
        logEvent(
          preview.warnings.length > 0 ? 'warn' : 'info',
          'sidecar',
          `${preview.displayName} verified · ${preview.frameCount} frames · ${preview.poseCount} position priors · ${(performance.now() - started).toFixed(1)} ms`,
        );
      } catch (error) {
        const message = errorMessage(error);
        setImageImportError(message.toLowerCase().includes('cancel') ? null : message);
        setImageImportBatch(null);
        setHimmelcapImport(null);
        logEvent(
          message.toLowerCase().includes('cancel') ? 'warn' : 'error',
          'sidecar',
          message.toLowerCase().includes('cancel')
            ? 'HimmelCAD Cap inspection cancelled'
            : `HimmelCAD Cap validation failed: ${message}`,
        );
      } finally {
        activeHimmelcapInspectId.current = null;
        activeImageProgressKey.current = null;
        setImageImportBusy(false);
        setImageImportProgress(null);
      }
    },
    [imageImportBusy, releaseHimmelcapStaging],
  );

  const inspectImages = useCallback(
    async (source: 'files' | 'folder') => {
      const api = window.himmelcad;
      if (!api || imageImportBusy) return;
      const started = performance.now();
      logEvent(
        'info',
        'renderer',
        source === 'files' ? 'Image picker opened' : 'Folder picker opened',
      );
      try {
        const paths =
          source === 'files' ? await api.images.selectFiles() : await api.images.selectFolder();
        if (!paths) return;
        if (paths.length === 1 && paths[0]?.toLocaleLowerCase().endsWith('.hcap')) {
          await inspectHimmelcap(paths[0]);
          return;
        }
        await releaseHimmelcapStaging();
        setHimmelcapImport(null);
        const operationId = `image-inspect-${crypto.randomUUID()}`;
        const progressKey = `image-import:${operationId}`;
        activeImageInspectId.current = operationId;
        activeImageProgressKey.current = progressKey;
        setImageImportBusy(true);
        setImageImportError(null);
        setImageImportProgress({
          fraction: 0,
          message: 'Scanning folders…',
          phase: 'inspect',
          indeterminate: true,
        });
        const batch = await api.sidecar.call<PhotoImportBatch>('photolab.images.inspect', {
          paths,
          operationId,
          progressKey,
        });
        if (!batch) return;
        setImageImportBatch((previous) => mergePhotoBatches(previous, batch));
        logEvent(
          batch.warnings.length > 0 ? 'warn' : 'info',
          'sidecar',
          `${batch.photos.length} images validated · ${batch.warnings.length} warnings · ${(performance.now() - started).toFixed(1)} ms`,
        );
      } catch (error) {
        const message = errorMessage(error);
        setImageImportError(message.toLowerCase().includes('cancel') ? null : message);
        logEvent(
          message.toLowerCase().includes('cancel') ? 'warn' : 'error',
          'sidecar',
          message.toLowerCase().includes('cancel')
            ? 'Image inspection cancelled; no images were committed'
            : `Image validation failed: ${message}`,
        );
      } finally {
        activeImageInspectId.current = null;
        activeImageProgressKey.current = null;
        setImageImportBusy(false);
        setImageImportProgress(null);
      }
    },
    [imageImportBusy, inspectHimmelcap, releaseHimmelcapStaging],
  );

  const discoverImageCrs = useCallback(async (query: CrsOperationQuery) => {
    const api = window.himmelcad;
    if (!api) throw new Error('Desktop bridge is missing');
    const operationId = `crs-discover-${crypto.randomUUID()}`;
    const started = performance.now();
    logEvent('info', 'sidecar', 'Validating coordinate operations');
    const discovery = await api.sidecar.call<CrsOperationDiscovery>('photolab.crs.discover', {
      operationId,
      query,
    });
    logEvent(
      discovery.warnings.length > 0 ? 'warn' : 'info',
      'sidecar',
      `${discovery.candidates.length} CRS operations checked · ${(performance.now() - started).toFixed(1)} ms`,
    );
    return discovery;
  }, []);

  const commitImageImport = useCallback(
    async (decision: ImageImportDecision) => {
      const api = window.himmelcad;
      if (!api || !imageImportBatch || imageImportBusy || !projectReady) return;
      const operationId = `image-import-${crypto.randomUUID()}`;
      activeImageCommitId.current = operationId;
      activeImageProgressKey.current = `image-import:${operationId}`;
      setImageImportBusy(true);
      setImageImportError(null);
      setImageImportProgress({
        fraction: 0.02,
        message: 'Freezing the selected CRS operation…',
        phase: 'commit',
        indeterminate: true,
      });
      const started = performance.now();
      try {
        const transformation = await api.sidecar.call<unknown>('photolab.crs.freeze', {
          operationId: `${operationId}.freeze`,
          decision,
        });
        const warningPaths = new Set(
          imageImportBatch.warnings.map((warning) => warning.sourcePath),
        );
        const result = await api.sidecar.call<{
          importedEntityCount: number;
          duplicateCount: number;
          autosaveGeneration: number;
          images: { entityId: EntityId; duplicate: boolean }[];
        }>('photolab.images.commit', {
          operationId,
          progressKey: activeImageProgressKey.current,
          transformation,
          images: imageImportBatch.photos.map((photo) => ({
            photo,
            projectedReference: null,
            tags: [
              ...(warningPaths.has(photo.sourcePath) ? ['qualityWarning' as const] : []),
              ...(hasFixedDjiRtk(photo.metadata) ? ['rtkFixed' as const] : []),
            ],
          })),
        });
        if (himmelcapImport) {
          const cameraEntityIds = [...new Set(result.images.map((image) => image.entityId))];
          if (cameraEntityIds.length < 2) {
            throw new Error('The Cap project did not produce at least two distinct project images');
          }
          const requestedGroupName = himmelcapImport.displayName.trim().slice(0, 120);
          const groupName =
            requestedGroupName.length > 0
              ? requestedGroupName
              : `HimmelCAD Cap ${himmelcapImport.sessionId}`;
          await api.sidecar.call<OpenPhotolabProjectResult>(
            'photolab.project.captureGroup.create',
            {
              name: groupName,
              cameraEntityIds,
              calibrationGroups: [
                {
                  name: 'HimmelCAD Cap camera',
                  cameraEntityIds,
                  groupingBasis: 'missionAutofocus',
                },
              ],
            },
          );
        }
        const opened = await api.sidecar.call<OpenPhotolabProjectResult>(
          'photolab.project.snapshot',
        );
        acceptProject(opened);
        setImageCount(
          Object.values(opened.manifest.entities).filter((entity) => entity.kind === 'CameraImage')
            .length,
        );
        setAutosaveGeneration(result.autosaveGeneration);
        setWorkspaceMode('images');
        setImageImportBatch(null);
        setHimmelcapImport(null);
        if (himmelcapStagingOperationId.current) {
          try {
            await releaseHimmelcapStaging();
          } catch (error) {
            logEvent(
              'warn',
              'sidecar',
              `Cap staging cleanup will be retried later: ${errorMessage(error)}`,
            );
          }
        }
        logEvent(
          'info',
          'sidecar',
          `${result.importedEntityCount} images imported atomically · ${result.duplicateCount} duplicates · ${(performance.now() - started).toFixed(1)} ms`,
        );
      } catch (error) {
        const message = errorMessage(error);
        setImageImportError(`Image import failed: ${message}`);
        logEvent('error', 'sidecar', `Image import failed: ${message}`);
      } finally {
        activeImageCommitId.current = null;
        activeImageProgressKey.current = null;
        setImageImportBusy(false);
        setImageImportProgress(null);
      }
    },
    [
      acceptProject,
      himmelcapImport,
      imageImportBatch,
      imageImportBusy,
      projectReady,
      releaseHimmelcapStaging,
    ],
  );

  const cancelImageImport = useCallback(async () => {
    const inspectionId = activeImageInspectId.current;
    const himmelcapInspectionId = activeHimmelcapInspectId.current;
    const operationId = activeImageCommitId.current;
    const api = window.himmelcad;
    try {
      if (himmelcapInspectionId && api) {
        await api.sidecar.call('photolab.himmelcap.cancel', {
          operationId: himmelcapInspectionId,
        });
        logEvent('warn', 'sidecar', 'HimmelCAD Cap inspection cancellation requested');
        return;
      }
      if (inspectionId && api) {
        await api.sidecar.call('photolab.images.inspect.cancel', { operationId: inspectionId });
        logEvent('warn', 'sidecar', 'Image inspection cancellation requested');
        return;
      }
      if (operationId && api) {
        const results = await Promise.allSettled([
          api.sidecar.call('photolab.crs.cancel', { operationId: `${operationId}.freeze` }),
          api.sidecar.call('photolab.crs.cancel', { operationId: `${operationId}.coordinates` }),
          api.sidecar.call('photolab.images.commit.cancel', { operationId }),
        ]);
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failure) throw failure.reason;
        logEvent('warn', 'sidecar', 'Image import cancellation requested');
        return;
      }
      await releaseHimmelcapStaging();
      setImageImportBatch(null);
      setHimmelcapImport(null);
      setImageImportProgress(null);
      setImageImportError(null);
    } catch (error) {
      reportPanelError(`Image import could not be cancelled: ${errorMessage(error)}`);
    }
  }, [releaseHimmelcapStaging, reportPanelError]);

  const selectTransformationGrid = useCallback(
    async (kind: 'horizontal' | 'vertical'): Promise<LocalGridSelection | null> => {
      const progressKey = `grid-register:${crypto.randomUUID()}`;
      activeGridProgressKey.current = progressKey;
      setGridSelectionProgress({
        fraction: 0.01,
        message: 'Reading transformation grid…',
        phase: 'grid',
      });
      try {
        const selected = await window.himmelcad?.grids.select(kind, progressKey);
        if (!selected) return null;
        logEvent(
          'info',
          'renderer',
          `Transformation grid ready · ${selected.filename} · ${selected.driver}`,
        );
        return selected;
      } finally {
        activeGridProgressKey.current = null;
        setGridSelectionProgress(null);
      }
    },
    [],
  );

  const chooseGcpCsv = useCallback(async () => {
    const api = window.himmelcad;
    if (!api || gcpBusy) return;
    try {
      const path = await api.reference.selectGcpCsv();
      if (!path) return;
      setGcpImportOpen(true);
      setGcpImportError(null);
      setGcpPath(path);
      logEvent('info', 'renderer', `GCP file selected · ${path}`);
    } catch (error) {
      reportPanelError(`GCP file could not be selected: ${errorMessage(error)}`);
    }
  }, [gcpBusy, reportPanelError]);

  const previewGcpCsv = useCallback(async (path: string, mapping: GcpCsvImportMapping) => {
    const api = window.himmelcad;
    if (!api) throw new Error('Desktop bridge is missing');
    return api.sidecar.call<GcpCsvPreview>('photolab.gcp.preview', {
      path,
      mapping,
      maximumPreviewRows: 100,
    });
  }, []);

  const commitGcpCsv = useCallback(
    async (
      path: string,
      mapping: GcpCsvImportMapping,
      decision: ImageImportDecision,
      coordinatesAlreadyInProjectCrs: boolean,
    ) => {
      const api = window.himmelcad;
      if (!api || gcpBusy || !projectReady) return;
      const operationId = `gcp-import-${crypto.randomUUID()}`;
      activeGcpOperationId.current = operationId;
      setGcpBusy(true);
      setGcpImportError(null);
      const started = performance.now();
      try {
        const transformation = await api.sidecar.call('photolab.crs.freeze', {
          operationId: `${operationId}.freeze`,
          decision,
        });
        const result = await api.sidecar.call<{
          collectionSha256: ObjectHash;
          autosaveGeneration: number;
          points: unknown[];
        }>('photolab.gcp.commit', {
          operationId,
          path,
          mapping,
          transformation,
          coordinatesAlreadyInProjectCrs,
        });
        const opened = await api.sidecar.call<OpenPhotolabProjectResult>(
          'photolab.project.snapshot',
        );
        acceptProject(opened);
        setAutosaveGeneration(result.autosaveGeneration);
        setGcpPath(null);
        setGcpImportOpen(false);
        setWorkspaceMode('scene');
        logEvent(
          'info',
          'sidecar',
          `${result.points.length} GCPs imported atomically · ${(performance.now() - started).toFixed(1)} ms`,
        );
      } catch (error) {
        const message = `GCP import failed: ${errorMessage(error)}`;
        setGcpImportError(message);
        logEvent('error', 'sidecar', message);
      } finally {
        activeGcpOperationId.current = null;
        setGcpBusy(false);
      }
    },
    [acceptProject, gcpBusy, projectReady],
  );

  const cancelGcpImport = useCallback(async () => {
    const operationId = activeGcpOperationId.current;
    const api = window.himmelcad;
    try {
      if (operationId && api) {
        const results = await Promise.allSettled([
          api.sidecar.call('photolab.crs.cancel', { operationId: `${operationId}.freeze` }),
          api.sidecar.call('photolab.gcp.cancel', { operationId }),
        ]);
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failure) throw failure.reason;
        logEvent('warn', 'sidecar', 'GCP import cancellation requested');
        return;
      }
      setGcpPath(null);
      setGcpImportError(null);
      setGcpImportOpen(false);
    } catch (error) {
      reportPanelError(`GCP import could not be cancelled: ${errorMessage(error)}`);
    }
  }, [reportPanelError]);

  useEffect(() => {
    activate('alignment.run');
    logEvent('info', 'renderer', 'PhotoLab renderer mounted · Quality Hybrid default');
    const api = window.himmelcad;
    if (!api) return;
    void api.sidecar.status().then(async (ready) => {
      setCoreReady(ready);
      logEvent(
        ready ? 'info' : 'warn',
        'sidecar',
        ready ? 'PhotoLab core ready' : 'Core unavailable',
      );
      if (ready && !initialBootstrapRequested.current) {
        initialBootstrapRequested.current = true;
        try {
          const opened = await api.project.bootstrap<OpenPhotolabProjectResult>();
          acceptProject(opened);
          void api.sidecar
            .call<HardwareCapabilities>('photolab.hardware.probe')
            .then((snapshot) => {
              setHardware(snapshot);
              logEvent('info', 'sidecar', `Hardware plan · ${hardwareLabel(snapshot)}`);
            })
            .catch((error: unknown) => {
              logEvent(
                'warn',
                'sidecar',
                `Hardware probe incomplete; safe CPU plan remains active: ${errorMessage(error)}`,
              );
            });
        } catch (error) {
          logEvent(
            'error',
            'sidecar',
            `Working project could not be initialized: ${errorMessage(error)}`,
          );
        }
      }
    });
    return api.sidecar.onStderr((line) => {
      const progress = parseSidecarProgress(line);
      if (progress) {
        consoleStore.push({
          level: 'info',
          source: 'sidecar',
          message: progress.message,
          timestamp: Date.now(),
          progress: progress.fraction,
          progressKey: progress.progressKey,
        });
        if (progress.progressKey === activeImageProgressKey.current) {
          setImageImportProgress((current) => ({
            fraction: progress.fraction,
            message: progress.message,
            phase: current?.phase ?? 'inspect',
            indeterminate: progress.message.startsWith('Scanning folders'),
          }));
        }
        if (progress.progressKey === activeGridProgressKey.current) {
          setGridSelectionProgress({
            fraction: progress.fraction,
            message: progress.message,
            phase: 'grid',
          });
        }
        if (progress.progressKey === activeProjectFileOperation.current?.progressKey) {
          setProjectFileOperation((current) => {
            if (!current) return current;
            const next = applyProjectProgress(current, progress);
            activeProjectFileOperation.current = next;
            return next;
          });
        }
        return;
      }
      const lower = line.toLowerCase();
      const level = lower.includes('error') ? 'error' : lower.includes('warn') ? 'warn' : 'debug';
      logEvent(level, 'sidecar', line);
    });
  }, [acceptProject, activate]);

  useEffect(() => {
    return consoleStore.subscribe(() => {
      const latest = consoleStore.getSnapshot().at(-1);
      if (latest?.level !== 'error') return;
      setBottomTab('console');
      setBottomCollapsed(false);
    });
  }, [setBottomCollapsed]);

  useEffect(() => {
    const active = jobs.filter((job) =>
      ['queued', 'running', 'cancelRequested'].includes(job.state.kind),
    );
    const newlyActive = active.find((job) => !observedActiveJobs.current.has(job.id));
    observedActiveJobs.current = new Set(active.map((job) => job.id));
    if (!newlyActive) return;
    setBottomTab('jobs');
    setBottomCollapsed(false);
  }, [jobs, setBottomCollapsed]);

  useEffect(() => {
    const failedIds = newlyFailedJobIds(jobs, observedFailedJobs.current);
    if (failedIds.length === 0) return;
    for (const jobId of failedIds) {
      observedFailedJobs.current.add(jobId);
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (job?.state.kind !== 'failed') continue;
      logEvent('error', 'sidecar', `${job.kind} failed: ${job.state.code}: ${job.state.message}`);
    }
    setAutoExpandJobId(failedIds.at(-1) ?? null);
    setBottomTab('jobs');
    setBottomCollapsed(false);
  }, [jobs, setBottomCollapsed]);

  useEffect(() => {
    if (!projectReady) return;
    const api = window.himmelcad;
    if (!api) return;
    const autosave = window.setInterval(() => {
      void api.sidecar
        .call<{ autosaveGeneration: number; lastSavedGeneration: number; dirty: boolean }>(
          'photolab.project.autosave',
        )
        .then((result) => {
          setAutosaveGeneration(result.autosaveGeneration);
          setLastSavedGeneration(result.lastSavedGeneration);
        })
        .catch((error: unknown) => {
          logEvent('error', 'sidecar', `Autosave failed: ${errorMessage(error)}`);
        });
    }, 30_000);
    return () => window.clearInterval(autosave);
  }, [projectReady]);

  useEffect(() => {
    if (!coreReady) return;
    const api = window.himmelcad;
    if (!api) return;
    let active = true;
    const refresh = () => {
      void api.sidecar
        .call<PhotolabJob[]>('photolab.jobs.list', { includeTerminal: true })
        .then((next) => {
          if (active) {
            setJobs(next);
            jobPollErrorLogged.current = false;
            for (const job of next) {
              if (job.kind !== 'alignPhotos') continue;
              if (!['queued', 'running', 'pauseRequested'].includes(job.state.kind)) continue;
              const total = job.progress.metrics.totalUnits;
              const stageFrac = total
                ? Math.min(1, job.progress.metrics.completedUnits / total)
                : 0;
              const overall = Math.min(
                1,
                (job.progress.stage.index + stageFrac) / Math.max(1, job.progress.stage.stageCount),
              );
              const stagePct = Math.round(stageFrac * 100);
              const overallPct = Math.round(overall * 100);
              const key = `${job.id}:${job.progress.stage.index}:${job.progress.stage.label}:${stagePct}:${overallPct}`;
              if (alignmentProgressLogRef.current.get(job.id) === key) continue;
              alignmentProgressLogRef.current.set(job.id, key);
              logEvent(
                'info',
                'sidecar',
                `Alignment · overall ${overallPct}% · stage ${job.progress.stage.index + 1}/${job.progress.stage.stageCount} “${job.progress.stage.label}” ${stagePct}%` +
                  (total != null ? ` · units ${job.progress.metrics.completedUnits}/${total}` : ''),
              );
            }
          }
        })
        .catch((error: unknown) => {
          if (active && !jobPollErrorLogged.current) {
            jobPollErrorLogged.current = true;
            logEvent('error', 'sidecar', `Job status is unavailable: ${errorMessage(error)}`);
          }
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [coreReady]);

  useEffect(() => {
    const completed = [...jobs]
      .reverse()
      .find((job) => job.kind === 'optimizeAlignment' && job.state.kind === 'completed');
    if (!completed || completed.id === lastLoadedGcpOptimizationJobId.current) return;
    const api = window.himmelcad;
    if (!api) return;
    lastLoadedGcpOptimizationJobId.current = completed.id;
    void api.sidecar
      .call<GcpOptimizationPublicationRecord | null>('photolab.gcp.optimization.latest', {
        ...(activeProcessingSetId ? { processingSetId: activeProcessingSetId } : {}),
      })
      .then(setGcpOptimization)
      .catch((error: unknown) => {
        lastLoadedGcpOptimizationJobId.current = null;
        logEvent(
          'error',
          'sidecar',
          `Completed GCP optimization could not be loaded: ${errorMessage(error)}`,
        );
      });
  }, [activeProcessingSetId, jobs]);

  useEffect(() => {
    const api = window.himmelcad;
    if (!api || !projectReady) return;
    const newlyCompleted = jobs.filter(
      (job) => job.state.kind === 'completed' && !refreshedCompletedJobs.current.has(job.id),
    );
    if (newlyCompleted.length === 0) return;
    for (const job of newlyCompleted) refreshedCompletedJobs.current.add(job.id);
    void api.sidecar
      .call<OpenPhotolabProjectResult>('photolab.project.snapshot')
      .then((opened) =>
        acceptProject(opened, {
          preserveSelection: true,
          processingSetId: activeProcessingSetId,
        }),
      )
      .catch((error: unknown) => {
        logEvent(
          'error',
          'sidecar',
          `Completed job result could not be mirrored: ${errorMessage(error)}`,
        );
      });
  }, [acceptProject, activeProcessingSetId, jobs, projectReady]);

  const cancelJob = useCallback(async (jobId: string) => {
    const api = window.himmelcad;
    if (!api) return;
    const started = performance.now();
    try {
      const { job } = await api.sidecar.call<{ firstRequest: boolean; job: PhotolabJob }>(
        'photolab.jobs.cancel',
        { jobId },
      );
      setJobs((previous) => previous.map((current) => (current.id === job.id ? job : current)));
      logEvent(
        'warn',
        'sidecar',
        `Cancellation confirmed for ${jobId} · ${(performance.now() - started).toFixed(1)} ms`,
      );
    } catch (error) {
      logEvent('error', 'sidecar', `Job could not be cancelled: ${errorMessage(error)}`);
    }
  }, []);

  const startImageQuality = useCallback(
    async (processingSetId: EntityId | null) => {
      const api = window.himmelcad;
      if (!api || !projectReady || imageQualityStarting || projectImages.length === 0) return;
      setImageQualityStarting(true);
      try {
        const result = await api.sidecar.call<{ job: PhotolabJob }>(
          'photolab.jobs.startImageQuality',
          {
            operationId: `image-quality-${crypto.randomUUID()}`,
            ...(processingSetId ? { processingSetId } : {}),
          },
        );
        setJobs((previous) => [...previous.filter((job) => job.id !== result.job.id), result.job]);
        logEvent(
          'info',
          'sidecar',
          processingSetId
            ? 'Image-quality analysis queued for the selected processing set'
            : `Image-quality analysis queued for all ${projectImages.length} images`,
        );
        setBottomTab('jobs');
        setBottomCollapsed(false);
      } catch (error) {
        logEvent(
          'error',
          'sidecar',
          `Image-quality analysis could not start: ${errorMessage(error)}`,
        );
      } finally {
        setImageQualityStarting(false);
      }
    },
    [imageQualityStarting, projectImages.length, projectReady, setBottomCollapsed],
  );

  const startAlignment = useCallback(async () => {
    const api = window.himmelcad;
    if (!api || !projectReady || alignmentStarting) return;
    if (alignmentImageCount < 2) {
      setResolveError('At least two imported images are required.');
      return;
    }
    if (!selectedAlignmentPreset) {
      setResolveError('Select an alignment preset before starting.');
      return;
    }
    const operationId = `alignment-${crypto.randomUUID()}`;
    setAlignmentStarting(true);
    setResolveError(null);
    const started = performance.now();
    const runProfile = selectedAlignmentPreset.profile;
    const runOverrides = selectedAlignmentPreset.overrides;
    try {
      const config = await api.sidecar.call<ResolvedAlignmentConfig>('photolab.alignment.resolve', {
        profile: runProfile,
        imageCount: alignmentImageCount,
        maxImageEdgeOverride: runOverrides.maxImageEdge,
        keypointsPerMegapixelOverride: runOverrides.keypointsPerMegapixel,
      });
      setResolved(config);
      const result = await api.sidecar.call<{ job: PhotolabJob }>('photolab.jobs.startAlignment', {
        operationId,
        profile: runProfile,
        cameraEntityIds: alignmentScope === 'selection' ? selectedCameraIds : [],
        processingSetId: activeProcessingSetId,
        overrides: {
          maxImageEdge: runOverrides.maxImageEdge,
          keypointsPerMegapixel: runOverrides.keypointsPerMegapixel,
          sequentialOverlap: runOverrides.sequentialOverlap,
          featureBudget: runOverrides.featureBudget,
        },
      });
      setJobs((previous) => [...previous.filter((job) => job.id !== result.job.id), result.job]);
      setBottomCollapsed(false);
      setBottomTab('jobs');
      logEvent(
        'info',
        'sidecar',
        `Photo alignment queued · ${selectedAlignmentPreset.name} · ${profileLabel(runProfile)} · edge ${config.maxImageEdge} · budget ${runOverrides.featureBudget ?? 'auto'} · ${(performance.now() - started).toFixed(1)} ms`,
      );
    } catch (error) {
      const message = errorMessage(error);
      setResolveError(message);
      logEvent('error', 'sidecar', `Photo alignment could not start: ${message}`);
    } finally {
      setAlignmentStarting(false);
    }
  }, [
    alignmentImageCount,
    alignmentScope,
    alignmentStarting,
    activeProcessingSetId,
    projectReady,
    selectedAlignmentPreset,
    selectedCameraIds,
    setBottomCollapsed,
    setBottomTab,
  ]);

  const startProduct = useCallback(
    async (configuration: ProductRunConfiguration) => {
      const api = window.himmelcad;
      if (!api || !projectReady || productStarting) return;
      const operationId = `${configuration.kind}-${crypto.randomUUID()}`;
      setProductStarting(true);
      const started = performance.now();
      try {
        const result = await api.sidecar.call<{ job: PhotolabJob }>('photolab.jobs.startProduct', {
          operationId,
          configuration,
          processingSetId: activeProductAlignmentId
            ? activeProductProcessingSetId
            : activeProcessingSetId,
          sourceAlignmentEntityId: activeProductAlignmentId,
        });
        setJobs((previous) => [...previous.filter((job) => job.id !== result.job.id), result.job]);
        logEvent(
          'info',
          'sidecar',
          `${productLabel(configuration.kind)} queued · ${(performance.now() - started).toFixed(1)} ms`,
        );
      } catch (error) {
        logEvent(
          'error',
          'sidecar',
          `${productLabel(configuration.kind)} could not start: ${errorMessage(error)}`,
        );
      } finally {
        setProductStarting(false);
      }
    },
    [
      activeProcessingSetId,
      activeProductAlignmentId,
      activeProductProcessingSetId,
      productStarting,
      projectReady,
    ],
  );

  const startBatch = useCallback(
    async (
      steps: BatchPipelineStep[],
      cameraEntityIds: readonly EntityId[],
      scopeLabel: string,
    ) => {
      const api = window.himmelcad;
      if (!api || !projectReady || batchStarting || steps.length === 0) return;
      setBatchStarting(true);
      try {
        const operationId = `batch-${crypto.randomUUID()}`;
        const resolvedSteps = await resolveBatchPipelineSteps(steps, async (path) => {
          const result = await api.alignmentPresets.loadPath(path);
          return result.preset;
        });
        const result = await api.sidecar.call<{ job: PhotolabJob }>('photolab.jobs.startBatch', {
          operationId,
          steps: resolvedSteps,
          cameraEntityIds,
          ...(activeProcessingSetId ? { processingSetId: activeProcessingSetId } : {}),
        });
        setJobs((previous) => [...previous.filter((job) => job.id !== result.job.id), result.job]);
        logEvent(
          'info',
          'sidecar',
          `Batch queued · ${steps.length} nodes · ${scopeLabel} · automatic recovery active`,
        );
        toggleBottom();
      } catch (error) {
        logEvent('error', 'sidecar', `Batch could not start: ${errorMessage(error)}`);
      } finally {
        setBatchStarting(false);
      }
    },
    [activeProcessingSetId, batchStarting, projectReady, toggleBottom],
  );

  const startGcpOptimization = useCallback(
    async (selection: GcpOptimizationSelection) => {
      const api = window.himmelcad;
      if (!api || !projectReady || gcpOptimizationStarting) return;
      const activePointIds = selection.pointIds.filter(
        (pointId) => selection.roleOverrides[pointId] !== 'disabled',
      );
      const snapshotOperationId = `gcp-snapshot-${crypto.randomUUID()}`;
      const operationId = `gcp-optimize-${crypto.randomUUID()}`;
      const processingSet = findMatchingProcessingSet(
        processingSets,
        alignedGcpCameras.map((camera) => camera.entityId),
      );
      setGcpOptimizationStarting(true);
      try {
        const snapshot = await api.sidecar.call<GcpOptimizationSnapshotResult>(
          'photolab.gcp.optimization.snapshot',
          {
            operationId: snapshotOperationId,
            ...(gcpCollection ? { expectedCollectionSha256: gcpCollection[0] } : {}),
            scope: {
              label: processingSet
                ? `${processingSet.name} · ${alignedGcpCameras.length} cameras · ${activePointIds.length} points`
                : `Ad-hoc alignment · ${alignedGcpCameras.length} cameras · ${activePointIds.length} points`,
              pointIds: activePointIds,
              cameraReferenceImageIds: selection.cameraReferenceImageIds,
            },
            roleOverrides: selection.roleOverrides,
          },
        );
        setAutosaveGeneration(snapshot.autosaveGeneration);
        const result = await api.sidecar.call<{ job: PhotolabJob }>(
          'photolab.jobs.startGcpOptimization',
          {
            operationId,
            snapshotSha256: snapshot.snapshotSha256,
            ...(processingSet ? { processingSetId: processingSet.entityId } : {}),
          },
        );
        setJobs((previous) => [...previous.filter((job) => job.id !== result.job.id), result.job]);
        logEvent(
          'info',
          'sidecar',
          `Alignment optimization queued · ${activePointIds.length} GCPs · ${selection.cameraReferenceImageIds.length} camera priors · snapshot ${snapshot.snapshotSha256.slice(0, 12)}`,
        );
      } catch (error) {
        logEvent(
          'error',
          'sidecar',
          `Alignment optimization could not start: ${errorMessage(error)}`,
        );
      } finally {
        setGcpOptimizationStarting(false);
      }
    },
    [alignedGcpCameras, gcpCollection, gcpOptimizationStarting, processingSets, projectReady],
  );

  const commitGcpMeasurement = useCallback(
    (measurement: GcpManualMeasurement): Promise<boolean> => {
      const operation = gcpMeasurementQueueRef.current.then(async (): Promise<boolean> => {
        const api = window.himmelcad;
        const currentCollection = gcpCollectionRef.current;
        if (!api || !currentCollection) return false;
        const operationId = `gcp-measure-${crypto.randomUUID()}`;
        try {
          const result = await api.sidecar.call<{
            collectionSha256: ObjectHash;
            autosaveGeneration: number;
            insertedCount: number;
            replacedCount: number;
          }>('photolab.gcp.observation.upsertAssisted', {
            operationId,
            expectedCollectionSha256: currentCollection[0],
            observation: {
              pointId: measurement.pointId,
              imageId: measurement.imageId,
              state: { state: 'manual', coordinate: measurement.coordinate },
            },
            maximumSeedDistancePixels: 3,
          });
          setAutosaveGeneration(result.autosaveGeneration);
          const updated = await api.sidecar.call<readonly [ObjectHash, GcpCollectionRecord] | null>(
            'photolab.gcp.list',
          );
          // Advance the concurrency token before the next queued drag starts;
          // waiting for React's next render would reuse the stale revision.
          gcpCollectionRef.current = updated;
          setGcpCollection(updated);
          // Every cached estimate is revision-bound. Recompute only the edited
          // point against fixed cameras; failure (usually <2 observations)
          // simply leaves global/coarse predictions in place.
          setGcpLocalEstimates([]);
          if (updated && alignedGcpCameras.length >= 2) {
            try {
              const local = await api.sidecar.call<GcpLocalEstimateArtifact>(
                'photolab.gcp.localEstimate.compute',
                {
                  expectedCollectionSha256: updated[0],
                  pointId: measurement.pointId,
                  cameras: alignedGcpCameras.map((camera) => camera.camera),
                },
              );
              if (local.estimate.collectionSha256 === updated[0]) {
                setGcpLocalEstimates([local]);
              }
            } catch {
              // One observation cannot be triangulated yet. Saving the marker
              // remains successful and does not trigger global adjustment.
            }
          }
          logEvent(
            'info',
            'sidecar',
            `GCP measurement saved · ${measurement.pointId} · ${result.insertedCount + result.replacedCount - 1} tie-point projections`,
          );
          return true;
        } catch (error) {
          logEvent('error', 'sidecar', `GCP measurement failed: ${errorMessage(error)}`);
          return false;
        }
      });
      gcpMeasurementQueueRef.current = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    [alignedGcpCameras],
  );

  const editGcpObservation = useCallback(
    async (marker: GcpImageMarker, edit: GcpObservationEdit) => {
      const api = window.himmelcad;
      if (!api || !gcpCollection) return;
      const operationId = `gcp-observation-${crypto.randomUUID()}`;
      try {
        const result = await api.sidecar.call<{
          collectionSha256: ObjectHash;
          autosaveGeneration: number;
        }>('photolab.gcp.observation.edit', {
          operationId,
          expectedCollectionSha256: gcpCollection[0],
          pointId: marker.pointId,
          imageId: marker.imageId,
          edit,
        });
        setAutosaveGeneration(result.autosaveGeneration);
        const updated = await api.sidecar.call<readonly [ObjectHash, GcpCollectionRecord] | null>(
          'photolab.gcp.list',
        );
        gcpCollectionRef.current = updated;
        setGcpCollection(updated);
        setGcpLocalEstimates([]);
        if (updated && alignedGcpCameras.length >= 2) {
          try {
            const local = await api.sidecar.call<GcpLocalEstimateArtifact>(
              'photolab.gcp.localEstimate.compute',
              {
                expectedCollectionSha256: updated[0],
                pointId: marker.pointId,
                cameras: alignedGcpCameras.map((camera) => camera.camera),
              },
            );
            if (local.estimate.collectionSha256 === updated[0]) setGcpLocalEstimates([local]);
          } catch {
            // Blocking/removing may intentionally leave fewer than two rays.
          }
        }
        logEvent('info', 'sidecar', `GCP observation ${edit.action} completed · ${marker.pointId}`);
      } catch (error) {
        logEvent('error', 'sidecar', `GCP observation edit failed: ${errorMessage(error)}`);
      }
    },
    [alignedGcpCameras, gcpCollection],
  );

  const editImageMask = useCallback(
    async (
      imageEntityId: EntityId,
      expectedRevisionSha256: ObjectHash | undefined,
      edit: EditImageMaskParams['edit'],
    ): Promise<void> => {
      const api = window.himmelcad;
      if (!api || !projectReady) return;
      const operationId = `image-mask-${crypto.randomUUID()}`;
      try {
        const result = await api.sidecar.call<EditImageMaskResult>(
          'photolab.project.imageMask.edit',
          {
            operationId,
            imageEntityId,
            ...(expectedRevisionSha256 ? { expectedRevisionSha256 } : {}),
            edit,
          } satisfies EditImageMaskParams,
        );
        setAutosaveGeneration(result.autosaveGeneration);
        const [records, images] = await Promise.all([
          api.sidecar.call<ListedImageMaskRevision[]>('photolab.project.imageMask.list'),
          api.sidecar.call<ProjectCameraImageRecord[]>('photolab.images.list'),
        ]);
        setImageMasks(records);
        setProjectImages(images);
        setImageCount(images.length);
        logEvent(
          'info',
          'sidecar',
          result.maskedPixelCount > 0
            ? `Image mask saved · ${result.maskedPixelCount.toLocaleString('en-US')} excluded pixels`
            : 'Image mask cleared',
        );
      } catch (error) {
        reportPanelError(`Image mask edit failed: ${errorMessage(error)}`);
        throw error;
      }
    },
    [projectReady, reportPanelError],
  );

  const gcpAccuracyReport = useMemo<GcpAccuracyReport | null>(() => {
    if (!gcpOptimization || !gcpCollection) return null;
    const result = gcpOptimization.artifact.result;
    const names = new Map(gcpCollection[1].points.map(({ point }) => [point.id, point.name]));
    const counts = new Map(result.points.map((point) => [point.pointId, point.observationCount]));
    const processingSet = findMatchingProcessingSet(
      processingSets,
      alignedGcpCameras.map((camera) => camera.entityId),
    );
    return {
      label: result.converged
        ? `Optimization converged · ${result.iterations} iterations`
        : `Optimization completed · ${result.iterations} iterations`,
      processingSetLabel: processingSet
        ? `${processingSet.name} · saved scope`
        : `Ad-hoc alignment · ${alignedGcpCameras.length} cameras`,
      alignmentRunLabel: gcpOptimization.operationId,
      optimizationSnapshotSha256: gcpOptimization.snapshotSha256,
      cameraCount: alignedGcpCameras.length,
      residuals: result.residuals.map((residual) => ({
        ...residual,
        pointName: names.get(residual.pointId) ?? residual.pointId,
        observationCount: counts.get(residual.pointId) ?? 0,
      })),
      ...(result.statistics.control ? { control: result.statistics.control } : {}),
      ...(result.statistics.checkpoint ? { checkpoint: result.statistics.checkpoint } : {}),
    };
  }, [alignedGcpCameras, gcpCollection, gcpOptimization, processingSets]);

  const gcpCameraReferences = useMemo(() => {
    const imagesByEntity = new Map(projectImages.map((image) => [image.entityId, image]));
    return alignedGcpCameras.map((camera) => {
      const image = imagesByEntity.get(camera.entityId);
      const reference = image?.metadata.projectedReference;
      const rtk = image?.metadata.inspectedPhoto.metadata.djiXmp.rtk;
      const horizontal = Math.max(
        rtk?.standardDeviationLongitudeMeters ?? 0,
        rtk?.standardDeviationLatitudeMeters ?? 0,
      );
      const height = rtk?.standardDeviationHeightMeters;
      const accuracyLabel =
        horizontal > 0 || (height != null && height > 0)
          ? `σ XY ${horizontal > 0 ? horizontal.toFixed(3) : '—'} m · Z ${height != null && height > 0 ? height.toFixed(3) : '—'} m`
          : image?.metadata.statusTags.includes('rtkFixed')
            ? 'RTK fixed · default σ 0.03 / 0.06 m'
            : 'GPS · default σ 5 / 10 m';
      return {
        imageId: camera.imageId,
        name: camera.imageName,
        referenceAvailable: reference?.transformedHeightMeters != null,
        accuracyLabel,
      };
    });
  }, [alignedGcpCameras, projectImages]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveProject();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveProject]);

  useEffect(() => {
    if (workspaceMode === 'images') return;
    viewportRef.current?.setSceneRenderOffset([
      project.renderOffset.x,
      project.renderOffset.y,
      project.renderOffset.z,
    ]);
    void viewportRef.current?.setViewMode(sceneNavigationMode);
  }, [
    project.renderOffset.x,
    project.renderOffset.y,
    project.renderOffset.z,
    sceneNavigationMode,
    workspaceMode,
  ]);

  useEffect(() => {
    if (workspaceMode === 'images') return;
    const alignedByEntity = new Map(
      alignedGcpCameras.map((entry) => [entry.entityId, entry] as const),
    );
    const optimizedByImageId = new Map(
      (gcpOptimization?.artifact.result.cameras ?? []).map((camera) => [camera.imageId, camera]),
    );
    viewportRef.current?.setCameraImageRectangles(
      projectImages
        .filter(
          (image) =>
            project.entities[image.entityId]?.kind === 'CameraImage' &&
            project.entities[image.entityId]?.visibility.visible !== false,
        )
        .flatMap((image) => {
          const aligned = alignedByEntity.get(image.entityId);
          const optimized = aligned ? optimizedByImageId.get(aligned.imageId) : undefined;
          return initialCameraRectangle(
            image,
            optimized
              ? {
                  widthPixels: optimized.widthPixels,
                  heightPixels: optimized.heightPixels,
                  focalXPixels: optimized.focalXPixels,
                  focalYPixels: optimized.focalYPixels,
                  cameraToWorldRotation: optimized.cameraToWorldRotation,
                  centerWorld: optimized.centerWorldMeters,
                }
              : aligned
                ? {
                    widthPixels: aligned.camera.widthPixels,
                    heightPixels: aligned.camera.heightPixels,
                    focalXPixels: aligned.camera.focalXPixels,
                    focalYPixels: aligned.camera.focalYPixels,
                    cameraToWorldRotation: aligned.camera.cameraToReconstructionRotation,
                    // The selected sparse model is normally the GPS/RTK-aligned project-world
                    // model. Only genuinely ungeoreferenced reconstructions need a temporary
                    // render-origin lift; adding the offset to an already aligned model doubles
                    // UTM/GK coordinates and makes every camera fail the precision guard.
                    centerWorld: aligned.centerInProjectWorld
                      ? aligned.camera.centerReconstruction
                      : [
                          aligned.camera.centerReconstruction[0] + project.renderOffset.x,
                          aligned.camera.centerReconstruction[1] + project.renderOffset.y,
                          aligned.camera.centerReconstruction[2] + project.renderOffset.z,
                        ],
                  }
                : undefined,
          );
        }),
    );
  }, [
    alignedGcpCameras,
    gcpOptimization,
    project.entities,
    project.renderOffset,
    projectImages,
    workspaceMode,
  ]);

  useEffect(() => {
    if (workspaceMode === 'images') return;
    const records = gcpCollection?.[1].points ?? [];
    const entityByName = new Map(
      Object.values(project.entities)
        .filter((entity) => entity.kind === 'GroundControlPoint')
        .map((entity) => [entity.name, entity]),
    );
    const markers = records.flatMap<GcpMarker>((record) => {
      const entity = entityByName.get(record.point.name);
      if (!entity?.visibility.visible) return [];
      const coordinate = record.point.coordinate;
      return [
        {
          entityId: entity.id,
          name: record.point.name,
          position: [coordinate.eastMeters, coordinate.northMeters, coordinate.heightMeters],
          role: record.point.role,
        },
      ];
    });
    viewportRef.current?.setGcpMarkers(markers);
  }, [gcpCollection, project.entities, workspaceMode]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const visibleIds = new Set(
      productDatasets.filter((dataset) => dataset.visible).map((dataset) => dataset.entityId),
    );
    desiredProductIds.current = visibleIds;
    setProductLayerStatuses((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([entityId]) => visibleIds.has(entityId as EntityId)),
      ),
    );
    for (const entityId of loadedProductIds.current) {
      if (visibleIds.has(entityId)) continue;
      productLoadGenerations.current.invalidate(entityId);
      viewport.removeLayer(entityId);
      loadedProductIds.current.delete(entityId);
    }
    for (const entityId of loadingProductIds.current) {
      if (visibleIds.has(entityId)) continue;
      productLoadGenerations.current.invalidate(entityId);
      viewport.removeLayer(entityId);
      loadingProductIds.current.delete(entityId);
    }
    for (const dataset of productDatasets) {
      if (!dataset.visible) continue;
      if (loadedProductIds.current.has(dataset.entityId)) continue;
      if (loadingProductIds.current.has(dataset.entityId)) continue;
      const loadTicket = productLoadGenerations.current.begin(dataset.entityId);
      const loadToken = entityLoadToken(loadTicket);
      loadingProductIds.current.add(dataset.entityId);
      const layerName =
        project.entities[dataset.entityId]?.name ?? productDatasetLabel(dataset.kind);
      setProductLayerStatuses((current) => ({
        ...current,
        [dataset.entityId]: { state: 'loading', name: layerName },
      }));
      const url = projectProductUrl(dataset.relativePath);
      const loading =
        (dataset.kind === 'dense' || dataset.kind === 'sparse') &&
        dataset.format === 'potreeV2' &&
        dataset.boundsMin &&
        dataset.boundsMax &&
        dataset.renderOffset &&
        dataset.pointCount != null
          ? viewport.loadPotreePointCloud(url, {
              entityId: dataset.entityId,
              sourceName: dataset.kind === 'sparse' ? 'Sparse Point Cloud' : 'Dense Point Cloud',
              loadToken,
              bounds: { min: dataset.boundsMin, max: dataset.boundsMax },
              pointCount: dataset.pointCount,
            })
          : dataset.kind === 'gaussianSplat'
            ? viewport.loadGaussianSplats(url, {
                entityId: dataset.entityId,
                loadToken,
                format: dataset.format === 'brushPly' ? 'brushPly' : 'prepared',
              })
            : dataset.kind === 'mesh' && dataset.preparedMesh
              ? viewport.loadPreparedMesh(dataset.preparedMesh, projectProductUrl, loadToken)
              : dataset.kind === 'dem' || dataset.kind === 'orthomosaic'
                ? viewport.loadRasterPyramid(url, {
                    entityId: dataset.entityId,
                    loadToken,
                    kind: dataset.kind,
                  })
                : null;
      if (!loading) {
        loadingProductIds.current.delete(dataset.entityId);
        productLoadGenerations.current.invalidate(dataset.entityId);
        setProductLayerStatuses((current) => {
          const next = { ...current };
          delete next[dataset.entityId];
          return next;
        });
        continue;
      }
      void loading
        .then(() => {
          if (!productLoadGenerations.current.isCurrent(loadTicket)) {
            if (!desiredProductIds.current.has(dataset.entityId)) {
              viewport.removeLayer(dataset.entityId);
            }
            return;
          }
          loadingProductIds.current.delete(dataset.entityId);
          if (!desiredProductIds.current.has(dataset.entityId)) {
            viewport.removeLayer(dataset.entityId);
            return;
          }
          const frameAfterLoad = loadedProductIds.current.size === 0;
          loadedProductIds.current.add(dataset.entityId);
          setProductLayerStatuses((current) => {
            const next = { ...current };
            delete next[dataset.entityId];
            return next;
          });
          if (frameAfterLoad) {
            window.requestAnimationFrame(() => {
              if (!viewport.frameSelection([dataset.entityId])) viewport.frameAll();
            });
          }
          logEvent(
            'info',
            'renderer',
            `${productDatasetLabel(dataset.kind)} loaded · ${dataset.entityId}`,
          );
        })
        .catch((error: unknown) => {
          if (!productLoadGenerations.current.isCurrent(loadTicket)) return;
          loadingProductIds.current.delete(dataset.entityId);
          const message = errorMessage(error);
          if (message.includes('load superseded by a newer entity generation')) {
            loadedProductIds.current.delete(dataset.entityId);
            setProductLayerStatuses((current) => {
              const next = { ...current };
              delete next[dataset.entityId];
              return next;
            });
            window.setTimeout(() => {
              if (desiredProductIds.current.has(dataset.entityId)) {
                setProductLayerRetryGeneration((generation) => generation + 1);
              }
            }, 0);
            return;
          }
          setProductLayerStatuses((current) => ({
            ...current,
            [dataset.entityId]: { state: 'error', name: layerName, message },
          }));
          logEvent('error', 'renderer', `Product could not be loaded: ${message}`);
        });
    }
  }, [productDatasets, productLayerRetryGeneration, project.entities]);

  const retryProductLayer = useCallback((entityId: EntityId) => {
    productLoadGenerations.current.invalidate(entityId);
    loadingProductIds.current.delete(entityId);
    loadedProductIds.current.delete(entityId);
    viewportRef.current?.removeLayer(entityId);
    setProductLayerStatuses((current) => {
      const next = { ...current };
      delete next[entityId];
      return next;
    });
    setProductLayerRetryGeneration((generation) => generation + 1);
  }, []);

  const switchWorkspace = useCallback((mode: WorkspaceMode) => {
    setWorkspaceMode(mode);
  }, []);

  const runEntityCommand = useCallback(
    async (method: string, params: Record<string, unknown>, successMessage: string) => {
      const api = window.himmelcad;
      if (!api || !projectReady) return;
      try {
        const opened = await api.sidecar.call<OpenPhotolabProjectResult>(method, params);
        acceptProject(opened);
        logEvent('info', 'sidecar', successMessage);
      } catch (error) {
        logEvent('error', 'sidecar', `Entity tree could not be changed: ${errorMessage(error)}`);
      }
    },
    [acceptProject, projectReady],
  );

  const applyProcessingSet = useCallback((processingSet: ProcessingSetRecord) => {
    setSelected(new Set(processingSet.cameraEntityIds));
    setAlignmentScope('selection');
    setActiveProcessingSetId(processingSet.entityId);
    setResolved(null);
    void window.himmelcad?.sidecar
      .call<AlignedGcpCameraRecord[]>('photolab.gcp.alignedCameras', {
        processingSetId: processingSet.entityId,
      })
      .then(setAlignedGcpCameras)
      .catch((error: unknown) => {
        setAlignedGcpCameras([]);
        logEvent(
          'warn',
          'sidecar',
          `Aligned cameras for ${processingSet.name} are not available yet: ${errorMessage(error)}`,
        );
      });
    void window.himmelcad?.sidecar
      .call<GcpOptimizationPublicationRecord | null>('photolab.gcp.optimization.latest', {
        processingSetId: processingSet.entityId,
      })
      .then(setGcpOptimization)
      .catch((error: unknown) => {
        setGcpOptimization(null);
        logEvent(
          'warn',
          'sidecar',
          `No compatible GCP optimization is available for ${processingSet.name}: ${errorMessage(error)}`,
        );
      });
    logEvent(
      'info',
      'renderer',
      `${processingSet.name} activated · ${processingSet.cameraEntityIds.length} cameras · immutable scope`,
    );
  }, []);

  const createCaptureGroup = useCallback(
    async (
      name: string,
      cameraEntityIds: readonly EntityId[],
      calibrationGroups: readonly CaptureCalibrationDraft[],
    ) => {
      const api = window.himmelcad;
      if (!api || captureGroupSaving || cameraEntityIds.length < 2) return;
      setCaptureGroupSaving(true);
      try {
        const opened = await api.sidecar.call<OpenPhotolabProjectResult>(
          'photolab.project.captureGroup.create',
          {
            name,
            cameraEntityIds,
            calibrationGroups,
          },
        );
        acceptProject(opened, { preserveSelection: true, processingSetId: activeProcessingSetId });
        const [captures, calibrations] = await Promise.all([
          api.sidecar.call<CaptureGroupRecord[]>('photolab.project.captureGroup.list'),
          api.sidecar.call<CameraCalibrationGroupRecord[]>(
            'photolab.project.calibrationGroup.list',
          ),
        ]);
        setCaptureGroups(captures);
        setCalibrationGroups(calibrations);
        logEvent(
          'info',
          'sidecar',
          `${name} created · ${cameraEntityIds.length} images · independent calibration`,
        );
      } catch (error) {
        logEvent('error', 'sidecar', `Capture group could not be created: ${errorMessage(error)}`);
      } finally {
        setCaptureGroupSaving(false);
      }
    },
    [acceptProject, activeProcessingSetId, captureGroupSaving],
  );

  const confirmCaptureGroup = useCallback(
    async (captureGroupId: EntityId) => {
      const api = window.himmelcad;
      if (!api || captureGroupSaving) return;
      setCaptureGroupSaving(true);
      try {
        const opened = await api.sidecar.call<OpenPhotolabProjectResult>(
          'photolab.project.captureGroup.confirm',
          { captureGroupId },
        );
        acceptProject(opened, { preserveSelection: true, processingSetId: activeProcessingSetId });
        const [captures, calibrations] = await Promise.all([
          api.sidecar.call<CaptureGroupRecord[]>('photolab.project.captureGroup.list'),
          api.sidecar.call<CameraCalibrationGroupRecord[]>(
            'photolab.project.calibrationGroup.list',
          ),
        ]);
        setCaptureGroups(captures);
        setCalibrationGroups(calibrations);
        logEvent('info', 'sidecar', 'Camera intrinsics grouping confirmed');
      } catch (error) {
        logEvent(
          'error',
          'sidecar',
          `Capture grouping could not be confirmed: ${errorMessage(error)}`,
        );
      } finally {
        setCaptureGroupSaving(false);
      }
    },
    [acceptProject, activeProcessingSetId, captureGroupSaving],
  );

  const updateCalibrationGroupIntrinsics = useCallback(
    async (calibrationGroupId: EntityId, intrinsicsPolicy: GcpIntrinsicsPolicy) => {
      const api = window.himmelcad;
      if (!api || captureGroupSaving) return;
      setCaptureGroupSaving(true);
      try {
        const opened = await api.sidecar.call<OpenPhotolabProjectResult>(
          'photolab.project.calibrationGroup.updateIntrinsics',
          { calibrationGroupId, intrinsicsPolicy },
        );
        acceptProject(opened, { preserveSelection: true, processingSetId: activeProcessingSetId });
        setCalibrationGroups(
          await api.sidecar.call<CameraCalibrationGroupRecord[]>(
            'photolab.project.calibrationGroup.list',
          ),
        );
        logEvent('info', 'sidecar', 'Calibration-group intrinsics policy updated');
      } catch (error) {
        logEvent(
          'error',
          'sidecar',
          `Intrinsics policy could not be saved: ${errorMessage(error)}`,
        );
      } finally {
        setCaptureGroupSaving(false);
      }
    },
    [acceptProject, activeProcessingSetId, captureGroupSaving],
  );

  const setCaptureGroupAsProcessingSet = useCallback(
    async (capture: CaptureGroupRecord) => {
      const api = window.himmelcad;
      if (!api || processingSetSaving) return;
      const existing = findMatchingProcessingSet(processingSets, capture.cameraEntityIds);
      if (existing) {
        applyProcessingSet(existing);
        activateStoredFunction('alignment.run');
        setRightPanelTab('function');
        return;
      }
      setProcessingSetSaving(true);
      try {
        const name = `${capture.name} Processing`;
        const opened = await api.sidecar.call<OpenPhotolabProjectResult>(
          'photolab.project.processingSet.create',
          { name, cameraEntityIds: capture.cameraEntityIds },
        );
        acceptProject(opened, { preserveSelection: true, processingSetId: null });
        const refreshed = await api.sidecar.call<ProcessingSetRecord[]>(
          'photolab.project.processingSet.list',
        );
        setProcessingSets(refreshed);
        const created = findMatchingProcessingSet(refreshed, capture.cameraEntityIds);
        if (!created) throw new Error('The new processing set was not published.');
        applyProcessingSet(created);
        activateStoredFunction('alignment.run');
        setRightPanelTab('function');
        logEvent(
          'info',
          'sidecar',
          `${name} created from ${capture.name} · ready for independent alignment and GCP optimization`,
        );
      } catch (error) {
        logEvent(
          'error',
          'sidecar',
          `Mission processing set could not be prepared: ${errorMessage(error)}`,
        );
      } finally {
        setProcessingSetSaving(false);
      }
    },
    [
      acceptProject,
      activateStoredFunction,
      applyProcessingSet,
      processingSetSaving,
      processingSets,
    ],
  );

  const createAlignmentMerge = useCallback(
    async (
      name: string,
      inputAlignmentEntityIds: readonly EntityId[],
      inputGcpOptimizationEntityIds: readonly EntityId[],
      connections: readonly AlignmentMergeConnection[],
    ) => {
      const api = window.himmelcad;
      if (!api || alignmentMergeBusy || inputAlignmentEntityIds.length < 2) return;
      setAlignmentMergeBusy(true);
      try {
        const opened = await api.sidecar.call<OpenPhotolabProjectResult>(
          'photolab.project.alignmentMerge.create',
          {
            name,
            inputAlignmentEntityIds,
            inputGcpOptimizationEntityIds,
            connections,
          },
        );
        acceptProject(opened, { preserveSelection: true, processingSetId: activeProcessingSetId });
        setAlignmentMerges(
          await api.sidecar.call<MergedAlignmentRunRecord[]>(
            'photolab.project.alignmentMerge.list',
          ),
        );
        logEvent(
          'info',
          'sidecar',
          `${name} planned · ${inputAlignmentEntityIds.length} alignment runs`,
        );
      } catch (error) {
        logEvent('error', 'sidecar', `Alignment merge plan failed: ${errorMessage(error)}`);
      } finally {
        setAlignmentMergeBusy(false);
      }
    },
    [acceptProject, activeProcessingSetId, alignmentMergeBusy],
  );

  const startAlignmentMerge = useCallback(
    async (mergeEntityId: EntityId) => {
      const api = window.himmelcad;
      if (!api || alignmentMergeBusy) return;
      setAlignmentMergeBusy(true);
      try {
        const result = await api.sidecar.call<{ job: PhotolabJob }>(
          'photolab.jobs.startAlignmentMerge',
          {
            operationId: `alignment-merge-${crypto.randomUUID()}`,
            mergeEntityId,
            profile,
          },
        );
        setJobs((previous) => [...previous.filter((job) => job.id !== result.job.id), result.job]);
        logEvent('info', 'sidecar', 'Alignment merge queued');
      } catch (error) {
        logEvent('error', 'sidecar', `Alignment merge could not start: ${errorMessage(error)}`);
      } finally {
        setAlignmentMergeBusy(false);
      }
    },
    [alignmentMergeBusy, profile],
  );

  const activateProcessingSet = useCallback(
    (processingSetId: EntityId) => {
      const processingSet = processingSets.find(
        (candidate) => candidate.entityId === processingSetId,
      );
      if (!processingSet) {
        logEvent('error', 'renderer', `Processing set ${processingSetId} is unavailable.`);
        return;
      }
      applyProcessingSet(processingSet);
    },
    [applyProcessingSet, processingSets],
  );

  const exportProduct = useCallback(
    async (id: EntityId) => {
      const api = window.himmelcad;
      const entity = project.entities[id];
      const dataset = productDatasets.find((candidate) => candidate.entityId === id);
      if (!api || !entity || !dataset) return;
      try {
        const result = await api.products.export<
          { job: PhotolabJob } | { confirmation: { token: string; displayName: string } }
        >({
          entityId: id,
          kind: dataset.kind,
          name: entity.name,
        });
        if (!result) return;
        if ('confirmation' in result) {
          setPendingProductExport({ ...result.confirmation, entityName: entity.name });
          return;
        }
        setJobs((previous) => [...previous.filter((job) => job.id !== result.job.id), result.job]);
        logEvent('info', 'sidecar', `Export queued · ${entity.name}`);
        setBottomTab('jobs');
        setBottomCollapsed(false);
      } catch (error) {
        logEvent('error', 'sidecar', `Product could not be exported: ${errorMessage(error)}`);
      }
    },
    [productDatasets, project.entities, setBottomCollapsed],
  );

  const confirmProductExport = useCallback(async () => {
    const api = window.himmelcad;
    if (!api || !pendingProductExport || productExportBusy) return;
    setProductExportBusy(true);
    try {
      const result = await api.products.confirmExport<{ job: PhotolabJob }>(
        pendingProductExport.token,
      );
      setJobs((previous) => [...previous.filter((job) => job.id !== result.job.id), result.job]);
      logEvent('info', 'sidecar', `Export queued · ${pendingProductExport.entityName}`);
      setPendingProductExport(null);
      setBottomTab('jobs');
      setBottomCollapsed(false);
    } catch (error) {
      logEvent('error', 'sidecar', `Product could not be exported: ${errorMessage(error)}`);
    } finally {
      setProductExportBusy(false);
    }
  }, [pendingProductExport, productExportBusy, setBottomCollapsed]);

  const cancelProductExport = useCallback(() => {
    if (!pendingProductExport || productExportBusy) return;
    const token = pendingProductExport.token;
    setPendingProductExport(null);
    void window.himmelcad?.products.cancelExport(token).catch((error: unknown) => {
      logEvent(
        'error',
        'electron',
        `Export confirmation could not be closed: ${errorMessage(error)}`,
      );
    });
  }, [pendingProductExport, productExportBusy]);

  const handleTreeContextAction = useCallback(
    (id: EntityId, action: 'showGcpImages' | 'open' | 'properties' | 'export' | 'remove') => {
      const entity = project.entities[id];
      if (!entity) return;
      if (action === 'remove' && entity.kind === 'CameraImage') {
        const entityIds = selected.has(id)
          ? [...selected].filter((candidate) => project.entities[candidate]?.kind === 'CameraImage')
          : [id];
        setPendingImageRemoval(entityIds);
      } else if (action === 'export') {
        void exportProduct(id);
      } else if (action === 'open' && entity.kind === 'ProcessingSet') {
        const processingSet = processingSets.find((candidate) => candidate.entityId === id);
        if (!processingSet) return;
        activateProcessingSet(processingSet.entityId);
        setWorkspaceMode('scene');
        activate('alignment.run');
      } else if (action === 'open' && entity.kind === 'CaptureGroup') {
        const capture = captureGroups.find((candidate) => candidate.entityId === id);
        if (!capture) return;
        setSelected(new Set(capture.cameraEntityIds));
        setWorkspaceMode('scene');
        activate('alignment.groups');
      } else if (action === 'open' && entity.kind === 'CameraCalibrationGroup') {
        const calibration = calibrationGroups.find((candidate) => candidate.entityId === id);
        if (!calibration) return;
        setSelected(new Set(calibration.cameraEntityIds));
        setWorkspaceMode('scene');
        activate('alignment.groups');
      } else if (action === 'showGcpImages') {
        const pointId = gcpCollection?.[1].points.find(({ point }) => point.name === entity.name)
          ?.point.id;
        setFocusedGcpId(pointId ?? null);
        setWorkspaceMode('images');
        activate('reference.gcp.images');
        logEvent('info', 'renderer', `Filtering images containing GCP “${entity.name}”`);
      } else if (action === 'open') {
        setFocusedGcpId(null);
        setWorkspaceMode(entity.kind === 'CameraImage' ? 'images' : 'scene');
      } else {
        setSelected(new Set([id]));
        setRightPanelTab('properties');
        setRightCollapsed(false);
      }
    },
    [
      activate,
      activateProcessingSet,
      calibrationGroups,
      captureGroups,
      exportProduct,
      gcpCollection,
      processingSets,
      project.entities,
      selected,
      setRightCollapsed,
    ],
  );

  const chooseExternalImports = useCallback(async (): Promise<void> => {
    const api = window.himmelcad;
    if (!api || !projectReady) return;
    try {
      const projectRoot = await api.externalImport.projectRoot();
      const session = await PhotolabExternalImportSession.open(projectRoot, api.sidecar.call);
      externalImportSessionRef.current = session;
      const formats = await session.listFormats();
      const captureExtensions = new Set([
        'jpg',
        'jpeg',
        'png',
        'dng',
        'heic',
        'heif',
        'avif',
        'mp4',
        'mov',
        'mkv',
        'webm',
      ]);
      const extensions = formats
        .flatMap((format) => format.extensions)
        .map((extension) => extension.replace(/^\./, '').toLowerCase())
        .filter((extension) => !captureExtensions.has(extension));
      const paths = await api.externalImport.selectFiles(extensions);
      setExternalImportPaths((current) => [...current, ...paths]);
    } catch (error) {
      logEvent('error', 'renderer', `External import could not start: ${errorMessage(error)}`);
    }
  }, [projectReady]);

  useEffect(() => {
    const api = window.himmelcad;
    if (!api || !projectReady) return;
    let active = true;
    void (async () => {
      try {
        const projectRoot = await api.externalImport.projectRoot();
        const session = await PhotolabExternalImportSession.open(projectRoot, api.sidecar.call);
        if (!active) return;
        externalImportSessionRef.current = session;
        await restoreExternalResidency(api, viewportRef.current);
      } catch (error) {
        logEvent(
          'warn',
          'renderer',
          `External datasets could not be restored: ${errorMessage(error)}`,
        );
      }
    })();
    return () => {
      active = false;
    };
  }, [project.projectId, projectReady]);

  const registrationPointClouds = useMemo<readonly PhotolabRegistrationPointCloudLayer[]>(
    () =>
      productDatasets.flatMap((dataset) => {
        if (
          !dataset.visible ||
          dataset.format !== 'potreeV2' ||
          !dataset.boundsMin ||
          !dataset.boundsMax
        ) {
          return [];
        }
        return [
          {
            entityId: dataset.entityId,
            name: project.entities[dataset.entityId]?.name ?? 'Current point cloud',
            metadataUrl: projectProductUrl(dataset.relativePath),
            pointCount: dataset.pointCount ?? 0,
            bounds: { min: dataset.boundsMin, max: dataset.boundsMax },
          },
        ];
      }),
    [productDatasets, project.entities],
  );

  const ribbonTabs = useMemo(
    () =>
      createPhotolabRibbonTabs({
        onNewProject: () => void createProject(),
        onOpenProject: () => void openProject(),
        onSaveProject: () => void saveProject(),
        onSaveProjectAs: () => void saveProjectAs(),
        onImportFiles: () => void inspectImages('files'),
        onImportFolder: () => void inspectImages('folder'),
        onImportExternal: () => void chooseExternalImports(),
        onImportGcps: () => void chooseGcpCsv(),
        onActivateFunction: activate,
      }),
    [
      chooseExternalImports,
      chooseGcpCsv,
      createProject,
      inspectImages,
      openProject,
      saveProject,
      saveProjectAs,
      activate,
    ],
  );

  const windowControls = useMemo<WindowControls | null>(() => {
    const api = window.himmelcad;
    if (!api) return null;
    return {
      minimize: () => void api.window.minimize(),
      maximizeToggle: () => void api.window.maximizeToggle(),
      close: () => void api.window.close(),
      isMaximized: () => api.window.isMaximized(),
      onMaximizeChange: (callback) => api.window.onMaximizeChange(callback),
    };
  }, []);

  const [themeMode, setThemeMode] = useState<'dark' | 'light'>(() => {
    if (typeof document === 'undefined') return 'dark';
    return document.documentElement.classList.contains('hc-theme-light') ? 'light' : 'dark';
  });
  useEffect(() => {
    document.documentElement.classList.toggle('hc-theme-dark', themeMode === 'dark');
    document.documentElement.classList.toggle('hc-theme-light', themeMode === 'light');
  }, [themeMode]);

  const statusItems = useMemo(
    () => [
      {
        id: 'core',
        content: coreReady ? '● Core ready' : '○ Core unavailable',
        align: 'left' as const,
      },
      { id: 'profile', content: `Profile: ${profileLabel(profile)}`, align: 'left' as const },
      {
        id: 'hardware',
        content: hardware ? hardwareLabel(hardware) : 'Hardware: probing…',
        align: 'left' as const,
      },
      {
        id: 'view',
        content: `View: ${workspaceLabel(workspaceMode, sceneNavigationMode)}`,
        align: 'left' as const,
      },
      {
        id: 'autosave',
        content: projectReady
          ? `Autosave: ${autosaveGeneration === lastSavedGeneration ? 'saved' : `local · ${autosaveGeneration}`}`
          : 'Autosave: initializing…',
        align: 'left' as const,
      },
      { id: 'images', content: `Images: ${imageCount}`, align: 'right' as const },
      {
        id: 'gcps',
        content: `GCPs: ${gcpCollection?.[1].points.length ?? 0}`,
        align: 'right' as const,
      },
      { id: 'snap', content: snap ? `Snap: ${snap.kind}` : 'Snap: —', align: 'right' as const },
      { id: 'units', content: 'Z-Up · m', align: 'right' as const },
      {
        id: 'theme',
        content: (
          <button
            type="button"
            className={styles.themeToggle}
            onClick={() => setThemeMode((mode) => (mode === 'dark' ? 'light' : 'dark'))}
            title="Toggle light / dark theme"
          >
            {themeMode === 'dark' ? 'Light' : 'Dark'}
          </button>
        ),
        align: 'right' as const,
      },
      { id: 'panels', content: <PanelToggles />, align: 'right' as const },
    ],
    [
      autosaveGeneration,
      coreReady,
      gcpCollection,
      hardware,
      imageCount,
      lastSavedGeneration,
      themeMode,
      profile,
      projectReady,
      snap,
      sceneNavigationMode,
      workspaceMode,
    ],
  );

  const onSelect = (id: EntityId, mode: 'replace' | 'add' | 'toggle') => {
    if (project.entities[id] && mode === 'replace') {
      setRightPanelTab('properties');
      setRightCollapsed(false);
      if (project.entities[id]?.kind === 'CameraImage') setFocusedGcpId(null);
    }
    setSelected((previous) => {
      const next = new Set(previous);
      if (mode === 'replace') {
        next.clear();
        next.add(id);
      } else if (mode === 'add') next.add(id);
      else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onCommand = (raw: string) => {
    const [command, argument] = raw.trim().split(/\s+/, 2);
    if (command === 'alignment.resolve') {
      void resolveProfile();
    } else if (command === 'alignment.run') {
      void startAlignment();
    } else if (command === 'alignment.profile' && isProfile(argument)) {
      setProfile(argument);
      activate('alignment.run');
    } else if (command === 'product.run' && isProductOperation(argument)) {
      void startProduct(defaultProductConfiguration(argument));
    } else if (command === 'batch.run') {
      activate('batch.configure');
    } else if (command === 'project.save') {
      void saveProject();
    } else {
      logEvent(
        'warn',
        'renderer',
        'Commands: alignment.resolve · alignment.run · alignment.profile qualityHybrid|maximumRobustness|fast · product.run depth|dense|dem|ortho|mesh|splat · batch.run · project.save',
      );
    }
  };

  const productOperation = productOperationFromFunctionId(activeFunctionId);

  return (
    <>
      <AppShell
        titleBar={
          <TitleBar
            appName="HimmelCAD"
            productLabel="PhotoLab"
            // Project name lives in the left tree only — not in the titlebar.
            brandMark={<img className={styles.brandLogo} src={photolabLogoUrl} alt="" />}
            controls={windowControls}
          />
        }
        ribbon={<Ribbon tabs={ribbonTabs} />}
        leftPanel={
          <EntityTree
            project={project}
            selectedIds={selected}
            onSelect={onSelect}
            onSelectMany={(ids) => {
              setSelected(new Set(ids));
              if (ids.some((id) => project.entities[id]?.kind === 'CameraImage')) {
                setFocusedGcpId(null);
                setRightPanelTab('properties');
                setRightCollapsed(false);
              }
            }}
            onRename={(entityId, name) =>
              void runEntityCommand(
                'photolab.project.entity.rename',
                { entityId, name },
                `Entity renamed · ${name}`,
              )
            }
            onMove={(entityId, newParentId) =>
              void runEntityCommand(
                'photolab.project.entity.move',
                { entityId, newParentId },
                'Entity moved in the project tree',
              )
            }
            onVisibilityChange={(entityId, visible) =>
              void runEntityCommand(
                'photolab.project.entity.visibility',
                { entityId, visible },
                visible ? 'Entity shown' : 'Entity hidden',
              )
            }
            onContextAction={handleTreeContextAction}
          />
        }
        rightPanel={
          <FunctionPanel
            activeFunctionId={activeFunctionId}
            activeTab={rightPanelTab}
            onActiveTabChange={setRightPanelTab}
            propertiesTitle={
              selected.size > 1
                ? `${selected.size} selected`
                : (selectedImage?.name ??
                  selectedGcp?.name ??
                  ([...selected][0] ? project.entities[[...selected][0]!]?.name : undefined))
            }
            properties={
              selectedImage ? (
                <ImagePropertiesPanel
                  image={selectedImage}
                  quality={selectedImageQuality}
                  aligned={selectedAlignedCamera}
                  optimization={gcpOptimization}
                />
              ) : selectedGcp && gcpCollection ? (
                <GcpPropertiesPanel
                  point={selectedGcp}
                  collection={gcpCollection[1]}
                  optimization={gcpOptimization}
                />
              ) : selected.size > 0 ? (
                <SelectionPropertiesPanel
                  project={project}
                  selectedIds={[...selected]}
                  images={projectImages}
                  processingSets={processingSets}
                  captureGroups={captureGroups}
                  calibrationGroups={calibrationGroups}
                  alignmentMerges={alignmentMerges}
                />
              ) : null
            }
            title={
              activeFunctionId === 'alignment.run'
                ? 'Align Photos'
                : activeFunctionId === 'alignment.optimize'
                  ? 'Optimize Alignment'
                  : activeFunctionId === 'alignment.merge'
                    ? 'Merge Alignments'
                    : activeFunctionId === 'alignment.groups'
                      ? 'Capture Groups'
                      : activeFunctionId === 'reference.gcp.images'
                        ? 'Images with this GCP'
                        : activeFunctionId === 'images.import.review'
                          ? undefined
                          : activeFunctionId === 'batch.configure' ||
                              activeFunctionId === 'batch.queue'
                            ? 'Batchprocessing'
                            : isProjectDiagnosticsKind(activeFunctionId)
                              ? diagnosticsTitle(activeFunctionId)
                              : productOperation
                                ? productLabel(productOperation)
                                : undefined
            }
          >
            {activeFunctionId === 'alignment.merge' ? (
              <AlignmentMergePanel
                candidates={alignmentMergeCandidates}
                merges={alignmentMerges}
                gcpOptimizations={gcpOptimizations}
                busy={alignmentMergeBusy}
                onCreate={(name, alignmentIds, optimizationIds, connections) =>
                  void createAlignmentMerge(name, alignmentIds, optimizationIds, connections)
                }
                onStart={(mergeEntityId) => void startAlignmentMerge(mergeEntityId)}
              />
            ) : activeFunctionId === 'alignment.groups' ? (
              <CaptureGroupsPanel
                captureGroups={captureGroups}
                calibrationGroups={calibrationGroups}
                projectCameras={projectImages.map((image) => ({
                  entityId: image.entityId,
                  name: image.name,
                }))}
                selectedCameras={projectImages.filter((image) =>
                  selectedCameraIds.includes(image.entityId),
                )}
                busy={captureGroupSaving || processingSetSaving}
                onCreate={(name, cameraIds, groups) =>
                  void createCaptureGroup(name, cameraIds, groups)
                }
                onConfirm={(captureGroupId) => void confirmCaptureGroup(captureGroupId)}
                intrinsicsDiagnostics={gcpOptimization?.artifact.result.intrinsicsDiagnostics ?? []}
                onUpdateIntrinsics={(groupId, policy) =>
                  void updateCalibrationGroupIntrinsics(groupId, policy)
                }
                onUseAsAlignmentScope={(capture) => void setCaptureGroupAsProcessingSet(capture)}
              />
            ) : activeFunctionId === 'reference.gcp.images' ? (
              <GcpImagesPanel
                pointName={focusedGcpName}
                images={focusedGcpImages}
                selectedImageEntityId={selectedImage?.entityId ?? null}
                onSelect={(entityId) => {
                  setSelected(new Set([entityId]));
                  setWorkspaceMode('images');
                }}
              />
            ) : activeFunctionId === 'alignment.run' ? (
              <AlignmentProfilePanel
                imageCount={alignmentImageCount}
                totalImageCount={projectImages.length}
                selectedImageCount={selectedCameraIds.length}
                scopeCameraIds={
                  alignmentScope === 'selection'
                    ? selectedCameraIds
                    : projectImages.map((image) => image.entityId)
                }
                scope={alignmentScope}
                processingSets={processingSets}
                captureGroups={captureGroups}
                activeProcessingSetId={activeProcessingSetId}
                selectedPreset={selectedAlignmentPreset}
                selectedPresetPath={selectedAlignmentPresetPath}
                resolving={resolving}
                starting={alignmentStarting}
                confirmingGroups={captureGroupSaving}
                canStart={projectReady && alignmentImageCount >= 2}
                error={resolveError}
                onScopeChange={(next) => {
                  setAlignmentScope(next);
                  setActiveProcessingSetId(null);
                  setResolved(null);
                }}
                onProcessingSetChange={activateProcessingSet}
                onPresetSelected={(preset, path) => {
                  setSelectedAlignmentPreset(preset);
                  setSelectedAlignmentPresetPath(path);
                  setProfile(preset.profile);
                  setAlignmentOverrides(preset.overrides);
                  setResolved(null);
                  logEvent(
                    'info',
                    'renderer',
                    `Alignment preset selected · ${preset.name} · ${path}`,
                  );
                }}
                onPresetCleared={() => {
                  setSelectedAlignmentPreset(null);
                  setSelectedAlignmentPresetPath(null);
                  setResolved(null);
                }}
                onStart={() => void startAlignment()}
                onConfirmPendingGroups={(ids) => {
                  void (async () => {
                    for (const id of ids) {
                      await confirmCaptureGroup(id);
                    }
                  })();
                }}
                onDefineAlignment={() => setDefineAlignmentOpen(true)}
              />
            ) : activeFunctionId === 'alignment.optimize' ? (
              <GcpOptimizationPanel
                collection={gcpCollection?.[1] ?? null}
                cameras={gcpCameraReferences}
                busy={gcpOptimizationStarting}
                onStart={(selection) => void startGcpOptimization(selection)}
              />
            ) : activeFunctionId === 'batch.configure' || activeFunctionId === 'batch.queue' ? (
              <BatchConfiguratorPanel
                busy={batchStarting}
                canStart={projectReady && projectImages.length >= 2}
                allCameraIds={projectImages.map((image) => image.entityId)}
                selectedCameraIds={selectedCameraIds}
                processingSets={processingSets}
                activeProcessingSetId={activeProcessingSetId}
                onActivateProcessingSet={activateProcessingSet}
                onClearProcessingSet={() => setActiveProcessingSetId(null)}
                onStart={(steps, cameraEntityIds, scopeLabel) =>
                  void startBatch(steps, cameraEntityIds, scopeLabel)
                }
                onError={reportPanelError}
              />
            ) : isProjectDiagnosticsKind(activeFunctionId) ? (
              <ProjectDiagnosticsPanel
                kind={activeFunctionId}
                images={projectImages}
                imageQualityAnalyses={imageQualityAnalyses}
                alignedCameras={alignedGcpCameras}
                jobs={jobs}
                processingSets={processingSets}
                activeProcessingSetId={activeProcessingSetId}
                projectTargetCrs={projectTargetCrs}
                gcpOptimization={gcpOptimization}
                imageQualityStarting={imageQualityStarting}
                onAnalyzeImageQuality={(processingSetId) => void startImageQuality(processingSetId)}
              />
            ) : productOperation ? (
              <ProductPanel
                operation={productOperation}
                busy={productStarting}
                inputs={productAlignmentInputs}
                selectedInputId={activeProductAlignmentId ?? 'latest'}
                onInputChange={(id) =>
                  setActiveProductAlignmentId(id === 'latest' ? null : (id as EntityId))
                }
                onStart={(configuration) => void startProduct(configuration)}
              />
            ) : null}
          </FunctionPanel>
        }
        bottomPanel={
          <PhotolabBottomPanel
            project={{
              id: project.projectId,
              name: project.name,
              formatVersion: project.formatVersion,
            }}
            jobs={jobs}
            onCommand={onCommand}
            onCancelJob={(jobId) => void cancelJob(jobId)}
            onCollapse={toggleBottom}
            accuracyReport={gcpAccuracyReport}
            hardware={hardware}
            products={productDatasets}
            processingSets={processingSets}
            captureGroups={captureGroups}
            calibrationGroups={calibrationGroups}
            alignmentMerges={alignmentMerges}
            alignmentRuns={alignmentMergeCandidates}
            gcpOptimizations={gcpOptimizations}
            autoExpandJobId={autoExpandJobId}
            activeTab={bottomTab}
            onTabChange={setBottomTab}
          />
        }
        viewport={
          <div className={styles.workspace}>
            <div className={styles.workspaceTabs}>
              <IslandTabs
                ariaLabel="Workspace"
                value={workspaceMode}
                onChange={(id) => switchWorkspace(id as 'scene' | 'images')}
                items={[
                  { id: 'scene', label: 'View' },
                  { id: 'images', label: 'Images' },
                ]}
              />
            </div>
            <div className={styles.workspaceBody}>
              <div
                className={`${styles.sceneWorkspace} ${workspaceMode === 'images' ? styles.workspacePaneHidden : ''}`}
                aria-hidden={workspaceMode === 'images'}
              >
                <PhotolabKernelViewport
                  key={project.projectId}
                  ref={viewportRef}
                  onCursorSnap={setSnap}
                  onLog={(level, message) => logEvent(level, 'renderer', message)}
                />
                {Object.entries(productLayerStatuses).length > 0 && (
                  <div className={styles.productLayerStatus} aria-live="polite">
                    {Object.entries(productLayerStatuses).map(([entityId, status]) => (
                      <div
                        key={entityId}
                        className={
                          status.state === 'error'
                            ? styles.productLayerStatusError
                            : styles.productLayerStatusLoading
                        }
                        role={status.state === 'error' ? 'alert' : 'status'}
                      >
                        {status.state === 'loading' ? (
                          <LoaderCircle className={styles.productLayerSpinner} size={17} />
                        ) : (
                          <AlertTriangle size={17} />
                        )}
                        <span>
                          <strong>
                            {status.state === 'loading' ? `Loading ${status.name}` : status.name}
                          </strong>
                          <small>
                            {status.state === 'loading'
                              ? 'Preparing the visible layer…'
                              : (status.message ?? 'The layer could not be loaded.')}
                          </small>
                        </span>
                        {status.state === 'error' && (
                          <button
                            type="button"
                            onClick={() => retryProductLayer(entityId as EntityId)}
                          >
                            Retry
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className={styles.sceneOverlayBar}>
                  {(['3d', '2.5d', '2d'] as const).map((mode) => (
                    <OverlayChip
                      key={mode}
                      as="button"
                      active={sceneNavigationMode === mode}
                      aria-pressed={sceneNavigationMode === mode}
                      onClick={() => setSceneNavigationMode(mode)}
                    >
                      {mode.toUpperCase()}
                    </OverlayChip>
                  ))}
                  <OverlayChip
                    as="button"
                    onClick={() => {
                      const ids = [...selected];
                      if (ids.length === 0 || !viewportRef.current?.frameSelection(ids)) {
                        viewportRef.current?.frameAll();
                      }
                    }}
                  >
                    {selected.size > 0 ? 'Frame selection' : 'Frame all'}
                  </OverlayChip>
                </div>
              </div>
              <div
                className={`${styles.imageWorkspace} ${workspaceMode === 'scene' ? styles.workspacePaneHidden : ''}`}
                aria-hidden={workspaceMode === 'scene'}
              >
                <ImageWorkspace
                  batch={imageImportBatch}
                  projectImages={projectImages}
                  imageMasks={imageMasks}
                  selectedImageEntityId={selectedImage?.entityId ?? null}
                  alignedCameras={alignedGcpCameras}
                  gcpCollection={gcpCollection?.[1] ?? null}
                  gcpOptimization={gcpOptimization}
                  gcpLocalEstimates={gcpLocalEstimates}
                  focusedGcpId={focusedGcpId}
                  onCommitGcpMeasurement={commitGcpMeasurement}
                  onEditGcpObservation={(marker, edit) => void editGcpObservation(marker, edit)}
                  onEditImageMask={editImageMask}
                  depthDatasets={productDatasets.filter((dataset) => dataset.kind === 'depth')}
                  onSelectProjectImage={(entityId) => {
                    setSelected(new Set([entityId]));
                    setRightPanelTab('properties');
                    setRightCollapsed(false);
                  }}
                  onError={reportPanelError}
                />
              </div>
            </div>
          </div>
        }
        floatingViewportTabs
        floatingLeftTabs
        floatingRightTabs
        statusBar={<StatusBar items={statusItems} />}
      />
      {window.himmelcad ? (
        <ManagedAutomationApproval transport={window.himmelcad.agentHarness} />
      ) : null}
      {activeFunctionId === 'automation.agent' && window.himmelcad ? (
        <FloatingTaskIsland onRequestClose={() => activate(null)}>
          <ManagedAgentChat
            transport={window.himmelcad.agentHarness}
            providerCredentials={window.himmelcad.providerCredentials}
            notConfiguredMessage="No agent runtime configured — configure an API key in preferences to enable the agent."
          />
        </FloatingTaskIsland>
      ) : null}
      {externalImportPaths[0] && externalImportSessionRef.current ? (
        <FloatingTaskIsland modal onRequestClose={() => undefined}>
          <PhotolabExternalImportDialog
            sourcePath={externalImportPaths[0]}
            projectLabel={project.name}
            session={externalImportSessionRef.current}
            currentPointClouds={registrationPointClouds}
            onCommitted={async () => {
              const api = window.himmelcad;
              if (!api) return;
              await restoreExternalResidency(api, viewportRef.current);
              logEvent('info', 'renderer', 'Registered external dataset committed and loaded');
            }}
            onClose={() => setExternalImportPaths((current) => current.slice(1))}
          />
        </FloatingTaskIsland>
      ) : null}
      {projectFileOperation && (
        <FloatingTaskIsland
          modal
          onRequestClose={() => {
            if (projectFileOperation.error)
              finishProjectFileOperation(projectFileOperation.archiveOperationId);
            else void cancelProjectFileOperation();
          }}
        >
          <ProjectFileOperationDialog
            operation={projectFileOperation}
            onCancel={() => void cancelProjectFileOperation()}
            onClose={() => finishProjectFileOperation(projectFileOperation.archiveOperationId)}
          />
        </FloatingTaskIsland>
      )}
      {(imageImportBusy || imageImportBatch != null || imageImportError != null) && (
        <FloatingTaskIsland>
          <ImageImportPanel
            batch={imageImportBatch}
            busy={imageImportBusy}
            progress={imageImportProgress}
            gridProgress={gridSelectionProgress}
            error={imageImportError}
            himmelcap={himmelcapImport}
            onChooseMoreFiles={() => void inspectImages('files')}
            onChooseFolder={() => void inspectImages('folder')}
            onChooseHimmelcap={() => void inspectHimmelcap()}
            onSelectGrid={selectTransformationGrid}
            onDiscoverCrs={discoverImageCrs}
            onCommit={commitImageImport}
            onCancel={() => void cancelImageImport()}
            onError={reportPanelError}
          />
        </FloatingTaskIsland>
      )}
      {gcpImportOpen && (
        <FloatingTaskIsland>
          <GcpImportPanel
            path={gcpPath}
            projectTargetCrs={projectTargetCrs}
            projectImages={projectImages}
            busy={gcpBusy}
            externalError={gcpImportError}
            gridProgress={gridSelectionProgress}
            onChooseFile={() => void chooseGcpCsv()}
            onPreview={previewGcpCsv}
            onDiscoverCrs={discoverImageCrs}
            onSelectGrid={selectTransformationGrid}
            onCommit={commitGcpCsv}
            onCancel={() => void cancelGcpImport()}
            onError={reportPanelError}
          />
        </FloatingTaskIsland>
      )}
      {pendingImageRemoval && (
        <FloatingTaskIsland
          modal
          onRequestClose={() => {
            if (!imageRemovalBusy) setPendingImageRemoval(null);
          }}
        >
          <ConfirmationDialog
            title={
              pendingImageRemoval.length === 1
                ? 'Remove image?'
                : `Remove ${pendingImageRemoval.length} images?`
            }
            message="The images are removed from the active project tree. Their immutable copied source objects remain recoverable from project history. Images referenced by a processing set, alignment, GCP observation, or product are protected."
            confirmLabel="Remove from project"
            busy={imageRemovalBusy}
            onCancel={() => {
              if (!imageRemovalBusy) setPendingImageRemoval(null);
            }}
            onConfirm={() => {
              const entityIds = [...pendingImageRemoval];
              setImageRemovalBusy(true);
              void runEntityCommand(
                'photolab.project.images.remove',
                { entityIds },
                `${entityIds.length} image${entityIds.length === 1 ? '' : 's'} removed from project`,
              ).finally(() => {
                setImageRemovalBusy(false);
                setPendingImageRemoval(null);
              });
            }}
          />
        </FloatingTaskIsland>
      )}
      {defineAlignmentOpen && (
        <FloatingTaskIsland onRequestClose={() => setDefineAlignmentOpen(false)}>
          <DefineAlignmentDialog
            onClose={() => setDefineAlignmentOpen(false)}
            onSaved={({ name, path }) => {
              logEvent('info', 'renderer', `Alignment preset saved · ${name} · ${path}`);
            }}
          />
        </FloatingTaskIsland>
      )}
      {batchRecipeOpen && (
        <FloatingTaskIsland modal onRequestClose={() => setBatchRecipeOpen(false)}>
          <BatchRecipeDialog
            busy={batchStarting}
            allCameraIds={projectImages.map((image) => image.entityId)}
            selectedCameraIds={selectedCameraIds}
            processingSets={processingSets}
            activeProcessingSetId={activeProcessingSetId}
            artifacts={productDatasets.flatMap((dataset) =>
              dataset.kind === 'dem' && dataset.versionHash
                ? [
                    {
                      entityId: dataset.entityId,
                      label: `DEM · ${project.entities[dataset.entityId]?.name ?? dataset.entityId}`,
                      kind: 'dem' as const,
                      versionHash: dataset.versionHash,
                    },
                  ]
                : [],
            )}
            onActivateProcessingSet={activateProcessingSet}
            onClearProcessingSet={() => setActiveProcessingSetId(null)}
            onRun={(steps, cameraEntityIds, scopeLabel) => {
              void startBatch(steps, cameraEntityIds, scopeLabel);
              setBatchRecipeOpen(false);
            }}
            onClose={() => setBatchRecipeOpen(false)}
            onError={reportPanelError}
          />
        </FloatingTaskIsland>
      )}
      {pendingProductExport && (
        <FloatingTaskIsland modal onRequestClose={cancelProductExport}>
          <ConfirmationDialog
            title={`Replace “${pendingProductExport.displayName}”?`}
            message="The selected export destination already exists. Replacing it removes the existing export before the new product is published. The PhotoLab project itself is not changed."
            confirmLabel="Replace and export"
            busyLabel="Queueing export…"
            busy={productExportBusy}
            onCancel={cancelProductExport}
            onConfirm={() => void confirmProductExport()}
          />
        </FloatingTaskIsland>
      )}
    </>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasFixedDjiRtk(
  metadata: ProjectCameraImageRecord['metadata']['inspectedPhoto']['metadata'],
): boolean {
  const rtk = metadata.djiXmp.rtk;
  if (!rtk) return false;
  const flag = rtk.flag?.trim().toLowerCase();
  const fixedFlag = flag === '50' || flag === 'fixed';
  const horizontal =
    rtk.standardDeviationLongitudeMeters != null &&
    rtk.standardDeviationLatitudeMeters != null &&
    rtk.standardDeviationLongitudeMeters <= 0.1 &&
    rtk.standardDeviationLatitudeMeters <= 0.1;
  const vertical =
    rtk.standardDeviationHeightMeters == null || rtk.standardDeviationHeightMeters <= 0.2;
  return fixedFlag && horizontal && vertical;
}

function mergePhotoBatches(
  previous: PhotoImportBatch | null,
  incoming: PhotoImportBatch,
): PhotoImportBatch {
  if (!previous) return incoming;
  const firstPathByHash = new Map(previous.photos.map((photo) => [photo.sha256, photo.sourcePath]));
  const photos = [...previous.photos];
  const warnings = [...previous.warnings, ...incoming.warnings];
  for (const photo of incoming.photos) {
    const duplicateOf = photo.duplicateOf ?? firstPathByHash.get(photo.sha256);
    photos.push({ ...photo, ...(duplicateOf ? { duplicateOf } : {}) });
    if (!duplicateOf) firstPathByHash.set(photo.sha256, photo.sourcePath);
  }
  return { photos, warnings };
}

function profileLabel(profile: AlignmentQualityProfile): string {
  if (profile === 'qualityHybrid') return 'Quality Hybrid';
  if (profile === 'maximumRobustness') return 'Maximum Robustness';
  return 'Fast';
}

function isProfile(value: string | undefined): value is AlignmentQualityProfile {
  return value === 'qualityHybrid' || value === 'maximumRobustness' || value === 'fast';
}

function workspaceLabel(mode: WorkspaceMode, sceneMode: '3d' | '2d' | '2.5d'): string {
  if (mode === 'images') return 'Images / Depth';
  return sceneMode === '3d' ? '3D Scene' : `${sceneMode.toUpperCase()} Plan · locked`;
}

function hardwareLabel(hardware: HardwareCapabilities): string {
  const backend = hardware.cuda
    ? `CUDA ${hardware.cuda.computeCapability.major}.${hardware.cuda.computeCapability.minor}`
    : hardware.vulkan
      ? `Vulkan ${hardware.vulkan.apiVersion}`
      : 'CPU';
  const ram = hardware.ramBytes / 1024 ** 3;
  const vram = hardware.dedicatedVramBytes
    ? ` · VRAM ${(hardware.dedicatedVramBytes / 1024 ** 3).toFixed(1)} GB`
    : '';
  return `${backend} · RAM ${ram.toFixed(1)} GB${vram}`;
}

function productOperationFromFunctionId(id: string | null): ProductOperation | null {
  if (id === 'products.depth') return 'depth';
  if (id === 'products.dense') return 'dense';
  if (id === 'products.dem') return 'dem';
  if (id === 'products.ortho') return 'ortho';
  if (id === 'products.mesh') return 'mesh';
  if (id === 'products.splat') return 'splat';
  return null;
}

function isProductOperation(value: string | undefined): value is ProductOperation {
  return (
    value === 'depth' ||
    value === 'dense' ||
    value === 'dem' ||
    value === 'ortho' ||
    value === 'mesh' ||
    value === 'splat'
  );
}

function productLabel(operation: ProductOperation): string {
  if (operation === 'depth') return 'Depth Maps';
  if (operation === 'dense') return 'Dense Point Cloud';
  if (operation === 'dem') return 'DEM';
  if (operation === 'ortho') return 'Orthomosaic';
  if (operation === 'mesh') return 'Textured Mesh';
  return 'Gaussian Splat';
}

function productDatasetLabel(kind: ProjectProductDatasetRecord['kind']): string {
  if (kind === 'gaussianSplat') return 'Gaussian Splat';
  if (kind === 'sparse') return 'Sparse Point Cloud';
  if (kind === 'dense') return 'Dense Point Cloud';
  if (kind === 'dem') return 'DEM Pyramid';
  if (kind === 'orthomosaic') return 'Orthomosaic Pyramid';
  return 'Mesh';
}

function isProjectDiagnosticsKind(value: string | null): value is ProjectDiagnosticsKind {
  return (
    value === 'images.metadata' ||
    value === 'images.quality' ||
    value === 'reference.transform' ||
    value === 'alignment.report'
  );
}

function diagnosticsTitle(kind: ProjectDiagnosticsKind): string {
  if (kind === 'images.metadata') return 'Image Metadata';
  if (kind === 'images.quality') return 'Image Status';
  if (kind === 'reference.transform') return 'Reference Frame';
  return 'Alignment Report';
}

function findMatchingProcessingSet(
  processingSets: readonly ProcessingSetRecord[],
  cameraEntityIds: readonly EntityId[],
): ProcessingSetRecord | undefined {
  const sortedCameraEntityIds = [...cameraEntityIds].sort();
  return processingSets.find(
    (candidate) =>
      candidate.cameraEntityIds.length === sortedCameraEntityIds.length &&
      [...candidate.cameraEntityIds]
        .sort()
        .every((entityId, index) => entityId === sortedCameraEntityIds[index]),
  );
}

function projectProductUrl(relativePath: string): string {
  const encoded = relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `hcad-product://project/${encoded}`;
}

function parseExternalAdmission(value: unknown): CanonicalRepresentationAdmission {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('entity' in value) ||
    typeof value.entity !== 'object' ||
    value.entity === null ||
    !('resolvedGeometry' in value)
  ) {
    throw new Error('invalid external canonical admission');
  }
  return value as CanonicalRepresentationAdmission;
}

async function restoreExternalResidency(
  api: NonNullable<typeof window.himmelcad>,
  viewport: PhotolabKernelViewportHandle | null,
): Promise<void> {
  if (!viewport) return;
  const residency = await api.externalImport.residency<ExternalImportResidency>();
  if (residency.schemaVersion !== 1) throw new Error('invalid external residency');
  for (const entry of residency.entries) {
    const admission = parseExternalAdmission(entry.admission);
    if (
      entry.dataset?.formatId === 'potree@2' &&
      admission.resolvedGeometry.kind === 'pointCloud'
    ) {
      await viewport.loadPotreePointCloud(entry.dataset.metadataUrl, {
        entityId: admission.entity.id as EntityId,
        sourceName: admission.entity.name,
        bounds: await readExternalPotreeBounds(entry.dataset.metadataUrl),
        pointCount: admission.resolvedGeometry.dataset.elementCount ?? 0,
        canonicalAdmission: admission,
      });
    } else if (entry.dataset === null) {
      await viewport.loadCanonicalPackage([admission]);
    }
  }
  viewport.frameAll();
}

async function readExternalPotreeBounds(metadataUrl: string): Promise<{
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}> {
  const response = await fetch(metadataUrl);
  if (!response.ok) throw new Error(`external Potree metadata failed (${response.status})`);
  const value: unknown = await response.json();
  if (
    typeof value !== 'object' ||
    value === null ||
    !('boundingBox' in value) ||
    typeof value.boundingBox !== 'object' ||
    value.boundingBox === null ||
    !('min' in value.boundingBox) ||
    !('max' in value.boundingBox)
  ) {
    throw new Error('external Potree metadata has no bounds');
  }
  return {
    min: externalCoordinateTuple(value.boundingBox.min),
    max: externalCoordinateTuple(value.boundingBox.max),
  };
}

function externalCoordinateTuple(value: unknown): readonly [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))
  ) {
    throw new Error('external Potree bound is invalid');
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

interface AlignedCameraRectanglePose {
  widthPixels: number;
  heightPixels: number;
  focalXPixels: number;
  focalYPixels: number;
  cameraToWorldRotation: [number, number, number, number, number, number, number, number, number];
  centerWorld: [number, number, number];
}

function initialCameraRectangle(
  record: ProjectCameraImageRecord,
  aligned?: AlignedCameraRectanglePose,
): CameraImageRectangle[] {
  if (aligned) return alignedCameraRectangle(record, aligned);
  const reference = record.metadata.projectedReference;
  if (!reference) return [];
  const photo = record.metadata.inspectedPhoto;
  const attitude = photo.metadata.djiXmp.gimbalAttitude ?? photo.metadata.djiXmp.flightAttitude;
  const yaw = degreesToRadians(attitude?.yaw ?? 0);
  const pitch = degreesToRadians(attitude?.pitch ?? -90);
  const roll = degreesToRadians(attitude?.roll ?? 0);
  const center: [number, number, number] = [
    reference.easting,
    reference.northing,
    reference.transformedHeightMeters ?? reference.sourceHeightMeters ?? 0,
  ];
  const forward = normalize3([
    Math.sin(yaw) * Math.cos(pitch),
    Math.cos(yaw) * Math.cos(pitch),
    Math.sin(pitch),
  ]);
  const unrolledRight = normalize3([Math.cos(yaw), -Math.sin(yaw), 0]);
  const unrolledUp = normalize3(cross3(unrolledRight, forward));
  const right = add3(scale3(unrolledRight, Math.cos(roll)), scale3(unrolledUp, Math.sin(roll)));
  const up = add3(scale3(unrolledUp, Math.cos(roll)), scale3(unrolledRight, -Math.sin(roll)));
  const dimensions = photo.metadata.exif.dimensions;
  const aspect = dimensions ? dimensions.widthPixels / dimensions.heightPixels : 4 / 3;
  const distance = Math.max(
    1,
    Math.min(20, (photo.metadata.djiXmp.relativeAltitude?.meters ?? 20) * 0.08),
  );
  const halfHeight = distance * 0.32;
  const halfWidth = halfHeight * Math.max(0.5, Math.min(2.5, aspect));
  const planeCenter = add3(center, scale3(forward, distance));
  const corners = [
    add3(add3(planeCenter, scale3(right, -halfWidth)), scale3(up, halfHeight)),
    add3(add3(planeCenter, scale3(right, halfWidth)), scale3(up, halfHeight)),
    add3(add3(planeCenter, scale3(right, halfWidth)), scale3(up, -halfHeight)),
    add3(add3(planeCenter, scale3(right, -halfWidth)), scale3(up, -halfHeight)),
  ] as CameraImageRectangle['corners'];
  const tags = record.metadata.statusTags;
  return [
    {
      entityId: record.entityId,
      cameraCenter: center,
      corners,
      aligned: tags.includes('aligned') && !tags.includes('alignmentStale'),
      depthReady: tags.includes('depthReady') && !tags.includes('depthStale'),
    },
  ];
}

function alignedCameraRectangle(
  record: ProjectCameraImageRecord,
  camera: AlignedCameraRectanglePose,
): CameraImageRectangle[] {
  const rotation = camera.cameraToWorldRotation;
  const right = normalize3([rotation[0], rotation[3], rotation[6]]);
  const up = normalize3([-rotation[1], -rotation[4], -rotation[7]]);
  const forward = normalize3([rotation[2], rotation[5], rotation[8]]);
  const distance = Math.max(
    0.25,
    Math.min(
      20,
      (record.metadata.inspectedPhoto.metadata.djiXmp.relativeAltitude?.meters ?? 20) * 0.08,
    ),
  );
  const halfWidth =
    (distance * camera.widthPixels) / Math.max(2 * camera.focalXPixels, Number.EPSILON);
  const halfHeight =
    (distance * camera.heightPixels) / Math.max(2 * camera.focalYPixels, Number.EPSILON);
  const planeCenter = add3(camera.centerWorld, scale3(forward, distance));
  const corners = [
    add3(add3(planeCenter, scale3(right, -halfWidth)), scale3(up, halfHeight)),
    add3(add3(planeCenter, scale3(right, halfWidth)), scale3(up, halfHeight)),
    add3(add3(planeCenter, scale3(right, halfWidth)), scale3(up, -halfHeight)),
    add3(add3(planeCenter, scale3(right, -halfWidth)), scale3(up, -halfHeight)),
  ] as CameraImageRectangle['corners'];
  const tags = record.metadata.statusTags;
  return [
    {
      entityId: record.entityId,
      cameraCenter: camera.centerWorld,
      corners,
      aligned: tags.includes('aligned') && !tags.includes('alignmentStale'),
      depthReady: tags.includes('depthReady') && !tags.includes('depthStale'),
    },
  ];
}

type Vector3Tuple = [number, number, number];

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function add3(left: readonly number[], right: readonly number[]): Vector3Tuple {
  return [
    (left[0] ?? 0) + (right[0] ?? 0),
    (left[1] ?? 0) + (right[1] ?? 0),
    (left[2] ?? 0) + (right[2] ?? 0),
  ];
}

function scale3(vector: readonly number[], scalar: number): Vector3Tuple {
  return [(vector[0] ?? 0) * scalar, (vector[1] ?? 0) * scalar, (vector[2] ?? 0) * scalar];
}

function cross3(left: readonly number[], right: readonly number[]): Vector3Tuple {
  const [lx, ly, lz] = [left[0] ?? 0, left[1] ?? 0, left[2] ?? 0];
  const [rx, ry, rz] = [right[0] ?? 0, right[1] ?? 0, right[2] ?? 0];
  return [ly * rz - lz * ry, lz * rx - lx * rz, lx * ry - ly * rx];
}

function normalize3(vector: readonly number[]): Vector3Tuple {
  const length = Math.hypot(vector[0] ?? 0, vector[1] ?? 0, vector[2] ?? 0);
  return length > 1e-12 ? scale3(vector, 1 / length) : [1, 0, 0];
}

function fromPhotolabKernelCamera(camera: KernelWorldCamera): ViewStateV1['camera'] {
  return {
    position: camera.eye,
    target: camera.target,
    up: camera.up,
    projection:
      camera.projection.kind === 'perspective'
        ? {
            kind: 'perspective',
            verticalFieldOfViewRadians: camera.projection.verticalFovRadians,
            near: camera.projection.near,
            far: camera.projection.far,
          }
        : {
            kind: 'orthographic',
            verticalSpan: camera.projection.verticalSpan,
            near: camera.projection.near,
            far: camera.projection.far,
          },
  };
}

function toPhotolabKernelCamera(state: ViewStateV1): KernelWorldCamera {
  return {
    eye: state.camera.position,
    target: state.camera.target,
    up: state.camera.up,
    projection:
      state.camera.projection.kind === 'perspective'
        ? {
            kind: 'perspective',
            verticalFovRadians: state.camera.projection.verticalFieldOfViewRadians,
            aspect: 1,
            near: state.camera.projection.near,
            far: state.camera.projection.far,
          }
        : {
            kind: 'orthographic',
            verticalSpan: state.camera.projection.verticalSpan,
            aspect: 1,
            near: state.camera.projection.near,
            far: state.camera.projection.far,
          },
  };
}

function assertSupportedPhotolabPresentation(state: ViewStateV1): void {
  const presentation = state.presentation;
  if (
    presentation.background !== 'black' ||
    presentation.renderStyle !== 'source' ||
    presentation.showGrid ||
    presentation.showAxes ||
    !presentation.showSelectionOutline
  ) {
    throw new Error('The requested PhotoLab presentation controls are not implemented.');
  }
}

function photolabScopedClipVolume(clip: ScopedClip): KernelClipVolume {
  if (clip.scope.kind !== 'all') {
    throw new Error('Entity-scoped automation clips are not supported by the current kernel.');
  }
  if (clip.primitive.kind === 'plane') {
    const sign = clip.primitive.keep === 'positive' ? 1 : -1;
    return {
      id: clip.id,
      enabled: clip.enabled,
      planes: [
        {
          normal: {
            x: clip.primitive.normal.x * sign,
            y: clip.primitive.normal.y * sign,
            z: clip.primitive.normal.z * sign,
          },
          distance: clip.primitive.constant * sign,
        },
      ],
      operation: 'keepInside',
      previewCap: false,
    };
  }
  const axes = photolabQuaternionAxes(clip.primitive.orientation);
  const center = clip.primitive.center;
  const extents = clip.primitive.halfExtents;
  const planes = axes.flatMap((axis, index) => {
    const extent = [extents.x, extents.y, extents.z][index]!;
    const centerProjection = axis.x * center.x + axis.y * center.y + axis.z * center.z;
    return [
      { normal: axis, distance: extent - centerProjection },
      {
        normal: { x: -axis.x, y: -axis.y, z: -axis.z },
        distance: extent + centerProjection,
      },
    ];
  });
  return {
    id: clip.id,
    enabled: clip.enabled,
    planes,
    operation: clip.primitive.keep === 'inside' ? 'keepInside' : 'removeInside',
    previewCap: false,
  };
}

function photolabQuaternionAxes(
  quaternion: Quaternion,
): readonly [
  { x: number; y: number; z: number },
  { x: number; y: number; z: number },
  { x: number; y: number; z: number },
] {
  const { x, y, z, w } = quaternion;
  return [
    { x: 1 - 2 * (y * y + z * z), y: 2 * (x * y + z * w), z: 2 * (x * z - y * w) },
    { x: 2 * (x * y - z * w), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + x * w) },
    { x: 2 * (x * z + y * w), y: 2 * (y * z - x * w), z: 1 - 2 * (x * x + y * y) },
  ];
}

function parseSidecarProgress(line: string): ProjectProgressEvent | null {
  const index = line.indexOf(SIDECAR_PROGRESS_PREFIX);
  if (index < 0) return null;
  try {
    const parsed = JSON.parse(line.slice(index + SIDECAR_PROGRESS_PREFIX.length).trim()) as {
      progressKey?: unknown;
      fraction?: unknown;
      message?: unknown;
      operationId?: unknown;
      archive?: unknown;
    };
    if (typeof parsed.progressKey !== 'string') return null;
    if (typeof parsed.fraction !== 'number' || !Number.isFinite(parsed.fraction)) return null;
    if (typeof parsed.message !== 'string') return null;
    return {
      progressKey: parsed.progressKey,
      fraction: Math.min(1, Math.max(0, parsed.fraction)),
      message: parsed.message,
      ...(typeof parsed.operationId === 'string' ? { operationId: parsed.operationId } : {}),
      ...(isProjectArchiveProgress(parsed.archive) ? { archive: parsed.archive } : {}),
    };
  } catch {
    return null;
  }
}

function isProjectArchiveProgress(value: unknown): value is ProjectArchiveProgress {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    ['scanning', 'packing', 'validating', 'extracting', 'committing'].includes(
      String(candidate.phase),
    ) &&
    ['filesCompleted', 'filesTotal', 'bytesCompleted', 'bytesTotal'].every(
      (key) => typeof candidate[key] === 'number' && Number.isFinite(candidate[key]),
    ) &&
    (candidate.currentPath == null || typeof candidate.currentPath === 'string')
  );
}

function referenceFrameLabel(
  frame: OpenPhotolabProjectResult['manifest']['referenceFrame'],
): string | null {
  if (!frame || typeof frame.target !== 'object' || frame.target == null) return null;
  const horizontal = (frame.target as { horizontal?: unknown }).horizontal;
  if (typeof horizontal !== 'object' || horizontal == null) return null;
  const crs = (horizontal as { crs?: unknown }).crs;
  if (typeof crs !== 'object' || crs == null) return null;
  const kind = (crs as { kind?: unknown }).kind;
  const value = (crs as { value?: unknown }).value;
  if (kind === 'epsg' && typeof value === 'number') return `EPSG:${value}`;
  if (kind === 'authority' && typeof value === 'string') {
    const horizontal = /^(EPSG:\d+)(?:\+\d+)?$/i.exec(value)?.[1];
    return horizontal ?? value;
  }
  return null;
}
