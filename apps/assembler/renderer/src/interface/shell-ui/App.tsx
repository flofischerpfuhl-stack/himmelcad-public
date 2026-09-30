import { useCallback, useState } from 'react';

import { AgentAccessIndicator } from '../agent-api/ui/AgentAccessIndicator.js';
import { AnalysisLegend } from '../../chrome/AnalysisLegend.js';
import { ExportImageDialog } from '../../chrome/ExportImageDialog.js';
import { MeasurePanel } from '../../chrome/MeasurePanel.js';
import { ColourDialog } from '../../chrome/ColourDialog.js';
import { CommandContextMenu } from './ContextMenu.js';
import { CommandSearch } from './CommandSearch.js';
import { HomeScreen } from './HomeScreen.js';
import { ItemsPanel } from './ItemsPanel.js';
import { KernelActivity } from './KernelActivity.js';
import { LeftDock } from './LeftDock.js';
import { NoticeToast } from './NoticeToast.js';

import { registeredPanels } from '../../platform/widgets/moduleUi.js';
import { RightDock } from './RightDock.js';
import panelStyles from '../../platform/widgets/Panel.module.css';
import { SectionControls } from '../../chrome/SectionControls.js';
import { SettingsDialog } from './SettingsDialog.js';
import { ShortcutOverlay } from './ShortcutOverlay.js';
import { StatusStrip } from './StatusStrip.js';
import { ToolSession } from './ToolSession.js';
import { TopBar } from './TopBar.js';
import { useGlobalKeyboard } from './useGlobalKeyboard.js';
import { InteropChrome } from '../../interop/ui/InteropChrome.js';
import { useAssemblerStore, type SelectionItem } from '../../foundation/commands/store.js';
import { SketchChrome } from '../../sketch/ui/SketchChrome.js';
import { Viewport } from '../../platform/viewport/Viewport.js';
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
  const rightStack = registeredPanels('rightStack').filter(
    (panel) => panel.isOpen?.(state) ?? true,
  );
  const overlayPanels = registeredPanels('overlay');

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
      {rightStack.length > 0 ? (
        // The modules' panels (Parameters) above History in one column below the right dock:
        // they stack, never overlap. Registered with `defineModuleUi` (`app/uiComposition.ts`).
        <div className={panelStyles.rightStack}>
          {rightStack.map((panel) => {
            const Panel = panel.component;
            return <Panel key={panel.id} state={state} onContextMenu={openContextMenuAt} />;
          })}
        </div>
      ) : null}
      <ToolSession state={state} />
      <SketchChrome />
      {state.viewState.sectionEnabled ? <SectionControls state={state} /> : null}
      {overlayPanels.map((panel) => {
        // The modules' floating chrome and dialogs (Print mode, Slicers…), registered with
        // defineModuleUi; each decides its own visibility.
        const Panel = panel.component;
        return <Panel key={panel.id} state={state} onContextMenu={openContextMenuAt} />;
      })}
      {state.viewState.measureEnabled ? <MeasurePanel state={state} /> : null}
      <AnalysisLegend state={state} />
      <StatusStrip state={state} />
      <KernelActivity state={state} />
      <AgentAccessIndicator />
      <HomeScreen />
      <InteropChrome />
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
