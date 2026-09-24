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
    COMMAND_REGISTRY.filter(
      (entry) => entry.surfaces.console && entry.products.includes(productId),
    ).map((entry) => entry.id);

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

  // The console is shared: PhotoLab sees its own product rows, Builder never does.
  const photolabVocabulary = expectedIds('photolab');
  const photolabHelp = await runConsoleCommand(
    'help',
    { ...context, productId: 'photolab' },
    () => undefined,
  );
  assert.equal(photolabHelp.kind, 'help');
  if (photolabHelp.kind === 'help') {
    assert.deepEqual(
      photolabHelp.lines.map((line) => line.split(/\s/, 1)[0]),
      photolabVocabulary,
    );
  }
  const photolabOnly = photolabVocabulary.filter((id) => !builderVocabulary.includes(id));
  assert.ok(photolabOnly.length > 0);
  assert.deepEqual(
    photolabOnly.filter((id) => !id.startsWith('photolab.')),
    [],
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
