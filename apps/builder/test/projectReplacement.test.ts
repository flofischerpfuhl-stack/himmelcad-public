import assert from 'node:assert/strict';
import test from 'node:test';

import { replaceProjectWithRecovery } from '../renderer/src/projectReplacement.js';

void test('create/open replacement keeps the shell and opens the selected project once', async () => {
  const events: string[] = [];
  let prepared = '';
  const result = await replaceProjectWithRecovery('/projects/new.hcad', {
    currentRoot: '/projects/old.hcad',
    closeCurrent: async () => {
      events.push('close');
      return true;
    },
    prepare: async (root) => {
      prepared = root;
      events.push(`prepare:${root}`);
    },
    openPrepared: async () => {
      events.push(`open:${prepared}`);
    },
    discardFailed: async () => {
      events.push('discard');
    },
  });
  assert.deepEqual(events, [
    'close',
    'prepare:/projects/new.hcad',
    'open:/projects/new.hcad',
  ]);
  assert.deepEqual(result, { activeRoot: '/projects/new.hcad', failure: null });
});

void test('failed replacement reopens the previous project and returns a typed retry reason', async () => {
  const events: string[] = [];
  let prepared = '';
  const result = await replaceProjectWithRecovery('/projects/broken.hcad', {
    currentRoot: '/projects/safe.hcad',
    closeCurrent: async () => true,
    prepare: async (root) => {
      prepared = root;
      events.push(`prepare:${root}`);
    },
    openPrepared: async () => {
      events.push(`open:${prepared}`);
      if (prepared.includes('broken')) throw new Error('journal checksum mismatch');
    },
    discardFailed: async () => {
      events.push('discard');
    },
  });
  assert.deepEqual(events, [
    'prepare:/projects/broken.hcad',
    'open:/projects/broken.hcad',
    'discard',
    'prepare:/projects/safe.hcad',
    'open:/projects/safe.hcad',
  ]);
  assert.equal(result.activeRoot, '/projects/safe.hcad');
  assert.equal(result.failure?.reason, 'journal checksum mismatch');
  assert.equal(result.failure?.recoveredRoot, '/projects/safe.hcad');
});
