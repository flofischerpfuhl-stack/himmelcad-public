import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import styles from './Ribbon.module.css';
import { useLayoutStore } from './useLayoutStore.js';

export interface RibbonAction {
  id: string;
  label: string;
  shortcut?: string;
  icon?: ReactNode;
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
  const activeFunctionId = useLayoutStore((s) => s.activeFunctionId);
  const activate = useLayoutStore((s) => s.activateFunction);

  const [activeTabId, setActiveTabId] = useState(tabs[0]?.id ?? '');
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  // When collapsed, clicking a tab opens THAT tab's actions as a popover
  // dropdown anchored beneath the tab. Clicking outside or selecting an
  // action closes it.
  const [dropdownTabId, setDropdownTabId] = useState<string | null>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!dropdownTabId) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (dropdownRef.current?.contains(target)) return;
      const tabEl = tabRefs.current.get(dropdownTabId);
      if (tabEl?.contains(target)) return;
      setDropdownTabId(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDropdownTabId(null);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [dropdownTabId]);

  // When ribbon expands, close any open dropdown.
  useEffect(() => {
    if (!collapsed) setDropdownTabId(null);
  }, [collapsed]);

  const dropdownTab = dropdownTabId ? tabs.find((t) => t.id === dropdownTabId) : null;
  const dropdownStyle: CSSProperties | undefined = (() => {
    if (!dropdownTabId) return undefined;
    const el = tabRefs.current.get(dropdownTabId);
    if (!el) return undefined;
    const rect = el.getBoundingClientRect();
    return {
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
    };
  })();

  return (
    <div className={`${styles.root} ${collapsed ? styles.collapsed : ''}`}>
      <div className={styles.tabRow}>
        <div className={styles.tabs} role="tablist">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isDropdown = collapsed && dropdownTabId === tab.id;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                role="tab"
                aria-selected={isActive}
                aria-haspopup={collapsed ? 'menu' : undefined}
                aria-expanded={collapsed ? isDropdown : undefined}
                className={`${styles.tab} ${
                  !collapsed && isActive ? styles.tabActive : ''
                } ${isDropdown ? styles.tabDropdownOpen : ''}`}
                onClick={() => {
                  if (collapsed) {
                    setDropdownTabId((prev) => (prev === tab.id ? null : tab.id));
                    setActiveTabId(tab.id);
                  } else if (!isActive) {
                    setActiveTabId(tab.id);
                  }
                }}
                onContextMenu={(e) => {
                  // RMB on a tab is reserved for "add to quick-bar" later.
                  e.preventDefault();
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={styles.collapseToggle}
          onClick={() => setCollapsed(!collapsed)}
          title={collapsed ? 'Expand ribbon' : 'Collapse ribbon'}
          aria-label={collapsed ? 'Expand ribbon' : 'Collapse ribbon'}
        >
          {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
      </div>
      {!collapsed && activeTab && (
        <div className={styles.body} role="tabpanel" aria-labelledby={activeTab.id}>
          {activeTab.groups.map((group) => (
            <div key={group.id} className={styles.group}>
              <div className={styles.groupBody}>
                {group.actions.map((action) => (
                  <RibbonActionButton
                    key={action.id}
                    action={action}
                    isActive={activeFunctionId === action.id}
                    onSelect={() => {
                      activate(action.id);
                      action.onActivate?.();
                    }}
                  />
                ))}
              </div>
              <div className={styles.groupLabel}>{group.label}</div>
            </div>
          ))}
        </div>
      )}
      {collapsed && dropdownTab && dropdownStyle && (
        <div ref={dropdownRef} className={styles.dropdown} style={dropdownStyle} role="menu">
          {dropdownTab.groups.map((group) => (
            <div key={group.id} className={styles.dropdownGroup}>
              <div className={styles.dropdownGroupLabel}>{group.label}</div>
              <div className={styles.dropdownItems}>
                {group.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    role="menuitem"
                    className={`${styles.dropdownItem} ${
                      activeFunctionId === action.id ? styles.dropdownItemActive : ''
                    }`}
                    onClick={() => {
                      activate(action.id);
                      action.onActivate?.();
                      setDropdownTabId(null);
                    }}
                  >
                    {action.icon && <span className={styles.dropdownItemIcon}>{action.icon}</span>}
                    <span className={styles.dropdownItemLabel}>{action.label}</span>
                    {action.shortcut && (
                      <span className={styles.dropdownItemShortcut}>{action.shortcut}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RibbonActionButton({
  action,
  isActive,
  onSelect,
}: {
  action: RibbonAction;
  isActive: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`${styles.action} ${isActive ? styles.actionActive : ''}`}
      title={action.shortcut ? `${action.label} (${action.shortcut})` : action.label}
      onClick={onSelect}
    >
      {action.icon && <span className={styles.actionIcon}>{action.icon}</span>}
      <span className={styles.actionLabel}>{action.label}</span>
    </button>
  );
}
