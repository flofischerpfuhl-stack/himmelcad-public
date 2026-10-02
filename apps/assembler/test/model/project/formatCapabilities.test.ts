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

/** Block 9 parity steps on the demo bracket, each using one of its new geometry fields. */
function parityDocument(): Feature[] {
  const body = 'body:feature-extrude-1';
  const base = { suppressed: false } as const;
  const steps: Record<string, unknown>[] = [
    {
      ...base,
      id: 'b9-pattern',
      name: 'Pattern 1',
      kind: 'pattern',
      bodyIds: [body],
      sketchIds: ['feature-sketch-4'],
      pattern: {
        kind: 'linear',
        direction: { kind: 'world', axis: 'X' },
        count: 2,
        spacing: 80,
        second: { direction: { kind: 'world', axis: 'Y' }, count: 2, spacing: 80 },
        third: { direction: { kind: 'world', axis: 'Z' }, count: 2, spacing: 80 },
      },
    },
    {
      ...base,
      id: 'b9-split',
      name: 'Split 1',
      kind: 'split',
      bodyId: body,
      bodyIds: [body, 'body:b9-pattern:1'],
      plane: { kind: 'plane', plane: 'XY', offset: 3 },
    },
    {
      ...base,
      id: 'b9-align',
      name: 'Align 1',
      kind: 'align',
      bodyId: 'body:b9-pattern:1',
      from: { kind: 'axis', axis: { kind: 'world', axis: 'Y' } },
      to: { kind: 'axis', axis: { kind: 'world', axis: 'Z' } },
      flip: false,
      center: true,
      offset: 0,
      turn: 15,
    },
  ];
  return [...createDemoDocument(), ...(steps as unknown as Feature[])];
}

void test('the Block 9 parity fields are capabilities: written, read back, refused when unknown', () => {
  const text = save(parityDocument());
  const raw = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(raw.requires, [
    { id: 'align.from', label: 'Align from an edge, axis or curved face' },
    { id: 'align.to', label: 'Align to an edge, axis, datum or curved face' },
    { id: 'align.turn', label: 'Align with a turn' },
    { id: 'pattern.sketchIds', label: 'Pattern of sketches' },
    { id: 'pattern.third', label: 'Three-direction pattern' },
    { id: 'pattern.twoDirections', label: 'Two-direction pattern' },
    { id: 'split.bodyIds', label: 'Split of several bodies' },
  ]);
  const loaded = loadProjectFile(text);
  assert.deepEqual(loaded.features, parityDocument());
  assert.equal(save(loaded.features), text, 'saved again byte-identical');

  // Plain forms of the same steps need nothing: two planar faces, one body, no turn.
  const base = { name: 'x', suppressed: false } as const;
  const used = (feature: Record<string, unknown>) =>
    [...featureFormatCapabilities([{ ...base, id: 'f', ...feature } as unknown as Feature])].sort();
  assert.deepEqual(used({ kind: 'split', bodyId: 'a', bodyIds: ['a'] }), []);
  assert.deepEqual(used({ kind: 'align', bodyId: 'a', turn: 0 }), []);
  assert.deepEqual(used({ kind: 'pattern', bodyIds: ['a'], sketchIds: [] }), []);

  // A reader without them (simulated: ids it has not registered) names them by label.
  raw.requires = (raw.requires as { id: string; label: string }[]).map((r) => ({
    id: `${r.id}X`,
    label: r.label,
  }));
  assert.throws(
    () => loadProjectFile(JSON.stringify(raw)),
    /needs a newer HimmelCAD Assembler: it uses Align from an edge, axis or curved face, .* and Split of several bodies\./,
  );
});

void test('document data that does not change geometry is no capability', () => {
  // Checks, ignored print findings, assistant sessions/skills, Pattern folders, parameter ranges:
  // an older reader ignores them and builds the same bodies.
  const ids = knownFormatCapabilities().map((c) => c.id);
  for (const field of ['checks', 'printIgnored', 'assistantSessions', 'assistantSkills', 'items']) {
    assert.ok(!ids.some((id) => id.startsWith(`${field}.`)), field);
  }
  for (const id of ['align.from', 'align.to', 'align.turn', 'split.bodyIds', 'pattern.third']) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(ids.includes('pattern.sketchIds'));
});

void test('capability ids are owned once', () => {
  registerFormatCapability({ id: 'test.thing', label: 'Test thing', module: 'test' });
  registerFormatCapability({ id: 'test.thing', label: 'Test thing', module: 'test' });
  assert.throws(() =>
    registerFormatCapability({ id: 'test.thing', label: 'Other', module: 'other' }),
  );
  assert.throws(() => registerFormatCapability({ id: 'Bad Id', label: 'x', module: 'test' }));
});
