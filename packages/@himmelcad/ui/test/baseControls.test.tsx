import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { Button } from '../src/Button.js';
import { Dialog } from '../src/Dialog.js';
import { DurabilityIndicator } from '../src/DurabilityIndicator.js';
import {
  Menu,
  MenuItem,
  getSubmenuPosition,
  moveMenuFocus,
  submenuKeyboardAction,
} from '../src/Menu.js';
import { NumberInput, parseDraft } from '../src/NumberInput.js';
import { ProgressBar } from '../src/ProgressBar.js';
import { Slider } from '../src/Slider.js';
import { Spinner, SpinnerVisual, spinnerDelay } from '../src/Spinner.js';
import { Toast, ToastRegion } from '../src/Toast.js';
import { Tooltip } from '../src/Tooltip.js';
import { nextLinearIndex, sliderValueForKey } from '../src/controlInteractions.js';

test('Menu exposes menu roles and vertical roving-key behavior', () => {
  const html = renderToStaticMarkup(
    <Menu onClose={() => undefined}>
      <MenuItem>Open</MenuItem>
      <MenuItem>Close</MenuItem>
    </Menu>,
  );
  assert.match(html, /role="menu"/);
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, 2);
  assert.equal(nextLinearIndex(0, 2, 'ArrowDown', 'vertical'), 1);
  assert.equal(nextLinearIndex(0, 2, 'ArrowUp', 'vertical'), 1);
  assert.equal(nextLinearIndex(1, 2, 'Home', 'vertical'), 0);
  assert.equal(nextLinearIndex(0, 2, 'End', 'vertical'), 1);
});

test('Menu keeps at most one focused item after ArrowDown', () => {
  const items = [0, 1, 2].map(() => {
    const attributes = new Set<string>();
    return {
      attributes,
      tabIndex: -1,
      focus: () => undefined,
      setAttribute: (name: string) => attributes.add(name),
      removeAttribute: (name: string) => attributes.delete(name),
    };
  });
  const next = nextLinearIndex(0, items.length, 'ArrowDown', 'vertical');
  moveMenuFocus(items, next);
  assert.equal(items.filter((item) => item.attributes.has('data-focused')).length, 1);
  assert.equal(items.filter((item) => item.tabIndex === 0).length, 1);
  assert.equal(items[next]?.attributes.has('data-focused'), true);
});

test('submenu anchors to its parent row, flips when clipped, and uses the keyboard pair', () => {
  const parentItem = {
    getBoundingClientRect: () => ({ left: 300, right: 480, top: 126, width: 180 }),
  } as Pick<HTMLElement, 'getBoundingClientRect'>;
  const submenu = {
    getBoundingClientRect: () => ({ width: 220 }),
  } as Pick<HTMLElement, 'getBoundingClientRect'>;

  assert.deepEqual(
    getSubmenuPosition(parentItem.getBoundingClientRect(), submenu.getBoundingClientRect(), 900),
    { x: 478, y: 126, side: 'right' },
  );
  assert.deepEqual(
    getSubmenuPosition(parentItem.getBoundingClientRect(), submenu.getBoundingClientRect(), 640),
    { x: 82, y: 126, side: 'left' },
  );
  assert.equal(submenuKeyboardAction('ArrowRight', false), 'open');
  assert.equal(submenuKeyboardAction('ArrowLeft', true), 'close');
  assert.equal(submenuKeyboardAction('ArrowLeft', false), null);
});

test('Button keeps native keyboard semantics and toggle/loading ARIA', () => {
  const html = renderToStaticMarkup(<Button pressed>Grid</Button>);
  assert.match(html, /^<button/);
  assert.match(html, /type="button"/);
  assert.match(html, /aria-pressed="true"/);
});

test('NumberInput exposes spinbutton state and commit/revert keyboard contracts', () => {
  const html = renderToStaticMarkup(
    <NumberInput aria-label="Length" defaultValue={2.5} unit="m" />,
  );
  assert.match(html, /role="spinbutton"/);
  assert.match(html, /aria-label="Length"/);
  assert.equal(parseDraft('2,5', 0, 3), 2.5);
  assert.equal(parseDraft('4', 0, 3), null);
  const source = readFileSync('src/NumberInput.tsx', 'utf8');
  assert.match(source, /registerEscapeRung\('fieldRevert'/);
  assert.match(source, /event\.key === 'Enter'/);
  assert.match(source, /consumeEscapeBlurCommitSuppression/);
});

test('Toast region is polite while errors are assertive and dismiss is a button', () => {
  const html = renderToStaticMarkup(
    <ToastRegion>
      <Toast tone="error" autoDismiss={false} onDismiss={() => undefined}>
        Failed
      </Toast>
    </ToastRegion>,
  );
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /role="alert" aria-live="assertive"/);
  assert.match(html, /aria-label="Dismiss"/);
});

test('Spinner has a status role and enforces delayed default appearance', () => {
  assert.equal(renderToStaticMarkup(<Spinner />), '');
  assert.equal(spinnerDelay(0), 300);
  assert.equal(spinnerDelay(450), 450);
  const html = renderToStaticMarkup(<SpinnerVisual label="Loading model" size="medium" />);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-label="Loading model"/);
});

test('DurabilityIndicator uses only verified stored, pending, and actionable failure copy', () => {
  assert.match(renderToStaticMarkup(<DurabilityIndicator state={{ kind: 'stored' }} />), /Stored/);
  assert.match(
    renderToStaticMarkup(<DurabilityIndicator state={{ kind: 'storing' }} />),
    /Storing…/,
  );
  const failed = renderToStaticMarkup(
    <DurabilityIndicator
      state={{ kind: 'failed', reason: 'Disk is full' }}
      onRetry={() => undefined}
    />,
  );
  assert.match(failed, /Not stored — Disk is full/);
  assert.match(failed, />Retry</);
});

test('Tooltip is described on focus-capable content and omitted for disabled-only content', () => {
  const html = renderToStaticMarkup(
    <Tooltip content="Zoom to selection" open>
      <button type="button">Zoom</button>
    </Tooltip>,
  );
  assert.match(html, /aria-describedby=/);
  assert.match(html, /role="tooltip"/);
  const disabled = renderToStaticMarkup(
    <Tooltip content="Unavailable" open>
      <button type="button" disabled>
        Run
      </button>
    </Tooltip>,
  );
  assert.doesNotMatch(disabled, /role="tooltip"|aria-describedby/);
});

test('Slider exposes slider ARIA and bounded keyboard steps', () => {
  const html = renderToStaticMarkup(
    <Slider aria-label="Point size" value={2} valueText="2 pixels" />,
  );
  assert.match(html, /role="slider"/);
  assert.match(html, /aria-valuetext="2 pixels"/);
  assert.equal(sliderValueForKey(2, 1, 3, 0.5, 'ArrowRight'), 2.5);
  assert.equal(sliderValueForKey(2, 1, 3, 0.5, 'Home'), 1);
  assert.equal(sliderValueForKey(2, 1, 3, 0.5, 'End'), 3);
});

test('Dialog is labelled, modal, focus-trapped, and registered at modal Escape', () => {
  const html = renderToStaticMarkup(
    <Dialog open onClose={() => undefined} title="Delete entity">
      Consequence
    </Dialog>,
  );
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby=/);
  const source = readFileSync('src/Dialog.tsx', 'utf8');
  assert.match(source, /registerEscapeRung\('modal'/);
  assert.match(source, /event\.key !== 'Tab'/);
});

test('ProgressBar is a top-level determinate and indeterminate ARIA control', () => {
  const determinate = renderToStaticMarkup(<ProgressBar value={0.42} ariaLabel="Import" />);
  assert.match(determinate, /role="progressbar"/);
  assert.match(determinate, /aria-valuenow="42"/);
  const indeterminate = renderToStaticMarkup(
    <ProgressBar value={0} ariaLabel="Import" indeterminate />,
  );
  assert.doesNotMatch(indeterminate, /aria-valuenow=/);
});

test('Ribbon tabs use horizontal activation keys and roving tabindex contract', () => {
  assert.equal(nextLinearIndex(0, 3, 'ArrowRight', 'horizontal'), 1);
  assert.equal(nextLinearIndex(0, 3, 'ArrowLeft', 'horizontal'), 2);
  assert.equal(nextLinearIndex(1, 3, 'Home', 'horizontal'), 0);
  assert.equal(nextLinearIndex(1, 3, 'End', 'horizontal'), 2);
  const source = readFileSync('src/Ribbon.tsx', 'utf8');
  assert.match(source, /role="tablist"/);
  assert.match(source, /tabIndex=\{isActive \? 0 : -1\}/);
  assert.match(source, /'ArrowLeft', 'ArrowRight', 'Home', 'End'/);
});
