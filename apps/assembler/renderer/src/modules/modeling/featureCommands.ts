/**
 * Commands of the modelling-feature tools (Revolve, Sweep, Loft, Split,
 * Mirror, Pattern, Rotate Around Axis, Align, and the print-part tools
 * Hole, Emboss, Draft, Rib, Thicken), registered by the modelling module.
 * Availability and the tool start come from the tool drafts
 * (`featureToolCommand`, `drafts.ts`), so a disabled command shows exactly
 * the reason the tool could not start. Offset Face and Delete Face are the
 * direct-edit module's; their block sits between the two blocks here, so
 * the published command order is unchanged.
 */
import type { AssemblerState } from '../../foundation/commands/store.js';
import type { Command } from '../../foundation/commands/registry.js';
import {
  countSelected as count,
  featureToolCommand,
  twoFacesOfTwoBodies,
  type FeatureToolCommandSpec,
} from '../../foundation/commands/featureToolCommand.js';

function nonPlanarFaceSelected(ctx: AssemblerState): boolean {
  return ctx.selection.some((s) => {
    if (s.kind !== 'face') return false;
    const face = ctx.evaluation.bodies
      .find((b) => b.id === s.bodyId)
      ?.faces.find((f) => f.key === s.faceKey);
    return face !== undefined && face.surface !== 'plane';
  });
}
/** Revolve, Sweep, Loft (before the direct-edit block). */
const PROFILE_SPECS: readonly FeatureToolCommandSpec[] = [
  {
    id: 'tools.revolve',
    label: 'Revolve',
    group: 'tools',
    kind: 'revolve',
    shortcut: 'V',
    keywords: ['lathe', 'rotate profile', 'turn', 'axis'],
    // Shapr3D: a profile plus an axis selects Revolve.
    recommend: (ctx) => (count(ctx, 'edge') === 1 ? 110 : null),
  },
  {
    id: 'tools.sweep',
    label: 'Sweep',
    group: 'tools',
    kind: 'sweep',
    shortcut: 'W',
    keywords: ['path', 'pipe', 'spine', 'tube'],
    recommend: (ctx) => (count(ctx, 'edge') > 1 ? 105 : null),
  },
  {
    id: 'tools.loft',
    label: 'Loft',
    group: 'tools',
    kind: 'loft',
    keywords: ['blend profiles', 'transition', 'sections'],
    recommend: (ctx) => (count(ctx, 'sketchProfile') >= 2 ? 105 : null),
  },
];

/** Split, the print-part tools and the transform tools (after the direct-edit block). */
const SPECS: readonly FeatureToolCommandSpec[] = [
  {
    id: 'tools.split',
    label: 'Split Body',
    group: 'tools',
    kind: 'split',
    keywords: ['cut in two', 'divide', 'plane'],
    recommend: (ctx) => (count(ctx, 'face') === 1 && count(ctx, 'body') === 1 ? 85 : null),
  },
  // ---- print-part tools (`printFeatureTools.ts`) ----
  {
    id: 'tools.hole',
    label: 'Hole',
    group: 'tools',
    kind: 'hole',
    keywords: [
      'drill',
      'screw',
      'bolt',
      'counterbore',
      'countersink',
      'clearance',
      'tap',
      'thread',
      'press fit',
      'M3',
    ],
    recommend: (ctx) =>
      ctx.selection.length === 1 && count(ctx, 'face') === 1 && !nonPlanarFaceSelected(ctx)
        ? 70
        : null,
  },
  {
    id: 'tools.emboss',
    label: 'Emboss',
    group: 'tools',
    kind: 'emboss',
    keywords: ['engrave', 'wrap', 'text', 'logo', 'label', 'deboss', 'raise'],
    recommend: (ctx) => (count(ctx, 'sketchProfile') >= 1 && count(ctx, 'face') === 1 ? 108 : null),
  },
  {
    id: 'tools.draft',
    label: 'Draft',
    group: 'tools',
    kind: 'draft',
    keywords: ['taper', 'mold', 'mould', 'angle faces', 'neutral plane', 'pull direction'],
  },
  {
    id: 'tools.rib',
    label: 'Rib',
    group: 'tools',
    kind: 'rib',
    keywords: ['web', 'gusset', 'stiffener', 'brace', 'strut'],
  },
  {
    id: 'tools.thicken',
    label: 'Thicken',
    group: 'tools',
    kind: 'thicken',
    keywords: ['surface to solid', 'offset solid', 'skin', 'sleeve', 'wall'],
  },
  {
    id: 'transform.mirror',
    label: 'Mirror',
    group: 'transform',
    kind: 'mirror',
    keywords: ['reflect', 'symmetry', 'flip copy'],
    recommend: (ctx) => (count(ctx, 'face') === 1 && count(ctx, 'body') >= 1 ? 88 : null),
  },
  {
    id: 'transform.pattern',
    label: 'Pattern',
    group: 'transform',
    kind: 'pattern',
    // "Pattern (3D)" in Shapr3D's manual; lets "p3" find it.
    keywords: ['pattern 3d', 'array', 'repeat', 'copies', 'circular', 'linear'],
  },
  {
    id: 'transform.rotateAxis',
    label: 'Rotate Around Axis',
    group: 'transform',
    kind: 'rotateAxis',
    keywords: ['rotate', 'axis', 'hinge', 'pivot', 'turn body', 'spin', 'swing'],
    // Shapr3D (interaction research §2): a line plus a face suggests Rotate Around Axis.
    recommend: (ctx) =>
      count(ctx, 'edge') === 1 && (count(ctx, 'face') >= 1 || count(ctx, 'body') >= 1) ? 112 : null,
  },
  {
    id: 'transform.align',
    label: 'Align',
    group: 'transform',
    kind: 'align',
    keywords: ['mate', 'snap faces', 'place', 'coplanar'],
    // Shapr3D: two faces of different bodies suggest Align (and Replace Face).
    recommend: (ctx) => (twoFacesOfTwoBodies(ctx) ? 115 : null),
  },
];

export const PROFILE_FEATURE_COMMANDS: readonly Command[] = PROFILE_SPECS.map(featureToolCommand);
export const FEATURE_COMMANDS: readonly Command[] = SPECS.map(featureToolCommand);
