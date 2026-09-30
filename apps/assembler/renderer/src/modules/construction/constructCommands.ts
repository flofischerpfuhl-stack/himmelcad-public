/**
 * Construct menu (Shapr3D 2026 "Construct", interaction research §1;
 * modelling research §2): construction planes and axes. Each command opens
 * the Construct tool in one mode, prefilled from the selection; whatever is
 * missing the tool asks for in its pill (it starts with or without a
 * selection). Plus the commands a selected plane/axis offers: sketch on
 * it (in `sketchCommands.ts`), cut the Section View along it.
 */
import { createConstructionDraft, type AxisMode, type PlaneMode } from './constructionTools.js';
import { PLANE_DEF_LABEL, AXIS_DEF_LABEL } from './construction.js';
import type { AssemblerState } from '../../foundation/commands/store.js';
import type { Command, CommandAvailability } from '../../foundation/commands/registry.js';

const KERNEL_LOADING = 'The CAD kernel is still loading.';
const KERNEL_FAILED = 'The CAD kernel failed to load.';

function kernelReason(ctx: AssemblerState): CommandAvailability | null {
  if (ctx.kernelStatus === 'ready') return null;
  return { enabled: false, reason: ctx.kernelStatus === 'error' ? KERNEL_FAILED : KERNEL_LOADING };
}

function selectedDatum(ctx: AssemblerState, kind: 'plane' | 'axis'): string | null {
  if (ctx.selection.length !== 1) return null;
  const item = ctx.selection[0]!;
  if (item.kind !== 'datum') return null;
  return ctx.evaluation.datums?.find((d) => d.featureId === item.featureId)?.kind === kind
    ? item.featureId
    : null;
}

interface Spec {
  id: string;
  label: string;
  kind: 'constructionPlane' | 'constructionAxis';
  mode: PlaneMode | AxisMode;
  keywords: string[];
  /** Recommended (adaptive bar) for this selection, with the priority. */
  recommend?: (ctx: AssemblerState) => number | null;
}

const count = (ctx: AssemblerState, kind: string) =>
  ctx.selection.filter((s) => s.kind === kind).length;

const SPECS: readonly Spec[] = [
  {
    id: 'construct.planeOffset',
    label: 'Offset Plane',
    kind: 'constructionPlane',
    mode: 'offset',
    keywords: ['construction plane', 'plane', 'datum', 'offset', 'parallel', 'work plane'],
    recommend: (ctx) => (selectedDatum(ctx, 'plane') ? 50 : null),
  },
  {
    id: 'construct.planeAngle',
    label: 'Plane at Angle',
    kind: 'constructionPlane',
    mode: 'angle',
    keywords: ['construction plane', 'plane', 'datum', 'angle', 'tilted', 'through edge'],
    recommend: (ctx) => (count(ctx, 'face') === 1 && count(ctx, 'edge') === 1 ? 45 : null),
  },
  {
    id: 'construct.planeThreePoints',
    label: 'Plane Through Three Points',
    kind: 'constructionPlane',
    mode: 'threePoints',
    keywords: ['construction plane', 'plane', 'datum', 'three points', '3 points', 'vertices'],
    recommend: (ctx) => (count(ctx, 'edge') === 3 && ctx.selection.length === 3 ? 45 : null),
  },
  {
    id: 'construct.midplane',
    label: 'Midplane',
    kind: 'constructionPlane',
    mode: 'midplane',
    keywords: ['construction plane', 'plane', 'datum', 'mid plane', 'middle', 'symmetry plane'],
    recommend: (ctx) => (count(ctx, 'face') === 2 && ctx.selection.length === 2 ? 40 : null),
  },
  {
    id: 'construct.planeTangent',
    label: 'Tangent Plane',
    kind: 'constructionPlane',
    mode: 'tangent',
    keywords: ['construction plane', 'plane', 'datum', 'tangent', 'cylinder', 'touching'],
  },
  {
    id: 'construct.axisEdge',
    label: 'Axis Along Edge',
    kind: 'constructionAxis',
    mode: 'edge',
    keywords: ['construction axis', 'axis', 'datum', 'edge', 'line'],
  },
  {
    id: 'construct.axisTwoPoints',
    label: 'Axis Through Two Points',
    kind: 'constructionAxis',
    mode: 'twoPoints',
    keywords: ['construction axis', 'axis', 'datum', 'two points', '2 points'],
  },
  {
    id: 'construct.axisCylinder',
    label: 'Cylinder Axis',
    kind: 'constructionAxis',
    mode: 'cylinder',
    keywords: ['construction axis', 'axis', 'datum', 'hole axis', 'shaft', 'center line'],
  },
  {
    id: 'construct.axisPlanes',
    label: 'Axis at Plane Intersection',
    kind: 'constructionAxis',
    mode: 'planes',
    keywords: ['construction axis', 'axis', 'datum', 'intersection', 'two planes'],
  },
];

function toCommand(spec: Spec): Command {
  return {
    id: spec.id,
    label: spec.label,
    group: 'construct',
    keywords: [
      ...spec.keywords,
      spec.kind === 'constructionPlane'
        ? PLANE_DEF_LABEL[spec.mode as PlaneMode]
        : AXIS_DEF_LABEL[spec.mode as AxisMode],
    ],
    requiresKernel: true,
    availability: (ctx) => {
      const notReady = kernelReason(ctx);
      if (notReady) return notReady;
      if (ctx.activeTool) return { enabled: false, reason: 'Finish the running tool first.' };
      const priority = spec.recommend?.(ctx) ?? null;
      return priority === null
        ? { enabled: true, priority: 15 }
        : { enabled: true, recommended: true, priority };
    },
    run: (ctx) =>
      ctx.beginFeatureTool(
        createConstructionDraft(spec.kind, spec.mode, ctx.selection, ctx.evaluation),
      ),
  };
}

export const CONSTRUCT_COMMANDS: readonly Command[] = [
  ...SPECS.map(toCommand),
  {
    id: 'construct.sectionAtPlane',
    label: 'Section at Plane',
    group: 'construct',
    keywords: ['section view', 'cut', 'construction plane', 'clip'],
    availability: (ctx) =>
      selectedDatum(ctx, 'plane')
        ? { enabled: true, recommended: true, priority: 40 }
        : { enabled: false, reason: 'Select a construction plane.' },
    run: (ctx) => {
      const id = selectedDatum(ctx, 'plane');
      const datum = ctx.evaluation.datums?.find((d) => d.featureId === id);
      if (!datum) return;
      const name = ctx.features.find((f) => f.id === id)?.name ?? 'Plane';
      // On first (it would reset the offset to the model centre), then onto the plane (offset 0).
      if (!ctx.viewState.sectionEnabled) ctx.setSectionEnabled(true);
      ctx.setSectionPlane({ normal: datum.frame.normal, origin: datum.center, label: name });
    },
  },
];
