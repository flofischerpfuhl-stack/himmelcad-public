import type {
  AppJob,
  JobEvent,
  PropertyAssignment,
  PropertyQueryResult,
  PropertyQueryRow,
  PropertyValue,
  Quaternion,
  ScopedClip,
  ScreenshotRequestV1,
  ViewStateV1,
} from '@himmelcad/app';
import {
  JOB_CHIP_DEBOUNCE_MS,
  JOB_COMPLETED_RETENTION_MS,
  JobMirror,
  LocalStorageSelectionPersistence,
  SELECTION_COMMAND_TABLE,
  SelectionStore,
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
  DurabilityIndicator,
  EntityTree,
  EntityCommandMenu,
  FunctionPanel,
  JobsIsland,
  JobsStatusChip,
  PanelToggles,
  QuickCommandSurface,
  Ribbon,
  MixedPropertyMarker,
  SelectionCandidateIndicator,
  SelectionPropertiesSummary,
  StatusBar,
  Toast,
  ToastRegion,
  TitleBar,
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
  type KernelViewingBoxState,
  type KernelClipVolume,
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
} from './project.js';
import { ribbonTabs } from './ribbon.js';
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
  const selection = useSyncExternalStore(
    selectionStore.subscribe,
    selectionStore.getSnapshot,
    selectionStore.getSnapshot,
  );
  const selected = selection.selectedEntityIds as ReadonlySet<EntityId>;
  const [navigationMode, setNavigationMode] = useState<'3d' | '2d' | '2.5d'>('3d');
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [pointSize, setPointSize] = useState(DEFAULT_POINT_SIZE);
  const [viewingBox, setViewingBox] = useState<KernelViewingBoxState | null>(null);
  const [placingViewingBoxCenter, setPlacingViewingBoxCenter] = useState(false);
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
  const durabilityRecoveryReportedRef = useRef(false);
  const jobMirrorRef = useRef<JobMirror | null>(null);
  const executeRegistryCommandRef = useRef<
    (invocation: CommandInvocation) => void | Promise<void>
  >(() => undefined);
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
  const automationClipsRef = useRef<readonly ScopedClip[]>([]);
  selectedRef.current = selected;
  projectRef.current = project;
  navigationModeRef.current = navigationMode;
  const selectedEntityKey = useMemo(() => [...selected].sort().join('\u0000'), [selected]);

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
    return bridge.register(async (method, params) => {
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
      const registryEntry = commandById(method);
      if (registryEntry?.surfaces.automation) {
        await executeRegistryCommandRef.current({
          id: registryEntry.id,
          args: [],
          source: 'automation',
          payload: params,
        });
        return { schemaId: 'hcad.command-result@1', payload: { commandId: registryEntry.id } };
      }
      if (method.startsWith('select.') || method.startsWith('selection.history.')) {
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
      if (method === 'view.state.get') return currentBuilderViewState();
      if (method !== 'view.state.set') throw new Error(`Unsupported view host method: ${method}`);
      const state = parseViewState(params);
      assertSupportedBuilderPresentation(state);
      await viewport.setViewMode(state.navigationMode);
      setNavigationMode(state.navigationMode);
      viewport.adoptWorldCamera(toKernelCamera(state));

      const nextHidden = new Set(state.hiddenEntityIds as readonly EntityId[]);
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
      selectionStore.replace(state.selectedEntityIds);
      const volumes = state.scopedClips.filter((clip) => clip.enabled).map(scopedClipVolume);
      viewport.setAutomationClipVolumes(volumes);
      automationClipsRef.current = state.scopedClips;
      await viewport.waitForNextPresentedFrame();
      return currentBuilderViewState();
    });

    function currentBuilderViewState(): ViewStateV1 {
      const camera = viewportRef.current?.worldCamera();
      if (!camera) throw new Error('Builder camera is not ready.');
      const hidden = new Set<EntityId>(automationHiddenRef.current);
      for (const entity of Object.values(projectRef.current?.entities ?? {})) {
        if (!entity.visibility.visible) hidden.add(entity.id);
      }
      return {
        schema: 'himmelcad.view-state',
        version: 1,
        camera: fromKernelCamera(camera),
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
  }, [selectionStore]);

  const ensureCanonicalProject = useCallback(async (): Promise<BuilderCanonicalProjectSession> => {
    if (canonicalSessionRef.current) return canonicalSessionRef.current;
    if (canonicalReadyRef.current) return canonicalReadyRef.current;
    const api = window.himmelcad;
    if (!api) throw new Error('Electron bridge missing — cannot open canonical project');
    const opening = (async () => {
      if (!(await api.sidecar.status())) throw new Error('sidecar offline');
      const projectRoot = await api.canonicalProject.defaultRoot();
      const session = await BuilderCanonicalProjectSession.open(projectRoot, api.sidecar.call);
      canonicalSessionRef.current = session;
      const snapshot = session.projectSnapshot();
      await selectionStore.openProject(
        snapshot.projectId,
        new Set(Object.keys(snapshot.entities)),
        (entityId) => snapshot.entities[entityId]?.kind,
        Object.values(snapshot.entities)
          .filter((entity) => !entity.visibility.visible)
          .map((entity) => entity.id),
      );
      setProject(snapshot);
      logEvent('info', 'renderer', `Canonical project opened: ${projectRoot}`);
      const viewport = viewportRef.current;
      if (!viewport) throw new Error('viewer bridge is not ready for canonical residency');
      const residency = await api.canonicalProject.residencyBootstrap();
      const restored = await restoreCanonicalResidency(viewport, residency);
      entityGroupsRef.current.cloud = restored.clouds;
      entityGroupsRef.current.ifc = restored.inlineMeshes;
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
  }, [selectionStore]);

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
          logEvent(
            'warn',
            'renderer',
            `Recovered ${status.recoveredTailCount} journal append(s) from an interrupted flush`,
          );
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
      syncing = true;
      void ensureCanonicalProject()
        .then((session) => session.catchUp())
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
  }, [ensureCanonicalProject, selectionStore]);

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
    if (id === 'import.file') {
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
    } else if (id === 'view.viewing-box' && !viewingBox) {
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
    viewportRef.current?.setViewingBox(viewingBox);
  }, [viewingBox]);

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

  const onSelect = (id: EntityId, mode: 'replace' | 'add' | 'toggle') => {
    if (mode === 'replace') selectionStore.replace([id]);
    else if (mode === 'toggle') selectionStore.toggle(id);
    else selectionStore.replace([...selected, id]);
  };

  const onVisibilityChange = useCallback(
    (id: EntityId, visible: boolean) => {
      if (!project) return;
      const groups = entityGroupsRef.current;
      const entityIds =
        id === project.rootEntity
          ? [...groups.cloud, ...groups.ifc, ...groups.orthophoto, ...groups.mesh]
          : [id];
      viewportRef.current?.setEntityVisibility(entityIds, visible);
      selectionStore.entitiesHidden(entityIds, !visible);
      selectionStore.invalidateCandidates('permissionChange');
      setProject((previous) => {
        if (!previous) return previous;
        const entity = previous.entities[id];
        if (!entity) return previous;
        return {
          ...previous,
          entities: {
            ...previous.entities,
            [id]: { ...entity, visibility: { ...entity.visibility, visible } },
          },
        };
      });
    },
    [project, selectionStore],
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
      selectedEntityIds: [...selected],
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
            | { readonly entityIds?: readonly string[]; readonly payload?: { readonly entityIds?: readonly string[] } }
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
        case 'view.preset.top':
          setNavigationMode('2d');
          await viewportRef.current?.setViewMode('2d');
          return;
        case 'view.preset.front':
        case 'view.preset.right':
        case 'view.preset.isometric':
          setNavigationMode('3d');
          await viewportRef.current?.setViewMode('3d');
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
        case 'project.flush':
          await flushProject();
          return;
        case 'entity.rename':
        case 'entity.export':
        case 'edit.clipboard.paste_in_place':
          activate(invocation.id);
          return;
      }
    },
    [activate, flushProject, onVisibilityChange, selectionStore],
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

  const registerImports = useCallback(async (paths: readonly string[]): Promise<void> => {
    const api = window.himmelcad;
    if (!api) return;
    const items = await registerImportJobs(api, paths);
    setRegistrationItems((current) => [...current, ...items]);
  }, []);

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
  void legacyCommand;

  return (
    <>
      <AppShell
        titleBar={
          <TitleBar
            appName="HimmelCAD"
            productLabel="Builder"
            projectLabel={project?.name ?? 'Opening project…'}
            brandMark={<img className={styles.brandLogo} src={builderLogoUrl} alt="" />}
            controls={windowControls}
          />
        }
        ribbon={<Ribbon tabs={ribbonTabs} />}
        leftPanel={
          project ? (
            <EntityTree
              project={project}
              selectedIds={selected}
              onSelect={onSelect}
              onVisibilityChange={onVisibilityChange}
            />
          ) : (
            <div className={styles.properties}>Opening canonical project…</div>
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
              />
            }
          >
            {functionBody(
              activeFunctionId,
              pointSize,
              setPointSize,
              viewingBox,
              setViewingBox,
              placingViewingBoxCenter,
              setPlacingViewingBoxCenter,
            )}
          </FunctionPanel>
        }
        bottomPanel={
          <Console defaultLevel="info" onCommand={registryConsoleCommand} onCollapse={toggleBottom} />
        }
        viewport={
          <BuilderKernelViewport
            ref={viewportRef}
            pointSize={pointSize}
            onCursorSnap={setSnap}
            selectedEntityIds={selected}
            onSelectEntity={(id, mode) => {
              const kind = projectRef.current?.entities[id]?.kind;
              if (kind === 'PointCloud' || kind === 'GaussianSplatCloud') return;
              onSelect(id, mode);
            }}
            onClearSelection={() => selectionStore.clear()}
            isEntityClickPickable={(id) => {
              const entity = projectRef.current?.entities[id];
              return Boolean(entity?.visibility.visible);
            }}
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
            viewingBox={viewingBox}
            placingViewingBoxCenter={placingViewingBoxCenter}
            onViewportPoint={(position) => {
              const created = viewingBox
                ? placeViewingBoxCenter(viewingBox, {
                    x: position.x,
                    y: position.y,
                    z: position.z ?? viewingBox.center.z,
                  })
                : viewportRef.current?.createViewingBoxAt(position);
              if (created) {
                setViewingBox(created);
                const size = created.halfExtents.x * 2;
                logEvent(
                  'info',
                  'renderer',
                  `Viewing Box placed (${size.toFixed(2)} m cube at the current zoom).`,
                );
              }
              setPlacingViewingBoxCenter(false);
            }}
            onViewingBoxChange={setViewingBox}
            onDropFiles={(paths) => void registerImports(paths)}
            onLog={(level, message) => logEvent(level, 'renderer', message)}
          />
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
          modal
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
          {...(selection.candidates?.items[selection.candidates.index]?.entityId
            ? { currentCandidateId: selection.candidates.items[selection.candidates.index]!.entityId }
            : {})}
          onExecute={executeRegistryCommand}
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
    return viewingBox ? (
      <ViewingBoxPanel
        state={viewingBox}
        placingCenter={placingViewingBoxCenter}
        onChange={onViewingBoxChange}
        onPlacingCenterChange={onPlacingViewingBoxCenterChange}
      />
    ) : (
      <div className={styles.toolHint}>Click the model to place a zoom-scaled viewing box.</div>
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
}

function BuilderPropertiesPanel({
  selectedCount,
  perKind,
  query,
  loading,
  editing,
  error,
  onAssign,
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
  readonly state: KernelViewingBoxState;
  readonly placingCenter: boolean;
  readonly onChange: (state: KernelViewingBoxState | null) => void;
  readonly onPlacingCenterChange: (placing: boolean) => void;
}

function ViewingBoxPanel({
  state,
  placingCenter,
  onChange,
  onPlacingCenterChange,
}: ViewingBoxPanelProps): JSX.Element {
  const modes: readonly { readonly id: KernelViewingBoxMode; readonly label: string }[] = [
    { id: 'resize', label: 'Arrows' },
    { id: 'rotate', label: 'Rings' },
  ];
  return (
    <div className={styles.toolPanel}>
      <div className={styles.segmented} aria-label="Viewing box manipulation">
        {modes.map((mode) => (
          <button
            key={mode.id}
            type="button"
            className={state.mode === mode.id ? styles.segmentActive : styles.segment}
            aria-pressed={state.mode === mode.id}
            onClick={() => onChange(setViewingBoxMode(state, mode.id))}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className={placingCenter ? styles.toolButtonActive : styles.toolButton}
        aria-pressed={placingCenter}
        onClick={() => onPlacingCenterChange(!placingCenter)}
      >
        {placingCenter ? 'Pick center in view…' : 'Set center in view'}
      </button>

      {state.mode === 'move' ? (
        <VectorEditor
          label="Center"
          values={state.center}
          onValue={(axis, value) =>
            onChange({ ...state, center: { ...state.center, [axis]: value } })
          }
        />
      ) : null}
      {state.mode === 'resize' ? (
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
      {state.mode === 'rotate' ? (
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

      <div className={styles.toolActions}>
        <button
          type="button"
          className={state.enabled ? styles.toolButtonActive : styles.toolButton}
          aria-pressed={state.enabled}
          onClick={() => onChange({ ...state, enabled: !state.enabled })}
        >
          {state.enabled ? 'Clipping on' : 'Clipping off'}
        </button>
        <button
          type="button"
          className={styles.toolButtonDanger}
          onClick={() => {
            onPlacingCenterChange(false);
            onChange(null);
          }}
        >
          Remove box
        </button>
      </div>
      <p className={styles.toolHint}>
        Drag a face arrow to resize. Click an arrow for rotation rings; drag a ring to rotate and
        click it to return to arrows.
      </p>
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
          <input
            type="number"
            min={minimum}
            step="any"
            value={Number(values[axis].toPrecision(12))}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isFinite(value) && (minimum === undefined || value >= minimum)) {
                onValue(axis, value);
              }
            }}
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

function fromKernelCamera(camera: KernelWorldCamera): ViewStateV1['camera'] {
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

function toKernelCamera(state: ViewStateV1): KernelWorldCamera {
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

function assertSupportedBuilderPresentation(state: ViewStateV1): void {
  const presentation = state.presentation;
  if (
    presentation.background !== 'black' ||
    presentation.renderStyle !== 'source' ||
    presentation.showGrid ||
    presentation.showAxes ||
    !presentation.showSelectionOutline
  ) {
    throw new Error('The requested Builder presentation controls are not implemented.');
  }
}

function scopedClipVolume(clip: ScopedClip): KernelClipVolume {
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
  const axes = quaternionAxes(clip.primitive.orientation);
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

function quaternionAxes(
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
): Promise<{ readonly clouds: EntityId[]; readonly inlineMeshes: EntityId[] }> {
  if (bootstrap.schemaVersion !== 1) {
    throw new Error('Electron returned an invalid canonical residency bootstrap');
  }
  const clouds = new Set<EntityId>();
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
        });
        clouds.add(admission.entity.id as EntityId);
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
  return { clouds: [...clouds], inlineMeshes: [...inlineMeshes] };
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
