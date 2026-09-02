import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  consumeEscapeBlurCommitSuppression,
  dispatchEscape,
  installEscapeLadder,
  registerEscapeRung,
  revertEscapeField,
  type EscapeRungKind,
} from '../src/escapeLadder.js';

const unregister: Array<() => void> = [];

afterEach(() => {
  while (unregister.length > 0) unregister.pop()?.();
});

test('dispatches rungs in UIP-D14 precedence order', () => {
  const calls: EscapeRungKind[] = [];
  const kinds: EscapeRungKind[] = [
    'selection',
    'functionTab',
    'detachedFunction',
    'modal',
    'tool',
    'menu',
    'drag',
    'fieldRevert',
  ];
  for (const kind of kinds) {
    unregister.push(
      registerEscapeRung(kind, () => {
        calls.push(kind);
        return true;
      }),
    );
  }

  assert.equal(dispatchEscape(escapeEvent()), true);
  assert.deepEqual(calls, ['fieldRevert']);
});

test('one rung acts per press and a yielding rung passes to the next', () => {
  const calls: string[] = [];
  unregister.push(
    registerEscapeRung('drag', () => {
      calls.push('drag-yield');
      return false;
    }),
    registerEscapeRung('menu', () => {
      calls.push('menu-act');
      return true;
    }),
    registerEscapeRung('tool', () => {
      calls.push('tool-must-not-run');
      return true;
    }),
  );

  assert.equal(dispatchEscape(escapeEvent()), true);
  assert.deepEqual(calls, ['drag-yield', 'menu-act']);
});

test('register and unregister control participation', () => {
  let calls = 0;
  const remove = registerEscapeRung('selection', () => {
    calls += 1;
    return true;
  });
  remove();

  assert.equal(dispatchEscape(escapeEvent()), false);
  assert.equal(calls, 0);
});

test('installEscapeLadder installs exactly one listener per target', () => {
  let additions = 0;
  let removals = 0;
  const target = {
    addEventListener(type: string) {
      if (type === 'keydown') additions += 1;
    },
    removeEventListener(type: string) {
      if (type === 'keydown') removals += 1;
    },
  } as unknown as Window;

  const removeFirst = installEscapeLadder(target);
  const removeSecond = installEscapeLadder(target);
  assert.equal(additions, 1);
  removeFirst();
  assert.equal(removals, 0);
  removeSecond();
  assert.equal(removals, 1);
});

test('the latest registration is topmost unless explicit order overrides it', () => {
  const calls: string[] = [];
  unregister.push(
    registerEscapeRung(
      'modal',
      () => {
        calls.push('ordered');
        return true;
      },
      { order: 2 },
    ),
    registerEscapeRung('modal', () => {
      calls.push('latest');
      return true;
    }),
  );

  dispatchEscape(escapeEvent());
  assert.deepEqual(calls, ['ordered']);
});

test('free-text Escape is consumed without invoking a rung or changing content', () => {
  let calls = 0;
  const target = {
    value: 'unfinished prompt',
    closest: (selector: string) => (selector.includes('[data-escape-free-text]') ? target : null),
  };
  unregister.push(
    registerEscapeRung('fieldRevert', () => {
      calls += 1;
      return true;
    }),
  );
  const event = escapeEvent(target as unknown as EventTarget);

  assert.equal(dispatchEscape(event), true);
  assert.equal(target.value, 'unfinished prompt');
  assert.equal(calls, 0);
  assert.equal(event.defaultPrevented, true);
});

test('field revert suppresses exactly the resulting blur commit', () => {
  const field = { value: 'dirty' } as HTMLInputElement;
  revertEscapeField(field, 'committed');

  assert.equal(field.value, 'committed');
  assert.equal(consumeEscapeBlurCommitSuppression(field), true);
  assert.equal(consumeEscapeBlurCommitSuppression(field), false);
});

function escapeEvent(target: EventTarget | null = null): KeyboardEvent & {
  defaultPrevented: boolean;
} {
  let prevented = false;
  return {
    key: 'Escape',
    target,
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
    stopImmediatePropagation() {},
  } as KeyboardEvent & { defaultPrevented: boolean };
}
