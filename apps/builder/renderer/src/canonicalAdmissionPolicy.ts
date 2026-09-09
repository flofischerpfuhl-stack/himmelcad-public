import type {
  CanonicalRepresentationAdmission,
  GeometryRepresentationBindingRef,
} from '@himmelcad/viewer/kernel';

/** Supplies the exact viewer slot generation when refreshing a live entity. */
export function withCurrentCanonicalGenerations(
  admissions: readonly CanonicalRepresentationAdmission[],
  bindingsForEntity: (
    entityId: string,
  ) => readonly GeometryRepresentationBindingRef[] | null,
): CanonicalRepresentationAdmission[] {
  return admissions.map((admission) => {
    if (admission.expectedGeneration !== null) return admission;
    const current = bindingsForEntity(admission.entity.id)?.find(
      (binding) => binding.key.slot.representationSlot === admission.representationSlot,
    );
    return current ? { ...admission, expectedGeneration: current.generation } : admission;
  });
}
