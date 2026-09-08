import { ViewLocalHistory, type ViewHistoryPersistence } from './viewHistory.js';
import type { ViewStateV2 } from './view.js';

export type ViewInteractionState = 'hidden' | 'reference' | 'editable' | 'inert';

export interface ViewDisplayStateV1 {
  readonly schemaId: 'hcad.view-display-state@1';
  readonly schemaVersion: 1;
  readonly globalDefault: ViewInteractionState;
  readonly overrides: Readonly<Record<string, ViewInteractionState>>;
  readonly supportOverlay: boolean;
  readonly labels: boolean;
  readonly activeClipEntityIds: readonly string[];
  readonly presentation: ViewStateV2['presentation'];
}

export interface ViewDisplaySnapshot {
  readonly projectId: string | null;
  readonly state: ViewDisplayStateV1;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

const BASELINE: ViewDisplayStateV1 = Object.freeze({
  schemaId: 'hcad.view-display-state@1',
  schemaVersion: 1,
  globalDefault: 'editable',
  overrides: Object.freeze({}),
  supportOverlay: false,
  labels: true,
  activeClipEntityIds: Object.freeze([]),
  presentation: Object.freeze({
    background: 'black',
    renderStyle: 'source',
    showGrid: false,
    showAxes: false,
    showSelectionOutline: true,
    colorModeOverride: Object.freeze({ kind: 'follow' }),
    pointSizeMultiplier: 1,
  }),
});

/**
 * P9 upper display layer. It deliberately has no document client: global
 * defaults and per-node overrides can never mutate canonical entities.
 */
export class ViewDisplayStore {
  private projectId: string | null = null;
  private history: ViewLocalHistory<ViewDisplayStateV1> | null = null;
  private state: ViewDisplayStateV1 = BASELINE;
  private snapshot: ViewDisplaySnapshot = {
    projectId: null,
    state: BASELINE,
    canUndo: false,
    canRedo: false,
  };
  private openToken = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly persistence: ViewHistoryPersistence,
    private readonly report: (message: string) => void = () => undefined,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // React's useSyncExternalStore requires Object.is-stable snapshots between
  // notifications. Rebuild this object only in changed().
  readonly getSnapshot = (): ViewDisplaySnapshot => this.snapshot;

  async openProject(projectId: string, baseline: ViewDisplayStateV1 = BASELINE): Promise<void> {
    if (!projectId.trim()) throw new TypeError('display projectId is required');
    const token = ++this.openToken;
    if (this.history) await this.history.flushPersistence();
    this.history = null;
    this.projectId = null;
    this.state = BASELINE;
    this.projectId = projectId;
    const history = new ViewLocalHistory(
      projectId,
      'display',
      baseline,
      parseViewDisplayState,
      this.persistence,
      this.report,
    );
    await history.open();
    if (token !== this.openToken) return;
    this.history = history;
    this.state = history.current;
    this.changed();
  }

  async closeProject(): Promise<void> {
    this.openToken += 1;
    if (this.history) await this.history.flushPersistence();
    this.history = null;
    this.projectId = null;
    this.state = BASELINE;
    this.changed();
  }

  effective(entityId: string): ViewInteractionState {
    return this.state.overrides[entityId] ?? this.state.globalDefault;
  }

  setGlobalDefault(value: ViewInteractionState): boolean {
    return this.commit({ ...this.state, globalDefault: parseInteractionState(value) });
  }

  setOverride(entityId: string, value: ViewInteractionState | null): boolean {
    if (!entityId.trim()) throw new TypeError('display entityId is required');
    const overrides = { ...this.state.overrides };
    if (value === null) delete overrides[entityId];
    else overrides[entityId] = parseInteractionState(value);
    return this.commit({ ...this.state, overrides });
  }

  setSupportOverlay(value: boolean): boolean {
    return this.commit({ ...this.state, supportOverlay: value });
  }

  setLabels(value: boolean): boolean {
    return this.commit({ ...this.state, labels: value });
  }

  setPresentation(value: ViewStateV2['presentation']): boolean {
    return this.commit({ ...this.state, presentation: value });
  }

  setActiveClipEntityIds(value: readonly string[]): boolean {
    return this.commit({ ...this.state, activeClipEntityIds: value });
  }

  /** Apply one complete upper-layer state as one P8 display-history entry. */
  replaceState(value: ViewDisplayStateV1): boolean {
    return this.commit(value);
  }

  undo(): boolean {
    if (!this.history?.canUndo) return false;
    this.state = this.history.undo();
    this.changed();
    return true;
  }

  redo(): boolean {
    if (!this.history?.canRedo) return false;
    this.state = this.history.redo();
    this.changed();
    return true;
  }

  clear(): void {
    this.requireHistory().clear();
    this.changed();
  }

  async flushPersistence(): Promise<void> {
    await this.history?.flushPersistence();
  }

  private commit(value: ViewDisplayStateV1): boolean {
    const history = this.requireHistory();
    const next = parseViewDisplayState(value);
    if (!history.commit(next)) return false;
    this.state = history.current;
    this.changed();
    return true;
  }

  private requireHistory(): ViewLocalHistory<ViewDisplayStateV1> {
    if (!this.history) throw new Error('display store has no open project');
    return this.history;
  }

  private changed(): void {
    this.snapshot = {
      projectId: this.projectId,
      state: this.state,
      canUndo: this.history?.canUndo ?? false,
      canRedo: this.history?.canRedo ?? false,
    };
    for (const listener of this.listeners) listener();
  }
}

export function parseViewDisplayState(input: unknown): ViewDisplayStateV1 {
  const value = input as Partial<ViewDisplayStateV1> | null;
  if (
    !value ||
    value.schemaId !== 'hcad.view-display-state@1' ||
    value.schemaVersion !== 1 ||
    typeof value.supportOverlay !== 'boolean' ||
    typeof value.labels !== 'boolean' ||
    !value.overrides ||
    typeof value.overrides !== 'object' ||
    Array.isArray(value.overrides)
  ) {
    throw new TypeError('invalid view display state');
  }
  parseInteractionState(value.globalDefault);
  for (const [id, state] of Object.entries(value.overrides)) {
    if (!id.trim()) throw new TypeError('display override id is empty');
    parseInteractionState(state);
  }
  const presentation = parsePresentation(value.presentation ?? BASELINE.presentation);
  const activeClipEntityIds = value.activeClipEntityIds ?? BASELINE.activeClipEntityIds;
  if (!Array.isArray(activeClipEntityIds) || activeClipEntityIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new TypeError('invalid active clip entity ids');
  }
  return structuredClone({
    ...value,
    activeClipEntityIds: [...new Set(activeClipEntityIds)],
    presentation,
  }) as ViewDisplayStateV1;
}

function parsePresentation(input: unknown): ViewStateV2['presentation'] {
  const value = input as Partial<ViewStateV2['presentation']> | null;
  if (
    !value ||
    !['theme', 'black', 'white'].includes(value.background as string) ||
    !['source', 'monochrome', 'xray'].includes(value.renderStyle as string) ||
    typeof value.showGrid !== 'boolean' ||
    typeof value.showAxes !== 'boolean' ||
    typeof value.showSelectionOutline !== 'boolean' ||
    !value.colorModeOverride ||
    !['follow', 'mode'].includes(value.colorModeOverride.kind) ||
    typeof value.pointSizeMultiplier !== 'number' ||
    !Number.isFinite(value.pointSizeMultiplier) ||
    value.pointSizeMultiplier <= 0
  ) {
    throw new TypeError('invalid view presentation');
  }
  return structuredClone(value) as ViewStateV2['presentation'];
}

function parseInteractionState(value: unknown): ViewInteractionState {
  if (!['hidden', 'reference', 'editable', 'inert'].includes(value as string)) {
    throw new TypeError('invalid view interaction state');
  }
  return value as ViewInteractionState;
}
