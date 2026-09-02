import assert from 'node:assert/strict';
import test from 'node:test';

import { gateA11yFindings, selectorMatchesPattern, validateA11yExceptions } from './a11y-audit.mjs';

const trackedException = {
  ruleId: 'color-contrast',
  selectorPattern: '.brand-art *',
  reason: 'Decorative artwork is not user interface text.',
  owner: 'PhotoLab',
  reviewDate: '2027-03-01',
};

test('selector exception patterns treat CSS punctuation literally and star as a wildcard', () => {
  assert.equal(selectorMatchesPattern('.brand-art > svg', '.brand-art *'), true);
  assert.equal(
    selectorMatchesPattern('button[data-kind="save"]', 'button[data-kind="save"]'),
    true,
  );
  assert.equal(
    selectorMatchesPattern('buttonXdata-kind="save"', 'button[data-kind="save"]'),
    false,
  );
  assert.equal(selectorMatchesPattern('.other > svg', '.brand-art *'), false);
});

test('severity gate exempts only a matching rule and selector', () => {
  const result = gateA11yFindings(
    [
      { ruleId: 'color-contrast', selector: '.brand-art > svg', impact: 'serious' },
      { ruleId: 'button-name', selector: '.brand-art > svg', impact: 'critical' },
      { ruleId: 'color-contrast', selector: '.toolbar button', impact: 'serious' },
      { ruleId: 'label', selector: '#scale', impact: 'moderate' },
    ],
    [trackedException],
  );

  assert.equal(result.findings[0].exception, trackedException);
  assert.deepEqual(
    result.blocking.map(({ ruleId, selector }) => ({ ruleId, selector })),
    [
      { ruleId: 'button-name', selector: '.brand-art > svg' },
      { ruleId: 'color-contrast', selector: '.toolbar button' },
    ],
  );
});

test('moderate and minor findings are reported without failing the gate', () => {
  const result = gateA11yFindings(
    [
      { ruleId: 'label', selector: '#scale', impact: 'moderate' },
      { ruleId: 'focus-order-semantics', selector: '[tabindex="0"]', impact: 'minor' },
    ],
    [],
  );
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.blocking, []);
});

test('tracked exceptions require ownership, reason and a review date', () => {
  assert.deepEqual(validateA11yExceptions({ schemaVersion: 1, exceptions: [trackedException] }), [
    trackedException,
  ]);
  assert.throws(
    () =>
      validateA11yExceptions({
        schemaVersion: 1,
        exceptions: [{ ...trackedException, owner: '' }],
      }),
    /non-empty owner/u,
  );
  assert.throws(
    () =>
      validateA11yExceptions({
        schemaVersion: 1,
        exceptions: [{ ...trackedException, reviewDate: 'March 2027' }],
      }),
    /YYYY-MM-DD/u,
  );
});
