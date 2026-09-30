import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addRecentFile,
  emptyRecentFilesState,
  extractThumbnail,
  MAX_RECENT_FILES,
  parseRecentFilesState,
  relocateRecentFile,
  removeRecentFile,
} from '../../electron/recentFiles.js';

void test('addRecentFile puts the new path first', () => {
  let state = emptyRecentFilesState();
  state = addRecentFile(state, 'C:/a.hcasm', '2020-01-01T00:00:00.000Z');
  state = addRecentFile(state, 'C:/b.hcasm', '2020-01-02T00:00:00.000Z');
  assert.deepEqual(
    state.entries.map((e) => e.path),
    ['C:/b.hcasm', 'C:/a.hcasm'],
  );
});

void test('addRecentFile de-duplicates by path, moving the existing entry to the front', () => {
  let state = emptyRecentFilesState();
  state = addRecentFile(state, 'C:/a.hcasm', '2020-01-01T00:00:00.000Z');
  state = addRecentFile(state, 'C:/b.hcasm', '2020-01-02T00:00:00.000Z');
  state = addRecentFile(state, 'C:/a.hcasm', '2020-01-03T00:00:00.000Z');
  assert.equal(state.entries.length, 2);
  assert.deepEqual(
    state.entries.map((e) => e.path),
    ['C:/a.hcasm', 'C:/b.hcasm'],
  );
  assert.equal(state.entries[0]!.openedAt, '2020-01-03T00:00:00.000Z');
});

void test('addRecentFile caps the list at MAX_RECENT_FILES, dropping the oldest', () => {
  let state = emptyRecentFilesState();
  for (let i = 0; i < MAX_RECENT_FILES + 3; i += 1) {
    state = addRecentFile(state, `C:/file${i}.hcasm`, new Date(2020, 0, i + 1).toISOString());
  }
  assert.equal(state.entries.length, MAX_RECENT_FILES);
  // Most recent first: the last-added file is at the front...
  assert.equal(state.entries[0]!.path, `C:/file${MAX_RECENT_FILES + 2}.hcasm`);
  // ...and the earliest ones were evicted.
  assert.ok(!state.entries.some((e) => e.path === 'C:/file0.hcasm'));
});

void test('removeRecentFile drops exactly the named entry', () => {
  let state = emptyRecentFilesState();
  state = addRecentFile(state, 'C:/a.hcasm');
  state = addRecentFile(state, 'C:/b.hcasm');
  state = removeRecentFile(state, 'C:/a.hcasm');
  assert.deepEqual(
    state.entries.map((e) => e.path),
    ['C:/b.hcasm'],
  );
});

void test('relocateRecentFile ("Locate…") replaces the path in place, keeping list order and timestamp', () => {
  let state = emptyRecentFilesState();
  state = addRecentFile(state, 'C:/a.hcasm', '2020-01-01T00:00:00.000Z');
  state = addRecentFile(state, 'C:/b.hcasm', '2020-01-02T00:00:00.000Z');
  // Most-recent-first order after the two adds above is [b, a].
  state = relocateRecentFile(state, 'C:/a.hcasm', 'D:/moved/a.hcasm');
  assert.deepEqual(
    state.entries.map((e) => e.path),
    ['C:/b.hcasm', 'D:/moved/a.hcasm'],
  );
  assert.equal(state.entries[1]!.openedAt, '2020-01-01T00:00:00.000Z');
});

void test("relocateRecentFile onto an existing entry's path merges rather than duplicating", () => {
  let state = emptyRecentFilesState();
  state = addRecentFile(state, 'C:/a.hcasm', '2020-01-01T00:00:00.000Z');
  state = addRecentFile(state, 'C:/b.hcasm', '2020-01-02T00:00:00.000Z');
  state = relocateRecentFile(state, 'C:/a.hcasm', 'C:/b.hcasm');
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0]!.path, 'C:/b.hcasm');
});

void test('parseRecentFilesState falls back to empty for malformed input rather than throwing', () => {
  assert.deepEqual(parseRecentFilesState(null), emptyRecentFilesState());
  assert.deepEqual(parseRecentFilesState('garbage'), emptyRecentFilesState());
  assert.deepEqual(parseRecentFilesState({ version: 2, entries: [] }), emptyRecentFilesState());
  assert.deepEqual(parseRecentFilesState({ version: 1, entries: 'nope' }), emptyRecentFilesState());
});

void test('parseRecentFilesState drops malformed entries but keeps valid ones', () => {
  const parsed = parseRecentFilesState({
    version: 1,
    entries: [
      { path: 'C:/a.hcasm', name: 'a.hcasm', openedAt: '2020-01-01T00:00:00.000Z' },
      { path: 123, name: 'bad' },
      'not-an-object',
    ],
  });
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0]!.path, 'C:/a.hcasm');
});

void test('a saved-then-parsed state round trips', () => {
  let state = emptyRecentFilesState();
  state = addRecentFile(state, 'C:/a.hcasm', '2020-01-01T00:00:00.000Z');
  const parsed = parseRecentFilesState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(parsed, state);
});

void test('extractThumbnail finds the PNG data URL near the start of a .hcasm, nothing else', () => {
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const head = `{\n  "format": "himmelcad-assembler",\n  "projectName": "Box",\n  "thumbnail": "${png}",\n  "features": [`;
  assert.equal(extractThumbnail(head), png);
  assert.equal(extractThumbnail('{"projectName": "Old file", "features": []}'), null);
  // Only a PNG data URL of the base64 alphabet is accepted (it goes straight into an <img>).
  assert.equal(extractThumbnail('{"thumbnail": "javascript:alert(1)"}'), null);
  assert.equal(extractThumbnail('{"thumbnail": "data:image/svg+xml;base64,PHN2Zz4="}'), null);
});
