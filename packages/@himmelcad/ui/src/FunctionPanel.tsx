import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { PanelRightClose, Settings2, X } from 'lucide-react';

import styles from './FunctionPanel.module.css';
import { registerEscapeRung } from './escapeLadder.js';
import { IslandTabs } from './IslandTabs.js';
import { Menu, MenuItem } from './Menu.js';
import { useLayoutStore } from './useLayoutStore.js';

const MIN_TAB_WIDTH = 96;
const TAB_GAP = 3;
const OVERFLOW_BUTTON_WIDTH = 24;

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
  /** Controlled open-tab list, primarily for isolated hosts and deterministic fixtures. */
  functionIds?: readonly string[];
  /** Allows a function island to leave the dock without changing its content or lifecycle. */
  detachable?: boolean;
  detached?: boolean;
  onDetachedChange?: (detached: boolean) => void;
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
  functionIds: controlledFunctionIds,
  detachable = false,
  detached = false,
  onDetachedChange,
}: FunctionPanelProps): JSX.Element {
  const collapseRight = useLayoutStore((s) => s.toggleRightPanel);
  const storedFunctionIds = useLayoutStore((s) => s.openFunctionIds);
  const activateFunction = useLayoutStore((s) => s.activateFunction);
  const closeStoredFunction = useLayoutStore((s) => s.closeFunction);
  const tabControlsRef = useRef<HTMLDivElement>(null);
  const tabStopRefs = useRef(new Map<string, HTMLButtonElement>());
  const [tabControlsWidth, setTabControlsWidth] = useState(Number.POSITIVE_INFINITY);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [rovingId, setRovingId] = useState(() =>
    activeTab === 'function' && activeFunctionId ? `function:${activeFunctionId}` : 'properties',
  );
  const overflowMenuId = useId();
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

  const openFunctionIds = controlledFunctionIds ?? storedFunctionIds;
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

  const functionIds = useMemo(
    () =>
      openFunctionIds.length > 0 ? openFunctionIds : activeFunctionId ? [activeFunctionId] : [],
    [activeFunctionId, openFunctionIds],
  );
  const selectedId =
    selectedTab === 'properties' || activeFunctionId === null
      ? 'properties'
      : `function:${activeFunctionId}`;
  const closeFunction = useCallback(
    (functionId: string) => {
      if (onCloseFunction) onCloseFunction(functionId);
      else closeStoredFunction(functionId);
      if (detached) onDetachedChange?.(false);
      if (functionIds.length === 1) onActiveTabChange?.('properties');
    },
    [
      closeStoredFunction,
      detached,
      functionIds.length,
      onActiveTabChange,
      onCloseFunction,
      onDetachedChange,
    ],
  );
  useEffect(() => {
    if (!closeFunctionTabs || !detached || selectedTab !== 'function' || !activeFunctionId) {
      return;
    }
    return registerEscapeRung('detachedFunction', () => {
      closeFunction(activeFunctionId);
      return true;
    });
  }, [activeFunctionId, closeFunction, closeFunctionTabs, detached, selectedTab]);
  useEffect(() => {
    if (!closeFunctionTabs || selectedTab !== 'function' || !activeFunctionId) return;
    return registerEscapeRung('functionTab', () => {
      closeFunction(activeFunctionId);
      return true;
    });
  }, [activeFunctionId, closeFunction, closeFunctionTabs, selectedTab]);

  useEffect(() => {
    if (!closeFunctionTabs || !tabControlsRef.current) return;
    const controls = tabControlsRef.current;
    const measure = (): void => setTabControlsWidth(controls.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(controls);
    return () => observer.disconnect();
  }, [closeFunctionTabs]);

  const { visibleFunctionIds, hiddenFunctionIds } = useMemo(
    () => functionTabVisibility(functionIds, activeFunctionId, tabControlsWidth),
    [activeFunctionId, functionIds, tabControlsWidth],
  );
  const hasOverflow = hiddenFunctionIds.length > 0;
  const visibleStopIds = useMemo(
    () => [
      'properties',
      ...visibleFunctionIds.map((id) => `function:${id}`),
      ...(hasOverflow ? ['overflow'] : []),
    ],
    [hasOverflow, visibleFunctionIds],
  );

  useEffect(() => {
    if (visibleStopIds.includes(rovingId)) return;
    setRovingId(visibleStopIds.includes(selectedId) ? selectedId : 'properties');
  }, [rovingId, selectedId, visibleStopIds]);

  useEffect(() => setRovingId(selectedId), [selectedId]);

  useEffect(() => {
    if (!hasOverflow) setOverflowOpen(false);
  }, [hasOverflow]);

  const activateTab = (id: string): void => {
    if (id === 'properties') {
      onActiveTabChange?.('properties');
      return;
    }
    const functionId = id.slice('function:'.length);
    if (!closeFunctionTabs || functionId !== activeFunctionId) activateFunction(functionId);
    onActiveTabChange?.('function');
  };

  const setTabStopRef = (id: string, node: HTMLButtonElement | null): void => {
    if (node) tabStopRefs.current.set(id, node);
    else tabStopRefs.current.delete(id);
  };
  const onTabStopKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-function-tab-stop]');
    const currentId = target?.dataset.functionTabStop;
    if (!currentId) return;
    event.preventDefault();
    const nextIndex = nextFunctionPanelTabStop(
      visibleStopIds.indexOf(currentId),
      visibleStopIds.length,
      event.key as 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
    );
    const nextId = visibleStopIds[nextIndex];
    if (!nextId) return;
    setRovingId(nextId);
    tabStopRefs.current.get(nextId)?.focus();
  };
  return (
    <div className={`${styles.root} ${detached ? styles.detached : ''}`}>
      <div className={styles.header}>
        {closeFunctionTabs ? (
          <div ref={tabControlsRef} className={styles.tabControls} onKeyDown={onTabStopKeyDown}>
            <div
              className={styles.closeableTabs}
              role="tablist"
              aria-label="Right panel"
              aria-orientation="horizontal"
            >
              <button
                ref={(node) => setTabStopRef('properties', node)}
                type="button"
                role="tab"
                aria-selected={selectedId === 'properties'}
                tabIndex={rovingId === 'properties' ? 0 : -1}
                title="Properties"
                data-function-tab-stop="properties"
                className={`${styles.closeableTab} ${selectedId === 'properties' ? styles.closeableTabActive : ''}`}
                onFocus={() => setRovingId('properties')}
                onClick={() => activateTab('properties')}
              >
                <span className={styles.tabLabelText} data-function-tab-label>
                  Properties
                </span>
              </button>
              {visibleFunctionIds.map((id) => {
                const label =
                  id === activeFunctionId ? (title ?? functionLabel(id)) : functionLabel(id);
                const tabId = `function:${id}`;
                const active = selectedId === tabId;
                // One control per tab: a tablist may only own tabs (ARIA
                // aria-required-children), so the close affordance is a region of
                // the tab itself rather than a nested button. Keyboard users close
                // the active tab with Escape (UIP-D14 rung 7).
                return (
                  <button
                    key={id}
                    ref={(node) => setTabStopRef(tabId, node)}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={`${label} (close with Escape)`}
                    tabIndex={rovingId === tabId ? 0 : -1}
                    title={label}
                    data-function-tab-stop={tabId}
                    className={`${styles.closeableTab} ${styles.closeableTabGroup} ${active ? styles.closeableTabActive : ''}`}
                    onFocus={() => setRovingId(tabId)}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest('[data-close-tab]')) {
                        closeFunction(id);
                        return;
                      }
                      activateTab(tabId);
                    }}
                  >
                    <span className={styles.closeableTabLabel}>
                      <span className={styles.tabLabelText} data-function-tab-label>
                        {label}
                      </span>
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
            {hasOverflow ? (
              <button
                ref={(node) => setTabStopRef('overflow', node)}
                type="button"
                className={styles.overflowButton}
                aria-label="More function tabs"
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                aria-controls={overflowOpen ? overflowMenuId : undefined}
                tabIndex={rovingId === 'overflow' ? 0 : -1}
                title="More function tabs"
                data-function-tab-stop="overflow"
                onFocus={() => setRovingId('overflow')}
                onClick={() => setOverflowOpen((open) => !open)}
              >
                <span aria-hidden>⋯</span>
              </button>
            ) : null}
            {overflowOpen && hasOverflow ? (
              <Menu
                id={overflowMenuId}
                ariaLabel="More function tabs"
                className={styles.overflowMenu ?? ''}
                onClose={() => setOverflowOpen(false)}
              >
                {hiddenFunctionIds.map((id) => {
                  const label = functionLabel(id);
                  return (
                    <div key={id} role="none" className={styles.overflowMenuRow}>
                      <MenuItem
                        className={styles.overflowMenuTab}
                        title={label}
                        onSelect={() => activateTab(`function:${id}`)}
                      >
                        <span className={styles.tabLabelText}>{label}</span>
                      </MenuItem>
                      <MenuItem
                        className={styles.overflowMenuClose}
                        aria-label={`Close ${label}`}
                        title={`Close ${label}`}
                        onSelect={() => closeFunction(id)}
                      >
                        <X size={12} />
                      </MenuItem>
                    </div>
                  );
                })}
              </Menu>
            ) : null}
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
          {detachable ? (
            <button
              type="button"
              className={styles.detachButton}
              title={detached ? 'Dock function panel' : 'Detach function panel'}
              aria-label={detached ? 'Dock function panel' : 'Detach function panel'}
              aria-pressed={detached}
              onClick={() => onDetachedChange?.(!detached)}
            >
              <span aria-hidden>{detached ? '↙' : '↗'}</span>
            </button>
          ) : null}
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

export interface FunctionTabVisibility {
  readonly visibleFunctionIds: readonly string[];
  readonly hiddenFunctionIds: readonly string[];
}

/** Capacity rule for UIP-D7 tabs; exported for deterministic layout tests. */
export function functionTabVisibility(
  functionIds: readonly string[],
  activeFunctionId: string | null,
  availableWidth: number,
): FunctionTabVisibility {
  const allTabsWidth = (functionIds.length + 1) * MIN_TAB_WIDTH + functionIds.length * TAB_GAP;
  if (allTabsWidth <= availableWidth) {
    return { visibleFunctionIds: functionIds, hiddenFunctionIds: [] };
  }

  const visibleTabCapacity = Math.max(
    1,
    Math.floor((availableWidth - OVERFLOW_BUTTON_WIDTH) / (MIN_TAB_WIDTH + TAB_GAP)),
  );
  const visibleFunctionCapacity = Math.max(0, visibleTabCapacity - 1);
  const visibleFunctionIds = functionIds.slice(0, visibleFunctionCapacity);
  if (
    activeFunctionId &&
    functionIds.includes(activeFunctionId) &&
    !visibleFunctionIds.includes(activeFunctionId) &&
    visibleFunctionCapacity > 0
  ) {
    visibleFunctionIds[visibleFunctionIds.length - 1] = activeFunctionId;
  }
  const visible = new Set(visibleFunctionIds);
  return {
    visibleFunctionIds,
    hiddenFunctionIds: functionIds.filter((id) => !visible.has(id)),
  };
}

export function nextFunctionPanelTabStop(
  currentIndex: number,
  stopCount: number,
  key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
): number {
  if (stopCount <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return stopCount - 1;
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  return key === 'ArrowRight'
    ? (safeIndex + 1) % stopCount
    : (safeIndex - 1 + stopCount) % stopCount;
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
