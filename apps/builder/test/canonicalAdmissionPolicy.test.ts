import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  CanonicalRepresentationAdmission,
  GeometryRepresentationBindingRef,
} from '@himmelcad/viewer/kernel';

import { withCurrentCanonicalGenerations } from '../renderer/src/canonicalAdmissionPolicy.js';

test('a live draw entity refresh uses the current viewer generation', () => {
  const admission = {
    entity: { id: 'draw-boundary-1' },
    representationSlot: 'primary',
    expectedGeneration: null,
  } as CanonicalRepresentationAdmission;
  const binding = {
    key: { slot: { entityId: 'draw-boundary-1', representationSlot: 'primary' } },
    generation: 7,
  } as GeometryRepresentationBindingRef;

  assert.equal(
    withCurrentCanonicalGenerations([admission], () => [binding])[0]!.expectedGeneration,
    7,
  );
  assert.equal(withCurrentCanonicalGenerations([admission], () => null)[0], admission);
});
