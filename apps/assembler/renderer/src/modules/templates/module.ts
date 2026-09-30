/**
 * The templates module (assembler/MODULES.md): Home-screen project
 * templates (`templates/projectTemplates.ts`, moved here in phase B). It
 * registers nothing yet; the Home screen reads the templates directly.
 */
import { defineAssemblerModule } from '../../foundation/commands/module.js';

export const templatesModule = defineAssemblerModule({ id: 'templates' });
