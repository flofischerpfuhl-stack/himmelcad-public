import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import styles from './Ribbon.module.css';
import { nextLinearIndex } from './controlInteractions.js';
import { registerEscapeRung } from './escapeLadder.js';
import { Menu, MenuItem, MenuSubmenu } from './Menu.js';
import { useLayoutStore } from './useLayoutStore.js';

export interface RibbonAction {
  id: string;
  label: string;
  title?: string;
  shortcut?: string;
  icon?: ReactNode;
  onActivate?: () => void;
  menuItems?: readonly RibbonActionMenuItem[];
}

export interface RibbonActionMenuItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly descriptionMono?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
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
  const idPrefix = useId();
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
    const unregisterEscape = registerEscapeRung('menu', () => (setDropdownTabId(null), true));
    document.addEventListener('mousedown', onDocClick);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      unregisterEscape();
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

  const activateTab = (id: string): void => {
    setActiveTabId(id);
    if (collapsed) setDropdownTabId(id);
    queueMicrotask(() => tabRefs.current.get(id)?.focus());
  };

  return (
    <div className={`${styles.root} ${collapsed ? styles.collapsed : ''}`}>
      <div className={styles.tabRow}>
        <div
          className={styles.tabs}
          role="tablist"
          aria-label="Ribbon"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            const current = Math.max(
              0,
              tabs.findIndex((tab) => tab.id === activeTabId),
            );
            const next = nextLinearIndex(
              current,
              tabs.length,
              event.key as 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
              'horizontal',
            );
            const nextTab = tabs[next];
            if (!nextTab) return;
            event.preventDefault();
            activateTab(nextTab.id);
          }}
        >
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
                id={`${idPrefix}-tab-${tab.id}`}
                aria-selected={isActive}
                aria-controls={`${idPrefix}-panel-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
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
      {tabs.map((tab) => {
        const selected = tab.id === activeTab?.id;
        return (
          <div
            key={tab.id}
            id={`${idPrefix}-panel-${tab.id}`}
            className={styles.body}
            role="tabpanel"
            aria-labelledby={`${idPrefix}-tab-${tab.id}`}
            hidden={collapsed || !selected}
          >
            {tab.groups.map((group) => (
              <div key={group.id} className={styles.group}>
                <div className={styles.groupBody}>
                  {group.actions.map((action) => (
                    <RibbonActionButton
                      key={action.id}
                      action={action}
                      isActive={activeFunctionId === action.id}
                      onSelect={() => {
                        if (action.onActivate) action.onActivate();
                        else activate(action.id);
                      }}
                    />
                  ))}
                </div>
                <div className={styles.groupLabel}>{group.label}</div>
              </div>
            ))}
          </div>
        );
      })}
      {collapsed && dropdownTab && dropdownStyle && (
        <div ref={dropdownRef} className={styles.dropdown} style={dropdownStyle} role="menu">
          {dropdownTab.groups.map((group) => (
            <div key={group.id} className={styles.dropdownGroup}>
              <div className={styles.dropdownGroupLabel}>{group.label}</div>
              <div className={styles.dropdownItems}>
                {group.actions.map((action) => (
                  action.menuItems ? (
                    <MenuSubmenu
                      key={action.id}
                      ariaLabel={`${action.label} projects`}
                      label={action.label}
                      className={styles.dropdownItem ?? ''}
                    >
                      {action.onActivate ? (
                        <MenuItem onSelect={action.onActivate}>
                          <span className={styles.actionMenuCopy}>
                            <span>{action.label}</span>
                            {action.shortcut ? (
                              <span className={styles.actionMenuDescription}>{action.shortcut}</span>
                            ) : null}
                          </span>
                        </MenuItem>
                      ) : null}
                      {action.menuItems.map((item) => (
                        <MenuItem key={item.id} disabled={item.disabled} onSelect={item.onSelect}>
                          <span className={styles.actionMenuCopy}>
                            <span>{item.label}</span>
                            {item.description ? (
                              <span className={item.descriptionMono ? styles.actionMenuPath : styles.actionMenuDescription}>
                                {item.description}
                              </span>
                            ) : null}
                          </span>
                        </MenuItem>
                      ))}
                    </MenuSubmenu>
                  ) : (
                    <button
                      key={action.id}
                      type="button"
                      role="menuitem"
                      className={`${styles.dropdownItem} ${
                        activeFunctionId === action.id ? styles.dropdownItemActive : ''
                      }`}
                      title={action.title ?? action.label}
                      onClick={() => {
                        if (action.onActivate) action.onActivate();
                        else activate(action.id);
                        setDropdownTabId(null);
                      }}
                    >
                      {action.icon && <span className={styles.dropdownItemIcon}>{action.icon}</span>}
                      <span className={styles.dropdownItemLabel}>{action.label}</span>
                      {action.shortcut && (
                        <span className={styles.dropdownItemShortcut}>{action.shortcut}</span>
                      )}
                    </button>
                  )
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
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const rect = menuOpen ? anchorRef.current?.getBoundingClientRect() : null;
  return (
    <div className={styles.actionHost}>
      <button
        ref={anchorRef}
        type="button"
        className={`${styles.action} ${isActive ? styles.actionActive : ''}`}
        title={
          action.title ?? (action.shortcut ? `${action.label} (${action.shortcut})` : action.label)
        }
        aria-haspopup={action.menuItems ? 'menu' : undefined}
        aria-expanded={action.menuItems && !action.onActivate ? menuOpen : undefined}
        onClick={() => {
          if (action.menuItems && !action.onActivate) setMenuOpen((open) => !open);
          else onSelect();
        }}
      >
        {action.icon && <span className={styles.actionIcon}>{action.icon}</span>}
        <span className={styles.actionLabel}>{action.label}</span>
      </button>
      {action.menuItems && action.onActivate ? (
        <button
          type="button"
          className={styles.actionMenuTrigger}
          aria-label={`${action.label} options`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <ChevronDown size={12} />
        </button>
      ) : null}
      {menuOpen && rect ? (
        <Menu
          ariaLabel={`${action.label} projects`}
          onClose={() => setMenuOpen(false)}
          className={styles.actionMenu!}
          style={{ position: 'fixed', left: rect.left, top: rect.bottom + 4 }}
        >
          {action.menuItems!.map((item) => (
            <MenuItem key={item.id} disabled={item.disabled} onSelect={item.onSelect}>
              <span className={styles.actionMenuCopy}>
                <span>{item.label}</span>
                {item.description ? (
                  <span className={item.descriptionMono ? styles.actionMenuPath : styles.actionMenuDescription}>
                    {item.description}
                  </span>
                ) : null}
              </span>
            </MenuItem>
          ))}
        </Menu>
      ) : null}
    </div>
  );
}
