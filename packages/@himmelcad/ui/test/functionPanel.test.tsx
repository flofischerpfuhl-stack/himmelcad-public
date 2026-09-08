import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FunctionPanel,
  functionTabVisibility,
  nextFunctionPanelTabStop,
} from '../src/FunctionPanel.js';

test('FunctionPanel keeps three 96 px tabs visible at 320 px and overflows rightmost tabs', () => {
  assert.deepEqual(functionTabVisibility(['first', 'second'], 'second', 294), {
    visibleFunctionIds: ['first', 'second'],
    hiddenFunctionIds: [],
  });
  assert.deepEqual(functionTabVisibility(['first', 'second', 'third', 'active'], 'active', 294), {
    visibleFunctionIds: ['active'],
    hiddenFunctionIds: ['first', 'second', 'third'],
  });
});

test('FunctionPanel pulls an activated tab out of overflow and never overflows Properties', () => {
  const result = functionTabVisibility(['first', 'second', 'third'], 'third', 392);
  assert.deepEqual(result.visibleFunctionIds, ['first', 'third']);
  assert.deepEqual(result.hiddenFunctionIds, ['second']);

  const html = renderToStaticMarkup(
    <FunctionPanel
      activeFunctionId="third"
      functionIds={['first', 'second', 'third']}
      closeFunctionTabs
      activeTab="function"
    />,
  );
  assert.match(html, /role="tablist"[^>]*>[\s\S]*Properties/);
  assert.match(html, /title="Properties"/);
  assert.match(html, /title="Third"/);
  assert.match(html, /aria-selected="true"[^>]*tabindex="0"[^>]*title="Third"/);
});

test('FunctionPanel roving order reaches overflow after the last visible tab', () => {
  const stopCount = 3; // Properties, active function, overflow button.
  assert.equal(nextFunctionPanelTabStop(1, stopCount, 'ArrowRight'), 2);
  assert.equal(nextFunctionPanelTabStop(2, stopCount, 'ArrowRight'), 0);
  assert.equal(nextFunctionPanelTabStop(0, stopCount, 'ArrowLeft'), 2);
  assert.equal(nextFunctionPanelTabStop(1, stopCount, 'End'), 2);
  assert.equal(nextFunctionPanelTabStop(2, stopCount, 'Home'), 0);
});
