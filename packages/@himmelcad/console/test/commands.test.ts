import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMAND_REGISTRY, type CommandContext } from '../../app/src/commands.js';
import { completeConsoleInput, consoleVocabulary, runConsoleCommand } from '../src/commands.js';

const context: CommandContext = {
  hasProject: true,
  selectedEntityIds: [],
  selectedEntityKinds: [],
};

void test('console help vocabulary is exactly the generated registry table', async () => {
  assert.deepEqual(consoleVocabulary(), COMMAND_REGISTRY.map((entry) => entry.id));
  const help = await runConsoleCommand('help', context, () => undefined);
  assert.equal(help.kind, 'help');
  if (help.kind === 'help') assert.equal(help.lines.length, COMMAND_REGISTRY.length);
});

void test('completion and execution accept every available command by id', async () => {
  assert.deepEqual(completeConsoleInput('view.preset.t'), ['view.preset.top']);
  let called = '';
  await runConsoleCommand('view.frame', context, (invocation) => { called = invocation.id; });
  assert.equal(called, 'view.frame');
});
