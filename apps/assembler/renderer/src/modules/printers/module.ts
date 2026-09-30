/**
 * The printers module (assembler/MODULES.md): registered slicers
 * (`print/slicerStore.ts`, `electron/slicer*.ts`); later printer profiles,
 * build volumes and direct send. It registers nothing yet.
 */
import { defineAssemblerModule } from '../../foundation/commands/module.js';

export const printersModule = defineAssemblerModule({ id: 'printers' });
