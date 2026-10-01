/**
 * Specs of the sketching module's agent-API methods (`hcasm.agent-api@1`):
 * `sketches.list` (block `API_ORDER.methods.sketchesList`, after the core
 * reads) and the `sketch.*` edits (block `API_ORDER.methods.sketchEdits`,
 * after the core feature commands) — the published order. The sketch data
 * definitions (`SketchShape`, `SketchEntity`, …) stay core: the `sketch`
 * feature kind (sketch-solver) uses them.
 */
import {
  schemaNumber,
  schemaObject,
  schemaPositive,
  schemaRef,
  schemaRevision,
  schemaScope,
  schemaString,
  type MethodSpec,
} from '../../foundation/commands/api/contract.js';

const obj = schemaObject;
const ref = schemaRef;
const str = schemaString;
const num = schemaNumber;
const positive = schemaPositive;
const revision = schemaRevision;
const scope = schemaScope;

export const SKETCHES_LIST_METHODS: Record<string, MethodSpec> = {
  'sketches.list': {
    kind: 'query',
    capability: 'document.read',
    summary:
      'Sketches with frame, entities, constraints, dimensions and their detected profiles (regions with stable keys, the boundary entity ids and world-space centres).',
    params: obj({ scope }),
    result:
      '[{featureId, name, plane, frame: {origin,u,v,normal}, entities, constraints, dimensions, patterns: [{id, kind, sources, count, count2?, lines?, center?, angle?, created}], regions: [{key, area, sample, center, holes, entityIds}], consumed}]',
  },
};

/** In the order of the published contract. */
export const SKETCH_EDIT_METHODS: Record<string, MethodSpec> = {
  'sketch.addProfile': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds a fully dimensioned rectangle or circle (entities + constraints + dimensions) to a sketch and re-solves it.',
    params: obj({ featureId: str, profile: ref('SketchShape'), expectedRevision: revision }, [
      'featureId',
      'profile',
    ]),
    result:
      '{featureId, shape: {kind, entityIds, dimensions: {role: name}}, dof, regions, revision, committed, errors}',
  },
  'sketch.addPolyline': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds connected lines through `points` (closed: back to the first point). Axis-aligned segments get horizontal/vertical constraints unless autoConstrain is false; construction lines never bound a profile (use one as a revolve axis).',
    params: obj(
      {
        featureId: str,
        points: { type: 'array', items: ref('Vec2'), minItems: 2 },
        closed: { type: 'boolean', default: false },
        construction: { type: 'boolean', default: false },
        autoConstrain: { type: 'boolean', default: true },
        expectedRevision: revision,
      },
      ['featureId', 'points'],
    ),
    result: '{featureId, pointIds, lineIds, dof, regions, revision, committed, errors}',
  },
  'sketch.addArc': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary: 'Adds a counter-clockwise arc from `start` to `end` around `center`.',
    params: obj(
      {
        featureId: str,
        center: ref('Vec2'),
        start: ref('Vec2'),
        end: ref('Vec2'),
        construction: { type: 'boolean', default: false },
        expectedRevision: revision,
      },
      ['featureId', 'center', 'start', 'end'],
    ),
    result: '{featureId, entityIds: [center, start, end, arc], dof, regions, revision, committed}',
  },
  'sketch.addConstraint': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds a geometric constraint (see $defs.SketchConstraint for the refs per kind) and re-solves; a conflicting or redundant constraint fails with sketchConflict.',
    params: obj(
      {
        featureId: str,
        kind: ref('SketchConstraintKind'),
        refs: { type: 'array', items: str, minItems: 1 },
        expectedRevision: revision,
      },
      ['featureId', 'kind', 'refs'],
    ),
    result: '{featureId, constraintId, dof, regions, revision, committed}',
  },
  'sketch.addDimension': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds a driving dimension (value in mm / degrees, or an expression over other dimension names) and re-solves the sketch to it.',
    params: {
      ...obj(
        {
          featureId: str,
          kind: ref('SketchDimensionKind'),
          refs: { type: 'array', items: str, minItems: 1 },
          value: { type: 'number', minimum: 0 },
          expression: str,
          name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
          expectedRevision: revision,
        },
        ['featureId', 'kind', 'refs'],
      ),
      anyOf: [{ required: ['value'] }, { required: ['expression'] }],
    },
    result: '{featureId, dimensionId, name, value, dof, regions, revision, committed}',
  },
  'sketch.setDimension': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Changes a dimension (by id or name, e.g. "d3") to a value or expression; the sketch re-solves and dependent features re-evaluate (the History-panel dimension edit).',
    params: {
      ...obj(
        {
          featureId: str,
          dimension: str,
          value: { type: 'number', minimum: 0 },
          expression: str,
          expectedRevision: revision,
        },
        ['featureId', 'dimension'],
      ),
      anyOf: [{ required: ['value'] }, { required: ['expression'] }],
    },
    result: '{featureId, dimensionId, name, value, dof, regions, revision, committed, errors}',
  },
  'sketch.deleteItems': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Deletes entities, constraints or dimensions by id (curves take their unused points, constraints/dimensions on deleted geometry go with them).',
    params: obj(
      {
        featureId: str,
        ids: { type: 'array', items: str, minItems: 1 },
        expectedRevision: revision,
      },
      ['featureId', 'ids'],
    ),
    result: '{featureId, dof, regions, revision, committed, errors}',
  },
  'sketch.addSpline': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds a spline: `fit` (default) passes through `points` with end tangent handles (constrain tangency with sketch.addConstraint "tangent" to a line/arc/spline sharing its end point); `control` uses `points` as control polygon. `closed` ends on the first point.',
    params: obj(
      {
        featureId: str,
        points: { type: 'array', items: ref('Vec2'), minItems: 2 },
        mode: { enum: ['fit', 'control'], default: 'fit' },
        closed: { type: 'boolean', default: false },
        construction: { type: 'boolean', default: false },
        expectedRevision: revision,
      },
      ['featureId', 'points'],
    ),
    result: '{featureId, entityId, pointIds, handleIds, dof, regions, revision, committed}',
  },
  'sketch.addEllipse': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds an ellipse (or, with `arc: [startDeg, endDeg]` parametric angles, an elliptical arc) at `center` with the major axis along `angle` degrees. `dimension: true` adds the two axis radii as dimensions.',
    params: obj(
      {
        featureId: str,
        center: ref('Vec2'),
        majorRadius: positive,
        minorRadius: positive,
        angle: num,
        arc: ref('Vec2'),
        dimension: { type: 'boolean', default: false },
        construction: { type: 'boolean', default: false },
        expectedRevision: revision,
      },
      ['featureId', 'center', 'majorRadius', 'minorRadius'],
    ),
    result: '{featureId, entityId, entityIds, dof, regions, revision, committed}',
  },
  'sketch.addSlot': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds a slot of `width` between the centres `start` and `end` (dimensioned centre distance and width unless `dimension: false`); with `arcCenter` an arc slot along the circle through `start` (counter-clockwise to the angle of `end`, `clockwise: true` the other way).',
    params: obj(
      {
        featureId: str,
        start: ref('Vec2'),
        end: ref('Vec2'),
        width: positive,
        arcCenter: ref('Vec2'),
        clockwise: { type: 'boolean', default: false },
        dimension: { type: 'boolean', default: true },
        construction: { type: 'boolean', default: false },
        expectedRevision: revision,
      },
      ['featureId', 'start', 'end', 'width'],
    ),
    result: '{featureId, curveIds, entityIds, dof, regions, revision, committed}',
  },
  'sketch.addPolygon': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds a regular polygon on a construction circle of `radius`: inscribed (vertices on the circle, default) or circumscribed (`inscribed: false`, edges tangent to it); `angle` turns the first vertex / edge midpoint.',
    params: obj(
      {
        featureId: str,
        center: ref('Vec2'),
        radius: positive,
        sides: { type: 'integer', minimum: 3, maximum: 64, default: 6 },
        inscribed: { type: 'boolean', default: true },
        angle: num,
        construction: { type: 'boolean', default: false },
        expectedRevision: revision,
      },
      ['featureId', 'center', 'radius'],
    ),
    result: '{featureId, lineIds, centerId, circleId, dof, regions, revision, committed}',
  },
  'sketch.addText': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Adds text (font Inter, SIL OFL 1.1) with its baseline starting at `position`: `height` is the cap height (mm), `angle` degrees. Every glyph becomes a closed profile (counters stay open) for extrude/emboss.',
    params: obj(
      {
        featureId: str,
        text: str,
        position: ref('Vec2'),
        height: positive,
        angle: num,
        font: { enum: ['inter'], default: 'inter' },
        construction: { type: 'boolean', default: false },
        expectedRevision: revision,
      },
      ['featureId', 'text', 'position', 'height'],
    ),
    result: '{featureId, entityId, anchorId, missingCharacters, dof, regions, revision, committed}',
  },
  'sketch.mirror': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Mirrors curves/points `ids` about the line `axis`; the copies are tied to the originals by symmetric constraints (they follow later edits).',
    params: obj(
      {
        featureId: str,
        ids: { type: 'array', items: str, minItems: 1 },
        axis: str,
        expectedRevision: revision,
      },
      ['featureId', 'ids', 'axis'],
    ),
    result: '{featureId, createdIds, dof, regions, revision, committed}',
  },
  'sketch.pattern': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Repeats curves/points `ids`: linear (`direction`, `spacing` — a spacing dimension drives every copy; with `count2`, `direction2`, `spacing2` a grid in two directions) or circular (`center`, `angle` total degrees, 360 = full turn); `count` includes the original. The pattern is recorded (`patternId`) so count/count2/angle stay editable (sketch.editPattern).',
    params: obj(
      {
        featureId: str,
        ids: { type: 'array', items: str, minItems: 1 },
        mode: { enum: ['linear', 'circular'], default: 'linear' },
        count: { type: 'integer', minimum: 2, maximum: 200 },
        direction: ref('Vec2'),
        spacing: positive,
        count2: { type: 'integer', minimum: 2, maximum: 200 },
        direction2: ref('Vec2'),
        spacing2: positive,
        center: ref('Vec2'),
        centerPointId: str,
        angle: num,
        expectedRevision: revision,
      },
      ['featureId', 'ids', 'count'],
    ),
    result: '{featureId, patternId, createdIds, dof, regions, revision, committed}',
  },
  'sketch.editPattern': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Changes a recorded sketch pattern (sketches.list → patterns): `count`, `count2` (two-direction linear patterns) or `angle` (circular, total degrees). The copies are rebuilt from the sources; spacing dimensions, direction lines and the centre stay.',
    params: obj(
      {
        featureId: str,
        patternId: str,
        count: { type: 'integer', minimum: 2, maximum: 200 },
        count2: { type: 'integer', minimum: 2, maximum: 200 },
        angle: num,
        expectedRevision: revision,
      },
      ['featureId', 'patternId'],
    ),
    result: '{featureId, patternId, pattern, dof, regions, revision, committed}',
  },
  'sketch.offset': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Offsets each curve of `ids` with its chain (connected curves; `single: true` only the curve) by `distance`: closed loops to the `outside` (default) or `inside`, open chains to the `left`/`right` of the curve direction. Lines and arcs offset exactly; ellipses, elliptical arcs and splines become fit splines through their true offset. New, unconstrained geometry.',
    params: obj(
      {
        featureId: str,
        ids: { type: 'array', items: str, minItems: 1 },
        distance: positive,
        side: { enum: ['outside', 'inside', 'left', 'right'], default: 'outside' },
        single: { type: 'boolean', default: false },
        expectedRevision: revision,
      },
      ['featureId', 'ids', 'distance'],
    ),
    result: '{featureId, createdIds, dof, regions, revision, committed}',
  },
  'sketch.roundCorner': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Fillets (radius `size`) or chamfers (set-back `size`) the corner at point `point` between two lines; the corner point stays as a virtual sharp so dimensions to it survive.',
    params: obj(
      {
        featureId: str,
        point: str,
        size: positive,
        mode: { enum: ['fillet', 'chamfer'], default: 'fillet' },
        expectedRevision: revision,
      },
      ['featureId', 'point', 'size'],
    ),
    result: '{featureId, createdIds, dof, regions, revision, committed}',
  },
  'sketch.project': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Projects a body `edge` or the boundary of a `face` into the sketch along its normal (construction unless `construction: false`). Associative: the projected geometry follows the source on re-evaluation; a lost source keeps it frozen with a warning.',
    params: obj(
      {
        featureId: str,
        edge: ref('EdgeInput'),
        face: ref('FaceInput'),
        construction: { type: 'boolean', default: true },
        expectedRevision: revision,
      },
      ['featureId'],
    ),
    result: '{featureId, projectionId, entityIds, dof, regions, revision, committed}',
  },
  'sketch.setReference': {
    kind: 'command',
    capability: 'document.write',
    transactional: true,
    summary:
      'Makes a dimension (by id or name) a reference (driven) dimension that only measures, or driving again with `reference: false`.',
    params: obj(
      {
        featureId: str,
        dimension: str,
        reference: { type: 'boolean', default: true },
        expectedRevision: revision,
      },
      ['featureId', 'dimension'],
    ),
    result: '{featureId, dimensionId, name, reference, dof, regions, revision, committed}',
  },
};
