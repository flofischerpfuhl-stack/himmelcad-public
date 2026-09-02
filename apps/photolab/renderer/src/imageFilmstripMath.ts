export type FilmstripNavigationKey =
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown';

export interface FilmstripVirtualWindow {
  startIndex: number;
  endIndex: number;
  offsetPixels: number;
  totalPixels: number;
}

export function calculateFilmstripPageSize(
  viewportPixels: number,
  itemExtentPixels: number,
): number {
  if (!Number.isFinite(viewportPixels) || !Number.isFinite(itemExtentPixels)) return 1;
  if (viewportPixels <= 0 || itemExtentPixels <= 0) return 1;
  return Math.max(1, Math.floor(viewportPixels / itemExtentPixels));
}

export function calculateFilmstripWindow(
  itemCount: number,
  itemExtentPixels: number,
  viewportPixels: number,
  scrollOffsetPixels: number,
  overscanItems: number,
): FilmstripVirtualWindow {
  const count = Math.max(0, Math.floor(itemCount));
  if (count === 0 || itemExtentPixels <= 0) {
    return { startIndex: 0, endIndex: 0, offsetPixels: 0, totalPixels: 0 };
  }

  const viewport = Math.max(0, viewportPixels);
  const maximumOffset = Math.max(0, count * itemExtentPixels - viewport);
  const offset = clamp(scrollOffsetPixels, 0, maximumOffset);
  const overscan = Math.max(0, Math.floor(overscanItems));
  const firstVisible = Math.floor(offset / itemExtentPixels);
  const visibleCount = Math.max(1, Math.ceil(viewport / itemExtentPixels) + 1);
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(count, firstVisible + visibleCount + overscan);

  return {
    startIndex,
    endIndex,
    offsetPixels: startIndex * itemExtentPixels,
    totalPixels: count * itemExtentPixels,
  };
}

export function navigateFilmstripIndex(
  currentIndex: number,
  itemCount: number,
  key: FilmstripNavigationKey,
  pageSize: number,
): number | null {
  const count = Math.max(0, Math.floor(itemCount));
  if (count === 0) return null;

  const current = clamp(Math.floor(currentIndex), 0, count - 1);
  const page = Math.max(1, Math.floor(pageSize));
  if (currentIndex < 0) {
    return key === 'End' ? count - 1 : 0;
  }

  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, current - 1);
    case 'ArrowRight':
      return Math.min(count - 1, current + 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageUp':
      return Math.max(0, current - page);
    case 'PageDown':
      return Math.min(count - 1, current + page);
  }
}

export function navigateFilmstripSelection<T>(
  itemIds: readonly T[],
  selectedId: T | null,
  key: FilmstripNavigationKey,
  pageSize: number,
): T | null {
  const currentIndex = selectedId == null ? -1 : itemIds.indexOf(selectedId);
  const nextIndex = navigateFilmstripIndex(currentIndex, itemIds.length, key, pageSize);
  return nextIndex == null ? null : (itemIds[nextIndex] ?? null);
}

export function isFilmstripNavigationKey(key: string): key is FilmstripNavigationKey {
  return (
    key === 'ArrowLeft' ||
    key === 'ArrowRight' ||
    key === 'Home' ||
    key === 'End' ||
    key === 'PageUp' ||
    key === 'PageDown'
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
