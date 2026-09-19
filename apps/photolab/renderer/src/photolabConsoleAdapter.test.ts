import assert from 'node:assert/strict';
import test from 'node:test';
import { consoleHelpEntries, type CommandContext } from '@himmelcad/app/commands';

import {
  photolabConsoleHelpLines,
  photolabConsoleRows,
  photolabConsoleVocabulary,
  runPhotolabConsoleCommand,
} from './photolabConsoleAdapter.js';

const context: CommandContext = {
  hasProject: true,
  productId: 'photolab',
  selectedEntityIds: ['camera-1'],
  selectedEntityKinds: ['other'],
  selectedCanonicalEntityKinds: ['CameraImage'],
  selectionEditable: true,
  selectionExportable: true,
  selectionVisibility: 'visible',
  clipboardAdmissible: true,
  candidates: [{ entityId: 'camera-1', kind: 'other', name: 'Camera 1' }],
};

test('PL-I3 exposes exactly the generated PhotoLab console rows', () => {
  const expected = consoleHelpEntries(context).map((entry) => entry.id);
  assert.deepEqual(
    photolabConsoleRows().map((entry) => entry.id),
    expected,
  );
  assert.equal(photolabConsoleHelpLines().length, expected.length);
  for (const [index, id] of expected.entries()) {
    assert.match(photolabConsoleHelpLines()[index]!, new RegExp(`^${id.replaceAll('.', '\\.')}(?: | —)`));
  }
});

test('PL-I3 has no private console vocabulary outside generated ids and aliases', () => {
  const generatedNames = photolabConsoleRows().flatMap((entry) => [
    entry.id,
    ...entry.console.aliases.map((alias) => alias.name),
  ]);
  assert.deepEqual(photolabConsoleVocabulary(), generatedNames);
  assert.equal(new Set(generatedNames).size, generatedNames.length);
});

test('PL-I3 retains the legacy PhotoLab console commands as generated aliases', () => {
  const names = new Set(photolabConsoleVocabulary());
  for (const name of [
    'alignment.resolve',
    'alignment.run',
    'alignment.profile',
    'product.run',
    'batch.run',
    'project.save',
  ]) {
    assert.ok(names.has(name), `${name} is missing`);
  }
});

test('PL-I3 dispatches typed JSON and generated legacy actions', async () => {
  const invocations: unknown[] = [];
  await runPhotolabConsoleCommand(
    'photolab.jobs.list {"includeTerminal":true}',
    context,
    (invocation) => {
      invocations.push(invocation);
    },
  );
  await runPhotolabConsoleCommand('alignment.profile fast', context, (invocation) => {
    invocations.push(invocation);
  });
  const [query, legacy] = invocations as Array<{
    payload: Record<string, unknown>;
    alias: { action: string } | null;
    args: string[];
  }>;
  assert.deepEqual(query!.payload, { includeTerminal: true });
  assert.equal(query!.alias, null);
  assert.equal(legacy!.alias?.action, 'setAlignmentProfile');
  assert.deepEqual(legacy!.args, ['fast']);
});

test('PL-I3 carries job and cancellation lifecycle in generated rows', () => {
  const quality = photolabConsoleRows().find(
    (entry) => entry.id === 'photolab.images.quality.start',
  );
  assert.equal(quality?.execution.kind, 'job');
  assert.equal(quality?.execution.cancelRoute, 'photolab.jobs.cancel');
  assert.match(
    quality?.console.argumentHelp ?? '',
    /operationId:string.*cameraEntityIds\?:string\[\]/u,
  );
});

test('PL-I3 rejects commands absent from the generated table', async () => {
  await assert.rejects(
    runPhotolabConsoleCommand('photolab.private.escape {}', context, () => undefined),
    /Unknown command/u,
  );
});
