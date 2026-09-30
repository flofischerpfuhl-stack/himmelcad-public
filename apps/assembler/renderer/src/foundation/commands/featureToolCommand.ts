/**
 * The command of a feature tool (a registered draft kind,
 * `featureDrafts.ts`): available when the tool can start from the
 * selection (the draft's own reason otherwise), recommended with a
 * priority of the module's choosing, and started as the store's generic
 * `feature` tool session. Modules build their tool commands with it.
 */
import { createDraft, type FeatureDraftKind } from './featureDrafts.js';
import type { Command, CommandAvailability, CommandGroup } from './registry.js';
import type { AssemblerState } from './store.js';

const KERNEL_LOADING = 'The CAD kernel is still loading.';
const KERNEL_FAILED = 'The CAD kernel failed to load.';

export interface FeatureToolCommandSpec {
  id: string;
  label: string;
  group: CommandGroup;
  kind: FeatureDraftKind;
  shortcut?: string;
  keywords: string[];
  /** Recommended (adaptive toolbar first) when this returns a priority. */
  recommend?: (ctx: AssemblerState) => number | null;
}

export function featureToolCommand(spec: FeatureToolCommandSpec): Command {
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

/** Selected items of one kind. */
export function countSelected(
  ctx: AssemblerState,
  kind: AssemblerState['selection'][number]['kind'],
): number {
  return ctx.selection.filter((s) => s.kind === kind).length;
}

/** Exactly two faces, on two different bodies (Shapr3D: Align / Replace Face). */
export function twoFacesOfTwoBodies(ctx: AssemblerState): boolean {
  const faces = ctx.selection.filter((s) => s.kind === 'face');
  return (
    faces.length === 2 &&
    ctx.selection.length === 2 &&
    faces[0]!.kind === 'face' &&
    faces[1]!.kind === 'face' &&
    faces[0]!.bodyId !== faces[1]!.bodyId
  );
}
