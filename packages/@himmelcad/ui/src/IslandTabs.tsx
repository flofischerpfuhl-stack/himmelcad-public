import type { ReactNode } from 'react';

import styles from './IslandTabs.module.css';

export interface IslandTabItem {
  id: string;
  label: string;
  disabled?: boolean;
  badge?: ReactNode;
  /** Small activity indicator (e.g. function active while on another tab). */
  showDot?: boolean;
}

export type IslandTabsVariant = 'floating' | 'strip';

export interface IslandTabsProps {
  items: readonly IslandTabItem[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  className?: string;
  /**
   * floating = same material as main dark islands (viewport / panel headers).
   * strip = classic attached tabs on the island surface (console family).
   */
  variant?: IslandTabsVariant;
}

/**
 * Scrollable tab strip. Sentence case; neutral active.
 * Use `floating` above islands; use `strip` for tabs that live *inside* an island.
 */
export function IslandTabs({
  items,
  value,
  onChange,
  ariaLabel,
  className,
  variant = 'floating',
}: IslandTabsProps): JSX.Element {
  const strip = variant === 'strip';
  const rootClass = strip ? styles.strip : styles.root;
  const tabClass = strip ? styles.stripTab : styles.tab;
  const activeClass = strip ? styles.stripTabActive : styles.tabActive;

  return (
    <div
      className={className ? `${rootClass} ${className}` : rootClass}
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            className={active ? `${tabClass} ${activeClass}` : tabClass}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.badge != null ? <span className={styles.badge}>{item.badge}</span> : null}
            {item.showDot ? <span className={styles.dot} aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}
