/**
 * The embedded assistant (assembler/AGENT-ASSISTANT.md; interface layer,
 * above agent-api): "describe the part, get an editable model" with the
 * user's own Claude/Codex/OpenCode CLI. Registers here what runs without a
 * UI — the commands, the `skills.*` methods (headless too) and the project
 * file fields (skills, sessions) — and, in the renderer, the command layer
 * the tools run on. The island and the Skills tab are `module.ui.tsx`.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';
import { appSessionHost } from '../agent-api/automationStore.js';
import { AgentSession } from '../agent-api/session.js';
import { ASSISTANT_COMMANDS } from './commands.js';
import { attachAssistantRuntime } from './controller.js';
import { SESSIONS_PROJECT_SECTION } from './sessions.js';
import { SKILLS_API, SKILLS_PROJECT_SECTION } from './skills.js';

export const assistantModule = defineAssemblerModule({
  id: 'assistant',
  commands: [{ order: COMMAND_ORDER.assistant, commands: ASSISTANT_COMMANDS }],
  api: SKILLS_API,
  fileFormatFields: [SKILLS_PROJECT_SECTION, SESSIONS_PROJECT_SECTION],
  install: (host) => {
    // The assistant's own command-layer session on the app's document (app capabilities:
    // no file paths), separate from Agent Access so their transactions never mix.
    const session = new AgentSession({
      store: useAssemblerStore,
      kernel: host.kernel,
      host: appSessionHost(),
    });
    attachAssistantRuntime({
      session,
      store: useAssemblerStore,
      subscribeStore: (listener) =>
        useAssemblerStore.subscribe((state, previous) => {
          if (
            state.features !== previous.features ||
            state.parameters !== previous.parameters ||
            state.checks !== previous.checks
          )
            listener();
        }),
    });
  },
});
