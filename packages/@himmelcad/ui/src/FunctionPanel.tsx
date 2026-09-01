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
  const openFunctionIds = useLayoutStore((s) => s.openFunctionIds);
  const activateFunction = useLayoutStore((s) => s.activateFunction);
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

  const functionAvailable =
    openFunctionIds.length > 0 || activeFunctionId != null || children != null;
  const propertiesAvailable = true;
  const selectedTab =
    activeTab === 'properties' && propertiesAvailable
      ? 'properties'
      : activeTab === 'function' && functionAvailable
        ? 'function'
        : propertiesAvailable
          ? 'properties'
          : 'function';

  const functionIds =
    openFunctionIds.length > 0 ? openFunctionIds : activeFunctionId ? [activeFunctionId] : [];
  const selectedId =
    selectedTab === 'properties' || activeFunctionId === null
      ? 'properties'
      : `function:${activeFunctionId}`;
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <IslandTabs
          ariaLabel="Right panel"
          value={selectedId}
          onChange={(id) => {
            if (id === 'properties') {
              onActiveTabChange?.('properties');
              return;
            }
            const functionId = id.slice('function:'.length);
            activateFunction(functionId);
            onActiveTabChange?.('function');
          }}
          items={[
            {
              id: 'properties',
              label: 'Properties',
              disabled: !propertiesAvailable,
            },
            ...functionIds.map((id) => ({
              id: `function:${id}`,
              label: id === activeFunctionId ? (title ?? functionLabel(id)) : functionLabel(id),
              showDot: Boolean(id === activeFunctionId && selectedTab === 'properties'),
            })),
          ]}
        />
        {collapseButton}
      </div>
      <div className={styles.islandBody}>
        <div className={styles.contextHeader}>
          <span className={styles.contextLabel}>
            {selectedTab === 'function' ? 'Function' : 'Properties'}
          </span>
          <span
            className={styles.contextName}
            title={selectedTab === 'function' ? title : propertiesTitle}
          >
            {selectedTab === 'function'
              ? (title ?? activeFunctionId ?? 'Function')
              : (propertiesTitle ?? 'Selection')}
          </span>
        </div>
        <div className={styles.body}>
          {selectedTab === 'function' ? (
            children
          ) : properties != null ? (
            properties
          ) : (
            <div className={styles.empty}>
              <Settings2 size={28} strokeWidth={1.4} color="var(--hc-fg-subtle)" />
              <div className={styles.emptyTitle}>No selection</div>
              <div className={styles.emptyHint}>Select entities to inspect their properties.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function functionLabel(id: string): string {
  const parts = id.split(/[._:-]+/).filter(Boolean);
  const appNamespaces = new Set([
    'view',
    'import',
    'output',
    'select',
    'inspect',
    'segment',
    'project',
  ]);
  const visible = parts.length > 1 && appNamespaces.has(parts[0]!) ? parts.slice(1) : parts;
  return visible.map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}
