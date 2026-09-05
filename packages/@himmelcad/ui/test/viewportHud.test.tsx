import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ViewportHud } from '../src/ViewportHud.js';

void test('HUD tone boundaries, exact numeric formatting, unavailable tier and explicit idle', () => {
  const render = (p95: number | null) =>
    renderToStaticMarkup(
      <ViewportHud
        p95={p95}
        p50={16.4}
        points={41_200_000}
        targetMs={25}
        quality={null}
        budget="gpu"
        backlog={3}
      />,
    );
  assert.match(render(25), /data-tone="normal"/);
  assert.match(render(25.1), /data-tone="warning"/);
  assert.match(render(50), /data-tone="warning"/);
  assert.match(render(50.1), /data-tone="error"/);
  assert.match(render(24.1), /24\.1/);
  assert.match(render(24.1), /41\.2/);
  assert.match(render(null), /Idle — no frames presented/);
});
