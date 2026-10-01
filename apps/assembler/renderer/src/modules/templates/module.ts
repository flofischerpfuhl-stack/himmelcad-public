/**
 * The templates module (assembler/MODULES.md): the Home screen's "New from
 * template" parts (`projectTemplates.ts`), registered with the template
 * registry (`foundation/commands/projectTemplates.ts`) the shell reads.
 */
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { PROJECT_TEMPLATES } from './projectTemplates.js';

export const templatesModule = defineAssemblerModule({
  id: 'templates',
  projectTemplates: PROJECT_TEMPLATES,
});
