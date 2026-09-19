import assert from 'node:assert/strict';
import test from 'node:test';

import { retireProjectInteractionState } from '../renderer/src/projectInteractionLifecycle.js';

void test('project replacement retires construction, active tools and every function tab', async () => {
  const events: string[] = [];
  await retireProjectInteractionState({
    draw: {
      snapshot: () => ({ armed: true }),
      cancelAll: async () => {
        events.push('draw.cancelAll');
        return true;
      },
    },
    measurement: {
      cancel: () => {
        events.push('measurement.cancel');
        return true;
      },
    },
    construction: { disarm: () => events.push('construction.disarm') },
    clearArmedPlacement: () => events.push('placement.clear'),
    clearHudOverlays: () => events.push('hud.clear'),
    clearSelection: async () => {
      events.push('selection.clear');
    },
    closeFunctionTabs: () => events.push('functions.closeAll'),
  });

  assert.deepEqual(events, [
    'construction.disarm',
    'draw.cancelAll',
    'measurement.cancel',
    'placement.clear',
    'hud.clear',
    'selection.clear',
    'functions.closeAll',
  ]);
});

void test('project replacement reset is safe when no tool is armed', async () => {
  let drawCancellations = 0;
  let measurementCancellations = 0;
  await retireProjectInteractionState({
    draw: {
      snapshot: () => ({ armed: false }),
      cancelAll: async () => {
        drawCancellations += 1;
        return false;
      },
    },
    measurement: {
      cancel: () => {
        measurementCancellations += 1;
        return false;
      },
    },
    construction: { disarm: () => undefined },
    clearArmedPlacement: () => undefined,
    clearHudOverlays: () => undefined,
    clearSelection: async () => undefined,
    closeFunctionTabs: () => undefined,
  });
  assert.equal(drawCancellations, 0);
  assert.equal(measurementCancellations, 1);
});
