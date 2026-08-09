/**
 * Structural-sharing pattern adapted from T3 Code
 * MessagesTimeline.logic.ts at v0.0.24. HimmelCAD row types and equality are local.
 */
export interface StableRowsState<Row extends { id: string }> {
  byId: ReadonlyMap<string, Row>;
  result: readonly Row[];
}

export function structurallyShareRows<Row extends { id: string }>(
  rows: readonly Row[],
  previous: StableRowsState<Row>,
  unchanged: (left: Row, right: Row) => boolean,
): StableRowsState<Row> {
  const byId = new Map<string, Row>();
  let changed = rows.length !== previous.result.length;
  const result = rows.map((row, index) => {
    const prior = previous.byId.get(row.id);
    const stable = prior && unchanged(prior, row) ? prior : row;
    byId.set(row.id, stable);
    if (!changed && previous.result[index] !== stable) changed = true;
    return stable;
  });
  return changed ? { byId, result } : previous;
}
