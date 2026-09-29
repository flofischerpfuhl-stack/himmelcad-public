/**
 * Fixed-position placement for small row menus inside scrolling panels
 * (History cards, Items folders): an absolutely positioned menu would be
 * clipped by the panel's `overflow: auto`. Opens below the trigger,
 * right-aligned, or above it when it would leave the window.
 */
import type { CSSProperties } from 'react';

export function anchoredMenuStyle(trigger: HTMLElement, estimatedHeight: number): CSSProperties {
  const rect = trigger.getBoundingClientRect();
  const below = rect.bottom + 4;
  const top =
    below + estimatedHeight > window.innerHeight - 8
      ? Math.max(8, rect.top - 4 - estimatedHeight)
      : below;
  return { position: 'fixed', top, right: Math.max(8, window.innerWidth - rect.right) };
}
