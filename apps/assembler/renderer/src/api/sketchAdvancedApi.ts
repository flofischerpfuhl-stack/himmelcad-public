/**
 * Agent-API side of the advanced sketch tools: splines, ellipses, slots,
 * polygons, text, mirror, patterns, fillet/chamfer corners, projections
 * and reference dimensions. Every command builds its edit with the same
 * pure functions the sketch tools use (`sketch/shapes.ts`,
 * `sketch/operations.ts`, `sketch/projection.ts`), so an agent-built sketch
 * is the one a user would draw; the caller (`session.ts#editSketch`)
 * re-solves and commits it as one undo step.
 */
import type { EvaluationResult } from '../foundation/geometry-kernel/types.js';
import type { Feature } from '../foundation/document/document.js';
import { SketchBuilder, type SnapTarget } from '../foundation/sketch-solver/edits.js';
import {
  circularPattern,
  linearPattern,
  mirrorGeometry,
  roundCorner,
} from '../sketch/operations.js';
import {
  addProjection,
  edgeSampleFromSegments,
  projectSource,
} from '../foundation/sketch-solver/projection.js';
import {
  buildArcSlot,
  buildEllipse,
  buildSlot,
  buildSpline,
  regularPolygon,
} from '../sketch/shapes.js';
import {
  DEFAULT_SKETCH_FONT,
  fontInfo,
  textOutline,
} from '../foundation/sketch-solver/text/fonts.js';
import type { SketchData, SketchProjection, Vec2 } from '../foundation/sketch-solver/types.js';
import { ApiError } from '../foundation/commands/api/errors.js';
import { resolveEdgeInput, resolveFaceInput } from '../foundation/commands/api/references.js';

type Json = Record<string, unknown>;

export const ADVANCED_SKETCH_METHODS = [
  'sketch.addSpline',
  'sketch.addEllipse',
  'sketch.addSlot',
  'sketch.addPolygon',
  'sketch.addText',
  'sketch.mirror',
  'sketch.pattern',
  'sketch.roundCorner',
  'sketch.project',
  'sketch.setReference',
] as const;

function vec(value: unknown, path: string): Vec2 {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    throw new ApiError('invalidParams', `${path}: expected [u, v]`);
  }
  return [value[0] as number, value[1] as number];
}

function positive(value: unknown, path: string): number {
  if (typeof value !== 'number' || !(value > 0)) {
    throw new ApiError('invalidParams', `${path}: expected a number above 0`);
  }
  return value;
}

function ids(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string')) {
    throw new ApiError('invalidParams', `${path}: expected a non-empty array of ids`);
  }
  return value as string[];
}

function snapOf(pos: Vec2, pointId?: unknown): SnapTarget {
  return typeof pointId === 'string' ? { pos, pointId } : { pos };
}

/** Created entity ids of an edit (not in `before`). */
function createdIds(before: SketchData, after: SketchData): string[] {
  const known = new Set(before.entities.map((e) => e.id));
  return after.entities.filter((e) => !known.has(e.id)).map((e) => e.id);
}

export async function advancedSketchEdit(
  method: string,
  p: Json,
  data: SketchData,
  ctx: { featureId: string; evaluation: EvaluationResult; features: readonly Feature[] },
): Promise<{ sketch: SketchData; result: Json }> {
  const construction = p.construction === true;
  switch (method) {
    case 'sketch.addSpline': {
      const points = (Array.isArray(p.points) ? p.points : []).map((q, i) =>
        vec(q, `points[${i}]`),
      );
      if (points.length < 2)
        throw new ApiError('invalidParams', 'A spline needs at least two points');
      const mode = p.mode === 'control' ? 'control' : 'fit';
      const b = new SketchBuilder(data);
      const snaps = points.map((q) => snapOf(q));
      if (p.closed === true) {
        const first = b.pointFor(snaps[0]!);
        snaps[0] = { pos: points[0]!, pointId: first };
        snaps.push({ pos: points[0]!, pointId: first });
      }
      const id = buildSpline(b, snaps, mode, construction);
      const sketch = b.result([id]).sketch;
      const spline = sketch.entities.find((e) => e.id === id);
      return {
        sketch,
        result: {
          entityId: id,
          pointIds: spline?.kind === 'spline' ? spline.points : [],
          handleIds: spline?.kind === 'spline' ? (spline.handles ?? []) : [],
        },
      };
    }
    case 'sketch.addEllipse': {
      const center = vec(p.center, 'center');
      const major = positive(p.majorRadius, 'majorRadius');
      const minor = positive(p.minorRadius, 'minorRadius');
      if (minor > major) {
        throw new ApiError('invalidParams', 'minorRadius must not exceed majorRadius');
      }
      const angle = (((typeof p.angle === 'number' ? p.angle : 0) as number) * Math.PI) / 180;
      const arc = Array.isArray(p.arc)
        ? (vec(p.arc, 'arc').map((deg) => (deg * Math.PI) / 180) as [number, number])
        : null;
      const b = new SketchBuilder(data);
      const id = buildEllipse(
        b,
        snapOf(center, p.centerPointId),
        { pos: [center[0] + major * Math.cos(angle), center[1] + major * Math.sin(angle)] },
        minor,
        {
          construction,
          arc,
          majorValue: p.dimension === true ? major : null,
          minorValue: p.dimension === true ? minor : null,
        },
      );
      const sketch = b.result([id]).sketch;
      return { sketch, result: { entityId: id, entityIds: createdIds(data, sketch) } };
    }
    case 'sketch.addSlot': {
      const width = positive(p.width, 'width');
      const b = new SketchBuilder(data);
      let created: string[];
      if (Array.isArray(p.arcCenter)) {
        const center = vec(p.arcCenter, 'arcCenter');
        const start = vec(p.start, 'start');
        const end = vec(p.end, 'end');
        const r = Math.hypot(start[0] - center[0], start[1] - center[1]);
        if (width / 2 >= r)
          throw new ApiError('invalidParams', 'The slot is wider than its arc radius');
        created = buildArcSlot(
          b,
          { pos: center },
          { pos: start },
          end,
          width / 2,
          p.clockwise !== true,
          {
            construction,
            width: p.dimension === false ? null : width,
          },
        );
      } else {
        const start = vec(p.start, 'start');
        const end = vec(p.end, 'end');
        const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
        if (!(length > 0)) throw new ApiError('invalidParams', 'start and end must differ');
        created = buildSlot(b, { pos: start }, { pos: end }, width / 2, {
          construction,
          length: p.dimension === false ? null : length,
          width: p.dimension === false ? null : width,
        });
      }
      const sketch = b.result(created).sketch;
      return { sketch, result: { curveIds: created, entityIds: createdIds(data, sketch) } };
    }
    case 'sketch.addPolygon': {
      const center = vec(p.center, 'center');
      const radius = positive(p.radius, 'radius');
      const sides = typeof p.sides === 'number' ? Math.round(p.sides) : 6;
      if (sides < 3 || sides > 64) throw new ApiError('invalidParams', 'sides: 3 to 64');
      const inscribed = p.inscribed !== false;
      const a = (((typeof p.angle === 'number' ? p.angle : 0) as number) * Math.PI) / 180;
      const cursor: Vec2 = [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)];
      const vertices = regularPolygon(center, cursor, sides, inscribed);
      const b = new SketchBuilder(data);
      const c = b.addPoint(center);
      const circle = b.addCircle(c, radius, true);
      const pointIds = vertices.map((v) => b.addPoint(v));
      const lines = pointIds.map((id, i) =>
        b.addLine(id, pointIds[(i + 1) % sides]!, construction),
      );
      if (inscribed) for (const id of pointIds) b.constrain('pointOnObject', [id, circle]);
      else for (const line of lines) b.constrain('tangent', [line, circle]);
      for (let i = 1; i < lines.length; i += 1) b.constrain('equal', [lines[0]!, lines[i]!]);
      return {
        sketch: b.result(lines).sketch,
        result: { lineIds: lines, centerId: c, circleId: circle },
      };
    }
    case 'sketch.addText': {
      const text = typeof p.text === 'string' ? p.text.replace(/[\r\n\t]+/g, ' ') : '';
      if (text.trim() === '')
        throw new ApiError('invalidParams', 'text: expected a non-empty string');
      const position = vec(p.position, 'position');
      const height = positive(p.height, 'height');
      const font = typeof p.font === 'string' ? p.font : DEFAULT_SKETCH_FONT;
      if (!fontInfo(font)) {
        throw new ApiError('invalidParams', `Unknown font "${font}"`, {
          hint: `Fonts: ${DEFAULT_SKETCH_FONT}`,
        });
      }
      const outline = await textOutline(font, text);
      const b = new SketchBuilder(data);
      const anchor = b.pointFor(snapOf(position, p.anchorPointId));
      const id = b.id('t');
      b.entities.push({
        id,
        kind: 'text',
        anchor,
        text,
        height,
        angle: typeof p.angle === 'number' ? p.angle : 0,
        font,
        outline: outline.outline,
        ...(construction ? { construction: true } : {}),
      });
      return {
        sketch: b.result([id]).sketch,
        result: { entityId: id, anchorId: anchor, missingCharacters: outline.missing },
      };
    }
    case 'sketch.mirror': {
      const edit = mirrorGeometry(data, ids(p.ids, 'ids'), String(p.axis));
      if (!edit) {
        throw new ApiError(
          'invalidParams',
          'Nothing to mirror: give curve/point ids and a line id as axis',
        );
      }
      return { sketch: edit.sketch, result: { createdIds: createdIds(data, edit.sketch) } };
    }
    case 'sketch.pattern': {
      const selection = ids(p.ids, 'ids');
      const count = typeof p.count === 'number' ? Math.round(p.count) : 0;
      if (count < 2 || count > 200) throw new ApiError('invalidParams', 'count: 2 to 200');
      const edit =
        p.mode === 'circular'
          ? circularPattern(
              data,
              selection,
              count,
              snapOf(vec(p.center ?? [0, 0], 'center'), p.centerPointId),
              typeof p.angle === 'number' ? p.angle : 360,
            )
          : linearPattern(
              data,
              selection,
              count,
              vec(p.direction ?? [1, 0], 'direction'),
              positive(p.spacing, 'spacing'),
            );
      if (!edit) throw new ApiError('invalidParams', 'Nothing to pattern: give curve or point ids');
      return { sketch: edit.sketch, result: { createdIds: createdIds(data, edit.sketch) } };
    }
    case 'sketch.roundCorner': {
      const mode = p.mode === 'chamfer' ? 'chamfer' : 'fillet';
      const edit = roundCorner(data, String(p.point), positive(p.size, 'size'), mode);
      if ('reason' in edit) throw new ApiError('invalidParams', edit.reason);
      return { sketch: edit.sketch, result: { createdIds: createdIds(data, edit.sketch) } };
    }
    case 'sketch.project': {
      const frame = ctx.evaluation.sketches.find((s) => s.featureId === ctx.featureId)?.frame;
      if (!frame) throw new ApiError('invalidParams', 'The sketch has no evaluated frame yet');
      let source: SketchProjection['source'];
      const samples = [];
      if (p.edge !== undefined) {
        const ref = resolveEdgeInput(p.edge, ctx.evaluation, 'edge')[0]!;
        const body = ctx.evaluation.bodies.find((b) => b.id === ref.bodyId)!;
        const edge = body.edges.find((e) => e.key === ref.key)!;
        samples.push(edgeSampleFromSegments(edge.curve, edge.segments));
        source = { kind: 'edge', ref };
      } else if (p.face !== undefined) {
        const ref = resolveFaceInput(p.face, ctx.evaluation, ctx.features, 'face', {
          single: true,
        })[0]!;
        const body = ctx.evaluation.bodies.find((b) => b.id === ref.bodyId)!;
        const face = body.faces.find((f) => f.key === ref.key)!;
        for (const index of face.edgeIndices) {
          const edge = body.edges[index];
          if (edge) samples.push(edgeSampleFromSegments(edge.curve, edge.segments));
        }
        source = { kind: 'face', ref };
      } else {
        throw new ApiError('invalidParams', 'Give "edge" or "face"');
      }
      const edit = addProjection(
        data,
        source,
        projectSource(samples, frame),
        p.construction !== false,
      );
      if (!edit)
        throw new ApiError(
          'invalidParams',
          'It projects to a point (parallel to the sketch normal)',
        );
      const projection = edit.sketch.projections![edit.sketch.projections!.length - 1]!;
      return {
        sketch: edit.sketch,
        result: { projectionId: projection.id, entityIds: projection.entities },
      };
    }
    case 'sketch.setReference': {
      const wanted = String(p.dimension);
      const dimension = data.dimensions.find((d) => d.id === wanted || d.name === wanted);
      if (!dimension) throw new ApiError('notFound', `No dimension "${wanted}" in this sketch`);
      const reference = p.reference !== false;
      return {
        sketch: {
          ...data,
          dimensions: data.dimensions.map((d) => {
            if (d.id !== dimension.id) return d;
            const { driven: _driven, expression: _expression, ...rest } = d;
            return reference
              ? { ...rest, driven: true }
              : { ...rest, ...(d.expression ? { expression: d.expression } : {}) };
          }),
        },
        result: { dimensionId: dimension.id, name: dimension.name, reference },
      };
    }
    default:
      throw new ApiError('invalidParams', `Unknown sketch command ${method}`);
  }
}
