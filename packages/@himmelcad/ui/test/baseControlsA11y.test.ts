import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

import { accessibilityFixtures } from './a11yFixtures.js';

interface AxeResult {
  violations: Array<{ id: string; impact: string | null; help: string }>;
}

test('axe-core passes every shared base-control fixture', async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    const axeSource = readFileSync('../../../node_modules/axe-core/axe.min.js', 'utf8');
    for (const [name, fixture] of Object.entries(accessibilityFixtures())) {
      await page.setContent(
        `<!doctype html><html lang="en"><head><title>${name}</title></head><body><main><h1>${name}</h1>${fixture}</main></body></html>`,
      );
      await page.addScriptTag({ content: axeSource });
      const result = await page.evaluate(async () => {
        const axe = (globalThis as unknown as { axe: { run: () => Promise<AxeResult> } }).axe;
        return axe.run();
      });
      assert.deepEqual(
        result.violations,
        [],
        `${name}: ${result.violations.map((violation) => `${violation.id} (${violation.impact})`).join(', ')}`,
      );
    }
  } finally {
    await browser.close();
  }
});
