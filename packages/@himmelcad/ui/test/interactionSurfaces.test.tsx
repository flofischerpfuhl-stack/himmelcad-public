import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ConstructionBar,
  InteractionStateCheckbox,
  SelectionVisuals,
  ViewportBottomBar,
} from '../src/index.js';

const noop = (): void => undefined;

void test('G-B2-P9-TREE four-state checkbox exposes state text and mixed semantics', () => {
  for (const state of ['hidden', 'reference', 'editable', 'inert', 'mixed'] as const) {
    const html = renderToStaticMarkup(
      <InteractionStateCheckbox label="Road edge" state={state} onStateChange={noop} />,
    );
    assert.match(html, new RegExp(`data-interaction-state="${state}"`));
    if (state === 'mixed') assert.match(html, /aria-checked="mixed"/);
    if (state === 'reference') assert.match(html, />R</);
    if (state === 'inert') assert.match(html, />I</);
  }
});

void test('bottom bar exposes toggles, mode radios, and selectable-kinds access', () => {
  const html = renderToStaticMarkup(
    <ViewportBottomBar
      state={{
        supportGeometry: true,
        granularity: 'whole',
        viewMode: '3d',
        selectableKinds: { points: true, lines: true },
        labels: true,
      }}
      onSupportGeometryChange={noop}
      onExplodePolylinesChange={noop}
      onViewModeChange={noop}
      onSelectableKindChange={noop}
      onLabelsChange={noop}
    />,
  );
  assert.match(html, /aria-label="Support points and lines" aria-pressed="true"/);
  assert.match(html, /aria-label="Explode polylines" aria-pressed="false"/);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, />Kinds <span aria-hidden="true">▾/);
  assert.match(html, /aria-label="Labels" aria-pressed="true"/);
});

void test('G-B2-INPUT construction bar declares fields, polar values and live candidate indicator', () => {
  const html = renderToStaticMarkup(
    <ConstructionBar
      prompt="Line — pick or type endpoint"
      fields={[
        { id: 'direction', label: 'Dir °', unit: '°', value: 30 },
        { id: 'distance', label: 'Dist m', unit: 'm', value: 12.5 },
        { id: 'deltaZ', label: 'Δz m', unit: 'm', value: 2.25 },
      ]}
      activeField="distance"
      candidateIndex={0}
      candidateCount={3}
    />,
  );
  assert.match(html, /data-construction-input="armed"/);
  assert.match(html, /Dir 30\.000° · Dist 12\.500 m · Δz 2\.250 m/);
  assert.match(html, />1 of 3</);
  assert.match(html, /data-active="true"/);
});

void test('G-B2-SELECTION-VISUAL fixture carries direction, square, anchor-only, and toggle-bound support cues', () => {
  const shown = renderToStaticMarkup(<SelectionVisuals supportVisible directionArrowSize={12} />);
  assert.match(shown, /data-direction-arrow-size="12"/);
  assert.match(shown, /data-support-geometry="visible"/);
  assert.match(shown, /Symbol point with anchor-only selection/);
  assert.match(shown, /data-hover-pickable-only="true"/);
  const hidden = renderToStaticMarkup(<SelectionVisuals supportVisible={false} />);
  assert.doesNotMatch(hidden, /data-support-geometry/);
});
