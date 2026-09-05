export type LinearNavigationKey =
  | 'ArrowDown'
  | 'ArrowUp'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End';

export function nextLinearIndex(
  current: number,
  count: number,
  key: LinearNavigationKey,
  orientation: 'horizontal' | 'vertical',
): number {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const forward = orientation === 'vertical' ? key === 'ArrowDown' : key === 'ArrowRight';
  const backward = orientation === 'vertical' ? key === 'ArrowUp' : key === 'ArrowLeft';
  if (forward) return (Math.max(0, current) + 1) % count;
  if (backward) return (Math.max(0, current) - 1 + count) % count;
  return Math.max(0, Math.min(count - 1, current));
}

export function sliderValueForKey(
  current: number,
  min: number,
  max: number,
  step: number,
  key: string,
): number | null {
  if (key === 'Home') return min;
  if (key === 'End') return max;
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(max, current + step);
  if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(min, current - step);
  return null;
}
