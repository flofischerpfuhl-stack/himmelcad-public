import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEmptyLibrary } from './defaults.js';
import { upsertSpecification } from './library.js';
import { ancestorCodes, isValidSpecCode, validateLibrary } from './validate.js';

describe('spec codes', () => {
  it('accepts 1–10 digit integers', () => {
    assert.equal(isValidSpecCode(1), true);
    assert.equal(isValidSpecCode(11), true);
    assert.equal(isValidSpecCode(9999999999), true);
    assert.equal(isValidSpecCode(0), false);
    assert.equal(isValidSpecCode(1.5), false);
    assert.equal(isValidSpecCode(10_000_000_000), false);
  });

  it('ancestor chain for hierarchical codes', () => {
    assert.deepEqual(ancestorCodes(111), [11, 1]);
    assert.deepEqual(ancestorCodes(12), [1]);
  });
});

describe('library', () => {
  it('boots with valid sample hierarchy', () => {
    const lib = createEmptyLibrary();
    const v = validateLibrary(lib);
    assert.equal(v.ok, true);
    assert.ok(lib.specifications.some((s) => s.code === 11));
  });

  it('rejects duplicate codes', () => {
    const lib = createEmptyLibrary();
    const existing = lib.specifications.find((s) => s.code === 11)!;
    assert.throws(() =>
      upsertSpecification(lib, {
        ...existing,
        id: 'other',
        name: 'Dup',
      }),
    );
  });
});
