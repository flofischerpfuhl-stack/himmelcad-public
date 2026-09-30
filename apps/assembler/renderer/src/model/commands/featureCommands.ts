/**
 * Commands of the modelling-feature tools (Revolve, Sweep, Loft, Mirror,
 * Pattern, Split, Align, Offset Face, Delete Face, and the print-part tools
 * Hole, Emboss, Draft, Rib, Thicken), spliced into
 * `registry.ts`'s `COMMANDS` so the menu, adaptive toolbar, search,
 * context menu and shortcuts all see them. Availability and the tool start
 * come from `featureTools.ts` (`createDraft`), so a disabled command shows
 * exactly the reason the tool could not start.
 */
import { createDraft, type FeatureDraftKind } from '../featureTools.js';
import type { AssemblerState, SelectionItem } from '../store.js';
import type { Command, CommandAvailability, CommandGroup } from './registry.js';

const KERNEL_LOADING = 'The CAD kernel is still loading.';
const KERNEL_FAILED = 'The CAD kernel failed to load.';

function count(ctx: AssemblerState, kind: SelectionItem['kind']): number {
  return ctx.selection.filter((s) => s.kind === kind).length;
}

/** Every selected item is a face (at least one). */
function onlyFaces(ctx: AssemblerState): boolean {
  return ctx.selection.length > 0 && ctx.selection.every((s) => s.kind === 'face');
}

/** Exactly two faces, on two different bodies (Shapr3D: Align / Replace Face). */
function twoFacesOfTwoBodies(ctx: AssemblerState): boolean {
  const faces = ctx.selection.filter((s) => s.kind === 'face');
  return (
    faces.length === 2 &&
    ctx.selection.length === 2 &&
    faces[0]!.kind === 'face' &&
    faces[1]!.kind === 'face' &&
    faces[0]!.bodyId !== faces[1]!.bodyId
  );
}

function nonPlanarFaceSelected(ctx: AssemblerState): boolean {
  return ctx.selection.some((s) => {
    if (s.kind !== 'face') return false;
    const face = ctx.evaluation.bodies
      .find((b) => b.id === s.bodyId)
      ?.faces.find((f) => f.key === s.faceKey);
    return face !== undefined && face.surface !== 'plane';
  });
}

interface FeatureCommandSpec {
  id: string;
  label: string;
  group: CommandGroup;
  kind: FeatureDraftKind;
  shortcut?: string;
  keywords: string[];
  /** Recommended (adaptive toolbar first) when this returns a priority. */
  recommend?: (ctx: AssemblerState) => number | null;
}

const SPECS: readonly FeatureCommandSpec[] = [
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
  {
    id: 'tools.offsetFace',
    label: 'Offset Face',
    group: 'tools',
    kind: 'offsetFace',
    keywords: ['push', 'pull', 'hole size', 'enlarge', 'thicken', 'direct edit'],
    // Shapr3D (interaction research §2): selecting a face activates Offset Face.
    // Two faces of two bodies are an Align case instead.
    recommend: (ctx) => (onlyFaces(ctx) && !twoFacesOfTwoBodies(ctx) ? 120 : null),
  },
  {
    id: 'tools.deleteFace',
    label: 'Delete Face',
    group: 'tools',
    kind: 'deleteFace',
    keywords: ['remove fillet', 'fill hole', 'heal', 'defeature', 'direct edit'],
  },
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

function toCommand(spec: FeatureCommandSpec): Command {
  const availability = (ctx: AssemblerState): CommandAvailability => {
    if (ctx.kernelStatus !== 'ready') {
      return {
        enabled: false,
        reason: ctx.kernelStatus === 'error' ? KERNEL_FAILED : KERNEL_LOADING,
      };
    }
    const start = createDraft(spec.kind, ctx);
    if (!start.ok) return { enabled: false, reason: start.reason };
    const priority = spec.recommend?.(ctx) ?? null;
    return priority === null
      ? { enabled: true, priority: 40 }
      : { enabled: true, recommended: true, priority };
  };
  return {
    id: spec.id,
    label: spec.label,
    group: spec.group,
    ...(spec.shortcut ? { shortcut: spec.shortcut } : {}),
    keywords: spec.keywords,
    requiresKernel: true,
    availability,
    run: (ctx) => {
      const start = createDraft(spec.kind, ctx);
      if (start.ok) ctx.beginFeatureTool(start.draft);
    },
  };
}

export const FEATURE_COMMANDS: readonly Command[] = SPECS.map(toCommand);
