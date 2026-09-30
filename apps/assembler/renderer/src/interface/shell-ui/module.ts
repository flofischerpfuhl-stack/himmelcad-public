/**
 * The shell's own registrations (assembler/MODULES.md): view presets,
 * workspace and File commands, and the notice toast the command gate uses.
 */
import { setNoticeSink } from '../../foundation/commands/notices.js';
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { setCameraSink } from '../../platform/viewport/cameraChannel.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { setProjectPersistence } from '../../foundation/document/projectPersistence.js';
import { PROJECT_PERSISTENCE } from './project/projectStore.js';
import { FILE_COMMANDS, VIEW_COMMANDS } from './shellCommands.js';
import { useWorkspaceStore } from './workspace.js';
import { WORKSPACE_COMMANDS } from './workspaceCommands.js';

export const shellUiModule = defineAssemblerModule({
  id: 'shell-ui',
  commands: [
    { order: COMMAND_ORDER.view, commands: VIEW_COMMANDS },
    { order: COMMAND_ORDER.workspace, commands: WORKSPACE_COMMANDS },
    { order: COMMAND_ORDER.file, commands: FILE_COMMANDS },
  ],
  onInstall: () => {
    setNoticeSink((text, tone) => useWorkspaceStore.getState().notify(text, tone));
    setCameraSink((command) => useWorkspaceStore.getState().sendCamera(command));
    setProjectPersistence(PROJECT_PERSISTENCE);
  },
});
