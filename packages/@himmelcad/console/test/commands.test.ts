import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMAND_REGISTRY, type CommandContext } from '../../app/src/commands.js';
import { completeConsoleInput, consoleVocabulary, runConsoleCommand } from '../src/commands.js';

const context: CommandContext = {
  hasProject: true,
  productId: 'builder',
  selectedEntityIds: [],
  selectedEntityKinds: [],
};

void test('console help vocabulary is exactly the generated registry table', async () => {
  const expectedIds = (productId: string) =>
    COMMAND_REGISTRY.filter((entry) => entry.products.includes(productId)).map((entry) => entry.id);

  const builderVocabulary = expectedIds('builder');
  assert.deepEqual(consoleVocabulary(), builderVocabulary);
  const help = await runConsoleCommand('help', context, () => undefined);
  assert.equal(help.kind, 'help');
  if (help.kind === 'help') {
    assert.deepEqual(
      help.lines.map((line) => line.split(/\s/, 1)[0]),
      builderVocabulary,
    );
  }

  const photolabVocabulary = expectedIds('photolab');
  assert.deepEqual(
    photolabVocabulary.filter((id) => !builderVocabulary.includes(id)),
    ['photolab.images.remove', 'photolab.gcp.images'],
  );
});

void test('completion and execution accept every available command by id', async () => {
  assert.deepEqual(completeConsoleInput('view.preset.t'), ['view.preset.top']);
  let called = '';
  await runConsoleCommand('view.frame', context, (invocation) => {
    called = invocation.id;
  });
  assert.equal(called, 'view.frame');
});
