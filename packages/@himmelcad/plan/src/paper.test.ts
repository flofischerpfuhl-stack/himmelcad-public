import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mmPointToScene,
  resolvePaperMm,
  sceneRectToMm,
  sheetTransform,
  worldMetersToPaperMm,
} from './paper.js';

describe('paper sizes', () => {
  it('A3 landscape is wider than tall', () => {
    const r = resolvePaperMm({ sizeId: 'a3', orientation: 'landscape', marginMm: 10 });
    assert.ok(r.widthMm > r.heightMm);
    assert.equal(r.widthMm, 420);
    assert.equal(r.heightMm, 297);
  });

  it('custom free format', () => {
    const r = resolvePaperMm({
      sizeId: 'custom',
      orientation: 'portrait',
      customWidthMm: 100,
      customHeightMm: 200,
      marginMm: 5,
    });
    assert.equal(r.widthMm, 100);
    assert.equal(r.heightMm, 200);
  });

  it('converts physical mm without making Excalidraw the unit authority', () => {
    const transform = sheetTransform({ sizeId: 'a3', orientation: 'landscape', marginMm: 10 });
    assert.deepEqual(mmPointToScene({ x: 20, y: 30 }, transform), { x: 80, y: 120 });
    assert.deepEqual(sceneRectToMm({ x: 80, y: 120, width: 400, height: 200 }, transform), {
      x: 20,
      y: 30,
      width: 100,
      height: 50,
    });
    assert.equal(worldMetersToPaperMm(1, 500), 2);
  });
});
