import { logEvent } from '@himmelcad/console';
import {
  STANDARD_PAPERS,
  addPlanSheet,
  createBuiltinPlanTemplates,
  createMockViewDescriptor,
  createPlanDocument,
  createPlanSheet,
  createPlanTemplate,
  createViewportPlaceholder,
  duplicatePlanSheet,
  exportPlanDeterministically,
  instantiatePlanTemplate,
  loadPlanLibrary,
  markViewportStale,
  paperCssPixels,
  parsePlanDocument,
  rasterizePlanSvg,
  removePlanSheet,
  renamePlanSheet,
  reorderPlanSheet,
  replaceProjectPlanLibrary,
  replaceSheetScene,
  resolvePaperMm,
  savePlanLibrary,
  serializePlanDocument,
  sheetSceneBounds,
  updatePlanSheet,
  updatePlanMetadata,
  upsertLibraryTemplate,
  type PaperConfig,
  type PlanDocument,
  type PlanElement,
  type PlanLibrary,
  type PlanSheet,
  type PlanTemplateDefinition,
  type PlanViewport,
} from '@himmelcad/plan';
import { Checkbox, Select } from '@himmelcad/ui';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  BringToFront,
  Copy,
  Download,
  FileDown,
  Focus,
  Group,
  Image as ImageIcon,
  Layers,
  Plus,
  Redo2,
  RefreshCw,
  Save,
  SendToBack,
  Trash2,
  Undo2,
  Ungroup,
  Upload,
  X,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
} from 'react';

import styles from './PlanIsland.module.css';

type PlanActionName =
  | 'undo'
  | 'redo'
  | 'group'
  | 'ungroup'
  | 'alignTop'
  | 'alignBottom'
  | 'alignLeft'
  | 'alignRight'
  | 'alignVerticallyCentered'
  | 'alignHorizontallyCentered'
  | 'distributeHorizontally'
  | 'distributeVertically'
  | 'sendBackward'
  | 'bringForward'
  | 'sendToBack'
  | 'bringToFront';

type PaperClamp = (
  viewport: { scrollX: number; scrollY: number; zoom: number },
  paper: readonly [number, number, number, number],
  editor: { width: number; height: number },
  options?: { minimumZoom?: number; maximumZoom?: number; overscroll?: number },
) => { scrollX: number; scrollY: number; zoom: number };

let clampPaperViewport: PaperClamp | null = null;

const Excalidraw = lazy(async () => {
  const module = await import('@excalidraw/excalidraw');
  clampPaperViewport = (module as unknown as { clampHimmelCadPaperViewport: PaperClamp })
    .clampHimmelCadPaperViewport;
  return { default: module.Excalidraw };
});

interface ExcalidrawApi {
  getSceneElements: () => readonly PlanElement[];
  getAppState: () => {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    zoom: { value: number };
    selectedElementIds: Readonly<Record<string, boolean>>;
    viewBackgroundColor?: string;
    gridSize?: number | null;
    gridStep?: number;
    gridModeEnabled?: boolean;
    objectsSnapModeEnabled?: boolean;
  };
  getFiles: () => Readonly<Record<string, unknown>>;
  updateScene: (scene: {
    elements?: readonly PlanElement[];
    appState?: Readonly<Record<string, unknown>>;
    files?: Readonly<Record<string, unknown>>;
  }) => void;
  executeAction: (name: PlanActionName) => boolean;
  scrollToContent: (
    elements?: readonly PlanElement[],
    options?: Readonly<Record<string, unknown>>,
  ) => void;
  refresh: () => void;
}

interface SceneDraft {
  sheetId: string;
  elements: readonly PlanElement[];
  appState: Readonly<Record<string, unknown>>;
  files: Readonly<Record<string, unknown>>;
}

const MOCK_LAYERS = ['Survey', 'Existing', 'Design', 'Annotations'] as const;

export function PlanIsland({ onClose }: { onClose: () => void }): JSX.Element {
  const [plan, setPlan] = useState<PlanDocument>(() =>
    createPlanDocument({
      id: `plan-${crypto.randomUUID()}`,
      name: 'Untitled plan',
      author: 'HimmelCAD user',
    }),
  );
  const [activeSheetId, setActiveSheetId] = useState(plan.sheets[0]!.id);
  const [userLibrary, setUserLibrary] = useState<PlanLibrary>(() => loadPlanLibrary());
  const [leftTab, setLeftTab] = useState<'sheets' | 'library' | 'layers'>('sheets');
  const [libraryScope, setLibraryScope] = useState<'project' | 'user'>('project');
  const [libraryName, setLibraryName] = useState('Reusable group');
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [sceneStats, setSceneStats] = useState({ elements: 0, dirty: false });
  const [status, setStatus] = useState('Ready · .hcplan is the document authority');
  const [error, setError] = useState<string | null>(null);
  const [draggedSheetId, setDraggedSheetId] = useState<string | null>(null);
  const apiRef = useRef<ExcalidrawApi | null>(null);
  const draftRef = useRef<SceneDraft | null>(null);
  const selectionKeyRef = useRef('');
  const clampingRef = useRef(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const builtins = useMemo(() => createBuiltinPlanTemplates(), []);
  const activeSheet = plan.sheets.find((sheet) => sheet.id === activeSheetId) ?? plan.sheets[0]!;
  const paperMm = resolvePaperMm(activeSheet.paper);
  const layout = paperCssPixels(activeSheet.paper, 1_000, 650);
  const selectedViewport = activeSheet.viewports.find((viewport) =>
    selectedIds.includes(viewport.elementId),
  );

  const materialize = useCallback((base: PlanDocument): PlanDocument => {
    const draft = draftRef.current;
    if (!draft) return base;
    draftRef.current = null;
    return replaceSheetScene(base, draft.sheetId, {
      elements: draft.elements,
      appState: draft.appState,
      files: draft.files,
    });
  }, []);

  const mutatePlan = useCallback(
    (mutator: (document: PlanDocument) => PlanDocument): void => {
      setPlan((current) => mutator(materialize(current)));
      setSceneStats((current) => ({ ...current, dirty: false }));
    },
    [materialize],
  );

  const switchSheet = (id: string): void => {
    if (id === activeSheetId) return;
    mutatePlan((document) => document);
    apiRef.current = null;
    selectionKeyRef.current = '';
    setSelectedIds([]);
    setActiveSheetId(id);
    setStatus(`Opened ${plan.sheets.find((sheet) => sheet.id === id)?.name ?? 'sheet'}`);
  };

  const onSceneChange = (
    elements: readonly PlanElement[],
    appState: Readonly<Record<string, unknown>>,
    files: Readonly<Record<string, unknown>>,
  ): void => {
    const selected = selectedElementIds(appState);
    const key = selected.join('|');
    if (key !== selectionKeyRef.current) {
      selectionKeyRef.current = key;
      setSelectedIds(selected);
    }
    draftRef.current = {
      sheetId: activeSheetId,
      elements,
      appState: persistentAppState(appState),
      files,
    };
    const visibleElements = visibleElementCount(elements);
    setSceneStats((current) =>
      current.elements === visibleElements && current.dirty
        ? current
        : { elements: visibleElements, dirty: true },
    );
  };

  const execute = (action: PlanActionName): void => {
    if (!apiRef.current?.executeAction(action)) setStatus(`Select elements to use ${action}.`);
  };

  const zoomToSheet = (): void => {
    const api = apiRef.current;
    if (!api) return;
    const state = api.getAppState();
    const bounds = sheetSceneBounds(activeSheet.paper);
    const width = bounds[2] - bounds[0];
    const height = bounds[3] - bounds[1];
    const zoom = Math.max(0.05, Math.min((state.width - 48) / width, (state.height - 48) / height));
    api.updateScene({
      appState: {
        zoom: { value: zoom },
        scrollX: 24 / zoom,
        scrollY: 24 / zoom,
      },
    });
    setStatus(`Fit ${activeSheet.name} · ${paperMm.widthMm} × ${paperMm.heightMm} mm`);
  };

  const handleScroll = (scrollX: number, scrollY: number, zoom: { value: number }): void => {
    const api = apiRef.current;
    if (!api || !clampPaperViewport || clampingRef.current) return;
    const state = api.getAppState();
    const clamped = clampPaperViewport(
      { scrollX, scrollY, zoom: zoom.value },
      sheetSceneBounds(activeSheet.paper),
      { width: state.width, height: state.height },
      { minimumZoom: 0.05, maximumZoom: 8, overscroll: 120 },
    );
    if (
      Math.abs(clamped.scrollX - scrollX) < 0.01 &&
      Math.abs(clamped.scrollY - scrollY) < 0.01 &&
      Math.abs(clamped.zoom - zoom.value) < 0.0001
    ) {
      return;
    }
    clampingRef.current = true;
    api.updateScene({
      appState: {
        scrollX: clamped.scrollX,
        scrollY: clamped.scrollY,
        zoom: { value: clamped.zoom },
      },
    });
    requestAnimationFrame(() => {
      clampingRef.current = false;
    });
  };

  const addSheet = (): void => {
    const id = `${plan.id}:sheet:${crypto.randomUUID()}`;
    mutatePlan((document) =>
      addPlanSheet(
        document,
        createPlanSheet(id, `Sheet ${document.sheets.length + 1}`),
        activeSheetId,
      ),
    );
    setActiveSheetId(id);
  };

  const duplicateSheet = (): void => {
    const id = `${plan.id}:sheet:${crypto.randomUUID()}`;
    mutatePlan((document) => duplicatePlanSheet(document, activeSheetId, id));
    setActiveSheetId(id);
  };

  const deleteSheet = (): void => {
    if (plan.sheets.length <= 1) {
      setError('A plan must keep at least one sheet.');
      return;
    }
    const index = plan.sheets.findIndex((sheet) => sheet.id === activeSheetId);
    const next = plan.sheets[index + 1] ?? plan.sheets[index - 1]!;
    mutatePlan((document) => removePlanSheet(document, activeSheetId));
    setActiveSheetId(next.id);
  };

  const updatePaper = (patch: Partial<PaperConfig>): void => {
    mutatePlan((document) =>
      updatePlanSheet(document, activeSheetId, (sheet) => ({
        ...sheet,
        paper: { ...sheet.paper, ...patch },
      })),
    );
  };

  const insertTemplate = (template: PlanTemplateDefinition): void => {
    const api = apiRef.current;
    if (!api) return;
    const instanceId = `template-instance-${crypto.randomUUID()}`;
    const offset = activeSheet.paper.marginMm + activeSheet.templateInstances.length * 4;
    const placed = instantiatePlanTemplate(
      template,
      instanceId,
      { x: offset, y: offset },
      {
        project: { name: 'Mock Builder project' },
        plan: { name: plan.name },
        sheet: { name: activeSheet.name },
        user: { name: plan.author || 'HimmelCAD user' },
        viewport: { scale: `1:${selectedViewport?.descriptor.scale ?? 500}` },
      },
    );
    api.updateScene({ elements: [...api.getSceneElements(), ...placed.elements] });
    mutatePlan((document) =>
      updatePlanSheet(document, activeSheetId, (sheet) => ({
        ...sheet,
        templateInstances: [...sheet.templateInstances, placed.instance],
      })),
    );
    setStatus(`Inserted ${template.name} · Excalidraw group`);
  };

  const saveSelectionToLibrary = (): void => {
    const api = apiRef.current;
    if (!api || selectedIds.length === 0) {
      setError('Select one or more Excalidraw elements first.');
      return;
    }
    const selected = api
      .getSceneElements()
      .filter((element) => selectedIds.includes(String(element.id)));
    const bounds = sceneBounds(selected);
    const template = createPlanTemplate({
      id: `template-${crypto.randomUUID()}`,
      revision: 1,
      name: libraryName.trim() || 'Reusable group',
      kind: 'textGroup',
      scope: libraryScope,
      elements: selected,
      widthMm: Math.max(1, bounds.width / 4),
      heightMm: Math.max(1, bounds.height / 4),
      anchors: [{ id: 'center', xMm: bounds.width / 8, yMm: bounds.height / 8 }],
      bindings: [],
    });
    if (libraryScope === 'user') {
      const next = upsertLibraryTemplate(userLibrary, template);
      setUserLibrary(next);
      savePlanLibrary(next);
    } else {
      mutatePlan((document) =>
        replaceProjectPlanLibrary(document, [
          template,
          ...document.projectLibrary.filter((item) => item.id !== template.id),
        ]),
      );
    }
    setStatus(`Saved “${template.name}” to ${libraryScope} library`);
  };

  const addViewport = (): void => {
    const api = apiRef.current;
    if (!api) return;
    const id = `viewport-${crypto.randomUUID()}`;
    const rect = {
      x: activeSheet.paper.marginMm + 8,
      y: activeSheet.paper.marginMm + 8,
      width: Math.max(40, paperMm.widthMm - activeSheet.paper.marginMm * 2 - 16),
      height: Math.max(30, paperMm.heightMm - activeSheet.paper.marginMm * 2 - 55),
    };
    const placeholder = createViewportPlaceholder(id, rect, createMockViewDescriptor(`${id}:view`));
    api.updateScene({ elements: [...api.getSceneElements(), ...placeholder.elements] });
    mutatePlan((document) =>
      updatePlanSheet(document, activeSheetId, (sheet) => ({
        ...sheet,
        viewports: [...sheet.viewports, placeholder.viewport],
      })),
    );
    setStatus('Added model viewport placeholder · adapter is intentionally mocked');
  };

  const updateViewport = (
    viewport: PlanViewport,
    patch: Partial<PlanViewport['descriptor']>,
  ): void => {
    mutatePlan((document) =>
      updatePlanSheet(document, activeSheetId, (sheet) => ({
        ...sheet,
        viewports: sheet.viewports.map((candidate) =>
          candidate.id === viewport.id
            ? {
                ...candidate,
                descriptor: markViewportStale({ ...candidate.descriptor, ...patch }),
              }
            : candidate,
        ),
      })),
    );
  };

  const refreshViewport = (viewport: PlanViewport): void => {
    mutatePlan((document) =>
      updatePlanSheet(document, activeSheetId, (sheet) => ({
        ...sheet,
        viewports: sheet.viewports.map((candidate) =>
          candidate.id === viewport.id
            ? {
                ...candidate,
                descriptor: {
                  ...candidate.descriptor,
                  refreshState: 'clean',
                  viewRevisionHash: `mock:${candidate.id}-refreshed-r${document.revision + 1}`,
                  snapshot: {
                    vectorSceneHash: `mock:${candidate.id}-vector`,
                    generatedAtRevision: document.revision + 1,
                  },
                },
              }
            : candidate,
        ),
      })),
    );
    setStatus('Viewport mock refreshed · no Builder geometry was fabricated');
  };

  const snapshotPlan = (): PlanDocument => {
    const snapshot = materialize(plan);
    setPlan(snapshot);
    setSceneStats((current) => ({ ...current, dirty: false }));
    return snapshot;
  };

  const saveHcplan = (): void => {
    try {
      const snapshot = snapshotPlan();
      downloadText(
        `${safeName(snapshot.name)}.hcplan`,
        serializePlanDocument(snapshot),
        'application/json',
      );
      logEvent(
        'info',
        'renderer',
        `Plan saved · ${snapshot.sheets.length} sheets · revision ${snapshot.revision}`,
      );
      setStatus(`Saved ${snapshot.sheets.length}-sheet .hcplan`);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const exportPlan = async (kind: 'pdf' | 'svg' | 'png'): Promise<void> => {
    const started = performance.now();
    try {
      const snapshot = snapshotPlan();
      const bundle = exportPlanDeterministically(snapshot);
      if (kind === 'pdf') {
        downloadBytes(`${safeName(snapshot.name)}.pdf`, bundle.pdf, 'application/pdf');
      } else if (kind === 'svg') {
        for (const sheet of bundle.sheets) downloadText(sheet.fileName, sheet.svg, 'image/svg+xml');
      } else {
        for (const sheet of bundle.sheets) {
          const blob = await rasterizePlanSvg(sheet.svg);
          downloadBlob(sheet.fileName.replace(/\.svg$/, '.png'), blob);
        }
      }
      downloadText(
        `${safeName(snapshot.name)}-fidelity.json`,
        JSON.stringify(bundle.report, null, 2),
        'application/json',
      );
      const duration = performance.now() - started;
      logEvent(
        'info',
        'renderer',
        `Plan ${kind.toUpperCase()} export complete · ${bundle.report.sheetCount} sheets · ${duration.toFixed(1)} ms`,
      );
      setStatus(
        `${kind.toUpperCase()} exported · ${bundle.report.vectorElementCount} vector · ${bundle.report.warnings.length} warnings`,
      );
      setError(null);
    } catch (caught) {
      const message = errorMessage(caught);
      logEvent('error', 'renderer', `Plan export failed: ${message}`);
      setError(message);
    }
  };

  const importHcplan = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      const imported = parsePlanDocument(await file.text());
      draftRef.current = null;
      apiRef.current = null;
      setPlan(imported);
      setActiveSheetId(imported.sheets[0]!.id);
      setSelectedIds([]);
      setStatus(`Imported ${file.name} · revision ${imported.revision}`);
      setError(null);
    } catch (caught) {
      setError(`Could not import ${file.name}: ${errorMessage(caught)}`);
    }
  };

  const initialData = {
    elements: activeSheet.scene.elements,
    appState: {
      ...activeSheet.scene.appState,
      viewBackgroundColor: '#ffffff',
      gridModeEnabled: false,
      objectsSnapModeEnabled: true,
    },
    files: activeSheet.scene.files,
    scrollToContent: true,
  };
  const availableTemplates = [...builtins, ...plan.projectLibrary, ...userLibrary.templates];

  return (
    <div className={styles.root} role="dialog" aria-label="Plan editor">
      <header className={styles.header} data-task-drag-handle>
        <div className={styles.titleBlock}>
          <h2>Plan · {plan.name}</h2>
          <span>
            rev {plan.revision} · {plan.contentHash.slice(-8)}
          </span>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onClose}
          aria-label="Close plan"
        >
          <X size={15} />
        </button>
      </header>

      <div className={styles.fileToolbar}>
        <ToolbarButton
          icon={<Upload size={14} />}
          label="Open .hcplan"
          onClick={() => importInputRef.current?.click()}
        />
        <ToolbarButton icon={<Save size={14} />} label="Save .hcplan" onClick={saveHcplan} />
        <span className={styles.separator} />
        <ToolbarButton icon={<Undo2 size={14} />} label="Undo" onClick={() => execute('undo')} />
        <ToolbarButton icon={<Redo2 size={14} />} label="Redo" onClick={() => execute('redo')} />
        <ToolbarButton icon={<Group size={14} />} label="Group" onClick={() => execute('group')} />
        <ToolbarButton
          icon={<Ungroup size={14} />}
          label="Ungroup"
          onClick={() => execute('ungroup')}
        />
        <span className={styles.separator} />
        <ToolbarButton
          icon={<AlignStartVertical size={14} />}
          label="Align left"
          onClick={() => execute('alignLeft')}
          compact
        />
        <ToolbarButton
          icon={<AlignCenterVertical size={14} />}
          label="Align center"
          onClick={() => execute('alignVerticallyCentered')}
          compact
        />
        <ToolbarButton
          icon={<AlignEndVertical size={14} />}
          label="Align right"
          onClick={() => execute('alignRight')}
          compact
        />
        <ToolbarButton
          icon={<AlignStartHorizontal size={14} />}
          label="Align top"
          onClick={() => execute('alignTop')}
          compact
        />
        <ToolbarButton
          icon={<AlignCenterHorizontal size={14} />}
          label="Align middle"
          onClick={() => execute('alignHorizontallyCentered')}
          compact
        />
        <ToolbarButton
          icon={<AlignEndHorizontal size={14} />}
          label="Align bottom"
          onClick={() => execute('alignBottom')}
          compact
        />
        <ToolbarButton
          icon={<BringToFront size={14} />}
          label="Bring front"
          onClick={() => execute('bringToFront')}
          compact
        />
        <ToolbarButton
          icon={<SendToBack size={14} />}
          label="Send back"
          onClick={() => execute('sendToBack')}
          compact
        />
        <span className={styles.toolbarSpacer} />
        <ToolbarButton icon={<Focus size={14} />} label="Fit sheet" onClick={zoomToSheet} />
        <ToolbarButton
          icon={<Download size={14} />}
          label="PDF"
          onClick={() => void exportPlan('pdf')}
        />
        <ToolbarButton
          icon={<FileDown size={14} />}
          label="SVG"
          onClick={() => void exportPlan('svg')}
        />
        <ToolbarButton
          icon={<ImageIcon size={14} />}
          label="PNG"
          onClick={() => void exportPlan('png')}
        />
        <input
          ref={importInputRef}
          className={styles.hiddenInput}
          type="file"
          accept=".hcplan,application/json"
          onChange={(event) => void importHcplan(event)}
        />
      </div>

      <div className={styles.workspace}>
        <aside className={styles.leftRail}>
          <div className={styles.railTabs}>
            <button
              type="button"
              className={leftTab === 'sheets' ? styles.tabActive : ''}
              onClick={() => setLeftTab('sheets')}
            >
              Sheets
            </button>
            <button
              type="button"
              className={leftTab === 'library' ? styles.tabActive : ''}
              onClick={() => setLeftTab('library')}
            >
              Library
            </button>
            <button
              type="button"
              className={leftTab === 'layers' ? styles.tabActive : ''}
              onClick={() => setLeftTab('layers')}
            >
              Layers
            </button>
          </div>
          {leftTab === 'sheets' && (
            <SheetsPanel
              plan={plan}
              activeSheetId={activeSheetId}
              draggedSheetId={draggedSheetId}
              onSelect={switchSheet}
              onDragStart={setDraggedSheetId}
              onDrop={(targetId) => {
                if (!draggedSheetId) return;
                const index = plan.sheets.findIndex((sheet) => sheet.id === targetId);
                mutatePlan((document) => reorderPlanSheet(document, draggedSheetId, index));
                setDraggedSheetId(null);
              }}
              onAdd={addSheet}
              onDuplicate={duplicateSheet}
              onDelete={deleteSheet}
            />
          )}
          {leftTab === 'library' && (
            <LibraryPanel
              templates={availableTemplates}
              selectedCount={selectedIds.length}
              name={libraryName}
              scope={libraryScope}
              onName={setLibraryName}
              onScope={setLibraryScope}
              onSaveSelection={saveSelectionToLibrary}
              onInsert={insertTemplate}
            />
          )}
          {leftTab === 'layers' && (
            <div className={styles.panelSection}>
              <h3>Sheet layers</h3>
              <p>Composition stays in Excalidraw. Model layers are pinned per viewport.</p>
              <div className={styles.emptyState}>
                <Layers size={18} /> Select a viewport to edit its model layer filter.
              </div>
            </div>
          )}
        </aside>

        <main className={styles.stage}>
          <div className={styles.paperMeta}>
            {activeSheet.name} · {paperMm.widthMm} × {paperMm.heightMm} mm ·{' '}
            {layout.scale < 1 ? `${Math.round(layout.scale * 100)}% preview` : '100% preview'}
          </div>
          <div className={styles.paper} style={{ width: layout.widthPx, height: layout.heightPx }}>
            <div className={styles.canvasHost} style={EXCALIDRAW_THEME_STYLE}>
              <Suspense
                fallback={<div className={styles.loading}>Loading maintained Excalidraw fork…</div>}
              >
                <Excalidraw
                  key={activeSheet.id}
                  theme="light"
                  initialData={initialData as never}
                  autoFocus
                  handleKeyboardGlobally
                  UIOptions={{
                    canvasActions: {
                      loadScene: false,
                      export: false,
                      saveAsImage: false,
                      toggleTheme: false,
                    },
                  }}
                  excalidrawAPI={(api) => {
                    apiRef.current = api as unknown as ExcalidrawApi;
                    requestAnimationFrame(zoomToSheet);
                  }}
                  onChange={(elements, appState, files) =>
                    onSceneChange(
                      elements as unknown as readonly PlanElement[],
                      appState as unknown as Readonly<Record<string, unknown>>,
                      files as unknown as Readonly<Record<string, unknown>>,
                    )
                  }
                  onScrollChange={handleScroll}
                />
              </Suspense>
            </div>
            <div
              className={styles.marginGuide}
              style={{
                inset: `${(activeSheet.paper.marginMm / paperMm.heightMm) * 100}% ${(activeSheet.paper.marginMm / paperMm.widthMm) * 100}%`,
              }}
            />
          </div>
        </main>

        <aside className={styles.properties}>
          <PropertiesPanel
            plan={plan}
            sheet={activeSheet}
            selectedIds={selectedIds}
            selectedViewport={selectedViewport}
            onPlanName={(name) => {
              if (name.trim()) mutatePlan((document) => updatePlanMetadata(document, { name }));
              else setError('Plan name is required.');
            }}
            onSheetName={(name) => {
              if (name.trim()) {
                mutatePlan((document) => renamePlanSheet(document, activeSheetId, name));
              } else setError('Sheet name is required.');
            }}
            onPaper={updatePaper}
            onAddViewport={addViewport}
            onViewport={updateViewport}
            onRefreshViewport={refreshViewport}
          />
        </aside>
      </div>

      <footer className={styles.statusBar}>
        <span>{error ? `Error · ${error}` : status}</span>
        <span>
          {sceneStats.elements} elements · {selectedIds.length} selected ·{' '}
          {sceneStats.dirty ? 'unsaved scene changes' : 'document synchronized'}
        </span>
      </footer>
    </div>
  );
}

function SheetsPanel({
  plan,
  activeSheetId,
  draggedSheetId,
  onSelect,
  onDragStart,
  onDrop,
  onAdd,
  onDuplicate,
  onDelete,
}: {
  plan: PlanDocument;
  activeSheetId: string;
  draggedSheetId: string | null;
  onSelect: (id: string) => void;
  onDragStart: (id: string) => void;
  onDrop: (id: string) => void;
  onAdd: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <>
      <div className={styles.sheetActions}>
        <button type="button" onClick={onAdd}>
          <Plus size={13} /> Add
        </button>
        <button type="button" onClick={onDuplicate}>
          <Copy size={13} /> Duplicate
        </button>
        <button type="button" onClick={onDelete}>
          <Trash2 size={13} /> Delete
        </button>
      </div>
      <div className={styles.sheetList}>
        {plan.sheets.map((sheet, index) => {
          const paper = resolvePaperMm(sheet.paper);
          return (
            <button
              key={sheet.id}
              type="button"
              draggable
              className={`${styles.sheetCard} ${sheet.id === activeSheetId ? styles.sheetCardActive : ''} ${sheet.id === draggedSheetId ? styles.sheetDragging : ''}`}
              onClick={() => onSelect(sheet.id)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                onDragStart(sheet.id);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event: DragEvent<HTMLButtonElement>) => {
                event.preventDefault();
                onDrop(sheet.id);
              }}
            >
              <span className={styles.sheetNumber}>{index + 1}</span>
              <span
                className={styles.thumbnail}
                style={{ aspectRatio: `${paper.widthMm}/${paper.heightMm}` }}
              >
                <i />
                <b>{visibleElementCount(sheet.scene.elements)}</b>
              </span>
              <span className={styles.sheetName}>{sheet.name}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function LibraryPanel({
  templates,
  selectedCount,
  name,
  scope,
  onName,
  onScope,
  onSaveSelection,
  onInsert,
}: {
  templates: readonly PlanTemplateDefinition[];
  selectedCount: number;
  name: string;
  scope: 'project' | 'user';
  onName: (value: string) => void;
  onScope: (value: 'project' | 'user') => void;
  onSaveSelection: () => void;
  onInsert: (template: PlanTemplateDefinition) => void;
}): JSX.Element {
  const groups = templates.reduce<Map<PlanTemplateDefinition['kind'], PlanTemplateDefinition[]>>(
    (result, template) => {
      const group = result.get(template.kind);
      if (group) group.push(template);
      else result.set(template.kind, [template]);
      return result;
    },
    new Map(),
  );
  return (
    <div className={styles.libraryPanel}>
      <div className={styles.librarySave}>
        <input
          value={name}
          onChange={(event) => onName(event.currentTarget.value)}
          aria-label="Library item name"
        />
        <Select
          value={scope}
          onChange={(event) => onScope(event.currentTarget.value as 'project' | 'user')}
        >
          <option value="project">Project library</option>
          <option value="user">User library</option>
        </Select>
        <button type="button" disabled={selectedCount === 0} onClick={onSaveSelection}>
          Save {selectedCount || ''} selected
        </button>
      </div>
      {[...groups.entries()].map(([kind, items]) => (
        <section key={kind} className={styles.libraryGroup}>
          <h3>{templateKindLabel(kind)}</h3>
          <div className={styles.libraryGrid}>
            {items.map((template) => (
              <button key={template.id} type="button" onClick={() => onInsert(template)}>
                <span>{template.name}</span>
                <small>
                  {template.scope} · r{template.revision}
                </small>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function PropertiesPanel({
  plan,
  sheet,
  selectedIds,
  selectedViewport,
  onPlanName,
  onSheetName,
  onPaper,
  onAddViewport,
  onViewport,
  onRefreshViewport,
}: {
  plan: PlanDocument;
  sheet: PlanSheet;
  selectedIds: readonly string[];
  selectedViewport: PlanViewport | undefined;
  onPlanName: (name: string) => void;
  onSheetName: (name: string) => void;
  onPaper: (patch: Partial<PaperConfig>) => void;
  onAddViewport: () => void;
  onViewport: (viewport: PlanViewport, patch: Partial<PlanViewport['descriptor']>) => void;
  onRefreshViewport: (viewport: PlanViewport) => void;
}): JSX.Element {
  return (
    <>
      <section className={styles.propertySection}>
        <h3>Document</h3>
        <Field label="Plan name">
          <input
            defaultValue={plan.name}
            key={`${plan.id}:${plan.name}`}
            onBlur={(event) => onPlanName(event.currentTarget.value)}
          />
        </Field>
        <Field label="Sheet name">
          <input
            onBlur={(event) => onSheetName(event.currentTarget.value)}
            defaultValue={sheet.name}
            key={`${sheet.id}:${sheet.name}`}
          />
        </Field>
      </section>
      <section className={styles.propertySection}>
        <h3>Paper</h3>
        <Field label="Format">
          <Select
            value={sheet.paper.sizeId}
            onChange={(event) => onPaper({ sizeId: event.currentTarget.value })}
          >
            {STANDARD_PAPERS.map((paper) => (
              <option key={paper.id} value={paper.id}>
                {paper.name}
              </option>
            ))}
            <option value="custom">Custom</option>
          </Select>
        </Field>
        <Field label="Orientation">
          <Select
            value={sheet.paper.orientation}
            onChange={(event) =>
              onPaper({ orientation: event.currentTarget.value as PaperConfig['orientation'] })
            }
          >
            <option value="landscape">Landscape</option>
            <option value="portrait">Portrait</option>
          </Select>
        </Field>
        <Field label="Margin mm">
          <input
            type="number"
            min={0}
            max={50}
            step={1}
            value={sheet.paper.marginMm}
            onChange={(event) => onPaper({ marginMm: Number(event.currentTarget.value) })}
          />
        </Field>
        {sheet.paper.sizeId === 'custom' && (
          <div className={styles.inlineFields}>
            <Field label="Width mm">
              <input
                type="number"
                min={50}
                max={2000}
                value={sheet.paper.customWidthMm ?? 420}
                onChange={(event) => onPaper({ customWidthMm: Number(event.currentTarget.value) })}
              />
            </Field>
            <Field label="Height mm">
              <input
                type="number"
                min={50}
                max={2000}
                value={sheet.paper.customHeightMm ?? 297}
                onChange={(event) => onPaper({ customHeightMm: Number(event.currentTarget.value) })}
              />
            </Field>
          </div>
        )}
      </section>
      <section className={styles.propertySection}>
        <h3>Selection</h3>
        <div className={styles.selectionSummary}>
          {selectedIds.length === 0
            ? 'Nothing selected'
            : `${selectedIds.length} Excalidraw element${selectedIds.length === 1 ? '' : 's'}`}
        </div>
        {!selectedViewport && (
          <button type="button" className={styles.primaryButton} onClick={onAddViewport}>
            Add model viewport
          </button>
        )}
      </section>
      {selectedViewport && (
        <section className={styles.propertySection}>
          <h3>Viewport pin</h3>
          <div className={styles.hashLine}>{selectedViewport.descriptor.viewRevisionHash}</div>
          <Field label="Scale 1:">
            <input
              type="number"
              min={1}
              step={10}
              value={selectedViewport.descriptor.scale}
              onChange={(event) =>
                onViewport(selectedViewport, { scale: Number(event.currentTarget.value) })
              }
            />
          </Field>
          <div
            className={`${styles.refreshState} ${styles[`refresh_${selectedViewport.descriptor.refreshState}`]}`}
          >
            {selectedViewport.descriptor.refreshState}
          </div>
          <h4>Model layers</h4>
          {MOCK_LAYERS.map((layer) => {
            const excluded = selectedViewport.descriptor.layerFilter.layerIds.includes(layer);
            return (
              <Checkbox
                key={layer}
                checked={!excluded}
                onChange={(event) => {
                  const next = event.currentTarget.checked
                    ? selectedViewport.descriptor.layerFilter.layerIds.filter((id) => id !== layer)
                    : [...selectedViewport.descriptor.layerFilter.layerIds, layer].sort();
                  onViewport(selectedViewport, {
                    layerFilter: { mode: 'exclude', layerIds: next },
                  });
                }}
                label={layer}
              />
            );
          })}
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => onRefreshViewport(selectedViewport)}
          >
            <RefreshCw size={13} /> Refresh mock snapshot
          </button>
        </section>
      )}
    </>
  );
}

function ToolbarButton({
  icon,
  label,
  onClick,
  compact = false,
}: {
  icon: JSX.Element;
  label: string;
  onClick: () => void;
  compact?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`${styles.toolbarButton} ${compact ? styles.toolbarButtonCompact : ''}`}
      onClick={onClick}
      title={label}
    >
      {icon}
      {!compact && <span>{label}</span>}
    </button>
  );
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function persistentAppState(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    [
      'viewBackgroundColor',
      'gridSize',
      'gridStep',
      'gridModeEnabled',
      'objectsSnapModeEnabled',
      'scrollX',
      'scrollY',
      'zoom',
      'theme',
    ].flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])),
  );
}

function selectedElementIds(appState: Readonly<Record<string, unknown>>): readonly string[] {
  const selected = appState.selectedElementIds;
  if (typeof selected !== 'object' || selected === null || Array.isArray(selected)) return [];
  return Object.entries(selected as Record<string, unknown>)
    .filter(([, active]) => active === true)
    .map(([id]) => id)
    .sort();
}

function sceneBounds(elements: readonly PlanElement[]): { width: number; height: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const element of elements) {
    const x = numberValue(element.x);
    const y = numberValue(element.y);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + numberValue(element.width));
    maxY = Math.max(maxY, y + numberValue(element.height));
  }
  return Number.isFinite(minX)
    ? { width: maxX - minX, height: maxY - minY }
    : { width: 4, height: 4 };
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function visibleElementCount(elements: readonly PlanElement[]): number {
  return elements.filter((element) => element.isDeleted !== true).length;
}

function templateKindLabel(kind: PlanTemplateDefinition['kind']): string {
  return {
    frame: 'Frames',
    titleBlock: 'Title blocks',
    stamp: 'Stamps',
    northArrow: 'North arrows',
    scaleBar: 'Scale bars',
    legend: 'Legends',
    logo: 'Logos',
    textGroup: 'Text groups',
  }[kind];
}

function downloadText(name: string, value: string, mediaType: string): void {
  downloadBlob(name, new Blob([value], { type: mediaType }));
}

function downloadBytes(name: string, value: Uint8Array, mediaType: string): void {
  downloadBlob(name, new Blob([value as BlobPart], { type: mediaType }));
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function safeName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'plan'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const EXCALIDRAW_THEME_STYLE = {
  '--color-primary': 'var(--hc-accent)',
  '--color-primary-darker': 'var(--hc-accent-strong)',
  '--default-bg-color': 'var(--hc-bg-island)',
  '--island-bg-color': 'var(--hc-bg-island-hi)',
  '--popup-bg-color': 'var(--hc-bg-island)',
} as CSSProperties;
