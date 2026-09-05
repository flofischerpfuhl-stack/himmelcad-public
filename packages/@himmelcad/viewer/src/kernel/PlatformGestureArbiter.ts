/**
 * Shared X6 gesture-recognition tunables.
 *
 * Four pixels absorbs normal press/release hand jitter without stealing a real
 * orbit or pan. Browsers do not expose the operating-system double-click
 * interval, so 500 ms is the conservative desktop/touch interval used by the
 * one recognizer instead of allowing each tool to invent its own timing.
 */
export const PLATFORM_GESTURE_TUNABLES = Object.freeze({
  clickDragThresholdPx: 4,
  doubleClickIntervalMs: 500,
  touchHoldIntervalMs: 500,
});

export type PlatformGestureRow =
  | 'lmbClick'
  | 'lmbDoubleClickEntity'
  | 'lmbDoubleClickVoid'
  | 'lmbDrag'
  | 'ctrlLmbClick'
  | 'rmbClick'
  | 'rmbDrag'
  | 'mmbClick'
  | 'mmbDrag'
  | 'wheel'
  | 'tab'
  | 'candidateCycle'
  | 'escape'
  | 'typing';

export type GestureToolReleaseReason =
  | { readonly code: 'released' }
  | { readonly code: 'superseded'; readonly armedByToolId: string };

export interface PlatformGestureEvent<Candidate> {
  readonly row: PlatformGestureRow;
  readonly candidate: Candidate | null;
  readonly originalEvent: Event;
  readonly direction?: 1 | -1;
  readonly phase?: 'start' | 'move' | 'end' | 'cancel';
}

export interface PlatformGestureClaim<Candidate> {
  readonly row: PlatformGestureRow;
  readonly handle: (event: PlatformGestureEvent<Candidate>) => void;
  readonly deviationReason?: string;
  /** Required for a typing claim; names the C1 entry surface that owns focus. */
  readonly entryFocus?: 'numeric' | 'text';
  /** Optional pointer-hit admission for a reasoned drag deviation. */
  readonly admit?: (event: PlatformGestureEvent<Candidate>) => boolean;
}

export interface PlatformGestureCallbacks<Candidate> {
  readonly candidateKey?: (candidate: Candidate) => string;
  readonly isPickable?: (candidate: Candidate) => boolean;
  readonly isSelected?: (candidate: Candidate) => boolean;
  readonly hasSelection?: () => boolean;
  readonly select?: (candidate: Candidate) => void;
  readonly toggleSelection?: (candidate: Candidate) => void;
  readonly clearSelection?: () => void;
  readonly openContextSurface?: (candidate: Candidate | null) => void;
  readonly cycleCandidate?: (direction: 1 | -1) => void;
  readonly candidateSetChanged?: (candidates: readonly Candidate[], index: number) => void;
  readonly candidateSetCleared?: () => void;
  readonly routeRegistryShortcut?: (event: KeyboardEvent) => void;
}

export type EscapeRungRegistrar = (
  kind: 'tool' | 'selection',
  handler: (event: KeyboardEvent) => boolean,
) => () => void;

export type GestureClaimErrorCode =
  | 'platform-owned-requires-deviation'
  | 'gesture-claim-collision'
  | 'unknown-tool';

export class GestureClaimError extends Error {
  constructor(
    readonly code: GestureClaimErrorCode,
    readonly row: PlatformGestureRow,
    readonly toolId: string,
    readonly conflictingToolId?: string,
  ) {
    super(
      code === 'platform-owned-requires-deviation'
        ? `${toolId} cannot claim platform-owned gesture ${row} without a deviation reason`
        : code === 'gesture-claim-collision'
          ? `${toolId} cannot claim ${row}; it is already claimed by ${conflictingToolId ?? 'another tool'}`
          : `Unknown gesture tool ${toolId}`,
    );
    this.name = 'GestureClaimError';
  }
}

const PLATFORM_OWNED_ROWS = new Set<PlatformGestureRow>([
  'lmbDrag',
  'rmbClick',
  'rmbDrag',
  'mmbDrag',
  'wheel',
]);

const REASON_REQUIRED_ROWS = new Set<PlatformGestureRow>(['lmbDoubleClickVoid']);

/** The sole platform-approved navigation deviation, from ui-platform §9.5. */
export const SHARED_3D_TARGET_DEVIATIONS = Object.freeze({
  lmbDrag: 'Handle-origin drag translates or rotates Shared3DTarget; off-handle drag navigates.',
});

interface RegisteredTool<Candidate> {
  readonly claims: ReadonlyMap<PlatformGestureRow, PlatformGestureClaim<Candidate>>;
  readonly onReleased?: (reason: GestureToolReleaseReason) => void;
}

interface CandidateIndicator {
  count: number;
  index: number;
  token: number;
}

export class PlatformGestureArbiter<Candidate> {
  private readonly tools = new Map<string, RegisteredTool<Candidate>>();
  private readonly claimedRows = new Map<PlatformGestureRow, string>();
  private armedToolId: string | null = null;
  private removeToolEscapeRung: (() => void) | null = null;
  private readonly removeSelectionEscapeRung: (() => void) | null;
  private candidateIndicator: CandidateIndicator | null = null;
  private indicatorToken = 0;
  private lastActivation: { pointerType: string; timeStamp: number; candidateKey: unknown } | null =
    null;

  constructor(
    private readonly callbacks: PlatformGestureCallbacks<Candidate> = {},
    private readonly registerEscapeRung?: EscapeRungRegistrar,
  ) {
    this.removeSelectionEscapeRung =
      registerEscapeRung?.('selection', () => {
        if (!this.callbacks.hasSelection?.()) return false;
        this.clearCandidateIndicator();
        this.callbacks.clearSelection?.();
        return true;
      }) ?? null;
  }

  registerGestureClaims(
    toolId: string,
    claims: readonly PlatformGestureClaim<Candidate>[],
    onReleased?: (reason: GestureToolReleaseReason) => void,
  ): () => void {
    const rows = new Map<PlatformGestureRow, PlatformGestureClaim<Candidate>>();
    for (const claim of claims) {
      if (
        (PLATFORM_OWNED_ROWS.has(claim.row) || REASON_REQUIRED_ROWS.has(claim.row)) &&
        !claim.deviationReason?.trim()
      ) {
        throw new GestureClaimError('platform-owned-requires-deviation', claim.row, toolId);
      }
      const conflict = this.claimedRows.get(claim.row);
      if (conflict && conflict !== toolId) {
        throw new GestureClaimError('gesture-claim-collision', claim.row, toolId, conflict);
      }
      if (rows.has(claim.row)) {
        throw new GestureClaimError('gesture-claim-collision', claim.row, toolId, toolId);
      }
      rows.set(claim.row, claim);
    }
    if (this.tools.has(toolId)) this.releaseTool(toolId, { code: 'released' });
    const registered: RegisteredTool<Candidate> = {
      claims: rows,
      ...(onReleased ? { onReleased } : {}),
    };
    this.tools.set(toolId, registered);
    for (const row of rows.keys()) this.claimedRows.set(row, toolId);
    this.armTool(toolId);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.releaseTool(toolId, { code: 'released' });
    };
  }

  armTool(toolId: string): void {
    const next = this.tools.get(toolId);
    if (!next) throw new GestureClaimError('unknown-tool', 'escape', toolId);
    if (this.armedToolId === toolId) return;
    const previous = this.armedToolId;
    if (previous) this.releaseTool(previous, { code: 'superseded', armedByToolId: toolId });
    this.armedToolId = toolId;
    const escape = next.claims.get('escape');
    if (escape && this.registerEscapeRung) {
      this.removeToolEscapeRung = this.registerEscapeRung('tool', (event) => {
        if (this.armedToolId !== toolId) return false;
        try {
          escape.handle({ row: 'escape', candidate: null, originalEvent: event });
        } finally {
          this.releaseTool(toolId, { code: 'released' });
        }
        return true;
      });
    }
  }

  disarmTool(toolId: string, reason: GestureToolReleaseReason = { code: 'released' }): void {
    if (this.armedToolId !== toolId) return;
    this.removeToolEscapeRung?.();
    this.removeToolEscapeRung = null;
    this.armedToolId = null;
    this.clearCandidateIndicator();
    this.tools.get(toolId)?.onReleased?.(reason);
  }

  activeTool(): string | null {
    return this.armedToolId;
  }

  setCandidateIndicator(count: number, index: number): () => void {
    if (
      !Number.isInteger(count) ||
      count < 2 ||
      !Number.isInteger(index) ||
      index < 1 ||
      index > count
    ) {
      throw new RangeError(
        'A candidate indicator requires count >= 2 and a one-based index in range',
      );
    }
    const token = ++this.indicatorToken;
    this.candidateIndicator = { count, index, token };
    return () => {
      if (this.candidateIndicator?.token === token) this.clearCandidateIndicator();
    };
  }

  /** Publishes the same stable-order candidate set represented by the indicator. */
  setCandidateSet(candidates: readonly Candidate[], index: number): () => void {
    if (candidates.length < 2) {
      this.clearCandidateIndicator();
      return () => undefined;
    }
    this.callbacks.candidateSetChanged?.(candidates, index - 1);
    return this.setCandidateIndicator(candidates.length, index);
  }

  clearCandidateIndicator(): void {
    if (this.candidateIndicator) this.callbacks.candidateSetCleared?.();
    this.candidateIndicator = null;
  }

  handleKeyDown(event: KeyboardEvent, candidate: Candidate | null): boolean {
    if (event.key === 'Escape') {
      this.clearCandidateIndicator();
      return false;
    }
    const tool = this.armedTool();
    if (event.key === 'Tab') {
      const claim = tool?.claims.get('tab');
      if (!claim) return false;
      consume(event);
      claim.handle({
        row: 'tab',
        candidate,
        originalEvent: event,
        direction: event.shiftKey ? -1 : 1,
      });
      return true;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (!this.candidateIndicator) return false;
      const indicator = this.candidateIndicator;
      const direction: 1 | -1 = event.key === 'ArrowUp' ? -1 : 1;
      consume(event);
      const claim = tool?.claims.get('candidateCycle');
      if (claim) {
        claim.handle({ row: 'candidateCycle', candidate, originalEvent: event, direction });
      } else {
        this.callbacks.cycleCandidate?.(direction);
      }
      if (this.candidateIndicator?.token === indicator.token) {
        indicator.index =
          ((indicator.index - 1 + direction + indicator.count) % indicator.count) + 1;
      }
      return true;
    }
    if (isPrintable(event)) {
      const claim = tool?.claims.get('typing');
      if (claim?.entryFocus) {
        consume(event);
        claim.handle({ row: 'typing', candidate, originalEvent: event });
        return true;
      }
      this.callbacks.routeRegistryShortcut?.(event);
    }
    return false;
  }

  beginContinuousClaim(
    row: 'lmbDrag' | 'rmbDrag' | 'mmbDrag' | 'wheel',
    originalEvent: Event,
    candidate: Candidate | null,
  ): boolean {
    const claim = this.armedTool()?.claims.get(row);
    if (!claim) return false;
    const event: PlatformGestureEvent<Candidate> = {
      row,
      candidate,
      originalEvent,
      phase: 'start',
    };
    if (claim.admit && !claim.admit(event)) return false;
    claim.handle(event);
    return true;
  }

  continueContinuousClaim(
    row: 'lmbDrag' | 'rmbDrag' | 'mmbDrag' | 'wheel',
    phase: 'move' | 'end' | 'cancel',
    originalEvent: Event,
    candidate: Candidate | null,
  ): void {
    this.armedTool()?.claims.get(row)?.handle({ row, candidate, originalEvent, phase });
  }

  handleClick(event: PointerEvent, candidate: Candidate | null, heldMilliseconds = 0): void {
    const pointerType = event.pointerType || 'mouse';
    if (
      pointerType === 'touch' &&
      heldMilliseconds >= PLATFORM_GESTURE_TUNABLES.touchHoldIntervalMs
    ) {
      this.dispatchClaimOrIdle('rmbClick', candidate, event, () =>
        this.callbacks.openContextSurface?.(candidate),
      );
      this.lastActivation = null;
      return;
    }
    if (event.button === 2) {
      this.lastActivation = null;
      this.dispatchClaimOrIdle('rmbClick', candidate, event, () =>
        this.callbacks.openContextSurface?.(candidate),
      );
      return;
    }
    if (event.button === 1) {
      this.lastActivation = null;
      this.dispatchClaimOrIdle('mmbClick', candidate, event, () => undefined);
      return;
    }
    if (event.button !== 0) return;
    const isDouble =
      this.lastActivation?.pointerType === pointerType &&
      event.timeStamp - this.lastActivation.timeStamp <=
        PLATFORM_GESTURE_TUNABLES.doubleClickIntervalMs &&
      this.lastActivation.candidateKey === this.keyFor(candidate);
    this.lastActivation = {
      pointerType,
      timeStamp: event.timeStamp,
      candidateKey: this.keyFor(candidate),
    };

    if (pointerType === 'touch' && isDouble) {
      this.clearCandidateIndicator();
      this.callbacks.clearSelection?.();
      this.lastActivation = null;
      return;
    }
    if (isDouble) {
      const row =
        candidate && this.isPickable(candidate) ? 'lmbDoubleClickEntity' : 'lmbDoubleClickVoid';
      this.dispatchClaimOrIdle(row, candidate, event, () => {
        if (!candidate || !this.isPickable(candidate)) {
          this.clearCandidateIndicator();
          this.callbacks.clearSelection?.();
        }
      });
      this.lastActivation = null;
      return;
    }
    if (event.ctrlKey) {
      this.dispatchClaimOrIdle('ctrlLmbClick', candidate, event, () => {
        if (candidate && this.isPickable(candidate)) this.callbacks.toggleSelection?.(candidate);
      });
      return;
    }
    this.dispatchClaimOrIdle('lmbClick', candidate, event, () => {
      if (!candidate || !this.isPickable(candidate)) return;
      if (pointerType === 'touch' && this.callbacks.isSelected?.(candidate)) {
        this.callbacks.toggleSelection?.(candidate);
      } else {
        this.callbacks.select?.(candidate);
      }
    });
  }

  dispose(): void {
    this.removeToolEscapeRung?.();
    this.removeSelectionEscapeRung?.();
    this.removeToolEscapeRung = null;
    this.armedToolId = null;
    this.tools.clear();
    this.claimedRows.clear();
    this.clearCandidateIndicator();
  }

  private armedTool(): RegisteredTool<Candidate> | undefined {
    return this.armedToolId ? this.tools.get(this.armedToolId) : undefined;
  }

  private releaseTool(toolId: string, reason: GestureToolReleaseReason): void {
    const tool = this.tools.get(toolId);
    if (!tool) return;
    try {
      this.disarmTool(toolId, reason);
    } finally {
      for (const row of tool.claims.keys()) {
        if (this.claimedRows.get(row) === toolId) this.claimedRows.delete(row);
      }
      this.tools.delete(toolId);
    }
  }

  private dispatchClaimOrIdle(
    row: PlatformGestureRow,
    candidate: Candidate | null,
    event: Event,
    idle: () => void,
  ): void {
    const claim = this.armedTool()?.claims.get(row);
    if (claim) {
      claim.handle({ row, candidate, originalEvent: event });
      return;
    }
    idle();
  }

  private isPickable(candidate: Candidate): boolean {
    return this.callbacks.isPickable?.(candidate) ?? true;
  }

  private keyFor(candidate: Candidate | null): unknown {
    if (candidate === null) return null;
    return this.callbacks.candidateKey?.(candidate) ?? candidate;
  }
}

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function isPrintable(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}
