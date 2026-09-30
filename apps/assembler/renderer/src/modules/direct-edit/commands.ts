/**
 * Offset Face and Delete Face commands (tool drafts in `drafts.ts`),
 * registered by the direct-edit module in the block between the modelling
 * module's profile tools and its other feature tools
 * (`COMMAND_ORDER.directEdit`), which is where they always were.
 */
import type { Command } from '../../foundation/commands/registry.js';
import type { AssemblerState } from '../../foundation/commands/store.js';
import {
  featureToolCommand,
  twoFacesOfTwoBodies,
} from '../../foundation/commands/featureToolCommand.js';

/** Every selected item is a face (at least one). */
function onlyFaces(ctx: AssemblerState): boolean {
  return ctx.selection.length > 0 && ctx.selection.every((s) => s.kind === 'face');
}

export const DIRECT_EDIT_COMMANDS: readonly Command[] = [
  featureToolCommand({
    id: 'tools.offsetFace',
    label: 'Offset Face',
    group: 'tools',
    kind: 'offsetFace',
    keywords: ['push', 'pull', 'hole size', 'enlarge', 'thicken', 'direct edit'],
    // Shapr3D (interaction research §2): selecting a face activates Offset Face.
    // Two faces of two bodies are an Align case instead.
    recommend: (ctx) => (onlyFaces(ctx) && !twoFacesOfTwoBodies(ctx) ? 120 : null),
  }),
  featureToolCommand({
    id: 'tools.deleteFace',
    label: 'Delete Face',
    group: 'tools',
    kind: 'deleteFace',
    keywords: ['remove fillet', 'fill hole', 'heal', 'defeature', 'direct edit'],
  }),
];
