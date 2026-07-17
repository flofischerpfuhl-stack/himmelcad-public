import type { ReactNode } from 'react';
import { PanelRightClose, Settings2 } from 'lucide-react';

import styles from './FunctionPanel.module.css';
import { IslandTabs } from './IslandTabs.js';
import { useLayoutStore } from './useLayoutStore.js';

export interface FunctionPanelProps {
  activeFunctionId: string | null;
  title?: string | undefined;
  children?: ReactNode;
  properties?: ReactNode;
  propertiesTitle?: string | undefined;
  activeTab?: 'function' | 'properties';
  onActiveTabChange?: (tab: 'function' | 'properties') => void;
}

export function FunctionPanel({
  activeFunctionId,
  title,
  children,
  properties,
  propertiesTitle,
  activeTab,
  onActiveTabChange,
}: FunctionPanelProps): JSX.Element {
  const collapseRight = useLayoutStore((s) => s.toggleRightPanel);
  const collapseButton = (
    <button
      type="button"
      className={styles.headerCollapse}
      onClick={collapseRight}
      title="Collapse panel"
      aria-label="Collapse right panel"
    >
      <PanelRightClose size={14} />
    </button>
  );

  const functionAvailable = activeFunctionId != null || children != null;
  const propertiesAvailable = properties != null;
  const selectedTab =
    activeTab === 'properties' && propertiesAvailable
      ? 'properties'
      : activeTab === 'function' && functionAvailable
        ? 'function'
        : propertiesAvailable
          ? 'properties'
          : 'function';

  if (!functionAvailable && !propertiesAvailable) {
    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <IslandTabs
            ariaLabel="Right panel"
            value="function"
            onChange={() => undefined}
            items={[{ id: 'function', label: 'Function', disabled: true }]}
          />
          {collapseButton}
        </div>
        <div className={styles.islandBody}>
          <div className={styles.empty}>
            <Settings2 size={28} strokeWidth={1.4} color="var(--hc-fg-subtle)" />
            <div className={styles.emptyTitle}>No active function</div>
            <div className={styles.emptyHint}>
              Activate a function from the ribbon. Its parameters appear here.
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <IslandTabs
          ariaLabel="Right panel"
          value={selectedTab}
          onChange={(id) => onActiveTabChange?.(id as 'function' | 'properties')}
          items={[
            {
              id: 'function',
              label: 'Function',
              disabled: !functionAvailable,
              showDot: Boolean(activeFunctionId && selectedTab !== 'function'),
            },
            {
              id: 'properties',
              label: 'Properties',
              disabled: !propertiesAvailable,
            },
          ]}
        />
        {collapseButton}
      </div>
      <div className={styles.islandBody}>
        <div className={styles.contextName} title={selectedTab === 'function' ? title : propertiesTitle}>
          {selectedTab === 'function'
            ? title ?? activeFunctionId ?? 'Function'
            : propertiesTitle ?? 'Selection'}
        </div>
        <div className={styles.body}>{selectedTab === 'function' ? children : properties}</div>
      </div>
    </div>
  );
}
