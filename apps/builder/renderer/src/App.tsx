import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

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
import { Viewport, type ViewportHandle } from '@himmelcad/viewer';

import { ribbonTabs } from './ribbon.js';
import { applyImportToProject, createEmptyProject, type ImportSummary } from './project.js';

const DEFAULT_POINT_SIZE = 1.5;
const DEFAULT_POINT_BUDGET = 8_000_000;
const SIDECAR_PROGRESS_PREFIX = '__HC_PROGRESS__';

export function App(): JSX.Element {
  const [project, setProject] = useState<ProjectSnapshot>(() => createEmptyProject());
  const [selected, setSelected] = useState<ReadonlySet<EntityId>>(new Set());
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [pointSize, setPointSize] = useState(DEFAULT_POINT_SIZE);
  const [pointBudget, setPointBudget] = useState(DEFAULT_POINT_BUDGET);
  const activeFunctionId = useLayoutStore((s) => s.activeFunctionId);
  const activate = useLayoutStore((s) => s.activateFunction);
  const toggleBottom = useLayoutStore((s) => s.toggleBottomPanel);
  const viewportRef = useRef<ViewportHandle | null>(null);
  const performanceLogTimerRef = useRef<number | null>(null);
  const performanceSettingsMountedRef = useRef(false);

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
    viewportRef.current?.setPointSize(pointSize);
    viewportRef.current?.setPointBudget(pointBudget);
    if (!performanceSettingsMountedRef.current) {
      performanceSettingsMountedRef.current = true;
      return;
    }
    if (performanceLogTimerRef.current) window.clearTimeout(performanceLogTimerRef.current);
    performanceLogTimerRef.current = window.setTimeout(() => {
      logEvent(
        'info',
        'renderer',
        `Point display: size ${pointSize.toFixed(1)} px, budget ${formatPointBudget(pointBudget)}`,
      );
      performanceLogTimerRef.current = null;
    }, 300);
    return () => {
      if (performanceLogTimerRef.current) {
        window.clearTimeout(performanceLogTimerRef.current);
        performanceLogTimerRef.current = null;
      }
    };
  }, [pointSize, pointBudget]);

  const importLasFiles = useCallback(
    async (paths: string[]) => {
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
          const entityId = `pc:${summary.source_name}:${Date.now()}` as EntityId;
          await viewportRef.current?.loadPotreePointCloud(summary.metadata_url, {
            entityId,
            sourceName: summary.source_name,
            renderOffset: summary.render_offset,
            bounds: { min: summary.bounds_min, max: summary.bounds_max },
            pointCount: summary.point_count_total,
            pointSize,
            pointBudget,
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
    },
    [pointSize, pointBudget],
  );

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
              'commands: help · clear · import.las · view.frame · view.point-size <px> · view.point-budget <millions> · ribbon.<id>',
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
        case 'view.point-budget': {
          const next = Number(rest[0]);
          if (Number.isFinite(next)) {
            setPointBudget(Math.round(clamp(next, 0.25, 50) * 1_000_000));
          } else {
            activate('view.performance');
          }
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
        id: 'budget',
        content: `Budget: ${formatPointBudget(pointBudget)}`,
        align: 'right' as const,
      },
      {
        id: 'point-size',
        content: `Point: ${pointSize.toFixed(1)}px`,
        align: 'right' as const,
      },
      { id: 'units', content: 'm', align: 'right' as const },
      { id: 'panels', content: <PanelToggles />, align: 'right' as const },
    ],
    [activeFunctionId, importing, pointBudget, pointSize, project.entities, selected.size, snap],
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
    <AppShell
      titleBar={
        <TitleBar
          appName="HimmelCAD"
          productLabel="Builder"
          projectLabel={project.name}
          controls={windowControls}
        />
      }
      ribbon={<Ribbon tabs={ribbonTabs} />}
      leftPanel={<EntityTree project={project} selectedIds={selected} onSelect={onSelect} />}
      rightPanel={
        <FunctionPanel activeFunctionId={activeFunctionId} title={functionTitle(activeFunctionId)}>
          {functionBody(activeFunctionId, {
            pointSize,
            pointBudget,
            onPointSizeChange: setPointSize,
            onPointBudgetChange: setPointBudget,
          })}
        </FunctionPanel>
      }
      bottomPanel={<Console defaultLevel="info" onCommand={onCommand} onCollapse={toggleBottom} />}
      viewport={
        <Viewport
          key="v3"
          ref={viewportRef}
          onCursorSnap={setSnap}
          onDropFiles={importLasFiles}
          onLog={(level, message) => logEvent(level, 'renderer', message)}
        />
      }
      statusBar={<StatusBar items={statusItems} />}
    />
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
  controls: {
    pointSize: number;
    pointBudget: number;
    onPointSizeChange: (value: number) => void;
    onPointBudgetChange: (value: number) => void;
  },
): JSX.Element | null {
  if (!id) return null;
  if (id === 'view.performance' || id === 'view.point-size') {
    return <PointCloudPerformanceControls {...controls} />;
  }
  return (
    <div style={{ color: 'var(--hc-fg-muted)', fontSize: 12, lineHeight: 1.6 }}>
      Parameters for <code>{id}</code> appear here once the function ships.
    </div>
  );
}

function PointCloudPerformanceControls({
  pointSize,
  pointBudget,
  onPointSizeChange,
  onPointBudgetChange,
}: {
  pointSize: number;
  pointBudget: number;
  onPointSizeChange: (value: number) => void;
  onPointBudgetChange: (value: number) => void;
}): JSX.Element {
  const budgetMillions = pointBudget / 1_000_000;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <label style={controlLabelStyle}>
        <span>Point size</span>
        <input
          type="range"
          min={0.5}
          max={8}
          step={0.1}
          value={pointSize}
          onChange={(e) => onPointSizeChange(clamp(Number(e.currentTarget.value), 0.25, 20))}
        />
        <input
          type="number"
          min={0.25}
          max={20}
          step={0.1}
          value={pointSize}
          onChange={(e) => onPointSizeChange(clamp(Number(e.currentTarget.value), 0.25, 20))}
          style={numberInputStyle}
        />
      </label>
      <label style={controlLabelStyle}>
        <span>Point budget</span>
        <input
          type="range"
          min={1}
          max={30}
          step={1}
          value={budgetMillions}
          onChange={(e) =>
            onPointBudgetChange(
              Math.round(clamp(Number(e.currentTarget.value), 0.25, 50) * 1_000_000),
            )
          }
        />
        <input
          type="number"
          min={0.25}
          max={50}
          step={0.5}
          value={Number(budgetMillions.toFixed(1))}
          onChange={(e) =>
            onPointBudgetChange(
              Math.round(clamp(Number(e.currentTarget.value), 0.25, 50) * 1_000_000),
            )
          }
          style={numberInputStyle}
        />
      </label>
    </div>
  );
}

const controlLabelStyle = {
  display: 'grid',
  gridTemplateColumns: '88px minmax(0, 1fr) 72px',
  gap: 8,
  alignItems: 'center',
  color: 'var(--hc-fg-default)',
  fontSize: 12,
} satisfies CSSProperties;

const numberInputStyle = {
  width: '100%',
  minWidth: 0,
  color: 'var(--hc-fg-default)',
  background: 'var(--hc-bg-island-hi)',
  border: '1px solid var(--hc-border-subtle)',
  borderRadius: 4,
  padding: '4px 6px',
  font: 'inherit',
} satisfies CSSProperties;

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

function formatPointBudget(value: number): string {
  return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
}

// Track loaded point clouds in the entity tree so the user has visual proof.
declare global {
  // helper type narrowing: see project.ts
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface _hc {}
}

// Hooks for kind narrowing (used by FunctionPanel sub-renderers later).
export type _ = EntityKind;
