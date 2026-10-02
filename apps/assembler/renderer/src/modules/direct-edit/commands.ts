/**
 * Offset Face, Delete Face and Replace Face commands (tool drafts in
 * `drafts.ts`, `replaceFaceTool.ts`),
 * registered by the direct-edit module in the block between the modelling
 * module's profile tools and its other feature tools
 * (`COMMAND_ORDER.directEdit`), which is where they always were.
 */
import { registerPickPlan } from '../../foundation/commands/pickSession.js';
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
  featureToolCommand({
    id: 'tools.replaceFace',
    label: 'Replace Face',
    group: 'tools',
    kind: 'replaceFace',
    keywords: [
      'flush',
      'extend to face',
      'trim to face',
      'match face',
      'up to face',
      'direct edit',
    ],
    // Shapr3D (interaction research §2): two faces of two bodies suggest Align and Replace Face.
    recommend: (ctx) => (twoFacesOfTwoBodies(ctx) ? 114 : null),
  }),
];

// Started without faces, Replace Face asks for them, then for the replacing face (UI-16).
registerPickPlan('tools.replaceFace', {
  label: 'Replace Face',
  steps: [
    {
      role: 'Faces to replace',
      prompt: 'Click the planar faces to replace, then Next.',
      min: 1,
      max: Infinity,
      accept: (item, picks, ctx) => {
        if (item.kind !== 'face') return 'Click a planar face.';
        const face = ctx.evaluation.bodies
          .find((b) => b.id === item.bodyId)
          ?.faces.find((f) => f.key === item.faceKey);
        if (face?.surface !== 'plane') return 'Only planar faces can be replaced.';
        const first = picks[0]?.[0];
        return first && first.kind === 'face' && first.bodyId !== item.bodyId
          ? 'The faces to replace must belong to one body.'
          : null;
      },
    },
    {
      role: 'Replacing face',
      prompt: 'Click the replacing face (planar or cylindrical).',
      min: 1,
      max: 1,
      accept: (item, _picks, ctx) => {
        if (item.kind !== 'face') return 'Click a face.';
        const face = ctx.evaluation.bodies
          .find((b) => b.id === item.bodyId)
          ?.faces.find((f) => f.key === item.faceKey);
        return face?.surface === 'plane' || face?.surface === 'cylinder'
          ? null
          : 'The replacing face must be planar or cylindrical.';
      },
    },
  ],
});
