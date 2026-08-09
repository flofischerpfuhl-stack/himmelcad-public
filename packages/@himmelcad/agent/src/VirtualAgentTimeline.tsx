import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type JSX,
} from 'react';

import type { AgentTimelineRow } from './timeline.js';
import {
  buildVirtualTimelineIndex,
  captureScrollAnchor,
  pruneVirtualMeasurements,
  restoreScrollAnchor,
  retainTextSelection,
  virtualRange,
  type ScrollAnchor,
  type TextSelectionAnchor,
} from './virtualization.js';

import styles from './agent.module.css';

export interface VirtualAgentTimelineProps {
  rows: readonly AgentTimelineRow[];
  renderRow: (row: AgentTimelineRow) => ReactNode;
  initialAtEnd?: boolean;
  overscanPx?: number;
  busy?: boolean;
  ariaLabel?: string;
  onAtEndChange?: (atEnd: boolean) => void;
}

/**
 * Virtual list owner adapted from the audited T3 Code list contract: stable keys,
 * estimated sizes, bottom-follow only while already at end, and visible-row anchoring.
 */
export const VirtualAgentTimeline = memo(function VirtualAgentTimeline({
  rows,
  renderRow,
  initialAtEnd = true,
  overscanPx = 500,
  busy = false,
  ariaLabel = 'Agent conversation',
  onAtEndChange,
}: VirtualAgentTimelineProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const measuredRef = useRef(new Map<string, number>());
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const selectionRef = useRef<TextSelectionAnchor | null>(null);
  const selectionRestorePendingRef = useRef(false);
  const initializedRef = useRef(false);
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 1 });
  const index = useMemo(() => {
    void measurementRevision;
    return buildVirtualTimelineIndex(rows, measuredRef.current);
  }, [measurementRevision, rows]);
  const range = useMemo(
    () => virtualRange(index, viewport.scrollTop, viewport.height, overscanPx),
    [index, overscanPx, viewport],
  );

  useEffect(() => {
    if (pruneVirtualMeasurements(measuredRef.current, rows) > 0) {
      setMeasurementRevision((value) => value + 1);
    }
  }, [rows]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => {
      setViewport((current) => ({ ...current, height: Math.max(1, host.clientHeight) }));
    });
    observer.observe(host);
    setViewport({ scrollTop: host.scrollTop, height: Math.max(1, host.clientHeight) });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      if (initialAtEnd) host.scrollTop = Math.max(0, index.totalHeight - host.clientHeight);
    } else {
      host.scrollTop = restoreScrollAnchor(anchorRef.current, index, host.clientHeight);
    }
    const retained = retainTextSelection(selectionRef.current, index);
    selectionRef.current = retained;
    selectionRestorePendingRef.current = Boolean(retained);
    if (retained && restoreDomTextSelection(host, retained)) {
      selectionRestorePendingRef.current = false;
    }
    anchorRef.current = captureScrollAnchor(index, host.scrollTop, host.clientHeight);
    setViewport({ scrollTop: host.scrollTop, height: Math.max(1, host.clientHeight) });
  }, [index, initialAtEnd]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const selection = selectionRef.current;
    if (!host || !selection || !selectionRestorePendingRef.current) return;
    if (restoreDomTextSelection(host, selection)) selectionRestorePendingRef.current = false;
  }, [index, range.end, range.start]);

  const measure = useCallback((rowId: string, element: HTMLDivElement | null): void => {
    if (!element) return;
    const height = element.getBoundingClientRect().height;
    const prior = measuredRef.current.get(rowId);
    if (height > 0 && (prior === undefined || Math.abs(prior - height) > 0.5)) {
      measuredRef.current.set(rowId, height);
      setMeasurementRevision((value) => value + 1);
    }
  }, []);

  return (
    <div
      ref={hostRef}
      className={styles.timeline}
      role="log"
      aria-label={ariaLabel}
      aria-live="polite"
      aria-relevant="additions text"
      aria-busy={busy}
      tabIndex={0}
      onScroll={(event) => {
        const host = event.currentTarget;
        const anchor = captureScrollAnchor(index, host.scrollTop, host.clientHeight);
        anchorRef.current = anchor;
        setViewport({ scrollTop: host.scrollTop, height: Math.max(1, host.clientHeight) });
        onAtEndChange?.(anchor?.wasAtEnd ?? true);
      }}
      onSelect={(event) => {
        selectionRef.current = captureDomTextSelection(event.currentTarget);
        selectionRestorePendingRef.current = false;
      }}
      data-agent-virtual-list="true"
    >
      <div className={styles.timelineSpacer} style={{ height: index.totalHeight }}>
        {index.rows.slice(range.start, range.end).map((row, localIndex) => {
          const rowIndex = range.start + localIndex;
          return (
            <div
              key={row.id}
              ref={(element) => measure(row.id, element)}
              className={styles.virtualRow}
              style={{ transform: `translateY(${index.offsets[rowIndex] ?? 0}px)` }}
              data-agent-row-id={row.id}
              data-agent-row-kind={row.kind}
            >
              {renderRow(row)}
            </div>
          );
        })}
      </div>
    </div>
  );
});

export function captureDomTextSelection(root: HTMLElement): TextSelectionAnchor | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const start = rowAndOffset(root, selection.anchorNode, selection.anchorOffset);
  const end = rowAndOffset(root, selection.focusNode, selection.focusOffset);
  if (!start || !end) return null;
  return {
    startRowId: start.rowId,
    startOffset: start.offset,
    endRowId: end.rowId,
    endOffset: end.offset,
    direction:
      selection.direction === 'forward' || selection.direction === 'backward'
        ? selection.direction
        : 'none',
  };
}

export function restoreDomTextSelection(root: HTMLElement, anchor: TextSelectionAnchor): boolean {
  const startRow = rowElement(root, anchor.startRowId);
  const endRow = rowElement(root, anchor.endRowId);
  if (!startRow || !endRow) return false;
  const start = textPosition(startRow, anchor.startOffset);
  const end = textPosition(endRow, anchor.endOffset);
  if (!start || !end) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  try {
    selection.removeAllRanges();
    if (typeof selection.setBaseAndExtent === 'function') {
      selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    } else {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      selection.addRange(range);
    }
  } catch {
    return false;
  }
  return true;
}

function rowAndOffset(
  root: HTMLElement,
  node: Node | null,
  nodeOffset: number,
): { rowId: string; offset: number } | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const row = element?.closest<HTMLElement>('[data-agent-row-id]');
  if (!row || !root.contains(row) || !node) return null;
  try {
    const range = document.createRange();
    range.selectNodeContents(row);
    range.setEnd(node, nodeOffset);
    return { rowId: row.dataset.agentRowId ?? '', offset: range.toString().length };
  } catch {
    return null;
  }
}

function textPosition(root: HTMLElement, offset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let node = walker.nextNode() as Text | null;
  while (node) {
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
    node = walker.nextNode() as Text | null;
  }
  return null;
}

function rowElement(root: HTMLElement, rowId: string): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>('[data-agent-row-id]')].find(
      (element) => element.dataset.agentRowId === rowId,
    ) ?? null
  );
}
