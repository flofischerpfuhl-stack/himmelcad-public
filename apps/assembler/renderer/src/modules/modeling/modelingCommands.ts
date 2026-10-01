/**
 * The modelling module's core tool commands — Extrude, Fillet/Chamfer,
 * Shell, the body booleans, Move/Rotate and Delete — registered through the
 * modelling module (`renderer/src/modules/modeling/module.ts`) into the
 * command registry (`foundation/commands/registry.ts`). Moved out of the
 * registry unchanged.
 */
import {
  alwaysEnabled,
  kernelNotReady,
  registeredCommand,
  selected,
  type Command,
  type CommandAvailability,
  type CommandContext,
} from '../../foundation/commands/registry.js';
import { isPlanarFace, makeFaceRef } from '../../foundation/commands/store.js';
import { createDraft } from '../../foundation/commands/featureDrafts.js';
import { featureToolCommand } from '../../foundation/commands/featureToolCommand.js';
import {
  acceptAnyBody,
  normalizeToBody,
  registerPickPlan,
} from '../../foundation/commands/pickSession.js';
import { PRIMITIVE_LABEL, PRIMITIVE_SHAPES, type PrimitiveShape } from './features.js';
import { createPrimitiveDraft } from './primitiveTools.js';

// Scale started without bodies asks for them (tool before selection); Translate asks itself.
registerPickPlan('transform.scale', {
  label: 'Scale',
  steps: [
    {
      role: 'Bodies',
      prompt: 'Click the bodies to scale, then Next.',
      min: 1,
      max: Infinity,
      accept: acceptAnyBody,
      normalize: normalizeToBody,
    },
  ],
});

/** Selected edges if they all belong to one body, else `null`. */
function edgesOfOneBody(ctx: CommandContext) {
  const edges = selected(ctx, 'edge');
  if (edges.length === 0 || edges.length !== ctx.selection.length) return null;
  return edges.every((e) => e.bodyId === edges[0]!.bodyId) ? edges : null;
}

function facesOfOneBody(ctx: CommandContext) {
  const faces = selected(ctx, 'face');
  if (faces.length === 0 || faces.length !== ctx.selection.length) return null;
  return faces.every((f) => f.bodyId === faces[0]!.bodyId) ? faces : null;
}

function booleanAvailability(ctx: CommandContext): CommandAvailability {
  const notReady = kernelNotReady(ctx);
  if (notReady) return notReady;
  const bodies = selected(ctx, 'body');
  if (bodies.length < 2 || bodies.length !== ctx.selection.length) {
    return {
      enabled: false,
      reason: 'Select two or more bodies; the first one selected is kept.',
    };
  }
  return { enabled: true, recommended: true, priority: 60 };
}

/** Extrude, Fillet/Chamfer, Chamfer and Shell. */
export const MODELING_TOOL_COMMANDS: readonly Command[] = [
  {
    id: 'tools.extrude',
    label: 'Extrude',
    group: 'tools',
    shortcut: 'E',
    keywords: ['push', 'pull', 'solidify'],
    availability: (ctx) => {
      const faces = selected(ctx, 'face');
      const profiles = selected(ctx, 'sketchProfile');
      const singleFace = ctx.selection.length === 1 && faces.length === 1;
      const singleProfile = ctx.selection.length === 1 && profiles.length === 1;
      if (!singleFace && !singleProfile) {
        return { enabled: false, reason: 'Select a sketch profile or a body face to extrude.' };
      }
      const notReady = kernelNotReady(ctx);
      if (notReady) return notReady;
      if (singleFace && !isPlanarFace(ctx.evaluation, faces[0]!.bodyId, faces[0]!.faceKey)) {
        return { enabled: false, reason: 'Only planar faces can be extruded.' };
      }
      return { enabled: true, recommended: true, priority: 100 };
    },
    run: (ctx) => {
      const faces = selected(ctx, 'face');
      const profiles = selected(ctx, 'sketchProfile');
      if (ctx.selection.length === 1 && faces.length === 1) {
        const face = faces[0]!;
        const ref = makeFaceRef(ctx.evaluation, face.bodyId, face.faceKey);
        if (ref) ctx.beginExtrude({ kind: 'face', face: ref });
        return;
      }
      if (ctx.selection.length === 1 && profiles.length === 1) {
        const { featureId, regionKey } = profiles[0]!;
        ctx.beginExtrude({
          kind: 'sketch',
          featureId,
          ...(regionKey ? { regions: [regionKey] } : {}),
        });
      }
    },
  },
  {
    id: 'tools.filletChamfer',
    label: 'Fillet/Chamfer',
    group: 'tools',
    shortcut: 'F',
    keywords: ['round', 'bevel', 'edge'],
    requiresKernel: true,
    availability: (ctx) => {
      const notReady = kernelNotReady(ctx);
      if (notReady) return notReady;
      if (!edgesOfOneBody(ctx)) {
        return { enabled: false, reason: 'Select one or more edges of one body.' };
      }
      return { enabled: true, recommended: true, priority: 100 };
    },
    run: (ctx) => ctx.beginEdgeBlend('fillet'),
  },
  {
    id: 'tools.chamfer',
    label: 'Chamfer',
    group: 'tools',
    keywords: ['bevel', 'edge', 'fillet'],
    requiresKernel: true,
    availability: (ctx) => {
      const notReady = kernelNotReady(ctx);
      if (notReady) return notReady;
      if (!edgesOfOneBody(ctx)) {
        return { enabled: false, reason: 'Select one or more edges of one body.' };
      }
      return { enabled: true, recommended: true, priority: 90 };
    },
    run: (ctx) => ctx.beginEdgeBlend('chamfer'),
  },
  {
    id: 'tools.shell',
    label: 'Shell',
    group: 'tools',
    shortcut: 'H',
    keywords: ['hollow', 'thin wall'],
    requiresKernel: true,
    availability: (ctx) => {
      const notReady = kernelNotReady(ctx);
      if (notReady) return notReady;
      if (!facesOfOneBody(ctx)) {
        return { enabled: false, reason: 'Select the faces of one body to open.' };
      }
      return { enabled: true, priority: 50 };
    },
    run: (ctx) => ctx.beginShell(),
  },
];

/** Union, Subtract and Intersect of the selected bodies. */
export const BOOLEAN_COMMANDS: readonly Command[] = [
  {
    id: 'tools.union',
    label: 'Union',
    group: 'tools',
    shortcut: 'Ctrl+U',
    keywords: ['boolean', 'combine', 'add'],
    requiresKernel: true,
    availability: booleanAvailability,
    run: (ctx) => ctx.beginBoolean('union'),
  },
  {
    id: 'tools.subtract',
    label: 'Subtract',
    group: 'tools',
    shortcut: 'Ctrl+B',
    keywords: ['boolean', 'cut', 'remove'],
    requiresKernel: true,
    availability: booleanAvailability,
    run: (ctx) => ctx.beginBoolean('subtract'),
  },
  {
    id: 'tools.intersect',
    label: 'Intersect',
    group: 'tools',
    shortcut: 'Ctrl+I',
    keywords: ['boolean', 'common'],
    requiresKernel: true,
    availability: booleanAvailability,
    run: (ctx) => ctx.beginBoolean('intersect'),
  },
];

const PRIMITIVE_KEYWORDS: Record<PrimitiveShape, string[]> = {
  box: ['cube', 'block', 'cuboid', 'primitive', 'add'],
  cylinder: ['rod', 'pin', 'peg', 'disc', 'primitive', 'add'],
  sphere: ['ball', 'primitive', 'add'],
  cone: ['frustum', 'taper', 'primitive', 'add'],
  torus: ['ring', 'donut', 'o-ring', 'primitive', 'add'],
};

/**
 * The "Add" menu (UI-02): primitive solids standing on the selected planar
 * face or construction plane, else on the XY grid (`primitiveTools.ts`).
 */
export const PRIMITIVE_COMMANDS: readonly Command[] = PRIMITIVE_SHAPES.map((shape) => ({
  id: `add.${shape}`,
  label: PRIMITIVE_LABEL[shape],
  group: 'add' as const,
  keywords: PRIMITIVE_KEYWORDS[shape],
  requiresKernel: true,
  // Global creation tools: in the Add menu and search, not in the selection's toolbar.
  adaptive: false,
  availability: (ctx: CommandContext) => kernelNotReady(ctx) ?? { enabled: true },
  run: (ctx: CommandContext) => {
    const start = createPrimitiveDraft(shape, ctx);
    if (start.ok) ctx.beginFeatureTool(start.draft);
  },
}));

/** Move/Rotate, Translate, Scale and Delete. */
export const TRANSFORM_COMMANDS: readonly Command[] = [
  {
    id: 'transform.moveRotate',
    label: 'Move/Rotate',
    group: 'transform',
    shortcut: 'M',
    keywords: [
      'move',
      'rotate',
      'translate',
      'transform',
      'gizmo',
      'mv',
      'move face',
      'move profile',
    ],
    availability: (ctx) => {
      // Shapr3D Move/Rotate takes sketch regions, edges, faces and bodies (modelling research §4).
      if (ctx.selection.length !== 1) {
        return {
          enabled: false,
          reason: 'Select one body, face or sketch profile to move or rotate.',
        };
      }
      const item = ctx.selection[0]!;
      if (item.kind === 'body') return { enabled: true, recommended: true, priority: 90 };
      if (item.kind === 'sketchProfile') return { enabled: true, priority: 60 };
      if (item.kind === 'face') {
        const notReady = kernelNotReady(ctx);
        if (notReady) return notReady;
        // A face moves along its normal (Offset Face); Offset Face stays the recommended entry.
        return { enabled: true, priority: 70 };
      }
      if (item.kind === 'edge') {
        const notReady = kernelNotReady(ctx);
        if (notReady) return notReady;
        // A straight edge between planar faces moves; its faces tilt (Move Edge).
        const start = createDraft('moveEdge', ctx);
        return start.ok
          ? { enabled: true, priority: 60 }
          : { enabled: false, reason: start.reason };
      }
      return {
        enabled: false,
        reason: 'Select one body, face, edge or sketch profile to move or rotate.',
      };
    },
    run: (ctx) => {
      if (ctx.selection.length !== 1) return;
      const item = ctx.selection[0]!;
      if (item.kind === 'body') ctx.beginMove(item.bodyId);
      else if (item.kind === 'sketchProfile') ctx.beginMoveSketch(item.featureId, item.regionKey);
      else if (item.kind === 'edge') {
        const start = createDraft('moveEdge', ctx);
        if (start.ok) ctx.beginFeatureTool(start.draft);
      } else if (item.kind === 'face') {
        // A planar face moves in any direction (Move Face); a curved one along its normal.
        const move = createDraft('moveFace', ctx);
        if (move.ok) {
          ctx.beginFeatureTool(move.draft);
          return;
        }
        const start = createDraft('offsetFace', ctx);
        if (start.ok && start.draft.kind === 'offsetFace') {
          ctx.beginFeatureTool({ ...start.draft, distance: 0, viaMove: true });
        }
      }
    },
  },
  featureToolCommand({
    id: 'transform.translate',
    label: 'Translate',
    group: 'transform',
    kind: 'translate',
    keywords: ['move point to point', 'snap', 'from to', 'vertex to vertex', 'copy'],
  }),
  featureToolCommand({
    id: 'transform.scale',
    label: 'Scale',
    group: 'transform',
    kind: 'scale',
    keywords: ['resize', 'size', 'factor', 'fit test', 'shrink', 'grow', 'non-uniform'],
  }),
  {
    id: 'transform.delete',
    label: 'Delete',
    group: 'transform',
    shortcut: 'Del',
    keywords: ['remove', 'erase'],
    availability: (ctx) =>
      ctx.selection.length > 0 ? alwaysEnabled : { enabled: false, reason: 'Nothing selected.' },
    run: (ctx) => {
      // Deleting faces removes them from the body and heals it (Delete Face tool).
      if (ctx.selection.every((item) => item.kind === 'face')) {
        const deleteFace = registeredCommand('tools.deleteFace');
        if (deleteFace?.availability(ctx).enabled) deleteFace.run(ctx);
        return;
      }
      for (const item of ctx.selection) {
        if (item.kind === 'feature' || item.kind === 'sketchProfile' || item.kind === 'datum') {
          ctx.deleteFeature(item.featureId);
        } else if (item.kind === 'body') {
          const body = ctx.evaluation.bodies.find((b) => b.id === item.bodyId);
          if (body) ctx.deleteFeature(body.createdBy);
        } else if (item.kind === 'mesh') {
          // An imported STL reference mesh is not a step: it is removed from the project.
          ctx.removeReferenceMesh(item.meshId);
        }
      }
      ctx.clearSelection();
    },
  },
];
