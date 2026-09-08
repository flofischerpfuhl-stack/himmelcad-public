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
  InteractionStateStore,
  JobMirror,
  LocalStorageSelectionPersistence,
  LocalStorageViewHistoryPersistence,
  SELECTION_COMMAND_TABLE,
  SelectionStore,
  StaleViewReferenceError,
  ViewDisplayStore,
  bookmarkCaptureState,
  validateViewStateReferences,
  commandById,
  dispatchRegistryShortcut,
  encodeRgbaScreenshot,
  executeSelectionCommand,
  parseViewState,
  validateScreenshotRequest,
  type CommandContext,
  type CommandInvocation,
} from '@himmelcad/app';
import { Console, consoleStore, logEvent, runConsoleCommand } from '@himmelcad/console';
import { ManagedAgentChat, ManagedAutomationApproval } from '@himmelcad/agent';
import type { EntityId, EntityKind, ProjectSnapshot, SnapResult } from '@himmelcad/data';
import {
  AppShell,
  Button,
  ConstructionBar,
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
  placeViewingBoxCenter,
  rotateViewingBox,
  setViewingBoxMode,
  type CanonicalRepresentationAdmission,
  type KernelViewingBoxAxis,
  type KernelViewingBoxMode,
  type KernelViewingBoxOperation,
  type KernelViewingBoxState,
  type KernelWorldCamera,
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

import builderLogoUrl from '../../build/mark.png';

import styles from './BuilderApp.module.css';
import { BuilderImportRegistrationIsland } from './BuilderImportRegistrationIsland.js';
import {
  BuilderKernelViewport,
  type BuilderKernelViewportHandle,
} from './BuilderKernelViewport.js';
import { FloatingTaskIsland } from './FloatingTaskIsland.js';
import { PlanIsland } from './PlanIsland.js';
import { SpecsIsland } from './SpecsIsland.js';
import {
  BuilderCanonicalProjectSession,
  startDurabilityPolling,
  type BuilderDurabilityStatus,
  type BuilderViewingBoxSummary,
} from './project.js';
import { createRibbonTabs } from './ribbon.js';
import { parseSidecarProgress } from './sidecarProgress.js';

const DEFAULT_POINT_SIZE = 1;

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
  const [navigationMode, setNavigationMode] = useState<'3d' | '2d' | '2.5d'>('3d');
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [pointSize, setPointSize] = useState(DEFAULT_POINT_SIZE);
  const [pointCloudMetadata, setPointCloudMetadata] = useState<
    ReadonlyMap<EntityId, CanonicalPointCloudMetadata>
  >(new Map());
  const [hudVisible, setHudVisible] = useState(false);
  const [viewingBox, setViewingBox] = useState<KernelViewingBoxState | null>(null);
  const viewingBoxRef = useRef<KernelViewingBoxState | null>(null);
  const viewingBoxRevisionRef = useRef<number | null>(null);
  const viewingBoxRevisionByIdRef = useRef(new Map<string, number>());
  const viewingBoxPersistTailRef = useRef(Promise.resolve());
  const [viewingBoxes, setViewingBoxes] = useState<readonly BuilderViewingBoxSummary[]>([]);
  const [viewingBoxName, setViewingBoxName] = useState('Viewing Box');
  const viewingBoxNameRef = useRef(viewingBoxName);
  viewingBoxNameRef.current = viewingBoxName;
  viewingBoxRef.current = viewingBox;
  const [placingViewingBoxCenter, setPlacingViewingBoxCenter] = useState(false);
  const pendingViewingBoxIdRef = useRef<string | null>(null);
  const viewingBoxBakeAbortRef = useRef<AbortController | null>(null);
  const viewingBoxBakeJobIdRef = useRef<string | null>(null);
  const debugViewingBoxLockRef = useRef<(locked: boolean) => Promise<void>>(async () => undefined);
  const [viewingBoxBakeProgress, setViewingBoxBakeProgress] = useState<{
    readonly fraction: number;
    readonly phase: string;
  } | null>(null);
  const [constructionDetached, setConstructionDetached] = useState(false);
  const [propertyQuery, setPropertyQuery] = useState<PropertyQueryResult | null>(null);
  const [propertyQueryError, setPropertyQueryError] = useState<string | null>(null);
  const [propertyQueryLoading, setPropertyQueryLoading] = useState(false);
  const [propertyEditing, setPropertyEditing] = useState(false);
  const [propertyRefresh, setPropertyRefresh] = useState(0);
  const [specsOpen, setSpecsOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [jobToasts, setJobToasts] = useState<readonly AppJob[]>([]);
  const [jobClock, setJobClock] = useState(() => Date.now());
  const [durability, setDurability] = useState<BuilderDurabilityStatus | null>(null);
  const [durabilityFailureToast, setDurabilityFailureToast] = useState(false);
  const interactionState = useMemo(() => {
    if (!project) return null;
    return interactionResolver(project, display.state);
  }, [display.state, project]);
  const [recoveryToast, setRecoveryToast] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<
    readonly { readonly path: string; readonly name: string; readonly openedAtUnixMs: number }[]
  >([]);
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [viewportEpoch, setViewportEpoch] = useState(0);
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
  const currentProjectPathRef = useRef<string | null>(null);
  const startupProjectRef = useRef<Promise<string> | null>(null);
  const closeCancelledRef = useRef(false);
  const durabilityRecoveryReportedRef = useRef(false);
  const jobMirrorRef = useRef<JobMirror | null>(null);
  const executeRegistryCommandRef = useRef<(invocation: CommandInvocation) => void | Promise<void>>(
    () => undefined,
  );
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
  const navigationModeRef = useRef(navigationMode);
  const automationHiddenRef = useRef(new Set<EntityId>());
  selectedRef.current = selected;
  projectRef.current = project;
  currentProjectPathRef.current = currentProjectPath;
  navigationModeRef.current = navigationMode;
  const selectedEntityKey = useMemo(() => [...selected].sort().join('\u0000'), [selected]);

  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    const target = window as Window & { __hcadS08Debug?: unknown };
    target.__hcadS08Debug = Object.freeze({
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
    return () => {
      delete target.__hcadS08Debug;
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
    if (jobs.length === 0) return;
    const timer = window.setInterval(() => setJobClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
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
      const registryEntry = commandById(method);
      if (registryEntry?.surfaces.automation) {
        if (method.startsWith('view.box.') && method !== 'view.box.list') {
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
      await viewport.setViewMode(state.navigationMode);
      setNavigationMode(state.navigationMode);
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
        navigationMode: navigationModeRef.current,
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
    async (mode: 'project' | 'window'): Promise<boolean> => {
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
            (job.owner === 'builder.import' || job.owner === 'builder.archive') &&
            !['completed', 'failed', 'cancelled'].includes(job.state)
          ) {
            await api.jobs.cancel(job.id).catch(() => undefined);
          }
        }
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
        setProject(null);
        setViewingBox(null);
        setViewingBoxes([]);
        viewingBoxRevisionByIdRef.current.clear();
        viewingBoxRevisionRef.current = null;
        setCurrentProjectPath(null);
        currentProjectPathRef.current = null;
        setDurability(null);
        entityGroupsRef.current = { cloud: [], ifc: [], orthophoto: [], mesh: [] };
        setViewportEpoch((epoch) => epoch + 1);
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
    [closeMode, displayStore, jobs, selectionStore],
  );

  const replaceProject = useCallback(
    async (projectRoot: string): Promise<void> => {
      if (projectRoot === currentProjectPathRef.current && canonicalSessionRef.current) return;
      if (canonicalSessionRef.current && !(await closeCurrentProject('project'))) return;
      durabilityRecoveryReportedRef.current = false;
      setRecoveryToast(null);
      currentProjectPathRef.current = projectRoot;
      setCurrentProjectPath(projectRoot);
      canonicalReadyRef.current = null;
      canonicalSessionRef.current = null;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await ensureCanonicalProjectRef.current();
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
      const storedViewingBoxes = await session.listViewingBoxes();
      const storedViewingBox = storedViewingBoxes[0];
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
    setProject(refreshed);
    const restored = await restoreCanonicalResidency(
      viewport,
      await api.canonicalProject.residencyBootstrap(),
    );
    entityGroupsRef.current.cloud = restored.clouds;
    entityGroupsRef.current.ifc = restored.inlineMeshes;
    setPointCloudMetadata(restored.pointCloudMetadata);
  }, [selectionStore]);

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
        .then((nextProject) => {
          if (nextProject) {
            pruneRemovedSelection(selectionStore, projectRef.current, nextProject);
            setProject(nextProject);
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
    if (id === 'file.import') {
      void (async () => {
        try {
          const api = window.himmelcad;
          if (!api) {
            logEvent('warn', 'renderer', 'no electron bridge: skipping import dialog');
            return;
          }
          const session = await ensureCanonicalProject();
          const formats = await session.listIoFormats();
          const extensions = formats
            .flatMap((format) => format.extensions)
            .map((value) => value.replace(/^\./, ''));
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
      setNavigationMode(mode);
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
    } else if (id === 'output.specs') {
      setSpecsOpen(true);
      closeFunction(id);
    } else if (id === 'output.plan') {
      setPlanOpen(true);
      closeFunction(id);
    } else if (id === 'automation.agent') {
      setAgentOpen(true);
      closeFunction(id);
    } else if (id === 'project.flush' || id === 'project.save') {
      void flushProject().finally(() => closeFunction(id));
    }
    // Other ribbon actions only highlight + show their function panel for now.
  }, [activeFunctionId, closeFunction, ensureCanonicalProject, flushProject, viewingBox]);

  useEffect(() => {
    if (activeFunctionId !== 'view.viewing-box') setPlacingViewingBoxCenter(false);
  }, [activeFunctionId]);

  useEffect(() => {
    if (!placingViewingBoxCenter) {
      constructionInputStore.disarm();
      return;
    }
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
  }, [constructionInputStore, placingViewingBoxCenter, viewingBox?.center]);

  useEffect(() => {
    viewportRef.current?.setViewingBox(
      viewingBox && display.state.activeClipEntityIds.includes(viewingBox.id) ? viewingBox : null,
    );
  }, [display.state.activeClipEntityIds, viewingBox]);

  const commitCanonicalViewingBox = useCallback(
    (next: KernelViewingBoxState | null): void => {
      setViewingBox(next);
      if (!next) return;
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
            viewingBoxNameRef.current,
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
    },
    [displayStore, viewingBoxes],
  );

  const createViewingBoxFromSelection = useCallback((): void => {
    const id = `viewing-box-${crypto.randomUUID()}`;
    const created = viewportRef.current?.createViewingBoxFromSelection([...selected], id);
    if (!created) {
      logEvent('warn', 'renderer', 'The current selection has no resident bounds.');
      return;
    }
    const name = `Viewing Box ${viewingBoxes.length + 1}`;
    viewingBoxNameRef.current = name;
    setViewingBoxName(name);
    commitCanonicalViewingBox(created);
  }, [commitCanonicalViewingBox, selected, viewingBoxes.length]);

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

  const renameViewingBox = useCallback(
    (name: string): void => {
      const trimmed = name.trim();
      const box = viewingBoxRef.current;
      if (!box || !trimmed) return;
      viewingBoxNameRef.current = trimmed;
      setViewingBoxName(trimmed);
      commitCanonicalViewingBox(box);
    },
    [commitCanonicalViewingBox],
  );

  const setViewingBoxLocked = useCallback(
    async (locked: boolean): Promise<void> => {
      const state = viewingBoxRef.current;
      const viewport = viewportRef.current;
      const api = window.himmelcad;
      if (!state || !viewport || !api) return;
      if (!locked && viewingBoxBakeAbortRef.current) {
        const jobId = viewingBoxBakeJobIdRef.current;
        viewingBoxBakeAbortRef.current.abort();
        if (jobId) await api.jobs.cancel(jobId);
        return;
      }
      if (viewingBoxBakeAbortRef.current) return;
      if (!locked) {
        commitCanonicalViewingBox(viewport.unlockViewingBox(state));
        return;
      }
      const controller = new AbortController();
      const jobId = `viewing-box-bake-${crypto.randomUUID()}`;
      viewingBoxBakeAbortRef.current = controller;
      viewingBoxBakeJobIdRef.current = jobId;
      setViewingBoxBakeProgress({ fraction: 0, phase: 'Preparing resident dataset' });
      await api.jobs.register({
        id: jobId,
        label: `Lock ${viewingBoxNameRef.current}`,
        owner: 'builder.viewing-box-bake',
        phase: 'Preparing resident dataset',
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
    [commitCanonicalViewingBox],
  );
  debugViewingBoxLockRef.current = setViewingBoxLocked;

  const deleteViewingBox = useCallback(async (): Promise<void> => {
    const state = viewingBoxRef.current;
    const session = canonicalSessionRef.current;
    if (!state || !session) return;
    if ((state.lockMode ?? 'unlocked') !== 'unlocked') viewportRef.current?.unlockViewingBox(state);
    await viewingBoxPersistTailRef.current;
    const revision = viewingBoxRevisionByIdRef.current.get(state.id);
    if (revision === undefined) return;
    await session.deleteViewingBox(state.id, revision);
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
  }, [displayStore, viewingBoxes]);

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
    void session.queryProperties(selectedEntityIds).then(
      (result) => {
        if (!active) return;
        setPropertyQuery(result);
        setPropertyQueryLoading(false);
      },
      (error: unknown) => {
        if (!active) return;
        setPropertyQuery(null);
        setPropertyQueryError(error instanceof Error ? error.message : String(error));
        setPropertyQueryLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [project, propertyRefresh, selectedEntityKey]);

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

  const executeRegistryCommand = useCallback(
    async (invocation: CommandInvocation): Promise<void> => {
      const ids = selectedRef.current;
      switch (invocation.id) {
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
          } else if (isViewingBoxPoint(payload.center) && isViewingBoxPoint(payload.extents)) {
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
            ...(typeof payload.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
          };
          commitCanonicalViewingBox(next);
          await viewingBoxPersistTailRef.current;
          return;
        }
        case 'view.box.set_operation': {
          const state = viewingBoxRef.current;
          const payload = automationPayload(invocation.payload);
          if (!state || !['keepInside', 'removeInside'].includes(String(payload.operation))) {
            throw new TypeError('view.box.set_operation requires an active box and operation.');
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
        case 'project.save':
          await flushProject();
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
        case 'entity.rename':
        case 'entity.export':
        case 'edit.clipboard.paste_in_place':
          activate(invocation.id);
          return;
      }
    },
    [
      activate,
      commitCanonicalViewingBox,
      createViewingBoxFromSelection,
      createViewingBoxFromTypedExtents,
      deleteViewingBox,
      displayStore,
      ensureCanonicalProject,
      flushProject,
      onVisibilityChange,
      recentProjects,
      renameViewingBox,
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
            const extensions = formats
              .flatMap((format) => format.extensions)
              .map((value) => value.replace(/^\./, ''));
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
          setNavigationMode('2d');
          void viewportRef.current?.setViewMode('2d');
          return;
        case 'view.orbit':
        case 'view.3d':
          setNavigationMode('3d');
          void viewportRef.current?.setViewMode('3d');
          return;
        case 'view.2.5d':
          setNavigationMode('2.5d');
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

  const fileRibbonTabs = useMemo(
    () =>
      createRibbonTabs({
        recent: recentProjects,
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
        onClose: () => void closeCurrentProject('project'),
        navigationMode,
      }),
    [
      closeCurrentProject,
      createProject,
      flushProject,
      openProject,
      navigationMode,
      recentProjects,
      replaceProject,
      saveProjectAs,
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
        content: `Point: ${pointSize.toFixed(1)}px`,
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
          <JobsStatusChip
            jobs={jobs}
            now={jobClock}
            debounceMs={JOB_CHIP_DEBOUNCE_MS}
            onClick={() => setJobsOpen((open) => !open)}
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
      jobClock,
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
  const routeConstructionTyping = useCallback((key: string): void => {
    if (!/^[0-9.,+\-]$/u.test(key)) return;
    const field = constructionBarFields()[0];
    if (!field) return;
    field.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, key);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.setSelectionRange(key.length, key.length);
  }, []);
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
        ribbon={<Ribbon tabs={fileRibbonTabs} />}
        leftPanel={
          project ? (
            <EntityTree
              project={project}
              selectedIds={selected}
              onSelect={(id, mode) => {
                if (id === ('builder:viewing-boxes' as EntityId)) {
                  activate('view.viewing-box');
                  return;
                }
                if (viewingBoxes.some((box) => box.entityId === id)) {
                  selectViewingBox(id);
                  activate('view.viewing-box');
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
              secondaryLabel={(entity) => {
                const count = pointCloudMetadata.get(entity.id)?.pointCount;
                return count === undefined ? null : formatPointCount(count);
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
            propertiesTitle={
              selected.size > 1
                ? `${selected.size} selected`
                : selected.size === 1
                  ? project?.entities[[...selected][0]!]?.name
                  : undefined
            }
            properties={
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
                onPointCloudDisplayChange={(display) => void setSelectedPointCloudDisplay(display)}
              />
            }
          >
            {functionBody(
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
                  onFieldCommit={(field, value) => constructionInputStore.setField(field, value)}
                  onCommit={() => placeViewingBoxAt(constructionInputStore.commit())}
                  onCycleCandidate={(direction) => viewportRef.current?.cycleCandidate(direction)}
                />
              ) : undefined
            }
            bottomBar={
              <ViewportBottomBar
                state={{
                  supportGeometry: display.state.supportOverlay,
                  granularity: selection.granularity,
                  viewMode: navigationMode,
                  selectableKinds: selection.selectableKinds,
                  labels: display.state.labels,
                }}
                onSupportGeometryChange={(value) => displayStore.setSupportOverlay(value)}
                onExplodePolylinesChange={(value) =>
                  selectionStore.setGranularity(value ? 'segments' : 'whole')
                }
                onViewModeChange={(mode) => {
                  setNavigationMode(mode);
                  void viewportRef.current?.setViewMode(mode);
                }}
                onSelectableKindChange={(kind, value) =>
                  selectionStore.setSelectableKind(kind, value)
                }
                onLabelsChange={(value) => displayStore.setLabels(value)}
              />
            }
          >
            <BuilderKernelViewport
              key={viewportEpoch}
              ref={viewportRef}
              pointSize={pointSize}
              onCursorSnap={(nextSnap) => {
                setSnap(nextSnap);
                if (
                  constructionInputStore.snapshot().armed &&
                  nextSnap?.position.z !== null &&
                  nextSnap?.position.z !== undefined
                ) {
                  constructionInputStore.pointer({
                    x: nextSnap.position.x,
                    y: nextSnap.position.y,
                    z: nextSnap.position.z,
                  });
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
              viewingBoxEditing={
                activeFunctionId === 'view.viewing-box' &&
                !placingViewingBoxCenter &&
                (viewingBox?.lockMode ?? 'unlocked') === 'unlocked'
              }
              placingViewingBoxCenter={placingViewingBoxCenter}
              constructionToolId={constructionInput.declaration?.toolId ?? null}
              onConstructionTab={traverseConstructionBar}
              onConstructionTyping={routeConstructionTyping}
              onConstructionCancel={() => setPlacingViewingBoxCenter(false)}
              onViewportPoint={placeViewingBoxAt}
              onViewingBoxChange={commitCanonicalViewingBox}
              onDropFiles={(paths) => void registerImports(paths)}
              onLog={(level, message) => logEvent(level, 'renderer', message)}
            />
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
          <JobsIsland
            jobs={jobs}
            now={jobClock}
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
                  if (job.state === 'completed') viewportRef.current?.frameAll();
                  else toggleBottom();
                }}
              >
                {job.state === 'completed' ? 'Frame' : 'Console'}
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
              payload: target,
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
  if (id === 'view.performance') return 'point cloud performance';
  if (id === 'view.point-size') return 'point size';
  if (id === 'view.viewing-box') return 'Viewing Box';
  return id.replace(/[._:-]/g, ' ');
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
          <span style={{ color: 'var(--hc-fg-muted)', fontSize: 12 }}>Point size</span>
          <output style={{ color: 'var(--hc-fg)', fontSize: 12 }}>{pointSize.toFixed(1)} px</output>
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
    </div>
  );
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
  const [typedCenter, setTypedCenter] = useState({ x: 0, y: 0, z: 0 });
  const [typedSize, setTypedSize] = useState({ x: 10, y: 10, z: 10 });
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
          <VectorEditor
            label="Center"
            values={typedCenter}
            onValue={(axis, value) => setTypedCenter((current) => ({ ...current, [axis]: value }))}
          />
          <VectorEditor
            label="Full extents"
            values={typedSize}
            minimum={0.000_002}
            onValue={(axis, value) => setTypedSize((current) => ({ ...current, [axis]: value }))}
          />
          <Button
            variant="primary"
            size="small"
            onClick={() => onCreateFromTypedExtents(typedCenter, typedSize)}
          >
            Create from extents
          </Button>
          <p className={styles.toolHint}>
            Create from resident selection bounds, type exact extents, or draw a 60%-of-view box.
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
              onBlur={() => onRename(nameDraft)}
            />
          </label>

          <div className={styles.segmented} aria-label="Viewing box operation">
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

          {!locked ? (
            <VectorEditor
              label="Center"
              values={state.center}
              onValue={(axis, value) =>
                onChange({ ...state, center: { ...state.center, [axis]: value } })
              }
            />
          ) : null}
          {!locked ? (
            <VectorEditor
              label="Size"
              values={{
                x: state.halfExtents.x * 2,
                y: state.halfExtents.y * 2,
                z: state.halfExtents.z * 2,
              }}
              minimum={0.000_002}
              onValue={(axis, value) =>
                onChange({
                  ...state,
                  halfExtents: { ...state.halfExtents, [axis]: Math.max(0.000_001, value * 0.5) },
                })
              }
            />
          ) : null}
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
              <strong>
                {state.lockMode === 'baked'
                  ? 'Locked · prepared data'
                  : 'Locked · edit-frozen copy scope'}
              </strong>
              <Button variant="secondary" size="small" onClick={() => onLockChange(false)}>
                Unlock
              </Button>
            </div>
          ) : (
            <Button variant="primary" size="small" onClick={() => onLockChange(true)}>
              Lock and bake
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

interface VectorEditorProps {
  readonly label: string;
  readonly values: { readonly x: number; readonly y: number; readonly z: number };
  readonly minimum?: number;
  readonly onValue: (axis: KernelViewingBoxAxis, value: number) => void;
}

function VectorEditor({ label, values, minimum, onValue }: VectorEditorProps): JSX.Element {
  return (
    <fieldset className={styles.vectorEditor}>
      <legend>{label}</legend>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <label key={axis}>
          <span>{axis.toUpperCase()}</span>
          <NumberInput
            min={minimum}
            step={0.001}
            value={Number(values[axis].toPrecision(12))}
            precision={6}
            unit="m"
            onCommit={(value) => onValue(axis, value)}
          />
        </label>
      ))}
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
  for (const entry of bootstrap.entries) {
    try {
      const admission = parseCanonicalAdmission(entry.admission);
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
        const entityId = admission.entity.id as EntityId;
        clouds.add(entityId);
        if (entry.pointCloud) pointCloudMetadata.set(entityId, entry.pointCloud);
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
  let inlineMeshes: readonly EntityId[] = [];
  if (inlineAdmissions.length > 0) {
    try {
      inlineMeshes = await viewport.loadCanonicalPackage({
        providerId: 'hcad.canonical-residency@1',
        providerVersion: '1',
        admissions: inlineAdmissions,
      });
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
    kind === 'DigitalElevationModel'
  );
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
