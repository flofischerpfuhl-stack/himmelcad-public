import type { ReactNode } from 'react';

import { EdgeStrip } from './EdgeStrip.js';
import { Splitter } from './Splitter.js';
import { useLayoutStore } from './useLayoutStore.js';
import styles from './AppShell.module.css';

export interface AppShellProps {
  titleBar: ReactNode;
  ribbon: ReactNode;
  leftPanel: ReactNode;
  rightPanel: ReactNode;
  bottomPanel: ReactNode;
  viewport: ReactNode;
  statusBar: ReactNode;
}

/**
 * Dark-Islands AppShell.
 *
 * Layout (top to bottom): titlebar (frameless drag region), ribbon, then
 * a workspace row containing left island, center column (viewport island
 * over a console island), and right island. The void shows through the
 * gaps between islands and is also where the splitters live.
 *
 * INVARIANT: panels never share borders. The void is what separates them.
 */
export function AppShell(props: AppShellProps): JSX.Element {
  const leftCollapsed = useLayoutStore((s) => s.leftPanelCollapsed);
  const rightCollapsed = useLayoutStore((s) => s.rightPanelCollapsed);
  const bottomCollapsed = useLayoutStore((s) => s.bottomPanelCollapsed);
  const leftWidth = useLayoutStore((s) => s.leftPanelWidth);
  const rightWidth = useLayoutStore((s) => s.rightPanelWidth);
  const bottomHeight = useLayoutStore((s) => s.bottomPanelHeight);

  const adjustLeft = useLayoutStore((s) => s.adjustLeftPanelWidth);
  const adjustRight = useLayoutStore((s) => s.adjustRightPanelWidth);
  const adjustBottom = useLayoutStore((s) => s.adjustBottomPanelHeight);
  const toggleLeft = useLayoutStore((s) => s.toggleLeftPanel);
  const toggleRight = useLayoutStore((s) => s.toggleRightPanel);
  const toggleBottom = useLayoutStore((s) => s.toggleBottomPanel);

  return (
    <div className={styles.root}>
      <div className={styles.titleBarSlot}>{props.titleBar}</div>
      <div className={styles.ribbonSlot}>{props.ribbon}</div>
      <div className={styles.workspace}>
        <div className={styles.body}>
          {leftCollapsed ? (
            <EdgeStrip side="left" label="Tree" onExpand={toggleLeft} />
          ) : (
            <>
              <aside
                className={`${styles.island} ${styles.leftPanel}`}
                style={{ width: leftWidth }}
                aria-label="Entity tree"
              >
                {props.leftPanel}
              </aside>
              {/* drag right = grow left panel → positive delta */}
              <Splitter orientation="vertical" onResize={(d) => adjustLeft(d)} />
            </>
          )}
          <main className={styles.center}>
            <section
              className={`${styles.island} ${styles.viewport}`}
              aria-label="3D viewport"
            >
              {props.viewport}
            </section>
            {bottomCollapsed ? (
              <EdgeStrip side="bottom" label="Console" onExpand={toggleBottom} />
            ) : (
              <>
                {/* drag up = grow bottom panel → -delta */}
                <Splitter orientation="horizontal" onResize={(d) => adjustBottom(-d)} />
                <section
                  className={`${styles.island} ${styles.bottomPanel}`}
                  style={{ height: bottomHeight }}
                  aria-label="Console"
                >
                  {props.bottomPanel}
                </section>
              </>
            )}
          </main>
          {rightCollapsed ? (
            <EdgeStrip side="right" label="Function" onExpand={toggleRight} />
          ) : (
            <>
              {/* drag left = grow right panel → -delta */}
              <Splitter orientation="vertical" onResize={(d) => adjustRight(-d)} />
              <aside
                className={`${styles.island} ${styles.rightPanel}`}
                style={{ width: rightWidth }}
                aria-label="Function panel"
              >
                {props.rightPanel}
              </aside>
            </>
          )}
        </div>
      </div>
      <div className={styles.statusBarSlot}>{props.statusBar}</div>
    </div>
  );
}
