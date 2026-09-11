export function contextualPointcloudPayload(entityIds: readonly string[]): {
  readonly entityIds: readonly string[];
  readonly sourceEntityId?: string;
} {
  return {
    entityIds,
    ...(entityIds.length === 1 ? { sourceEntityId: entityIds[0] } : {}),
  };
}

export function pointcloudSourceRequirementReason(
  available: boolean | undefined,
): string | undefined {
  return available === false ? 'Select one resident point cloud.' : undefined;
}
