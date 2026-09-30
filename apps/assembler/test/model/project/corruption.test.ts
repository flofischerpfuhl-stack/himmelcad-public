/**
 * Corrupted `.hcasm` files (`assembler/ROBUSTNESS.md`): truncated, garbled,
 * non-finite and huge numbers, deep nesting, wrong shapes. Every one is
 * either refused as a whole with a readable `ProjectFormatError` (and the
 * open document stays untouched: no partial load), or, when it is a
 * structurally valid document with absurd values, opens and reports named
 * feature errors in bounded time. Never another exception type.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ApiError } from '../../../renderer/src/api/errors.js';
import { ProjectFormatError, loadProjectFile } from '../../../renderer/src/model/project/format.js';
import { FuzzHarness } from '../../fuzz/harness.js';

type Json = Record<string, unknown>;

// Compiled to `.build/tests/apps/assembler/test/model/project/`; fixtures live in the sources.
const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(here, '..', '..', '..', '..', '..', '..', '..');
const fixture = readFileSync(join(APP_DIR, 'test', 'fixtures', 'phone-stand.hcasm'), 'utf8');

function nested(depth: number): string {
  return `${'['.repeat(depth)}0${']'.repeat(depth)}`;
}

function withFeatureField(field: string, raw: string): string {
  // Splices raw JSON text (e.g. `NaN`, deep nesting) into the first extrude, bypassing JSON.stringify.
  const doc = JSON.parse(fixture) as { features: Json[] };
  doc.features.find((f) => f.kind === 'extrude')![field] = '__RAW__';
  return JSON.stringify(doc).replace('"__RAW__"', raw);
}

const REFUSED: [name: string, text: string][] = [
  ['empty file', ''],
  ['whitespace', '   \n\t'],
  ['truncated at half', fixture.slice(0, Math.floor(fixture.length / 2))],
  ['truncated by one byte', fixture.slice(0, -2)],
  ['garbled bytes', 'PK\u0003\u0004\u0000\u0000ÿþ garbage \u0000'],
  [
    'a UTF-8 BOM before garbage',
    '﻿{"format": "himmelcad-assembler", "schemaVersion": 3, "features": [',
  ],
  ['a JSON number', '42'],
  ['a JSON array', '[1, 2, 3]'],
  ['null', 'null'],
  ['another format', JSON.stringify({ format: 'something-else', schemaVersion: 1 })],
  ['future schema', fixture.replace(/"schemaVersion":\s*\d+/, '"schemaVersion": 999')],
  ['schemaVersion NaN', fixture.replace(/"schemaVersion":\s*\d+/, '"schemaVersion": NaN')],
  ['NaN literal in a feature', withFeatureField('distance', 'NaN')],
  ['Infinity via 1e999', withFeatureField('distance', '1e999')],
  ['-Infinity via -1e999', withFeatureField('distance', '-1e999')],
  ['features not an array', fixture.replace(/"features":\s*\[/, '"features": {"x": [')],
  ['deep nesting in a feature (100 000 levels)', withFeatureField('profile', nested(100_000))],
  ['deep nesting as the whole file (100 000 levels)', nested(100_000)],
  [
    'a feature of an unknown kind',
    (() => {
      const doc = JSON.parse(fixture) as { features: Json[] };
      doc.features.push({ id: 'x1', name: 'X', kind: 'teleport', suppressed: false });
      return JSON.stringify(doc);
    })(),
  ],
  [
    'duplicate feature ids',
    (() => {
      const doc = JSON.parse(fixture) as { features: Json[] };
      doc.features.push({ ...doc.features[0]! });
      return JSON.stringify(doc);
    })(),
  ],
];

void test('corrupted project files are refused with a readable ProjectFormatError (never another exception)', () => {
  assert.doesNotThrow(() => loadProjectFile(fixture), 'the fixture itself loads');
  for (const [name, text] of REFUSED) {
    let caught: unknown = null;
    try {
      loadProjectFile(text);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, `${name}: refused`);
    assert.ok(
      caught instanceof ProjectFormatError,
      `${name}: ProjectFormatError, got ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}`,
    );
    assert.ok(
      caught.message.length > 10 && !/undefined|\[object/.test(caught.message),
      `${name}: ${caught.message}`,
    );
  }
});

const harnessReady = FuzzHarness.create();

void test('agent project.open of a corrupted file: invalidParams, the open document untouched', async () => {
  const harness = await harnessReady;
  await harness.reset();
  await harness.call('project.open', { text: fixture });
  const before = harness.store.getState();
  const revision = harness.session.documentRevision;
  for (const [name, text] of REFUSED) {
    try {
      await harness.call('project.open', { text });
      assert.fail(`${name}: opened`);
    } catch (error) {
      assert.ok(error instanceof ApiError, `${name}: ${String(error)}`);
      assert.equal(error.code, 'invalidParams', `${name}: ${error.message}`);
    }
    const after = harness.store.getState();
    assert.strictEqual(after.features, before.features, `${name}: no partial load`);
    assert.strictEqual(after.parameters, before.parameters, `${name}: parameters kept`);
    assert.equal(after.projectName, before.projectName);
    assert.equal(harness.session.documentRevision, revision);
  }
});

void test('huge but finite numbers open and fail as named feature errors, in bounded time', async () => {
  const harness = await harnessReady;
  for (const huge of [1e6, 1e12, 1e100, Number.MAX_VALUE]) {
    const doc = JSON.parse(fixture) as { features: Json[] };
    const extrude = doc.features.find((f) => f.kind === 'extrude')!;
    extrude.distance = huge;
    const started = Date.now();
    const result = await harness.call<{
      errors: Record<string, string>;
      warnings: Record<string, string>;
      bodies: { valid: boolean }[];
    }>('project.open', { text: JSON.stringify(doc) });
    assert.ok(Date.now() - started < 60_000, `${huge}: evaluated in bounded time`);
    for (const message of Object.values(result.errors)) {
      assert.ok(message.length > 5 && !/undefined|\[object|^\d+$/.test(message), message);
    }
    // Every body that exists is valid, or a step says why not.
    if (result.bodies.some((b) => !b.valid)) {
      assert.ok(Object.keys({ ...result.errors, ...result.warnings }).length > 0, `${huge}: said`);
    }
    const state = harness.store.getState();
    assert.equal(state.features.length, doc.features.length, `${huge}: loaded as a whole`);
  }
});
