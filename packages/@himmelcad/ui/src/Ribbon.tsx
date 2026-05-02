import { useState } from 'react';

import styles from './Ribbon.module.css';
import { useLayoutStore } from './useLayoutStore.js';

export interface RibbonAction {
  id: string;
  label: string;
  shortcut?: string;
  onActivate?: () => void;
}

export interface RibbonGroup {
  id: string;
  label: string;
  actions: RibbonAction[];
}

export interface RibbonTab {
  id: string;
  label: string;
  groups: RibbonGroup[];
}

export interface RibbonProps {
  tabs: RibbonTab[];
}

export function Ribbon({ tabs }: RibbonProps): JSX.Element {
  const collapsed = useLayoutStore((s) => s.ribbonCollapsed);
  const setCollapsed = useLayoutStore((s) => s.setRibbonCollapsed);
  const activate = useLayoutStore((s) => s.activateFunction);

  const [activeTabId, setActiveTabId] = useState(tabs[0]?.id ?? '');
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  return (
    <div className={`${styles.root} ${collapsed ? styles.collapsed : ''}`}>
      <div className={styles.tabRow}>
        <div className={styles.brand}>himmel:cad</div>
        <div className={styles.tabs} role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeTabId}
              className={`${styles.tab} ${tab.id === activeTabId ? styles.tabActive : ''}`}
              onClick={() => setActiveTabId(tab.id)}
              onContextMenu={(e) => {
                // RMB on a tab is reserved for "add to quick bar" later.
                e.preventDefault();
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          className={styles.collapseToggle}
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'Expand ribbon' : 'Collapse ribbon'}
          aria-label={collapsed ? 'Expand ribbon' : 'Collapse ribbon'}
        >
          {collapsed ? '▾' : '▴'}
        </button>
      </div>
      {!collapsed && activeTab && (
        <div className={styles.groupRow}>
          {activeTab.groups.map((group) => (
            <div key={group.id} className={styles.group}>
              <div className={styles.groupBody}>
                {group.actions.map((action) => (
                  <button
                    key={action.id}
                    className={styles.action}
                    title={action.shortcut ? `${action.label} (${action.shortcut})` : action.label}
                    onClick={() => {
                      activate(action.id);
                      action.onActivate?.();
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
              <div className={styles.groupLabel}>{group.label}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
