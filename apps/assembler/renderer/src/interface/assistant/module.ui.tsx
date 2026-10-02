/**
 * The assistant's desktop UI: the island (Chat and Skills tabs) floating over
 * the viewport, the Assistant toggle in the left dock's mode group, and the
 * wiring of the shared `@himmelcad/agent` runtime (harness discovery and
 * drivers, the redactor) to the controller.
 */
import { discoverHarnesses, findHarnessDriver, redactSensitiveText } from '@himmelcad/agent';

import { host } from '../../foundation/host/index.js';
import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import { configureAssistant } from './controller.js';
import { AssistantButton } from './ui/AssistantButton.js';
import { AssistantIsland } from './ui/AssistantIsland.js';

export const assistantUi = defineModuleUi({
  id: 'assistant',
  panels: [{ id: 'assistant', slot: 'overlay', order: 500, component: AssistantIsland }],
  modeButtons: [{ id: 'assistant', order: 300, component: AssistantButton }],
  install: () => {
    configureAssistant(
      {
        discover: (transport) => discoverHarnesses(transport),
        create: (identity, transport) =>
          findHarnessDriver(identity.provider).create({
            transport,
            identity,
            scope: {
              workspaceCapabilityId: 'assembler-open-project',
              filesystem: 'readOnly',
              network: 'providerOnly',
              destructiveCommands: 'productApprovalRequired',
            },
          }),
        redact: (text) => redactSensitiveText(text, 128 * 1024),
      },
      host().assistant ?? null,
      host().unavailableReason('assistant'),
    );
  },
});
