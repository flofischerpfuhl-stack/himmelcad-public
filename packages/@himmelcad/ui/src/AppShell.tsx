import type { ReactNode } from 'react';

import { Splitter } from './Splitter.js';
import { useLayoutStore } from './useLayoutStore.js';
import styles from './AppShell.module.css';

export interface AppShellProps {
  ribbon: ReactNode;
  leftPanel: ReactNode;
  rightPanel: ReactNode;
  bottomPanel: ReactNode;
  viewport: ReactNode;
  statusBar: ReactNode;
}

export function AppShell(props: AppShellProps): JSX.Element {
  const layout = useLayoutStore();

  return (
    <div className={styles.root}>
      <div className={styles.ribbonSlot}>{props.ribbon}</div>
      <div className={styles.body}>
        {!layout.leftPanelCollapsed && (
          <>
            <aside
              className={styles.leftPanel}
              style={{ width: layout.leftPanelWidth }}
              aria-label="Entity tree"
            >
              {props.leftPanel}
            </aside>
            <Splitter
              orientation="vertical"
              onResize={(d) => layout.setLeftPanelWidth(layout.leftPanelWidth + d)}
            />
          </>
        )}
        <main className={styles.center}>
          <section className={styles.viewport} aria-label="3D viewport">
            {props.viewport}
          </section>
          {!layout.bottomPanelCollapsed && (
            <>
              <Splitter
                orientation="horizontal"
                onResize={(d) => layout.setBottomPanelHeight(layout.bottomPanelHeight - d)}
              />
              <section
                className={styles.bottomPanel}
                style={{ height: layout.bottomPanelHeight }}
                aria-label="Console"
              >
                {props.bottomPanel}
              </section>
            </>
          )}
        </main>
        {!layout.rightPanelCollapsed && (
          <>
            <Splitter
              orientation="vertical"
              onResize={(d) => layout.setRightPanelWidth(layout.rightPanelWidth - d)}
            />
            <aside
              className={styles.rightPanel}
              style={{ width: layout.rightPanelWidth }}
              aria-label="Function panel"
            >
              {props.rightPanel}
            </aside>
          </>
        )}
      </div>
      <div className={styles.statusBarSlot}>{props.statusBar}</div>
    </div>
  );
}
