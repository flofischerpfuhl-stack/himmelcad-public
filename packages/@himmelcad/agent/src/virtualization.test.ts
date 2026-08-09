import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { performance } from 'node:perf_hooks';

import type { AgentTimelineRow } from './timeline.js';
import {
  buildVirtualTimelineIndex,
  captureScrollAnchor,
  pruneVirtualMeasurements,
  restoreScrollAnchor,
  retainTextSelection,
  virtualRange,
} from './virtualization.js';

describe('virtual agent timeline', () => {
  it('indexes 100,000 rows within the performance gate and renders a bounded window', () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => row(`row-${index}`, index));
    const started = performance.now();
    const model = buildVirtualTimelineIndex(rows);
    const range = virtualRange(model, model.totalHeight / 2, 900, 500);
    const elapsedMs = performance.now() - started;
    assert(elapsedMs < 5_000, `100k timeline index took ${elapsedMs.toFixed(1)} ms`);
    assert.equal(model.indexById.size, 100_000);
    assert(
      range.end - range.start < 100,
      `virtual window contains ${range.end - range.start} rows`,
    );
  });

  it('keeps the visible row fixed across prepend and only follows appended rows at end', () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => row(`row-${index}`, index));
    const before = buildVirtualTimelineIndex(rows);
    const anchor = captureScrollAnchor(before, 20_000, 800)!;
    assert.equal(anchor.wasAtEnd, false);
    const prepended = Array.from({ length: 25 }, (_, index) => row(`prior-${index}`, -25 + index));
    const after = buildVirtualTimelineIndex([...prepended, ...rows]);
    const restored = restoreScrollAnchor(anchor, after, 800);
    const rowIndex = after.indexById.get(anchor.rowId)!;
    assert.equal(restored, after.offsets[rowIndex]! + anchor.offsetWithinRow);

    const endAnchor = captureScrollAnchor(before, before.totalHeight - 800, 800)!;
    const appended = buildVirtualTimelineIndex([...rows, row('new', 1_001)]);
    assert.equal(restoreScrollAnchor(endAnchor, appended, 800), appended.totalHeight - 800);
  });

  it('preserves scroll and text selection across streaming height changes', () => {
    const rows = Array.from({ length: 100 }, (_, index) => row(`row-${index}`, index));
    const before = buildVirtualTimelineIndex(rows);
    const anchor = captureScrollAnchor(before, before.offsets[60]! + 7, 500)!;
    const measured = new Map<string, number>([['row-10', 240]]);
    const after = buildVirtualTimelineIndex(rows, measured);
    const restored = restoreScrollAnchor(anchor, after, 500);
    assert.equal(restored, after.offsets[60]! + 7);
    const selection = {
      startRowId: 'row-60',
      startOffset: 2,
      endRowId: 'row-61',
      endOffset: 7,
      direction: 'forward' as const,
    };
    assert.strictEqual(retainTextSelection(selection, after), selection);
    assert.equal(retainTextSelection({ ...selection, endRowId: 'missing' }, after), null);
  });

  it('bounds retained DOM measurements after rows leave the timeline', () => {
    const rows = [row('retained-a', 1), row('retained-b', 2)];
    const measured = new Map<string, number>([
      ['retained-a', 50],
      ['retained-b', 60],
      ['stale-a', 70],
      ['stale-b', 80],
    ]);
    assert.equal(pruneVirtualMeasurements(measured, rows, 1), 2);
    assert.deepEqual([...measured.keys()], ['retained-a', 'retained-b']);
    assert.equal(pruneVirtualMeasurements(measured, rows, 1), 0);
  });
});

function row(id: string, sequence: number): AgentTimelineRow {
  return {
    id,
    kind: 'message',
    sequence,
    role: 'assistant',
    text: `Message ${sequence}`,
    streaming: false,
    createdAt: '2026-01-01T00:00:00Z',
  };
}
