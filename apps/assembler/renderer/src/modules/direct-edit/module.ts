/**
 * The direct-edit module (assembler/MODULES.md): Offset Face (value modes),
 * Delete Face, move face. Its commands and kinds are still part of the
 * modelling module (`model/commands/featureCommands.ts`,
 * `model/features.ts`); phase B moves them here.
 */
import { defineAssemblerModule } from '../../foundation/commands/module.js';

export const directEditModule = defineAssemblerModule({ id: 'direct-edit' });
