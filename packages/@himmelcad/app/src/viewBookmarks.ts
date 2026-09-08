import { parseViewStateV2, type ViewStateV2 } from './view.js';
import { validateViewStateReferences, type CanonicalViewReferent } from './viewStateRuntime.js';

export interface ViewBookmarkV1 {
  readonly schemaId: 'hcad.view-bookmark@1';
  readonly entityId: string;
  readonly revision: number;
  readonly name: string;
  readonly state: ViewBookmarkStateV1;
}

export interface ViewBookmarkStateV1 {
  readonly schemaId: 'hcad.bookmark-view-state@1';
  readonly camera: ViewStateV2['camera'];
  readonly navigationMode: ViewStateV2['navigationMode'];
  readonly hiddenEntityIds: readonly string[];
  readonly clipRefs: ViewStateV2['clipRefs'];
  readonly presentation: Omit<ViewStateV2['presentation'], 'pointSizeMultiplier'>;
}

export interface ViewBookmarkJournal {
  create(name: string, state: ViewBookmarkStateV1): Promise<ViewBookmarkV1>;
  list(): Promise<readonly ViewBookmarkV1[]>;
  read(entityId: string): Promise<ViewBookmarkV1 | null>;
  recordRestore(entityId: string, expectedRevision: number): Promise<void>;
}

/** Canonical bookmark commands; the supplied repository is the document journal boundary. */
export class ViewBookmarkController {
  constructor(
    private readonly journal: ViewBookmarkJournal,
    private readonly resolve: (entityId: string) => CanonicalViewReferent | null,
    private readonly current: () => ViewStateV2,
    private readonly apply: (state: ViewStateV2) => Promise<void>,
  ) {}

  async create(name: string, current: ViewStateV2): Promise<ViewBookmarkV1> {
    if (!name.trim()) throw new TypeError('Bookmark name is required.');
    const validated = parseViewStateV2(current);
    validateViewStateReferences(validated, this.resolve);
    const state = bookmarkCaptureState(validated);
    return await this.journal.create(name.trim(), state);
  }

  async list(): Promise<readonly ViewBookmarkV1[]> {
    return await this.journal.list();
  }

  async restore(entityId: string, expectedRevision?: number): Promise<ViewBookmarkV1> {
    const bookmark = await this.journal.read(entityId);
    if (!bookmark) throw new Error(`Bookmark ${entityId} no longer exists.`);
    if (expectedRevision !== undefined && bookmark.revision !== expectedRevision) {
      throw new Error(`Bookmark ${entityId} is stale.`);
    }
    const live = this.current();
    const state = validateViewStateReferences(
      {
        schema: 'himmelcad.view-state',
        version: 2,
        ...bookmark.state,
        selectedEntityIds: live.selectedEntityIds,
        sessionHiddenEntityIds: live.sessionHiddenEntityIds,
        presentation: {
          ...bookmark.state.presentation,
          pointSizeMultiplier: live.presentation.pointSizeMultiplier,
        },
      },
      this.resolve,
    );
    // The journal effect is accepted before view-local state changes. Failure
    // therefore leaves camera/display untouched and never reports success.
    await this.journal.recordRestore(bookmark.entityId, bookmark.revision);
    await this.apply(state);
    return bookmark;
  }
}

/** VD-D3 exclusions are normalized at the capture boundary. */
export function bookmarkCaptureState(state: ViewStateV2): ViewBookmarkStateV1 {
  const { pointSizeMultiplier: _excluded, ...presentation } = state.presentation;
  return Object.freeze({
    schemaId: 'hcad.bookmark-view-state@1',
    camera: structuredClone(state.camera),
    navigationMode: state.navigationMode,
    hiddenEntityIds: [...state.hiddenEntityIds],
    clipRefs: structuredClone(state.clipRefs),
    presentation,
  });
}
