/**
 * Locating a check's result in the viewport (click a failed check): its
 * faces/edges or bodies become the selection and the camera frames them;
 * the result's spots (closest points, overlap centre) are drawn while the
 * check is focused (`overlay.ts`).
 */
import type { CheckResult } from '../../foundation/commands/checks.js';
import { useAssemblerStore, type SelectionItem } from '../../foundation/commands/store.js';
import { sendCamera } from '../../platform/viewport/cameraChannel.js';
import { useCheckResults } from './checksStore.js';

/** Selection items of a result's locations that exist in the current evaluation. */
export function locationSelection(result: CheckResult): SelectionItem[] {
  const bodies = new Set(useAssemblerStore.getState().evaluation.bodies.map((b) => b.id));
  const items: SelectionItem[] = [];
  for (const location of result.outcome?.locations ?? []) {
    const parts: SelectionItem[] = [
      ...(location.faces ?? []).map(
        (f): SelectionItem => ({ kind: 'face', bodyId: f.bodyId, faceKey: f.faceKey }),
      ),
      ...(location.edges ?? []).map(
        (e): SelectionItem => ({ kind: 'edge', bodyId: e.bodyId, edgeKey: e.edgeKey }),
      ),
    ];
    if (parts.length === 0) {
      parts.push(...location.bodyIds.map((bodyId): SelectionItem => ({ kind: 'body', bodyId })));
    }
    for (const item of parts) {
      if ('bodyId' in item && !bodies.has(item.bodyId)) continue;
      items.push(item);
    }
  }
  return items;
}

/** Focuses a check: selects and frames where its result points (toggle off with `null`). */
export function focusCheck(result: CheckResult | null): void {
  if (!result) {
    useCheckResults.setState({ focusedId: null });
    return;
  }
  useCheckResults.setState({ focusedId: result.id });
  const items = locationSelection(result);
  if (items.length === 0) return;
  useAssemblerStore.getState().setSelection(items);
  sendCamera({ kind: 'fitSelection' });
}
