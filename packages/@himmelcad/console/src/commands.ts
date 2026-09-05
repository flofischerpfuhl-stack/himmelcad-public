import {
  completeConsoleCommand,
  consoleHelpEntries,
  executeConsoleLine,
  type CommandContext,
  type CommandExecutor,
} from '../../app/src/commands.js';

export function consoleVocabulary(): readonly string[] {
  return consoleHelpEntries().map((entry) => entry.id);
}

export function completeConsoleInput(input: string): readonly string[] {
  return completeConsoleCommand(input);
}

export function runConsoleCommand(
  raw: string,
  context: CommandContext,
  execute: CommandExecutor,
) {
  return executeConsoleLine(raw, context, execute);
}
