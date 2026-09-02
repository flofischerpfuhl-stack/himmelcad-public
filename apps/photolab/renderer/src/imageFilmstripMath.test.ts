import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  calculateFilmstripPageSize,
  calculateFilmstripWindow,
  navigateFilmstripIndex,
  navigateFilmstripSelection,
  // @ts-expect-error Node's strip-types test runner loads the TypeScript source directly.
} from './imageFilmstripMath.ts';

describe('image filmstrip virtualization', () => {
  it('renders the visible window plus bounded overscan', () => {
    assert.deepEqual(calculateFilmstripWindow(1_000, 140, 700, 14_000, 3), {
      startIndex: 97,
      endIndex: 109,
      offsetPixels: 13_580,
      totalPixels: 140_000,
    });
  });

  it('clamps scroll offsets and handles empty lists', () => {
    assert.deepEqual(calculateFilmstripWindow(10, 140, 420, -80, 2), {
      startIndex: 0,
      endIndex: 6,
      offsetPixels: 0,
      totalPixels: 1_400,
    });
    assert.deepEqual(calculateFilmstripWindow(10, 140, 420, 99_000, 2), {
      startIndex: 5,
      endIndex: 10,
      offsetPixels: 700,
      totalPixels: 1_400,
    });
    assert.deepEqual(calculateFilmstripWindow(0, 140, 420, 0, 2), {
      startIndex: 0,
      endIndex: 0,
      offsetPixels: 0,
      totalPixels: 0,
    });
  });

  it('derives a whole-item page size with a minimum of one', () => {
    assert.equal(calculateFilmstripPageSize(700, 140), 5);
    assert.equal(calculateFilmstripPageSize(100, 140), 1);
    assert.equal(calculateFilmstripPageSize(0, 140), 1);
  });
});

describe('image filmstrip keyboard navigation', () => {
  it('supports arrows, endpoints, pages, and boundary clamping', () => {
    assert.equal(navigateFilmstripIndex(4, 10, 'ArrowLeft', 3), 3);
    assert.equal(navigateFilmstripIndex(4, 10, 'ArrowRight', 3), 5);
    assert.equal(navigateFilmstripIndex(4, 10, 'Home', 3), 0);
    assert.equal(navigateFilmstripIndex(4, 10, 'End', 3), 9);
    assert.equal(navigateFilmstripIndex(4, 10, 'PageUp', 3), 1);
    assert.equal(navigateFilmstripIndex(4, 10, 'PageDown', 3), 7);
    assert.equal(navigateFilmstripIndex(0, 10, 'ArrowLeft', 3), 0);
    assert.equal(navigateFilmstripIndex(9, 10, 'PageDown', 3), 9);
    assert.equal(navigateFilmstripIndex(0, 0, 'Home', 3), null);
  });

  it('navigates only the supplied filtered subset', () => {
    const filteredIds = ['image-2', 'image-8', 'image-21', 'image-55'] as const;
    assert.equal(navigateFilmstripSelection(filteredIds, 'image-8', 'ArrowRight', 2), 'image-21');
    assert.equal(navigateFilmstripSelection(filteredIds, 'image-21', 'PageUp', 2), 'image-2');
    assert.equal(navigateFilmstripSelection(filteredIds, 'image-999', 'ArrowRight', 2), 'image-2');
  });
});
