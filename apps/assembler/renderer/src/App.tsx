import { useCallback, useState } from 'react';

import { AgentAccessIndicator } from './chrome/AgentAccessIndicator.js';
import { AnalysisLegend } from './chrome/AnalysisLegend.js';
import { ExportImageDialog } from './chrome/ExportImageDialog.js';
import { MeasurePanel } from './chrome/MeasurePanel.js';
import { ColourDialog } from './chrome/ColourDialog.js';
import { CommandContextMenu } from './chrome/ContextMenu.js';
import { CommandSearch } from './chrome/CommandSearch.js';
import { HistoryPanel } from './chrome/HistoryPanel.js';
import { ItemsPanel } from './chrome/ItemsPanel.js';
import { KernelActivity } from './chrome/KernelActivity.js';
import { LeftDock } from './chrome/LeftDock.js';
import { NoticeToast } from './chrome/NoticeToast.js';
import { ParametersPanel } from './chrome/ParametersPanel.js';
import { RightDock } from './chrome/RightDock.js';
import panelStyles from './chrome/Panel.module.css';
import { SectionControls } from './chrome/SectionControls.js';
import { SettingsDialog } from './chrome/SettingsDialog.js';
import { ShortcutOverlay } from './chrome/ShortcutOverlay.js';
import { StatusStrip } from './chrome/StatusStrip.js';
import { ToolSession } from './chrome/ToolSession.js';
import { TopBar } from './chrome/TopBar.js';
import { useGlobalKeyboard } from './chrome/useGlobalKeyboard.js';
import { useAssemblerStore, type SelectionItem } from './model/store.js';
import { PrintChrome } from './print/ui/PrintChrome.js';
import { SketchChrome } from './sketch/ui/SketchChrome.js';
import { Viewport } from './viewport/Viewport.js';
import styles from './App.module.css';

interface ContextMenuState {
  x: number;
  y: number;
}

/**
 * Application chrome shell: full-bleed 3D viewport (owned by the viewport
 * agent — see `renderer/src/viewport/Viewport.tsx`) with the top bar, left
 * and right docks, Items/History panels, the adaptive toolbar, tool-session
 * pill, status strip, command search and context menu floating above it as
 * rounded islands (docs/DESIGN-SYSTEM.md "Visual language"), plus the
 * Settings dialog, shortcut overlay and colour dialog.
 */
export function App(): JSX.Element {
  const state = useAssemblerStore((s) => s);
  const [commandSearch, setCommandSearch] = useState<{ initialQuery?: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const getState = useCallback(() => useAssemblerStore.getState(), []);
  const openSearch = useCallback(
    (initialQuery?: string) => setCommandSearch(initialQuery ? { initialQuery } : {}),
    [],
  );
  useGlobalKeyboard(getState, openSearch);

  const openContextMenuAt = useCallback((x: number, y: number) => {
    setContextMenu({ x, y });
  }, []);

  const handleViewportContextMenu = useCallback(
    (event: { clientX: number; clientY: number; target: SelectionItem | null }) => {
      const current = useAssemblerStore.getState();
      // Right-clicking something already selected keeps a multi-selection.
      const alreadySelected =
        event.target !== null &&
        current.selection.some((item) => JSON.stringify(item) === JSON.stringify(event.target));
      if (event.target && !alreadySelected) current.select(event.target);
      else if (!event.target) current.clearSelection();
      openContextMenuAt(event.clientX, event.clientY);
    },
    [openContextMenuAt],
  );

  return (
    <div className={styles.root}>
      <div className={styles.viewportLayer}>
        <Viewport onContextMenu={handleViewportContextMenu} />
      </div>

      <TopBar state={state} />
      <LeftDock state={state} onOpenSearch={() => openSearch()} />
      <RightDock state={state} />
      {state.panels.items ? <ItemsPanel state={state} onContextMenu={openContextMenuAt} /> : null}
      {state.panels.parameters || state.panels.history ? (
        // Parameters above History in one column below the right dock: they stack, never overlap.
        <div className={panelStyles.rightStack}>
          {state.panels.parameters ? <ParametersPanel state={state} /> : null}
          {state.panels.history ? (
            <HistoryPanel state={state} onContextMenu={openContextMenuAt} />
          ) : null}
        </div>
      ) : null}
      <ToolSession state={state} />
      <SketchChrome />
      {state.viewState.sectionEnabled ? <SectionControls state={state} /> : null}
      <PrintChrome />
      {state.viewState.measureEnabled ? <MeasurePanel state={state} /> : null}
      <AnalysisLegend state={state} />
      <StatusStrip state={state} />
      <KernelActivity state={state} />
      <AgentAccessIndicator />
      <NoticeToast />

      {commandSearch ? (
        <CommandSearch
          state={state}
          {...(commandSearch.initialQuery ? { initialQuery: commandSearch.initialQuery } : {})}
          onClose={() => setCommandSearch(null)}
        />
      ) : null}
      {contextMenu ? (
        <CommandContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          state={state}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
      <SettingsDialog />
      <ColourDialog />
      <ExportImageDialog />
      <ShortcutOverlay />
    </div>
  );
}
