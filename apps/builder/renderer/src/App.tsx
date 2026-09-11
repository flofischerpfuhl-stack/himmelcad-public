import type {
  AppJob,
  ViewBookmarkStateV1,
  ViewDisplayStateV1,
  JobEvent,
  PropertyAssignment,
  PropertyQueryResult,
  PropertyQueryRow,
  PropertyValue,
  ScreenshotRequestV1,
  ViewStateV2,
  CanonicalPointCloudMetadata,
  PointCloudDisplayStyle,
} from '@himmelcad/app';
import {
  JOB_CHIP_DEBOUNCE_MS,
  JOB_COMPLETED_RETENTION_MS,
  ConstructionInputController,
  DrawToolController,
  pointAcquisition,
  InteractionStateStore,
  JobMirror,
  LocalStorageSelectionPersistence,
  LocalStorageViewHistoryPersistence,
  SELECTION_COMMAND_TABLE,
  SelectionStore,
  StaleViewReferenceError,
  ViewDisplayStore,
  MeasurementToolController,
  attachedMeasurementAnchor,
  measurementAnchorPosition,
  bookmarkCaptureState,
  validateViewStateReferences,
  commandById,
  dispatchRegistryShortcut,
  encodeRgbaScreenshot,
  executeSelectionCommand,
  parseViewState,
  parseViewModeTransitionRequest,
  validateScreenshotRequest,
  type CommandContext,
  type CommandInvocation,
  type MeasurementToolKind,
  type DrawRole,
  type DrawToolKind,
} from '@himmelcad/app';
import { Console, consoleStore, logEvent, runConsoleCommand } from '@himmelcad/console';
import { ManagedAgentChat, ManagedAutomationApproval } from '@himmelcad/agent';
import type { EntityId, EntityKind, ProjectSnapshot, SnapResult } from '@himmelcad/data';
import type { MeasurementV1 } from '@himmelcad/data/canonical';
import {
  AppShell,
  Button,
  ConstructionBar,
  Dialog,
  DurabilityIndicator,
  EntityTree,
  EntityCommandMenu,
  FunctionPanel,
  JobsIsland,
  JobsStatusChip,
  PanelToggles,
  PointCloudDisplayProperties,
  QuickCommandSurface,
  Ribbon,
  MixedPropertyMarker,
  NumberInput,
  ProgressBar,
  SelectionCandidateIndicator,
  SelectionPropertiesSummary,
  StatusBar,
  Toast,
  ToastRegion,
  TitleBar,
  ViewportBottomBar,
  ViewportInteractionChrome,
  installEscapeLadder,
  useLayoutStore,
  type WindowControls,
} from '@himmelcad/ui';
import {
  assertFenceVolume,
  assertViewingBox,
  fencePolygonArea,
  fencePrismFromPolygon,
  fenceVolumeFromCamera,
  placeViewingBoxCenter,
  rotateViewingBox,
  setViewingBoxMode,
  type CanonicalRepresentationAdmission,
  type KernelViewingBoxAxis,
  type KernelViewingBoxMode,
  type KernelViewingBoxOperation,
  type KernelViewingBoxState,
  type KernelFenceVolume,
  type KernelWorldCamera,
  type KernelWorldPoint,
} from '@himmelcad/viewer/kernel';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';

import builderLogoUrl from '../../build/mark.png';

import styles from './BuilderApp.module.css';
import { BuilderImportRegistrationIsland } from './BuilderImportRegistrationIsland.js';
import { BuilderPhotoLabProductImportIsland } from './BuilderPhotoLabProductImportIsland.js';
import { BuilderExportIsland } from './BuilderExportIsland.js';
import {
  BuilderKernelViewport,
  type BuilderKernelViewportHandle,
} from './BuilderKernelViewport.js';
import { FloatingTaskIsland } from './FloatingTaskIsland.js';
import { MeasurementPanel, MeasurementProperties } from './MeasurementPanel.js';
import { MeasurementViewportOverlay } from './MeasurementViewportOverlay.js';
import { DrawPanel, type DrawSnapKind } from './DrawPanel.js';
import { DrawViewportOverlay } from './DrawViewportOverlay.js';
import { DgmCreationWindow, type DgmSourceCandidate } from './DgmCreationWindow.js';
import { GroundExtractionPanel } from './GroundExtractionPanel.js';
import { GroundPreviewOverlay } from './GroundPreviewOverlay.js';
import { PointcloudSamplingPanel } from './PointcloudSamplingPanel.js';
import { PointcloudSegmentPanel } from './PointcloudSegmentPanel.js';
import { SurfaceEditPanel, type SurfaceBoundaryCandidate } from './SurfaceEditPanel.js';
import { SurfaceEditViewportOverlay } from './SurfaceEditViewportOverlay.js';
import { PlanIsland } from './PlanIsland.js';
import { SpecsIsland } from './SpecsIsland.js';
import {
  BuilderCanonicalProjectSession,
  startDurabilityPolling,
  type BuilderDurabilityStatus,
  type BuilderDrawCurveSummary,
  type BuilderMeasurementSummary,
  type BuilderPhotoLabProvenanceSummary,
  type BuilderSnapshotSummary,
  type BuilderViewingBoxSummary,
  type GroundExtractionParameters,
  type GroundExtractionResult,
  type GroundExtractionScope,
  type GroundPreviewResult,
  type PointCloudSegmentResult,
  type PointcloudRasterizeParameters,
  type PointcloudRasterizeResult,
  type PointcloudSampleParameters,
  type PointcloudSampleResult,
  type SurfaceRules,
  type SurfaceEditPreview,
} from './project.js';
import { createRibbonTabs } from './ribbon.js';
import { registeredImportExtensions } from './importDialogPolicy.js';
import {
  replaceProjectWithRecovery,
  type ProjectReplacementFailure,
} from './projectReplacement.js';
import { parseSidecarProgress } from './sidecarProgress.js';
import { contextualPointcloudPayload } from './pointcloudSourcePredicates.js';
import { canonicalSelectionBounds } from './selectionBounds.js';
import { executeBuilderSnapshotCommand } from './snapshotCommands.js';
import {
  canonicalViewingBoxCommandId,
  setViewingBoxExtent,
  viewingBoxExtents,
} from './viewingBoxWorkflow.js';

const DEFAULT_POINT_SIZE = 1;

type BuilderRendererStatus =
  | { readonly mode: 'hardware' }
  | {
      readonly mode: 'software';
      readonly from: 'webgl2';
      readonly reason: string;
      readonly gpu: string;
      readonly driver: string;
      readonly decidedAt: string;
    };

interface SegmentFenceState {
  readonly kind: 'polygon' | 'rectangle';
  readonly vertices: readonly KernelWorldPoint[];
  readonly closed: boolean;
  readonly volume: KernelFenceVolume | null;
  readonly entityIds: readonly EntityId[];
  readonly scopes: ReadonlyMap<string, GroundExtractionScope>;
}

const EMPTY_SEGMENT_FENCE: SegmentFenceState = {
  kind: 'polygon',
  vertices: [],
  closed: false,
  volume: null,
  entityIds: [],
  scopes: new Map(),
};

interface BuilderResidencyBootstrap {
  readonly schemaVersion: 1;
  readonly entries: readonly {
    readonly admission: unknown;
    readonly dataset: {
      readonly datasetId: string;
      readonly formatId: string;
      readonly metadataUrl: string;
    } | null;
    readonly pointCloud?: CanonicalPointCloudMetadata;
  }[];
}

type BuilderNavigationMode = '3d' | '2d' | '2.5d';

class NavigationModeStore {
  private mode: BuilderNavigationMode = '3d';
  private readonly listeners = new Set<() => void>();

  readonly snapshot = (): BuilderNavigationMode => this.mode;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(mode: BuilderNavigationMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    for (const listener of this.listeners) listener();
  }
}

function NavigationModeSubscriber({
  store,
  children,
}: {
  readonly store: NavigationModeStore;
  readonly children: (mode: BuilderNavigationMode) => ReactNode;
}): JSX.Element {
  const mode = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return <>{children(mode)}</>;
}

function useLiveJobClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

function LiveJobsStatusChip({
  jobs,
  debounceMs,
  onClick,
}: {
  readonly jobs: readonly AppJob[];
  readonly debounceMs: number;
  readonly onClick: () => void;
}): JSX.Element | null {
  const now = useLiveJobClock(jobs.length > 0);
  return <JobsStatusChip jobs={jobs} now={now} debounceMs={debounceMs} onClick={onClick} />;
}

function LiveJobsIsland({
  jobs,
  completedRetentionMs,
  onCancel,
  onRespond,
  onClearFinished,
}: {
  readonly jobs: readonly AppJob[];
  readonly completedRetentionMs: number;
  readonly onCancel: (id: string) => void;
  readonly onRespond: (id: string) => void;
  readonly onClearFinished: () => void;
}): JSX.Element {
  const now = useLiveJobClock(true);
  return (
    <JobsIsland
      jobs={jobs}
      now={now}
      completedRetentionMs={completedRetentionMs}
      onCancel={onCancel}
      onRespond={onRespond}
      onClearFinished={onClearFinished}
    />
  );
}

export function App(): JSX.Element {
  useEffect(() => installEscapeLadder(window), []);
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const selectionStoreRef = useRef<SelectionStore | null>(null);
  if (!selectionStoreRef.current) {
    selectionStoreRef.current = new SelectionStore({
      persistence: new LocalStorageSelectionPersistence(window.localStorage),
      onRecovery: (message) => logEvent('warn', 'renderer', message),
    });
  }
  const selectionStore = selectionStoreRef.current;
  const displayStoreRef = useRef<ViewDisplayStore | null>(null);
  if (!displayStoreRef.current) {
    displayStoreRef.current = new ViewDisplayStore(
      new LocalStorageViewHistoryPersistence(window.localStorage, 'display'),
      (message) => logEvent('warn', 'renderer', message),
    );
  }
  const displayStore = displayStoreRef.current;
  const display = useSyncExternalStore(
    displayStore.subscribe,
    displayStore.getSnapshot,
    displayStore.getSnapshot,
  );
  const selection = useSyncExternalStore(
    selectionStore.subscribe,
    selectionStore.getSnapshot,
    selectionStore.getSnapshot,
  );
  const selected = selection.selectedEntityIds as ReadonlySet<EntityId>;
  const constructionInputRef = useRef<ConstructionInputController | null>(null);
  if (!constructionInputRef.current)
    constructionInputRef.current = new ConstructionInputController();
  const constructionInputStore = constructionInputRef.current;
  const constructionInput = useSyncExternalStore(
    constructionInputStore.subscribe,
    constructionInputStore.snapshot,
    constructionInputStore.snapshot,
  );
  const navigationModeStoreRef = useRef<NavigationModeStore | null>(null);
  if (!navigationModeStoreRef.current) navigationModeStoreRef.current = new NavigationModeStore();
  const navigationModeStore = navigationModeStoreRef.current;
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [pointSize, setPointSize] = useState(DEFAULT_POINT_SIZE);
  const [pointCloudMetadata, setPointCloudMetadata] = useState<
    ReadonlyMap<EntityId, CanonicalPointCloudMetadata>
  >(new Map());
  const [hudVisible, setHudVisible] = useState(false);
  const [rendererStatus] = useState<BuilderRendererStatus>(
    window.himmelcad?.renderer.launchStatus ?? { mode: 'hardware' },
  );
  const backendFallback = useMemo(
    () => ({
      enabled: true as const,
      softwareRendering: rendererStatus.mode === 'software',
      ...(rendererStatus.mode === 'software'
        ? {
            startupFallback: {
              from: rendererStatus.from,
              to: 'software' as const,
              reason: rendererStatus.reason,
            },
          }
        : {}),
    }),
    [rendererStatus],
  );
  const [viewingBox, setViewingBox] = useState<KernelViewingBoxState | null>(null);
  const viewingBoxRef = useRef<KernelViewingBoxState | null>(null);
  const viewingBoxRevisionRef = useRef<number | null>(null);
  const viewingBoxRevisionByIdRef = useRef(new Map<string, number>());
  const viewingBoxPersistTailRef = useRef(Promise.resolve());
  const [viewingBoxes, setViewingBoxes] = useState<readonly BuilderViewingBoxSummary[]>([]);
  const [measurements, setMeasurements] = useState<readonly BuilderMeasurementSummary[]>([]);
  const measurementsRef = useRef(measurements);
  measurementsRef.current = measurements;
  const [drawCurves, setDrawCurves] = useState<readonly BuilderDrawCurveSummary[]>([]);
  const drawCurvesRef = useRef(drawCurves);
  drawCurvesRef.current = drawCurves;
  const [viewingBoxName, setViewingBoxName] = useState('Viewing Box');
  const viewingBoxNameRef = useRef(viewingBoxName);
  viewingBoxNameRef.current = viewingBoxName;
  viewingBoxRef.current = viewingBox;
  const [placingViewingBoxCenter, setPlacingViewingBoxCenter] = useState(false);
  const pendingViewingBoxIdRef = useRef<string | null>(null);
  const viewingBoxBakeAbortRef = useRef<AbortController | null>(null);
  const viewingBoxBakeJobIdRef = useRef<string | null>(null);
  const lockedViewingBoxSourceRevisionKeyRef = useRef<string | null>(null);
  const debugViewingBoxLockRef = useRef<(locked: boolean) => Promise<void>>(async () => undefined);
  const [viewingBoxBakeProgress, setViewingBoxBakeProgress] = useState<{
    readonly fraction: number;
    readonly phase: string;
  } | null>(null);
  const viewingBoxSourceRevisionKey = useMemo(
    () =>
      Object.values(project?.entities ?? {})
        .filter((entity) => entity.kind === 'PointCloud')
        .map((entity) => `${entity.id}:${entity.versionHash}`)
        .sort()
        .join('\u0000'),
    [project],
  );
  const [constructionDetached, setConstructionDetached] = useState(false);
  const [viewingBoxDetached, setViewingBoxDetached] = useState(false);
  const [propertyQuery, setPropertyQuery] = useState<PropertyQueryResult | null>(null);
  const [productProvenance, setProductProvenance] = useState<
    readonly BuilderPhotoLabProvenanceSummary[]
  >([]);
  const [treeProductProvenance, setTreeProductProvenance] = useState<
    readonly BuilderPhotoLabProvenanceSummary[]
  >([]);
  const [propertyQueryError, setPropertyQueryError] = useState<string | null>(null);
  const [propertyQueryLoading, setPropertyQueryLoading] = useState(false);
  const [propertyEditing, setPropertyEditing] = useState(false);
  const [propertyRefresh, setPropertyRefresh] = useState(0);
  const [specsOpen, setSpecsOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [dgmOpen, setDgmOpen] = useState(false);
  const [surfaceEditTargetId, setSurfaceEditTargetId] = useState<string | null>(null);
  const [surfaceEditRegionSource, setSurfaceEditRegionSource] = useState<
    'fence' | 'boundary_polyline'
  >('fence');
  const [surfaceEditPreview, setSurfaceEditPreview] = useState<SurfaceEditPreview | null>(null);
  const [surfaceEditBoundaryRegion, setSurfaceEditBoundaryRegion] = useState<
    readonly (readonly [number, number, number])[] | null
  >(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportMounted, setExportMounted] = useState(false);
  const [exportInitialScope, setExportInitialScope] = useState<'selection' | 'visible'>('visible');
  const [exportDetached, setExportDetached] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [photoLabProductImportOpen, setPhotoLabProductImportOpen] = useState(false);
  const [jobToasts, setJobToasts] = useState<readonly AppJob[]>([]);
  const [groundPreview, setGroundPreview] = useState<GroundPreviewResult | null>(null);
  const [groundResult, setGroundResult] = useState<GroundExtractionResult | null>(null);
  const [groundError, setGroundError] = useState<string | null>(null);
  const [segmentFence, setSegmentFence] = useState<SegmentFenceState>(EMPTY_SEGMENT_FENCE);
  const segmentFenceRef = useRef(segmentFence);
  segmentFenceRef.current = segmentFence;
  const [segmentError, setSegmentError] = useState<string | null>(null);
  const [sampleResult, setSampleResult] = useState<PointcloudSampleResult | null>(null);
  const [rasterizeResult, setRasterizeResult] = useState<PointcloudRasterizeResult | null>(null);
  const [pointcloudProcessingError, setPointcloudProcessingError] = useState<string | null>(null);
  const [durability, setDurability] = useState<BuilderDurabilityStatus | null>(null);
  const [durabilityFailureToast, setDurabilityFailureToast] = useState(false);
  const [snapshots, setSnapshots] = useState<readonly BuilderSnapshotSummary[]>([]);
  const [snapshotToRestore, setSnapshotToRestore] = useState<BuilderSnapshotSummary | null>(null);
  const [snapshotRestorePending, setSnapshotRestorePending] = useState(false);
  const interactionState = useMemo(() => {
    if (!project) return null;
    return interactionResolver(project, display.state);
  }, [display.state, project]);
  const [recoveryToast, setRecoveryToast] = useState<string | null>(null);
  const [projectReplacementFailure, setProjectReplacementFailure] =
    useState<ProjectReplacementFailure | null>(null);
  const [recentProjects, setRecentProjects] = useState<
    readonly { readonly path: string; readonly name: string; readonly openedAtUnixMs: number }[]
  >([]);
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [closeMode, setCloseMode] = useState<'project' | 'window' | null>(null);
  const [registrationItems, setRegistrationItems] = useState<
    readonly { readonly jobId: string; readonly sourcePath: string }[]
  >([]);
  const [foregroundRegistrationJobId, setForegroundRegistrationJobId] = useState<string | null>(
    null,
  );
  const registrationItem =
    registrationItems.find((item) => item.jobId === foregroundRegistrationJobId) ??
    registrationItems[0] ??
    null;
  const registrationSourcePath = registrationItem?.sourcePath ?? null;
  const [backgroundedRegistrationJobId, setBackgroundedRegistrationJobId] = useState<string | null>(
    null,
  );
  const [rightPanelTab, setRightPanelTab] = useState<'function' | 'properties'>('function');
  const [commandSurface, setCommandSurface] = useState<{
    readonly kind: 'entity' | 'void';
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>(() =>
    document.documentElement.classList.contains('hc-theme-light') ? 'light' : 'dark',
  );
  const activeFunctionId = useLayoutStore((s) => s.activeFunctionId);
  const activate = useLayoutStore((s) => s.activateFunction);
  const closeFunction = useLayoutStore((s) => s.closeFunction);
  const toggleBottom = useLayoutStore((s) => s.toggleBottomPanel);
  const viewportRef = useRef<BuilderKernelViewportHandle | null>(null);
  const initialImportStartedRef = useRef(false);
  const initialMixedSceneStartedRef = useRef(false);
  const canonicalSessionRef = useRef<BuilderCanonicalProjectSession | null>(null);
  const canonicalReadyRef = useRef<Promise<BuilderCanonicalProjectSession> | null>(null);
  const ensureCanonicalProjectRef = useRef<() => Promise<BuilderCanonicalProjectSession>>(
    async () => {
      throw new Error('canonical project opener is not ready');
    },
  );
  const measurementToolRef = useRef<MeasurementToolController<BuilderMeasurementSummary> | null>(
    null,
  );
  if (!measurementToolRef.current) {
    measurementToolRef.current = new MeasurementToolController({
      layerId: 'default-layer',
      nextName: (kind) => `${measurementKindLabel(kind)} ${measurementsRef.current.length + 1}`,
      sink: {
        create: async ({ name, measurement }) => {
          const session = await ensureCanonicalProjectRef.current();
          const created = await session.createMeasurement(
            `measurement-${crypto.randomUUID()}`,
            name,
            measurement,
          );
          setProject(session.projectSnapshot());
          setMeasurements(await session.listMeasurements());
          selectionStore.replace([created.entityId]);
          setRightPanelTab('properties');
          activate('measurement.list');
          return created;
        },
      },
    });
  }
  const measurementToolStore = measurementToolRef.current;
  const measurementTool = useSyncExternalStore(
    measurementToolStore.subscribe,
    measurementToolStore.snapshot,
    measurementToolStore.snapshot,
  );
  const drawToolRef = useRef<DrawToolController | null>(null);
  if (!drawToolRef.current) {
    drawToolRef.current = new DrawToolController(
      {
        write: async (input) => {
          const session = await ensureCanonicalProjectRef.current();
          const { summary, result } = await session.putDrawCurve(input);
          const next = await session.listDrawCurves();
          setProject(session.projectSnapshot());
          setDrawCurves(next);
          await viewportRef.current?.loadCanonicalPackage({
            providerId: 'hcad.draw@1',
            providerVersion: '1',
            admissions: [summary.admission],
          });
          selectionStore.replace([summary.entityId]);
          return result;
        },
        undo: async (commandId) => {
          const session = await ensureCanonicalProjectRef.current();
          const entityId = drawToolRef.current?.snapshot().entityId;
          const result = await session.undoDrawCurve(commandId);
          const next = await session.listDrawCurves();
          setProject(session.projectSnapshot());
          setDrawCurves(next);
          const live = entityId ? next.find((curve) => curve.entityId === entityId) : null;
          if (live) {
            await viewportRef.current?.loadCanonicalPackage({
              providerId: 'hcad.draw@1',
              providerVersion: '1',
              admissions: [live.admission],
            });
          } else if (entityId) {
            viewportRef.current?.setEntityVisibility([entityId as EntityId], false);
          }
          return result;
        },
      },
      (kind) => ({
        entityId: `draw-${kind}-${crypto.randomUUID()}`,
        name: `${drawKindLabel(kind)} ${drawCurvesRef.current.length + 1}`,
      }),
    );
  }
  const drawToolStore = drawToolRef.current;
  const drawTool = useSyncExternalStore(
    drawToolStore.subscribe,
    drawToolStore.snapshot,
    drawToolStore.snapshot,
  );
  const [drawSnapKinds, setDrawSnapKinds] = useState<Readonly<Record<DrawSnapKind, boolean>>>({
    point: true,
    cloudPoint: true,
    end: true,
    mid: true,
    intersection: true,
    perpendicular: true,
  });
  const [constructionClaimGeneration, setConstructionClaimGeneration] = useState(0);
  const currentProjectPathRef = useRef<string | null>(null);
  const startupProjectRef = useRef<Promise<string> | null>(null);
  const closeCancelledRef = useRef(false);
  const durabilityRecoveryReportedRef = useRef(false);
  const jobMirrorRef = useRef<JobMirror | null>(null);
  const executeRegistryCommandRef = useRef<(invocation: CommandInvocation) => void | Promise<void>>(
    () => undefined,
  );
  const groundAutomationRef = useRef<
    (
      method: string,
      params: unknown,
    ) => Promise<{ readonly schemaId: string; readonly payload: unknown }>
  >(async () => {
    throw new Error('Ground extraction automation is not ready.');
  });
  const pointcloudProcessingAutomationRef = useRef<
    (
      method: 'pointcloud.sample' | 'pointcloud.rasterize',
      params: unknown,
    ) => Promise<{ readonly schemaId: string; readonly payload: unknown }>
  >(async () => {
    throw new Error('Point-cloud processing automation is not ready.');
  });
  const currentViewStateRef = useRef<() => ViewStateV2>(() => {
    throw new Error('Builder view state is not ready.');
  });
  const applyViewStateRef = useRef<(state: unknown) => Promise<ViewStateV2>>(async () => {
    throw new Error('Builder view state is not ready.');
  });
  const projectActionsRef = useRef({
    create: async (): Promise<void> => undefined,
    open: async (): Promise<void> => undefined,
    saveAs: async (): Promise<void> => undefined,
    close: async (): Promise<void> => undefined,
  });
  if (!jobMirrorRef.current && window.himmelcad) {
    jobMirrorRef.current = new JobMirror(window.himmelcad.jobs);
  }
  const jobs = useSyncExternalStore(
    jobMirrorRef.current?.subscribe ?? (() => () => undefined),
    jobMirrorRef.current?.snapshot ?? (() => []),
    () => [],
  );
  const entityGroupsRef = useRef({
    cloud: [] as EntityId[],
    ifc: [] as EntityId[],
    orthophoto: [] as EntityId[],
    mesh: [] as EntityId[],
  });
  const selectedRef = useRef(selected);
  const projectRef = useRef(project);
  const automationHiddenRef = useRef(new Set<EntityId>());
  selectedRef.current = selected;
  projectRef.current = project;
  currentProjectPathRef.current = currentProjectPath;
  const settleNavigationMode = useCallback(
    (mode: BuilderNavigationMode): void => navigationModeStore.set(mode),
    [navigationModeStore],
  );
  const selectedEntityKey = useMemo(() => [...selected].sort().join('\u0000'), [selected]);

  useEffect(() => {
    if (!import.meta.env.DEV && import.meta.env.VITE_HCAD_PERF_DEBUG !== '1') return undefined;
    const target = window as Window & { __hcadS08Debug?: unknown };
    const debug = Object.freeze({
      getState: () => currentViewStateRef.current(),
      setState: (state: unknown) => applyViewStateRef.current(state),
      displaySnapshot: () => displayStore.getSnapshot(),
      displayOverride: (entityId: string, state: 'hidden' | 'reference' | 'editable' | 'inert') =>
        displayStore.setOverride(entityId, state),
      displayOpenProject: (projectId: string) => displayStore.openProject(projectId),
      displayFlush: () => displayStore.flushPersistence(),
      cameraHistory: (action: 'get' | 'undo' | 'redo' | 'clear') =>
        viewportRef.current?.cameraHistory(action),
      preset: (preset: 'top' | 'front' | 'right' | 'isometric' | 'perspective') =>
        viewportRef.current?.setPreset(preset),
      setHud: (visible: boolean) => setHudVisible(visible),
      sampleDiagnostics: (durationMs: number) =>
        viewportRef.current?.sampleDiagnostics({ durationMs }),
      quality: () => viewportRef.current?.qualitySnapshot(),
      projectPath: () => currentProjectPathRef.current,
      viewingBox: () => viewingBoxRef.current,
      viewingBoxes: () => [...viewingBoxRevisionByIdRef.current.entries()],
      lockViewingBox: (locked: boolean) => debugViewingBoxLockRef.current(locked),
      viewingBoxFlush: () => viewingBoxPersistTailRef.current,
    });
    target.__hcadS08Debug = debug;
    return () => {
      if (target.__hcadS08Debug === debug) delete target.__hcadS08Debug;
    };
  }, [displayStore]);

  useEffect(() => {
    const mirror = jobMirrorRef.current;
    if (!mirror) return;
    let unmount: (() => void) | undefined;
    void mirror.mount().then((off) => {
      unmount = off;
      setRegistrationItems(
        mirror
          .snapshot()
          .filter(
            (job) =>
              job.owner === 'builder.import' &&
              job.state !== 'completed' &&
              job.state !== 'failed' &&
              job.state !== 'cancelled',
          )
          .flatMap((job) =>
            typeof job.context?.sourcePath === 'string'
              ? [{ jobId: job.id, sourcePath: job.context.sourcePath }]
              : [],
          ),
      );
    });
    return () => unmount?.();
  }, []);

  useEffect(() => {
    const candidates = jobs
      .filter(
        (job) =>
          job.owner === 'builder.import' &&
          job.state !== 'completed' &&
          job.state !== 'failed' &&
          job.state !== 'cancelled',
      )
      .flatMap((job) =>
        typeof job.context?.sourcePath === 'string'
          ? [{ jobId: job.id, sourcePath: job.context.sourcePath }]
          : [],
      );
    setRegistrationItems((current) => [
      ...current,
      ...candidates.filter((candidate) => !current.some((item) => item.jobId === candidate.jobId)),
    ]);
  }, [jobs]);

  useEffect(() => {
    const api = window.himmelcad;
    if (!api) return;
    return api.jobs.onEvent((event: JobEvent) => {
      if (
        (event.kind === 'started' || event.kind === 'updated') &&
        event.job.owner === 'builder.viewing-box-bake' &&
        event.job.state === 'cancelling' &&
        event.job.id === viewingBoxBakeJobIdRef.current
      ) {
        viewingBoxBakeAbortRef.current?.abort();
      }
      if (event.kind !== 'completed' && event.kind !== 'failed' && event.kind !== 'cancelled')
        return;
      const job = event.job;
      setJobToasts((current) => [...current.filter((item) => item.id !== job.id), job]);
      const duration = ((job.finishedAtUnixMs! - job.createdAtUnixMs) / 1_000).toFixed(1);
      logEvent(
        event.kind === 'failed' ? 'error' : event.kind === 'cancelled' ? 'warn' : 'info',
        'renderer',
        event.kind === 'failed'
          ? `${job.label} failed after ${duration} s; canonical project remains unchanged: ${job.error}`
          : `${job.label} ${event.kind} · ${duration} s`,
      );
    });
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('hc-theme-dark', themeMode === 'dark');
    document.documentElement.classList.toggle('hc-theme-light', themeMode === 'light');
  }, [themeMode]);

  useEffect(() => {
    const bridge = window.himmelcad?.automationViewHost;
    if (!bridge) return;
    const unregister = bridge.register(async (method, params) => {
      const viewport = viewportRef.current;
      if (!viewport) throw new Error('Builder view host is not ready.');
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
        if (!captureRect) throw new Error('Builder viewport has no capture rectangle.');
        return { captureRect };
      }
      if (method === 'measurement.list') {
        return admissionResult(
          await (await ensureCanonicalProjectRef.current()).listMeasurements(),
        );
      }
      if (
        method === 'snapshot.create' ||
        method === 'snapshot.list' ||
        method === 'snapshot.restore'
      ) {
        const session = await ensureCanonicalProjectRef.current();
        const command = await executeBuilderSnapshotCommand(
          session,
          method,
          automationPayload(params),
        );
        setSnapshots(command.snapshots);
        if (command.method === 'snapshot.restore') {
          pruneRemovedSelection(selectionStore, projectRef.current, command.project);
          setProject(command.project);
          await reloadCanonicalResidencyRef.current();
        } else if (command.method === 'snapshot.create') {
          setProject(session.projectSnapshot());
        }
        return admissionResult(command.result);
      }
      if (method === 'measurement.get') {
        const payload = automationPayload(params);
        if (typeof payload.entityId !== 'string') {
          throw new TypeError('measurement.get requires payload.entityId');
        }
        return admissionResult(
          await (await ensureCanonicalProjectRef.current()).getMeasurement(payload.entityId),
        );
      }
      if (
        method === 'measurement.create' ||
        method === 'measure.point' ||
        method === 'measure.distance' ||
        method === 'measure.dz'
      ) {
        const payload = automationPayload(params);
        if (!isMeasurementPayload(payload.measurement)) {
          throw new TypeError(`${method} requires payload.measurement using hcad.measurement@1`);
        }
        const expectedKind = measurementKindForMethod(method);
        if (expectedKind && payload.measurement.measurementKind !== expectedKind) {
          throw new TypeError(`${method} does not match payload.measurement.measurementKind`);
        }
        const session = await ensureCanonicalProjectRef.current();
        const created = await session.createMeasurement(
          typeof payload.entityId === 'string'
            ? payload.entityId
            : `measurement-${crypto.randomUUID()}`,
          typeof payload.name === 'string'
            ? payload.name
            : `${measurementKindLabel(payload.measurement.measurementKind)} ${measurementsRef.current.length + 1}`,
          payload.measurement,
        );
        setProject(session.projectSnapshot());
        setMeasurements(await session.listMeasurements());
        return admissionResult(created);
      }
      if (method === 'measurement.remove' || method === 'measurement.delete') {
        const payload = automationPayload(params);
        if (typeof payload.entityId !== 'string') {
          throw new TypeError(`${method} requires payload.entityId`);
        }
        const session = await ensureCanonicalProjectRef.current();
        const current = await session.getMeasurement(payload.entityId);
        const expectedRevision =
          typeof payload.expectedRevision === 'number'
            ? payload.expectedRevision
            : current.revision;
        await session.deleteMeasurement(payload.entityId, expectedRevision);
        selectionStore.pruneDeleted([payload.entityId]);
        setProject(session.projectSnapshot());
        setMeasurements(await session.listMeasurements());
        return admissionResult({ entityId: payload.entityId, deleted: true });
      }
      if (method === 'view.bookmark.list') {
        return await (await ensureCanonicalProjectRef.current()).listViewBookmarks();
      }
      if (method === 'view.bookmark.create') {
        const payload = automationPayload(params);
        const name = typeof payload.name === 'string' ? payload.name : nextBookmarkName(0);
        const bookmark = await (
          await ensureCanonicalProjectRef.current()
        ).createViewBookmark(name, bookmarkCaptureState(currentBuilderViewState()));
        setProject(canonicalSessionRef.current?.projectSnapshot() ?? null);
        return bookmark;
      }
      if (method === 'view.bookmark.restore') {
        const payload = automationPayload(params);
        if (typeof payload.entityId !== 'string') {
          throw new TypeError('view.bookmark.restore requires entityId');
        }
        const session = await ensureCanonicalProjectRef.current();
        const listed = await session.listViewBookmarks();
        const selectedBookmark = listed.find((item) => item.entityId === payload.entityId);
        if (!selectedBookmark) throw new Error(`Bookmark ${payload.entityId} no longer exists.`);
        const candidate = viewStateFromBookmark(selectedBookmark.state, currentBuilderViewState());
        validateBuilderClipRefs(candidate, viewingBoxRef.current, viewingBoxRevisionRef.current);
        const bookmark = await session.restoreViewBookmark(
          selectedBookmark.entityId,
          typeof payload.expectedRevision === 'number'
            ? payload.expectedRevision
            : selectedBookmark.revision,
        );
        await applyViewStateRef.current(candidate);
        setProject(session.projectSnapshot());
        return bookmark;
      }
      if (method === 'viewing_box.list' || method === 'view.box.list') {
        return await (await ensureCanonicalProjectRef.current()).listViewingBoxes();
      }
      if (method === 'view.presentation.set') {
        const payload = automationPayload(params) as Partial<ViewStateV2['presentation']>;
        const live = currentBuilderViewState();
        return await applyBuilderViewState({
          ...live,
          presentation: { ...live.presentation, ...payload },
        });
      }
      if (method === 'view.point_size.set') {
        const payload = automationPayload(params);
        const multiplier = payload.multiplier ?? payload.value;
        if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0) {
          throw new TypeError('view.point_size.set requires a positive numeric multiplier');
        }
        const live = currentBuilderViewState();
        return await applyBuilderViewState({
          ...live,
          presentation: { ...live.presentation, pointSizeMultiplier: multiplier },
        });
      }
      if (
        method === 'pointcloud.ground.extract' ||
        method === 'pointcloud.ground.preview' ||
        method === 'pointcloud.ground.cancel'
      ) {
        return await groundAutomationRef.current(method, params);
      }
      if (method === 'pointcloud.sample' || method === 'pointcloud.rasterize') {
        return await pointcloudProcessingAutomationRef.current(method, params);
      }
      const registryEntry = commandById(canonicalViewingBoxCommandId(method));
      if (registryEntry?.surfaces.automation) {
        if (registryEntry.id.startsWith('view.box.') && registryEntry.id !== 'view.box.list') {
          viewport.cancelViewingBoxDrag();
        }
        await executeRegistryCommandRef.current({
          id: registryEntry.id,
          args: [],
          source: 'automation',
          payload: params,
        });
        return { schemaId: 'hcad.command-result@1', payload: { commandId: registryEntry.id } };
      }
      if (
        method.startsWith('select.') ||
        method.startsWith('selection.history.') ||
        method.startsWith('selection.granularity.') ||
        method.startsWith('selection.kind_filter.')
      ) {
        if (!(method in SELECTION_COMMAND_TABLE)) {
          throw new Error(`Unsupported selection method: ${method}`);
        }
        return executeSelectionCommand(
          selectionStore,
          method as Parameters<typeof executeSelectionCommand>[1],
          params,
        );
      }
      if (method === 'view.diagnostics.get') return viewport.diagnosticsSnapshot();
      if (method === 'view.quality.get') return viewport.qualitySnapshot();
      if (method === 'view.diagnostics.sample') {
        const envelope = params as {
          readonly schemaId?: unknown;
          readonly payload?: { readonly durationMs?: unknown; readonly lastFrames?: unknown };
        };
        if (envelope.schemaId !== 'hcad.view-diagnostics-sample-request@1') {
          throw new TypeError('view.diagnostics.sample requires the S-01 request envelope');
        }
        const request = envelope.payload ?? {};
        if (typeof request.durationMs !== 'number') {
          throw new TypeError('view.diagnostics.sample requires numeric durationMs');
        }
        return Object.freeze({
          schemaId: 'hcad.view-diagnostics-sample-result@1',
          payload: await viewport.sampleDiagnostics({
            durationMs: request.durationMs,
            ...(typeof request.lastFrames === 'number' ? { lastFrames: request.lastFrames } : {}),
          }),
        });
      }
      if (
        method === 'view.support_overlay.get' ||
        method === 'view.support_overlay.set' ||
        method === 'view.labels.global.get' ||
        method === 'view.labels.global.set'
      ) {
        const value = displayBooleanOperationValue(params);
        if (method.endsWith('.set')) {
          if (value === null) throw new TypeError(`${method} requires boolean payload.value`);
          if (method.startsWith('view.support_overlay.')) displayStore.setSupportOverlay(value);
          else displayStore.setLabels(value);
        }
        const state = displayStore.getSnapshot().state;
        return Object.freeze({
          schemaId: 'hcad.view-display-command-result@1',
          payload: {
            value: method.startsWith('view.support_overlay.') ? state.supportOverlay : state.labels,
          },
        });
      }
      if (method.startsWith('display.history.') || method.startsWith('view.display.')) {
        const action = method.split('.').at(-1);
        if (action === 'get') return displayStore.getSnapshot();
        if (action === 'undo') displayStore.undo();
        else if (action === 'redo') displayStore.redo();
        else if (action === 'clear') displayStore.clear();
        else throw new Error(`Unsupported display history method: ${method}`);
        return displayStore.getSnapshot();
      }
      if (method.startsWith('camera.history.') || method.startsWith('view.camera.')) {
        const action = method.split('.').at(-1);
        if (!['get', 'undo', 'redo', 'clear'].includes(action ?? '')) {
          throw new Error(`Unsupported camera history method: ${method}`);
        }
        return await viewport.cameraHistory(action as 'get' | 'undo' | 'redo' | 'clear');
      }
      if (method === 'view.state.get') return currentBuilderViewState();
      if (method === 'view.mode.set') {
        const request = parseViewModeTransitionRequest(params);
        const settled = await viewport.setViewMode(request.mode, {
          ...(request.durationMilliseconds === undefined
            ? {}
            : { durationMilliseconds: request.durationMilliseconds }),
          ...(request.cursorAnchor === undefined ? {} : { cursorAnchor: request.cursorAnchor }),
          ...(request.cursorNdc === undefined ? {} : { cursorNdc: request.cursorNdc }),
        });
        if (!settled) throw new Error('View mode transition was cancelled.');
        await viewport.waitForNextPresentedFrame();
        return currentBuilderViewState();
      }
      if (method !== 'view.state.set') throw new Error(`Unsupported view host method: ${method}`);
      return await applyBuilderViewState(params);
    });

    async function applyBuilderViewState(input: unknown): Promise<ViewStateV2> {
      const viewport = viewportRef.current;
      if (!viewport) throw new Error('Builder view host is not ready.');
      const state = parseViewState(input);
      // Resolve the complete clip set before mutating camera, display or selection.
      for (const ref of state.clipRefs) {
        const box = viewingBoxRef.current;
        if (!box || ref.entityId !== box.id) {
          throw new StaleViewReferenceError(ref.entityId, ref.expectedRevision, null);
        }
        const revision = viewingBoxRevisionRef.current;
        if (revision === null || ref.expectedRevision !== revision) {
          throw new StaleViewReferenceError(ref.entityId, ref.expectedRevision, revision);
        }
      }
      if (!(await viewport.setViewMode(state.navigationMode))) {
        throw new Error('View mode transition was cancelled.');
      }
      settleNavigationMode(state.navigationMode);
      viewport.adoptWorldCamera(toKernelCamera(state));

      const nextHidden = new Set(state.sessionHiddenEntityIds as readonly EntityId[]);
      for (const id of automationHiddenRef.current) {
        if (!nextHidden.has(id)) {
          const visible = projectRef.current?.entities[id]?.visibility.visible ?? true;
          viewport.setEntityVisibility([id], visible);
          selectionStore.entitiesHidden([id], !visible);
        }
      }
      for (const id of nextHidden) {
        viewport.setEntityVisibility([id], false);
        selectionStore.entitiesHidden([id], true);
      }
      automationHiddenRef.current = nextHidden;
      const overrides = { ...displayStore.getSnapshot().state.overrides };
      for (const entity of Object.values(projectRef.current?.entities ?? {})) {
        if (entity.id === projectRef.current?.rootEntity) continue;
        if (state.hiddenEntityIds.includes(entity.id)) overrides[entity.id] = 'hidden';
        else if (overrides[entity.id] === 'hidden') overrides[entity.id] = 'editable';
      }
      displayStore.replaceState({
        ...displayStore.getSnapshot().state,
        overrides,
        activeClipEntityIds: state.clipRefs.filter((ref) => ref.active).map((ref) => ref.entityId),
        presentation: state.presentation,
      });
      selectionStore.replace(state.selectedEntityIds);
      viewport.setViewingBox(
        state.clipRefs.some((ref) => ref.active) ? viewingBoxRef.current : null,
      );
      setPointSize(state.presentation.pointSizeMultiplier);
      await viewport.waitForNextPresentedFrame();
      return currentBuilderViewState();
    }

    function currentBuilderViewState(): ViewStateV2 {
      const camera = viewportRef.current?.worldCamera();
      if (!camera) throw new Error('Builder camera is not ready.');
      const hidden = Object.values(projectRef.current?.entities ?? {})
        .filter(
          (entity) =>
            entity.id !== projectRef.current?.rootEntity &&
            displayStore.effective(entity.id) === 'hidden',
        )
        .map((entity) => entity.id)
        .sort();
      const box = viewingBoxRef.current;
      return {
        schema: 'himmelcad.view-state',
        version: 2,
        camera: fromKernelCamera(camera),
        navigationMode: navigationModeStore.snapshot(),
        hiddenEntityIds: hidden,
        sessionHiddenEntityIds: [...automationHiddenRef.current].sort(),
        selectedEntityIds: [...selectedRef.current].sort(),
        clipRefs:
          box && viewingBoxRevisionRef.current !== null
            ? [
                {
                  entityId: box.id,
                  expectedRevision: viewingBoxRevisionRef.current,
                  active: displayStore.getSnapshot().state.activeClipEntityIds.includes(box.id),
                  locked: (box.lockMode ?? 'unlocked') !== 'unlocked',
                },
              ]
            : [],
        presentation: displayStore.getSnapshot().state.presentation,
      };
    }
    currentViewStateRef.current = currentBuilderViewState;
    applyViewStateRef.current = applyBuilderViewState;
    return unregister;
  }, [displayStore, selectionStore]);

  const closeCurrentProject = useCallback(
    async (mode: 'project' | 'window', preserveRenderer = false): Promise<boolean> => {
      const api = window.himmelcad;
      const session = canonicalSessionRef.current;
      if (!api || closeMode) return false;
      if (!session) {
        if (mode === 'window') await api.window.closeReady();
        return true;
      }
      closeCancelledRef.current = false;
      setCloseMode(mode);
      setDurability((current) =>
        current
          ? { ...current, state: 'storing', pendingCount: Math.max(1, current.pendingCount) }
          : current,
      );
      try {
        for (const job of jobs) {
          if (
            (job.owner === 'builder.import' ||
              job.owner === 'builder.archive' ||
              job.owner === 'builder.ground-extraction') &&
            !['completed', 'failed', 'cancelled'].includes(job.state)
          ) {
            await api.jobs.cancel(job.id).catch(() => undefined);
          }
        }
        if (drawToolStore.snapshot().armed) await drawToolStore.cancelAll();
        constructionInputStore.disarm();
        if (activeFunctionId) closeFunction(activeFunctionId);
        await viewingBoxPersistTailRef.current;
        await selectionStore.closeProject();
        await displayStore.closeProject();
        const closed = await session.close();
        if (!closed) throw new Error('the journal flush did not complete');
        if (closeCancelledRef.current) {
          canonicalSessionRef.current = null;
          canonicalReadyRef.current = null;
          await ensureCanonicalProjectRef.current();
          return false;
        }
        canonicalSessionRef.current = null;
        canonicalReadyRef.current = null;
        setRegistrationItems([]);
        setForegroundRegistrationJobId(null);
        setBackgroundedRegistrationJobId(null);
        if (!preserveRenderer) {
          setProject(null);
          setSnapshots([]);
          setMeasurements([]);
          setViewingBox(null);
          setViewingBoxes([]);
          viewingBoxRevisionByIdRef.current.clear();
          viewingBoxRevisionRef.current = null;
          setCurrentProjectPath(null);
          currentProjectPathRef.current = null;
          setDurability(null);
          entityGroupsRef.current = { cloud: [], ifc: [], orthophoto: [], mesh: [] };
          viewportRef.current?.resetProjectScene();
        }
        if (mode === 'window') await api.window.closeReady();
        return true;
      } catch (error) {
        logEvent('error', 'renderer', `Project close failed: ${String(error)}`);
        const snapshot = session.projectSnapshot();
        await selectionStore.openProject(
          currentProjectPathRef.current ?? snapshot.projectId,
          new Set(Object.keys(snapshot.entities)),
          (entityId) => snapshot.entities[entityId]?.kind,
        );
        await displayStore.openProject(currentProjectPathRef.current ?? snapshot.projectId);
        return false;
      } finally {
        setCloseMode(null);
      }
    },
    [
      activeFunctionId,
      closeFunction,
      closeMode,
      constructionInputStore,
      displayStore,
      drawToolStore,
      jobs,
      selectionStore,
    ],
  );

  const replaceProject = useCallback(
    async (projectRoot: string): Promise<void> => {
      const previousRoot = currentProjectPathRef.current;
      setProjectReplacementFailure(null);
      const result = await replaceProjectWithRecovery(projectRoot, {
        currentRoot: previousRoot,
        closeCurrent: async () =>
          canonicalSessionRef.current ? closeCurrentProject('project', true) : true,
        prepare: async (root) => {
          durabilityRecoveryReportedRef.current = false;
          setRecoveryToast(null);
          currentProjectPathRef.current = root;
          setCurrentProjectPath(root);
          canonicalReadyRef.current = null;
          canonicalSessionRef.current = null;
          entityGroupsRef.current = { cloud: [], ifc: [], orthophoto: [], mesh: [] };
          viewportRef.current?.resetProjectScene();
        },
        openPrepared: () => ensureCanonicalProjectRef.current().then(() => undefined),
        discardFailed: async () => {
          const failed = canonicalSessionRef.current;
          if (failed) await failed.close().catch(() => false);
          canonicalSessionRef.current = null;
          canonicalReadyRef.current = null;
        },
      });
      if (result.failure) {
        setProjectReplacementFailure(result.failure);
        const recovery = result.failure.recoveredRoot
          ? ' The previous project was restored.'
          : result.failure.recoveryReason
            ? ` Recovery also failed: ${result.failure.recoveryReason}`
            : '';
        logEvent(
          'error',
          'renderer',
          `Project replacement failed: ${result.failure.reason}.${recovery}`,
        );
      }
      if (!result.activeRoot) {
        setProject(null);
        setCurrentProjectPath(null);
        currentProjectPathRef.current = null;
      }
    },
    [closeCurrentProject],
  );

  useEffect(() => {
    const api = window.himmelcad;
    if (!api) return;
    return api.canonicalProject.onCloseRequested(() => void closeCurrentProject('window'));
  }, [closeCurrentProject]);

  const ensureCanonicalProject = useCallback(async (): Promise<BuilderCanonicalProjectSession> => {
    if (canonicalSessionRef.current) return canonicalSessionRef.current;
    if (canonicalReadyRef.current) return canonicalReadyRef.current;
    const api = window.himmelcad;
    if (!api) throw new Error('Electron bridge missing — cannot open canonical project');
    const opening = (async () => {
      if (!(await api.sidecar.status())) throw new Error('sidecar offline');
      if (!startupProjectRef.current) {
        startupProjectRef.current = api.canonicalProject.startup().then((startup) => {
          setRecentProjects(startup.recent);
          if (startup.fallbackNotice) logEvent('warn', 'renderer', startup.fallbackNotice);
          return startup.projectRoot;
        });
      }
      const startupSelected = currentProjectPathRef.current === null;
      let projectRoot = currentProjectPathRef.current ?? (await startupProjectRef.current);
      let session: BuilderCanonicalProjectSession;
      try {
        session = await BuilderCanonicalProjectSession.open(projectRoot, api.sidecar.call);
      } catch (error) {
        if (!startupSelected) throw error;
        const fallback = await api.canonicalProject.defaultRoot();
        if (fallback === projectRoot) throw error;
        logEvent(
          'warn',
          'renderer',
          `Last project could not be opened; using the default project: ${String(error)}`,
        );
        projectRoot = fallback;
        session = await BuilderCanonicalProjectSession.open(projectRoot, api.sidecar.call);
      }
      canonicalSessionRef.current = session;
      currentProjectPathRef.current = projectRoot;
      setCurrentProjectPath(projectRoot);
      const snapshot = session.projectSnapshot();
      await selectionStore.openProject(
        projectRoot,
        new Set(Object.keys(snapshot.entities)),
        (entityId) => snapshot.entities[entityId]?.kind,
        Object.values(snapshot.entities)
          .filter((entity) => !entity.visibility.visible)
          .map((entity) => entity.id),
      );
      await displayStore.openProject(projectRoot);
      setProject(snapshot);
      setSnapshots(await session.listSnapshots());
      setMeasurements(await session.listMeasurements());
      const storedDrawCurves = await session.listDrawCurves();
      setDrawCurves(storedDrawCurves);
      const storedViewingBoxes = await session.listViewingBoxes();
      const activeViewingBoxId = displayStore.getSnapshot().state.activeClipEntityIds[0];
      const storedViewingBox =
        storedViewingBoxes.find((box) => box.entityId === activeViewingBoxId) ??
        storedViewingBoxes[0];
      let restoredViewingBox: KernelViewingBoxState | null = null;
      setViewingBoxes(storedViewingBoxes);
      viewingBoxRevisionByIdRef.current = new Map(
        storedViewingBoxes.map((box) => [box.entityId, box.revision]),
      );
      if (storedViewingBox) {
        const restoredBox = parseCanonicalViewingBoxState(storedViewingBox.state);
        restoredViewingBox = restoredBox;
        viewingBoxRevisionRef.current = storedViewingBox.revision;
        setViewingBoxName(storedViewingBox.name);
        setViewingBox(restoredBox);
      } else {
        viewingBoxRevisionRef.current = null;
        setViewingBoxName('Viewing Box');
        setViewingBox(null);
      }
      setRecentProjects(await api.canonicalProject.opened(projectRoot));
      logEvent('info', 'renderer', `Canonical project opened: ${projectRoot}`);
      const viewport = viewportRef.current;
      if (!viewport) throw new Error('viewer bridge is not ready for canonical residency');
      const residency = await api.canonicalProject.residencyBootstrap();
      const restored = await restoreCanonicalResidency(viewport, residency);
      if (storedDrawCurves.length > 0) {
        await viewport.loadCanonicalPackage({
          providerId: 'hcad.draw@1',
          providerVersion: '1',
          admissions: storedDrawCurves.map((curve) => curve.admission),
        });
      }
      entityGroupsRef.current.cloud = restored.clouds;
      entityGroupsRef.current.ifc = restored.inlineMeshes;
      setPointCloudMetadata(restored.pointCloudMetadata);
      if (restoredViewingBox?.lockMode === 'baked') {
        try {
          const restoredLock = await viewport.lockViewingBox(
            restoredViewingBox,
            new AbortController().signal,
            () => undefined,
          );
          viewingBoxRef.current = restoredLock;
          setViewingBox(restoredLock);
        } catch (error) {
          const recovered = { ...restoredViewingBox, lockMode: 'unlocked' as const, bakeKey: null };
          viewingBoxRef.current = recovered;
          setViewingBox(recovered);
          logEvent(
            'warn',
            'renderer',
            `Locked viewing-box cache was unavailable; editing was restored: ${String(error)}`,
          );
        }
      }
      if (restored.clouds.length > 0 || restored.inlineMeshes.length > 0) {
        logEvent(
          'info',
          'renderer',
          `Restored ${restored.clouds.length.toLocaleString()} point cloud(s) and ${restored.inlineMeshes.length.toLocaleString()} inline mesh entity/entities from the canonical store`,
        );
      }
      return session;
    })();
    canonicalReadyRef.current = opening;
    try {
      return await opening;
    } catch (error) {
      canonicalReadyRef.current = null;
      throw error;
    }
  }, [displayStore, selectionStore]);
  ensureCanonicalProjectRef.current = ensureCanonicalProject;

  const reloadCanonicalResidency = useCallback(async (): Promise<void> => {
    const session = canonicalSessionRef.current;
    const viewport = viewportRef.current;
    const api = window.himmelcad;
    if (!session || !viewport || !api) return;
    const refreshed = await session.refresh();
    pruneRemovedSelection(selectionStore, projectRef.current, refreshed);
    selectionStore.updateEntityCatalog(
      new Set(Object.keys(refreshed.entities)),
      (entityId) => refreshed.entities[entityId]?.kind,
    );
    setProject(refreshed);
    const restored = await restoreCanonicalResidency(
      viewport,
      await api.canonicalProject.residencyBootstrap(),
      new Set(viewport.residentEntityIds()),
    );
    entityGroupsRef.current.cloud = restored.clouds;
    entityGroupsRef.current.ifc = restored.inlineMeshes;
    setPointCloudMetadata(restored.pointCloudMetadata);
  }, [selectionStore]);
  const reloadCanonicalResidencyRef = useRef(reloadCanonicalResidency);
  reloadCanonicalResidencyRef.current = reloadCanonicalResidency;

  useEffect(() => {
    if (!project || selectionStore.getSnapshot().projectId === null) return;
    selectionStore.updateEntityCatalog(
      new Set(Object.keys(project.entities)),
      (entityId) => project.entities[entityId]?.kind,
    );
  }, [project, selectionStore]);

  useEffect(() => {
    logEvent('info', 'renderer', 'Builder renderer mounted');
    const api = window.himmelcad;
    if (!api) return;
    void api.sidecar.status().then((ok) => {
      logEvent(ok ? 'info' : 'warn', 'sidecar', ok ? 'sidecar ready' : 'sidecar offline');
    });
    const off = api.sidecar.onStderr((line) => {
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
        return;
      }
      // Sidecar uses tracing → stderr. Forward each line as a debug entry so
      // the user can copy it from the in-app console without leaving the app.
      const lower = line.toLowerCase();
      const level = lower.includes('error') ? 'error' : lower.includes('warn') ? 'warn' : 'debug';
      logEvent(level, 'sidecar', line);
    });
    return off;
  }, []);

  useEffect(() => {
    void ensureCanonicalProject().catch((error: unknown) => {
      logEvent('error', 'renderer', `Canonical project failed to open: ${String(error)}`);
    });
  }, [ensureCanonicalProject]);

  const flushProject = useCallback(async (): Promise<void> => {
    try {
      setDurability((current) => ({
        state: 'storing',
        visibleGeneration: current?.visibleGeneration ?? 0,
        durableGeneration: current?.durableGeneration ?? 0,
        acknowledgedAtMs: current?.acknowledgedAtMs ?? 0,
        pendingCount: current?.pendingCount ?? 1,
        reason: null,
        recoveredTailCount: current?.recoveredTailCount ?? 0,
      }));
      const status = await (await ensureCanonicalProject()).flushAndSnapshot();
      setDurability(status);
      const session = canonicalSessionRef.current;
      if (session) setSnapshots(await session.listSnapshots());
      setDurabilityFailureToast(false);
      logEvent(
        'info',
        'renderer',
        `All changes stored · ${new Date(status.acknowledgedAtMs).toLocaleTimeString()}`,
      );
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      setDurability((current) => ({
        state: 'failed',
        visibleGeneration: current?.visibleGeneration ?? 0,
        durableGeneration: current?.durableGeneration ?? 0,
        acknowledgedAtMs: current?.acknowledgedAtMs ?? 0,
        pendingCount: current?.pendingCount ?? 1,
        reason,
        recoveredTailCount: current?.recoveredTailCount ?? 0,
      }));
      setDurabilityFailureToast(true);
      logEvent('error', 'renderer', `Changes are not stored: ${reason}`);
    }
  }, [ensureCanonicalProject]);

  useEffect(() => {
    return startDurabilityPolling(
      async () => {
        const session = canonicalSessionRef.current;
        if (!session) throw new Error('canonical project is opening');
        return session.durabilityStatus();
      },
      (status) => {
        setDurability(status);
        if (status.state === 'failed') setDurabilityFailureToast(true);
        if (status.recoveredTailCount > 0 && !durabilityRecoveryReportedRef.current) {
          durabilityRecoveryReportedRef.current = true;
          const recoveredMessage = `Recovered ${status.recoveredTailCount} unsaved changes from ${new Date(
            status.acknowledgedAtMs,
          ).toLocaleTimeString()}`;
          setRecoveryToast(recoveredMessage);
          logEvent('warn', 'renderer', recoveredMessage);
        }
      },
      () => undefined,
      25,
    );
  }, [project?.projectId]);

  useEffect(() => {
    let syncing = false;
    let reportedError = false;
    const timer = window.setInterval(() => {
      if (syncing) return;
      const session = canonicalSessionRef.current;
      if (!session) return;
      syncing = true;
      void session
        .catchUp()
        .then(async (nextProject) => {
          if (nextProject) {
            pruneRemovedSelection(selectionStore, projectRef.current, nextProject);
            setProject(nextProject);
            setMeasurements(await session.listMeasurements());
          }
          reportedError = false;
        })
        .catch((error: unknown) => {
          if (!reportedError) {
            logEvent('warn', 'renderer', `Canonical journal sync paused: ${String(error)}`);
            reportedError = true;
          }
        })
        .finally(() => {
          syncing = false;
        });
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [selectionStore]);

  useEffect(() => {
    if (initialImportStartedRef.current) return;
    initialImportStartedRef.current = true;
    const api = window.himmelcad;
    if (!api) return;
    void ensureCanonicalProject()
      .then(async () => {
        const prepared = await api.dev.initialPreparedPointCloud();
        if (prepared) {
          logEvent(
            'warn',
            'renderer',
            `Ignoring legacy prepared development dataset ${prepared.datasetId}: it has no committed canonical admission; set HCAD_DEV_POINT_CLOUD to import the source instead`,
          );
        }
        const paths = await api.dev.initialPointCloudPaths();
        if (paths.length === 0) return;
        logEvent('info', 'renderer', `Loading development point cloud: ${paths[0] ?? ''}`);
        const items = await registerImportJobs(api, paths);
        setRegistrationItems((current) => [...current, ...items]);
      })
      .catch((error: unknown) => {
        logEvent('error', 'renderer', `Development point-cloud import failed: ${String(error)}`);
      });
  }, [ensureCanonicalProject]);

  useEffect(() => {
    if (initialMixedSceneStartedRef.current) return;
    initialMixedSceneStartedRef.current = true;
    const api = window.himmelcad;
    if (!api) return;
    void ensureCanonicalProject()
      .then(async () => {
        const scene = await api.dev.initialMixedScene();
        if (!scene) return;
        const developmentIfcPath = scene.ifcPath;
        if (developmentIfcPath) {
          logEvent(
            'info',
            'renderer',
            `Development IFC awaits registration: ${developmentIfcPath}`,
          );
          const items = await registerImportJobs(api, [developmentIfcPath]);
          setRegistrationItems((current) => [...current, ...items]);
        }
        if (scene.orthophoto) {
          const [a, d, b, e, c, f] = scene.orthophoto.worldFile;
          if ([a, d, b, e, c, f].some((value) => value == null || !Number.isFinite(value))) {
            throw new Error('development orthophoto world file is invalid');
          }
          const entityId = 'alte-akademie-orthophoto' as EntityId;
          await viewportRef.current?.loadRasterImage(scene.orthophoto.url, {
            entityId,
            sourceName: 'Alte Akademie · Orthomosaic 20 cm',
            origin: [c!, f!, 482.75],
            columnStep: [a!, d!, 0],
            rowStep: [b!, e!, 0],
            rasterSize: [scene.orthophoto.width, scene.orthophoto.height],
            tiles: scene.orthophoto.tiles.map((tile) => ({
              ...tile,
              depthUrl: tile.demUrl,
            })),
          });
          entityGroupsRef.current.orthophoto = [entityId];
          logEvent(
            'info',
            'renderer',
            'Georeferenced orthomosaic loaded as a development-only viewer preview',
          );
          if (scene.demUrl) {
            const meshEntityId = 'alte-akademie-textured-terrain' as EntityId;
            await viewportRef.current?.loadDrapedRaster(scene.orthophoto.url, scene.demUrl, {
              entityId: meshEntityId,
              sourceName: 'Alte Akademie · Orthophoto textured terrain',
              origin: [c!, f!, 0],
              columnStep: [a!, d!, 0],
              rowStep: [b!, e!, 0],
              rasterSize: [scene.orthophoto.width, scene.orthophoto.height],
              tiles: scene.orthophoto.tiles.map((tile) => ({
                ...tile,
                depthUrl: tile.demUrl,
              })),
            });
            entityGroupsRef.current.mesh = [meshEntityId];
            logEvent(
              'info',
              'renderer',
              'Textured terrain loaded as a development-only viewer preview · DEM sampled from dense reconstruction',
            );
          }
        }
        viewportRef.current?.frameAll();
      })
      .catch((error: unknown) => {
        logEvent('error', 'renderer', `Mixed development scene failed: ${String(error)}`);
      });
  }, [ensureCanonicalProject]);

  // Hook ribbon actions to real handlers.
  useEffect(() => {
    if (!activeFunctionId) return;
    const id = activeFunctionId;
    const drawKind = drawKindForFunction(id);
    const measurementKind = measurementKindForFunction(id);
    if (drawKind) {
      if (!drawToolStore.snapshot().armed || drawToolStore.snapshot().kind !== drawKind) {
        drawToolStore.arm(drawKind, drawKind === 'boundary' ? 'boundary' : 'plain');
      }
      setRightPanelTab('function');
      logEvent('info', 'renderer', `${drawKindLabel(drawKind)}: pick or type the first vertex.`);
    } else if (measurementKind) {
      const metric = measurementKind === 'distance' ? 'spatial' : null;
      if (
        !measurementToolStore.snapshot().armed ||
        measurementToolStore.snapshot().kind !== measurementKind
      ) {
        measurementToolStore.arm(measurementKind, metric);
      }
      logEvent(
        'info',
        'renderer',
        `${measurementKindLabel(measurementKind)}: pick or type an exact anchor.`,
      );
    } else if (id === 'file.import') {
      void (async () => {
        try {
          const api = window.himmelcad;
          if (!api) {
            logEvent('warn', 'renderer', 'no electron bridge: skipping import dialog');
            return;
          }
          const session = await ensureCanonicalProject();
          const formats = await session.listIoFormats();
          const extensions = registeredImportExtensions(formats);
          const paths = await api.dialog.openImport(extensions);
          if (paths.length > 0) {
            const items = await registerImportJobs(api, paths);
            setRegistrationItems((current) => [...current, ...items]);
          }
        } catch (error: unknown) {
          logEvent('error', 'renderer', `Import selection failed: ${String(error)}`);
        } finally {
          closeFunction(id);
        }
      })();
    } else if (id === 'view.frame') {
      viewportRef.current?.frameAll();
      closeFunction(id);
    } else if (id === 'view.3d' || id === 'view.2.5d' || id === 'view.2d') {
      const mode = id.slice('view.'.length) as '3d' | '2.5d' | '2d';
      void viewportRef.current?.setViewMode(mode);
      closeFunction(id);
    } else if (
      id === 'view.hud.toggle' ||
      id.startsWith('view.preset.') ||
      id === 'view.camera.undo' ||
      id === 'view.camera.redo' ||
      id === 'view.display.undo' ||
      id === 'view.display.redo' ||
      id === 'view.bookmark.create' ||
      id === 'view.bookmark.restore'
    ) {
      void Promise.resolve(
        executeRegistryCommandRef.current({ id, args: [], source: 'ribbon' } as CommandInvocation),
      )
        .catch((error: unknown) => logEvent('warn', 'renderer', String(error)))
        .finally(() => closeFunction(id));
    } else if (id === 'view.viewing-box' && !viewingBox) {
      pendingViewingBoxIdRef.current = `viewing-box-${crypto.randomUUID()}`;
      setPlacingViewingBoxCenter(true);
      logEvent('info', 'renderer', 'Viewing Box: click the model to place the box.');
    } else if (id === 'pointcloud.fence.begin') {
      setRightPanelTab('function');
      setSegmentError(null);
      logEvent('info', 'renderer', 'Segment: draw a rectangle or polygon fence in the viewport.');
    } else if (id === 'output.specs') {
      setSpecsOpen(true);
      closeFunction(id);
    } else if (id === 'output.plan') {
      setPlanOpen(true);
      closeFunction(id);
    } else if (id === 'mesh.surface.create') {
      void ensureCanonicalProject().then(() => setDgmOpen(true));
      closeFunction(id);
    } else if (id === 'mesh.edit.smooth') {
      const surfaceIds = [...selected].filter((entityId) => {
        const kind = projectRef.current?.entities[entityId]?.kind;
        return kind === 'Surface' || kind === 'DigitalElevationModel';
      });
      if (surfaceIds.length === 1 && selected.size === 1) {
        setSurfaceEditTargetId(surfaceIds[0]!);
        setSurfaceEditPreview(null);
        setRightPanelTab('function');
        setSegmentFence((current) => ({ ...EMPTY_SEGMENT_FENCE, kind: current.kind }));
      } else {
        logEvent('warn', 'renderer', 'Edit surface requires one selected DGM.');
        closeFunction(id);
      }
    } else if (id === 'automation.agent') {
      setAgentOpen(true);
      closeFunction(id);
    } else if (id === 'project.flush' || id === 'project.save') {
      void flushProject().finally(() => closeFunction(id));
    }
    // Other ribbon actions only highlight + show their function panel for now.
  }, [
    activeFunctionId,
    closeFunction,
    ensureCanonicalProject,
    flushProject,
    drawToolStore,
    measurementToolStore,
    selected,
    viewingBox,
  ]);

  useEffect(() => {
    if (activeFunctionId !== 'view.viewing-box') setPlacingViewingBoxCenter(false);
  }, [activeFunctionId]);

  useEffect(() => {
    if (
      activeFunctionId === 'pointcloud.fence.begin' ||
      (activeFunctionId === 'mesh.edit.smooth' && surfaceEditRegionSource === 'fence')
    )
      return;
    setSegmentFence((current) =>
      current.vertices.length === 0 && !current.closed
        ? current
        : { ...EMPTY_SEGMENT_FENCE, kind: current.kind },
    );
  }, [activeFunctionId, surfaceEditRegionSource]);

  useEffect(() => {
    if (!measurementKindForFunction(activeFunctionId) && measurementToolStore.snapshot().armed) {
      measurementToolStore.cancel();
    }
  }, [activeFunctionId, measurementToolStore]);

  useEffect(() => {
    if (!drawKindForFunction(activeFunctionId) && drawToolStore.snapshot().armed) {
      drawToolStore.cancel();
    }
  }, [activeFunctionId, drawToolStore]);

  useEffect(() => {
    if (drawTool.armed && drawTool.kind) {
      const firstPoint = drawTool.vertices.at(-1)?.point;
      const seed =
        snap?.position.z == null
          ? (firstPoint ?? { x: 0, y: 0, z: 0 })
          : { x: snap.position.x, y: snap.position.y, z: snap.position.z };
      const toolId = `draw:${drawTool.kind}:${drawTool.vertices.length}:${constructionClaimGeneration}`;
      if (constructionInputStore.snapshot().declaration?.toolId !== toolId) {
        constructionInputStore.arm(
          {
            toolId,
            prompt:
              drawTool.vertices.length === 0
                ? `${drawKindLabel(drawTool.kind)} — pick or type first vertex`
                : `${drawKindLabel(drawTool.kind)} — pick, constrain, or type next vertex`,
            fields: firstPoint
              ? ['direction', 'distance', 'deltaZ', 'slope', 'x', 'y', 'z']
              : ['x', 'y', 'z'],
            ...(firstPoint ? { firstPoint } : {}),
          },
          seed,
        );
      }
      return;
    }
    if (measurementTool.armed && measurementTool.kind) {
      const first = measurementTool.anchors[0];
      const firstPoint = first ? measurementAnchorConstructionPoint(first) : undefined;
      const seed =
        snap?.position.z == null
          ? (firstPoint ?? { x: 0, y: 0, z: 0 })
          : { x: snap.position.x, y: snap.position.y, z: snap.position.z };
      const toolId = `measurement:${measurementTool.kind}:${measurementTool.anchors.length}`;
      if (constructionInputStore.snapshot().declaration?.toolId !== toolId) {
        constructionInputStore.arm(
          {
            toolId,
            prompt:
              measurementTool.anchors.length === 0
                ? 'Measurement — pick or type start point'
                : 'Measurement — pick or type next point',
            fields: ['x', 'y', 'z'],
            ...(firstPoint ? { firstPoint } : {}),
          },
          seed,
        );
      }
      return;
    }
    if (placingViewingBoxCenter) {
      if (constructionInputStore.snapshot().armed) return;
      const seed = viewingBox?.center ?? { x: 0, y: 0, z: 0 };
      constructionInputStore.arm(
        {
          toolId: 'view.viewing-box.place',
          prompt: 'Viewing box center — pick or type coordinates',
          fields: ['x', 'y', 'z'],
        },
        seed,
      );
      return;
    }
    if (
      activeFunctionId === 'pointcloud.fence.begin' &&
      segmentFence.kind === 'rectangle' &&
      segmentFence.vertices.length === 1 &&
      !segmentFence.closed
    ) {
      const anchor = segmentFence.vertices[0]!;
      const toolId = 'pointcloud.fence.rectangle.extents';
      if (constructionInputStore.snapshot().declaration?.toolId !== toolId) {
        constructionInputStore.arm(
          {
            toolId,
            prompt: 'Rectangle fence — type Width and Height',
            fields: ['x', 'y'],
            fieldLabels: { x: 'Width', y: 'Height' },
          },
          { x: 0, y: 0, z: anchor.z },
        );
      }
      return;
    }
    constructionInputStore.disarm();
  }, [
    activeFunctionId,
    constructionInputStore,
    constructionClaimGeneration,
    drawTool.armed,
    drawTool.kind,
    drawTool.vertices,
    measurementTool.anchors,
    measurementTool.anchors.length,
    measurementTool.armed,
    measurementTool.kind,
    placingViewingBoxCenter,
    segmentFence.closed,
    segmentFence.kind,
    segmentFence.vertices,
    snap?.position.x,
    snap?.position.y,
    snap?.position.z,
    viewingBox?.center,
  ]);

  useEffect(() => {
    viewportRef.current?.setViewingBox(
      viewingBox && display.state.activeClipEntityIds.includes(viewingBox.id) ? viewingBox : null,
    );
  }, [display.state.activeClipEntityIds, viewingBox]);

  const commitCanonicalViewingBox = useCallback(
    (next: KernelViewingBoxState | null): void => {
      if (next) assertViewingBox(next);
      setViewingBox(next);
      if (!next) return;
      const committedName = viewingBoxNameRef.current;
      displayStore.setActiveClipEntityIds([next.id]);
      const session = canonicalSessionRef.current;
      const projectPath = currentProjectPathRef.current;
      if (!session || !projectPath) return;
      viewingBoxPersistTailRef.current = viewingBoxPersistTailRef.current
        .then(async () => {
          if (
            canonicalSessionRef.current !== session ||
            currentProjectPathRef.current !== projectPath
          ) {
            throw new Error('Viewing-box commit cancelled because the project changed.');
          }
          const committed = await session.putViewingBox(
            next.id,
            viewingBoxRevisionByIdRef.current.get(next.id) ?? null,
            committedName,
            next,
          );
          if (canonicalSessionRef.current !== session) return;
          viewingBoxRevisionRef.current = committed.revision;
          viewingBoxRevisionByIdRef.current.set(next.id, committed.revision);
          setViewingBoxes((current) => [
            ...current.filter((box) => box.entityId !== committed.entityId),
            committed,
          ]);
          setProject(session.projectSnapshot());
        })
        .catch((error: unknown) =>
          logEvent('error', 'renderer', `Viewing Box was not stored: ${String(error)}`),
        );
    },
    [displayStore],
  );

  const selectViewingBox = useCallback(
    (entityId: string): void => {
      const summary = viewingBoxes.find((box) => box.entityId === entityId);
      if (!summary) return;
      const current = viewingBoxRef.current;
      if (current && current.id !== entityId && (current.lockMode ?? 'unlocked') !== 'unlocked') {
        viewportRef.current?.unlockViewingBox(current);
      }
      const state = parseCanonicalViewingBoxState(summary.state);
      viewingBoxRevisionRef.current = summary.revision;
      viewingBoxRef.current = state;
      viewingBoxNameRef.current = summary.name;
      setViewingBoxName(summary.name);
      setViewingBox(state);
      displayStore.setActiveClipEntityIds([state.id]);
      if ((state.lockMode ?? 'unlocked') !== 'unlocked') {
        void debugViewingBoxLockRef.current(true);
      }
    },
    [displayStore, viewingBoxes],
  );

  const createViewingBoxFromSelection = useCallback((): void => {
    const id = `viewing-box-${crypto.randomUUID()}`;
    const canonical = canonicalSelectionBounds(selected, drawCurves, measurements);
    if (canonical.hasUnknownHeight) {
      logEvent(
        'warn',
        'renderer',
        'The current selection contains canonical geometry without a known height.',
      );
      return;
    }
    const created = viewportRef.current?.createViewingBoxFromSelection(
      [...selected],
      id,
      canonical.bounds,
    );
    if (!created) {
      logEvent('warn', 'renderer', 'The current selection has no canonical or resident bounds.');
      return;
    }
    const name = `Viewing Box ${viewingBoxes.length + 1}`;
    viewingBoxNameRef.current = name;
    setViewingBoxName(name);
    commitCanonicalViewingBox(created);
  }, [commitCanonicalViewingBox, drawCurves, measurements, selected, viewingBoxes.length]);

  const createViewingBoxFromTypedExtents = useCallback(
    (
      center: { readonly x: number; readonly y: number; readonly z: number },
      size: { readonly x: number; readonly y: number; readonly z: number },
    ): void => {
      const id = `viewing-box-${crypto.randomUUID()}`;
      const seeded = viewportRef.current?.createViewingBoxAt(center, id);
      if (!seeded) return;
      const created: KernelViewingBoxState = {
        ...seeded,
        center,
        halfExtents: {
          x: Math.max(1e-6, size.x * 0.5),
          y: Math.max(1e-6, size.y * 0.5),
          z: Math.max(1e-6, size.z * 0.5),
        },
      };
      const name = `Viewing Box ${viewingBoxes.length + 1}`;
      viewingBoxNameRef.current = name;
      setViewingBoxName(name);
      commitCanonicalViewingBox(created);
    },
    [commitCanonicalViewingBox, viewingBoxes.length],
  );

  const createViewingBoxFromViewportDrag = useCallback(
    (preview: KernelViewingBoxState): void => {
      const id = pendingViewingBoxIdRef.current ?? `viewing-box-${crypto.randomUUID()}`;
      pendingViewingBoxIdRef.current = null;
      const name = `Viewing Box ${viewingBoxes.length + 1}`;
      viewingBoxNameRef.current = name;
      setViewingBoxName(name);
      setPlacingViewingBoxCenter(false);
      commitCanonicalViewingBox({ ...preview, id });
    },
    [commitCanonicalViewingBox, viewingBoxes.length],
  );

  const renameViewingBox = useCallback(
    (name: string): void => {
      const trimmed = name.trim();
      const box = viewingBoxRef.current;
      if (!box || !trimmed) return;
      if (trimmed === viewingBoxNameRef.current) return;
      viewingBoxNameRef.current = trimmed;
      setViewingBoxName(trimmed);
      commitCanonicalViewingBox(box);
    },
    [commitCanonicalViewingBox],
  );

  const setViewingBoxLocked = useCallback(
    async (locked: boolean, rebuilding = false): Promise<void> => {
      const state = viewingBoxRef.current;
      const viewport = viewportRef.current;
      const api = window.himmelcad;
      if (!state || !viewport || !api) return;
      if (!locked && viewingBoxBakeAbortRef.current) {
        const controller = viewingBoxBakeAbortRef.current;
        const jobId = viewingBoxBakeJobIdRef.current;
        // Cancellation is an interactive boundary: acknowledge it immediately
        // before AbortSignal's synchronous listeners begin renderer cleanup.
        // The live abort ref remains set until the bake's `finally`, so
        // another lock cannot overlap that serialized cleanup.
        flushSync(() => setViewingBoxBakeProgress(null));
        controller.abort();
        if (jobId) void api.jobs.cancel(jobId);
        return;
      }
      if (viewingBoxBakeAbortRef.current) return;
      if (!locked) {
        commitCanonicalViewingBox(viewport.unlockViewingBox(state));
        return;
      }
      const controller = new AbortController();
      const jobId = `viewing-box-bake-${crypto.randomUUID()}`;
      const initialPhase = rebuilding ? 'Rebuilding locked box' : 'Preparing resident dataset';
      viewingBoxBakeAbortRef.current = controller;
      viewingBoxBakeJobIdRef.current = jobId;
      setViewingBoxBakeProgress({ fraction: 0, phase: initialPhase });
      await api.jobs.register({
        id: jobId,
        label: `${rebuilding ? 'Rebuild' : 'Lock'} ${viewingBoxNameRef.current}`,
        owner: 'builder.viewing-box-bake',
        phase: initialPhase,
        expectedDurationMs: 2_000,
        progressKey: jobId,
        cancellable: true,
        context: { viewingBoxId: state.id },
      });
      try {
        const next = await viewport.lockViewingBox(
          state,
          controller.signal,
          async (fraction, phase) => {
            setViewingBoxBakeProgress({ fraction, phase });
            await api.jobs.update(jobId, { fraction, phase });
          },
        );
        if (controller.signal.aborted)
          throw new DOMException('Viewing-box bake cancelled.', 'AbortError');
        commitCanonicalViewingBox(next);
        lockedViewingBoxSourceRevisionKeyRef.current = viewingBoxSourceRevisionKey;
        await api.jobs.complete(
          jobId,
          next.lockMode === 'baked' ? 'Prepared dataset locked' : 'Edit-frozen copy scope',
        );
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          await api.jobs.cancelled(jobId);
        } else {
          await api.jobs.fail(jobId, String(error));
        }
      } finally {
        viewingBoxBakeAbortRef.current = null;
        viewingBoxBakeJobIdRef.current = null;
        setViewingBoxBakeProgress(null);
      }
    },
    [commitCanonicalViewingBox, viewingBoxSourceRevisionKey],
  );
  debugViewingBoxLockRef.current = setViewingBoxLocked;

  useEffect(() => {
    if ((viewingBox?.lockMode ?? 'unlocked') !== 'baked') {
      lockedViewingBoxSourceRevisionKeyRef.current = null;
      return;
    }
    const previous = lockedViewingBoxSourceRevisionKeyRef.current;
    if (previous === null) {
      lockedViewingBoxSourceRevisionKeyRef.current = viewingBoxSourceRevisionKey;
      return;
    }
    if (previous === viewingBoxSourceRevisionKey || viewingBoxBakeProgress !== null) return;
    // Coalesce settled project snapshots. If another source revision lands
    // during this rebuild, the next progress transition schedules one more
    // rebuild against the newest exact entity versions.
    lockedViewingBoxSourceRevisionKeyRef.current = viewingBoxSourceRevisionKey;
    void setViewingBoxLocked(true, true);
  }, [
    setViewingBoxLocked,
    viewingBox?.lockMode,
    viewingBoxBakeProgress,
    viewingBoxSourceRevisionKey,
  ]);

  const deleteViewingBox = useCallback(async (): Promise<void> => {
    const state = viewingBoxRef.current;
    const session = canonicalSessionRef.current;
    if (!state || !session) return;
    if ((state.lockMode ?? 'unlocked') !== 'unlocked') viewportRef.current?.unlockViewingBox(state);
    await viewingBoxPersistTailRef.current;
    const revision = viewingBoxRevisionByIdRef.current.get(state.id);
    if (revision === undefined) return;
    await session.deleteViewingBox(state.id, revision);
    selectionStore.pruneDeleted([state.id]);
    viewingBoxRevisionByIdRef.current.delete(state.id);
    const remaining = viewingBoxes.filter((box) => box.entityId !== state.id);
    setViewingBoxes(remaining);
    const replacement = remaining[0];
    if (replacement) {
      const next = parseCanonicalViewingBoxState(replacement.state);
      viewingBoxRevisionRef.current = replacement.revision;
      setViewingBoxName(replacement.name);
      setViewingBox(next);
      displayStore.setActiveClipEntityIds([next.id]);
    } else {
      viewingBoxRevisionRef.current = null;
      setViewingBox(null);
      displayStore.setActiveClipEntityIds([]);
    }
    setProject(session.projectSnapshot());
  }, [displayStore, selectionStore, viewingBoxes]);

  useEffect(() => {
    const current = projectRef.current;
    const viewport = viewportRef.current;
    if (!current || !viewport || display.projectId !== currentProjectPathRef.current) return;
    const entities = Object.values(current.entities).filter(
      (entity) => entity.id !== current.rootEntity,
    );
    const effective = interactionResolver(current, display.state);
    for (const entity of entities) {
      const visible = effective.effective(entity.id).renderable;
      viewport.setEntityVisibility([entity.id], visible);
      selectionStore.entitiesHidden([entity.id], !visible);
    }
    setPointSize(display.state.presentation.pointSizeMultiplier);
    setProject((previous) => {
      if (!previous) return previous;
      const next = { ...previous.entities };
      for (const entity of Object.values(previous.entities)) {
        if (entity.id === previous.rootEntity) continue;
        const state = effective.effective(entity.id).effective;
        next[entity.id] = {
          ...entity,
          visibility: {
            visible: state !== 'hidden',
            locked: state !== 'editable',
          },
        };
      }
      return { ...previous, entities: next };
    });
  }, [display, displayStore, selectionStore]);

  useEffect(() => {
    let active = true;
    if (selectedEntityKey.length === 0) {
      setPropertyQuery(null);
      setPropertyQueryError(null);
      setPropertyQueryLoading(false);
      return () => {
        active = false;
      };
    }
    const selectedEntityIds = selectedEntityKey.split('\u0000');
    const session = canonicalSessionRef.current;
    if (!session) return undefined;
    setPropertyQueryLoading(true);
    setPropertyQueryError(null);
    void Promise.all([
      session.queryProperties(selectedEntityIds),
      session.productProvenance(selectedEntityIds),
    ]).then(
      ([result, provenance]) => {
        if (!active) return;
        setPropertyQuery(result);
        setProductProvenance(provenance);
        setPropertyQueryLoading(false);
      },
      (error: unknown) => {
        if (!active) return;
        setPropertyQuery(null);
        setProductProvenance([]);
        setPropertyQueryError(error instanceof Error ? error.message : String(error));
        setPropertyQueryLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [project, propertyRefresh, selectedEntityKey]);

  useEffect(() => {
    let active = true;
    const session = canonicalSessionRef.current;
    const entityIds = Object.keys(project?.entities ?? {});
    if (!session || entityIds.length === 0) {
      setTreeProductProvenance([]);
      return undefined;
    }
    void Promise.all(
      Array.from({ length: Math.ceil(entityIds.length / 200) }, (_, index) =>
        session.productProvenance(entityIds.slice(index * 200, (index + 1) * 200)),
      ),
    ).then(
      (pages) => {
        if (active) setTreeProductProvenance(pages.flat());
      },
      () => {
        if (active) setTreeProductProvenance([]);
      },
    );
    return () => {
      active = false;
    };
  }, [project, propertyRefresh]);

  const assignSelectionProperty = useCallback(
    async (assignment: PropertyAssignment): Promise<void> => {
      const session = canonicalSessionRef.current;
      if (!session || !propertyQuery || propertyEditing) return;
      setPropertyEditing(true);
      setPropertyQueryError(null);
      try {
        setProject(await session.assignProperty(propertyQuery, assignment));
        setPropertyRefresh((revision) => revision + 1);
        logEvent(
          'info',
          'renderer',
          `Updated ${assignment.propertyId.name} on ${propertyQuery.entities.length.toLocaleString()} entity/entities in one canonical transaction`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setPropertyQueryError(message);
        logEvent('error', 'renderer', `Property edit failed: ${message}`);
      } finally {
        setPropertyEditing(false);
      }
    },
    [propertyEditing, propertyQuery],
  );

  const selectedPointClouds = [...selected].flatMap((entityId) => {
    const metadata = pointCloudMetadata.get(entityId);
    return metadata ? [{ entityId, metadata }] : [];
  });
  const selectedGroundCloud =
    selectedPointClouds.length === 1 &&
    selected.size === 1 &&
    project?.entities[selectedPointClouds[0]!.entityId]?.visibility.visible
      ? selectedPointClouds[0]
      : null;
  const segmentablePointClouds = selectedPointClouds.filter(({ entityId }) => {
    const effective = interactionState?.effective(entityId);
    return effective?.renderable === true && effective.editable;
  });
  const dgmCandidates = useMemo<readonly DgmSourceCandidate[]>(() => {
    if (!project) return [];
    const candidates: DgmSourceCandidate[] = [];
    for (const entityId of selected) {
      const entity = project.entities[entityId];
      if (!entity) continue;
      const cloud = pointCloudMetadata.get(entityId);
      if (entity.kind === 'PointCloud') {
        const visibleClasses = cloud?.display.classes
          .filter((classification) => classification.visible)
          .map((classification) => classification.code);
        if (cloud && visibleClasses?.length === 0) continue;
        candidates.push({
          entityId,
          name: entity.name,
          kind: 'PointCloud',
          count: cloud?.pointCount ?? null,
          role: 'points',
          ...(visibleClasses ? { visibleClasses } : {}),
        });
      } else if (entity.kind === 'SinglePoint') {
        candidates.push({
          entityId,
          name: entity.name,
          kind: 'SinglePoint',
          count: 1,
          role: 'points',
        });
      } else if (entity.kind === 'Polyline3D') {
        const curve = drawCurves.find((item) => item.entityId === entityId);
        const role =
          curve?.role === 'boundary'
            ? 'outer_boundary'
            : curve?.role === 'breakline'
              ? 'breakline'
              : 'form_line';
        candidates.push({
          entityId,
          name: entity.name,
          kind: 'Polyline3D',
          count: curve?.vertices.length ?? null,
          role,
        });
      } else if (entity.kind === 'Surface' || entity.kind === 'DigitalElevationModel') {
        candidates.push({
          entityId,
          name: entity.name,
          kind: 'Surface',
          count: null,
          role: 'points',
        });
      }
    }
    return candidates;
  }, [drawCurves, pointCloudMetadata, project, selected]);
  const surfaceBoundaryCandidates = useMemo<readonly SurfaceBoundaryCandidate[]>(
    () =>
      drawCurves
        .filter((curve) => curve.closed && curve.role === 'boundary' && curve.vertices.length >= 3)
        .map((curve) => ({
          entityId: curve.entityId,
          name: curve.name,
          polygon: curve.vertices.map((point) => [point.x, point.y] as const),
          worldPolygon: curve.vertices.every((point) => point.z !== null)
            ? curve.vertices.map((point) => [point.x, point.y, point.z!] as const)
            : null,
        })),
    [drawCurves],
  );
  const surfaceEditTarget = useMemo(() => {
    if (!surfaceEditTargetId || !project) return null;
    const entity = project.entities[surfaceEditTargetId as EntityId];
    return entity ? { entityId: entity.id, name: entity.name } : null;
  }, [project, surfaceEditTargetId]);
  const activeGroundJob =
    jobs.find(
      (job) =>
        job.owner === 'builder.ground-extraction' &&
        !['completed', 'failed', 'cancelled'].includes(job.state),
    ) ?? null;
  const activeSegmentJob =
    jobs.find(
      (job) =>
        job.owner === 'builder.pointcloud-segment' &&
        !['completed', 'failed', 'cancelled'].includes(job.state),
    ) ?? null;
  const captureSegmentTargets = useCallback(
    (
      requestedIds?: readonly string[],
    ): {
      readonly entityIds: readonly EntityId[];
      readonly scopes: ReadonlyMap<string, GroundExtractionScope>;
    } => {
      const current = projectRef.current;
      const ids = requestedIds
        ? requestedIds.map((id) => id as EntityId)
        : [...selectedRef.current];
      const capturedBox = viewingBoxRef.current;
      const activeBox =
        capturedBox?.enabled &&
        displayStore.getSnapshot().state.activeClipEntityIds.includes(capturedBox.id)
          ? capturedBox
          : null;
      const entityIds: EntityId[] = [];
      const scopes = new Map<string, GroundExtractionScope>();
      for (const entityId of ids) {
        const entity = current?.entities[entityId];
        const metadata = pointCloudMetadata.get(entityId);
        const effective = interactionState?.effective(entityId);
        if (
          entity?.kind !== 'PointCloud' ||
          !metadata ||
          effective?.renderable !== true ||
          !effective.editable
        ) {
          continue;
        }
        const visibleClasses = metadata.display.classes
          .filter((classification) => classification.visible)
          .map((classification) => classification.code);
        if (visibleClasses.length === 0) continue;
        entityIds.push(entityId);
        scopes.set(entityId, {
          visibleClasses,
          viewingBox: activeBox
            ? {
                center: [activeBox.center.x, activeBox.center.y, activeBox.center.z],
                halfExtents: [
                  activeBox.halfExtents.x,
                  activeBox.halfExtents.y,
                  activeBox.halfExtents.z,
                ],
                rotation: activeBox.rotation,
                keepInside: (activeBox.operation ?? 'keepInside') === 'keepInside',
              }
            : null,
        });
      }
      if (entityIds.length === 0) {
        throw new Error('Select one or more editable, visible point clouds with a visible class.');
      }
      return { entityIds, scopes };
    },
    [displayStore, interactionState, pointCloudMetadata],
  );
  const closeSegmentFence = useCallback(
    (volume?: KernelFenceVolume, requestedIds?: readonly string[]): SegmentFenceState | null => {
      try {
        const current = segmentFenceRef.current;
        const camera = viewportRef.current?.worldCamera();
        const nextVolume =
          volume ??
          (camera && current.vertices.length >= 3
            ? fenceVolumeFromCamera(camera, current.vertices)
            : null);
        if (!nextVolume) throw new Error('A fence needs at least three vertices.');
        assertFenceVolume(nextVolume);
        const targets = captureSegmentTargets(requestedIds);
        const volumeVertices = fenceVolumeVertices(nextVolume);
        const next: SegmentFenceState = {
          ...current,
          vertices: current.vertices.length >= 3 ? current.vertices : volumeVertices,
          closed: true,
          volume: nextVolume,
          entityIds: targets.entityIds,
          scopes: targets.scopes,
        };
        setSegmentFence(next);
        constructionInputStore.disarm();
        setSegmentError(null);
        logEvent(
          'info',
          'renderer',
          `Fence closed · ${current.vertices.length >= 3 ? current.vertices.length : volumeVertices.length} vertices · ${targets.entityIds.length} cloud${targets.entityIds.length === 1 ? '' : 's'} captured`,
        );
        return next;
      } catch (error) {
        setSegmentError(error instanceof Error ? error.message : String(error));
        return null;
      }
    },
    [captureSegmentTargets, constructionInputStore],
  );
  const runSegmentation = useCallback(
    async (
      side: 'keep_inside' | 'remove_inside',
      override?: SegmentFenceState,
      requestedOperationId?: string,
    ): Promise<PointCloudSegmentResult | undefined> => {
      const api = window.himmelcad;
      const captured = override ?? segmentFenceRef.current;
      if (!api || !captured.closed || !captured.volume || captured.entityIds.length === 0) {
        setSegmentError('Close a fence around one or more editable, visible point clouds first.');
        return;
      }
      const operationId = requestedOperationId ?? `segment-${crypto.randomUUID()}`;
      setSegmentError(null);
      let registered = false;
      try {
        const overlapping = jobs.filter(
          (job) =>
            job.owner === 'builder.pointcloud-segment' &&
            !['completed', 'failed', 'cancelled'].includes(job.state) &&
            captured.entityIds.some((id) =>
              typeof job.context?.sourceEntityIds === 'string'
                ? job.context.sourceEntityIds.split(',').includes(id)
                : false,
            ),
        );
        for (const job of overlapping) {
          await api.jobs.cancel(job.id);
          await waitForJobTerminal(api.jobs, job.id);
        }
        await api.jobs.register({
          id: operationId,
          label: `${side === 'keep_inside' ? 'Keep inside' : 'Remove inside'} · ${captured.entityIds.length} cloud${captured.entityIds.length === 1 ? '' : 's'}`,
          owner: 'builder.pointcloud-segment',
          phase: 'Capturing visible point-cloud state',
          expectedDurationMs: 60_000,
          progressKey: operationId,
          cancellable: true,
          context: { sourceEntityIds: captured.entityIds.join(','), side },
        });
        registered = true;
        const session = await ensureCanonicalProject();
        const result = await session.segmentPointClouds({
          operationId,
          progressKey: operationId,
          sourceEntityIds: captured.entityIds,
          volume: captured.volume,
          side,
          scopes: captured.scopes,
        });
        await reloadCanonicalResidency();
        selectionStore.replace(result.revisions.map((revision) => revision.entityId));
        const retained = result.revisions.reduce(
          (sum, revision) => sum + revision.retainedPoints,
          0,
        );
        await api.jobs.complete(operationId, `${retained.toLocaleString()} points retained`);
        setSegmentFence((current) => ({ ...EMPTY_SEGMENT_FENCE, kind: current.kind }));
        logEvent(
          'info',
          'renderer',
          `${side === 'keep_inside' ? 'Keep inside' : 'Remove inside'} committed as one undoable transaction · ${result.revisions.length} revision${result.revisions.length === 1 ? '' : 's'}`,
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const job = registered ? await api.jobs.get(operationId).catch(() => null) : null;
        if (job?.state === 'cancelling' || /cancelled|canceled/i.test(message)) {
          await api.jobs.cancelled(operationId);
        } else if (registered) {
          setSegmentError(message);
          await api.jobs.fail(operationId, message);
        } else {
          setSegmentError(message);
        }
        return undefined;
      }
    },
    [ensureCanonicalProject, jobs, reloadCanonicalResidency, selectionStore],
  );
  const runGroundOperation = useCallback(
    async (
      mode: 'preview' | 'extract',
      parameters: GroundExtractionParameters,
      propagateError = false,
      requestedSourceId?: string,
      requestedOperationId?: string,
    ): Promise<GroundPreviewResult | GroundExtractionResult | undefined> => {
      const api = window.himmelcad;
      const current = projectRef.current;
      const ids = requestedSourceId ? [requestedSourceId as EntityId] : [...selectedRef.current];
      const sourceId = ids.length === 1 ? ids[0] : undefined;
      const source = sourceId ? current?.entities[sourceId] : undefined;
      const metadata = sourceId ? pointCloudMetadata.get(sourceId) : undefined;
      if (
        !api ||
        !sourceId ||
        source?.kind !== 'PointCloud' ||
        !source.visibility.visible ||
        !metadata
      ) {
        setGroundError('Select exactly one visible point cloud.');
        return;
      }
      const visibleClasses = metadata.display.classes
        .filter((classification) => classification.visible)
        .map((classification) => classification.code);
      if (visibleClasses.length === 0) {
        setGroundError('At least one source classification must be visible.');
        return;
      }
      const capturedBox = viewingBoxRef.current;
      const activeBox =
        capturedBox?.enabled &&
        displayStore.getSnapshot().state.activeClipEntityIds.includes(capturedBox.id)
          ? capturedBox
          : null;
      const scope = {
        viewingBox: activeBox
          ? {
              center: [activeBox.center.x, activeBox.center.y, activeBox.center.z] as const,
              halfExtents: [
                activeBox.halfExtents.x,
                activeBox.halfExtents.y,
                activeBox.halfExtents.z,
              ] as const,
              rotation: activeBox.rotation,
              keepInside: (activeBox.operation ?? 'keepInside') === 'keepInside',
            }
          : null,
        visibleClasses,
      };
      const operationId = requestedOperationId ?? `ground-${mode}-${crypto.randomUUID()}`;
      setGroundError(null);
      if (mode === 'preview') setGroundPreview(null);
      else setGroundResult(null);
      await api.jobs.register({
        id: operationId,
        label:
          mode === 'preview'
            ? `Preview ground · ${source.name}`
            : `Extract ground · ${source.name}`,
        owner: 'builder.ground-extraction',
        phase:
          mode === 'preview' ? 'Preparing ground preview' : 'Capturing visible point-cloud state',
        expectedDurationMs: mode === 'preview' ? 2_000 : 60_000,
        progressKey: operationId,
        cancellable: true,
        context: { sourceEntityId: sourceId, mode },
      });
      try {
        const session = await ensureCanonicalProject();
        if (mode === 'preview') {
          const preview = await session.previewGround({
            operationId,
            progressKey: operationId,
            sourceEntityId: sourceId,
            parameters,
            scope,
          });
          setGroundPreview(preview);
          logEvent(
            'info',
            'renderer',
            `pointcloud.ground.preview · ${preview.preview.groundPoints.toLocaleString()} / ${preview.preview.sampledPoints.toLocaleString()} sampled · residual σ ${preview.preview.residuals.standardDeviationM.toFixed(3)} m`,
          );
          await api.jobs.complete(
            operationId,
            `${preview.preview.groundPoints.toLocaleString()} preview ground points`,
          );
          return preview;
        } else {
          const result = await session.extractGround({
            operationId,
            progressKey: operationId,
            sourceEntityId: sourceId,
            groundEntityId: `pointcloud-ground-${crypto.randomUUID()}`,
            outputName: `${source.name} — Ground`,
            parameters,
            scope,
          });
          setGroundResult(result);
          logEvent(
            'info',
            'renderer',
            `pointcloud.ground.extract · Ground points ${result.summary.groundPoints.toLocaleString()} (${(result.summary.ratio * 100).toFixed(1)} %) · residual σ ${result.summary.residuals.standardDeviationM.toFixed(3)} m · sha256 ${result.summary.membershipSha256}`,
          );
          await reloadCanonicalResidency();
          selectionStore.replace([result.groundCloud.entityId as EntityId]);
          await api.jobs.complete(
            operationId,
            `${result.summary.groundPoints.toLocaleString()} ground points`,
          );
          return result;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const job = await api.jobs.get(operationId).catch(() => null);
        if (job?.state === 'cancelling' || /cancelled|canceled/i.test(message)) {
          await api.jobs.cancelled(operationId);
        } else {
          setGroundError(message);
          await api.jobs.fail(operationId, message);
        }
        if (propagateError) throw error;
        return undefined;
      }
    },
    [
      displayStore,
      drawToolStore,
      ensureCanonicalProject,
      pointCloudMetadata,
      reloadCanonicalResidency,
      selectionStore,
    ],
  );
  groundAutomationRef.current = async (method, input) => {
    const payload = automationPayload(input);
    if (method === 'pointcloud.ground.cancel') {
      if (typeof payload.operationId !== 'string') {
        throw new TypeError('pointcloud.ground.cancel requires payload.operationId.');
      }
      const job = await window.himmelcad?.jobs.cancel(payload.operationId);
      return admissionResult({
        operationId: payload.operationId,
        state: job?.state ?? 'cancelling',
      });
    }
    if (typeof payload.sourceEntityId !== 'string') {
      throw new TypeError(`${method} requires payload.sourceEntityId.`);
    }
    selectionStore.replace([payload.sourceEntityId]);
    const result = await runGroundOperation(
      method === 'pointcloud.ground.preview' ? 'preview' : 'extract',
      groundParametersFromPayload(payload.parameters),
      true,
      payload.sourceEntityId,
      typeof payload.operationId === 'string' ? payload.operationId : undefined,
    );
    if (!result) throw new Error(`${method} did not return a typed result.`);
    return groundResultEnvelope(result);
  };
  const activePointcloudProcessingJob =
    jobs.find(
      (job) =>
        job.owner === 'builder.pointcloud-processing' &&
        !['completed', 'failed', 'cancelled'].includes(job.state),
    ) ?? null;
  const runPointcloudProcessing = useCallback(
    async (
      mode: 'sample' | 'rasterize',
      parameters: PointcloudSampleParameters | PointcloudRasterizeParameters,
      propagateError = false,
      requestedSourceId?: string,
      requestedOperationId?: string,
      requestedOutputName?: string,
    ): Promise<PointcloudSampleResult | PointcloudRasterizeResult | undefined> => {
      const api = window.himmelcad;
      const current = projectRef.current;
      const ids = requestedSourceId ? [requestedSourceId as EntityId] : [...selectedRef.current];
      const sourceId = ids.length === 1 ? ids[0] : undefined;
      const source = sourceId ? current?.entities[sourceId] : undefined;
      const metadata = sourceId ? pointCloudMetadata.get(sourceId) : undefined;
      const sourceInteraction =
        sourceId && current
          ? interactionResolver(current, displayStore.getSnapshot().state).effective(sourceId)
          : null;
      if (
        !api ||
        !sourceId ||
        source?.kind !== 'PointCloud' ||
        !sourceInteraction?.renderable ||
        !['reference', 'editable'].includes(sourceInteraction.effective) ||
        !metadata
      ) {
        setPointcloudProcessingError(
          'Select exactly one visible Reference or Editable point cloud.',
        );
        return;
      }
      const visibleClasses = metadata.display.classes
        .filter((classification) => classification.visible)
        .map((classification) => classification.code);
      if (visibleClasses.length === 0) {
        setPointcloudProcessingError('At least one source classification must be visible.');
        return;
      }
      const capturedBox = viewingBoxRef.current;
      const activeBox =
        capturedBox?.enabled &&
        displayStore.getSnapshot().state.activeClipEntityIds.includes(capturedBox.id)
          ? capturedBox
          : null;
      const scope = {
        viewingBox: activeBox
          ? {
              center: [activeBox.center.x, activeBox.center.y, activeBox.center.z] as const,
              halfExtents: [
                activeBox.halfExtents.x,
                activeBox.halfExtents.y,
                activeBox.halfExtents.z,
              ] as const,
              rotation: activeBox.rotation,
              keepInside: (activeBox.operation ?? 'keepInside') === 'keepInside',
            }
          : null,
        visibleClasses,
      };
      const operationId = requestedOperationId ?? `${mode}-${crypto.randomUUID()}`;
      const label = mode === 'sample' ? `Sample · ${source.name}` : `Rasterize · ${source.name}`;
      setPointcloudProcessingError(null);
      if (mode === 'sample') setSampleResult(null);
      else setRasterizeResult(null);
      await api.jobs.register({
        id: operationId,
        label,
        owner: 'builder.pointcloud-processing',
        phase: 'Capturing visible point-cloud state',
        expectedDurationMs: 60_000,
        progressKey: operationId,
        cancellable: true,
        context: { sourceEntityId: sourceId, mode },
      });
      try {
        const session = await ensureCanonicalProject();
        if (mode === 'sample') {
          const result = await session.samplePointCloud({
            operationId,
            progressKey: operationId,
            sourceEntityId: sourceId,
            outputEntityId: `pointcloud-sample-${crypto.randomUUID()}`,
            outputName: requestedOutputName ?? `${source.name} — Sampled`,
            parameters: parameters as PointcloudSampleParameters,
            scope,
          });
          setSampleResult(result);
          logEvent(
            'info',
            'renderer',
            `pointcloud.sample · ${result.summary.sampledPoints.toLocaleString()} of ${result.summary.scopedPoints.toLocaleString()} points · sha256 ${result.summary.selectionSha256}`,
          );
          await reloadCanonicalResidency();
          selectionStore.replace([result.sampledCloud.entityId as EntityId]);
          await api.jobs.complete(
            operationId,
            `${result.summary.sampledPoints.toLocaleString()} sampled points`,
          );
          return result;
        }
        const rasterizeParameters = parameters as PointcloudRasterizeParameters;
        const result = await session.rasterizePointCloud({
          operationId,
          progressKey: operationId,
          sourceEntityId: sourceId,
          outputEntityId: `pointcloud-grid-${crypto.randomUUID()}`,
          outputName:
            requestedOutputName ??
            `${source.name} — ${rasterizeParameters.aggregation === 'count' ? 'Count grid' : 'Height grid'}`,
          parameters: rasterizeParameters,
          scope,
        });
        setRasterizeResult(result);
        logEvent(
          'info',
          'renderer',
          `pointcloud.rasterize · ${result.summary.width.toLocaleString()} × ${result.summary.height.toLocaleString()} · ${result.summary.cellSizeM} m · ${(result.summary.emptyRatio * 100).toFixed(1)} % empty · sha256 ${result.summary.cellSha256}`,
        );
        await reloadCanonicalResidency();
        selectionStore.replace([result.grid.entityId as EntityId]);
        await api.jobs.complete(
          operationId,
          `${result.summary.width.toLocaleString()} × ${result.summary.height.toLocaleString()} grid`,
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const job = await api.jobs.get(operationId).catch(() => null);
        if (job?.state === 'cancelling' || /cancelled|canceled/i.test(message)) {
          await api.jobs.cancelled(operationId);
        } else {
          setPointcloudProcessingError(message);
          await api.jobs.fail(operationId, message);
        }
        if (propagateError) throw error;
        return undefined;
      }
    },
    [
      displayStore,
      ensureCanonicalProject,
      pointCloudMetadata,
      reloadCanonicalResidency,
      selectionStore,
    ],
  );
  pointcloudProcessingAutomationRef.current = async (method, input) => {
    const payload = automationPayload(input);
    if (typeof payload.sourceEntityId !== 'string') {
      throw new TypeError(`${method} requires payload.sourceEntityId.`);
    }
    selectionStore.replace([payload.sourceEntityId]);
    const result = await runPointcloudProcessing(
      method === 'pointcloud.sample' ? 'sample' : 'rasterize',
      method === 'pointcloud.sample'
        ? sampleParametersFromPayload(payload.parameters)
        : rasterizeParametersFromPayload(payload.parameters),
      true,
      payload.sourceEntityId,
      typeof payload.operationId === 'string' ? payload.operationId : undefined,
      typeof payload.outputName === 'string' ? payload.outputName : undefined,
    );
    if (!result) throw new Error(`${method} did not return a typed result.`);
    return pointcloudProcessingResultEnvelope(result);
  };
  const setSelectedPointCloudDisplay = useCallback(
    async (display: PointCloudDisplayStyle, targetEntityIds?: readonly string[]): Promise<void> => {
      const session = canonicalSessionRef.current;
      const entityIds = (
        targetEntityIds ?? selectedPointClouds.map(({ entityId }) => entityId)
      ).map((entityId) => entityId as EntityId);
      if (!session || entityIds.length === 0 || propertyEditing) return;
      setPropertyEditing(true);
      setPropertyQueryError(null);
      try {
        setProject(await session.setPointCloudDisplay(entityIds, display));
        setPointCloudMetadata((current) => {
          const next = new Map(current);
          for (const entityId of entityIds) {
            const metadata = next.get(entityId);
            if (metadata) next.set(entityId, { ...metadata, display });
          }
          return next;
        });
        viewportRef.current?.setPointCloudDisplay(entityIds, display);
        setPropertyRefresh((revision) => revision + 1);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setPropertyQueryError(message);
        logEvent('error', 'renderer', `Point-cloud display edit failed: ${message}`);
      } finally {
        setPropertyEditing(false);
      }
    },
    [propertyEditing, selectedPointClouds],
  );

  const onSelect = (id: EntityId, mode: 'replace' | 'add' | 'toggle') => {
    if (mode === 'replace') selectionStore.replace([id]);
    else if (mode === 'toggle') selectionStore.toggle(id);
    else selectionStore.replace([...selected, id]);
  };

  const openExport = useCallback((): void => {
    const hasExportableSelection =
      project !== null &&
      [...selectedRef.current].some((id) => {
        const entity = project.entities[id];
        return entity !== undefined && isExportScopeEntity(entity.kind);
      });
    setExportInitialScope(hasExportableSelection ? 'selection' : 'visible');
    setExportMounted(true);
    setExportOpen(true);
  }, [project]);

  const onVisibilityChange = useCallback(
    (id: EntityId, visible: boolean) => {
      if (!project) return;
      if (id === project.rootEntity) displayStore.setGlobalDefault(visible ? 'editable' : 'hidden');
      else displayStore.setOverride(id, visible ? 'editable' : 'hidden');
      selectionStore.invalidateCandidates('permissionChange');
    },
    [displayStore, project, selectionStore],
  );

  const onInteractionStateChange = useCallback(
    (
      ids: readonly EntityId[],
      state: 'hidden' | 'reference' | 'editable' | 'inert',
      scope: 'node' | 'subtree' | 'all',
    ): void => {
      if (!project || !interactionState) return;
      const current = displayStore.getSnapshot().state;
      if (ids.includes(project.rootEntity) && scope !== 'all') {
        displayStore.replaceState({ ...current, globalDefault: state });
      } else if (scope === 'all') {
        const overrides = { ...current.overrides };
        for (const id of ids) {
          if (id !== project.rootEntity) overrides[id] = state;
        }
        displayStore.replaceState({ ...current, overrides });
      } else {
        const targets = interactionState.setRequested(ids, state, scope);
        const resolved = interactionState.requestedOverrides();
        const overrides = { ...current.overrides };
        for (const id of targets) {
          if (id !== project.rootEntity) overrides[id] = resolved[id] ?? state;
        }
        displayStore.replaceState({ ...current, overrides });
      }
      selectionStore.invalidateCandidates('permissionChange');
    },
    [displayStore, interactionState, project, selectionStore],
  );

  const commandContext = useMemo<CommandContext>(() => {
    const entities = [...selected].flatMap((id) => {
      const entity = project?.entities[id];
      return entity ? [entity] : [];
    });
    const visibility = entities.every((entity) => entity.visibility.visible)
      ? 'visible'
      : entities.every((entity) => !entity.visibility.visible)
        ? 'hidden'
        : 'mixed';
    return {
      hasProject: project !== null,
      productId: 'builder',
      selectedEntityIds: [...selected],
      selectedCanonicalEntityKinds: entities.map((entity) => entity.kind),
      ...(entities[0] ? { entityKind: entities[0].kind } : {}),
      selectedEntityKinds: entities.map((entity) => commandEntityKind(entity.kind)),
      selectionVisibility: visibility,
      selectionEditable: entities.every((entity) => !entity.visibility.locked),
      selectionExportable:
        entities.length > 0 && entities.every((entity) => isCommandExportable(entity.kind)),
      clipboardAdmissible: false,
      candidates: selection.candidates?.items ?? [],
    };
  }, [project, selected, selection.candidates]);

  const changeDocumentHistory = useCallback(
    async (direction: 'undo' | 'redo'): Promise<void> => {
      try {
        const session = await ensureCanonicalProject();
        const before = projectRef.current;
        const next =
          direction === 'undo' ? await session.undoDocument() : await session.redoDocument();
        const removedEntityIds = before
          ? (Object.keys(before.entities).filter(
              (entityId) => !next.entities[entityId],
            ) as EntityId[])
          : [];
        const restoredEntityIds = before
          ? (Object.keys(next.entities).filter(
              (entityId) => !before.entities[entityId],
            ) as EntityId[])
          : [];
        if (removedEntityIds.length > 0) {
          viewportRef.current?.setEntityVisibility(removedEntityIds, false);
        }
        pruneRemovedSelection(selectionStore, before, next);
        setProject(next);
        await reloadCanonicalResidency();
        for (const entityId of restoredEntityIds) {
          viewportRef.current?.setEntityVisibility(
            [entityId],
            next.entities[entityId]?.visibility.visible ?? true,
          );
        }
        setSnapshots(await session.listSnapshots());
        setPropertyRefresh((revision) => revision + 1);
        logEvent('info', 'renderer', `${direction === 'undo' ? 'Undo' : 'Redo'} committed`);
      } catch (error) {
        logEvent(
          'warn',
          'renderer',
          `${direction === 'undo' ? 'Undo' : 'Redo'} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [ensureCanonicalProject, reloadCanonicalResidency, selectionStore],
  );

  const executeRegistryCommand = useCallback(
    async (invocation: CommandInvocation): Promise<void> => {
      const ids = selectedRef.current;
      switch (invocation.id) {
        case 'draw.line':
        case 'draw.polyline':
        case 'draw.boundary': {
          const payload = automationPayload(invocation.payload);
          const kind = drawKindForFunction(invocation.id)!;
          const vertices = drawVerticesFromPayload(payload.vertices);
          if (vertices.length === 0) {
            activate(invocation.id);
            return;
          }
          if (vertices.length < 2 || (kind === 'line' && vertices.length !== 2)) {
            throw new TypeError(
              `${invocation.id} requires ${kind === 'line' ? 'exactly two' : 'at least two'} typed vertices.`,
            );
          }
          if (kind === 'boundary' && vertices.length < 3) {
            throw new TypeError('draw.boundary requires at least three typed vertices.');
          }
          const role = drawRoleFromPayload(payload.role, kind);
          const entityId =
            typeof payload.entityId === 'string'
              ? payload.entityId
              : `draw-${kind}-${crypto.randomUUID()}`;
          const session = await ensureCanonicalProject();
          const { summary } = await session.putDrawCurve({
            entityId,
            expectedRevision: null,
            name:
              typeof payload.name === 'string'
                ? payload.name
                : `${drawKindLabel(kind)} ${drawCurvesRef.current.length + 1}`,
            tool: kind,
            role,
            closed: kind === 'boundary' ? payload.closed !== false : false,
            vertices,
            acquisitions: vertices.map((point) => pointAcquisition({ kind: 'typed', point })),
          });
          setProject(session.projectSnapshot());
          setDrawCurves(await session.listDrawCurves());
          await viewportRef.current?.loadCanonicalPackage({
            providerId: 'hcad.draw@1',
            providerVersion: '1',
            admissions: [summary.admission],
          });
          selectionStore.replace([summary.entityId]);
          return;
        }
        case 'draw.vertex.add':
        case 'draw.vertex.type': {
          const point = drawPointFromPayload(automationPayload(invocation.payload));
          if (!drawToolStore.snapshot().armed) throw new Error('Arm a Draw tool first.');
          await drawToolStore.acceptTyped(point);
          return;
        }
        case 'draw.vertex.constrain': {
          const payload = automationPayload(invocation.payload);
          if (!drawToolStore.snapshot().armed) throw new Error('Arm a Draw tool first.');
          const direction = finiteNumber(payload.direction, 'direction');
          const distance = finiteNumber(payload.length, 'length');
          if (typeof payload.slope === 'number') {
            await drawToolStore.acceptConstraint(direction, distance, {
              kind: 'slope',
              value: finiteNumber(payload.slope, 'slope'),
            });
          } else {
            await drawToolStore.acceptConstraint(direction, distance, {
              kind: 'deltaZ',
              value:
                typeof payload.deltaZ === 'number' ? finiteNumber(payload.deltaZ, 'deltaZ') : 0,
            });
          }
          return;
        }
        case 'draw.vertex.undo':
          await drawToolStore.undoVertex();
          return;
        case 'measure.point':
        case 'measure.distance':
        case 'measure.dz':
        case 'measurement.list':
          activate(invocation.id);
          return;
        case 'measurement.delete': {
          const id = [...ids][0];
          if (!id) return;
          const item = measurementsRef.current.find((candidate) => candidate.entityId === id);
          if (!item) throw new Error('Select one saved measurement to delete.');
          const session = await ensureCanonicalProject();
          await session.deleteMeasurement(item.entityId, item.revision);
          selectionStore.pruneDeleted([item.entityId]);
          setProject(session.projectSnapshot());
          setMeasurements(await session.listMeasurements());
          return;
        }
        case 'select.set': {
          const envelope = invocation.payload as
            | {
                readonly entityIds?: readonly string[];
                readonly payload?: { readonly entityIds?: readonly string[] };
              }
            | undefined;
          const next = envelope?.entityIds ?? envelope?.payload?.entityIds ?? invocation.args;
          selectionStore.replace(next);
          return;
        }
        case 'select.clear':
          selectionStore.clear();
          return;
        case 'view.frame':
        case 'entity.zoom_to':
          viewportRef.current?.frameAll();
          return;
        case 'view.camera.undo':
        case 'view.camera.redo':
          await viewportRef.current?.cameraHistory(
            invocation.id.endsWith('undo') ? 'undo' : 'redo',
          );
          return;
        case 'view.display.undo':
          displayStore.undo();
          return;
        case 'view.display.redo':
          displayStore.redo();
          return;
        case 'view.hud.toggle':
          setHudVisible((visible) => !visible);
          return;
        case 'view.bookmark.create': {
          const session = await ensureCanonicalProject();
          const bookmarks = await session.listViewBookmarks();
          const payload = automationPayload(invocation.payload);
          const name =
            typeof payload.name === 'string' ? payload.name : nextBookmarkName(bookmarks.length);
          await session.createViewBookmark(
            name,
            bookmarkCaptureState(currentViewStateRef.current()),
          );
          setProject(session.projectSnapshot());
          logEvent('info', 'renderer', `Captured bookmark “${name}”.`);
          return;
        }
        case 'view.bookmark.restore': {
          const session = await ensureCanonicalProject();
          const bookmarks = await session.listViewBookmarks();
          const payload = automationPayload(invocation.payload);
          const bookmark =
            (typeof payload.entityId === 'string'
              ? bookmarks.find((item) => item.entityId === payload.entityId)
              : bookmarks.at(-1)) ?? null;
          if (!bookmark) throw new Error('There are no view bookmarks to restore.');
          const candidate = viewStateFromBookmark(bookmark.state, currentViewStateRef.current());
          validateBuilderClipRefs(candidate, viewingBoxRef.current, viewingBoxRevisionRef.current);
          const restored = await session.restoreViewBookmark(bookmark.entityId, bookmark.revision);
          await applyViewStateRef.current(candidate);
          setProject(session.projectSnapshot());
          logEvent('info', 'renderer', `Restored bookmark “${restored.name}”.`);
          return;
        }
        case 'view.box.place': {
          const payload = automationPayload(invocation.payload);
          if (payload.fromSelection === true) {
            createViewingBoxFromSelection();
          } else if ('center' in payload || 'extents' in payload) {
            if (!isViewingBoxPoint(payload.center) || !isPositiveViewingBoxPoint(payload.extents)) {
              throw new TypeError(
                'view.box.place requires finite center coordinates and positive extents.',
              );
            }
            createViewingBoxFromTypedExtents(payload.center, payload.extents);
          } else {
            pendingViewingBoxIdRef.current = `viewing-box-${crypto.randomUUID()}`;
            setPlacingViewingBoxCenter(true);
            activate('view.viewing-box');
          }
          await viewingBoxPersistTailRef.current;
          return;
        }
        case 'view.box.update': {
          const state = viewingBoxRef.current;
          if (!state || (state.lockMode ?? 'unlocked') !== 'unlocked') {
            throw new Error('An unlocked active viewing box is required.');
          }
          const payload = automationPayload(invocation.payload);
          const next: KernelViewingBoxState = {
            ...state,
            ...(isViewingBoxPoint(payload.center) ? { center: payload.center } : {}),
            ...(isViewingBoxPoint(payload.halfExtents) ? { halfExtents: payload.halfExtents } : {}),
            ...(isViewingBoxRotation(payload.rotation) ? { rotation: payload.rotation } : {}),
            ...(typeof payload.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
          };
          commitCanonicalViewingBox(next);
          await viewingBoxPersistTailRef.current;
          return;
        }
        case 'view.box.set_operation': {
          const state = viewingBoxRef.current;
          const payload = automationPayload(invocation.payload);
          if (
            !state ||
            (state.lockMode ?? 'unlocked') !== 'unlocked' ||
            !['keepInside', 'removeInside'].includes(String(payload.operation))
          ) {
            throw new TypeError(
              'view.box.set_operation requires an unlocked active box and operation.',
            );
          }
          commitCanonicalViewingBox({
            ...state,
            operation: payload.operation as KernelViewingBoxOperation,
          });
          await viewingBoxPersistTailRef.current;
          return;
        }
        case 'view.box.lock':
          await setViewingBoxLocked(true);
          await viewingBoxPersistTailRef.current;
          return;
        case 'view.box.unlock':
          await setViewingBoxLocked(false);
          await viewingBoxPersistTailRef.current;
          return;
        case 'view.box.rename': {
          const payload = automationPayload(invocation.payload);
          if (typeof payload.name !== 'string' || !payload.name.trim()) {
            throw new TypeError('view.box.rename requires name.');
          }
          renameViewingBox(payload.name);
          await viewingBoxPersistTailRef.current;
          return;
        }
        case 'view.box.activate': {
          const payload = automationPayload(invocation.payload);
          if (typeof payload.entityId !== 'string') {
            throw new TypeError('view.box.activate requires entityId.');
          }
          selectViewingBox(payload.entityId);
          return;
        }
        case 'view.box.deactivate':
          displayStore.setActiveClipEntityIds([]);
          viewportRef.current?.setViewingBox(null);
          return;
        case 'view.box.remove':
          await deleteViewingBox();
          return;
        case 'view.box.list':
          return;
        case 'view.preset.top':
        case 'view.preset.front':
        case 'view.preset.right':
        case 'view.preset.isometric':
        case 'view.preset.perspective':
          viewportRef.current?.setPreset(
            invocation.id.slice('view.preset.'.length) as
              | 'top'
              | 'front'
              | 'right'
              | 'isometric'
              | 'perspective',
          );
          return;
        case 'entity.hide':
          for (const id of ids) onVisibilityChange(id, false);
          return;
        case 'entity.show':
          for (const id of ids) onVisibilityChange(id, true);
          return;
        case 'entity.isolate': {
          const current = projectRef.current;
          if (!current) return;
          for (const entity of Object.values(current.entities)) {
            if (entity.id !== current.rootEntity) onVisibilityChange(entity.id, ids.has(entity.id));
          }
          return;
        }
        case 'entity.properties':
          setRightPanelTab('properties');
          return;
        case 'pointcloud.display.set': {
          setRightPanelTab('properties');
          const envelope = invocation.payload as
            | {
                readonly payload?: {
                  readonly entityIds?: readonly string[];
                  readonly display?: PointCloudDisplayStyle;
                };
              }
            | undefined;
          if (envelope?.payload?.entityIds) {
            selectionStore.replace(envelope.payload.entityIds);
          }
          if (envelope?.payload?.display) {
            await setSelectedPointCloudDisplay(
              envelope.payload.display,
              envelope.payload.entityIds,
            );
          }
          return;
        }
        case 'pointcloud.fence.begin': {
          const payload = automationPayload(invocation.payload);
          const kind = payload.kind === 'rectangle' ? 'rectangle' : 'polygon';
          const volume = optionalFenceVolumeFromPayload(payload);
          setSegmentFence({
            ...EMPTY_SEGMENT_FENCE,
            kind,
            ...(volume
              ? {
                  vertices: fenceVolumeVertices(volume),
                  closed: true,
                  volume,
                  ...captureSegmentTargets(stringArray(payload.entityIds)),
                }
              : {}),
          });
          setSegmentError(null);
          activate('pointcloud.fence.begin');
          setRightPanelTab('function');
          return;
        }
        case 'pointcloud.fence.commit': {
          const payload = automationPayload(invocation.payload);
          const volume = optionalFenceVolumeFromPayload(payload);
          if (!closeSegmentFence(volume ?? undefined, stringArray(payload.entityIds))) {
            throw new Error('The active point-cloud fence could not be closed.');
          }
          return;
        }
        case 'pointcloud.fence.cancel':
          setSegmentFence((current) => ({ ...EMPTY_SEGMENT_FENCE, kind: current.kind }));
          constructionInputStore.disarm();
          if (activeFunctionId === 'pointcloud.fence.begin') closeFunction(activeFunctionId);
          return;
        case 'pointcloud.segment.keep_inside':
        case 'pointcloud.segment.remove_inside': {
          const payload = automationPayload(invocation.payload);
          const side = invocation.id.endsWith('keep_inside') ? 'keep_inside' : 'remove_inside';
          const explicitVolume = optionalFenceVolumeFromPayload(payload);
          let captured = segmentFenceRef.current;
          if (explicitVolume) {
            const targets = captureSegmentTargets(stringArray(payload.entityIds));
            captured = {
              kind: explicitVolume.kind === 'box' ? 'rectangle' : 'polygon',
              vertices: fenceVolumeVertices(explicitVolume),
              closed: true,
              volume: explicitVolume,
              ...targets,
            };
            setSegmentFence(captured);
          }
          const result = await runSegmentation(
            side,
            captured,
            typeof payload.operationId === 'string' ? payload.operationId : undefined,
          );
          if (!result && invocation.source === 'automation') {
            throw new Error('Point-cloud segmentation did not produce a revision.');
          }
          return;
        }
        case 'pointcloud.sample':
        case 'pointcloud.rasterize': {
          const payload = automationPayload(invocation.payload);
          if (typeof payload.sourceEntityId === 'string') {
            selectionStore.replace([payload.sourceEntityId]);
          }
          if (
            (invocation.source === 'ribbon' || invocation.source === 'contextMenu') &&
            payload.parameters === undefined
          ) {
            activate(invocation.id);
            return;
          }
          await runPointcloudProcessing(
            invocation.id === 'pointcloud.sample' ? 'sample' : 'rasterize',
            invocation.id === 'pointcloud.sample'
              ? sampleParametersFromPayload(payload.parameters)
              : rasterizeParametersFromPayload(payload.parameters),
            false,
            typeof payload.sourceEntityId === 'string' ? payload.sourceEntityId : undefined,
            typeof payload.operationId === 'string' ? payload.operationId : undefined,
            typeof payload.outputName === 'string' ? payload.outputName : undefined,
          );
          return;
        }
        case 'pointcloud.ground.extract': {
          const payload = automationPayload(invocation.payload);
          if (typeof payload.sourceEntityId === 'string') {
            selectionStore.replace([payload.sourceEntityId]);
          }
          if (
            (invocation.source === 'ribbon' || invocation.source === 'contextMenu') &&
            payload.parameters === undefined
          ) {
            activate('pointcloud.ground.extract');
            return;
          }
          await runGroundOperation(
            'extract',
            groundParametersFromPayload(payload.parameters),
            false,
            typeof payload.sourceEntityId === 'string' ? payload.sourceEntityId : undefined,
            typeof payload.operationId === 'string' ? payload.operationId : undefined,
          );
          return;
        }
        case 'pointcloud.ground.preview': {
          const payload = automationPayload(invocation.payload);
          if (typeof payload.sourceEntityId === 'string') {
            selectionStore.replace([payload.sourceEntityId]);
          }
          await runGroundOperation(
            'preview',
            groundParametersFromPayload(payload.parameters),
            false,
            typeof payload.sourceEntityId === 'string' ? payload.sourceEntityId : undefined,
            typeof payload.operationId === 'string' ? payload.operationId : undefined,
          );
          return;
        }
        case 'pointcloud.ground.cancel': {
          const payload = automationPayload(invocation.payload);
          const jobId =
            typeof payload.operationId === 'string' ? payload.operationId : activeGroundJob?.id;
          if (!jobId) throw new TypeError('pointcloud.ground.cancel requires operationId.');
          await window.himmelcad?.jobs.cancel(jobId);
          return;
        }
        case 'mesh.surface.draft.create': {
          const payload = automationPayload(invocation.payload);
          const session = await ensureCanonicalProject();
          const entityIds = stringArray(payload.entityIds) ?? [];
          if (entityIds.length > 0) selectionStore.replace(entityIds);
          await session.createSurfaceDraft({
            operationId:
              typeof payload.operationId === 'string'
                ? payload.operationId
                : `surface-draft-${crypto.randomUUID()}`,
            progressKey:
              typeof payload.progressKey === 'string'
                ? payload.progressKey
                : 'mesh.surface.draft.create',
            draftId:
              typeof payload.draftId === 'string'
                ? payload.draftId
                : `surface-draft-${crypto.randomUUID()}`,
            name: typeof payload.name === 'string' ? payload.name : 'DGM surface',
            sources: entityIds.map((entityId) => ({
              entityId,
              role:
                projectRef.current?.entities[entityId]?.kind === 'Polyline3D'
                  ? 'breakline'
                  : 'points',
            })),
            rules: surfaceRulesFromPayload(payload.rules),
          });
          return;
        }
        case 'mesh.surface.check': {
          const payload = automationPayload(invocation.payload);
          if (typeof payload.draftId !== 'string')
            throw new TypeError('mesh.surface.check requires draftId.');
          await (await ensureCanonicalProject()).checkSurface(payload.draftId);
          return;
        }
        case 'mesh.surface.draft.apply_fix': {
          const payload = automationPayload(invocation.payload);
          if (
            typeof payload.draftId !== 'string' ||
            typeof payload.errorId !== 'string' ||
            !['drop', 'snap', 'split', 'exclude'].includes(String(payload.fix))
          ) {
            throw new TypeError('mesh.surface.draft.apply_fix requires draftId, errorId, and fix.');
          }
          await (
            await ensureCanonicalProject()
          ).fixSurface(
            payload.draftId,
            payload.errorId,
            payload.fix as 'drop' | 'snap' | 'split' | 'exclude',
            typeof payload.authoritySourceId === 'string' ? payload.authoritySourceId : undefined,
          );
          return;
        }
        case 'mesh.surface.create': {
          const payload = automationPayload(invocation.payload);
          if (
            (invocation.source === 'ribbon' || invocation.source === 'contextMenu') &&
            typeof payload.draftId !== 'string'
          ) {
            setDgmOpen(true);
            return;
          }
          if (typeof payload.draftId !== 'string')
            throw new TypeError('mesh.surface.create requires draftId.');
          const session = await ensureCanonicalProject();
          const result = await session.publishSurface({
            operationId:
              typeof payload.operationId === 'string'
                ? payload.operationId
                : `surface-create-${crypto.randomUUID()}`,
            progressKey:
              typeof payload.progressKey === 'string' ? payload.progressKey : 'mesh.surface.create',
            draftId: payload.draftId,
            outputEntityId:
              typeof payload.outputEntityId === 'string'
                ? payload.outputEntityId
                : `surface-${crypto.randomUUID()}`,
          });
          setProject(session.projectSnapshot());
          await reloadCanonicalResidency();
          logEvent(
            'info',
            'renderer',
            `mesh.surface.create · ${result.triangles.toLocaleString()} triangles`,
          );
          return;
        }
        case 'mesh.edit.region.select': {
          const payload = automationPayload(invocation.payload);
          const targetEntityId =
            typeof payload.targetEntityId === 'string' ? payload.targetEntityId : null;
          const polygon = surfaceEditPolygonFromPayload(payload.polygon);
          if (!targetEntityId || !polygon) {
            throw new TypeError(
              'mesh.edit.region.select requires targetEntityId and a typed project-XY polygon.',
            );
          }
          const editId =
            typeof payload.editId === 'string'
              ? payload.editId
              : `surface-edit-${crypto.randomUUID()}`;
          const selectedRegion = await (
            await ensureCanonicalProject()
          ).selectSurfaceEditRegion(editId, targetEntityId, {
            source: payload.source === 'boundary_polyline' ? 'boundary_polyline' : 'fence',
            polygon,
          });
          logEvent(
            'info',
            'renderer',
            `mesh.edit.region.select · ${selectedRegion.summary.area.toFixed(2)} m² · ${selectedRegion.summary.vertices.toLocaleString()} vertices`,
          );
          return;
        }
        case 'mesh.edit.smooth':
        case 'mesh.edit.downsample': {
          const payload = automationPayload(invocation.payload);
          if (
            (invocation.source === 'ribbon' || invocation.source === 'contextMenu') &&
            payload.polygon === undefined
          ) {
            const targetEntityId =
              typeof payload.targetEntityId === 'string'
                ? payload.targetEntityId
                : selectedRef.current.size === 1
                  ? [...selectedRef.current][0]!
                  : null;
            const targetKind = targetEntityId
              ? projectRef.current?.entities[targetEntityId]?.kind
              : null;
            if (
              !targetEntityId ||
              (targetKind !== 'Surface' && targetKind !== 'DigitalElevationModel')
            ) {
              throw new TypeError('Edit surface requires one selected DGM.');
            }
            selectionStore.replace([targetEntityId]);
            setSurfaceEditTargetId(targetEntityId);
            setSurfaceEditPreview(null);
            setSurfaceEditBoundaryRegion(null);
            activate('mesh.edit.smooth');
            return;
          }
          const targetEntityId =
            typeof payload.targetEntityId === 'string' ? payload.targetEntityId : null;
          const polygon = surfaceEditPolygonFromPayload(payload.polygon);
          if (!targetEntityId || !polygon) {
            throw new TypeError(
              `${invocation.id} requires targetEntityId and a typed project-XY polygon.`,
            );
          }
          const session = await ensureCanonicalProject();
          const editId =
            typeof payload.editId === 'string'
              ? payload.editId
              : `surface-edit-${crypto.randomUUID()}`;
          await session.selectSurfaceEditRegion(editId, targetEntityId, {
            source: payload.source === 'boundary_polyline' ? 'boundary_polyline' : 'fence',
            polygon,
          });
          const kind = invocation.id === 'mesh.edit.smooth' ? 'smooth' : 'downsample';
          const parameters =
            typeof payload.parameters === 'object' && payload.parameters
              ? (payload.parameters as Record<string, unknown>)
              : {};
          const result = await session.bakeSurfaceEdit({
            kind,
            operationId:
              typeof payload.operationId === 'string'
                ? payload.operationId
                : `mesh-edit-${crypto.randomUUID()}`,
            editId,
            outputEntityId:
              typeof payload.outputEntityId === 'string'
                ? payload.outputEntityId
                : `surface-${crypto.randomUUID()}`,
            outputName:
              typeof payload.outputName === 'string'
                ? payload.outputName
                : kind === 'smooth'
                  ? 'Smoothed DGM'
                  : 'Downsampled DGM',
            ...(kind === 'smooth'
              ? {
                  smooth: {
                    filter: parameters.filter === 'median' ? 'median' : 'gaussian',
                    radius: typeof parameters.radius === 'number' ? parameters.radius : 1,
                  },
                }
              : {
                  downsample: {
                    maximumVerticalError:
                      typeof parameters.maximumVerticalError === 'number'
                        ? parameters.maximumVerticalError
                        : 0.02,
                  },
                }),
          });
          setProject(session.projectSnapshot());
          await reloadCanonicalResidency();
          logEvent(
            'info',
            'renderer',
            `${invocation.id} · vertices ${result.metrics.verticesBefore.toLocaleString()} → ${result.metrics.verticesAfter.toLocaleString()} · max error ${result.metrics.error.maximumVerticalError.toFixed(3)} m · RMS ${result.metrics.error.rmsVerticalError.toFixed(3)} m`,
          );
          return;
        }
        case 'file.import': {
          const envelope = invocation.payload as
            | { readonly payload?: { readonly paths?: readonly string[] } }
            | undefined;
          const paths = envelope?.payload?.paths;
          if (paths && paths.length > 0) {
            const api = window.himmelcad;
            if (!api) return;
            const items = await registerImportJobs(api, paths);
            setRegistrationItems((current) => [...current, ...items]);
          } else {
            activate('file.import');
          }
          return;
        }
        case 'io.import.product_dataset.list':
        case 'io.import.product_dataset.register':
          setPhotoLabProductImportOpen(true);
          logEvent(
            'info',
            'renderer',
            invocation.id === 'io.import.product_dataset.list'
              ? 'PhotoLab product dataset chooser opened'
              : 'PhotoLab product dataset registration opened',
          );
          return;
        case 'project.save':
          await flushProject();
          return;
        case 'project.undo':
          await changeDocumentHistory('undo');
          return;
        case 'project.redo':
          await changeDocumentHistory('redo');
          return;
        case 'project.new':
          await projectActionsRef.current.create();
          return;
        case 'project.open':
          await projectActionsRef.current.open();
          return;
        case 'project.recent':
          for (const entry of recentProjects) {
            logEvent('info', 'renderer', `${entry.name} · ${entry.path}`);
          }
          return;
        case 'project.save_as':
          await projectActionsRef.current.saveAs();
          return;
        case 'project.close':
          await projectActionsRef.current.close();
          return;
        case 'entity.export':
          openExport();
          return;
        case 'entity.rename':
        case 'edit.clipboard.paste_in_place':
          activate(invocation.id);
          return;
      }
    },
    [
      activate,
      activeGroundJob,
      activeFunctionId,
      captureSegmentTargets,
      changeDocumentHistory,
      closeFunction,
      closeSegmentFence,
      commitCanonicalViewingBox,
      constructionInputStore,
      createViewingBoxFromSelection,
      createViewingBoxFromTypedExtents,
      deleteViewingBox,
      displayStore,
      ensureCanonicalProject,
      flushProject,
      onVisibilityChange,
      openExport,
      recentProjects,
      renameViewingBox,
      runGroundOperation,
      runPointcloudProcessing,
      runSegmentation,
      selectionStore,
      selectViewingBox,
      setSelectedPointCloudDisplay,
      setViewingBoxLocked,
    ],
  );
  executeRegistryCommandRef.current = executeRegistryCommand;

  const registryConsoleCommand = useCallback(
    (raw: string): void => {
      void runConsoleCommand(raw, commandContext, executeRegistryCommand).then(
        (result) => {
          if (result.kind === 'help') {
            for (const line of result.lines) logEvent('info', 'renderer', line);
          }
        },
        (error: unknown) =>
          logEvent('warn', 'renderer', error instanceof Error ? error.message : String(error)),
      );
    },
    [commandContext, executeRegistryCommand],
  );

  useEffect(() => {
    const routeShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      dispatchRegistryShortcut(event, commandContext, executeRegistryCommand);
    };
    window.addEventListener('keydown', routeShortcut);
    return () => window.removeEventListener('keydown', routeShortcut);
  }, [commandContext, executeRegistryCommand]);

  const legacyCommand = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      const [head, ...rest] = trimmed.split(/\s+/);
      const head_ = head ?? '';
      switch (head_.toLowerCase()) {
        case 'help':
        case '?':
          consoleStore.push({
            level: 'info',
            source: 'renderer',
            timestamp: Date.now(),
            message:
              'commands: help · clear · import · jobs.list · jobs.get <id> · jobs.cancel <id> · jobs.respond <id> · view.frame · view.point-size <px> · view.3d · view.2.5d · view.2d · view.clip.horizontal <z> · view.clip.vertical-x <x> · view.clip.vertical-y <y> · view.clip.clear · view.opacity <group> <0..1> · view.exaggeration <group> <factor> · ribbon.<id>',
          });
          return;
        case 'clear':
          consoleStore.clear();
          return;
        case 'import':
        case 'import.las':
          void (async () => {
            const api = window.himmelcad;
            if (!api) {
              logEvent('warn', 'renderer', 'electron bridge missing');
              return;
            }
            const session = await ensureCanonicalProject();
            const formats = await session.listIoFormats();
            const extensions = registeredImportExtensions(formats);
            const paths = rest.length > 0 ? rest : await api.dialog.openImport(extensions);
            if (paths.length === 0) return;
            const items = await registerImportJobs(api, paths);
            setRegistrationItems((current) => [...current, ...items]);
          })();
          return;
        case 'jobs':
        case 'jobs.list':
          void window.himmelcad?.jobs.list().then((listed) => {
            logEvent(
              'info',
              'renderer',
              listed.length === 0
                ? 'No jobs'
                : listed.map((job) => `${job.id} · ${job.state} · ${job.label}`).join('\n'),
            );
          });
          return;
        case 'jobs.get':
          if (!rest[0]) {
            logEvent('warn', 'renderer', 'jobs.get requires a job id');
            return;
          }
          void window.himmelcad?.jobs
            .get(rest[0])
            .then((job) => logEvent('info', 'renderer', `${job.id} · ${job.state} · ${job.phase}`));
          return;
        case 'jobs.cancel':
        case 'jobs.respond': {
          const id = rest[0];
          if (!id) {
            logEvent('warn', 'renderer', `${head_} requires a job id`);
            return;
          }
          const operation = head_.toLowerCase() === 'jobs.cancel' ? 'cancel' : 'respond';
          void window.himmelcad?.jobs[operation](id).catch((error: unknown) =>
            logEvent('error', 'renderer', `${head_} failed: ${String(error)}`),
          );
          return;
        }
        case 'view.frame':
          viewportRef.current?.frameAll();
          return;
        case 'view.point-size': {
          const next = Number(rest[0]);
          if (Number.isFinite(next)) setPointSize(clamp(next, 0.25, 20));
          else activate('view.point-size');
          return;
        }
        case 'view.top':
        case 'view.2d':
          void viewportRef.current?.setViewMode('2d');
          return;
        case 'view.orbit':
        case 'view.3d':
          void viewportRef.current?.setViewMode('3d');
          return;
        case 'view.2.5d':
          void viewportRef.current?.setViewMode('2.5d');
          return;
        case 'view.clip.clear':
          viewportRef.current?.setClipVolumes([]);
          return;
        case 'view.clip.horizontal':
        case 'view.clip.vertical-x':
        case 'view.clip.vertical-y': {
          const value = Number(rest[0]);
          if (!Number.isFinite(value)) {
            logEvent('warn', 'renderer', `${head_} requires a project coordinate`);
            return;
          }
          const normal =
            head_.toLowerCase() === 'view.clip.horizontal'
              ? { x: 0, y: 0, z: 1 }
              : head_.toLowerCase() === 'view.clip.vertical-x'
                ? { x: 1, y: 0, z: 0 }
                : { x: 0, y: 1, z: 0 };
          viewportRef.current?.setClipVolumes([
            {
              id: 'builder-user-section',
              planes: [{ normal, distance: -value }],
              operation: 'keepInside',
              previewCap: true,
              enabled: true,
            },
          ]);
          return;
        }
        case 'view.opacity':
        case 'view.exaggeration': {
          const group = rest[0] as keyof typeof entityGroupsRef.current;
          const value = Number(rest[1]);
          const ids = entityGroupsRef.current[group];
          if (!ids || !Number.isFinite(value)) {
            logEvent('warn', 'renderer', `${head_} requires cloud|ifc|orthophoto|mesh and a value`);
            return;
          }
          viewportRef.current?.setEntityAppearance(ids, {
            ...(head_.toLowerCase() === 'view.opacity'
              ? { opacity: clamp(value, 0, 1) }
              : { verticalExaggeration: clamp(value, 0.01, 100) }),
          });
          return;
        }
        default:
          if (head_.startsWith('ribbon.')) {
            activate(head_.slice('ribbon.'.length));
            return;
          }
          // INVARIANT: unknown commands degrade gracefully — they don't crash
          // the renderer; the ribbon registry will be the dispatcher in a
          // future workstream.
          activate(head_);
          logEvent('warn', 'renderer', `unrecognised command: ${head_}`);
      }
    },
    [activate, ensureCanonicalProject],
  );

  const registerImports = useCallback(
    async (paths: readonly string[]): Promise<void> => {
      const api = window.himmelcad;
      if (!api) return;
      const projectPaths = paths.filter((path) => /\.hcadx?$/i.test(path));
      if (projectPaths.length > 0) {
        if (paths.length !== 1) {
          logEvent(
            'warn',
            'renderer',
            'Open one project or archive at a time. Other dropped files were ignored.',
          );
        }
        const projectRoot = await api.canonicalProject.openPath(projectPaths[0]!);
        if (projectRoot) await replaceProject(projectRoot);
        return;
      }
      const items = await registerImportJobs(api, paths);
      setRegistrationItems((current) => [...current, ...items]);
    },
    [replaceProject],
  );

  const createProject = useCallback(async (): Promise<void> => {
    const api = window.himmelcad;
    if (!api) return;
    try {
      const path = await api.canonicalProject.create();
      if (path) await replaceProject(path);
    } catch (error) {
      logEvent('error', 'renderer', `Project creation failed: ${String(error)}`);
    }
  }, [replaceProject]);

  const openProject = useCallback(async (): Promise<void> => {
    const api = window.himmelcad;
    if (!api) return;
    try {
      const path = await api.canonicalProject.open();
      if (path) await replaceProject(path);
    } catch (error) {
      logEvent('error', 'renderer', `Project open failed: ${String(error)}`);
    }
  }, [replaceProject]);

  const saveProjectAs = useCallback(async (): Promise<void> => {
    const api = window.himmelcad;
    const projectRoot = currentProjectPathRef.current;
    if (!api || !projectRoot) return;
    try {
      const summary = await api.canonicalProject.saveAs(projectRoot);
      if (summary) {
        logEvent(
          'info',
          'renderer',
          `Archive stored: ${summary.path} · ${summary.bytes.toLocaleString()} bytes`,
        );
      }
    } catch (error) {
      logEvent('error', 'renderer', `Save As failed: ${String(error)}`);
    }
  }, []);

  const restoreSnapshot = useCallback(async (): Promise<void> => {
    const target = snapshotToRestore;
    const session = canonicalSessionRef.current;
    if (!target || !session || snapshotRestorePending) return;
    setSnapshotRestorePending(true);
    try {
      const command = await executeBuilderSnapshotCommand(session, 'snapshot.restore', {
        entityId: target.entityId,
      });
      pruneRemovedSelection(selectionStore, projectRef.current, command.project);
      setProject(command.project);
      await reloadCanonicalResidency();
      setSnapshots(command.snapshots);
      logEvent('info', 'renderer', `Restored snapshot '${target.name}'`);
      setSnapshotToRestore(null);
    } catch (error) {
      logEvent('error', 'renderer', `Snapshot restore failed: ${String(error)}`);
    } finally {
      setSnapshotRestorePending(false);
    }
  }, [reloadCanonicalResidency, selectionStore, snapshotRestorePending, snapshotToRestore]);

  const placeViewingBoxAt = useCallback(
    (position: { readonly x: number; readonly y: number; readonly z: number | null }): void => {
      const created = viewingBox
        ? placeViewingBoxCenter(viewingBox, {
            x: position.x,
            y: position.y,
            z: position.z ?? viewingBox.center.z,
          })
        : viewportRef.current?.createViewingBoxAt(
            position,
            pendingViewingBoxIdRef.current ?? `viewing-box-${crypto.randomUUID()}`,
          );
      if (created) {
        pendingViewingBoxIdRef.current = null;
        const name = `Viewing Box ${viewingBoxes.length + 1}`;
        viewingBoxNameRef.current = name;
        setViewingBoxName(name);
        commitCanonicalViewingBox(created);
        const size = created.halfExtents.x * 2;
        logEvent(
          'info',
          'renderer',
          `Viewing Box placed (${size.toFixed(2)} m cube at the current zoom).`,
        );
      }
      setPlacingViewingBoxCenter(false);
    },
    [commitCanonicalViewingBox, viewingBox, viewingBoxes.length],
  );
  projectActionsRef.current = {
    create: createProject,
    open: openProject,
    saveAs: saveProjectAs,
    close: async () => {
      await closeCurrentProject('project');
    },
  };

  const fileRibbonTabs = useCallback(
    (navigationMode: BuilderNavigationMode) =>
      createRibbonTabs({
        recent: recentProjects,
        snapshots: snapshots.map((snapshot) => ({
          entityId: snapshot.entityId,
          name: snapshot.name,
          createdAt: snapshot.marker.createdAt,
          markedGeneration: snapshot.marker.markedGeneration,
        })),
        onNew: () => void createProject(),
        onOpen: () => void openProject(),
        onOpenArchive: () => {
          void window.himmelcad?.canonicalProject
            .openArchive()
            .then((path) => (path ? replaceProject(path) : undefined))
            .catch((error: unknown) =>
              logEvent('error', 'renderer', `Archive open failed: ${String(error)}`),
            );
        },
        onOpenRecent: (path) => {
          void window.himmelcad?.canonicalProject
            .openRecent(path)
            .then(replaceProject)
            .catch(async (error: unknown) => {
              logEvent('error', 'renderer', String(error));
              const recent = await window.himmelcad?.canonicalProject.recent();
              if (recent) setRecentProjects(recent);
            });
        },
        onSave: () => void flushProject(),
        onSaveAs: () => void saveProjectAs(),
        onUndo: () => void changeDocumentHistory('undo'),
        onRedo: () => void changeDocumentHistory('redo'),
        onRestoreSnapshot: (entityId) => {
          const target = snapshots.find((snapshot) => snapshot.entityId === entityId);
          if (target) setSnapshotToRestore(target);
        },
        onClose: () => void closeCurrentProject('project'),
        onExport: openExport,
        onImport: () => activate('file.import'),
        onPhotoLabProductImport: () => setPhotoLabProductImportOpen(true),
        rendererSoftware: rendererStatus.mode === 'software',
        onTryHardwareRenderingAgain: () => {
          void window.himmelcad?.renderer.tryHardwareAgain().catch((error: unknown) => {
            logEvent('error', 'renderer', `Could not restart hardware rendering: ${String(error)}`);
          });
        },
        navigationMode,
        groundExtractionAvailable: selectedGroundCloud !== null,
        segmentationAvailable: segmentablePointClouds.length > 0,
      }),
    [
      closeCurrentProject,
      changeDocumentHistory,
      createProject,
      activate,
      flushProject,
      openProject,
      openExport,
      segmentablePointClouds.length,
      recentProjects,
      replaceProject,
      rendererStatus.mode,
      saveProjectAs,
      selectedGroundCloud,
      snapshots,
    ],
  );

  const statusItems = useMemo(
    () => [
      {
        id: 'durability',
        content: (
          <DurabilityIndicator
            state={
              durability?.state === 'failed'
                ? { kind: 'failed', reason: durability.reason ?? 'Storage failed' }
                : durability?.state === 'stored'
                  ? { kind: 'stored' }
                  : { kind: 'storing' }
            }
            onRetry={() => void flushProject()}
          />
        ),
        align: 'left' as const,
      },
      { id: 'tool', content: activeFunctionId ?? 'Idle', align: 'left' as const },
      { id: 'sel', content: `Selected: ${selected.size}`, align: 'left' as const },
      ...(selection.candidates
        ? [
            {
              id: 'selection-candidates',
              content: (
                <SelectionCandidateIndicator
                  index={selection.candidates.index}
                  count={selection.candidates.items.length}
                />
              ),
              align: 'left' as const,
            },
          ]
        : []),
      {
        id: 'pc',
        content: `Clouds: ${
          Object.values(project?.entities ?? {}).filter((e) => e.kind === 'PointCloud').length
        }`,
        align: 'right' as const,
      },
      {
        id: 'snap',
        content: snap ? `Snap: ${snap.kind}` : 'Snap: —',
        align: 'right' as const,
      },
      {
        id: 'point-size',
        content: `Point: ×${pointSize.toFixed(1)}`,
        align: 'right' as const,
      },
      { id: 'quality', content: 'Quality: adaptive', align: 'right' as const },
      { id: 'units', content: 'm', align: 'right' as const },
      {
        id: 'theme',
        content: (
          <button
            type="button"
            className={styles.themeToggle}
            onClick={() => setThemeMode((mode) => (mode === 'dark' ? 'light' : 'dark'))}
          >
            {themeMode === 'dark' ? 'Light' : 'Dark'}
          </button>
        ),
        align: 'right' as const,
      },
      { id: 'panels', content: <PanelToggles />, align: 'right' as const },
      {
        id: 'jobs',
        content: (
          <LiveJobsStatusChip
            jobs={jobs}
            debounceMs={JOB_CHIP_DEBOUNCE_MS}
            onClick={() => {
              if (registrationItem) setBackgroundedRegistrationJobId(registrationItem.jobId);
              setJobsOpen((open) => !open);
            }}
          />
        ),
        align: 'right' as const,
      },
    ],
    [
      activeFunctionId,
      durability,
      flushProject,
      pointSize,
      project?.entities,
      jobs,
      selected.size,
      selection.candidates,
      snap,
      themeMode,
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
      onMaximizeChange: (cb) => api.window.onMaximizeChange(cb),
    };
  }, []);
  const traverseConstructionBar = useCallback((direction: 1 | -1): void => {
    const fields = constructionBarFields();
    if (fields.length === 0) return;
    const current = fields.indexOf(document.activeElement as HTMLInputElement);
    const next =
      current < 0
        ? direction > 0
          ? 0
          : fields.length - 1
        : (current + direction + fields.length) % fields.length;
    fields[next]?.focus();
    fields[next]?.select();
  }, []);
  const routeConstructionTyping = useCallback(
    (key: string): void => {
      if (!/^[0-9.,+-]$/u.test(key)) return;
      const field =
        (drawToolStore.snapshot().vertices.length > 0
          ? document.querySelector<HTMLInputElement>(
              '[data-construction-input="armed"] input[aria-label="Dist m"]',
            )
          : null) ?? constructionBarFields()[0];
      if (!field) return;
      field.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(field, key);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.setSelectionRange(key.length, key.length);
    },
    [drawToolStore],
  );
  const commitConstructionInput = useCallback((): void => {
    const point = constructionInputStore.commit();
    if (drawToolStore.snapshot().armed) {
      const input = constructionInputStore.snapshot();
      const operation =
        input.mode === 'constrain'
          ? drawToolStore.acceptConstraint(
              input.values.direction,
              input.values.distance,
              input.verticalMode === 'slope'
                ? { kind: 'slope', value: input.values.slope }
                : { kind: 'deltaZ', value: input.values.deltaZ },
            )
          : drawToolStore.acceptTyped(point);
      void operation.catch((error: unknown) =>
        logEvent('error', 'renderer', `Draw vertex failed: ${String(error)}`),
      );
      return;
    }
    if (measurementToolStore.snapshot().armed) {
      void measurementToolStore
        .acceptTyped(point)
        .catch((error: unknown) =>
          logEvent('error', 'renderer', `Measurement failed: ${String(error)}`),
        );
      return;
    }
    const fence = segmentFenceRef.current;
    if (
      activeFunctionId === 'pointcloud.fence.begin' &&
      fence.kind === 'rectangle' &&
      fence.vertices.length === 1 &&
      !fence.closed
    ) {
      const rectangle = viewportRef.current?.typedFenceRectangle(
        fence.vertices[0]!,
        point.x,
        point.y,
      );
      const camera = viewportRef.current?.worldCamera();
      if (!rectangle || !camera) {
        setSegmentError('The viewport camera is not ready for a typed rectangle.');
        return;
      }
      setSegmentFence((current) => ({ ...current, vertices: rectangle }));
      closeSegmentFence(fenceVolumeFromCamera(camera, rectangle));
      return;
    }
    placeViewingBoxAt(point);
  }, [
    activeFunctionId,
    closeSegmentFence,
    constructionInputStore,
    drawToolStore,
    measurementToolStore,
    placeViewingBoxAt,
  ]);
  const acceptConstructionPreview = useCallback((): void => {
    if (drawToolStore.snapshot().armed) {
      void drawToolStore
        .acceptPreview()
        .catch((error: unknown) => logEvent('error', 'renderer', `Draw failed: ${String(error)}`));
      return;
    }
    if (!measurementToolStore.snapshot().armed) return;
    void measurementToolStore
      .acceptPreview()
      .catch((error: unknown) =>
        logEvent('error', 'renderer', `Measurement failed: ${String(error)}`),
      );
  }, [drawToolStore, measurementToolStore]);
  const finishDraw = useCallback(
    async (close: boolean): Promise<void> => {
      const draw = drawToolStore.snapshot();
      if (!draw.armed) return;
      try {
        if (await drawToolStore.finish(close || draw.kind === 'boundary')) {
          constructionInputStore.disarm();
          setConstructionClaimGeneration((generation) => generation + 1);
        }
      } catch (error) {
        logEvent('error', 'renderer', `Draw finish failed: ${String(error)}`);
      }
    },
    [constructionInputStore, drawToolStore],
  );
  const undoDrawVertex = useCallback(async (): Promise<void> => {
    try {
      await drawToolStore.undoVertex();
      setConstructionClaimGeneration((generation) => generation + 1);
    } catch (error) {
      logEvent('error', 'renderer', `Undo vertex failed: ${String(error)}`);
    }
  }, [drawToolStore]);
  const cancelDrawAll = useCallback(async (): Promise<void> => {
    try {
      if (await drawToolStore.cancelAll()) {
        constructionInputStore.disarm();
        if (activeFunctionId) closeFunction(activeFunctionId);
      }
    } catch (error) {
      logEvent('error', 'renderer', `Cancel draw failed: ${String(error)}`);
    }
  }, [activeFunctionId, closeFunction, constructionInputStore, drawToolStore]);
  const cancelConstructionTool = useCallback((): void => {
    if (constructionInputStore.revertField()) {
      setConstructionClaimGeneration((generation) => generation + 1);
      return;
    }
    if (drawToolStore.revertPending()) {
      setConstructionClaimGeneration((generation) => generation + 1);
      return;
    }
    if (drawToolStore.cancel()) {
      constructionInputStore.disarm();
      if (activeFunctionId) closeFunction(activeFunctionId);
      return;
    }
    if (measurementToolStore.cancel()) {
      constructionInputStore.disarm();
      if (activeFunctionId) closeFunction(activeFunctionId);
      return;
    }
    if (
      activeFunctionId === 'pointcloud.fence.begin' ||
      (activeFunctionId === 'mesh.edit.smooth' && surfaceEditRegionSource === 'fence')
    ) {
      const fence = segmentFenceRef.current;
      if (fence.vertices.length > 0 || fence.closed) {
        setSegmentFence({ ...EMPTY_SEGMENT_FENCE, kind: fence.kind });
        constructionInputStore.disarm();
      } else {
        closeFunction(activeFunctionId);
      }
      return;
    }
    setPlacingViewingBoxCenter(false);
  }, [
    activeFunctionId,
    surfaceEditRegionSource,
    closeFunction,
    constructionInputStore,
    drawToolStore,
    measurementToolStore,
  ]);
  useEffect(() => {
    if (
      activeFunctionId !== 'pointcloud.fence.begin' &&
      !(activeFunctionId === 'mesh.edit.smooth' && surfaceEditRegionSource === 'fence')
    )
      return;
    const handle = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (event.key === 'Enter' && !segmentFenceRef.current.closed) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (activeFunctionId === 'pointcloud.fence.begin') closeSegmentFence();
        else {
          const current = segmentFenceRef.current;
          const camera = viewportRef.current?.worldCamera();
          if (!camera || current.vertices.length < 3) return;
          const volume = fenceVolumeFromCamera(camera, current.vertices);
          setSegmentFence({
            ...current,
            closed: true,
            volume,
            entityIds: surfaceEditTargetId ? [surfaceEditTargetId as EntityId] : [],
            scopes: new Map(),
          });
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        const fence = segmentFenceRef.current;
        if (fence.vertices.length === 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        setSegmentFence({
          ...fence,
          vertices: fence.closed ? fence.vertices : fence.vertices.slice(0, -1),
          closed: false,
          volume: null,
          entityIds: [],
          scopes: new Map(),
        });
      }
    };
    window.addEventListener('keydown', handle, true);
    return () => window.removeEventListener('keydown', handle, true);
  }, [activeFunctionId, closeSegmentFence, surfaceEditRegionSource, surfaceEditTargetId]);
  const selectMeasurement = useCallback(
    (entityId: string): void => {
      selectionStore.replace([entityId]);
      setRightPanelTab('properties');
    },
    [selectionStore],
  );
  const deleteMeasurement = useCallback(
    async (entityId: string): Promise<void> => {
      const item = measurementsRef.current.find((candidate) => candidate.entityId === entityId);
      if (!item) return;
      const session = await ensureCanonicalProjectRef.current();
      await session.deleteMeasurement(item.entityId, item.revision);
      selectionStore.pruneDeleted([item.entityId]);
      setProject(session.projectSnapshot());
      setMeasurements(await session.listMeasurements());
      logEvent('info', 'renderer', `Deleted measurement “${item.name}”.`);
    },
    [selectionStore],
  );
  const selectedMeasurement = useMemo(
    () => measurements.find((item) => selected.has(item.entityId as EntityId)) ?? null,
    [measurements, selected],
  );
  void legacyCommand;

  return (
    <>
      <AppShell
        titleBar={
          <TitleBar
            appName="HimmelCAD"
            productLabel="Builder"
            projectLabel={project?.name ?? 'No project'}
            brandMark={<img className={styles.brandLogo} src={builderLogoUrl} alt="" />}
            controls={windowControls}
          />
        }
        ribbon={
          <NavigationModeSubscriber store={navigationModeStore}>
            {(mode) => <Ribbon tabs={fileRibbonTabs(mode)} />}
          </NavigationModeSubscriber>
        }
        leftPanel={
          project ? (
            <EntityTree
              project={project}
              productId="builder"
              selectedIds={selected}
              onSelect={(id, mode) => {
                if (id === ('builder:viewing-boxes' as EntityId)) {
                  activate('view.viewing-box');
                  return;
                }
                if (id === ('builder:measurements' as EntityId)) {
                  activate('measurement.list');
                  return;
                }
                if (viewingBoxes.some((box) => box.entityId === id)) {
                  selectViewingBox(id);
                  activate('view.viewing-box');
                }
                if (measurements.some((item) => item.entityId === id)) {
                  selectMeasurement(id);
                  activate('measurement.list');
                  return;
                }
                onSelect(id, mode);
              }}
              onVisibilityChange={(id, visible) => {
                if (id === ('builder:viewing-boxes' as EntityId)) {
                  if (viewingBox) commitCanonicalViewingBox({ ...viewingBox, enabled: visible });
                  return;
                }
                const summary = viewingBoxes.find((box) => box.entityId === id);
                if (summary) {
                  const state = parseCanonicalViewingBoxState(summary.state);
                  selectViewingBox(id);
                  commitCanonicalViewingBox({ ...state, enabled: visible });
                  return;
                }
                onVisibilityChange(id, visible);
              }}
              interactionState={(entity) => interactionState?.presentation(entity.id) ?? 'editable'}
              onInteractionStateChange={onInteractionStateChange}
              onContextAction={(
                commandId: string,
                entityIds: readonly EntityId[],
              ) => {
                const command = commandById(commandId);
                if (!command) {
                  logEvent('warn', 'renderer', `Unknown entity context command: ${commandId}`);
                  return;
                }
                void executeRegistryCommand({
                  id: command.id,
                  args: [],
                  source: 'contextMenu',
                  payload: contextualPointcloudPayload(entityIds),
                });
              }}
              secondaryLabel={(entity) => {
                const count = pointCloudMetadata.get(entity.id)?.pointCount;
                const published = treeProductProvenance.find(
                  (candidate) => candidate.entityId === entity.id,
                );
                return (
                  <>
                    {count === undefined ? null : formatPointCount(count)}
                    {published ? (
                      <span
                        className={styles.provenanceBadge}
                        title={`Published by PhotoLab · generation ${published.provenance.publicationGeneration} · sha ${published.provenance.packageSha256.slice(0, 5)}…`}
                        aria-label="Published by PhotoLab"
                      >
                        {productGlyph(published.provenance.productKind)}
                      </span>
                    ) : null}
                  </>
                );
              }}
            />
          ) : (
            <div className={styles.properties}>No project open</div>
          )
        }
        rightPanel={
          <FunctionPanel
            activeFunctionId={activeFunctionId}
            closeFunctionTabs
            onCloseFunction={closeFunction}
            title={functionTitle(activeFunctionId)}
            activeTab={rightPanelTab}
            onActiveTabChange={setRightPanelTab}
            detachable={
              (activeFunctionId === 'view.viewing-box' ||
                activeFunctionId === 'pointcloud.fence.begin' ||
                activeFunctionId === 'pointcloud.ground.extract' ||
                activeFunctionId === 'pointcloud.sample' ||
                activeFunctionId === 'pointcloud.rasterize') &&
              rightPanelTab === 'function'
            }
            detached={
              viewingBoxDetached &&
              (activeFunctionId === 'view.viewing-box' ||
                activeFunctionId === 'pointcloud.fence.begin' ||
                activeFunctionId === 'pointcloud.ground.extract' ||
                activeFunctionId === 'pointcloud.sample' ||
                activeFunctionId === 'pointcloud.rasterize') &&
              rightPanelTab === 'function'
            }
            onDetachedChange={setViewingBoxDetached}
            propertiesTitle={
              selected.size > 1
                ? `${selected.size} selected`
                : selected.size === 1
                  ? project?.entities[[...selected][0]!]?.name
                  : undefined
            }
            properties={
              selectedMeasurement ? (
                <MeasurementProperties
                  measurement={selectedMeasurement}
                  pixelsPerMetre={measurementPixelsPerMetre(
                    viewportRef.current?.worldCamera() ?? null,
                    viewportRef.current?.captureRectangle()?.height ?? window.innerHeight,
                  )}
                />
              ) : (
                <BuilderPropertiesPanel
                  selectedCount={selected.size}
                  perKind={selectionKindCounts(selected, project)}
                  query={propertyQuery}
                  loading={propertyQueryLoading}
                  editing={propertyEditing}
                  error={propertyQueryError}
                  onAssign={(assignment) => void assignSelectionProperty(assignment)}
                  pointCloudStyles={
                    selectedPointClouds.length === selected.size
                      ? selectedPointClouds.map(({ metadata }) => metadata.display)
                      : []
                  }
                  productProvenance={productProvenance}
                  onPointCloudDisplayChange={(display) =>
                    void setSelectedPointCloudDisplay(display)
                  }
                />
              )
            }
          >
            {isMeasurementFunction(activeFunctionId) ? (
              <MeasurementPanel
                tool={measurementTool}
                measurements={measurements}
                selectedId={selectedMeasurement?.entityId ?? null}
                pixelsPerMetre={measurementPixelsPerMetre(
                  viewportRef.current?.worldCamera() ?? null,
                  viewportRef.current?.captureRectangle()?.height ?? window.innerHeight,
                )}
                onMetricChange={(metric) => measurementToolStore.setDistanceMetric(metric)}
                onSelect={selectMeasurement}
                onDelete={(entityId) => void deleteMeasurement(entityId)}
              />
            ) : isDrawFunction(activeFunctionId) ? (
              <DrawPanel
                tool={drawTool}
                constructionPreview={constructionInput.preview}
                snapKinds={drawSnapKinds}
                onRoleChange={(role) => drawToolStore.setRole(role)}
                onSnapKindChange={(kind, enabled) =>
                  setDrawSnapKinds((current) => ({ ...current, [kind]: enabled }))
                }
                onFinish={() => void finishDraw(false)}
                onClose={() => void finishDraw(true)}
                onUndoVertex={() => void undoDrawVertex()}
                onCancel={() => void cancelDrawAll()}
              />
            ) : activeFunctionId === 'mesh.edit.smooth' && canonicalSessionRef.current ? (
              <SurfaceEditPanel
                session={canonicalSessionRef.current}
                target={surfaceEditTarget}
                fencePolygon={
                  surfaceEditRegionSource === 'fence' && segmentFence.closed
                    ? segmentFence.vertices.map((point) => [point.x, point.y] as const)
                    : null
                }
                boundaries={surfaceBoundaryCandidates}
                onRegionSourceChange={(source) => {
                  setSurfaceEditRegionSource(source);
                  setSurfaceEditPreview(null);
                  setSurfaceEditBoundaryRegion(null);
                  setSegmentFence((current) => ({ ...EMPTY_SEGMENT_FENCE, kind: current.kind }));
                }}
                onRegionWorldPolygonChange={setSurfaceEditBoundaryRegion}
                onPreview={setSurfaceEditPreview}
                onPublished={(result) => {
                  selectionStore.replace([result.entityId as EntityId]);
                  setPropertyRefresh((revision) => revision + 1);
                  void reloadCanonicalResidency();
                }}
                onLog={(message) => logEvent('info', 'renderer', message)}
              />
            ) : activeFunctionId === 'pointcloud.fence.begin' ? (
              <PointcloudSegmentPanel
                fenceKind={segmentFence.kind}
                vertexCount={segmentFence.vertices.length}
                area={segmentFenceArea(segmentFence)}
                closed={segmentFence.closed}
                appliesTo={segmentFence.entityIds.length}
                activeJob={activeSegmentJob}
                error={segmentError}
                onFenceKindChange={(kind) => setSegmentFence({ ...EMPTY_SEGMENT_FENCE, kind })}
                onKeepInside={() => void runSegmentation('keep_inside')}
                onRemoveInside={() => void runSegmentation('remove_inside')}
                onClearFence={() => {
                  constructionInputStore.disarm();
                  setSegmentFence((current) => ({ ...EMPTY_SEGMENT_FENCE, kind: current.kind }));
                }}
                onCancel={(jobId) => void window.himmelcad?.jobs.cancel(jobId)}
              />
            ) : activeFunctionId === 'pointcloud.ground.extract' ? (
              <GroundExtractionPanel
                sourceName={
                  selectedGroundCloud
                    ? (project?.entities[selectedGroundCloud.entityId]?.name ?? null)
                    : null
                }
                activeJob={activeGroundJob}
                preview={groundPreview}
                result={groundResult}
                error={groundError}
                onPreview={(parameters) => void runGroundOperation('preview', parameters)}
                onExtract={(parameters) => void runGroundOperation('extract', parameters)}
                onCancel={(jobId) => void window.himmelcad?.jobs.cancel(jobId)}
                onCreateSurface={(entityId) => {
                  selectionStore.replace([entityId]);
                  activate('mesh.surface.create');
                }}
              />
            ) : activeFunctionId === 'pointcloud.sample' ||
              activeFunctionId === 'pointcloud.rasterize' ? (
              <PointcloudSamplingPanel
                mode={activeFunctionId === 'pointcloud.sample' ? 'sample' : 'rasterize'}
                sourceName={
                  selectedGroundCloud
                    ? (project?.entities[selectedGroundCloud.entityId]?.name ?? null)
                    : null
                }
                sourcePoints={selectedGroundCloud?.metadata.pointCount ?? null}
                activeJob={activePointcloudProcessingJob}
                sampleResult={sampleResult}
                rasterizeResult={rasterizeResult}
                error={pointcloudProcessingError}
                onSample={(parameters) => void runPointcloudProcessing('sample', parameters)}
                onRasterize={(parameters) => void runPointcloudProcessing('rasterize', parameters)}
                onCancel={(jobId) => void window.himmelcad?.jobs.cancel(jobId)}
              />
            ) : (
              functionBody(
                activeFunctionId,
                pointSize,
                setPointSize,
                viewingBox,
                commitCanonicalViewingBox,
                placingViewingBoxCenter,
                setPlacingViewingBoxCenter,
                viewingBoxes,
                viewingBoxName,
                selected.size,
                selectViewingBox,
                createViewingBoxFromSelection,
                createViewingBoxFromTypedExtents,
                renameViewingBox,
                (locked) => void setViewingBoxLocked(locked),
                () => void deleteViewingBox(),
                viewingBoxBakeProgress,
              )
            )}
          </FunctionPanel>
        }
        bottomPanel={
          <Console
            defaultLevel="info"
            onCommand={registryConsoleCommand}
            onCollapse={toggleBottom}
          />
        }
        viewport={
          <ViewportInteractionChrome
            constructionBar={
              constructionInput.armed ? (
                <ConstructionBar
                  prompt={constructionInput.declaration?.prompt ?? ''}
                  fields={constructionInputStore.fields()}
                  activeField={constructionInput.activeField}
                  {...(selection.candidates
                    ? {
                        candidateIndex: selection.candidates.index,
                        candidateCount: selection.candidates.items.length,
                      }
                    : {})}
                  detached={constructionDetached}
                  onDetachedChange={setConstructionDetached}
                  onFieldFocus={(field) => constructionInputStore.focus(field)}
                  onFieldChange={(field, value) => constructionInputStore.setField(field, value)}
                  onFieldCommit={(field, value) => constructionInputStore.setField(field, value)}
                  onCommit={(field) => {
                    // Direction Enter locks the snapped heading. Length (or an
                    // absolute coordinate/vertical field) completes the point.
                    if (drawToolStore.snapshot().armed && field === 'direction') return;
                    commitConstructionInput();
                  }}
                  onCycleCandidate={(direction) => viewportRef.current?.cycleCandidate(direction)}
                />
              ) : undefined
            }
            bottomBar={
              <NavigationModeSubscriber store={navigationModeStore}>
                {(mode) => (
                  <ViewportBottomBar
                    state={{
                      supportGeometry: display.state.supportOverlay,
                      granularity: selection.granularity,
                      viewMode: mode,
                      selectableKinds: selection.selectableKinds,
                      labels: display.state.labels,
                    }}
                    renderer={
                      rendererStatus.mode === 'software'
                        ? {
                            label: 'Software rendering',
                            title: `${rendererStatus.gpu} · driver ${rendererStatus.driver} · ${rendererStatus.reason}`,
                            degraded: true,
                          }
                        : {
                            label: 'Hardware rendering',
                            title: 'Hardware-accelerated renderer',
                            degraded: false,
                          }
                    }
                    onSupportGeometryChange={(value) => displayStore.setSupportOverlay(value)}
                    onExplodePolylinesChange={(value) =>
                      selectionStore.setGranularity(value ? 'segments' : 'whole')
                    }
                    onViewModeChange={(nextMode) => {
                      void viewportRef.current?.setViewMode(nextMode);
                    }}
                    onSelectableKindChange={(kind, value) =>
                      selectionStore.setSelectableKind(kind, value)
                    }
                    onLabelsChange={(value) => displayStore.setLabels(value)}
                  />
                )}
              </NavigationModeSubscriber>
            }
          >
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
              <BuilderKernelViewport
                ref={viewportRef}
                backendFallback={backendFallback}
                pointSize={pointSize}
                onViewModeSettled={settleNavigationMode}
                onCursorSnap={(nextSnap) => {
                  setSnap(nextSnap);
                  if (drawToolStore.snapshot().armed) {
                    const source = nextSnap?.entity
                      ? canonicalSessionRef.current?.canonicalEntity(nextSnap.entity)
                      : null;
                    const enabled = nextSnap ? drawSnapEnabled(nextSnap, drawSnapKinds) : false;
                    drawToolStore.pointer(
                      nextSnap?.position.z != null && nextSnap.target?.exact && source && enabled
                        ? {
                            kind: 'pick',
                            point: {
                              x: nextSnap.position.x,
                              y: nextSnap.position.y,
                              z: nextSnap.position.z,
                            },
                            snapKind: drawSnapLabel(nextSnap),
                            sourceEntityId: source.id,
                            sourceRevision: source.revision,
                            providerId: nextSnap.target.datasetKind,
                            primitiveAddress: JSON.stringify(nextSnap.target.primitive),
                          }
                        : null,
                    );
                  }
                  if (
                    constructionInputStore.snapshot().armed &&
                    constructionInputStore.snapshot().declaration?.toolId !==
                      'pointcloud.fence.rectangle.extents' &&
                    (!drawToolStore.snapshot().armed ||
                      (nextSnap !== null && drawSnapEnabled(nextSnap, drawSnapKinds))) &&
                    nextSnap?.position.z !== null &&
                    nextSnap?.position.z !== undefined
                  ) {
                    constructionInputStore.pointer({
                      x: nextSnap.position.x,
                      y: nextSnap.position.y,
                      z: nextSnap.position.z,
                    });
                  }
                  if (measurementToolStore.snapshot().armed) {
                    let anchor = null;
                    if (nextSnap?.target?.exact && nextSnap.entity) {
                      const source = canonicalSessionRef.current?.canonicalEntity(nextSnap.entity);
                      if (source) {
                        try {
                          anchor = attachedMeasurementAnchor(nextSnap, source);
                        } catch (error) {
                          logEvent(
                            'warn',
                            'renderer',
                            `Snap cannot anchor a measurement: ${String(error)}`,
                          );
                        }
                      }
                    }
                    measurementToolStore.pointer(anchor);
                  }
                }}
                selectedEntityIds={selected}
                onSelectEntity={(id, mode) => {
                  const kind = projectRef.current?.entities[id]?.kind;
                  if (kind === 'PointCloud' || kind === 'GaussianSplatCloud') return;
                  onSelect(id, mode);
                }}
                onClearSelection={() => selectionStore.clear()}
                isEntityClickPickable={(id) => {
                  const entity = projectRef.current?.entities[id];
                  return Boolean(
                    entity &&
                    interactionState?.effective(id).selectable &&
                    selectionStore.isKindSelectable(entity.kind),
                  );
                }}
                isEntitySnappable={(id) => interactionState?.effective(id).snappable ?? false}
                isEntitySelectionHighlightable={(id) => {
                  const kind = projectRef.current?.entities[id]?.kind;
                  return kind !== 'PointCloud' && kind !== 'GaussianSplatCloud';
                }}
                onCandidateSet={(candidates, index) =>
                  selectionStore.setCandidates(
                    candidates.map((candidate) => {
                      const entityId = candidate.address.entityId as EntityId;
                      const entity = projectRef.current?.entities[entityId];
                      return {
                        entityId,
                        name: entity?.name ?? entityId,
                        kind: entity?.kind ?? 'Object',
                      };
                    }),
                    index,
                  )
                }
                onCandidateSetClear={() => selectionStore.invalidateCandidates('viewportBlur')}
                onContextSurface={(candidate, position) => {
                  if (candidate) selectionStore.replace([candidate.address.entityId as EntityId]);
                  setCommandSurface({ kind: candidate ? 'entity' : 'void', ...position });
                }}
                onRegistryShortcut={(event) =>
                  void dispatchRegistryShortcut(event, commandContext, executeRegistryCommand)
                }
                {...(project ? { projectId: currentProjectPath ?? project.projectId } : {})}
                hudVisible={hudVisible}
                viewingBox={viewingBox}
                viewingBoxName={viewingBoxName}
                viewingBoxPanelOpen={
                  activeFunctionId === 'view.viewing-box' && rightPanelTab === 'function'
                }
                onOpenViewingBox={() => {
                  activate('view.viewing-box');
                  setRightPanelTab('function');
                }}
                viewingBoxEditing={
                  activeFunctionId === 'view.viewing-box' &&
                  !placingViewingBoxCenter &&
                  (viewingBox?.lockMode ?? 'unlocked') === 'unlocked'
                }
                placingViewingBoxCenter={placingViewingBoxCenter}
                constructionToolId={
                  activeFunctionId === 'pointcloud.fence.begin' ||
                  activeFunctionId === 'mesh.edit.smooth'
                    ? null
                    : (constructionInput.declaration?.toolId ?? null)
                }
                constructionOrigin={drawTool.vertices.at(-1)?.point ?? null}
                onConstructionTab={traverseConstructionBar}
                onConstructionTyping={routeConstructionTyping}
                onConstructionCancel={cancelConstructionTool}
                onConstructionClick={acceptConstructionPreview}
                onConstructionFinish={() => void finishDraw(false)}
                onConstructionUndo={() => void undoDrawVertex()}
                onViewportPoint={placeViewingBoxAt}
                onViewportBox={createViewingBoxFromViewportDrag}
                onViewingBoxChange={commitCanonicalViewingBox}
                fence={
                  activeFunctionId === 'pointcloud.fence.begin' ||
                  (activeFunctionId === 'mesh.edit.smooth' && surfaceEditRegionSource === 'fence')
                    ? {
                        kind: segmentFence.kind,
                        vertices: segmentFence.vertices,
                        closed: segmentFence.closed,
                      }
                    : null
                }
                onFenceVertex={(point) => {
                  setSegmentFence((current) => ({
                    ...current,
                    vertices: current.closed ? current.vertices : [...current.vertices, point],
                  }));
                }}
                onFenceRectangle={(vertices) => {
                  setSegmentFence((current) => ({
                    ...current,
                    vertices,
                    closed: false,
                    volume: null,
                    entityIds: [],
                    scopes: new Map(),
                  }));
                }}
                onFenceClose={(volume) => {
                  if (activeFunctionId === 'mesh.edit.smooth') {
                    const current = segmentFenceRef.current;
                    setSegmentFence({
                      ...current,
                      vertices:
                        current.vertices.length >= 3
                          ? current.vertices
                          : fenceVolumeVertices(volume),
                      closed: true,
                      volume,
                      entityIds: surfaceEditTargetId ? [surfaceEditTargetId as EntityId] : [],
                      scopes: new Map(),
                    });
                    constructionInputStore.disarm();
                    logEvent('info', 'renderer', 'Surface edit region fence captured.');
                  } else {
                    closeSegmentFence(volume);
                  }
                }}
                onFenceCancel={cancelConstructionTool}
                onFenceKey={(key) => {
                  if (key === 'Tab' || key === 'Shift+Tab') {
                    traverseConstructionBar(key === 'Tab' ? 1 : -1);
                  } else {
                    routeConstructionTyping(key);
                  }
                }}
                onFenceNavigationRejected={() =>
                  logEvent(
                    'info',
                    'renderer',
                    'Finish or cancel the open fence before changing the camera.',
                  )
                }
                onDropFiles={(paths) => void registerImports(paths)}
                onLog={(level, message) => logEvent(level, 'renderer', message)}
              />
              <MeasurementViewportOverlay
                viewport={viewportRef.current}
                measurements={measurements.filter(
                  (item) => project?.entities[item.entityId]?.visibility.visible !== false,
                )}
                tool={measurementTool}
                selected={selected}
                onSelect={selectMeasurement}
              />
              <DrawViewportOverlay
                viewport={viewportRef.current}
                tool={drawTool}
                curves={drawCurves}
                supportVisible={display.state.supportOverlay}
                constructionPreview={constructionInput.preview}
              />
              <GroundPreviewOverlay viewport={viewportRef.current} result={groundPreview} />
              <SurfaceEditViewportOverlay
                viewport={viewportRef.current}
                preview={surfaceEditPreview}
                region={
                  surfaceEditRegionSource === 'fence' && segmentFence.closed
                    ? segmentFence.vertices.map((point) => [point.x, point.y, point.z] as const)
                    : surfaceEditBoundaryRegion
                }
              />
            </div>
          </ViewportInteractionChrome>
        }
        floatingLeftTabs
        floatingRightTabs
        statusBar={<StatusBar items={statusItems} />}
      />
      {window.himmelcad ? (
        <ManagedAutomationApproval transport={window.himmelcad.agentHarness} />
      ) : null}
      {specsOpen ? (
        <FloatingTaskIsland onRequestClose={() => setSpecsOpen(false)}>
          <SpecsIsland onClose={() => setSpecsOpen(false)} />
        </FloatingTaskIsland>
      ) : null}
      {planOpen ? (
        <FloatingTaskIsland onRequestClose={() => setPlanOpen(false)}>
          <PlanIsland onClose={() => setPlanOpen(false)} />
        </FloatingTaskIsland>
      ) : null}
      {dgmOpen && canonicalSessionRef.current ? (
        <FloatingTaskIsland onRequestClose={() => setDgmOpen(false)}>
          <DgmCreationWindow
            session={canonicalSessionRef.current}
            candidates={dgmCandidates}
            onClose={() => setDgmOpen(false)}
            onPublished={(surface) => {
              setPropertyRefresh((revision) => revision + 1);
              void reloadCanonicalResidency();
              logEvent(
                'info',
                'renderer',
                `mesh.surface.create · ${surface.triangles.toLocaleString()} triangles · ${surface.area.toFixed(2)} m² · Z ${surface.zRange[0].toFixed(2)}–${surface.zRange[1].toFixed(2)} m`,
              );
            }}
          />
        </FloatingTaskIsland>
      ) : null}
      {exportMounted && canonicalSessionRef.current && project ? (
        <FloatingTaskIsland
          hidden={!exportOpen}
          docked={exportDetached ? false : 'right'}
          onRequestClose={() => setExportOpen(false)}
        >
          <BuilderExportIsland
            key={project.projectId}
            session={canonicalSessionRef.current}
            entities={Object.values(project.entities)
              .filter((entity) => isExportScopeEntity(entity.kind))
              .map((entity) => ({
                id: entity.id,
                kind: entity.kind,
                ...(measurements.some((measurement) => measurement.entityId === entity.id)
                  ? { label: 'Measurement' }
                  : {}),
              }))}
            selectedIds={[...selected]}
            visibleIds={Object.values(project.entities)
              .filter(
                (entity) =>
                  isExportScopeEntity(entity.kind) &&
                  displayStore.effective(entity.id) !== 'hidden',
              )
              .map((entity) => entity.id)}
            initialScope={exportInitialScope}
            detached={exportDetached}
            onDetachedChange={setExportDetached}
            onClose={() => setExportOpen(false)}
            onConsole={(level, message) => logEvent(level, 'renderer', message)}
          />
        </FloatingTaskIsland>
      ) : null}
      {agentOpen && window.himmelcad ? (
        <FloatingTaskIsland onRequestClose={() => setAgentOpen(false)}>
          <ManagedAgentChat
            transport={window.himmelcad.agentHarness}
            providerCredentials={window.himmelcad.providerCredentials}
          />
        </FloatingTaskIsland>
      ) : null}
      {jobsOpen && window.himmelcad ? (
        <FloatingTaskIsland onRequestClose={() => setJobsOpen(false)}>
          <LiveJobsIsland
            jobs={jobs.map((job) =>
              typeof job.context?.productGlyph === 'string'
                ? { ...job, label: `${job.context.productGlyph} ${job.label}` }
                : job,
            )}
            completedRetentionMs={JOB_COMPLETED_RETENTION_MS}
            onCancel={(id) => void window.himmelcad?.jobs.cancel(id)}
            onRespond={(id) => {
              void window.himmelcad?.jobs.respond(id).then((job) => {
                const sourcePath = job.context?.sourcePath;
                if (typeof sourcePath !== 'string') return;
                setRegistrationItems((current) => [
                  { jobId: job.id, sourcePath },
                  ...current.filter((item) => item.jobId !== job.id),
                ]);
                setForegroundRegistrationJobId(job.id);
                setJobsOpen(false);
              });
            }}
            onClearFinished={() => void window.himmelcad?.jobs.clearFinished()}
          />
        </FloatingTaskIsland>
      ) : null}
      {registrationSourcePath && canonicalSessionRef.current ? (
        <FloatingTaskIsland
          hidden={
            backgroundedRegistrationJobId === registrationItem!.jobId ||
            jobs.find((job) => job.id === registrationItem!.jobId)?.state === 'running' ||
            jobs.find((job) => job.id === registrationItem!.jobId)?.state === 'cancelling'
          }
          onRequestClose={() => undefined}
        >
          <BuilderImportRegistrationIsland
            jobId={registrationItem!.jobId}
            sourcePath={registrationSourcePath}
            projectLabel={project?.name ?? 'Current project'}
            session={canonicalSessionRef.current}
            onBackgroundStateChange={(backgrounded) => {
              setBackgroundedRegistrationJobId(backgrounded ? registrationItem!.jobId : null);
              if (backgrounded) {
                setForegroundRegistrationJobId(
                  registrationItems.find((item) => item.jobId !== registrationItem!.jobId)?.jobId ??
                    null,
                );
              }
            }}
            onCommitted={async () => {
              await reloadCanonicalResidency();
              await viewportRef.current?.waitForNextPresentedFrame();
              logEvent('info', 'renderer', 'Registered import committed and loaded');
            }}
            onClose={() => {
              setBackgroundedRegistrationJobId(null);
              setRegistrationItems((current) =>
                current.filter((item) => item.jobId !== registrationItem!.jobId),
              );
              setForegroundRegistrationJobId((current) =>
                current === registrationItem!.jobId ? null : current,
              );
            }}
          />
        </FloatingTaskIsland>
      ) : null}
      {photoLabProductImportOpen && canonicalSessionRef.current ? (
        <FloatingTaskIsland modal onRequestClose={() => setPhotoLabProductImportOpen(false)}>
          <BuilderPhotoLabProductImportIsland
            session={canonicalSessionRef.current}
            onCommitted={async () => {
              await reloadCanonicalResidency();
              await viewportRef.current?.waitForNextPresentedFrame();
              logEvent('info', 'renderer', 'PhotoLab product import committed and rendered');
            }}
            onClose={() => setPhotoLabProductImportOpen(false)}
          />
        </FloatingTaskIsland>
      ) : null}
      <Dialog
        open={snapshotToRestore !== null}
        onClose={() => {
          if (!snapshotRestorePending) setSnapshotToRestore(null);
        }}
        title="Restore snapshot?"
        actions={
          <>
            <Button
              variant="secondary"
              disabled={snapshotRestorePending}
              onClick={() => setSnapshotToRestore(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={snapshotRestorePending}
              onClick={() => void restoreSnapshot()}
            >
              Restore
            </Button>
          </>
        }
      >
        <span>
          Restore snapshot '{snapshotToRestore?.name}'? Later changes stay in the journal and can be
          redone.
        </span>
      </Dialog>
      <ToastRegion>
        {closeMode ? (
          <Toast
            tone="info"
            autoDismiss={false}
            action={
              <Button
                size="small"
                variant="quiet"
                onClick={() => {
                  closeCancelledRef.current = true;
                }}
              >
                Cancel
              </Button>
            }
          >
            Storing changes before closing…
          </Toast>
        ) : null}
        {recoveryToast ? (
          <Toast
            tone="warning"
            autoDismiss={false}
            action={
              <Button size="small" variant="quiet" onClick={toggleBottom}>
                Show in console
              </Button>
            }
            onDismiss={() => setRecoveryToast(null)}
          >
            {recoveryToast}
          </Toast>
        ) : null}
        {projectReplacementFailure ? (
          <Toast
            tone="error"
            autoDismiss={false}
            action={
              <Button
                size="small"
                variant="quiet"
                onClick={() => void replaceProject(projectReplacementFailure.targetRoot)}
              >
                Retry open
              </Button>
            }
            onDismiss={() => setProjectReplacementFailure(null)}
          >
            Could not open project — {projectReplacementFailure.reason}.
            {projectReplacementFailure.recoveredRoot
              ? ' The previous project is still open.'
              : projectReplacementFailure.recoveryReason
                ? ` Recovery failed: ${projectReplacementFailure.recoveryReason}`
                : ' Choose Retry open after correcting the problem.'}
          </Toast>
        ) : null}
        {durabilityFailureToast && durability?.state === 'failed' ? (
          <Toast
            tone="error"
            autoDismiss={false}
            action={
              <Button size="small" variant="quiet" onClick={() => void flushProject()}>
                Retry
              </Button>
            }
            onDismiss={() => setDurabilityFailureToast(false)}
          >
            Not stored — {durability.reason ?? 'Storage failed'}. Changes remain queued.
          </Toast>
        ) : null}
        {jobToasts.map((job) => (
          <Toast
            key={job.id}
            tone={
              job.state === 'failed' ? 'error' : job.state === 'cancelled' ? 'warning' : 'success'
            }
            action={
              <Button
                size="small"
                variant="quiet"
                onClick={() => {
                  if (
                    job.state === 'completed' &&
                    job.owner === 'builder.export' &&
                    typeof job.context?.targetPath === 'string'
                  ) {
                    void window.himmelcad?.shell.showItemInFolder(job.context.targetPath);
                  } else if (job.state === 'completed') viewportRef.current?.frameAll();
                  else toggleBottom();
                }}
              >
                {job.state === 'completed' && job.owner === 'builder.export'
                  ? 'Show in folder'
                  : job.state === 'completed'
                    ? 'Frame'
                    : 'Console'}
              </Button>
            }
            onDismiss={() =>
              setJobToasts((current) => current.filter((item) => item.id !== job.id))
            }
          >
            {job.state === 'failed'
              ? `${job.label} failed. The canonical project remains safe.`
              : job.state === 'cancelled'
                ? `${job.label} cancelled`
                : (job.resultLabel ?? `${job.label} completed`)}
          </Toast>
        ))}
      </ToastRegion>
      {commandSurface?.kind === 'entity' ? (
        <EntityCommandMenu
          x={commandSurface.x}
          y={commandSurface.y}
          context={commandContext}
          target={{
            entityIds: commandContext.selectedEntityIds,
            kind: commandContext.entityKind ?? 'Object',
          }}
          {...(selection.candidates?.items[selection.candidates.index]?.entityId
            ? {
                currentCandidateId:
                  selection.candidates.items[selection.candidates.index]!.entityId,
              }
            : {})}
          onExecute={(commandId, target) =>
            executeRegistryCommand({
              id: commandId,
              args: [],
              source: 'contextMenu',
              payload: {
                ...target,
                ...contextualPointcloudPayload(target.entityIds),
              },
            })
          }
          onClose={() => setCommandSurface(null)}
        />
      ) : commandSurface?.kind === 'void' ? (
        <QuickCommandSurface
          x={commandSurface.x}
          y={commandSurface.y}
          context={commandContext}
          onExecute={executeRegistryCommand}
          onClose={() => setCommandSurface(null)}
        />
      ) : null}
    </>
  );
}

function functionTitle(id: string | null): string | undefined {
  if (!id) return undefined;
  if (id === 'measure.point') return 'Measure point';
  if (id === 'measure.distance') return 'Measure distance';
  if (id === 'measure.dz') return 'Measure height difference';
  if (id === 'measurement.list' || id === 'measurements.panel') return 'Measurements';
  if (id === 'view.performance') return 'point cloud performance';
  if (id === 'view.point-size') return 'point size';
  if (id === 'view.viewing-box') return 'Viewing Box';
  if (id === 'pointcloud.ground.extract') return 'Extract ground';
  if (id === 'pointcloud.fence.begin') return 'Segment';
  if (id === 'pointcloud.sample') return 'Sample';
  if (id === 'pointcloud.rasterize') return 'Rasterize mean height';
  if (id === 'mesh.edit.smooth') return 'Edit surface';
  return id.replace(/[._:-]/g, ' ');
}

function measurementKindForFunction(id: string | null): MeasurementToolKind | null {
  if (id === 'measure.point') return 'point';
  if (id === 'measure.distance') return 'distance';
  if (id === 'measure.dz') return 'heightDifference';
  return null;
}

function drawKindForFunction(id: string | null): DrawToolKind | null {
  if (id === 'draw.line') return 'line';
  if (id === 'draw.polyline') return 'polyline';
  if (id === 'draw.boundary') return 'boundary';
  return null;
}

function isDrawFunction(id: string | null): boolean {
  return drawKindForFunction(id) !== null;
}

function drawKindLabel(kind: DrawToolKind): string {
  return kind === 'line' ? 'Line' : kind === 'polyline' ? 'Polyline' : 'Boundary polygon';
}

function drawSnapLabel(snap: SnapResult): DrawSnapKind | null {
  if (snap.source === 'point-cloud') return 'cloudPoint';
  const semantic = snap.candidateId?.split(':', 1)[0];
  if (semantic === 'midpoint') return 'mid';
  if (semantic === 'intersection') return 'intersection';
  if (semantic === 'perpendicular') return 'perpendicular';
  if (snap.kind === 'Point') return 'point';
  if (snap.kind === 'Vertex') return 'end';
  return null;
}

function drawSnapEnabled(
  snap: SnapResult,
  enabled: Readonly<Record<DrawSnapKind, boolean>>,
): boolean {
  const kind = drawSnapLabel(snap);
  return kind !== null && enabled[kind];
}

function drawVerticesFromPayload(value: unknown): readonly {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('vertices must be an array of XYZ coordinates.');
  return value.map((item) => drawPointFromPayload(item));
}

function drawPointFromPayload(value: unknown): {
  readonly x: number;
  readonly y: number;
  readonly z: number;
} {
  if (!value || typeof value !== 'object')
    throw new TypeError('Draw vertex must be an XYZ object.');
  const point = value as Record<string, unknown>;
  return {
    x: finiteNumber(point.x, 'x'),
    y: finiteNumber(point.y, 'y'),
    z: finiteNumber(point.z, 'z'),
  };
}

function drawRoleFromPayload(value: unknown, kind: DrawToolKind): DrawRole {
  if (kind === 'boundary') return 'boundary';
  if (value === undefined) return 'plain';
  if (value === 'plain' || value === 'breakline') return value;
  throw new TypeError('Draw role must be plain or breakline for this tool.');
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite.`);
  }
  return value;
}

function isMeasurementFunction(id: string | null): boolean {
  return (
    measurementKindForFunction(id) !== null ||
    id === 'measurement.list' ||
    id === 'measurements.panel'
  );
}

function measurementKindLabel(kind: MeasurementToolKind): string {
  if (kind === 'heightDifference') return 'Height difference';
  return kind === 'point' ? 'Point' : 'Distance';
}

function measurementKindForMethod(method: string): MeasurementToolKind | null {
  if (method === 'measure.point') return 'point';
  if (method === 'measure.distance') return 'distance';
  if (method === 'measure.dz') return 'heightDifference';
  return null;
}

function isMeasurementPayload(value: unknown): value is MeasurementV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MeasurementV1>;
  return (
    candidate.schemaId === 'hcad.measurement@1' &&
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.anchors) &&
    ['point', 'distance', 'heightDifference'].includes(String(candidate.measurementKind))
  );
}

function admissionResult(payload: unknown): {
  readonly schemaId: string;
  readonly payload: unknown;
} {
  return { schemaId: 'hcad.admission-operation-result@1', payload };
}

function groundResultEnvelope(result: GroundPreviewResult | GroundExtractionResult): {
  readonly schemaId: string;
  readonly payload: unknown;
} {
  const { schemaId, ...payload } = result;
  return { schemaId, payload };
}

function pointcloudProcessingResultEnvelope(
  result: PointcloudSampleResult | PointcloudRasterizeResult,
): { readonly schemaId: string; readonly payload: unknown } {
  const { schemaId, ...payload } = result;
  return { schemaId, payload };
}

function measurementAnchorConstructionPoint(
  anchor: Parameters<typeof measurementAnchorPosition>[0],
): { readonly x: number; readonly y: number; readonly z: number } | undefined {
  const point = measurementAnchorPosition(anchor);
  return point.z === null ? undefined : { x: point.x, y: point.y, z: point.z };
}

function measurementPixelsPerMetre(
  camera: KernelWorldCamera | null,
  viewportHeight: number,
): number {
  if (!camera || !(viewportHeight > 0)) return 1;
  if (camera.projection.kind === 'orthographic') {
    return viewportHeight / camera.projection.verticalSpan;
  }
  const dx = camera.target.x - camera.eye.x;
  const dy = camera.target.y - camera.eye.y;
  const dz = camera.target.z - camera.eye.z;
  const distance = Math.hypot(dx, dy, dz);
  return viewportHeight / (2 * distance * Math.tan(camera.projection.verticalFovRadians / 2));
}

function functionBody(
  id: string | null,
  pointSize: number,
  onPointSizeChange: (value: number) => void,
  viewingBox: KernelViewingBoxState | null,
  onViewingBoxChange: (value: KernelViewingBoxState | null) => void,
  placingViewingBoxCenter: boolean,
  onPlacingViewingBoxCenterChange: (value: boolean) => void,
  viewingBoxes: readonly BuilderViewingBoxSummary[],
  viewingBoxName: string,
  selectedCount: number,
  onSelectViewingBox: (entityId: string) => void,
  onCreateFromSelection: () => void,
  onCreateFromTypedExtents: (
    center: { readonly x: number; readonly y: number; readonly z: number },
    size: { readonly x: number; readonly y: number; readonly z: number },
  ) => void,
  onRename: (name: string) => void,
  onLockChange: (locked: boolean) => void,
  onRemove: () => void,
  bakeProgress: { readonly fraction: number; readonly phase: string } | null,
): ReactNode {
  if (!id) return null;
  if (id === 'view.performance' || id === 'view.point-size') {
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <label style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
          <span style={{ color: 'var(--hc-fg-muted)', fontSize: 12 }}>Point size multiplier</span>
          <output style={{ color: 'var(--hc-fg)', fontSize: 12 }}>×{pointSize.toFixed(1)}</output>
          <input
            type="range"
            min={0.25}
            max={8}
            step={0.1}
            value={pointSize}
            onChange={(event) =>
              onPointSizeChange(clamp(Number(event.currentTarget.value), 0.25, 20))
            }
            style={{ gridColumn: '1 / -1' }}
          />
        </label>
      </div>
    );
  }
  if (id === 'view.viewing-box') {
    return (
      <ViewingBoxPanel
        state={viewingBox}
        boxes={viewingBoxes}
        name={viewingBoxName}
        selectedCount={selectedCount}
        placingCenter={placingViewingBoxCenter}
        bakeProgress={bakeProgress}
        onChange={onViewingBoxChange}
        onSelect={onSelectViewingBox}
        onCreateFromSelection={onCreateFromSelection}
        onCreateFromTypedExtents={onCreateFromTypedExtents}
        onRename={onRename}
        onLockChange={onLockChange}
        onRemove={onRemove}
        onPlacingCenterChange={onPlacingViewingBoxCenterChange}
      />
    );
  }
  return (
    <div style={{ color: 'var(--hc-fg-muted)', fontSize: 12, lineHeight: 1.6 }}>
      Parameters for <code>{id}</code> appear here once the function ships.
    </div>
  );
}

interface BuilderPropertiesPanelProps {
  readonly selectedCount: number;
  readonly perKind: Readonly<Record<string, number>>;
  readonly query: PropertyQueryResult | null;
  readonly loading: boolean;
  readonly editing: boolean;
  readonly error: string | null;
  readonly onAssign: (assignment: PropertyAssignment) => void;
  readonly pointCloudStyles: readonly PointCloudDisplayStyle[];
  readonly productProvenance: readonly BuilderPhotoLabProvenanceSummary[];
  readonly onPointCloudDisplayChange: (display: PointCloudDisplayStyle) => void;
}

function BuilderPropertiesPanel({
  selectedCount,
  perKind,
  query,
  loading,
  editing,
  error,
  onAssign,
  pointCloudStyles,
  productProvenance,
  onPointCloudDisplayChange,
}: BuilderPropertiesPanelProps): JSX.Element {
  if (selectedCount === 0) {
    return (
      <div className={styles.propertiesEmpty}>
        <strong>Properties</strong>
        <span>Select one or more entities to inspect their shared and mixed values.</span>
      </div>
    );
  }
  return (
    <div className={styles.propertyPanel} aria-busy={loading || editing}>
      {loading ? (
        <div className={styles.propertySummary}>
          <strong>{selectedCount} selected</strong>
          <span>Reading exact revisions…</span>
        </div>
      ) : (
        <SelectionPropertiesSummary count={selectedCount} perKind={perKind} />
      )}
      {error ? <div className={styles.propertyError}>{error}</div> : null}
      {query?.properties.map((row) => (
        <PropertyRowEditor
          key={`${row.propertyId.namespace}:${row.propertyId.name}:${JSON.stringify(row.aggregate)}`}
          row={row}
          disabled={editing}
          onAssign={onAssign}
        />
      ))}
      {pointCloudStyles.length > 0 ? (
        <PointCloudDisplayProperties
          styles={pointCloudStyles}
          disabled={editing}
          onChange={onPointCloudDisplayChange}
        />
      ) : null}
      {productProvenance.map(({ entityId, componentSha256, provenance }) => {
        const lineage = readProductLineage(provenance.lineagePayloadUtf8);
        return (
          <section className={styles.provenanceGroup} key={entityId} aria-label="Lineage">
            <div className={styles.propertyHeading}>
              <span>Lineage</span>
              <small>PhotoLab</small>
            </div>
            <dl>
              <dt>Product</dt>
              <dd>{provenance.product}</dd>
              <dt>Project</dt>
              <dd>{lineage.sourceProjectId ?? provenance.sourceProjectId}</dd>
              <dt>Processing set</dt>
              <dd>{lineage.processingSet}</dd>
              <dt>Mask scope</dt>
              <dd>{lineage.maskScope}</dd>
              <dt>Tool ids</dt>
              <dd>{lineage.toolIds.length > 0 ? lineage.toolIds.join(' · ') : 'None recorded'}</dd>
              {lineage.demFacts ? (
                <>
                  <dt>DEM semantics</dt>
                  <dd>{lineage.demFacts.semantics}</dd>
                  <dt>Interpolation</dt>
                  <dd>{lineage.demFacts.interpolation}</dd>
                  <dt>Connectivity</dt>
                  <dd>{lineage.demFacts.connectivity}</dd>
                  <dt>Validity</dt>
                  <dd>{lineage.demFacts.validity}</dd>
                  <dt>NoData</dt>
                  <dd>{lineage.demFacts.noData}</dd>
                </>
              ) : null}
              <dt>Package</dt>
              <dd title={provenance.packageSha256}>{provenance.packageSha256}</dd>
              <dt>Component</dt>
              <dd title={componentSha256}>{componentSha256}</dd>
            </dl>
          </section>
        );
      })}
    </div>
  );
}

function readProductLineage(payload: string): {
  readonly sourceProjectId: string | null;
  readonly processingSet: string;
  readonly maskScope: string;
  readonly toolIds: readonly string[];
  readonly demFacts: {
    readonly semantics: string;
    readonly interpolation: string;
    readonly connectivity: string;
    readonly validity: string;
    readonly noData: string;
  } | null;
} {
  try {
    const value = JSON.parse(payload) as unknown;
    if (!isRecord(value)) throw new Error('invalid lineage');
    const processing = isRecord(value.processing_set_choice) ? value.processing_set_choice : null;
    const mask = isRecord(value.image_mask_scope) ? value.image_mask_scope : null;
    const tools = Array.isArray(value.tools)
      ? value.tools
          .filter(isRecord)
          .map((tool) => tool.id)
          .filter((id): id is string => typeof id === 'string')
      : [];
    const dem = isRecord(value.dem_facts) ? value.dem_facts : null;
    const validity =
      dem && isRecord(dem.validity) && isRecord(dem.validity.resource)
        ? `${dem.validity.encoding === 'bitsetLsb0' ? 'bitsetLsb0' : 'recorded'} · ${formatRatioFromBitset(dem.validity.resource.byte_length, value)}`
        : 'Not recorded';
    const noData =
      dem && isRecord(dem.source_no_data)
        ? dem.source_no_data.kind === 'numeric'
          ? `numeric ${String(dem.source_no_data.value)}`
          : String(dem.source_no_data.kind)
        : 'Not recorded';
    const connectivity = dem && isRecord(dem.connectivity) ? dem.connectivity : null;
    return {
      sourceProjectId: typeof value.source_project_id === 'string' ? value.source_project_id : null,
      processingSet:
        processing?.kind === 'all_imported_cameras'
          ? 'All imported cameras'
          : processing?.kind === 'selected' && typeof processing.processing_set_id === 'string'
            ? processing.processing_set_id
            : processing?.kind === 'none'
              ? 'None'
              : 'Not recorded',
      maskScope:
        mask?.kind === 'selected' && typeof mask.scope_sha256 === 'string'
          ? mask.scope_sha256
          : mask?.kind === 'none'
            ? 'None'
            : 'Not recorded',
      toolIds: tools,
      demFacts: dem
        ? {
            semantics: typeof dem.semantics === 'string' ? dem.semantics : 'Not recorded',
            interpolation:
              typeof dem.interpolation === 'string' ? dem.interpolation : 'Not recorded',
            connectivity:
              connectivity && typeof connectivity.kind === 'string'
                ? `${connectivity.kind}${typeof connectivity.diagonal === 'string' ? ` · ${connectivity.diagonal}` : ''}`
                : 'Not recorded',
            validity,
            noData,
          }
        : null,
    };
  } catch {
    return {
      sourceProjectId: null,
      processingSet: 'Unreadable lineage payload',
      maskScope: 'Unreadable lineage payload',
      toolIds: [],
      demFacts: null,
    };
  }
}

function formatRatioFromBitset(byteLength: unknown, lineage: Record<string, unknown>): string {
  const validCount = typeof lineage.valid_cell_count === 'number' ? lineage.valid_cell_count : null;
  const totalCount = typeof lineage.cell_count === 'number' ? lineage.cell_count : null;
  if (validCount !== null && totalCount !== null && totalCount > 0) {
    return `${((validCount / totalCount) * 100).toFixed(1)}% valid`;
  }
  return typeof byteLength === 'number' ? `${byteLength.toLocaleString()} bytes` : 'validity mask';
}

interface PropertyRowEditorProps {
  readonly row: PropertyQueryRow;
  readonly disabled: boolean;
  readonly onAssign: (assignment: PropertyAssignment) => void;
}

function PropertyRowEditor({ row, disabled, onAssign }: PropertyRowEditorProps): JSX.Element {
  const sharedValue = row.aggregate.state === 'shared' ? row.aggregate.value : null;
  const [draft, setDraft] = useState(() => (sharedValue ? propertyValueText(sharedValue) : ''));
  const editable =
    row.definition?.editability === 'writable' &&
    row.definition.valueType !== 'optionalTransform3d';
  const assignmentValue = editable ? propertyValueFromText(row, draft) : null;
  const unchanged = sharedValue !== null && propertyValueText(sharedValue) === draft;
  return (
    <section className={styles.propertyRow}>
      <div className={styles.propertyHeading}>
        <span>{propertyDisplayName(row)}</span>
        <small>{row.aggregate.state}</small>
      </div>
      {row.aggregate.state === 'unavailable' ? (
        <div className={styles.propertyUnavailable}>Not available in this schema revision</div>
      ) : editable ? (
        <div className={styles.propertyEditor}>
          <input
            aria-label={propertyDisplayName(row)}
            value={draft}
            placeholder={row.aggregate.state === 'mixed' ? 'Mixed' : undefined}
            disabled={disabled}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && assignmentValue && !unchanged && !disabled) {
                onAssign({ propertyId: row.propertyId, value: assignmentValue });
              }
            }}
          />
          <button
            type="button"
            disabled={disabled || assignmentValue === null || unchanged}
            onClick={() => {
              if (assignmentValue) onAssign({ propertyId: row.propertyId, value: assignmentValue });
            }}
          >
            Apply to all
          </button>
        </div>
      ) : (
        <output className={styles.propertyValue}>
          {sharedValue ? propertyValueText(sharedValue) || 'None' : <MixedPropertyMarker />}
        </output>
      )}
    </section>
  );
}

function propertyDisplayName(row: PropertyQueryRow): string {
  const name = row.propertyId.name;
  const labels: Readonly<Record<string, string>> = {
    typeId: 'Type',
    name: 'Name',
    owner: 'Owner',
    layerIds: 'Layers',
    placement: 'Placement',
    componentsRef: 'Components',
    attributesRef: 'Attributes',
    relationsRef: 'Relations',
    styleRef: 'Style',
  };
  return labels[name] ?? row.definition?.displayNameKey ?? name;
}

function propertyValueText(value: PropertyValue): string {
  switch (value.kind) {
    case 'text':
    case 'entityType':
    case 'contentHash':
      return value.value;
    case 'optionalEntityReference':
    case 'optionalContentHash':
      return value.value ?? '';
    case 'entityReferences':
      return value.values.join(', ');
    case 'optionalTransform3d':
      return value.value ? JSON.stringify(value.value) : '';
  }
}

function propertyValueFromText(row: PropertyQueryRow, text: string): PropertyValue | null {
  switch (row.definition?.valueType) {
    case 'text':
      return { kind: 'text', value: text };
    case 'optionalEntityReference':
      return { kind: 'optionalEntityReference', value: text.trim() || null };
    case 'entityReferences':
      return {
        kind: 'entityReferences',
        values: [
          ...new Set(
            text
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean),
          ),
        ],
      };
    case 'optionalContentHash': {
      const value = text.trim();
      if (value.length > 0 && !/^[0-9a-f]{64}$/.test(value)) return null;
      return { kind: 'optionalContentHash', value: value || null };
    }
    default:
      return null;
  }
}

interface ViewingBoxPanelProps {
  readonly state: KernelViewingBoxState | null;
  readonly boxes: readonly BuilderViewingBoxSummary[];
  readonly name: string;
  readonly selectedCount: number;
  readonly placingCenter: boolean;
  readonly bakeProgress: { readonly fraction: number; readonly phase: string } | null;
  readonly onChange: (state: KernelViewingBoxState | null) => void;
  readonly onSelect: (entityId: string) => void;
  readonly onCreateFromSelection: () => void;
  readonly onCreateFromTypedExtents: (
    center: { readonly x: number; readonly y: number; readonly z: number },
    size: { readonly x: number; readonly y: number; readonly z: number },
  ) => void;
  readonly onRename: (name: string) => void;
  readonly onLockChange: (locked: boolean) => void;
  readonly onRemove: () => void;
  readonly onPlacingCenterChange: (placing: boolean) => void;
}

function ViewingBoxPanel({
  state,
  boxes,
  name,
  selectedCount,
  placingCenter,
  bakeProgress,
  onChange,
  onSelect,
  onCreateFromSelection,
  onCreateFromTypedExtents,
  onRename,
  onLockChange,
  onRemove,
  onPlacingCenterChange,
}: ViewingBoxPanelProps): JSX.Element {
  const [nameDraft, setNameDraft] = useState(name);
  const [typedMin, setTypedMin] = useState({ x: -5, y: -5, z: -5 });
  const [typedMax, setTypedMax] = useState({ x: 5, y: 5, z: 5 });
  useEffect(() => setNameDraft(name), [name]);
  const modes: readonly { readonly id: KernelViewingBoxMode; readonly label: string }[] = [
    { id: 'resize', label: 'Resize' },
    { id: 'rotate', label: 'Rotate' },
  ];
  const locked = (state?.lockMode ?? 'unlocked') !== 'unlocked';
  return (
    <div className={styles.toolPanel}>
      {boxes.length > 0 ? (
        <label className={styles.toolGroup}>
          <span className={styles.toolLabel}>Active viewing box</span>
          <select
            className={styles.toolSelect}
            value={state?.id ?? ''}
            onChange={(event) => onSelect(event.currentTarget.value)}
          >
            {boxes.map((box) => (
              <option key={box.entityId} value={box.entityId}>
                {box.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className={styles.toolActions}>
        <Button
          size="small"
          variant="secondary"
          disabled={selectedCount === 0 || bakeProgress !== null}
          onClick={onCreateFromSelection}
        >
          From selection
        </Button>
        <Button
          size="small"
          variant={placingCenter ? 'primary' : 'secondary'}
          pressed={placingCenter}
          disabled={bakeProgress !== null}
          onClick={() => onPlacingCenterChange(!placingCenter)}
        >
          {placingCenter ? 'Pick in view…' : 'Draw in view'}
        </Button>
      </div>

      {!state ? (
        <>
          <ExtentsEditor
            min={typedMin}
            max={typedMax}
            onValue={(bound, axis, value) => {
              if (bound === 'min') setTypedMin((current) => ({ ...current, [axis]: value }));
              else setTypedMax((current) => ({ ...current, [axis]: value }));
            }}
          />
          <Button
            variant="primary"
            size="small"
            disabled={(['x', 'y', 'z'] as const).some((axis) => typedMin[axis] >= typedMax[axis])}
            onClick={() =>
              onCreateFromTypedExtents(
                {
                  x: (typedMin.x + typedMax.x) * 0.5,
                  y: (typedMin.y + typedMax.y) * 0.5,
                  z: (typedMin.z + typedMax.z) * 0.5,
                },
                {
                  x: typedMax.x - typedMin.x,
                  y: typedMax.y - typedMin.y,
                  z: typedMax.z - typedMin.z,
                },
              )
            }
          >
            Create from extents
          </Button>
          <p className={styles.toolHint}>
            Create from canonical geometry or resident cloud bounds, type exact extents, or drag a
            box in the view.
          </p>
        </>
      ) : (
        <>
          <label className={styles.toolGroup}>
            <span className={styles.toolLabel}>Name</span>
            <input
              className={styles.toolTextInput}
              value={nameDraft}
              disabled={bakeProgress !== null}
              onChange={(event) => setNameDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onRename(nameDraft);
                if (event.key === 'Escape') setNameDraft(name);
              }}
            />
          </label>
          <Button
            variant="secondary"
            size="small"
            disabled={!nameDraft.trim() || bakeProgress !== null}
            onClick={() => onRename(nameDraft)}
          >
            Save as entity
          </Button>

          <div
            className={`${styles.segmented} ${styles.segmentedPair}`}
            aria-label="Viewing box operation"
          >
            {(
              [
                ['keepInside', 'Keep inside'],
                ['removeInside', 'Remove inside'],
              ] as const
            ).map(([operation, label]) => (
              <button
                key={operation}
                type="button"
                disabled={locked || bakeProgress !== null}
                className={
                  (state.operation ?? 'keepInside') === operation
                    ? styles.segmentActive
                    : styles.segment
                }
                aria-pressed={(state.operation ?? 'keepInside') === operation}
                onClick={() =>
                  onChange({ ...state, operation: operation as KernelViewingBoxOperation })
                }
              >
                {label}
              </button>
            ))}
          </div>

          <div className={styles.segmented} aria-label="Viewing box manipulation">
            {modes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={state.mode === mode.id ? styles.segmentActive : styles.segment}
                disabled={locked || bakeProgress !== null}
                aria-pressed={state.mode === mode.id}
                onClick={() => onChange(setViewingBoxMode(state, mode.id))}
              >
                {mode.label}
              </button>
            ))}
          </div>

          <ExtentsEditor
            {...viewingBoxExtents(state)}
            disabled={locked || bakeProgress !== null}
            onValue={(bound, axis, value) =>
              onChange(setViewingBoxExtent(state, bound, axis, value))
            }
          />
          {state.mode === 'rotate' && !locked ? (
            <div className={styles.toolGroup}>
              <span className={styles.toolLabel}>Rotate 15° around local axis</span>
              <div className={styles.axisGrid}>
                {(['x', 'y', 'z'] as const).flatMap((axis) => [
                  <button
                    key={`${axis}-negative`}
                    type="button"
                    className={styles.toolButton}
                    onClick={() => onChange(rotateViewingBox(state, axis, -Math.PI / 12))}
                  >
                    {axis.toUpperCase()} −
                  </button>,
                  <button
                    key={`${axis}-positive`}
                    type="button"
                    className={styles.toolButton}
                    onClick={() => onChange(rotateViewingBox(state, axis, Math.PI / 12))}
                  >
                    {axis.toUpperCase()} +
                  </button>,
                ])}
              </div>
            </div>
          ) : null}

          {bakeProgress ? (
            <div className={styles.toolGroup} aria-live="polite">
              <span className={styles.toolLabel}>{bakeProgress.phase}</span>
              <ProgressBar value={bakeProgress.fraction} ariaLabel="Viewing box bake progress" />
              <Button variant="secondary" size="small" onClick={() => onLockChange(false)}>
                Cancel bake
              </Button>
            </div>
          ) : locked ? (
            <div className={styles.viewingBoxLockBanner}>
              <span aria-hidden>🔒</span>
              <strong className={styles.viewingBoxLockCopy}>
                <span>Locked — unlock to edit</span>
                <span className={styles.viewingBoxLockDetail}>
                  {state.lockMode === 'baked'
                    ? 'Prepared dataset'
                    : 'Kept region is most of the cloud; clip planes remain active'}
                </span>
              </strong>
              <Button variant="primary" size="small" onClick={() => onLockChange(false)}>
                Unlock
              </Button>
            </div>
          ) : (
            <Button variant="primary" size="small" onClick={() => onLockChange(true)}>
              Lock
            </Button>
          )}

          <div className={styles.toolActions}>
            <button
              type="button"
              className={state.enabled ? styles.toolButtonActive : styles.toolButton}
              aria-pressed={state.enabled}
              disabled={bakeProgress !== null}
              onClick={() => onChange({ ...state, enabled: !state.enabled })}
            >
              {state.enabled ? 'Clipping on' : 'Clipping off'}
            </button>
            <button
              type="button"
              className={styles.toolButtonDanger}
              disabled={bakeProgress !== null}
              onClick={() => {
                onPlacingCenterChange(false);
                onRemove();
              }}
            >
              Remove box
            </button>
          </div>
          <p className={styles.toolHint}>
            Drag a blue face or corner grip to resize. Orange marks the active grip. Geometry is
            previewed locally and stored once when the gesture ends.
          </p>
        </>
      )}
    </div>
  );
}

interface ExtentsEditorProps {
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  readonly max: { readonly x: number; readonly y: number; readonly z: number };
  readonly disabled?: boolean;
  readonly onValue: (bound: 'min' | 'max', axis: KernelViewingBoxAxis, value: number) => void;
}

function ExtentsEditor({ min, max, disabled = false, onValue }: ExtentsEditorProps): JSX.Element {
  return (
    <fieldset className={`${styles.vectorEditor} ${styles.extentsEditor}`} disabled={disabled}>
      <legend>Extents</legend>
      {(['x', 'y', 'z'] as const).flatMap((axis) =>
        (['min', 'max'] as const).map((bound) => (
          <label key={`${bound}-${axis}`}>
            <span>
              {bound === 'min' ? 'Min' : 'Max'} {axis.toUpperCase()}
            </span>
            <NumberInput
              step={0.001}
              value={Number((bound === 'min' ? min[axis] : max[axis]).toPrecision(12))}
              precision={6}
              unit="m"
              aria-label={`${bound === 'min' ? 'Minimum' : 'Maximum'} ${axis.toUpperCase()}`}
              onCommit={(value) => onValue(bound, axis, value)}
            />
          </label>
        )),
      )}
    </fieldset>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function constructionBarFields(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('[data-construction-input="armed"] input'),
  ).filter((field) => !field.disabled);
}

async function waitForJobTerminal(
  jobs: { readonly get: (id: string) => Promise<AppJob> },
  jobId: string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const job = await jobs.get(jobId);
    if (['completed', 'failed', 'cancelled'].includes(job.state)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for segmentation ${jobId} to stop safely.`);
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new TypeError('entityIds must be an array of strings.');
  }
  return value;
}

function surfaceEditPolygonFromPayload(
  value: unknown,
): readonly (readonly [number, number])[] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  return value.map((entry) => {
    if (
      Array.isArray(entry) &&
      entry.length >= 2 &&
      typeof entry[0] === 'number' &&
      Number.isFinite(entry[0]) &&
      typeof entry[1] === 'number' &&
      Number.isFinite(entry[1])
    ) {
      return [entry[0], entry[1]] as const;
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const point = entry as Record<string, unknown>;
      if (
        typeof point.x === 'number' &&
        Number.isFinite(point.x) &&
        typeof point.y === 'number' &&
        Number.isFinite(point.y)
      ) {
        return [point.x, point.y] as const;
      }
    }
    throw new TypeError('surface edit polygon vertices need finite project X and Y.');
  });
}

function optionalFenceVolumeFromPayload(
  payload: Record<string, unknown>,
): KernelFenceVolume | null {
  if (payload.volume !== undefined) {
    if (!payload.volume || typeof payload.volume !== 'object' || Array.isArray(payload.volume)) {
      throw new TypeError('volume must be a projection-true fence volume.');
    }
    const volume = payload.volume as KernelFenceVolume;
    assertFenceVolume(volume);
    return volume;
  }
  if (payload.polygon === undefined) return null;
  if (!Array.isArray(payload.polygon)) throw new TypeError('polygon must be an array.');
  const polygon = payload.polygon.map((entry): KernelWorldPoint => {
    if (
      Array.isArray(entry) &&
      entry.length === 3 &&
      entry.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
    ) {
      return { x: entry[0] as number, y: entry[1] as number, z: entry[2] as number };
    }
    if (
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      ['x', 'y', 'z'].every(
        (axis) =>
          typeof (entry as Record<string, unknown>)[axis] === 'number' &&
          Number.isFinite((entry as Record<string, number>)[axis]),
      )
    ) {
      const point = entry as Record<'x' | 'y' | 'z', number>;
      return { x: point.x, y: point.y, z: point.z };
    }
    throw new TypeError('polygon vertices must contain three finite coordinates.');
  });
  return fencePrismFromPolygon(polygon);
}

function fenceVolumeVertices(volume: KernelFenceVolume): readonly KernelWorldPoint[] {
  if (volume.kind === 'box') return [];
  return volume.polygon.map(([x, y, z]) => ({ x, y, z }));
}

function segmentFenceArea(fence: SegmentFenceState): number | null {
  if (fence.volume?.kind === 'box') {
    return fence.volume.halfExtents[0] * fence.volume.halfExtents[1] * 4;
  }
  const polygon =
    fence.volume?.polygon ??
    (fence.vertices.length >= 3 ? fence.vertices.map(({ x, y, z }) => [x, y, z] as const) : null);
  if (!polygon) return null;
  try {
    return fencePolygonArea(polygon);
  } catch {
    return null;
  }
}

function interactionResolver(
  project: ProjectSnapshot,
  display: Pick<ViewDisplayStateV1, 'globalDefault' | 'overrides'>,
): InteractionStateStore {
  const resolver = new InteractionStateStore(
    Object.values(project.entities).map((entity) => ({
      id: entity.id,
      parentId: entity.parent ?? null,
      kind: entity.kind,
    })),
  );
  resolver.applyViewDisplayState(display);
  return resolver;
}

function displayBooleanOperationValue(input: unknown): boolean | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const payload = (input as { readonly payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as { readonly value?: unknown }).value;
  return typeof value === 'boolean' ? value : null;
}

function fromKernelCamera(camera: KernelWorldCamera): ViewStateV2['camera'] {
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

function toKernelCamera(state: ViewStateV2): KernelWorldCamera {
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

function automationPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const payload = record.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : record;
}

function groundParametersFromPayload(value: unknown): GroundExtractionParameters {
  const defaults: GroundExtractionParameters = {
    cellSizeM: 1,
    slope: 0.15,
    maxWindowM: 18,
    initialDistanceM: 0.5,
  };
  if (value === undefined) return defaults;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('ground parameters must be an object.');
  }
  const input = value as Record<string, unknown>;
  const number = (key: keyof GroundExtractionParameters): number => {
    const candidate = input[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      throw new TypeError(`ground parameters.${key} must be finite.`);
    }
    return candidate;
  };
  return {
    cellSizeM: number('cellSizeM'),
    slope: number('slope'),
    maxWindowM: number('maxWindowM'),
    initialDistanceM: number('initialDistanceM'),
  };
}

function surfaceRulesFromPayload(value: unknown): SurfaceRules {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const positive = (key: string, fallback: number): number => {
    const candidate = Number(input[key] ?? fallback);
    if (!Number.isFinite(candidate) || candidate <= 0)
      throw new TypeError(`${key} must be positive.`);
    return candidate;
  };
  return {
    maximumEdgeLength: positive('maximumEdgeLength', 25),
    thinCloudSpacing: positive('thinCloudSpacing', 0.25),
    xyTolerance: positive('xyTolerance', 0.001),
    zTolerance: Math.max(0, Number(input.zTolerance ?? 0.001)),
    excludeOutsideBoundary: input.excludeOutsideBoundary !== false,
    breaklineExclusionDistance:
      input.breaklineExclusionDistance == null
        ? null
        : positive('breaklineExclusionDistance', 0.25),
    autoBoundary: input.autoBoundary !== false,
    cropPolyline: Array.isArray(input.cropPolyline)
      ? input.cropPolyline.flatMap((item) =>
          Array.isArray(item) &&
          item.length === 2 &&
          item.every((coordinate) => Number.isFinite(Number(coordinate)))
            ? [[Number(item[0]), Number(item[1])] as const]
            : [],
        )
      : [],
  };
}

function sampleParametersFromPayload(value: unknown): PointcloudSampleParameters {
  const defaults: PointcloudSampleParameters = {
    method: 'distance',
    spacingM: 0.25,
    percentage: 10,
  };
  if (value === undefined) return defaults;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('sample parameters must be an object.');
  }
  const input = value as Record<string, unknown>;
  const method = input.method;
  if (!['distance', 'grid', 'random'].includes(String(method))) {
    throw new TypeError('sample parameters.method must be distance, grid, or random.');
  }
  const finite = (key: string, fallback?: number): number => {
    const candidate = input[key] ?? fallback;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      throw new TypeError(`sample parameters.${key} must be finite.`);
    }
    return candidate;
  };
  const optional = (key: string): number | undefined =>
    input[key] === undefined ? undefined : finite(key);
  const originX = optional('originX');
  const originY = optional('originY');
  return {
    method: method as PointcloudSampleParameters['method'],
    spacingM: finite('spacingM', defaults.spacingM),
    percentage: finite('percentage', defaults.percentage),
    ...(originX === undefined ? {} : { originX }),
    ...(originY === undefined ? {} : { originY }),
  };
}

function rasterizeParametersFromPayload(value: unknown): PointcloudRasterizeParameters {
  const defaults: PointcloudRasterizeParameters = {
    cellSizeM: 1,
    aggregation: 'mean',
    emptyCellPolicy: { kind: 'no_data' },
  };
  if (value === undefined) return defaults;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('rasterize parameters must be an object.');
  }
  const input = value as Record<string, unknown>;
  const aggregation = input.aggregation;
  if (!['mean', 'min', 'max', 'count'].includes(String(aggregation))) {
    throw new TypeError('rasterize parameters.aggregation must be mean, min, max, or count.');
  }
  const finite = (key: string, fallback?: number): number => {
    const candidate = input[key] ?? fallback;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      throw new TypeError(`rasterize parameters.${key} must be finite.`);
    }
    return candidate;
  };
  const optional = (key: string): number | undefined =>
    input[key] === undefined ? undefined : finite(key);
  const emptyCellPolicy = input.emptyCellPolicy;
  if (!['no_data', 'fill'].includes(String(emptyCellPolicy))) {
    throw new TypeError('rasterize parameters.emptyCellPolicy must be no_data or fill.');
  }
  const originX = optional('originX');
  const originY = optional('originY');
  return {
    cellSizeM: finite('cellSizeM', defaults.cellSizeM),
    aggregation: aggregation as PointcloudRasterizeParameters['aggregation'],
    emptyCellPolicy:
      emptyCellPolicy === 'fill'
        ? { kind: 'fill', value: finite('emptyCellValue') }
        : { kind: 'no_data' },
    ...(originX === undefined ? {} : { originX }),
    ...(originY === undefined ? {} : { originY }),
  };
}

function nextBookmarkName(count: number): string {
  return `View ${String(count + 1)}`;
}

function viewStateFromBookmark(state: unknown, live: ViewStateV2): ViewStateV2 {
  const bookmark = state as ViewBookmarkStateV1;
  return parseViewState({
    schema: 'himmelcad.view-state',
    version: 2,
    camera: bookmark.camera,
    navigationMode: bookmark.navigationMode,
    hiddenEntityIds: bookmark.hiddenEntityIds,
    sessionHiddenEntityIds: live.sessionHiddenEntityIds,
    selectedEntityIds: live.selectedEntityIds,
    clipRefs: bookmark.clipRefs,
    presentation: {
      ...bookmark.presentation,
      pointSizeMultiplier: live.presentation.pointSizeMultiplier,
    },
  });
}

function validateBuilderClipRefs(
  state: ViewStateV2,
  box: KernelViewingBoxState | null,
  revision: number | null,
): ViewStateV2 {
  return validateViewStateReferences(state, (entityId) =>
    box?.id === entityId && revision !== null ? { entityId, revision, kind: 'viewing-box' } : null,
  );
}

function parseCanonicalViewingBoxState(value: unknown): KernelViewingBoxState {
  const state = value as KernelViewingBoxState;
  return setViewingBoxMode(state, state.mode);
}

function isViewingBoxPoint(
  value: unknown,
): value is { readonly x: number; readonly y: number; readonly z: number } {
  const point = value as { readonly x?: unknown; readonly y?: unknown; readonly z?: unknown };
  return (
    point !== null &&
    typeof point === 'object' &&
    typeof point.x === 'number' &&
    Number.isFinite(point.x) &&
    typeof point.y === 'number' &&
    Number.isFinite(point.y) &&
    typeof point.z === 'number' &&
    Number.isFinite(point.z)
  );
}

function isPositiveViewingBoxPoint(
  value: unknown,
): value is { readonly x: number; readonly y: number; readonly z: number } {
  return isViewingBoxPoint(value) && value.x > 0 && value.y > 0 && value.z > 0;
}

function isViewingBoxRotation(value: unknown): value is readonly [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((component) => typeof component === 'number' && Number.isFinite(component)) &&
    Math.hypot(...value) > 1e-9
  );
}

async function registerImportJobs(
  api: NonNullable<Window['himmelcad']>,
  paths: readonly string[],
): Promise<readonly { readonly jobId: string; readonly sourcePath: string }[]> {
  const items: { jobId: string; sourcePath: string }[] = [];
  for (const sourcePath of paths) {
    const jobId = `registration-${crypto.randomUUID()}`;
    const label = `Import ${sourcePath.split(/[\\/]/).pop() ?? sourcePath}`;
    await api.jobs.register({
      id: jobId,
      label,
      owner: 'builder.import',
      expectedDurationMs: 2_000,
      needsInput: true,
      progressKey: jobId,
      cancellable: true,
      context: { sourcePath },
    });
    logEvent('info', 'renderer', `${label} started`);
    items.push({ jobId, sourcePath });
  }
  return items;
}

async function restoreCanonicalResidency(
  viewport: BuilderKernelViewportHandle,
  bootstrap: BuilderResidencyBootstrap,
  residentEntityIds: ReadonlySet<string> = new Set(),
): Promise<{
  readonly clouds: EntityId[];
  readonly inlineMeshes: EntityId[];
  readonly pointCloudMetadata: ReadonlyMap<EntityId, CanonicalPointCloudMetadata>;
}> {
  if (bootstrap.schemaVersion !== 1) {
    throw new Error('Electron returned an invalid canonical residency bootstrap');
  }
  const clouds = new Set<EntityId>();
  const pointCloudMetadata = new Map<EntityId, CanonicalPointCloudMetadata>();
  const inlineAdmissions: CanonicalRepresentationAdmission[] = [];
  const inlineMeshes = new Set<EntityId>();
  for (const entry of bootstrap.entries) {
    try {
      const admission = parseCanonicalAdmission(entry.admission);
      const entityId = admission.entity.id as EntityId;
      if (residentEntityIds.has(entityId)) {
        if (entry.dataset?.formatId === 'potree@2') {
          clouds.add(entityId);
          if (entry.pointCloud) pointCloudMetadata.set(entityId, entry.pointCloud);
        } else if (entry.dataset === null) {
          inlineMeshes.add(entityId);
        }
        continue;
      }
      if (entry.dataset?.formatId === 'potree@2') {
        if (admission.resolvedGeometry.kind !== 'pointCloud') {
          throw new Error('Potree residency does not contain point-cloud geometry');
        }
        const bounds = await readPotreeBounds(entry.dataset.metadataUrl);
        await viewport.loadPotreePointCloud(entry.dataset.metadataUrl, {
          datasetId: entry.dataset.datasetId,
          admission,
          bounds,
          ...(entry.pointCloud ? { display: entry.pointCloud.display } : {}),
        });
        clouds.add(entityId);
        if (entry.pointCloud) pointCloudMetadata.set(entityId, entry.pointCloud);
      } else if (entry.dataset?.formatId === 'himmelcad-prepared-hierarchy@1') {
        await viewport.loadPreparedHierarchy(entry.dataset.metadataUrl, {
          datasetId: entry.dataset.datasetId,
          formatId: entry.dataset.formatId,
          admission,
        });
      } else if (entry.dataset === null) {
        inlineAdmissions.push(admission);
      } else {
        logEvent(
          'warn',
          'renderer',
          `Canonical dataset ${entry.dataset.datasetId} uses unsupported bootstrap format ${entry.dataset.formatId}`,
        );
      }
    } catch (error) {
      logEvent('error', 'renderer', `Canonical residency entry skipped: ${String(error)}`);
    }
  }
  if (inlineAdmissions.length > 0) {
    try {
      const loaded = await viewport.loadCanonicalPackage({
        providerId: 'hcad.canonical-residency@1',
        providerVersion: '1',
        admissions: inlineAdmissions,
      });
      for (const entityId of loaded) inlineMeshes.add(entityId);
    } catch (error) {
      logEvent('error', 'renderer', `Canonical inline residency skipped: ${String(error)}`);
    }
  }
  viewport.frameAll();
  return { clouds: [...clouds], inlineMeshes: [...inlineMeshes], pointCloudMetadata };
}

function formatPointCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} k`;
  return value.toLocaleString();
}

function productGlyph(kind: BuilderPhotoLabProvenanceSummary['provenance']['productKind']): string {
  switch (kind) {
    case 'dem':
      return '⌁';
    case 'mesh':
      return '◇';
    case 'gaussianSplat':
      return '✣';
    case 'orthomosaic':
      return '▧';
    case 'sparse':
    case 'dense':
      return '✦';
  }
}

async function readPotreeBounds(metadataUrl: string): Promise<{
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}> {
  const response = await fetch(metadataUrl);
  if (!response.ok) throw new Error(`canonical Potree metadata failed (${response.status})`);
  const metadata: unknown = await response.json();
  if (!isRecord(metadata) || !isRecord(metadata.boundingBox)) {
    throw new Error('canonical Potree metadata has no bounding box');
  }
  return {
    min: coordinateTuple(metadata.boundingBox.min, 'minimum'),
    max: coordinateTuple(metadata.boundingBox.max, 'maximum'),
  };
}

function coordinateTuple(value: unknown, label: string): readonly [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))
  ) {
    throw new Error(`canonical Potree ${label} bound is invalid`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function parseCanonicalAdmission(value: unknown): CanonicalRepresentationAdmission {
  if (
    !isRecord(value) ||
    !isRecord(value.entity) ||
    typeof value.entity.id !== 'string' ||
    typeof value.entity.versionHash !== 'string' ||
    !isRecord(value.selected) ||
    typeof value.selected.geometryRef !== 'string' ||
    typeof value.representationSlot !== 'string' ||
    !isRecord(value.resolvedGeometry) ||
    typeof value.resolvedGeometry.kind !== 'string'
  ) {
    throw new Error('sidecar returned a malformed canonical admission');
  }
  return value as unknown as CanonicalRepresentationAdmission;
}

function pruneRemovedSelection(
  store: SelectionStore,
  previous: ProjectSnapshot | null,
  next: ProjectSnapshot,
): void {
  if (!previous) return;
  const deleted = Object.keys(previous.entities).filter((id) => next.entities[id] === undefined);
  if (deleted.length > 0) store.pruneDeleted(deleted);
}

function selectionKindCounts(
  selection: ReadonlySet<EntityId>,
  project: ProjectSnapshot | null,
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const id of selection) {
    const kind = project?.entities[id]?.kind ?? 'Object';
    const labels: Readonly<Record<string, string>> = {
      SinglePoint: 'point',
      Polyline3D: 'polyline',
      PointCloud: 'point cloud',
      GaussianSplatCloud: 'splat cloud',
      IfcElement: 'IFC element',
    };
    const label = labels[kind] ?? kind.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    result[label] = (result[label] ?? 0) + 1;
  }
  return result;
}

function commandEntityKind(kind: EntityKind): CommandContext['selectedEntityKinds'][number] {
  if (kind === 'SinglePoint' || kind === 'GroundControlPoint') return 'point';
  if (kind === 'Polyline3D') return 'polyline';
  if (kind === 'Surface' || kind === 'Mesh' || kind === 'TexturedMesh') return 'mesh';
  if (kind === 'PointCloud' || kind === 'GaussianSplatCloud') return 'cloud';
  return 'other';
}

function isCommandExportable(kind: EntityKind): boolean {
  return (
    kind === 'SinglePoint' ||
    kind === 'Polyline3D' ||
    kind === 'Surface' ||
    kind === 'Mesh' ||
    kind === 'TexturedMesh' ||
    kind === 'DepthMap' ||
    kind === 'Orthomosaic' ||
    kind === 'DigitalElevationModel' ||
    kind === 'PointCloud' ||
    kind === 'GaussianSplatCloud'
  );
}

function isExportScopeEntity(kind: EntityKind): boolean {
  return kind !== 'ProjectRoot' && kind !== 'Group' && kind !== 'Layer';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
