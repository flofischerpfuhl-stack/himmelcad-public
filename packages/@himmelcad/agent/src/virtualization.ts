import type { AgentTimelineRow } from './timeline.js';

export interface VirtualTimelineIndex {
  rows: readonly AgentTimelineRow[];
  offsets: Float64Array;
  heights: Float64Array;
  indexById: ReadonlyMap<string, number>;
  totalHeight: number;
}

export interface VirtualRange {
  start: number;
  end: number;
  offsetTop: number;
}

export interface ScrollAnchor {
  rowId: string;
  offsetWithinRow: number;
  wasAtEnd: boolean;
}

export interface TextSelectionAnchor {
  startRowId: string;
  startOffset: number;
  endRowId: string;
  endOffset: number;
  direction: 'forward' | 'backward' | 'none';
}

export function buildVirtualTimelineIndex(
  rows: readonly AgentTimelineRow[],
  measuredHeights: ReadonlyMap<string, number> = new Map(),
): VirtualTimelineIndex {
  const offsets = new Float64Array(rows.length + 1);
  const heights = new Float64Array(rows.length);
  const indexById = new Map<string, number>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const measured = measuredHeights.get(row.id);
    const height = measured && measured > 0 ? measured : estimateRowHeight(row);
    heights[index] = height;
    offsets[index + 1] = offsets[index]! + height;
    indexById.set(row.id, index);
  }
  return { rows, offsets, heights, indexById, totalHeight: offsets[rows.length] ?? 0 };
}

export function virtualRange(
  index: VirtualTimelineIndex,
  scrollTop: number,
  viewportHeight: number,
  overscanPx = 500,
): VirtualRange {
  const startOffset = Math.max(0, scrollTop - overscanPx);
  const endOffset = Math.min(index.totalHeight, scrollTop + viewportHeight + overscanPx);
  const start = Math.max(0, upperBound(index.offsets, startOffset) - 1);
  const end = Math.min(index.rows.length, upperBound(index.offsets, endOffset) + 1);
  return { start, end, offsetTop: index.offsets[start] ?? 0 };
}

export function captureScrollAnchor(
  index: VirtualTimelineIndex,
  scrollTop: number,
  viewportHeight: number,
  endThresholdPx = 8,
): ScrollAnchor | null {
  if (index.rows.length === 0) return null;
  const rowIndex = Math.max(0, upperBound(index.offsets, Math.max(0, scrollTop)) - 1);
  return {
    rowId: index.rows[Math.min(rowIndex, index.rows.length - 1)]!.id,
    offsetWithinRow: scrollTop - index.offsets[rowIndex]!,
    wasAtEnd: index.totalHeight - (scrollTop + viewportHeight) <= endThresholdPx,
  };
}

export function restoreScrollAnchor(
  anchor: ScrollAnchor | null,
  next: VirtualTimelineIndex,
  viewportHeight: number,
): number {
  if (!anchor) return Math.max(0, next.totalHeight - viewportHeight);
  if (anchor.wasAtEnd) return Math.max(0, next.totalHeight - viewportHeight);
  const rowIndex = next.indexById.get(anchor.rowId);
  if (rowIndex === undefined) return 0;
  return Math.max(0, next.offsets[rowIndex]! + anchor.offsetWithinRow);
}

export function retainTextSelection(
  selection: TextSelectionAnchor | null,
  next: VirtualTimelineIndex,
): TextSelectionAnchor | null {
  if (!selection) return null;
  return next.indexById.has(selection.startRowId) && next.indexById.has(selection.endRowId)
    ? selection
    : null;
}

export function pruneVirtualMeasurements(
  measuredHeights: Map<string, number>,
  rows: readonly AgentTimelineRow[],
  slack = 1_024,
): number {
  if (measuredHeights.size <= rows.length + Math.max(0, slack)) return 0;
  const retainedIds = new Set(rows.map((row) => row.id));
  let removed = 0;
  for (const rowId of measuredHeights.keys()) {
    if (retainedIds.has(rowId)) continue;
    measuredHeights.delete(rowId);
    removed += 1;
  }
  return removed;
}

export function estimateRowHeight(row: AgentTimelineRow): number {
  if (row.kind === 'message') return 54 + Math.min(480, Math.ceil(row.text.length / 90) * 19);
  if (row.kind === 'reasoning') return 44 + Math.min(180, Math.ceil(row.summary.length / 100) * 17);
  if (row.kind === 'approval') return 112;
  if (row.kind === 'error') return 86;
  return 56;
}

function upperBound(values: Float64Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}
