/**
 * Sketch commands (registered into `registry.ts`'s `COMMANDS`): entering
 * and leaving sketch mode, the drawing tools (single-key shortcuts from the
 * Shapr3D shortcut list: L, A, C, R, G, I (Spline), T, O, P (Project), D;
 * Assembler's own for tools Shapr3D has no key for: U Slot, Y Ellipse,
 * K Text, J Mirror, N Pattern, Shift+R Fillet/Chamfer) and the constraints
 * (Shift + letter), with availability derived from the sketch session and
 * its selection — the same source for toolbar, command search, context
 * menu and keyboard.
 */
import { CONSTRAINT_INFO, planConstraint } from '../../sketch/constraintRules.js';
import { useSketchStore, type BeginSketchOptions } from '../../sketch/session.js';
import type { SketchToolKind } from '../../sketch/tools.js';
import { isPlanarFace, type SelectionItem } from '../store.js';
import type { Command, CommandAvailability, CommandContext } from './registry.js';

const enabled: CommandAvailability = { enabled: true };
const NOT_SKETCHING = 'Open a sketch first (double-click a sketch, or start one with L, R or C).';

function session() {
  return useSketchStore.getState().session;
}

/** The single selected planar face, if any (a new sketch goes there). */
function selectedPlanarFace(ctx: CommandContext): { bodyId: string; faceKey: string } | null {
  if (ctx.selection.length !== 1) return null;
  const item = ctx.selection[0]!;
  if (item.kind !== 'face') return null;
  return isPlanarFace(ctx.evaluation, item.bodyId, item.faceKey) ? item : null;
}

/** The sketch feature id of the current selection (a profile or a sketch history card). */
export function selectedSketchId(ctx: CommandContext): string | null {
  if (ctx.selection.length !== 1) return null;
  const item: SelectionItem = ctx.selection[0]!;
  if (item.kind === 'sketchProfile') return item.featureId;
  if (item.kind === 'feature') {
    const feature = ctx.features.find((f) => f.id === item.featureId);
    return feature?.kind === 'sketch' ? feature.id : null;
  }
  return null;
}

function beginNew(ctx: CommandContext, options: BeginSketchOptions): void {
  const face = selectedPlanarFace(ctx);
  useSketchStore.getState().begin({ ...(face ? { face } : {}), ...options });
}

/** A drawing tool: switches tools in sketch mode, otherwise starts a new sketch with it. */
function drawingTool(
  id: string,
  label: string,
  shortcut: string,
  tool: SketchToolKind,
  keywords: string[],
): Command {
  return {
    id,
    label,
    group: 'sketch',
    shortcut,
    keywords: ['sketch', 'draw', ...keywords],
    availability: (ctx) => {
      if (session()) return { enabled: true, recommended: session()!.tool.kind === tool };
      const face = selectedPlanarFace(ctx);
      return { enabled: true, recommended: face !== null, priority: face ? 65 : 0 };
    },
    run: (ctx) => {
      if (session()) useSketchStore.getState().setTool(tool);
      else beginNew(ctx, { tool });
    },
  };
}

/** A sketch-mode-only tool (Trim, Offset, Dimension). */
function sessionTool(
  id: string,
  label: string,
  shortcut: string,
  tool: SketchToolKind,
  keywords: string[],
): Command {
  return {
    id,
    label,
    group: 'sketch',
    shortcut,
    keywords: ['sketch', ...keywords],
    availability: () =>
      session()
        ? { enabled: true, recommended: session()!.tool.kind === tool }
        : { enabled: false, reason: NOT_SKETCHING },
    run: () => useSketchStore.getState().setTool(tool),
  };
}

function constraintCommand(info: (typeof CONSTRAINT_INFO)[number]): Command {
  return {
    id: `sketch.constrain.${info.kind}`,
    label: info.label,
    group: 'sketch',
    shortcut: info.shortcut,
    keywords: ['constraint', 'sketch', info.kind],
    availability: () => {
      const s = session();
      if (!s) return { enabled: false, reason: NOT_SKETCHING };
      const plan = planConstraint(s.sketch, info.kind, s.selection);
      return plan.ok
        ? { enabled: true, recommended: true, priority: 40 }
        : { enabled: false, reason: plan.reason };
    },
    run: () => void useSketchStore.getState().applyConstraint(info.kind),
  };
}

export const SKETCH_COMMANDS: readonly Command[] = [
  {
    id: 'sketch.new',
    label: 'New Sketch',
    group: 'sketch',
    keywords: ['sketch', 'plane', 'face', 'profile'],
    availability: (ctx) =>
      session()
        ? { enabled: false, reason: 'Finish the current sketch first.' }
        : { enabled: true, recommended: selectedPlanarFace(ctx) !== null, priority: 60 },
    run: (ctx) => beginNew(ctx, { tool: 'line' }),
  },
  ...(['XY', 'XZ', 'YZ'] as const).map(
    (plane): Command => ({
      id: `sketch.new${plane}`,
      label: `New Sketch on ${plane}`,
      group: 'sketch',
      keywords: ['sketch', 'plane', plane.toLowerCase()],
      availability: () =>
        session() ? { enabled: false, reason: 'Finish the current sketch first.' } : enabled,
      run: () => void useSketchStore.getState().begin({ plane, tool: 'line' }),
    }),
  ),
  {
    id: 'sketch.edit',
    label: 'Edit Sketch',
    group: 'sketch',
    keywords: ['sketch', 'modify', 'open'],
    availability: (ctx) => {
      if (session()) return { enabled: false, reason: 'A sketch is already open.' };
      return selectedSketchId(ctx)
        ? { enabled: true, recommended: true, priority: 80 }
        : { enabled: false, reason: 'Select a sketch.' };
    },
    run: (ctx) => {
      const id = selectedSketchId(ctx);
      if (id) useSketchStore.getState().begin({ featureId: id });
    },
  },
  {
    id: 'sketch.finish',
    label: 'Finish Sketch',
    group: 'sketch',
    keywords: ['sketch', 'done', 'close', 'exit'],
    availability: () =>
      session()
        ? { enabled: true, recommended: true, priority: 10 }
        : { enabled: false, reason: NOT_SKETCHING },
    run: () => void useSketchStore.getState().finish(),
  },
  drawingTool('sketch.line', 'Line', 'L', 'line', ['segment', 'polyline']),
  drawingTool('sketch.arc', 'Arc', 'A', 'arc', ['curve', 'tangent arc', 'three point']),
  drawingTool('sketch.circle', 'Circle', 'C', 'circle', ['round', 'hole', 'diameter']),
  drawingTool('sketch.rectangle', 'Rectangle', 'R', 'rectangle', ['rect', 'box profile']),
  drawingTool('sketch.polygon', 'Polygon', 'G', 'polygon', [
    'hexagon',
    'regular',
    'inscribed',
    'circumscribed',
  ]),
  drawingTool('sketch.spline', 'Spline', 'I', 'spline', [
    'curve',
    'bezier',
    'freeform',
    'fit point',
    'control point',
  ]),
  drawingTool('sketch.slot', 'Slot', 'U', 'slot', ['oblong', 'arc slot', 'obround', 'long hole']),
  drawingTool('sketch.ellipse', 'Ellipse', 'Y', 'ellipse', ['oval', 'elliptical arc']),
  drawingTool('sketch.text', 'Text', 'K', 'text', ['lettering', 'label', 'font', 'emboss']),
  sessionTool('sketch.trim', 'Trim', 'T', 'trim', ['cut', 'split', 'delete segment']),
  sessionTool('sketch.offset', 'Offset', 'O', 'offset', ['parallel copy', 'offset edge']),
  sessionTool('sketch.fillet', 'Sketch Fillet / Chamfer', 'Shift+R', 'corner', [
    'round corner',
    'chamfer',
    'bevel',
    'radius',
  ]),
  sessionTool('sketch.mirror', 'Sketch Mirror', 'J', 'mirror', ['symmetry', 'flip', 'reflect']),
  sessionTool('sketch.pattern', 'Sketch Pattern', 'N', 'pattern', [
    'array',
    'repeat',
    'linear',
    'circular',
    'copies',
  ]),
  sessionTool('sketch.project', 'Project', 'P', 'project', [
    'use edge',
    'reference',
    'silhouette',
    'intersect',
    'include geometry',
  ]),
  sessionTool('sketch.dimension', 'Dimension', 'D', 'dimension', [
    'measure',
    'length',
    'angle',
    'radius',
  ]),
  {
    id: 'sketch.construction',
    label: 'Construction',
    group: 'sketch',
    shortcut: 'Q',
    keywords: ['sketch', 'reference', 'helper', 'dashed'],
    availability: () => {
      const s = session();
      if (!s) return { enabled: false, reason: NOT_SKETCHING };
      return { enabled: true, recommended: s.construction };
    },
    run: () => void useSketchStore.getState().toggleConstructionOfSelection(),
  },
  ...CONSTRAINT_INFO.map(constraintCommand),
  {
    id: 'sketch.toggleReference',
    label: 'Reference Dimension',
    group: 'sketch',
    keywords: ['sketch', 'driven', 'reference', 'dimension', 'measure only'],
    availability: () => {
      const s = session();
      if (!s) return { enabled: false, reason: NOT_SKETCHING };
      const dimension = s.sketch.dimensions.find((d) => s.selection.includes(d.id));
      return dimension
        ? { enabled: true, recommended: true, priority: 35 }
        : { enabled: false, reason: 'Select a dimension.' };
    },
    run: () => {
      const s = session();
      const dimension = s?.sketch.dimensions.find((d) => s.selection.includes(d.id));
      if (dimension) void useSketchStore.getState().toggleReference(dimension.id);
    },
  },
  {
    id: 'sketch.editText',
    label: 'Edit Text',
    group: 'sketch',
    keywords: ['sketch', 'text', 'lettering', 'change'],
    availability: () => {
      const s = session();
      if (!s) return { enabled: false, reason: NOT_SKETCHING };
      const text = s.sketch.entities.find((e) => e.kind === 'text' && s.selection.includes(e.id));
      return text
        ? { enabled: true, recommended: true, priority: 45 }
        : { enabled: false, reason: 'Select a text.' };
    },
    run: () => {
      const s = session();
      const text = s?.sketch.entities.find((e) => e.kind === 'text' && s.selection.includes(e.id));
      if (text) useSketchStore.getState().editText(text.id);
    },
  },
  {
    id: 'sketch.deleteSelection',
    label: 'Delete Sketch Selection',
    group: 'sketch',
    keywords: ['sketch', 'remove', 'erase'],
    availability: () => {
      const s = session();
      if (!s) return { enabled: false, reason: NOT_SKETCHING };
      return s.selection.length > 0
        ? enabled
        : { enabled: false, reason: 'Nothing selected in the sketch.' };
    },
    run: () => void useSketchStore.getState().deleteSelection(),
  },
];
