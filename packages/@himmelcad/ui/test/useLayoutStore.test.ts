import assert from 'node:assert/strict';
import test from 'node:test';

import { useLayoutStore } from '../src/useLayoutStore.js';

void test('named functions remain independently open and can be revisited', () => {
  useLayoutStore.setState({ activeFunctionId: null, openFunctionIds: [] });
  const actions = useLayoutStore.getState();

  actions.activateFunction('view.point-size');
  actions.activateFunction('view.performance');
  assert.deepEqual(useLayoutStore.getState().openFunctionIds, [
    'view.point-size',
    'view.performance',
  ]);
  assert.equal(useLayoutStore.getState().activeFunctionId, 'view.performance');

  useLayoutStore.getState().activateFunction('view.point-size');
  assert.deepEqual(useLayoutStore.getState().openFunctionIds, [
    'view.point-size',
    'view.performance',
  ]);
  assert.equal(useLayoutStore.getState().activeFunctionId, 'view.point-size');
});

void test('reselecting the active function closes only that tab', () => {
  useLayoutStore.setState({
    activeFunctionId: 'view.performance',
    openFunctionIds: ['view.point-size', 'view.performance'],
  });

  useLayoutStore.getState().activateFunction('view.performance');
  assert.deepEqual(useLayoutStore.getState().openFunctionIds, ['view.point-size']);
  assert.equal(useLayoutStore.getState().activeFunctionId, 'view.point-size');

  useLayoutStore.getState().closeFunction('view.point-size');
  assert.deepEqual(useLayoutStore.getState().openFunctionIds, []);
  assert.equal(useLayoutStore.getState().activeFunctionId, null);
});
