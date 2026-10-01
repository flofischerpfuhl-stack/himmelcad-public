/**
 * The display settings in the project file (`viewState`): display mode and
 * toggles first, and the face-aligned section plane and "section only" next
 * to the store's section fields. View-only: changing them never makes the
 * project unsaved. On Open (after the store's own `applyViewState`) this
 * section's `load` applies them (`viewDisplayFromProject`).
 */
import { useAssemblerStore } from '../../foundation/commands/store.js';
import { registerViewStatePart } from '../../foundation/document/format.js';
import type { ProjectSection } from '../../foundation/document/projectSections.js';
import { viewDisplayFromProject, viewDisplayToProject } from './viewDisplay.js';

// First in `viewState`, as always.
registerViewStatePart({ key: 'displayMode', module: 'display', order: 100 });
registerViewStatePart({ key: 'display', module: 'display', order: 110 });

export const DISPLAY_PROJECT_SECTION: ProjectSection = {
  id: 'display.view',
  // After the store's own view state: the section plane follows its section fields.
  order: 200,
  save: () => {
    const display = viewDisplayToProject(useAssemblerStore.getState().viewState);
    return {
      viewState: {
        displayMode: display.displayMode,
        display: display.display,
        section: display.sectionExtras,
      },
    };
  },
  load: (project) => {
    if (!project?.viewState) return;
    const fields = viewDisplayFromProject(project.viewState);
    useAssemblerStore.setState((s) => ({ viewState: { ...s.viewState, ...fields } }));
  },
};
