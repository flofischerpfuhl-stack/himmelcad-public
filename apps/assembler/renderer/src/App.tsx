import { useCallback, useState } from 'react';

import { CommandContextMenu } from './chrome/ContextMenu.js';
import { CommandSearch } from './chrome/CommandSearch.js';
import { HistoryPanel } from './chrome/HistoryPanel.js';
import { ItemsPanel } from './chrome/ItemsPanel.js';
import { LeftDock } from './chrome/LeftDock.js';
import { RightDock } from './chrome/RightDock.js';
import { StatusStrip } from './chrome/StatusStrip.js';
import { ToolSession } from './chrome/ToolSession.js';
import { TopBar } from './chrome/TopBar.js';
import { useGlobalKeyboard } from './chrome/useGlobalKeyboard.js';
import { useAssemblerStore, type SelectionItem } from './model/store.js';
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
 * rounded islands (docs/DESIGN-SYSTEM.md "Visual language").
 */
export function App(): JSX.Element {
  const state = useAssemblerStore((s) => s);
  const [commandSearchOpen, setCommandSearchOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const getState = useCallback(() => useAssemblerStore.getState(), []);
  useGlobalKeyboard(getState, () => setCommandSearchOpen(true));

  const openContextMenuAt = useCallback((x: number, y: number) => {
    setContextMenu({ x, y });
  }, []);

  const handleViewportContextMenu = useCallback(
    (event: { clientX: number; clientY: number; target: SelectionItem | null }) => {
      if (event.target) state.select(event.target);
      else state.clearSelection();
      openContextMenuAt(event.clientX, event.clientY);
    },
    [state, openContextMenuAt],
  );

  return (
    <div className={styles.root}>
      <div className={styles.viewportLayer}>
        <Viewport onContextMenu={handleViewportContextMenu} />
      </div>

      <TopBar state={state} />
      <LeftDock state={state} onOpenSearch={() => setCommandSearchOpen(true)} />
      <RightDock state={state} />
      {state.panels.items ? <ItemsPanel state={state} onContextMenu={openContextMenuAt} /> : null}
      {state.panels.history ? (
        <HistoryPanel state={state} onContextMenu={openContextMenuAt} />
      ) : null}
      <ToolSession state={state} />
      <StatusStrip state={state} />

      {commandSearchOpen ? (
        <CommandSearch state={state} onClose={() => setCommandSearchOpen(false)} />
      ) : null}
      {contextMenu ? (
        <CommandContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          state={state}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}
