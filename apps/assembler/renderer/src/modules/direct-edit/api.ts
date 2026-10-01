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
};

export const DIRECT_EDIT_API: ApiContribution = {
  featureKinds: [{ order: API_ORDER.featureKinds.directEdit, kinds: KIND_SCHEMAS }],
};
