/**
 * The shell's own registrations (assembler/MODULES.md): view presets,
 * workspace and File commands, the notice toast the command gate uses and
 * the section state saved views carry.
 */
import { setNoticeSink } from '../../foundation/commands/notices.js';
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { setCameraSink } from '../../platform/viewport/cameraChannel.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { setProjectPersistence } from '../../foundation/document/projectPersistence.js';
import { PROJECT_PERSISTENCE } from './project/projectStore.js';
import { FILE_COMMANDS, VIEW_COMMANDS } from './shellCommands.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';
import { SAVED_VIEWS_SECTION, setSectionAccess, useWorkspaceStore } from './workspace.js';
import { WORKSPACE_COMMANDS } from './workspaceCommands.js';

export const shellUiModule = defineAssemblerModule({
  id: 'shell-ui',
  commands: [
    { order: COMMAND_ORDER.view, commands: VIEW_COMMANDS },
    { order: COMMAND_ORDER.workspace, commands: WORKSPACE_COMMANDS },
    { order: COMMAND_ORDER.file, commands: FILE_COMMANDS },
  ],
  fileFormatFields: [SAVED_VIEWS_SECTION],
  onInstall: () => {
    setNoticeSink((text, tone) => useWorkspaceStore.getState().notify(text, tone));
    setCameraSink((command) => useWorkspaceStore.getState().sendCamera(command));
    setProjectPersistence(PROJECT_PERSISTENCE);
    // Saved views carry the section state (`workspace.ts` `SavedSection`).
    setSectionAccess({
      read: () => {
        const v = useAssemblerStore.getState().viewState;
        return {
          enabled: v.sectionEnabled,
          axis: v.sectionAxis,
          offset: v.sectionOffset,
          flipped: v.sectionFlipped,
          plane: v.sectionPlane,
          sectionOnly: v.sectionOnly,
        };
      },
      apply: (section) =>
        useAssemblerStore.setState((s) => ({
          viewState: {
            ...s.viewState,
            sectionEnabled: section.enabled,
            sectionAxis: section.axis,
            sectionOffset: section.offset,
            sectionFlipped: section.flipped,
            sectionPlane: section.plane,
            sectionOnly: section.enabled && section.sectionOnly,
          },
        })),
    });
  },
});
