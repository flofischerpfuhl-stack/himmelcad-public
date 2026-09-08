import { DEFAULT_SELECTABLE_KINDS, type SelectionGranularity } from './selection.js';
import type { ViewDisplayStateV1 } from './viewDisplay.js';

export type InteractionState = 'hidden' | 'reference' | 'editable' | 'inert';
export type InteractionCapability = 'render' | 'select' | 'snap' | 'edit' | 'measure';

export interface InteractionNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: string;
  readonly capabilities?: ReadonlySet<InteractionCapability>;
}

export interface EffectiveInteractionState {
  readonly requested: InteractionState;
  readonly effective: InteractionState;
  readonly causes: readonly string[];
  readonly renderable: boolean;
  readonly selectable: boolean;
  readonly snappable: boolean;
  readonly editable: boolean;
  readonly measurable: boolean;
}

export type InteractionTreePresentation = InteractionState | 'mixed';

const RESTRICTIVENESS: Readonly<Record<InteractionState, number>> = {
  editable: 0,
  reference: 1,
  inert: 2,
  hidden: 3,
};

const DEFAULT_CAPABILITIES = new Set<InteractionCapability>([
  'render',
  'select',
  'snap',
  'edit',
  'measure',
]);

/**
 * P9's sole view-local requested/effective-state resolver.
 *
 * Parent writes may deliberately propagate through the subtree. Global defaults
 * are a separate ceiling and therefore never rewrite an explicit node choice.
 */
export class InteractionStateStore {
  private readonly nodes = new Map<string, InteractionNode>();
  private readonly children = new Map<string | null, string[]>();
  private readonly requested = new Map<string, InteractionState>();
  private globalDefault: InteractionState;
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  constructor(nodes: Iterable<InteractionNode>, globalDefault: InteractionState = 'editable') {
    this.globalDefault = assertInteractionState(globalDefault);
    this.replaceNodes(nodes);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getRevision(): number {
    return this.revision;
  }

  replaceNodes(nodes: Iterable<InteractionNode>): void {
    const next = new Map<string, InteractionNode>();
    const children = new Map<string | null, string[]>();
    for (const node of nodes) {
      if (!node.id.trim()) throw new TypeError('interaction node id is required');
      if (next.has(node.id)) throw new RangeError(`duplicate interaction node: ${node.id}`);
      next.set(node.id, node);
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node.id);
      children.set(node.parentId, siblings);
    }
    for (const node of next.values()) {
      if (node.parentId !== null && !next.has(node.parentId)) {
        throw new RangeError(`interaction parent does not exist: ${node.parentId}`);
      }
      assertNoOwnerCycle(node.id, next);
    }
    this.nodes.clear();
    this.children.clear();
    for (const [id, node] of next) this.nodes.set(id, node);
    for (const [id, ids] of children) this.children.set(id, ids);
    for (const id of this.requested.keys()) if (!this.nodes.has(id)) this.requested.delete(id);
    this.changed();
  }

  requestedState(id: string): InteractionState {
    this.requireNode(id);
    return this.requested.get(id) ?? this.globalDefault;
  }

  setGlobalDefault(state: InteractionState): void {
    const next = assertInteractionState(state);
    if (next === this.globalDefault) return;
    this.globalDefault = next;
    this.changed();
  }

  /** The global value changes only fallback behavior; explicit choices survive. */
  getGlobalDefault(): InteractionState {
    return this.globalDefault;
  }

  /**
   * Read-only S-08 display-stream bridge. Persistence and undo remain owned by
   * ViewDisplayStore; this resolver only derives P9 hierarchy eligibility.
   */
  applyViewDisplayState(state: Pick<ViewDisplayStateV1, 'globalDefault' | 'overrides'>): void {
    const nextGlobal = assertInteractionState(state.globalDefault);
    const nextRequested = new Map<string, InteractionState>();
    for (const [id, value] of Object.entries(state.overrides)) {
      if (!this.nodes.has(id)) continue;
      nextRequested.set(id, assertInteractionState(value));
    }
    if (
      nextGlobal === this.globalDefault &&
      sameInteractionOverrides(this.requested, nextRequested)
    ) {
      return;
    }
    this.globalDefault = nextGlobal;
    this.requested.clear();
    for (const [id, value] of nextRequested) this.requested.set(id, value);
    this.changed();
  }

  requestedOverrides(): Readonly<Record<string, InteractionState>> {
    return Object.freeze(Object.fromEntries(this.requested));
  }

  setRequested(
    ids: Iterable<string>,
    state: InteractionState,
    scope: 'node' | 'subtree' = 'subtree',
  ): readonly string[] {
    const next = assertInteractionState(state);
    const targets = new Set<string>();
    for (const id of ids) {
      this.requireNode(id);
      targets.add(id);
      if (scope === 'subtree') for (const child of this.descendants(id)) targets.add(child);
    }
    let mutated = false;
    for (const id of targets) {
      if (this.requested.get(id) === next) continue;
      this.requested.set(id, next);
      mutated = true;
    }
    if (mutated) this.changed();
    return [...targets];
  }

  clearRequested(id: string): void {
    this.requireNode(id);
    if (this.requested.delete(id)) this.changed();
  }

  presentation(id: string): InteractionTreePresentation {
    this.requireNode(id);
    const states = [id, ...this.descendants(id)].map((nodeId) => this.requestedState(nodeId));
    return states.every((state) => state === states[0]) ? states[0]! : 'mixed';
  }

  effective(id: string): EffectiveInteractionState {
    const node = this.requireNode(id);
    let effective = this.requestedState(id);
    const causes = [`${id}: ${effective}`];
    let parentId = node.parentId;
    while (parentId !== null) {
      const parentState = this.requestedState(parentId);
      if (RESTRICTIVENESS[parentState] > RESTRICTIVENESS[effective]) {
        effective = parentState;
      }
      causes.push(`${parentId}: ${parentState}`);
      parentId = this.requireNode(parentId).parentId;
    }
    const capabilities = node.capabilities ?? DEFAULT_CAPABILITIES;
    const renderable = effective !== 'hidden' && capabilities.has('render');
    const interactive = effective === 'reference' || effective === 'editable';
    return Object.freeze({
      requested: this.requestedState(id),
      effective,
      causes: Object.freeze(causes),
      renderable,
      selectable: renderable && interactive && capabilities.has('select'),
      snappable: renderable && interactive && capabilities.has('snap'),
      editable: renderable && effective === 'editable' && capabilities.has('edit'),
      measurable: renderable && interactive && capabilities.has('measure'),
    });
  }

  visibleSet(): ReadonlySet<string> {
    return new Set([...this.nodes.keys()].filter((id) => this.effective(id).renderable));
  }

  pickableSet(kindFilter?: ReadonlySet<string>): ReadonlySet<string> {
    return new Set(
      [...this.nodes.values()]
        .filter(
          (node) =>
            (!kindFilter || kindFilter.has(node.kind)) && this.effective(node.id).selectable,
        )
        .map((node) => node.id),
    );
  }

  snappableSet(): ReadonlySet<string> {
    return new Set([...this.nodes.keys()].filter((id) => this.effective(id).snappable));
  }

  private descendants(id: string): string[] {
    const result: string[] = [];
    const pending = [...(this.children.get(id) ?? [])];
    while (pending.length) {
      const current = pending.shift()!;
      result.push(current);
      pending.unshift(...(this.children.get(current) ?? []));
    }
    return result;
  }

  private requireNode(id: string): InteractionNode {
    const node = this.nodes.get(id);
    if (!node) throw new RangeError(`unknown interaction node: ${id}`);
    return node;
  }

  private changed(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

export type DisplayViewMode = '3d' | '2.5d' | '2d';

export interface ViewportBottomBarState {
  readonly supportGeometry: boolean;
  readonly granularity: SelectionGranularity;
  readonly viewMode: DisplayViewMode;
  readonly selectableKinds: Readonly<Record<string, boolean>>;
  readonly labels: boolean;
}

export const DEFAULT_VIEWPORT_BOTTOM_BAR_STATE: ViewportBottomBarState = Object.freeze({
  supportGeometry: false,
  granularity: 'whole',
  viewMode: '3d',
  selectableKinds: DEFAULT_SELECTABLE_KINDS,
  labels: true,
});

function assertInteractionState(state: string): InteractionState {
  if (state !== 'hidden' && state !== 'reference' && state !== 'editable' && state !== 'inert') {
    throw new TypeError(`invalid interaction state: ${state}`);
  }
  return state;
}

function assertNoOwnerCycle(id: string, nodes: ReadonlyMap<string, InteractionNode>): void {
  const seen = new Set<string>([id]);
  let parent = nodes.get(id)?.parentId ?? null;
  while (parent !== null) {
    if (seen.has(parent)) throw new RangeError(`interaction node owner cycle at ${id}`);
    seen.add(parent);
    parent = nodes.get(parent)?.parentId ?? null;
  }
}

function sameInteractionOverrides(
  left: ReadonlyMap<string, InteractionState>,
  right: ReadonlyMap<string, InteractionState>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, state] of left) if (right.get(id) !== state) return false;
  return true;
}
