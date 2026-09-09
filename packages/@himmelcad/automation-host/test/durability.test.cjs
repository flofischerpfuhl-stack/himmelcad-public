'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { syncDirectory } = require('../durability.cjs');

test('directory sync runs on POSIX and is skipped on Windows', async () => {
  const calls = [];
  const filesystem = {
    open: async (path, flags) => {
      calls.push(['open', path, flags]);
      return {
        sync: async () => calls.push(['sync']),
        close: async () => calls.push(['close']),
      };
    },
  };

  assert.equal(await syncDirectory(filesystem, '/project', 'linux'), true);
  assert.deepEqual(calls, [['open', '/project', 'r'], ['sync'], ['close']]);

  calls.length = 0;
  assert.equal(await syncDirectory(filesystem, 'C:\\project', 'win32'), false);
  assert.deepEqual(calls, []);
});

test('unsupported directory sync errors remain best-effort', async () => {
  let closed = false;
  const error = Object.assign(new Error('directory fsync is unsupported'), { code: 'ENOTSUP' });
  const filesystem = {
    open: async () => ({
      sync: async () => {
        throw error;
      },
      close: async () => {
        closed = true;
      },
    }),
  };

  assert.equal(await syncDirectory(filesystem, '/project', 'linux'), false);
  assert.equal(closed, true);
});
