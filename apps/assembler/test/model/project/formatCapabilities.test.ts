/**
 * The `.hcasm` minimum-reader rule (`document/formatCapabilities.ts`): a file
 * lists the geometry-changing optional fields it uses in `requires`, and a
 * reader refuses one it does not know with a readable message instead of
 * building the plain feature. Documents without such a field are written
 * exactly as before; the schema stays 3.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Feature } from '../../../renderer/src/foundation/document/document.js';
import { featureFormatCapabilities } from '../../../renderer/src/foundation/document/featureKinds.js';
import {
  CURRENT_SCHEMA_VERSION,
  loadProjectFile,
  ProjectFormatError,
  saveProjectFile,
} from '../../../renderer/src/foundation/document/format.js';
import {
  knownFormatCapabilities,
  registerFormatCapability,
} from '../../../renderer/src/foundation/document/formatCapabilities.js';
import { createDemoDocument } from '../../../renderer/src/foundation/commands/demoDocument.js';

const DATES = { createdAt: '2026-10-02T00:00:00.000Z', modifiedAt: '2026-10-02T00:00:00.000Z' };

function save(features: Feature[]): string {
  return saveProjectFile({ projectName: 'Caps', features, appVersion: 'test', ...DATES });
}

function tapered(): Feature[] {
  return createDemoDocument().map((f) =>
    f.kind === 'extrude' && f.id === 'feature-extrude-1' ? { ...f, taper: 3 } : f,
  );
}

void test('a plain document has no requires list (bytes as before, schema 3)', () => {
  const text = save(createDemoDocument());
  const raw = JSON.parse(text) as Record<string, unknown>;
  assert.equal('requires' in raw, false);
  assert.equal(raw.schemaVersion, 3);
  assert.equal(CURRENT_SCHEMA_VERSION, 3);
  assert.deepEqual(loadProjectFile(text).features, createDemoDocument());
});

void test('a tapered extrude writes its capability with a label and reads back', () => {
  const text = save(tapered());
  const raw = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(raw.requires, [{ id: 'extrude.taper', label: 'Extrude taper' }]);
  assert.deepEqual(Object.keys(raw).slice(0, 3), ['format', 'schemaVersion', 'requires']);
  const loaded = loadProjectFile(text);
  assert.deepEqual(loaded.features, tapered());
  // Saved again: the list is derived from the features, not copied.
  const again = JSON.parse(save(loaded.features)) as Record<string, unknown>;
  assert.deepEqual(again.requires, raw.requires);
  // A zero taper is the plain extrude: nothing required.
  const zero = createDemoDocument().map((f) => (f.kind === 'extrude' ? { ...f, taper: 0 } : f));
  assert.equal('requires' in (JSON.parse(save(zero)) as object), false);
});

void test('a reader refuses a capability it does not know, naming it by its label', () => {
  const raw = JSON.parse(save(tapered())) as Record<string, unknown>;
  raw.requires = [
    { id: 'extrude.taper', label: 'Extrude taper' },
    { id: 'loft.guideRails', label: 'Loft guide rails' },
    { id: 'thread.cosmetic', label: 'Cosmetic threads' },
  ];
  assert.throws(
    () => loadProjectFile(JSON.stringify(raw)),
    (error: unknown) =>
      error instanceof ProjectFormatError &&
      error.message ===
        'This project needs a newer HimmelCAD Assembler: it uses Loft guide rails and Cosmetic threads. Update the app to open it.',
  );
  // Without a label the id is shown.
  raw.requires = [{ id: 'loft.guideRails' }];
  assert.throws(() => loadProjectFile(JSON.stringify(raw)), /it uses loft\.guideRails\./);
  // Malformed lists are format errors of their own.
  for (const bad of [{}, ['x'], [{ id: '' }], [{ id: 'a.b', label: 3 }]]) {
    raw.requires = bad;
    assert.throws(() => loadProjectFile(JSON.stringify(raw)), /at requires/);
  }
  // A newer schema says so first.
  raw.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
  raw.requires = [{ id: 'loft.guideRails', label: 'Loft guide rails' }];
  assert.throws(() => loadProjectFile(JSON.stringify(raw)), /newer version .*schema version 4/);
});

void test('the modelling kinds declare their Block 8 geometry fields', () => {
  const base = { name: 'x', suppressed: false } as const;
  const used = (feature: Record<string, unknown>) =>
    [...featureFormatCapabilities([{ ...base, id: 'f', ...feature } as unknown as Feature])].sort();
  assert.deepEqual(used({ kind: 'revolve', helix: { pitch: 2, turns: 3 } }), ['revolve.helix']);
  assert.deepEqual(used({ kind: 'revolve', angle: 360 }), []);
  assert.deepEqual(
    used({
      kind: 'pattern',
      pattern: {
        kind: 'linear',
        count: 2,
        spacing: 5,
        spacingMode: 'total',
        second: { count: 2, spacing: 3 },
      },
    }),
    ['pattern.totalLength', 'pattern.twoDirections'],
  );
  assert.deepEqual(
    used({
      kind: 'pattern',
      pattern: { kind: 'circular', count: 4, angle: 30, angleMode: 'spacing', uniform: true },
    }),
    ['pattern.angleSpacing', 'pattern.uniform'],
  );
  assert.deepEqual(
    used({ kind: 'pattern', pattern: { kind: 'circular', count: 4, angle: 360 } }),
    [],
  );
  assert.deepEqual(
    used({ kind: 'split', profile: { kind: 'sketch', featureId: 's' }, keepOriginal: true }),
    ['split.keepOriginal', 'split.profile'],
  );
  const ids = knownFormatCapabilities().map((c) => c.id);
  for (const id of ['extrude.taper', 'revolve.helix', 'pattern.twoDirections', 'split.profile']) {
    assert.ok(ids.includes(id), id);
  }
});

void test('capability ids are owned once', () => {
  registerFormatCapability({ id: 'test.thing', label: 'Test thing', module: 'test' });
  registerFormatCapability({ id: 'test.thing', label: 'Test thing', module: 'test' });
  assert.throws(() =>
    registerFormatCapability({ id: 'test.thing', label: 'Other', module: 'other' }),
  );
  assert.throws(() => registerFormatCapability({ id: 'Bad Id', label: 'x', module: 'test' }));
});
