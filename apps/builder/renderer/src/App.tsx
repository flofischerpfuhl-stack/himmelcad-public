import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Console, consoleStore, logEvent } from '@himmelcad/console';
import type { EntityId, EntityKind, ProjectSnapshot, SnapResult } from '@himmelcad/data';
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

import builderLogoUrl from '../../build/mark.png';

import {
  BuilderKernelViewport,
  type BuilderCanonicalImportPackage,
  type BuilderKernelViewportHandle,
} from './BuilderKernelViewport.js';
import { FloatingTaskIsland } from './FloatingTaskIsland.js';
import { PlanIsland } from './PlanIsland.js';
import { ribbonTabs } from './ribbon.js';
import { applyImportToProject, createEmptyProject, type ImportSummary } from './project.js';
import { SpecsIsland } from './SpecsIsland.js';
import styles from './BuilderApp.module.css';

const SIDECAR_PROGRESS_PREFIX = '__HC_PROGRESS__';
const DEFAULT_POINT_SIZE = 1;

export function App(): JSX.Element {
  const [project, setProject] = useState<ProjectSnapshot>(() => createEmptyProject());
  const [selected, setSelected] = useState<ReadonlySet<EntityId>>(new Set());
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [pointSize, setPointSize] = useState(DEFAULT_POINT_SIZE);
  const [specsOpen, setSpecsOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<'function' | 'properties'>('function');
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>(() =>
    document.documentElement.classList.contains('hc-theme-light') ? 'light' : 'dark',
  );
  const activeFunctionId = useLayoutStore((s) => s.activeFunctionId);
  const activate = useLayoutStore((s) => s.activateFunction);
  const toggleBottom = useLayoutStore((s) => s.toggleBottomPanel);
  const viewportRef = useRef<BuilderKernelViewportHandle | null>(null);
  const initialImportStartedRef = useRef(false);
  const initialMixedSceneStartedRef = useRef(false);
  const entityGroupsRef = useRef({
    cloud: [] as EntityId[],
    ifc: [] as EntityId[],
    orthophoto: [] as EntityId[],
    mesh: [] as EntityId[],
  });

  useEffect(() => {
    document.documentElement.classList.toggle('hc-theme-dark', themeMode === 'dark');
    document.documentElement.classList.toggle('hc-theme-light', themeMode === 'light');
  }, [themeMode]);

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

  const importLasFiles = useCallback(async (paths: string[]) => {
    const api = window.himmelcad;
    if (!api) {
      logEvent('error', 'renderer', 'Electron bridge missing — cannot import LAS');
      return;
    }
    if (paths.length === 0) return;
    setImporting(true);
    const progressKey = `import:${Date.now()}`;
    const total = paths.length;
    const pushProgress = (fraction: number, label: string) => {
      consoleStore.push({
        level: 'info',
        source: 'renderer',
        message: label,
        timestamp: Date.now(),
        progress: Math.min(Math.max(fraction, 0), 1),
        progressKey,
      });
    };
    try {
      pushProgress(0, `Preparing import for ${total} file(s)…`);
      const t0 = performance.now();
      pushProgress(0.01, `Starting LAS/LAZ conversion…`);
      const result = await api.importLas(paths, progressKey);
      const dtImport = performance.now() - t0;
      const importCount = result.imports.length;
      pushProgress(0.86, `Conversion finished. Loading ${importCount} cloud(s) into viewport…`);
      let done = 0;
      for (const summary of result.imports) {
        done++;
        pushProgress(
          0.86 + 0.13 * (done / Math.max(1, importCount)),
          `Loading ${summary.source_name} (${done}/${importCount})…`,
        );
        logEvent(
          'info',
          'sidecar',
          `${summary.source_name}: loaded ${summary.point_count_loaded.toLocaleString()} / ${summary.point_count_total.toLocaleString()} points`,
        );
        const entityId = summary.entity_id as EntityId;
        entityGroupsRef.current.cloud.push(entityId);
        await viewportRef.current?.loadPotreePointCloud(summary.metadata_url, {
          entityId,
          datasetId: summary.dataset_id,
          sourceName: summary.source_name,
          bounds: { min: summary.bounds_min, max: summary.bounds_max },
          pointCount: summary.point_count_total,
        });
        setProject((prev) =>
          applyImportToProject(prev, {
            entityId,
            kind: 'PointCloud',
            name: summary.source_name,
            bounds: { min: summary.bounds_min, max: summary.bounds_max },
            pointCount: summary.point_count_loaded,
          } as ImportSummary),
        );
      }
      const dt = performance.now() - t0;
      pushProgress(
        1,
        `Import finished in ${(dt / 1000).toFixed(2)}s (sidecar ${(dtImport / 1000).toFixed(2)}s)`,
      );
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      consoleStore.push({
        level: 'error',
        source: 'renderer',
        message: `Import failed`,
        timestamp: Date.now(),
        progressKey,
      });
      for (const line of msg.split('\n')) {
        if (line.trim().length > 0) logEvent('error', 'renderer', line);
      }
    } finally {
      setImporting(false);
    }
  }, []);

  useEffect(() => {
    if (initialImportStartedRef.current) return;
    initialImportStartedRef.current = true;
    const api = window.himmelcad;
    if (!api) return;
    void api.dev.initialPreparedPointCloud().then(async (prepared) => {
      if (prepared) {
        const entityId = prepared.entityId as EntityId;
        const bounds = {
          min: prepared.boundsMin as [number, number, number],
          max: prepared.boundsMax as [number, number, number],
        };
        await viewportRef.current?.loadPotreePointCloud(prepared.metadataUrl, {
          entityId,
          datasetId: prepared.datasetId,
          sourceName: prepared.sourceName,
          bounds,
          pointCount: prepared.pointCount,
        });
        entityGroupsRef.current.cloud.push(entityId);
        setProject((previous) =>
          applyImportToProject(previous, {
            entityId,
            kind: 'PointCloud',
            name: prepared.sourceName,
            bounds,
            pointCount: prepared.pointCount,
          }),
        );
        logEvent('info', 'renderer', `Prepared point cloud loaded · ${prepared.pointCount.toLocaleString()} points`);
        return;
      }
      const paths = await api.dev.initialPointCloudPaths();
      if (paths.length === 0) return;
      logEvent('info', 'renderer', `Loading development point cloud: ${paths[0] ?? ''}`);
      await importLasFiles(paths);
    });
  }, [importLasFiles]);

  useEffect(() => {
    if (initialMixedSceneStartedRef.current) return;
    initialMixedSceneStartedRef.current = true;
    const api = window.himmelcad;
    if (!api) return;
    void api.dev.initialMixedScene().then(async (scene) => {
      if (!scene) return;
      if (scene.ifcPath) {
        logEvent('info', 'renderer', `Loading development IFC: ${scene.ifcPath}`);
        const package_ = await api.sidecar.call<BuilderCanonicalImportPackage>('import.ifc', {
          path: scene.ifcPath,
          import_namespace: 'builder-alte-akademie',
        });
        const ids = await viewportRef.current?.loadCanonicalPackage(package_, [
          691112.11, 5334890.385, 517.62,
        ]);
        entityGroupsRef.current.ifc = [...(ids ?? [])];
        const treeId = 'alte-akademie-ifc' as EntityId;
        setProject((previous) =>
          applyImportToProject(previous, {
            entityId: treeId,
            kind: 'IfcElement',
            name: 'Alte Akademie · IFC model',
            bounds: {
              min: [691067.873, 5334794.44, 482.831],
              max: [691306.253, 5335032.82, 721.211],
            },
            pointCount: 0,
          }),
        );
        logEvent('info', 'renderer', `IFC loaded · ${ids?.length ?? 0} canonical entities`);
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
        setProject((previous) =>
          applyImportToProject(previous, {
            entityId,
            kind: 'Orthomosaic',
            name: 'Orthomosaic · 20 cm',
            bounds: {
              min: [691064.265, 5334758.3, 482.75],
              max: [691289.676, 5335057.515, 482.75],
            },
            pointCount: 0,
          }),
        );
        logEvent('info', 'renderer', 'Georeferenced orthomosaic loaded');
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
          setProject((previous) =>
            applyImportToProject(previous, {
              entityId: meshEntityId,
              kind: 'TexturedMesh',
              name: 'Textured terrain · DEM + orthomosaic',
              bounds: {
                min: [691064.265, 5334758.3, 482.035],
                max: [691289.676, 5335057.515, 560.356],
              },
              pointCount: 0,
            }),
          );
          logEvent('info', 'renderer', 'Textured terrain loaded · DEM sampled from dense reconstruction');
        }
      }
      viewportRef.current?.frameAll();
    }).catch((error: unknown) => {
      logEvent('error', 'renderer', `Mixed development scene failed: ${String(error)}`);
    });
  }, []);

  // Hook ribbon actions to real handlers.
  useEffect(() => {
    if (!activeFunctionId) return;
    const id = activeFunctionId;
    if (id === 'import.las') {
      void (async () => {
        const api = window.himmelcad;
        if (!api) {
          logEvent('warn', 'renderer', 'no electron bridge: skipping LAS dialog');
          activate(null);
          return;
        }
        const paths = await api.dialog.openLas();
        activate(null);
        if (paths.length > 0) {
          await importLasFiles(paths);
        }
      })();
    } else if (id === 'view.frame') {
      viewportRef.current?.frameAll();
      activate(null);
    } else if (id === 'output.specs') {
      setSpecsOpen(true);
      activate(null);
    } else if (id === 'output.plan') {
      setPlanOpen(true);
      activate(null);
    }
    // Other ribbon actions only highlight + show their function panel for now.
  }, [activeFunctionId, importLasFiles, activate]);

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

  const onVisibilityChange = useCallback((id: EntityId, visible: boolean) => {
    const groups = entityGroupsRef.current;
    const entityIds = id === project.rootEntity
      ? [...groups.cloud, ...groups.ifc, ...groups.orthophoto, ...groups.mesh]
      : id === ('alte-akademie-ifc' as EntityId)
        ? groups.ifc
        : [id];
    viewportRef.current?.setEntityVisibility(entityIds, visible);
    setProject((previous) => {
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
  }, [project.rootEntity]);

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
              'commands: help · clear · import.las · view.frame · view.point-size <px> · view.top · view.orbit · view.clip.horizontal <z> · view.clip.vertical-x <x> · view.clip.vertical-y <y> · view.clip.clear · view.opacity <group> <0..1> · view.exaggeration <group> <factor> · ribbon.<id>',
          });
          return;
        case 'clear':
          consoleStore.clear();
          return;
        case 'import.las':
          void (async () => {
            const api = window.himmelcad;
            if (!api) {
              logEvent('warn', 'renderer', 'electron bridge missing');
              return;
            }
            const paths = rest.length > 0 ? rest : await api.dialog.openLas();
            if (paths.length === 0) return;
            await importLasFiles(paths);
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
          viewportRef.current?.setNavigationMode('lockedTopDown2d');
          return;
        case 'view.orbit':
          viewportRef.current?.setNavigationMode('orbit3d');
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
    [activate, importLasFiles],
  );

  const statusItems = useMemo(
    () => [
      { id: 'tool', content: activeFunctionId ?? 'Idle', align: 'left' as const },
      { id: 'sel', content: `Selected: ${selected.size}`, align: 'left' as const },
      {
        id: 'imp',
        content: importing ? 'Importing…' : 'Idle',
        align: 'left' as const,
      },
      {
        id: 'pc',
        content: `Clouds: ${
          Object.values(project.entities).filter((e) => e.kind === 'PointCloud').length
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
    [activeFunctionId, importing, pointSize, project.entities, selected.size, snap, themeMode],
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
            projectLabel={project.name}
            brandMark={
              <img className={styles.brandLogo} src={builderLogoUrl} alt="" />
            }
            controls={windowControls}
          />
        }
        ribbon={<Ribbon tabs={ribbonTabs} />}
        leftPanel={
          <EntityTree
            project={project}
            selectedIds={selected}
            onSelect={onSelect}
            onVisibilityChange={onVisibilityChange}
          />
        }
        rightPanel={
          <FunctionPanel
            activeFunctionId={activeFunctionId}
            title={functionTitle(activeFunctionId)}
            activeTab={rightPanelTab}
            onActiveTabChange={setRightPanelTab}
            propertiesTitle={selected.size === 1 ? project.entities[[...selected][0]!]?.name : undefined}
            properties={
              selected.size > 0 ? (
                <div className={styles.properties}>
                  <span>{selected.size === 1 ? 'Selected entity' : 'Selection'}</span>
                  <strong>
                    {selected.size === 1
                      ? (project.entities[[...selected][0]!]?.name ?? 'Unknown')
                      : `${selected.size} entities`}
                  </strong>
                </div>
              ) : null
            }
          >
            {functionBody(activeFunctionId, pointSize, setPointSize)}
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
            onDropFiles={importLasFiles}
            onLog={(level, message) => logEvent(level, 'renderer', message)}
          />
        }
        floatingLeftTabs
        floatingRightTabs
        statusBar={<StatusBar items={statusItems} />}
      />
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
    </>
  );
}

function functionTitle(id: string | null): string | undefined {
  if (!id) return undefined;
  if (id === 'view.performance') return 'point cloud performance';
  if (id === 'view.point-size') return 'point size';
  return id.replace(/[._:-]/g, ' ');
}

function functionBody(
  id: string | null,
  pointSize: number,
  onPointSizeChange: (value: number) => void,
): JSX.Element | null {
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
  return (
    <div style={{ color: 'var(--hc-fg-muted)', fontSize: 12, lineHeight: 1.6 }}>
      Parameters for <code>{id}</code> appear here once the function ships.
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
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

// Track loaded point clouds in the entity tree so the user has visual proof.
declare global {
  // helper type narrowing: see project.ts
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface _hc {}
}

// Hooks for kind narrowing (used by FunctionPanel sub-renderers later).
export type _ = EntityKind;
