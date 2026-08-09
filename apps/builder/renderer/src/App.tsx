import type {
  PropertyAssignment,
  PropertyQueryResult,
  PropertyQueryRow,
  PropertyValue,
  Quaternion,
  ScopedClip,
  ScreenshotRequestV1,
  ViewStateV1,
} from '@himmelcad/app';
import { encodeRgbaScreenshot, parseViewState, validateScreenshotRequest } from '@himmelcad/app';
import { Console, consoleStore, logEvent } from '@himmelcad/console';
import { ManagedAgentChat, ManagedAutomationApproval } from '@himmelcad/agent';
import type { EntityId, ProjectSnapshot, SnapResult } from '@himmelcad/data';
import {
  AppShell,
  EntityTree,
  FunctionPanel,
  PanelToggles,
  Ribbon,
  StatusBar,
  TitleBar,
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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

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
import { BuilderCanonicalProjectSession } from './project.js';
import { ribbonTabs } from './ribbon.js';

const SIDECAR_PROGRESS_PREFIX = '__HC_PROGRESS__';
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
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<EntityId>>(new Set());
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
  const [registrationSourcePaths, setRegistrationSourcePaths] = useState<readonly string[]>([]);
  const registrationSourcePath = registrationSourcePaths[0] ?? null;
  const [rightPanelTab, setRightPanelTab] = useState<'function' | 'properties'>('function');
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
        }
      }
      for (const id of nextHidden) viewport.setEntityVisibility([id], false);
      automationHiddenRef.current = nextHidden;
      setSelected(new Set(state.selectedEntityIds as readonly EntityId[]));
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
  }, []);

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
      setProject(session.projectSnapshot());
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
  }, []);

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

  useEffect(() => {
    let syncing = false;
    let reportedError = false;
    const timer = window.setInterval(() => {
      if (syncing) return;
      syncing = true;
      void ensureCanonicalProject()
        .then((session) => session.catchUp())
        .then((nextProject) => {
          if (nextProject) setProject(nextProject);
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
  }, [ensureCanonicalProject]);

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
        setRegistrationSourcePaths((current) => [...current, ...paths]);
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
          setRegistrationSourcePaths((current) => [...current, developmentIfcPath]);
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
    if (
      [
        'import.las',
        'import.e57',
        'import.dxf',
        'import.dwg',
        'import.ifc',
        'import.slpk',
      ].includes(id)
    ) {
      void (async () => {
        const api = window.himmelcad;
        if (!api) {
          logEvent('warn', 'renderer', 'no electron bridge: skipping import dialog');
          closeFunction(id);
          return;
        }
        const session = await ensureCanonicalProject();
        const formats = await session.listIoFormats();
        const extensions = formats
          .flatMap((format) => format.extensions)
          .map((value) => value.replace(/^\./, ''));
        const paths = await api.dialog.openImport(extensions);
        closeFunction(id);
        setRegistrationSourcePaths((current) => [...current, ...paths]);
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
      const created = viewportRef.current?.createViewingBoxAt(snap?.position);
      if (created) setViewingBox(created);
    } else if (id === 'output.specs') {
      setSpecsOpen(true);
      closeFunction(id);
    } else if (id === 'output.plan') {
      setPlanOpen(true);
      closeFunction(id);
    } else if (id === 'automation.agent') {
      setAgentOpen(true);
      closeFunction(id);
    }
    // Other ribbon actions only highlight + show their function panel for now.
  }, [activeFunctionId, closeFunction, ensureCanonicalProject, snap?.position, viewingBox]);

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
    setSelected((prev) => {
      const next = new Set(prev);
      if (mode === 'replace') {
        next.clear();
        next.add(id);
      } else if (mode === 'add') {
        next.add(id);
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
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
    [project],
  );

  const onCommand = useCallback(
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
              'commands: help · clear · import.las · view.frame · view.point-size <px> · view.3d · view.2.5d · view.2d · view.clip.horizontal <z> · view.clip.vertical-x <x> · view.clip.vertical-y <y> · view.clip.clear · view.opacity <group> <0..1> · view.exaggeration <group> <factor> · ribbon.<id>',
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
            setRegistrationSourcePaths((current) => [...current, ...paths]);
          })();
          return;
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

  const statusItems = useMemo(
    () => [
      { id: 'tool', content: activeFunctionId ?? 'Idle', align: 'left' as const },
      { id: 'sel', content: `Selected: ${selected.size}`, align: 'left' as const },
      {
        id: 'imp',
        content: registrationSourcePath ? 'Registering import…' : 'Idle',
        align: 'left' as const,
      },
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
    ],
    [
      activeFunctionId,
      pointSize,
      project?.entities,
      registrationSourcePath,
      selected.size,
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
            title={functionTitle(activeFunctionId)}
            activeTab={rightPanelTab}
            onActiveTabChange={setRightPanelTab}
            propertiesTitle={
              selected.size === 1 ? project?.entities[[...selected][0]!]?.name : undefined
            }
            properties={
              <BuilderPropertiesPanel
                selectedCount={selected.size}
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
          <Console defaultLevel="info" onCommand={onCommand} onCollapse={toggleBottom} />
        }
        viewport={
          <BuilderKernelViewport
            ref={viewportRef}
            pointSize={pointSize}
            onCursorSnap={setSnap}
            viewingBox={viewingBox}
            placingViewingBoxCenter={placingViewingBoxCenter}
            onViewportPoint={(position) => {
              setViewingBox((current) =>
                current
                  ? placeViewingBoxCenter(current, {
                      x: position.x,
                      y: position.y,
                      z: position.z ?? current.center.z,
                    })
                  : current,
              );
              setPlacingViewingBoxCenter(false);
            }}
            onDropFiles={(paths) => setRegistrationSourcePaths((current) => [...current, ...paths])}
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
      {registrationSourcePath && canonicalSessionRef.current ? (
        <FloatingTaskIsland modal onRequestClose={() => undefined}>
          <BuilderImportRegistrationIsland
            sourcePath={registrationSourcePath}
            projectLabel={project?.name ?? 'Current project'}
            session={canonicalSessionRef.current}
            onCommitted={async () => {
              const session = canonicalSessionRef.current;
              const viewport = viewportRef.current;
              const api = window.himmelcad;
              if (!session || !viewport || !api) return;
              setProject(await session.refresh());
              const restored = await restoreCanonicalResidency(
                viewport,
                await api.canonicalProject.residencyBootstrap(),
              );
              entityGroupsRef.current.cloud = restored.clouds;
              entityGroupsRef.current.ifc = restored.inlineMeshes;
              logEvent('info', 'renderer', 'Registered import committed and loaded');
            }}
            onClose={() => setRegistrationSourcePaths((current) => current.slice(1))}
          />
        </FloatingTaskIsland>
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
      <div className={styles.toolHint}>Move the cursor over the model to create a viewing box.</div>
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
  readonly query: PropertyQueryResult | null;
  readonly loading: boolean;
  readonly editing: boolean;
  readonly error: string | null;
  readonly onAssign: (assignment: PropertyAssignment) => void;
}

function BuilderPropertiesPanel({
  selectedCount,
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
      <div className={styles.propertySummary}>
        <strong>{selectedCount === 1 ? '1 entity' : `${selectedCount} entities`}</strong>
        <span>{loading ? 'Reading exact revisions…' : 'Canonical selection'}</span>
      </div>
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
            placeholder={row.aggregate.state === 'mixed' ? 'Mixed values' : undefined}
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
          {sharedValue ? propertyValueText(sharedValue) || 'None' : 'Mixed values'}
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
    { id: 'resize', label: 'Size' },
    { id: 'move', label: 'Move' },
    { id: 'rotate', label: 'Rotate' },
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
        The box owns one scoped clip and remains active while other tools are used.
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

function parseSidecarProgress(
  line: string,
): { progressKey: string; fraction: number; message: string } | null {
  const idx = line.indexOf(SIDECAR_PROGRESS_PREFIX);
  if (idx < 0) return null;
  const raw = line.slice(idx + SIDECAR_PROGRESS_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(raw) as {
      progressKey?: unknown;
      fraction?: unknown;
      message?: unknown;
    };
    if (typeof parsed.progressKey !== 'string') return null;
    if (typeof parsed.fraction !== 'number' || !Number.isFinite(parsed.fraction)) return null;
    if (typeof parsed.message !== 'string') return null;
    return {
      progressKey: parsed.progressKey,
      fraction: clamp(parsed.fraction, 0, 1),
      message: parsed.message,
    };
  } catch {
    return null;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
