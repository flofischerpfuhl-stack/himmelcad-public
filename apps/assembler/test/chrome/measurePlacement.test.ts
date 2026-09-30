/**
 * Measure panel placement: never over the Parameters/History column or the
 * right dock by default; a remembered drag position stays inside the window.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEASURE_PANEL_WIDTH,
  measurePanelPlacement,
} from '../../renderer/src/chrome/measurePlacement.js';

const window = { width: 1600, height: 900 };
/** The right column (Parameters/History): x from width - 284 to width - 12, y from 372. */
const column = { left: window.width - 12 - 272, top: 372 };

void test('with History or Parameters open the panel sits left of the column, not on it', () => {
  const p = measurePanelPlacement({ rightColumnOpen: true, position: null, window });
  assert.equal(p.left, undefined);
  const panelRight = window.width - p.right!;
  assert.ok(panelRight <= column.left, `panel ends at ${panelRight}, column starts ${column.left}`);
  assert.ok(panelRight - MEASURE_PANEL_WIDTH > 0, 'fully inside the window');
});

void test('with the column closed it takes the column place below the right dock', () => {
  const p = measurePanelPlacement({ rightColumnOpen: false, position: null, window });
  assert.equal(p.right, 12);
  assert.equal(p.bottom, 64);
  // Its maximum height ends below the dock (372 px) and above the bottom strip (64 px).
  assert.equal(p.maxHeight, 'calc(100% - 436px)');
});

void test('a remembered position is used, and pulled back inside a smaller window', () => {
  const kept = measurePanelPlacement({
    rightColumnOpen: true,
    position: { x: 300, y: 200 },
    window,
  });
  assert.deepEqual([kept.left, kept.top], [300, 200]);
  const clamped = measurePanelPlacement({
    rightColumnOpen: true,
    position: { x: 1500, y: 880 },
    window: { width: 1000, height: 600 },
  });
  assert.equal(clamped.left, 1000 - MEASURE_PANEL_WIDTH - 12);
  assert.equal(clamped.top, 560);
});
