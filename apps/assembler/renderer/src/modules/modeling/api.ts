/**
 * Agent-API contract of the modelling module: the `feature.create`
 * parameter schemas of its kinds (params are the stored fields, like every
 * kind) and the print features' `$defs` (`printSchema.ts`), in the blocks
 * and order of the published `hcasm.agent-api@1` schema.
 */
import {
  schemaNumber,
  schemaObject,
  schemaRef,
  schemaString,
  type FeatureKindSpec,
} from '../../foundation/commands/api/contract.js';
import { API_ORDER, type ApiContribution } from '../../foundation/commands/api/registry.js';
import type { JsonSchema } from '../../foundation/commands/api/validate.js';
import { PRINT_DEFS, PRINT_FEATURE_KIND_SCHEMAS } from './printSchema.js';

const operation: JsonSchema = {
  enum: ['new', 'join', 'cut', 'intersect'],
  default: 'new',
  description:
    'New body, or join into / cut from / intersect with `targetBodyId` (default: the most recently changed body).',
};

/** Revolve, Sweep, Loft, Mirror (before the construction kinds). */
const PROFILE_KIND_SCHEMAS: Record<string, FeatureKindSpec> = {
  revolve: {
    label: 'Revolve',
    summary:
      'Revolves a profile about an axis (world axis, body edge or sketch line — e.g. a construction centre line); New/Join/Cut like Extrude. The axis must not cross the profile.',
    params: schemaObject(
      {
        profile: schemaRef('ExtrudeProfile'),
        axis: schemaRef('AxisRef'),
        angle: {
          type: 'number',
          minimum: -360,
          maximum: 360,
          default: 360,
          description: 'Degrees; 360 is a full revolution, negative turns the other way.',
        },
        operation,
        targetBodyId: schemaString,
        resultBodyName: schemaString,
      },
      ['profile', 'axis'],
    ),
  },
  sweep: {
    label: 'Sweep',
    summary:
      'Sweeps a profile (without holes) along a path (edge chain, sketch region outline or straight line); New/Join/Cut.',
    params: schemaObject(
      {
        profile: schemaRef('ExtrudeProfile'),
        path: schemaRef('PathRef'),
        operation,
        targetBodyId: schemaString,
        resultBodyName: schemaString,
      },
      ['profile', 'path'],
    ),
  },
  loft: {
    label: 'Loft',
    summary:
      'Lofts through two or more single profiles on different planes, in order; smooth or ruled; New/Join/Cut.',
    params: schemaObject(
      {
        profiles: { type: 'array', items: schemaRef('ExtrudeProfile'), minItems: 2 },
        ruled: { type: 'boolean', default: false },
        operation,
        targetBodyId: schemaString,
        resultBodyName: schemaString,
      },
      ['profiles'],
    ),
  },
  mirror: {
    label: 'Mirror',
    summary:
      'Mirrors bodies, sketches and planar faces across a plane (world plane, planar face, construction plane) or, with `axis`, about a line (a half turn); with keepOriginal (default) the mirror images of bodies are new bodies. Mirrored sketches/faces become sketches "<featureId>:sketch:<i>" (sketchIds first, then faces) whose profiles extrude/revolve reference.',
    params: schemaObject(
      {
        bodyIds: { type: 'array', items: schemaString },
        plane: schemaRef('SketchPlane'),
        keepOriginal: { type: 'boolean', default: true },
        sketchIds: { type: 'array', items: schemaString },
        faces: { type: 'array', items: schemaRef('FaceInput') },
        axis: schemaRef('AxisRef'),
      },
      [],
      'At least one of bodyIds / sketchIds / faces must be non-empty. `plane` defaults to the YZ plane (and is ignored with `axis`).',
    ),
  },
};

/** Pattern, Split, Move/Rotate, Rotate, Align (after the construction kinds). */
const BODY_KIND_SCHEMAS: Record<string, FeatureKindSpec> = {
  pattern: {
    label: 'Pattern',
    summary: 'Copies bodies in a linear or circular pattern (independent copies).',
    params: schemaObject(
      {
        bodyIds: { type: 'array', items: schemaString, minItems: 1 },
        pattern: schemaRef('PatternDefinition'),
      },
      ['bodyIds', 'pattern'],
    ),
  },
  split: {
    label: 'Split',
    summary: 'Splits a body by a plane into two bodies (the positive side becomes new).',
    params: schemaObject({ bodyId: schemaString, plane: schemaRef('SketchPlane') }, [
      'bodyId',
      'plane',
    ]),
  },
  transform: {
    label: 'Move/Rotate',
    summary:
      'Rigid transform of a body: rotate rx, ry, rz degrees about world X, then Y, then Z through `pivot`, then translate (dx, dy, dz); `copy` makes a new body.',
    params: schemaObject(
      {
        bodyId: schemaString,
        dx: schemaNumber,
        dy: schemaNumber,
        dz: schemaNumber,
        rx: schemaNumber,
        ry: schemaNumber,
        rz: schemaNumber,
        pivot: schemaRef('Vec3'),
        copy: { type: 'boolean', default: false },
      },
      ['bodyId'],
      'Missing components default to 0, the pivot to the world origin.',
    ),
  },
  rotateAxis: {
    label: 'Rotate',
    summary:
      'Rotates bodies by `angle` degrees about an axis (a straight or circular edge, a sketch line or a world axis) — "Rotate Around Axis"; `copy` keeps the originals and adds rotated copies.',
    params: schemaObject(
      {
        bodyIds: { type: 'array', items: schemaString, minItems: 1 },
        axis: schemaRef('AxisRef'),
        angle: schemaNumber,
        copy: { type: 'boolean', default: false },
      },
      ['bodyIds', 'axis', 'angle'],
    ),
  },
  align: {
    label: 'Align',
    summary:
      'Moves a body so its planar `face` lies on the plane of `target` (a planar face of another body): face to face by default, same direction with flip; `offset` leaves a gap; `center` slides the face centres together.',
    params: schemaObject(
      {
        bodyId: schemaString,
        face: schemaRef('FaceInput'),
        target: schemaRef('FaceInput'),
        flip: { type: 'boolean', default: false },
        center: { type: 'boolean', default: true },
        offset: { type: 'number', default: 0 },
      },
      ['face', 'target'],
    ),
  },
};

export const MODELING_API: ApiContribution = {
  defs: [{ order: API_ORDER.defs.printFeatures, defs: PRINT_DEFS }],
  featureKinds: [
    { order: API_ORDER.featureKinds.modeling, kinds: PROFILE_KIND_SCHEMAS },
    { order: API_ORDER.featureKinds.modelingTail, kinds: BODY_KIND_SCHEMAS },
    { order: API_ORDER.featureKinds.printFeatures, kinds: PRINT_FEATURE_KIND_SCHEMAS },
  ],
};
