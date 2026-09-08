import { parseViewStateV2, type ViewClipRefV2, type ViewStateV2 } from './view.js';

export interface CanonicalViewReferent {
  readonly entityId: string;
  readonly revision: number;
  readonly kind: 'viewing-box' | 'section' | 'entity';
}

export class StaleViewReferenceError extends Error {
  constructor(
    readonly entityId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number | null,
  ) {
    super(
      actualRevision === null
        ? `View reference ${entityId} no longer exists.`
        : `View reference ${entityId} is stale (expected revision ${expectedRevision}, current revision ${actualRevision}).`,
    );
    this.name = 'StaleViewReferenceError';
  }
}

/** Validates the complete reference set before any state producer is invoked. */
export function validateViewStateReferences(
  input: unknown,
  resolve: (entityId: string) => CanonicalViewReferent | null,
): ViewStateV2 {
  const state = parseViewStateV2(input);
  for (const ref of state.clipRefs) validateClipRef(ref, resolve(ref.entityId));
  return state;
}

/** Fail-closed apply boundary used by automation and bookmark restore. */
export async function applyViewStateAtomically<T>(
  input: unknown,
  resolve: (entityId: string) => CanonicalViewReferent | null,
  apply: (validated: ViewStateV2) => Promise<T> | T,
): Promise<T> {
  const state = validateViewStateReferences(input, resolve);
  return await apply(state);
}

function validateClipRef(ref: ViewClipRefV2, resolved: CanonicalViewReferent | null): void {
  if (!resolved) throw new StaleViewReferenceError(ref.entityId, ref.expectedRevision, null);
  if (resolved.kind !== 'viewing-box' && resolved.kind !== 'section') {
    throw new TypeError(`View clip reference ${ref.entityId} is not a section or viewing box.`);
  }
  if (resolved.revision !== ref.expectedRevision) {
    throw new StaleViewReferenceError(ref.entityId, ref.expectedRevision, resolved.revision);
  }
}
