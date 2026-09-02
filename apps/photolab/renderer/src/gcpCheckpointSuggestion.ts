export interface CheckpointSuggestionPoint {
  readonly id: string;
  readonly coordinate: {
    readonly eastMeters: number;
    readonly northMeters: number;
    readonly heightMeters: number;
  };
}

/** Returns a deterministic, spatially distributed sample of point ids. */
export function spatialCheckpointIds(points: readonly CheckpointSuggestionPoint[]): string[] {
  if (points.length < 4) return [];

  const target = Math.max(1, Math.min(10, Math.round(points.length * 0.2)));
  const sorted = [...points].sort(
    (left, right) =>
      left.coordinate.eastMeters - right.coordinate.eastMeters ||
      left.coordinate.northMeters - right.coordinate.northMeters ||
      left.coordinate.heightMeters - right.coordinate.heightMeters ||
      left.id.localeCompare(right.id),
  );
  if (target === 1) return [sorted[Math.floor(sorted.length / 2)]?.id ?? ''].filter(Boolean);
  return Array.from(
    { length: target },
    (_, index) => sorted[Math.round((index * (sorted.length - 1)) / (target - 1))]?.id,
  ).filter((id): id is string => id != null);
}
