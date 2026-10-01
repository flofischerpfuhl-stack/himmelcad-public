/**
 * Agent-API contract of the direct-edit module: the `feature.create`
 * parameter schemas of Offset Face and Delete Face (the stored fields).
 */
import {
  schemaObject,
  schemaRef,
  type FeatureKindSpec,
} from '../../foundation/commands/api/contract.js';
import { API_ORDER, type ApiContribution } from '../../foundation/commands/api/registry.js';
import { OFFSET_FACE_MODES } from './kinds.js';

const KIND_SCHEMAS: Record<string, FeatureKindSpec> = {
  offsetFace: {
    label: 'Offset Face',
    summary:
      'Offsets faces of one body along their normals: positive adds material, negative removes it (e.g. enlarges a hole). With one face, `mode` "radius"/"diameter" sets a cylindrical face to that size and "total" sets its distance to the parallel `opposite` face; `distance` is then that target value, re-measured on every evaluation.',
    params: schemaObject(
      {
        faces: { type: 'array', items: schemaRef('FaceInput'), minItems: 1 },
        distance: {
          type: 'number',
          description:
            'mode "offset": signed offset (mm); "radius"/"diameter"/"total": the positive target value (mm).',
        },
        mode: { enum: [...OFFSET_FACE_MODES], default: 'offset' },
        opposite: schemaRef('FaceInput'),
      },
      ['faces', 'distance'],
    ),
  },
  deleteFace: {
    label: 'Delete Face',
    summary: 'Removes faces (holes, fillets, chamfers) of one body and heals it.',
    params: schemaObject({ faces: { type: 'array', items: schemaRef('FaceInput'), minItems: 1 } }, [
      'faces',
    ]),
  },
  moveEdge: {
    label: 'Move Edge',
    summary:
      'Moves a straight edge between two planar faces by `vector` (world, mm): each face tilts about its far side (the boundary farthest from the edge) so that it passes through the moved edge; the part of the vector along the edge changes nothing. Curved faces/edges and moves past the far side of a face are refused.',
    params: schemaObject({ edge: schemaRef('EdgeInput'), vector: schemaRef('Vec3') }, [
      'edge',
      'vector',
    ]),
  },
  moveFace: {
    label: 'Move Face',
    summary:
      'Moves a planar face by `vector` (world, mm) in any direction: the part along its normal offsets it (like Offset Face), the part in its plane slides it — every planar neighbour sharing a straight edge tilts about its far side to follow. A face with a curved edge can only move along its normal. `rotation` then turns the face about a line in its plane (the neighbours follow).',
    params: schemaObject(
      {
        face: schemaRef('FaceInput'),
        vector: schemaRef('Vec3'),
        rotation: {
          type: 'object',
          properties: {
            point: schemaRef('Vec3'),
            axis: schemaRef('Vec3'),
            angle: {
              type: 'number',
              minimum: -80,
              maximum: 80,
              description: 'Degrees, right-hand about `axis`.',
            },
          },
          required: ['point', 'axis', 'angle'],
          additionalProperties: false,
          description:
            'Turns the face about the line through `point` (moved with the face) along `axis` (projected into the face plane).',
        },
      },
      ['face', 'vector'],
    ),
  },
};

export const DIRECT_EDIT_API: ApiContribution = {
  featureKinds: [{ order: API_ORDER.featureKinds.directEdit, kinds: KIND_SCHEMAS }],
};
