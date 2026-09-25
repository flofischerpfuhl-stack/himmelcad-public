import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  Equal,
  Eye,
  EyeOff,
  Layers,
  Magnet,
  Minus,
  Moon,
  Pencil,
  Plus,
  Redo2,
  Search,
  SlidersHorizontal,
  Spline,
  Star,
  Sun,
  Terminal,
  Undo2,
  X,
  Filter,
  Pentagon,
  ScanLine,
  Camera,
} from 'lucide-react';
import { TitleBar } from '@himmelcad/ui';

import {
  CLOUD_FUNCTIONS,
  LINE_FUNCTIONS,
  QUICK_FUNCTIONS,
  TABS,
  type LabFunction,
} from './data.js';
import {
  CLOUD_ID,
  loadCloud,
  Viewport,
  type CameraPose,
  type CloudData,
  type NavMode,
  type Vec3,
  type ViewportHandle,
} from './Viewport.js';

// ---- Model -------------------------------------------------------------------
interface LabLine {
  readonly id: string;
  readonly name: string;
  readonly kind: 'Breakline' | 'Boundary' | 'Parallel';
  readonly points: readonly Vec3[];
  readonly closed: boolean;
  readonly visible: boolean;
}

type HeightMode = 'same' | 'offset' | 'slope';
type Side = 'left' | 'right' | 'both';

interface ParallelParams {
  readonly distance: number;
  readonly side: Side;
  readonly heightMode: HeightMode;
  readonly dz: number;
  readonly slope: number;
}

interface Preset {
  readonly id: string;
  readonly name: string;
  readonly functionId: 'draw.parallel';
  readonly params: ParallelParams;
}

interface SavedView {
  readonly id: string;
  readonly name: string;
  readonly pose: CameraPose | null;
}

const DEFAULT_PARALLEL: ParallelParams = {
  distance: 2,
  side: 'left',
  heightMode: 'same',
  dz: 0.5,
  slope: 2,
};

function useStored<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const store = useCallback(
    (next: T) => {
      setValue(next);
      localStorage.setItem(key, JSON.stringify(next));
    },
    [key],
  );
  return [value, store];
}

// ---- App -----------------------------------------------------------------------
export function App(): JSX.Element {
  const [theme, setTheme] = useStored<'dark' | 'light'>('lab.theme', 'dark');
  const [cloud, setCloud] = useState<CloudData | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudVisible, setCloudVisible] = useState(true);
  const [lines, setLines] = useState<readonly LabLine[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [navMode, setNavMode] = useState<NavMode>('3d');
  const [openTab, setOpenTab] = useState<string | null>(null);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [parallel, setParallel] = useState<ParallelParams | null>(null);
  const [presets, setPresets] = useStored<readonly Preset[]>('lab.presets', []);
  const [views, setViews] = useState<readonly SavedView[]>([
    { id: 'v1', name: '3D view', pose: null },
  ]);
  const [currentViewId, setCurrentViewId] = useState('v1');
  const [toast, setToast] = useState<string | null>(null);
  const viewport = useRef<ViewportHandle>(null);

  useEffect(() => {
    document.body.classList.toggle('hc-theme-light', theme === 'light');
    document.body.classList.toggle('hc-theme-dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    loadCloud('/cloud.bin')
      .then((data) => {
        setCloud(data);
        setLines(demoLines(data));
      })
      .catch((error: unknown) =>
        setCloudError(error instanceof Error ? error.message : String(error)),
      );
  }, []);

  useEffect(() => {
    if (!toast) return;
    const handle = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(handle);
  }, [toast]);

  const selectedLine = lines.find((line) => line.id === selectedId) ?? null;
  const selectionName = selectedId === CLOUD_ID ? 'Road scan' : (selectedLine?.name ?? null);

  const previews = useMemo(() => {
    if (!parallel || !selectedLine) return [];
    return parallelPaths(selectedLine, parallel);
  }, [parallel, selectedLine]);

  const startParallel = useCallback(
    (params: ParallelParams) => {
      if (!selectedLine) {
        setToast('Select a line first');
        return;
      }
      setParallel(params);
      setRightOpen(true);
    },
    [selectedLine],
  );

  const runFunction = (fn: LabFunction | Preset) => {
    setMenu(null);
    setOpenTab(null);
    if ('params' in fn) {
      startParallel(fn.params);
      return;
    }
    switch (fn.id) {
      case 'draw.parallel':
        startParallel(DEFAULT_PARALLEL);
        return;
      case 'view.frame':
        viewport.current?.frameAll();
        return;
      case 'view.preset.top':
        viewport.current?.topView();
        return;
      case 'view.zoom_selection':
        if (selectedLine) viewport.current?.frameSelection(selectedLine.points);
        else viewport.current?.frameAll();
        return;
      case 'entity.hide':
        if (selectedId === CLOUD_ID) setCloudVisible(false);
        else
          setLines((all) =>
            all.map((line) => (line.id === selectedId ? { ...line, visible: false } : line)),
          );
        setSelectedId(null);
        return;
      case 'entity.delete':
        setLines((all) => all.filter((line) => line.id !== selectedId));
        setSelectedId(null);
        setParallel(null);
        return;
      case 'entity.properties':
        setRightOpen(true);
        return;
      case 'view.save':
        saveView();
        return;
      default:
        setToast(`${fn.label} — not part of this mock-up`);
    }
  };

  const saveView = () => {
    const pose = viewport.current?.pose() ?? null;
    const id = `v${Date.now()}`;
    const name = `View ${views.length + 1}`;
    setViews([...views, { id, name, pose }]);
    setCurrentViewId(id);
    setToast(`Saved “${name}”`);
  };

  const applyParallel = () => {
    if (!parallel || !selectedLine) return;
    const paths = parallelPaths(selectedLine, parallel);
    const created = paths.map((points, index) => ({
      id: `line-${Date.now()}-${index}`,
      name: `Parallel ${parallel.distance.toFixed(2)} m`,
      kind: 'Parallel' as const,
      points,
      closed: false,
      visible: true,
    }));
    setLines([...lines, ...created]);
    setParallel(null);
    setToast(`Created ${created.length} parallel${created.length > 1 ? 's' : ''}`);
  };

  // Escape ladder: menu → flyout → function → selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return;
      if (event.key === 'Escape') {
        if (menu) setMenu(null);
        else if (openTab) setOpenTab(null);
        else if (parallel) setParallel(null);
        else setSelectedId(null);
      } else if (event.key === 'f') viewport.current?.frameAll();
      else if (event.key === 'Delete' && selectedLine)
        runFunction({ id: 'entity.delete', label: 'Delete', icon: Minus });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, openTab, parallel, selectedLine, runFunction]);

  const menuFunctions =
    selectedId === CLOUD_ID ? CLOUD_FUNCTIONS : selectedLine ? LINE_FUNCTIONS : QUICK_FUNCTIONS;
  const menuPresets = selectedLine ? presets : [];

  return (
    <div className="lab-root">
      <TitleBar
        productLabel="BUILDER"
        projectLabel="Deponie Orscholz"
        controls={{
          minimize: () => undefined,
          maximizeToggle: () => undefined,
          close: () => undefined,
          isMaximized: () => Promise.resolve(false),
          onMaximizeChange: () => () => undefined,
        }}
      />
      <main className="lab-stage">
        <Viewport
          ref={viewport}
          cloud={cloud}
          cloudVisible={cloudVisible}
          cloudSelected={selectedId === CLOUD_ID}
          theme={theme}
          navMode={navMode}
          polylines={lines}
          selectedId={selectedId}
          previews={previews}
          onPick={(id) => {
            if (parallel) return;
            setSelectedId(id);
          }}
          onContextMenu={(x, y, picked) => {
            if (picked) setSelectedId(picked);
            setMenu({ x, y });
          }}
          onPointerDownAnywhere={() => {
            setMenu(null);
            setOpenTab(null);
          }}
        />

        {!cloud && <div className="lab-loading">{cloudError ?? 'Loading road scan sample…'}</div>}

        <TopBar
          openTab={openTab}
          onOpenTab={setOpenTab}
          onRun={runFunction}
          onUndo={() => setToast('Undo')}
          onRedo={() => setToast('Redo')}
        />

        <SidePanel side="left" open={leftOpen} title="Layers" onClose={() => setLeftOpen(false)}>
          <LayersPanel
            lines={lines}
            cloudVisible={cloudVisible}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
            onToggleCloud={() => setCloudVisible(!cloudVisible)}
            onToggleLine={(id) =>
              setLines(
                lines.map((line) => (line.id === id ? { ...line, visible: !line.visible } : line)),
              )
            }
          />
        </SidePanel>

        <SidePanel
          side="right"
          open={rightOpen}
          title={parallel ? 'Parallel' : 'Properties'}
          icon={parallel ? Equal : SlidersHorizontal}
          onClose={() => {
            setRightOpen(false);
            setParallel(null);
          }}
        >
          {parallel && selectedLine ? (
            <ParallelPanel
              source={selectedLine}
              params={parallel}
              onChange={setParallel}
              onApply={applyParallel}
              onCancel={() => setParallel(null)}
              onSavePreset={(name) => {
                setPresets([
                  ...presets,
                  { id: `p${Date.now()}`, name, functionId: 'draw.parallel', params: parallel },
                ]);
                setToast(`“${name}” added to the quick menu`);
              }}
            />
          ) : (
            <PropertiesPanel
              line={selectedLine}
              cloudSelected={selectedId === CLOUD_ID}
              cloud={cloud}
            />
          )}
        </SidePanel>

        <BottomBar
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          onToggleLeft={() => setLeftOpen(!leftOpen)}
          onToggleRight={() => setRightOpen(!rightOpen)}
          navMode={navMode}
          onNavMode={setNavMode}
          theme={theme}
          onTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          views={views}
          currentViewId={currentViewId}
          onSelectView={(id) => {
            setCurrentViewId(id);
            const pose = views.find((view) => view.id === id)?.pose;
            if (pose) viewport.current?.setPose(pose);
            else viewport.current?.frameAll();
          }}
          onRenameView={(id, name) =>
            setViews(views.map((view) => (view.id === id ? { ...view, name } : view)))
          }
          onSaveView={saveView}
          onToast={setToast}
        />

        {menu && (
          <ContextWheel
            x={menu.x}
            y={menu.y}
            title={selectionName ?? 'Quick menu'}
            presets={menuPresets}
            functions={menuFunctions}
            onRun={runFunction}
            onClose={() => setMenu(null)}
          />
        )}

        {toast && <div className="lab-toast">{toast}</div>}
      </main>
    </div>
  );
}

// ---- Top bar -------------------------------------------------------------------
function TopBar(props: {
  openTab: string | null;
  onOpenTab: (id: string | null) => void;
  onRun: (fn: LabFunction) => void;
  onUndo: () => void;
  onRedo: () => void;
}): JSX.Element {
  const closeTimer = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => props.onOpenTab(null), 220);
  };
  const tab = TABS.find((candidate) => candidate.id === props.openTab) ?? null;
  return (
    <div
      className="lab-top"
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') scheduleClose();
      }}
      onPointerEnter={cancelClose}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="lab-island lab-pill">
        <IconButton label="Undo" icon={Undo2} onClick={props.onUndo} />
        <IconButton label="Redo" icon={Redo2} onClick={props.onRedo} />
        <span className="lab-divider" />
        {TABS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={`lab-tab ${props.openTab === candidate.id ? 'is-open' : ''}`}
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse') props.onOpenTab(candidate.id);
            }}
            onClick={() => props.onOpenTab(props.openTab === candidate.id ? null : candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
        <span className="lab-divider" />
        <IconButton
          label="Search functions"
          icon={Search}
          onClick={() => props.onRun({ id: 'search', label: 'Search', icon: Search })}
        />
      </div>
      {tab && (
        <div className="lab-island lab-flyout" key={tab.id}>
          {tab.groups.map((group) => (
            <section key={group.label} className="lab-group">
              <div className="lab-group-tiles">
                {group.functions.map((fn) => (
                  <button
                    key={fn.id}
                    type="button"
                    className="lab-tile"
                    onClick={() => props.onRun(fn)}
                  >
                    <fn.icon size={20} strokeWidth={1.6} />
                    <span>{fn.label}</span>
                  </button>
                ))}
              </div>
              <div className="lab-group-label">{group.label}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Bottom bar ----------------------------------------------------------------
function BottomBar(props: {
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  navMode: NavMode;
  onNavMode: (mode: NavMode) => void;
  theme: 'dark' | 'light';
  onTheme: () => void;
  views: readonly SavedView[];
  currentViewId: string;
  onSelectView: (id: string) => void;
  onRenameView: (id: string, name: string) => void;
  onSaveView: () => void;
  onToast: (text: string) => void;
}): JSX.Element {
  const [snap, setSnap] = useState(true);
  return (
    <div className="lab-bottom" onPointerDown={(event) => event.stopPropagation()}>
      <div className="lab-island lab-bottom-group">
        <button
          type="button"
          className={`lab-panel-button ${props.leftOpen ? 'is-active' : ''}`}
          onClick={props.onToggleLeft}
        >
          <Layers size={18} strokeWidth={1.6} />
          <span>Layers</span>
        </button>
      </div>

      <div className="lab-island lab-bottom-group lab-bottom-center">
        <div className="lab-segmented" role="radiogroup" aria-label="Navigation mode">
          {(['3d', '2.5d', '2d'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={props.navMode === mode}
              className={props.navMode === mode ? 'is-active' : ''}
              onClick={() => props.onNavMode(mode)}
            >
              {mode.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="lab-divider" />
        <ViewSwitcher
          views={props.views}
          currentId={props.currentViewId}
          onSelect={props.onSelectView}
          onRename={props.onRenameView}
          onSave={props.onSaveView}
        />
        <span className="lab-divider" />
        <IconButton
          label={snap ? 'Snapping on' : 'Snapping off'}
          icon={Magnet}
          active={snap}
          onClick={() => setSnap(!snap)}
        />
        <IconButton
          label="Selectable kinds"
          icon={Filter}
          onClick={() => props.onToast('Selectable kinds')}
        />
      </div>

      <div className="lab-island lab-bottom-group">
        <span className="lab-status" title="WebGL2 on a hardware adapter">
          <span className="lab-status-dot" />
          WebGL2
        </span>
        <IconButton label="Console" icon={Terminal} onClick={() => props.onToast('Console')} />
        <IconButton label="Agent" icon={Bot} onClick={() => props.onToast('Agent')} />
        <IconButton
          label={props.theme === 'dark' ? 'Light theme' : 'Dark theme'}
          icon={props.theme === 'dark' ? Sun : Moon}
          onClick={props.onTheme}
        />
        <button
          type="button"
          className={`lab-panel-button ${props.rightOpen ? 'is-active' : ''}`}
          onClick={props.onToggleRight}
        >
          <SlidersHorizontal size={18} strokeWidth={1.6} />
          <span>Properties</span>
        </button>
      </div>
    </div>
  );
}

function ViewSwitcher(props: {
  views: readonly SavedView[];
  currentId: string;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onSave: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const current = props.views.find((view) => view.id === props.currentId) ?? props.views[0]!;
  const [draft, setDraft] = useState(current.name);
  useEffect(() => setDraft(current.name), [current.name]);
  const commit = () => {
    const name = draft.trim();
    if (name) props.onRename(current.id, name);
    setEditing(false);
  };
  return (
    <div className="lab-view-switcher">
      {editing ? (
        <input
          className="lab-input lab-view-input"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="lab-view-button"
          onClick={() => setOpen(!open)}
          onDoubleClick={() => setEditing(true)}
        >
          <span>{current.name}</span>
          <ChevronDown size={14} strokeWidth={1.8} />
        </button>
      )}
      {open && (
        <div className="lab-island lab-popover lab-view-popover">
          {props.views.length > 1 &&
            props.views.map((view) => (
              <button
                key={view.id}
                type="button"
                className={`lab-row ${view.id === props.currentId ? 'is-current' : ''}`}
                onClick={() => {
                  props.onSelect(view.id);
                  setOpen(false);
                }}
              >
                <ScanLine size={16} strokeWidth={1.6} />
                <span>{view.name}</span>
                {view.id === props.currentId && <Check size={15} className="lab-row-end" />}
              </button>
            ))}
          {props.views.length > 1 && <div className="lab-popover-divider" />}
          <button
            type="button"
            className="lab-row"
            onClick={() => {
              setOpen(false);
              setEditing(true);
            }}
          >
            <Pencil size={16} strokeWidth={1.6} />
            <span>Rename “{current.name}”</span>
          </button>
          <button
            type="button"
            className="lab-row"
            onClick={() => {
              setOpen(false);
              props.onSave();
            }}
          >
            <Camera size={16} strokeWidth={1.6} />
            <span>Save current view</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Side panels ---------------------------------------------------------------
function SidePanel(props: {
  side: 'left' | 'right';
  open: boolean;
  title: string;
  icon?: typeof Layers;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const Icon = props.icon ?? Layers;
  return (
    <aside
      className={`lab-island lab-side lab-side-${props.side} ${props.open ? 'is-open' : ''}`}
      aria-hidden={!props.open}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="lab-side-header">
        <Icon size={17} strokeWidth={1.6} />
        <span>{props.title}</span>
        <IconButton label="Close" icon={X} onClick={props.onClose} small />
      </header>
      <div className="lab-side-body">{props.children}</div>
    </aside>
  );
}

function LayersPanel(props: {
  lines: readonly LabLine[];
  cloudVisible: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggleCloud: () => void;
  onToggleLine: (id: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const visible = props.lines.filter((line) =>
    line.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="lab-search">
        <Search size={15} strokeWidth={1.6} />
        <input
          className="lab-search-input"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="lab-tree-group">Scan</div>
      <TreeRow
        label="Road scan"
        meta="400 k pts"
        icon={ScanLine}
        selected={props.selectedId === CLOUD_ID}
        visible={props.cloudVisible}
        onSelect={() => props.onSelect(CLOUD_ID)}
        onToggle={props.onToggleCloud}
      />
      <div className="lab-tree-group">Drafting</div>
      {visible.map((line) => (
        <TreeRow
          key={line.id}
          label={line.name}
          meta={`${line.points.length} vertices`}
          icon={line.kind === 'Boundary' ? Pentagon : line.kind === 'Parallel' ? Equal : Spline}
          selected={props.selectedId === line.id}
          visible={line.visible}
          onSelect={() => props.onSelect(line.id)}
          onToggle={() => props.onToggleLine(line.id)}
        />
      ))}
      <div className="lab-tree-group">Surfaces</div>
      <div className="lab-empty">No surfaces yet</div>
    </>
  );
}

function TreeRow(props: {
  label: string;
  meta: string;
  icon: typeof Layers;
  selected: boolean;
  visible: boolean;
  onSelect: () => void;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div
      className={`lab-tree-row ${props.selected ? 'is-selected' : ''} ${props.visible ? '' : 'is-hidden'}`}
    >
      <button type="button" className="lab-tree-main" onClick={props.onSelect}>
        <props.icon size={16} strokeWidth={1.6} />
        <span className="lab-tree-label">{props.label}</span>
        <span className="lab-tree-meta">{props.meta}</span>
      </button>
      <IconButton
        label={props.visible ? 'Hide' : 'Show'}
        icon={props.visible ? Eye : EyeOff}
        onClick={props.onToggle}
        small
      />
    </div>
  );
}

function PropertiesPanel(props: {
  line: LabLine | null;
  cloudSelected: boolean;
  cloud: CloudData | null;
}): JSX.Element {
  if (props.cloudSelected) {
    return (
      <PropertyList
        rows={[
          ['Name', 'Road scan'],
          ['Type', 'Point cloud'],
          ['Points (sample)', `${props.cloud?.count.toLocaleString('en-US') ?? '—'}`],
          ['Source', 'PW_GHT_251215_Orscholz_Deponie-1-1.las'],
          ['Color', 'RGB'],
        ]}
      />
    );
  }
  if (!props.line)
    return <div className="lab-empty lab-empty-large">Select an object to see its properties.</div>;
  const { length2d, length3d, zmin, zmax } = measure(props.line);
  return (
    <PropertyList
      rows={[
        ['Name', props.line.name],
        ['Type', `3D ${props.line.closed ? 'polygon' : 'polyline'}`],
        ['Vertices', String(props.line.points.length)],
        ['Length 2D', `${length2d.toFixed(2)} m`],
        ['Length 3D', `${length3d.toFixed(2)} m`],
        ['Height range', `${zmin.toFixed(2)} – ${zmax.toFixed(2)} m`],
        ['Layer', 'Default'],
      ]}
    />
  );
}

function PropertyList(props: { rows: readonly (readonly [string, string])[] }): JSX.Element {
  return (
    <dl className="lab-props">
      {props.rows.map(([key, value]) => (
        <div key={key} className="lab-prop">
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ParallelPanel(props: {
  source: LabLine;
  params: ParallelParams;
  onChange: (params: ParallelParams) => void;
  onApply: () => void;
  onCancel: () => void;
  onSavePreset: (name: string) => void;
}): JSX.Element {
  const { params } = props;
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const suggestion = presetName(params);
  const set = (patch: Partial<ParallelParams>) => props.onChange({ ...params, ...patch });
  return (
    <div className="lab-function">
      <div className="lab-field">
        <label>Source</label>
        <div className="lab-chip">
          <Spline size={14} strokeWidth={1.6} />
          {props.source.name}
        </div>
      </div>
      <NumberField
        label="Distance"
        unit="m"
        value={params.distance}
        step={0.25}
        min={0.05}
        onChange={(distance) => set({ distance })}
      />
      <div className="lab-hint">Or drag the preview in the view.</div>
      <div className="lab-field">
        <label>Side</label>
        <Segmented
          value={params.side}
          options={[
            ['left', 'Left'],
            ['right', 'Right'],
            ['both', 'Both'],
          ]}
          onChange={(side) => set({ side })}
        />
      </div>
      <div className="lab-field">
        <label>Height</label>
        <Segmented
          value={params.heightMode}
          options={[
            ['same', 'Same height'],
            ['offset', 'Offset'],
            ['slope', 'Slope'],
          ]}
          onChange={(heightMode) => set({ heightMode })}
        />
      </div>
      {params.heightMode === 'offset' && (
        <NumberField
          label="Height offset"
          unit="m"
          value={params.dz}
          step={0.1}
          onChange={(dz) => set({ dz })}
        />
      )}
      {params.heightMode === 'slope' && (
        <>
          <NumberField
            label="Slope"
            unit="%"
            value={params.slope}
            step={0.5}
            onChange={(slope) => set({ slope })}
          />
          <div className="lab-hint">
            Height change {((params.slope * params.distance) / 100).toFixed(3)} m over{' '}
            {params.distance.toFixed(2)} m.
          </div>
        </>
      )}
      <div className="lab-function-actions">
        <button type="button" className="lab-button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" className="lab-button lab-button-primary" onClick={props.onApply}>
          Apply
        </button>
      </div>
      <div className="lab-preset">
        {saving ? (
          <div className="lab-preset-form">
            <label>Name in the quick menu</label>
            <div className="lab-preset-row">
              <span className="lab-preset-icon">
                <Equal size={16} strokeWidth={1.6} />
              </span>
              <input
                className="lab-input"
                autoFocus
                placeholder={suggestion}
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    props.onSavePreset(name.trim() || suggestion);
                    setSaving(false);
                    setName('');
                  }
                }}
              />
            </div>
            <div className="lab-function-actions">
              <button type="button" className="lab-button" onClick={() => setSaving(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="lab-button lab-button-primary"
                onClick={() => {
                  props.onSavePreset(name.trim() || suggestion);
                  setSaving(false);
                  setName('');
                }}
              >
                Add
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="lab-link" onClick={() => setSaving(true)}>
            <Plus size={15} strokeWidth={1.8} />
            Add to quick menu
          </button>
        )}
      </div>
    </div>
  );
}

function NumberField(props: {
  label: string;
  unit: string;
  value: number;
  step: number;
  min?: number;
  onChange: (value: number) => void;
}): JSX.Element {
  const [text, setText] = useState(props.value.toFixed(2));
  useEffect(() => setText(props.value.toFixed(2)), [props.value]);
  const clamp = (value: number) => (props.min === undefined ? value : Math.max(props.min, value));
  return (
    <div className="lab-field">
      <label>{props.label}</label>
      <div className="lab-number">
        <button
          type="button"
          aria-label={`Decrease ${props.label}`}
          onClick={() => props.onChange(clamp(props.value - props.step))}
        >
          <Minus size={16} strokeWidth={1.8} />
        </button>
        <input
          className="lab-number-input"
          inputMode="decimal"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            const parsed = Number.parseFloat(text.replace(',', '.'));
            if (Number.isFinite(parsed)) props.onChange(clamp(parsed));
            else setText(props.value.toFixed(2));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          }}
        />
        <span className="lab-number-unit">{props.unit}</span>
        <button
          type="button"
          aria-label={`Increase ${props.label}`}
          onClick={() => props.onChange(clamp(props.value + props.step))}
        >
          <Plus size={16} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}

function Segmented<T extends string>(props: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="lab-segmented lab-segmented-wide" role="radiogroup">
      {props.options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={props.value === value}
          className={props.value === value ? 'is-active' : ''}
          onClick={() => props.onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ---- Context wheel (quick menu) ------------------------------------------------
function ContextWheel(props: {
  x: number;
  y: number;
  title: string;
  presets: readonly Preset[];
  functions: readonly LabFunction[];
  onRun: (fn: LabFunction | Preset) => void;
  onClose: () => void;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const ROW = 48;
  const VISIBLE = 5;
  const entries: readonly (LabFunction | Preset)[] = [...props.presets, ...props.functions];
  const height = Math.min(entries.length, VISIBLE) * ROW;
  const left = Math.min(props.x + 8, window.innerWidth - 316);
  const top = Math.min(Math.max(props.y - height / 2 - 20, 48), window.innerHeight - height - 110);
  const wheel = entries.length > VISIBLE;
  return (
    <div
      className="lab-island lab-wheel"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="lab-wheel-title">
        <span>{props.title}</span>
        <button
          type="button"
          className="lab-wheel-close"
          aria-label="Close"
          onClick={props.onClose}
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>
      <div
        ref={listRef}
        className={`lab-wheel-list ${wheel ? 'is-wheel' : ''} ${scroll > 1 ? 'fade-top' : ''} ${
          scroll + height < entries.length * ROW - 1 ? 'fade-bottom' : ''
        }`}
        style={{ height }}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
      >
        {entries.map((entry, index) => {
          const isPreset = 'params' in entry;
          const Icon = isPreset ? Equal : entry.icon;
          // Only rows near an edge that has more entries behind it recede (wheel feel);
          // the list start and end stay fully legible.
          const rowTop = index * ROW - scroll;
          const hiddenAbove = scroll > 1;
          const hiddenBelow = scroll + height < entries.length * ROW - 1;
          const edge = Math.min(
            hiddenAbove ? rowTop : Infinity,
            hiddenBelow ? height - (rowTop + ROW) : Infinity,
          );
          const distance = wheel && edge < ROW ? Math.min(1, Math.max(0, (ROW - edge) / ROW)) : 0;
          return (
            <button
              key={`${isPreset ? 'preset' : 'fn'}-${entry.id}`}
              type="button"
              className="lab-wheel-row"
              style={{ opacity: 1 - distance * 0.55, transform: `scale(${1 - distance * 0.06})` }}
              onClick={() => props.onRun(entry)}
            >
              <span className="lab-wheel-icon">
                <Icon size={18} strokeWidth={1.6} />
              </span>
              <span className="lab-wheel-label">{isPreset ? entry.name : entry.label}</span>
              {isPreset && <Star size={13} className="lab-wheel-star" aria-label="Your preset" />}
            </button>
          );
        })}
      </div>
      {wheel && <div className="lab-wheel-hint">Scroll for more</div>}
    </div>
  );
}

function IconButton(props: {
  label: string;
  icon: typeof Layers;
  onClick: () => void;
  active?: boolean;
  small?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`lab-icon-button ${props.active ? 'is-active' : ''} ${props.small ? 'is-small' : ''}`}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
    >
      <props.icon size={props.small ? 16 : 18} strokeWidth={1.6} />
    </button>
  );
}

// ---- Geometry helpers ----------------------------------------------------------
function demoLines(cloud: CloudData): LabLine[] {
  const drape = (x: number, y: number): Vec3 => [x, y, cloud.heightAt(x, y) + 0.15];
  const breakline: Vec3[] = [];
  for (let i = 0; i <= 24; i += 1) {
    const t = i / 24;
    const x = -78 + 150 * t;
    const y = -30 + 34 * Math.sin(t * 2.4) + 10 * t;
    breakline.push(drape(x, y));
  }
  const boundary: Vec3[] = [];
  for (let i = 0; i < 18; i += 1) {
    const a = (i / 18) * Math.PI * 2;
    const r = 34 + 6 * Math.sin(a * 3);
    boundary.push(drape(28 + r * Math.cos(a), 34 + r * 0.8 * Math.sin(a)));
  }
  return [
    {
      id: 'breakline-1',
      name: 'Breakline 1',
      kind: 'Breakline',
      points: breakline,
      closed: false,
      visible: true,
    },
    {
      id: 'boundary-1',
      name: 'Boundary 1',
      kind: 'Boundary',
      points: boundary,
      closed: true,
      visible: true,
    },
  ];
}

function parallelPaths(line: LabLine, params: ParallelParams): Vec3[][] {
  const sides = params.side === 'both' ? [1, -1] : [params.side === 'left' ? 1 : -1];
  return sides.map((sign) => offsetPolyline(line.points, sign * params.distance, params));
}

function offsetPolyline(points: readonly Vec3[], offset: number, params: ParallelParams): Vec3[] {
  const distance = Math.abs(offset);
  const dz =
    params.heightMode === 'same'
      ? 0
      : params.heightMode === 'offset'
        ? params.dz
        : (params.slope / 100) * distance;
  return points.map((point, index) => {
    const prev = points[Math.max(0, index - 1)]!;
    const next = points[Math.min(points.length - 1, index + 1)]!;
    const tx = next[0] - prev[0];
    const ty = next[1] - prev[1];
    const length = Math.hypot(tx, ty) || 1;
    const nx = -ty / length;
    const ny = tx / length;
    return [point[0] + nx * offset, point[1] + ny * offset, point[2] + dz];
  });
}

function measure(line: LabLine): {
  length2d: number;
  length3d: number;
  zmin: number;
  zmax: number;
} {
  let length2d = 0;
  let length3d = 0;
  let zmin = Infinity;
  let zmax = -Infinity;
  const count = line.closed ? line.points.length : line.points.length - 1;
  for (let i = 0; i < line.points.length; i += 1) {
    const p = line.points[i]!;
    zmin = Math.min(zmin, p[2]);
    zmax = Math.max(zmax, p[2]);
    if (i < count) {
      const q = line.points[(i + 1) % line.points.length]!;
      const d2 = Math.hypot(q[0] - p[0], q[1] - p[1]);
      length2d += d2;
      length3d += Math.hypot(d2, q[2] - p[2]);
    }
  }
  return { length2d, length3d, zmin, zmax };
}

function presetName(params: ParallelParams): string {
  const height =
    params.heightMode === 'same'
      ? 'same height'
      : params.heightMode === 'offset'
        ? `Δz ${params.dz >= 0 ? '+' : ''}${params.dz.toFixed(2)} m`
        : `slope ${params.slope.toFixed(1)} %`;
  return `Parallel ${params.distance.toFixed(2)} m, ${height}`;
}
