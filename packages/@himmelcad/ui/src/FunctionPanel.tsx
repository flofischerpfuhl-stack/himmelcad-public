import { useCallback, useEffect, type ReactNode } from 'react';
import { PanelRightClose, Settings2, X } from 'lucide-react';

import styles from './FunctionPanel.module.css';
import { registerEscapeRung } from './escapeLadder.js';
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
  /** Enables UIP-D7 close affordances without changing existing consumers by default. */
  closeFunctionTabs?: boolean;
  onCloseFunction?: (functionId: string) => void;
}

export function FunctionPanel({
  activeFunctionId,
  title,
  children,
  properties,
  propertiesTitle,
  activeTab,
  onActiveTabChange,
  closeFunctionTabs = false,
  onCloseFunction,
}: FunctionPanelProps): JSX.Element {
  const collapseRight = useLayoutStore((s) => s.toggleRightPanel);
  const openFunctionIds = useLayoutStore((s) => s.openFunctionIds);
  const activateFunction = useLayoutStore((s) => s.activateFunction);
  const closeStoredFunction = useLayoutStore((s) => s.closeFunction);
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
  const closeFunction = useCallback(
    (functionId: string) => {
      if (onCloseFunction) onCloseFunction(functionId);
      else closeStoredFunction(functionId);
      if (functionIds.length === 1) onActiveTabChange?.('properties');
    },
    [closeStoredFunction, functionIds.length, onActiveTabChange, onCloseFunction],
  );
  useEffect(() => {
    if (!closeFunctionTabs || selectedTab !== 'function' || !activeFunctionId) return;
    return registerEscapeRung('functionTab', () => {
      closeFunction(activeFunctionId);
      return true;
    });
  }, [activeFunctionId, closeFunction, closeFunctionTabs, selectedTab]);

  const activateTab = (id: string): void => {
    if (id === 'properties') {
      onActiveTabChange?.('properties');
      return;
    }
    const functionId = id.slice('function:'.length);
    if (!closeFunctionTabs || functionId !== activeFunctionId) activateFunction(functionId);
    onActiveTabChange?.('function');
  };
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        {closeFunctionTabs ? (
          <div className={styles.closeableTabs} role="tablist" aria-label="Right panel">
            <button
              type="button"
              role="tab"
              aria-selected={selectedId === 'properties'}
              className={`${styles.closeableTab} ${selectedId === 'properties' ? styles.closeableTabActive : ''}`}
              onClick={() => activateTab('properties')}
            >
              Properties
            </button>
            {functionIds.map((id) => {
              const label =
                id === activeFunctionId ? (title ?? functionLabel(id)) : functionLabel(id);
              const active = selectedId === `function:${id}`;
              // One control per tab: a tablist may only own tabs (ARIA
              // aria-required-children), so the close affordance is a region of
              // the tab itself rather than a nested button. Keyboard users close
              // the active tab with Escape (UIP-D14 rung 7).
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-label={`${label} (close with Escape)`}
                  className={`${styles.closeableTab} ${styles.closeableTabGroup} ${active ? styles.closeableTabActive : ''}`}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest('[data-close-tab]')) {
                      closeFunction(id);
                      return;
                    }
                    activateTab(`function:${id}`);
                  }}
                >
                  <span className={styles.closeableTabLabel}>
                    {label}
                    {id === activeFunctionId && selectedTab === 'properties' ? (
                      <span className={styles.tabDot} aria-hidden />
                    ) : null}
                  </span>
                  <span
                    className={styles.tabClose}
                    data-close-tab
                    title={`Close ${label}`}
                    aria-hidden
                  >
                    <X size={11} />
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <IslandTabs
            ariaLabel="Right panel"
            value={selectedId}
            onChange={activateTab}
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
        )}
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
