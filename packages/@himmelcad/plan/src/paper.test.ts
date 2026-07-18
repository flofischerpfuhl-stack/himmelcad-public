import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolvePaperMm } from './paper.js';

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
});
