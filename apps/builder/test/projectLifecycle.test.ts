import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  BuilderProjectLifecycleStore,
  recentProjectLimitFromEnvironment,
  withArchiveExtension,
  withProjectExtension,
} from '../electron/projectLifecycle.js';

test('G-FP-3 recent project list is durable, de-duplicated and bounded', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'hcad-builder-recent-'));
  const preferences = resolve(root, 'project-lifecycle.v1.json');
  const store = new BuilderProjectLifecycleStore(preferences, 3);
  await store.opened(resolve(root, 'one.hcad'));
  await store.opened(resolve(root, 'two.hcad'));
  await store.opened(resolve(root, 'three.hcad'));
  await store.opened(resolve(root, 'one.hcad'));
  assert.deepEqual(store.recent().map((entry) => entry.name), ['one', 'three', 'two']);

  const relaunched = new BuilderProjectLifecycleStore(preferences, 3);
  await relaunched.load();
  assert.equal(relaunched.lastProjectPath(), resolve(root, 'one.hcad'));
  assert.deepEqual(relaunched.recent().map((entry) => entry.name), ['one', 'three', 'two']);
  assert.equal(JSON.parse(await readFile(preferences, 'utf8')).schemaVersion, 1);
});

test('project and archive extensions are explicit and the MRU tunable fails safe', () => {
  assert.equal(withProjectExtension('/tmp/site'), '/tmp/site.hcad');
  assert.equal(withProjectExtension('/tmp/site.hcad'), '/tmp/site.hcad');
  assert.equal(withArchiveExtension('/tmp/site'), '/tmp/site.hcadx');
  assert.equal(recentProjectLimitFromEnvironment('17'), 17);
  assert.equal(recentProjectLimitFromEnvironment('0'), 10);
});
