/**
 * The agent API's own registrations (assembler/MODULES.md): the Agent
 * Access command.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { AGENT_COMMANDS } from './agentCommands.js';

export const agentApiModule = defineAssemblerModule({
  id: 'agent-api',
  commands: [{ order: COMMAND_ORDER.agent, commands: AGENT_COMMANDS }],
});
