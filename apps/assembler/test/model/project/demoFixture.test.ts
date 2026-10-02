/**
 * The demo bracket as a project file for the web e2e tests
 * (`apps/assembler-web/e2e/fixtures/demo-bracket.hcasm`): since Block 9 the
 * products start with a blank project, so the browser tests open the demo
 * the way a user opens a file (dropped onto the window). This test keeps
 * the checked-in file equal to `createDemoDocument()`; `ASSEMBLER_UPDATE_FIXTURES=1`
 * rewrites it.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createDemoDocument } from '../../../renderer/src/foundation/commands/demoDocument.js';
import {
  loadProjectFile,
  saveProjectFile,
} from '../../../renderer/src/foundation/document/format.js';

const FIXTURE = join(process.cwd(), '..', 'assembler-web', 'e2e', 'fixtures', 'demo-bracket.hcasm');

void test('the web e2e demo fixture is the demo document', () => {
  const text = `${saveProjectFile({
    projectName: 'Bracket',
    features: createDemoDocument(),
    appVersion: 'e2e-fixture',
    createdAt: '2026-10-02T00:00:00.000Z',
    modifiedAt: '2026-10-02T00:00:00.000Z',
  })}\n`;
  if (process.env.ASSEMBLER_UPDATE_FIXTURES === '1' || !existsSync(FIXTURE)) {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, text);
  }
  const stored = readFileSync(FIXTURE, 'utf8');
  assert.deepEqual(loadProjectFile(stored).features, createDemoDocument(), FIXTURE);
});
