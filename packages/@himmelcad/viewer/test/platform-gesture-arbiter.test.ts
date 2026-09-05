import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GestureClaimError,
  PlatformGestureArbiter,
  SHARED_3D_TARGET_DEVIATIONS,
  type EscapeRungRegistrar,
} from '../src/kernel/PlatformGestureArbiter.js';

interface Pick {
  readonly id: string;
  readonly pickable: boolean;
}

void test('G-B2-GESTURE-C1 coordinate tool keeps Tab on its bar and gates candidate cycling', () => {
  const calls: string[] = [];
  const arbiter = new PlatformGestureArbiter<Pick>({
    cycleCandidate: (direction) => calls.push(`idle-cycle:${direction}`),
  });
  arbiter.registerGestureClaims('draw.point', [
    {
      row: 'tab',
      handle: (event) => calls.push(`bar:${event.direction}`),
    },
    {
      row: 'candidateCycle',
      handle: (event) => calls.push(`candidate:${event.direction}`),
    },
  ]);
  assert.equal(arbiter.handleKeyDown(keyEvent('Tab'), null), true);
  assert.deepEqual(calls, ['bar:1']);
  assert.equal(arbiter.handleKeyDown(keyEvent('ArrowDown'), null), false);
  assert.deepEqual(calls, ['bar:1']);

  const removeIndicator = arbiter.setCandidateIndicator(3, 1);
  assert.equal(arbiter.handleKeyDown(keyEvent('ArrowDown'), null), true);
  assert.deepEqual(calls, ['bar:1', 'candidate:1']);
  removeIndicator();
  assert.equal(arbiter.handleKeyDown(keyEvent('ArrowUp'), null), false);
});

void test('UIP-D16 publishes, cycles, and invalidates the live candidate set', () => {
  const calls: string[] = [];
  const candidates = [
    { id: 'point', pickable: true },
    { id: 'line', pickable: true },
    { id: 'hidden', pickable: false },
  ];
  const arbiter = new PlatformGestureArbiter<Pick>({
    candidateSetChanged: (items, index) =>
      calls.push(`set:${items.map((item) => item.id).join(',')}:${index}`),
    candidateSetCleared: () => calls.push('clear'),
    cycleCandidate: (direction) => calls.push(`cycle:${direction}`),
  });

  const dispose = arbiter.setCandidateSet(candidates.slice(0, 2), 1);
  assert.equal(arbiter.handleKeyDown(keyEvent('ArrowDown'), null), true);
  dispose();
  assert.equal(arbiter.handleKeyDown(keyEvent('ArrowDown'), null), false);

  arbiter.setCandidateSet(candidates.slice(0, 2), 2);
  assert.equal(arbiter.handleKeyDown(keyEvent('Escape'), null), false);
  assert.deepEqual(calls, ['set:point,line:0', 'cycle:1', 'clear', 'set:point,line:1', 'clear']);
});

void test('G-B2-GESTURE-C1 Escape cancels the tool rung before selection and clears next', () => {
  const ladder = escapeLadderHarness();
  let selected = true;
  const calls: string[] = [];
  const arbiter = new PlatformGestureArbiter<Pick>(
    {
      hasSelection: () => selected,
      clearSelection: () => {
        selected = false;
        calls.push('selection');
      },
    },
    ladder.register,
  );
  arbiter.registerGestureClaims('draw.point', [
    { row: 'escape', handle: () => calls.push('tool') },
  ]);
  assert.equal(ladder.dispatch(), true);
  assert.deepEqual(calls, ['tool']);
  assert.equal(selected, true);
  assert.equal(ladder.dispatch(), true);
  assert.deepEqual(calls, ['tool', 'selection']);
  assert.equal(selected, false);
});

void test('G-B2-GESTURE-C1 armed LMB void is claimed while idle void is inert', () => {
  const calls: string[] = [];
  const arbiter = new PlatformGestureArbiter<Pick>({
    clearSelection: () => calls.push('clear'),
    select: (pick) => calls.push(`select:${pick.id}`),
    isPickable: (pick) => pick.pickable,
  });
  const release = arbiter.registerGestureClaims('draw.point', [
    { row: 'lmbClick', handle: ({ candidate }) => calls.push(`vertex:${candidate?.id ?? 'void'}`) },
  ]);
  arbiter.handleClick(pointerEvent(0, 10), null);
  assert.deepEqual(calls, ['vertex:void']);

  release();
  arbiter.handleClick(pointerEvent(0, 1_000), null);
  assert.deepEqual(calls, ['vertex:void']);
  arbiter.handleClick(pointerEvent(0, 2_000), { id: 'cloud', pickable: false });
  assert.deepEqual(calls, ['vertex:void']);
  arbiter.handleClick(pointerEvent(0, 3_000), { id: 'wall', pickable: true });
  assert.deepEqual(calls, ['vertex:void', 'select:wall']);
});

void test('gesture registry rejects unreasoned platform ownership and same-state collisions', () => {
  const arbiter = new PlatformGestureArbiter<Pick>();
  assert.throws(
    () =>
      arbiter.registerGestureClaims('bad-camera-tool', [{ row: 'wheel', handle: () => undefined }]),
    (error: unknown) =>
      error instanceof GestureClaimError &&
      error.code === 'platform-owned-requires-deviation' &&
      error.row === 'wheel',
  );
  arbiter.registerGestureClaims('first', [{ row: 'lmbClick', handle: () => undefined }]);
  assert.throws(
    () => arbiter.registerGestureClaims('second', [{ row: 'lmbClick', handle: () => undefined }]),
    (error: unknown) =>
      error instanceof GestureClaimError &&
      error.code === 'gesture-claim-collision' &&
      error.conflictingToolId === 'first',
  );
});

void test('arming another non-colliding tool releases the first with a typed reason', () => {
  const reasons: unknown[] = [];
  const arbiter = new PlatformGestureArbiter<Pick>();
  arbiter.registerGestureClaims('point', [{ row: 'lmbClick', handle: () => undefined }], (reason) =>
    reasons.push(reason),
  );
  arbiter.registerGestureClaims('measure', [{ row: 'mmbClick', handle: () => undefined }]);
  assert.deepEqual(reasons, [{ code: 'superseded', armedByToolId: 'measure' }]);
  assert.equal(arbiter.activeTool(), 'measure');
});

void test('idle mouse and touch gestures preserve the platform selection and context map', () => {
  const calls: string[] = [];
  const selected = new Set<string>();
  const arbiter = new PlatformGestureArbiter<Pick>({
    candidateKey: (pick) => pick.id,
    isPickable: (pick) => pick.pickable,
    isSelected: (pick) => selected.has(pick.id),
    select: (pick) => {
      selected.clear();
      selected.add(pick.id);
      calls.push(`select:${pick.id}`);
    },
    toggleSelection: (pick) => {
      if (selected.has(pick.id)) selected.delete(pick.id);
      else selected.add(pick.id);
      calls.push(`toggle:${pick.id}`);
    },
    clearSelection: () => {
      selected.clear();
      calls.push('clear');
    },
    openContextSurface: (pick) => calls.push(`context:${pick?.id ?? 'void'}`),
  });
  const wall = { id: 'wall', pickable: true };

  arbiter.handleClick(pointerEvent(0, 10), wall);
  arbiter.handleClick({ ...pointerEvent(0, 700), ctrlKey: true } as PointerEvent, wall);
  arbiter.handleClick(pointerEvent(0, 1_500), wall);
  arbiter.handleClick(pointerEvent(0, 1_700), wall); // entity double-click is reserved
  arbiter.handleClick(pointerEvent(0, 2_500), null);
  arbiter.handleClick(pointerEvent(0, 2_700), null); // void double-click clears
  arbiter.handleClick(pointerEvent(2, 3_500), wall);
  assert.deepEqual(calls, ['select:wall', 'toggle:wall', 'select:wall', 'clear', 'context:wall']);

  arbiter.handleClick(touchEvent(4_500), wall);
  arbiter.handleClick(touchEvent(5_200), wall); // touch tap-again deselects
  arbiter.handleClick(touchEvent(6_000), wall, 600); // tap-hold opens context
  assert.deepEqual(calls.slice(-3), ['select:wall', 'toggle:wall', 'context:wall']);
});

void test('typing stays with registry shortcuts unless a tool declares entry focus', () => {
  const calls: string[] = [];
  const arbiter = new PlatformGestureArbiter<Pick>({
    routeRegistryShortcut: (event) => calls.push(`registry:${event.key}`),
  });
  arbiter.handleKeyDown(keyEvent('7'), null);
  const releaseUndeclared = arbiter.registerGestureClaims('undeclared', [
    { row: 'typing', handle: () => calls.push('must-not-own') },
  ]);
  arbiter.handleKeyDown(keyEvent('8'), null);
  releaseUndeclared();
  arbiter.registerGestureClaims('coordinate', [
    { row: 'typing', entryFocus: 'numeric', handle: () => calls.push('numeric') },
  ]);
  arbiter.handleKeyDown(keyEvent('9'), null);
  assert.deepEqual(calls, ['registry:7', 'registry:8', 'numeric']);
});

void test('Shared3DTarget can register its documented handle-drag deviation', () => {
  const arbiter = new PlatformGestureArbiter<Pick>();
  const phases: unknown[] = [];
  assert.doesNotThrow(() =>
    arbiter.registerGestureClaims('Shared3DTarget', [
      {
        row: 'lmbDrag',
        deviationReason: SHARED_3D_TARGET_DEVIATIONS.lmbDrag,
        admit: () => true,
        handle: (event) => phases.push(event.phase),
      },
    ]),
  );
  assert.equal(arbiter.beginContinuousClaim('lmbDrag', pointerEvent(0, 10), null), true);
  arbiter.continueContinuousClaim('lmbDrag', 'move', pointerEvent(0, 20), null);
  arbiter.continueContinuousClaim('lmbDrag', 'end', pointerEvent(0, 30), null);
  assert.deepEqual(phases, ['start', 'move', 'end']);
});

function keyEvent(key: string): KeyboardEvent {
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault() {},
    stopPropagation() {},
  } as KeyboardEvent;
}

function pointerEvent(button: number, timeStamp: number): PointerEvent {
  return {
    button,
    timeStamp,
    pointerType: 'mouse',
    ctrlKey: false,
  } as PointerEvent;
}

function touchEvent(timeStamp: number): PointerEvent {
  return { ...pointerEvent(0, timeStamp), pointerType: 'touch' } as PointerEvent;
}

function escapeLadderHarness(): {
  readonly register: EscapeRungRegistrar;
  readonly dispatch: () => boolean;
} {
  const rungs = new Map<'tool' | 'selection', ((event: KeyboardEvent) => boolean)[]>();
  return {
    register: (kind, handler) => {
      const entries = rungs.get(kind) ?? [];
      entries.push(handler);
      rungs.set(kind, entries);
      return () => {
        const index = entries.indexOf(handler);
        if (index >= 0) entries.splice(index, 1);
      };
    },
    dispatch: () => {
      for (const kind of ['tool', 'selection'] as const) {
        for (const handler of [...(rungs.get(kind) ?? [])].reverse()) {
          if (handler(keyEvent('Escape'))) return true;
        }
      }
      return false;
    },
  };
}
