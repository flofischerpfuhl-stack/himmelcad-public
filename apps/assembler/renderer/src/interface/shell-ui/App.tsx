import { useCallback, useState } from 'react';

import { AgentAccessIndicator } from '../agent-api/ui/AgentAccessIndicator.js';
import { CommandContextMenu } from './ContextMenu.js';
import { CommandSearch } from './CommandSearch.js';
import { HomeScreen } from './HomeScreen.js';
import { ItemsPanel } from './ItemsPanel.js';
import { KernelActivity } from './KernelActivity.js';
import { LeftDock } from './LeftDock.js';
import { NoticeToast } from './NoticeToast.js';

import { registeredPanels } from '../../platform/widgets/moduleUi.js';
import { NumericKeypad } from '../../platform/widgets/NumericKeypad.js';
import { RightDock } from './RightDock.js';
import panelStyles from '../../platform/widgets/Panel.module.css';
import { SettingsDialog } from './SettingsDialog.js';
import { ShortcutOverlay } from './ShortcutOverlay.js';
import { StatusStrip } from './StatusStrip.js';
import { ToolSession } from './ToolSession.js';
import { TopBar } from './TopBar.js';
import { useGlobalKeyboard } from './useGlobalKeyboard.js';
import { useAssemblerStore, type SelectionItem } from '../../foundation/commands/store.js';
import { Viewport } from '../../platform/viewport/Viewport.js';
import styles from './App.module.css';

interface ContextMenuState {
  x: number;
  y: number;
}

/**
 * Application chrome shell: full-bleed 3D viewport (owned by the viewport
 * agent — see `renderer/src/platform/viewport/Viewport.tsx`) with the top bar, left
 * and right docks, Items/History panels, the adaptive toolbar, tool-session
 * pill, status strip, command search and context menu floating above it as
 * rounded islands (docs/DESIGN-SYSTEM.md "Visual language"), plus the
 * Settings dialog and shortcut overlay. Module panels and dialogs (Section
 * View, Measure, Print mode, import/export, colour, image export …) come
 * from the UI registry (`platform/widgets/moduleUi.ts`).
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
      {overlayPanels.map((panel) => {
        // The modules' floating chrome and dialogs (sketch chrome, Print mode, Slicers…), registered with
        // defineModuleUi; each decides its own visibility.
        const Panel = panel.component;
        return <Panel key={panel.id} state={state} onContextMenu={openContextMenuAt} />;
      })}
      <StatusStrip state={state} />
      <KernelActivity state={state} />
      <AgentAccessIndicator />
      <HomeScreen />
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
      <ShortcutOverlay />
      {/* Touch: the number keypad for value fields (tablet layout or Settings). */}
      <NumericKeypad />
    </div>
  );
}
