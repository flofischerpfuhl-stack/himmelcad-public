#!/usr/bin/env node

/* global document, getComputedStyle, process, requestAnimationFrame, window */
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Playwright values cross the Node/browser boundary in this standalone visual audit. */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright-core';

import { countA11yImpacts, gateA11yFindings, validateA11yExceptions } from './lib/a11y-audit.mjs';
import { compareImages, decodePng, encodePng } from './lib/png-compare.mjs';

process.env.HIMMELCAD_PHOTOLAB_CLEAN_BOOT = '1';

const root = resolve(import.meta.dirname, '..');
const rendererUrl = pathToFileURL(resolve(root, 'apps/photolab/dist/renderer/index.html')).href;
const baselineRoot = resolve(root, 'apps/photolab/test/visual-baselines');
// A capture fails when more than 0.1 % of its pixels differ from the baseline,
// counting a pixel as different once any RGBA channel deviates by more than 16.
// The channel tolerance absorbs Chromium's sub-visual antialiasing jitter; the
// area threshold absorbs a few stray glyph edges while any real layout shift —
// a moved control, a changed panel width, a restyled surface — moves whole
// runs of pixels and lands far above it.
const CHANNEL_TOLERANCE = 16;
const MAX_DIFF_RATIO = 0.001;
const KEYBOARD_MAX_STEPS = 250;
const updateBaselines = process.argv.includes('--update-baselines');
const compareBaselines =
  updateBaselines ||
  (!process.argv.includes('--no-compare-baselines') &&
    process.argv.includes('--compare-baselines'));
const a11yEnabled = !process.argv.includes('--no-a11y');
const a11yExceptionPath = resolve(root, 'apps/photolab/test/a11y-exceptions.json');
const a11yExceptions = a11yEnabled
  ? validateA11yExceptions(JSON.parse(await readFile(a11yExceptionPath, 'utf8')))
  : [];
const axeSource = a11yEnabled
  ? await readFile(resolve(root, 'node_modules/axe-core/axe.min.js'), 'utf8')
  : null;
const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1100x720', width: 1100, height: 720 },
];
const ribbonActions = {
  Project: [],
  Images: ['Metadata', 'Image Status'],
  Reference: ['Reference Frame'],
  Alignment: ['Align Photos', 'Optimize', 'Merge Alignments', 'Capture Groups', 'Report'],
  Products: ['Depth Maps', 'Dense Cloud', 'DEM', 'Orthomosaic', 'Textured Mesh', 'Gaussian Splat'],
  Automation: ['Configure Batch', 'Queue'],
};

if (!process.argv.includes('--skip-build'))
  await run('pnpm', ['--filter', '@himmelcad/photolab', 'exec', 'vite', 'build']);
let browser;
let browserVersion = 'unknown';
const reports = [];
if (updateBaselines) await mkdir(baselineRoot, { recursive: true });
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN ?? '/usr/bin/google-chrome',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--allow-file-access-from-files',
    ],
  });
  browserVersion = browser.version();
  for (const viewport of viewports) reports.push(await auditViewport(browser, viewport));
} finally {
  await browser?.close();
}

const baseline = {
  mode: updateBaselines ? 'update' : compareBaselines ? 'compare' : 'off',
  channelTolerance: CHANNEL_TOLERANCE,
  maxDiffRatio: MAX_DIFF_RATIO,
  directory: relative(root, baselineRoot),
  chromiumVersion: browserVersion,
  platform: `${process.platform}-${process.arch}`,
};
if (updateBaselines)
  await writeFile(
    resolve(baselineRoot, 'manifest.json'),
    `${JSON.stringify(
      {
        note: 'Pixel baselines for scripts/photolab-visual-regression.mjs. Rendering depends on the Chromium build and the installed font stack, so comparison is only meaningful on a machine or CI image matching this provenance. Regenerate with `pnpm photolab:test:visual -- --update-baselines`.',
        channelTolerance: CHANNEL_TOLERANCE,
        maxDiffRatio: MAX_DIFF_RATIO,
        chromiumVersion: browserVersion,
        platform: `${process.platform}-${process.arch}`,
        viewports: viewports.map((viewport) => viewport.name),
        captures: Object.fromEntries(
          reports.map((report) => [report.viewport, report.captures.slice().sort()]),
        ),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

const reportPath = resolve(root, '.build/visual-regression/report.json');
await writeFile(reportPath, `${JSON.stringify({ baseline, reports }, null, 2)}\n`, 'utf8');
const a11ySurfaces = reports.flatMap((report) => report.a11ySurfaces);
const a11yFindings = a11ySurfaces.flatMap((surface) => surface.violations);
const a11yGate = gateA11yFindings(a11yFindings, a11yExceptions);
const excludedRuleIds = [
  ...new Set(a11ySurfaces.flatMap((surface) => surface.excludedRules)),
].sort();
const a11yReport = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  enabled: a11yEnabled,
  axeVersion: a11ySurfaces.find((surface) => surface.axeVersion)?.axeVersion ?? null,
  ruleset: {
    standardTags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
    scope:
      'Desktop app shell rules: colour contrast, form labels, button/link names, ARIA validity, and focus-order semantics.',
    includedRules: [...new Set(a11ySurfaces.flatMap((surface) => surface.includedRules))].sort(),
    exclusions: excludedRuleIds.map((ruleId) => ({
      ruleId,
      reason:
        ruleId === 'region'
          ? 'An Electron app shell is not an article-style browser document; its persistent named panels already provide application navigation, so requiring every node to sit in a landmark creates duplicate-shell noise.'
          : `The ${ruleId} rule covers content structure, document metadata, media, or browser navigation outside WP-F3's bounded desktop-shell baseline; it is not represented as audited coverage.`,
    })),
  },
  exceptionsFile: relative(root, a11yExceptionPath),
  exceptions: a11yExceptions,
  counts: countA11yImpacts(a11yGate.findings),
  blockingCount: a11yGate.blocking.length,
  surfaces: a11ySurfaces,
  keyboard: reports.flatMap((report) => report.keyboardAudits),
};
const a11yReportPath = resolve(root, '.build/visual-regression/a11y-report.json');
const a11ySummaryPath = resolve(root, '.build/visual-regression/a11y-summary.md');
await writeFile(a11yReportPath, `${JSON.stringify(a11yReport, null, 2)}\n`, 'utf8');
await writeFile(a11ySummaryPath, renderA11yMarkdown(a11yReport), 'utf8');
const issues = reports.flatMap((report) =>
  report.issues.map((issue) => `${report.viewport}: ${issue}`),
);
issues.push(
  ...a11yGate.blocking.map(
    (finding) =>
      `${finding.viewport}/${finding.surface}: ${finding.ruleId} (${finding.impact}) at ${finding.selector}`,
  ),
);
if (issues.length > 0) {
  throw new Error(
    `PhotoLab visual audit failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}`,
  );
}
const captureCount = reports.reduce((sum, report) => sum + report.captures.length, 0);
const baselineSummary = updateBaselines
  ? ` · ${reports.reduce((sum, report) => sum + report.baselinesWritten, 0)} baselines written`
  : compareBaselines
    ? ` · ${reports.reduce((sum, report) => sum + report.baselinesCompared, 0)} baselines matched`
    : '';
process.stdout.write(
  `PhotoLab visual audit passed · ${captureCount} captures${baselineSummary}` +
    `${a11yEnabled ? ` · a11y ${formatImpactCounts(a11yReport.counts)}` : ' · a11y skipped'}` +
    ` · ${reportPath}\n`,
);

async function auditViewport(browserInstance, viewport) {
  const output = resolve(root, `.build/visual-regression/${viewport.name}`);
  const baselineDirectory = resolve(baselineRoot, viewport.name);
  await mkdir(output, { recursive: true });
  if (updateBaselines) await mkdir(baselineDirectory, { recursive: true });
  const context = await browserInstance.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    bypassCSP: true,
  });
  const page = await context.newPage();
  const issues = [];
  const captures = [];
  const comparisons = [];
  const a11ySurfaces = [];
  const keyboardAudits = [];
  const keyboardSignatures = new Map();
  let baselinesWritten = 0;
  let baselinesCompared = 0;
  const pageErrors = [];
  const nativeDialogs = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
    // A renderer crash makes every later locator time out, and the timeout
    // message alone never names the cause. Echo it as it happens.
    process.stderr.write(`[visual ${viewport.name}] page error: ${error.stack ?? error.message}\n`);
  });
  page.on('dialog', async (dialog) => {
    nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });
  await page.addInitScript({ content: mockBridgeSource() });
  await page.goto(rendererUrl);
  try {
    await page.waitForFunction(() => document.body.innerText.includes('Project'));
  } catch (error) {
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '<unavailable>');
    throw new Error(
      `PhotoLab renderer did not become ready for ${viewport.name}. ` +
        `Page errors: ${pageErrors.join(' | ') || '<none>'}. ` +
        `Body: ${bodyText.slice(0, 500) || '<empty>'}`,
      { cause: error },
    );
  }
  if (a11yEnabled) {
    // Inject once per page document; every surface capture below runs a fresh
    // axe scan after its screenshot. This ordering keeps pixel baselines
    // independent of axe and of the keyboard walk's temporary attributes.
    await page.addScriptTag({ content: axeSource });
    await page.waitForFunction(() => typeof window.axe?.run === 'function');
  }

  const capture = async (name) => {
    await page.evaluate(
      () =>
        new Promise((resolveCapture) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveCapture)),
        ),
    );
    await page.waitForTimeout(120);
    const shot = await page.screenshot({
      path: resolve(output, `${name}.png`),
      animations: 'disabled',
    });
    captures.push(name);
    if (compareBaselines) {
      const baselinePath = resolve(baselineDirectory, `${name}.png`);
      const diffPath = resolve(output, `${name}.diff.png`);
      if (updateBaselines) {
        await writeFile(baselinePath, shot);
        baselinesWritten += 1;
      } else {
        const stored = await readFile(baselinePath).catch(() => null);
        if (!stored)
          issues.push(
            `${name}: no pixel baseline at ${relative(root, baselinePath)} — run ` +
              '`pnpm photolab:test:visual -- --update-baselines` after reviewing the capture',
          );
        else {
          const result = compareImages(decodePng(shot), decodePng(stored), {
            channelTolerance: CHANNEL_TOLERANCE,
          });
          comparisons.push({
            name,
            differingPixels: result.differingPixels,
            totalPixels: result.totalPixels,
            ratio: Number(result.ratio.toFixed(6)),
            maxChannelDelta: result.maxChannelDelta,
            sizeMismatch: result.sizeMismatch,
          });
          baselinesCompared += 1;
          if (result.sizeMismatch || result.ratio > MAX_DIFF_RATIO) {
            await writeFile(diffPath, encodePng(result.diff));
            issues.push(
              `${name}: pixel baseline mismatch — ${result.differingPixels}/${result.totalPixels} ` +
                `pixels (${(result.ratio * 100).toFixed(3)} % > ${(MAX_DIFF_RATIO * 100).toFixed(3)} %)` +
                `${result.sizeMismatch ? ', capture size differs from the baseline' : ''}; diff: ${relative(root, diffPath)}`,
            );
          } else await rm(diffPath, { force: true });
        }
      }
    }
    const audit = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          box.width > 0 &&
          box.height > 0
        );
      };
      const taskIslands = [...document.querySelectorAll('[data-task-drag-handle]')]
        .map((handle) => handle.closest('section'))
        .filter((section) => section && visible(section))
        .map((section) => {
          const box = section.getBoundingClientRect();
          return {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
            outerPointerEvents: section.parentElement?.parentElement
              ? getComputedStyle(section.parentElement.parentElement).pointerEvents
              : null,
          };
        });
      const selectedTabs = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
        .filter(visible)
        .map((tab) => ({
          label: tab.textContent?.trim() ?? '',
          background: getComputedStyle(tab).backgroundColor,
        }));
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
        .filter(visible)
        .map((dialog) => {
          const box = dialog.getBoundingClientRect();
          const layer = dialog.parentElement?.parentElement;
          return {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
            layerPointerEvents: layer ? getComputedStyle(layer).pointerEvents : null,
            activeElementInside: dialog.contains(document.activeElement),
          };
        });
      return {
        bodyOverflowX: document.documentElement.scrollWidth - window.innerWidth,
        bodyOverflowY: document.documentElement.scrollHeight - window.innerHeight,
        taskIslands,
        selectedTabs,
        dialogs,
        emptyFunctionPanel: [...document.querySelectorAll('main,aside,section')].some(
          (node) => visible(node) && node.textContent?.trim() === 'FUNCTION',
        ),
      };
    });
    if (audit.bodyOverflowX > 1)
      issues.push(`${name}: page overflows horizontally by ${audit.bodyOverflowX}px`);
    if (audit.bodyOverflowY > 1)
      issues.push(`${name}: page overflows vertically by ${audit.bodyOverflowY}px`);
    for (const box of audit.taskIslands) {
      if (
        box.left < -1 ||
        box.top < -1 ||
        box.right > viewport.width + 1 ||
        box.bottom > viewport.height + 1
      )
        issues.push(`${name}: task island escapes viewport (${JSON.stringify(box)})`);
      if (box.outerPointerEvents !== 'none')
        issues.push(`${name}: task island blocks the entire application surface`);
    }
    for (const dialog of audit.dialogs) {
      if (
        dialog.left < -1 ||
        dialog.top < -1 ||
        dialog.right > viewport.width + 1 ||
        dialog.bottom > viewport.height + 1
      )
        issues.push(`${name}: modal dialog escapes viewport (${JSON.stringify(dialog)})`);
      if (dialog.layerPointerEvents !== 'auto')
        issues.push(`${name}: modal dialog does not block background pointers`);
      if (!dialog.activeElementInside) issues.push(`${name}: modal dialog does not contain focus`);
    }
    if (a11yEnabled) {
      const surface = await auditA11ySurface(page, viewport.name, name);
      a11ySurfaces.push(surface);
      const keyboardAudit = await auditKeyboardReachability(
        page,
        viewport.name,
        name,
        keyboardSignatures,
      );
      keyboardAudits.push(keyboardAudit);
      if (!keyboardAudit.duplicateOf) {
        const ribbonFailures = [
          ...keyboardAudit.ribbon.unreachable.map((control) => `${control.selector} (unreachable)`),
          ...keyboardAudit.ribbon.withoutFocusIndicator.map(
            (control) => `${control.selector} (no visible focus indicator)`,
          ),
        ];
        if (ribbonFailures.length > 0)
          issues.push(`${name}: ribbon keyboard invariant failed: ${ribbonFailures.join(', ')}`);
      }
    }
    return audit;
  };

  if (process.env.PHOTOLAB_VISUAL_THEME === 'light') {
    // G17 light-theme captures use the product's own theme control (status bar).
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains('hc-theme-light'));
    const themeProbe = await page.evaluate(() => ({
      classes: document.documentElement.className,
      island: getComputedStyle(document.body).getPropertyValue('--hc-bg-island').trim(),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    }));
    process.stderr.write(`[visual ${viewport.name}] theme probe ${JSON.stringify(themeProbe)}\n`);
  }
  const mainAudit = await capture('00-main-view');
  const viewTab = mainAudit.selectedTabs.find((tab) => tab.label === 'View');
  const rightTab = mainAudit.selectedTabs.find(
    (tab) => tab.label === 'Function' || tab.label === 'Properties',
  );
  if (viewTab && rightTab && viewTab.background !== rightTab.background)
    issues.push(
      `active View and right-panel tabs use inconsistent backgrounds (${viewTab.background} vs ${rightTab.background})`,
    );

  await page.getByRole('tree').getByText('DJI_VISUAL_0001.JPG', { exact: true }).click();
  await page.getByRole('tab', { name: 'Properties', exact: true }).click();
  await capture('right-panel-properties');

  await page.getByRole('tab', { name: /^Jobs\b/ }).click();
  await capture('bottom-jobs');
  await page.getByRole('tab', { name: 'Accuracy', exact: true }).click();
  await capture('bottom-accuracy');
  await page.getByRole('tab', { name: 'Report', exact: true }).click();
  await capture('bottom-report');
  await page.getByRole('button', { name: 'HTML', exact: true }).click();
  await page.waitForTimeout(200);
  await capture('bottom-report-saved');
  await page.evaluate(() => window.__photolabVisualStderr?.('ERROR visual audit failure'));
  await page
    .getByRole('tab', { name: 'Console', exact: true })
    .and(page.locator('[aria-selected="true"]'))
    .waitFor();
  await capture('error-opens-console');
  for (const [tabName, actions] of Object.entries(ribbonActions)) {
    await page.getByRole('tab', { name: tabName, exact: true }).first().click();
    await capture(`ribbon-${slug(tabName)}`);
    for (const action of actions) {
      // The keyboard walk of the previous surface may have left the ribbon on
      // another tab (automatic activation); return to this tab first.
      const ribbonTab = page.getByRole('tab', { name: tabName, exact: true }).first();
      if ((await ribbonTab.getAttribute('aria-selected')) !== 'true') await ribbonTab.click();
      const button = page.getByRole('button', { name: action, exact: true }).first();
      if ((await button.count()) === 0) {
        issues.push(`${tabName}: missing ribbon action ${action}`);
        continue;
      }
      if (action === 'Capture Groups') {
        const tree = page.getByRole('tree');
        await tree.getByText('DJI_VISUAL_0001.JPG', { exact: true }).click();
        await tree
          .getByText('DJI_VISUAL_0002.JPG', { exact: true })
          .click({ modifiers: ['Control'] });
      }
      await button.click();
      await capture(`function-${slug(action)}`);
      if (action === 'DEM') {
        // WP-A4: the DTM surface exposes the ground-classification parameters.
        // The shared Select is a button + listbox, not a native <select>.
        const pickSurface = async (optionName) => {
          await page
            .locator('button[aria-haspopup="listbox"]', { hasText: /D[ST]M · / })
            .first()
            .click();
          await page.getByRole('option', { name: optionName }).click();
        };
        await pickSurface(/^DTM · /);
        await capture('function-dem-dtm');
        await pickSurface(/^DSM · /);
      }
      if (action === 'Textured Mesh') {
        // WP-A3: the dense-cloud source shows its own prerequisite and stage copy.
        const pickSource = async (optionName) => {
          await page
            .locator('button[aria-haspopup="listbox"]', {
              hasText: /(DEM · terrain|Dense cloud ·)/,
            })
            .first()
            .click();
          await page.getByRole('option', { name: optionName }).click();
        };
        await pickSource(/^Dense cloud · /);
        await capture('function-textured-mesh-dense');
        await pickSource(/^DEM · /);
      }
      if (action === 'Configure Batch') {
        // The configurator renders inside the right function panel; the legacy
        // recipe dialog is the only surface with an explicit close button.
        const close = page.getByRole('button', { name: 'Close batch configuration', exact: true });
        if ((await close.count()) > 0) await close.click();
      }
      if (action === 'Capture Groups') {
        await page.getByRole('button', { name: 'Add split', exact: true }).click();
        await capture('function-capture-groups-calibration-split');
      }
    }
  }

  await page.getByRole('tab', { name: 'Images', exact: true }).first().click();
  await page.getByRole('button', { name: 'Images', exact: true }).first().click();
  await page.getByText('Scanning folders…', { exact: true }).waitFor();
  await capture('image-import-progress');
  try {
    await page.getByText('2 images ready', { exact: true }).waitFor({ timeout: 15_000 });
  } catch (error) {
    const bodyText = await page
      .locator('body')
      .innerText()
      .catch(() => '<unavailable>');
    throw new Error(
      `Image import preview did not become ready. Body tail: ${bodyText.slice(-3_000)}`,
      {
        cause: error,
      },
    );
  }
  await capture('image-import-preview');
  await page.getByRole('button', { name: 'None', exact: true }).click();
  await page.getByText('Ready to import', { exact: true }).waitFor();
  await capture('image-import-review');
  await page.getByRole('button', { name: 'Close image import', exact: true }).click();

  await page.evaluate(() => {
    window.__photolabVisualInspectError = true;
  });
  await page.getByRole('button', { name: 'Images', exact: true }).first().click();
  await page.getByText('Visual image inspection failure', { exact: true }).waitFor();
  await capture('image-import-error');
  await page.getByRole('button', { name: 'Close image import', exact: true }).click();
  await page.evaluate(() => {
    window.__photolabVisualInspectError = false;
  });

  await page.getByRole('tab', { name: 'Reference', exact: true }).first().click();
  await page.getByRole('button', { name: 'Import GCPs', exact: true }).click();
  await page.getByText('Preview valid · 2 points', { exact: true }).waitFor();
  await capture('gcp-import-file');
  await capture('gcp-import-preview');
  await page.getByRole('button', { name: 'None', exact: true }).click();
  await page.getByText('Summary', { exact: true }).last().waitFor();
  await capture('gcp-import-review');
  await page.getByRole('button', { name: 'Close GCP import', exact: true }).click();

  await page.evaluate(() => {
    window.__photolabVisualGcpPreviewError = true;
  });
  await page.getByRole('button', { name: 'Import GCPs', exact: true }).click();
  await page.getByText('Visual GCP preview failure', { exact: true }).waitFor();
  await capture('gcp-import-error');
  await page.getByRole('button', { name: 'Close GCP import', exact: true }).click();
  await page.evaluate(() => {
    window.__photolabVisualGcpPreviewError = false;
  });

  const cameraTreeItem = page
    .getByLabel('Entity tree', { exact: true })
    .getByText('DJI_VISUAL_0001.JPG', { exact: true });
  await cameraTreeItem.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove from project…', exact: true }).click();
  await page.getByRole('dialog', { name: /Remove (?:image|\d+ images)\?/ }).waitFor();
  await capture('confirmation-remove-image');
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();

  const productTreeItem = page.getByText('Sparse Point Cloud', { exact: true });
  await productTreeItem.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Entity commands' }).waitFor();
  await capture('context-menu-product');
  const exportItem = page.getByRole('menuitem', { name: 'Export…', exact: true });
  if ((await exportItem.count()) === 0) {
    const offered = await page
      .getByRole('menu', { name: 'Entity commands' })
      .getByRole('menuitem')
      .allInnerTexts();
    issues.push(`product context menu offers no Export… (has: ${offered.join(' | ')})`);
    await page.keyboard.press('Escape');
    return;
  }
  await exportItem.click();
  const exportDialog = page.getByRole('dialog', { name: 'Replace “Sparse Point Cloud”?' });
  await exportDialog.waitFor();
  await page.keyboard.press('Tab');
  if (!(await exportDialog.evaluate((dialog) => dialog.contains(document.activeElement))))
    issues.push('product export confirmation allowed focus to escape the modal');
  await capture('confirmation-replace-product');
  await exportDialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('tab', { name: 'Images', exact: true }).last().click();
  await capture('workspace-images');
  await page.getByRole('tab', { name: 'View', exact: true }).click();
  await capture('workspace-view-restored');

  if (nativeDialogs.length > 0) issues.push(`native dialogs used: ${nativeDialogs.join(' | ')}`);
  if (pageErrors.length > 0) issues.push(`page errors: ${pageErrors.join(' | ')}`);
  await context.close();
  return {
    viewport: viewport.name,
    captures,
    baselinesWritten,
    baselinesCompared,
    comparisons,
    a11ySurfaces,
    keyboardAudits,
    issues,
    nativeDialogs,
    pageErrors,
  };
}

async function auditA11ySurface(page, viewport, surface) {
  const scanned = await page.evaluate(
    async ({ viewportName, surfaceName }) => {
      const standardTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
      const taggedRules = window.axe.getRules(standardTags);
      const allRuleIds = new Set(window.axe.getRules().map((rule) => rule.ruleId));
      const namedRules = new Set(['color-contrast', 'label', 'button-name', 'link-name']);
      const includedRules = taggedRules
        .map((rule) => rule.ruleId)
        .filter((ruleId) => namedRules.has(ruleId) || ruleId.startsWith('aria-'));
      // focus-order-semantics is an axe best-practice rule rather than a WCAG
      // tagged rule, but keyboard order is explicitly part of the desktop-shell
      // baseline and is therefore added to the otherwise WCAG 2.1 A/AA set.
      if (allRuleIds.has('focus-order-semantics')) includedRules.push('focus-order-semantics');
      const uniqueRules = [...new Set(includedRules)].sort();
      const excludedRules = [
        ...taggedRules.map((rule) => rule.ruleId).filter((ruleId) => !uniqueRules.includes(ruleId)),
        ...(allRuleIds.has('region') ? ['region'] : []),
      ];
      const result = await window.axe.run(document, {
        runOnly: { type: 'rule', values: uniqueRules },
        resultTypes: ['violations'],
      });
      const violations = result.violations.flatMap((violation) =>
        violation.nodes.map((node) => ({
          viewport: viewportName,
          surface: surfaceName,
          selector: node.target
            .flat(Number.POSITIVE_INFINITY)
            .map((part) => String(part))
            .join(' >>> '),
          ruleId: violation.id,
          impact: node.impact ?? violation.impact ?? 'unknown',
          help: violation.help,
          helpUrl: violation.helpUrl,
          failureSummary: node.failureSummary ?? null,
        })),
      );
      const counts = { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 };
      for (const finding of violations) {
        const impact = Object.hasOwn(counts, finding.impact) ? finding.impact : 'unknown';
        counts[impact] += 1;
      }
      return {
        viewport: viewportName,
        surface: surfaceName,
        axeVersion: result.testEngine.version,
        includedRules: uniqueRules,
        excludedRules: [...new Set(excludedRules)].sort(),
        counts,
        violations,
      };
    },
    { viewportName: viewport, surfaceName: surface },
  );
  return {
    ...scanned,
    violations: gateA11yFindings(scanned.violations, a11yExceptions).findings,
  };
}

async function auditKeyboardReachability(page, viewport, surface, priorSignatures) {
  const prepared = await page.evaluate(
    ({ surfaceName, hardStepLimit }) => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          box.width > 0 &&
          box.height > 0
        );
      };
      const cssPath = (element) => {
        if (element.id) return `#${CSS.escape(element.id)}`;
        const parts = [];
        let current = element;
        while (current && current !== document.body && parts.length < 6) {
          const siblings = current.parentElement
            ? [...current.parentElement.children].filter(
                (sibling) => sibling.tagName === current.tagName,
              )
            : [];
          const position =
            siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
          parts.unshift(`${current.tagName.toLowerCase()}${position}`);
          current = current.parentElement;
        }
        return parts.join(' > ');
      };
      const descriptor = (element) => ({
        selector: cssPath(element),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        name:
          element.getAttribute('aria-label') ??
          element.getAttribute('title') ??
          element.textContent?.trim().replace(/\s+/gu, ' ').slice(0, 120) ??
          '',
        disabled: element.matches(':disabled, [aria-disabled="true"]'),
      });
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
      const activePanel =
        dialogs.at(-1) ?? document.querySelector('aside[aria-label="Function panel"]');
      const controlSelector = 'button, [role="button"], input, select, textarea, [tabindex]';
      const panelControls = activePanel
        ? [...activePanel.querySelectorAll(controlSelector)].filter(visible)
        : [];
      const ribbonTablist = [...document.querySelectorAll('[role="tablist"]')].find((tablist) => {
        const labels = [...tablist.querySelectorAll('[role="tab"]')].map((tab) =>
          tab.textContent?.trim(),
        );
        return labels.includes('Project') && labels.includes('Automation');
      });
      const ribbonTabs = ribbonTablist
        ? [...ribbonTablist.querySelectorAll('[role="tab"]')].filter(visible)
        : [];
      document
        .querySelectorAll('[data-photolab-a11y-target]')
        .forEach((element) => element.removeAttribute('data-photolab-a11y-target'));
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      // Start the walk on the ribbon: a WAI-ARIA tablist keeps one tab in the Tab order and
      // moves between tabs with arrow keys; the audit judges reachability from there.
      const targets = [];
      const baselines = {};
      for (const [group, elements] of [
        ['ribbon', dialogs.length > 0 ? [] : ribbonTabs],
        ['panel', panelControls],
      ])
        for (const element of elements) {
          const id = `${group}-${targets.length}`;
          element.setAttribute('data-photolab-a11y-target', id);
          const style = getComputedStyle(element);
          baselines[id] = { outline: style.outline, boxShadow: style.boxShadow };
          targets.push({ id, group, ...descriptor(element) });
        }
      const scrollPositions = [...document.querySelectorAll('*')]
        .filter((element) => element.scrollTop !== 0 || element.scrollLeft !== 0)
        .map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft }));
      // Start the walk on the ribbon only after the unfocused style baselines are captured.
      if (ribbonTabs[0] instanceof HTMLElement) ribbonTabs[0].focus();
      window.__photolabA11yKeyboard = { baselines, scrollPositions };
      const signature = targets
        .map((target) =>
          [
            target.group,
            target.selector,
            target.name,
            target.disabled ? 'disabled' : 'enabled',
          ].join('|'),
        )
        .join('\n');
      return {
        surface: surfaceName,
        panel: dialogs.length > 0 ? 'dialog' : activePanel ? 'function-panel' : 'none',
        ribbonSkippedForModal: dialogs.length > 0,
        signature,
        targets,
        maxSteps: Math.min(hardStepLimit, Math.max(40, targets.length * 4 + 20)),
      };
    },
    { surfaceName: surface, hardStepLimit: KEYBOARD_MAX_STEPS },
  );

  const duplicateOf = priorSignatures.get(prepared.signature);
  if (duplicateOf) {
    await cleanupKeyboardAudit(page);
    return {
      viewport,
      surface,
      panel: prepared.panel,
      duplicateOf,
      maxSteps: 0,
      focusedChain: [],
      ribbon: { total: 0, unreachable: [], withoutFocusIndicator: [] },
      panelControls: { total: 0, unreachable: [], withoutFocusIndicator: [] },
    };
  }
  priorSignatures.set(prepared.signature, surface);

  const focused = new Map();
  const focusedChain = [];
  const seenFocusOrder = new Set();
  {
    // The walk starts on the ribbon tablist (see prepare); record that initial focus.
    // Chromium only paints :focus-visible for programmatic focus when the last
    // interaction was keyboard-driven; the surface setup clicks, so nudge the
    // modality with a modifier key and re-focus before sampling the indicator.
    await page.keyboard.press('Shift');
    await page.evaluate(() => {
      const element = document.activeElement;
      if (element instanceof HTMLElement) {
        element.blur();
        element.focus();
      }
    });
    const initial = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      const id = element.getAttribute('data-photolab-a11y-target');
      if (!id) return null;
      const baseline = window.__photolabA11yKeyboard?.baselines?.[id];
      const style = getComputedStyle(element);
      return {
        id,
        visibleFocusIndicator:
          !baseline || style.outline !== baseline.outline || style.boxShadow !== baseline.boxShadow,
      };
    });
    if (initial)
      focused.set(initial.id, { step: 0, visibleFocusIndicator: initial.visibleFocusIndicator });
  }
  const readFocusState = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      const cssPath = (node) => {
        if (node.id) return `#${CSS.escape(node.id)}`;
        const parts = [];
        let current = node;
        while (current && current !== document.body && parts.length < 6) {
          const siblings = current.parentElement
            ? [...current.parentElement.children].filter(
                (sibling) => sibling.tagName === current.tagName,
              )
            : [];
          const position =
            siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
          parts.unshift(`${current.tagName.toLowerCase()}${position}`);
          current = current.parentElement;
        }
        return parts.join(' > ') || element.tagName.toLowerCase();
      };
      const id = element.getAttribute('data-photolab-a11y-target');
      const role = element.getAttribute('role');
      const style = getComputedStyle(element);
      const baseline = id ? window.__photolabA11yKeyboard?.baselines[id] : null;
      return {
        id,
        role,
        selector: cssPath(element),
        name:
          element.getAttribute('aria-label') ??
          element.getAttribute('title') ??
          element.textContent?.trim().replace(/\s+/gu, ' ').slice(0, 120) ??
          '',
        visibleFocusIndicator: Boolean(
          baseline &&
          (style.outline !== baseline.outline || style.boxShadow !== baseline.boxShadow),
        ),
      };
    });
  const record = (state) => {
    focusedChain.push(state);
    if (state.id)
      focused.set(state.id, {
        visibleFocusIndicator:
          (focused.get(state.id)?.visibleFocusIndicator ?? false) || state.visibleFocusIndicator,
      });
  };
  // WAI-ARIA tablists keep one tab in the Tab order (roving tabindex); the
  // sibling tabs are reached with ArrowRight, so walk them from any focused tab.
  const walkedTablists = new Set();
  const arrowWalkTablist = async (origin) => {
    if (!origin || origin.role !== 'tab') return;
    // One walk per tablist and surface: mark the selected tab (automatic
    // activation moves the panel with the arrows, so the walk must end on it)
    // and count the tabs so the arrow loop is bounded by the real tab count.
    const tablist = await page.evaluate((selector) => {
      const element = document.querySelector(selector);
      const list = element?.closest('[role="tablist"]');
      if (!(list instanceof HTMLElement)) return null;
      const tabs = [...list.querySelectorAll('[role="tab"]')];
      const key = list.getAttribute('aria-label') ?? list.id ?? tabs.map((tab) => tab.id).join('|');
      const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
      if (selected instanceof HTMLElement) selected.setAttribute('data-a11y-walk-return', '1');
      return { key, count: tabs.length, hasSelected: selected instanceof HTMLElement };
    }, origin.selector);
    if (!tablist || walkedTablists.has(tablist.key)) return;
    walkedTablists.add(tablist.key);
    await page.keyboard.press('Home');
    let previous = null;
    for (let hop = 0; hop < tablist.count; hop += 1) {
      const state = await readFocusState();
      if (!state || state.role !== 'tab' || state.selector === previous) break;
      record(state);
      previous = state.selector;
      if (hop < tablist.count - 1) await page.keyboard.press('ArrowRight');
    }
    if (!tablist.hasSelected) return;
    await page.keyboard.press('Home');
    for (let hop = 0; hop < tablist.count; hop += 1) {
      const back = await page.evaluate(() => {
        const element = document.activeElement;
        if (!(element instanceof HTMLElement) || !element.hasAttribute('data-a11y-walk-return'))
          return false;
        element.removeAttribute('data-a11y-walk-return');
        return true;
      });
      if (back) break;
      await page.keyboard.press('ArrowRight');
    }
  };
  await arrowWalkTablist(await readFocusState());
  for (let step = 0; step < prepared.maxSteps; step += 1) {
    await page.keyboard.press('Tab');
    const state = await readFocusState();
    if (!state) continue;
    if (seenFocusOrder.has(state.selector)) break;
    seenFocusOrder.add(state.selector);
    record(state);
    await arrowWalkTablist(state);
  }

  const summarize = (group) => {
    const controls = prepared.targets.filter((target) => target.group === group);
    return {
      total: controls.length,
      unreachable: controls.filter((control) => !focused.has(control.id)),
      withoutFocusIndicator: controls.filter(
        (control) => focused.has(control.id) && !focused.get(control.id).visibleFocusIndicator,
      ),
    };
  };
  await cleanupKeyboardAudit(page);
  return {
    viewport,
    surface,
    panel: prepared.panel,
    duplicateOf: null,
    maxSteps: prepared.maxSteps,
    focusedChain,
    ribbon: summarize('ribbon'),
    panelControls: summarize('panel'),
  };
}

async function cleanupKeyboardAudit(page) {
  await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return (
        style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0
      );
    };
    const dialog = [...document.querySelectorAll('[role="dialog"]')].filter(visible).at(-1);
    if (dialog) {
      const first = [
        ...dialog.querySelectorAll('button, [role="button"], input, select, textarea, [tabindex]'),
      ].find(
        (element) => visible(element) && !element.matches(':disabled, [aria-disabled="true"]'),
      );
      if (first instanceof HTMLElement) first.focus();
    } else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.evaluate(() => {
    for (const position of window.__photolabA11yKeyboard?.scrollPositions ?? []) {
      position.element.scrollTop = position.top;
      position.element.scrollLeft = position.left;
    }
    document
      .querySelectorAll('[data-photolab-a11y-target]')
      .forEach((element) => element.removeAttribute('data-photolab-a11y-target'));
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    delete window.__photolabA11yKeyboard;
  });
}

function formatImpactCounts(counts) {
  return ['critical', 'serious', 'moderate', 'minor', 'unknown']
    .map((impact) => `${impact}=${counts[impact]}`)
    .join(', ');
}

function renderA11yMarkdown(report) {
  const lines = [
    '# PhotoLab accessibility audit',
    '',
    report.enabled
      ? `axe-core ${report.axeVersion} · ${formatImpactCounts(report.counts)} · ${report.blockingCount} unexcepted blocking findings`
      : 'Accessibility scanning was disabled with `--no-a11y`.',
    '',
    'Rules: WCAG 2.1 A/AA colour contrast, labels, button/link names and ARIA validity, plus the axe `focus-order-semantics` best-practice rule.',
    '',
    'Excluded: `region`, because a persistent Electron application shell is not an article-style browser document; other WCAG rules are outside this bounded first shell baseline.',
    '',
  ];
  if (!report.enabled) return `${lines.join('\n')}\n`;
  lines.push(
    '| Viewport | Surface | Critical | Serious | Moderate | Minor |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  );
  for (const surface of report.surfaces)
    lines.push(
      `| ${surface.viewport} | ${surface.surface} | ${surface.counts.critical} | ${surface.counts.serious} | ${surface.counts.moderate} | ${surface.counts.minor} |`,
    );
  const keyboardFindings = report.keyboard.filter(
    (audit) =>
      !audit.duplicateOf &&
      (audit.ribbon.unreachable.length > 0 ||
        audit.ribbon.withoutFocusIndicator.length > 0 ||
        audit.panelControls.unreachable.length > 0 ||
        audit.panelControls.withoutFocusIndicator.length > 0),
  );
  lines.push('', '## Keyboard reachability', '');
  if (keyboardFindings.length === 0) lines.push('No keyboard reachability findings.');
  else
    for (const audit of keyboardFindings)
      lines.push(
        `- ${audit.viewport}/${audit.surface}: ribbon unreachable ${audit.ribbon.unreachable.length}, ribbon focus indicator ${audit.ribbon.withoutFocusIndicator.length}, panel unreachable ${audit.panelControls.unreachable.length}, panel focus indicator ${audit.panelControls.withoutFocusIndicator.length}.`,
      );
  lines.push('', '## Tracked exceptions', '');
  if (report.exceptions.length === 0) lines.push('None.');
  else
    for (const exception of report.exceptions)
      lines.push(
        `- ${exception.ruleId} at \`${exception.selectorPattern}\`: ${exception.reason} (${exception.owner}; review ${exception.reviewDate})`,
      );
  return `${lines.join('\n')}\n`;
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function mockBridgeSource() {
  return `(() => {
    const frozenUnixMs=1735689600000;
    class FrozenDate extends Date{constructor(...args){if(args.length===0)super(frozenUnixMs);else super(...args)}static now(){return frozenUnixMs}}
    window.Date=FrozenDate;
    window.performance.now=()=>0;
    window.alert=()=>{throw new Error('Native alert is forbidden')};
    window.confirm=()=>{throw new Error('Native confirm is forbidden')};
    window.prompt=()=>{throw new Error('Native prompt is forbidden')};
    const hash='${'0'.repeat(64)}';
    const entity=(id,kind,name,parent,children=[])=>({id,kind,name,parent,children,visibility:{visible:true,locked:false},versionHash:hash,bounds:null});
    const entities={
      root:entity('root','ProjectRoot','Visual Test Project',null,['survey']),
      survey:entity('survey','Survey','Survey 01','root',['images','reference','products']),
      images:entity('images','ImageCollection','Images · 2','survey',['camera-1','camera-2']),
      'camera-1':entity('camera-1','CameraImage','DJI_VISUAL_0001.JPG','images'),
      'camera-2':entity('camera-2','CameraImage','DJI_VISUAL_0002.JPG','images'),
      reference:entity('reference','Group','Reference & GCPs','survey'),
      products:entity('products','Group','Products','survey',['sparse-1']),
      'sparse-1':entity('sparse-1','PointCloud','Sparse Point Cloud','products')
    };
    const opened={
      session:{sessionId:'visual',sourcePath:'/tmp/visual.hcad',workingPath:'/tmp/visual.hcad',usesLocalWorkingCopy:false,recoveryAvailable:false,readOnly:false,autosaveGeneration:0,lastSavedGeneration:0},
      manifest:{formatVersion:1,coordinateAxisContractVersion:2,projectId:'visual',name:'Visual Test Project',createdUnixMs:0,modifiedUnixMs:0,autosaveGeneration:0,commandSequence:0,cleanShutdown:true,spatialReference:{kind:'crsBacked'},rootEntity:'root',entities,renderOffset:{x:4375560,y:5281257,z:735},activeRuns:[]}
    };
    const defaults={delimiter:';',decimalSeparator:'comma',hasHeader:true,columns:{name:'0',east:'1',north:'2',height:'3'},role:'controlXyz',horizontalStddev:.02,heightStddev:.03};
    const photo=(number)=>({sourcePath:'/tmp/DJI_000'+number+'.JPG',format:'jpeg',byteSize:12000000,sha256:String(number).padStart(64,'0'),metadata:{exif:{make:'DJI',model:'M4E',focalLengthMm:12.29,dimensions:{widthPixels:5280,heightPixels:3956},gps:{latitudeDegrees:47.6657+number*.0001,longitudeDegrees:10.3414+number*.0001,altitude:{meters:783,semanticReference:'unknown'}}},djiXmp:{latitudeDegrees:47.6657+number*.0001,longitudeDegrees:10.3414+number*.0001,absoluteAltitude:{meters:783,semanticReference:'unknown'},gimbalAttitude:{yaw:65,pitch:-90,roll:0},rtk:{flag:'50',standardDeviationLongitudeMeters:.01,standardDeviationLatitudeMeters:.01,standardDeviationHeightMeters:.03}}}});
    const batch={photos:[photo(1),photo(2)],warnings:[]};
    const projectImage=(number)=>({entityId:'camera-'+number,name:'DJI_VISUAL_000'+number+'.JPG',metadataObjectHash:hash,metadata:{schemaVersion:1,sourceObjectHash:photo(number).sha256,transformationObjectHash:hash,inspectedPhoto:photo(number),projectedReference:{sourceLatitudeDegrees:47.6657+number*.0001,sourceLongitudeDegrees:10.3414+number*.0001,sourceHeightMeters:783,easting:4375560+number,northing:5281257+number,transformedHeightMeters:735,transformationDecisionSha256:hash},statusTags:['rtkFixed']}});
    const discovery={candidates:[{operationId:'visual-operation',name:'Explicit offline coordinate operation',kind:'general',projPipeline:'+proj=noop',areaOfUse:{westLongitude:-180,southLatitude:-90,eastLongitude:180,northLatitude:90},expectedAccuracyMm:1,ballpark:false,bestAvailable:true,requiredGrids:[]}],audit:{versions:{projVersion:'9.6.0',epsgDatabaseVersion:'12.004'}},warnings:[]};
    const preview={header:['Name','East','North','Height'],dataRowCount:2,validPointCount:2,previewRows:[{sourceLine:2,point:{name:'GCP-01',coordinate:{eastMeters:4375560.1,northMeters:5281257.2,heightMeters:735.3},role:'controlXyz',uncertainty:{horizontalStddevMeters:.02,heightStddevMeters:.03},code:'BP'},uncertaintyOrigin:{eastUsedDefault:true,northUsedDefault:true,heightUsedDefault:true}},{sourceLine:3,point:{name:'GCP-02',coordinate:{eastMeters:4375572.4,northMeters:5281268.5,heightMeters:736.1},role:'checkpointXyz',uncertainty:{horizontalStddevMeters:.02,heightStddevMeters:.03},code:'BP'},uncertaintyOrigin:{eastUsedDefault:true,northUsedDefault:true,heightUsedDefault:true}}],errors:[]};
    const productDataset={entityId:'sparse-1',kind:'sparse',relativePath:'products/sparse/metadata.json',format:'potreeV2',visible:false,boundsMin:[4375550,5281247,730],boundsMax:[4375570,5281267,740],renderOffset:[4375560,5281257,735],pointCount:10};
    const call=async(method)=>{
      if(method==='app.negotiate')return {selectedVersion:1,serverName:'visual-sidecar',serverVersion:'visual',sessionId:'visual-app-session',capabilities:['io.formats.read','io.probe','registration.import']};
      if(method==='canonical.project.open')return {};
      if(method==='photolab.hardware.probe')return {operatingSystem:'linux',cpu:{physicalCores:8,logicalCores:16,supportsAvx2:true},ramBytes:34359738368,dedicatedVramBytes:0};
      if(method==='photolab.images.inspect'){await new Promise(resolve=>setTimeout(resolve,1500));if(window.__photolabVisualInspectError)throw new Error('Visual image inspection failure');return batch;}
      if(method==='photolab.crs.discover')return discovery;
      if(method==='photolab.gcp.preview'){if(window.__photolabVisualGcpPreviewError)throw new Error('Visual GCP preview failure');return preview;}
      if(method==='photolab.images.list')return [projectImage(1),projectImage(2)];
      if(method==='photolab.images.quality.list'||method==='photolab.project.imageMask.list')return [];
      if(method==='photolab.products.list')return [productDataset];
      if(method==='photolab.jobs.list')return [{schemaVersion:1,id:'visual-depth',kind:'buildDepthMaps',origin:'job',configHash:hash,inputHash:hash,state:{kind:'running'},progress:{stage:{kind:'depthEstimation',index:1,stageCount:3,label:'Estimate depth'},metrics:{completedUnits:42,totalUnits:100,completedBytes:0}},createdAtUnixMs:0,startedAtUnixMs:0},{schemaVersion:1,id:'visual-archive',kind:'archiveSave',origin:'sideOperation',configHash:hash,inputHash:hash,state:{kind:'running'},progress:{stage:{kind:'featureExtraction',index:0,stageCount:1,label:'Writing archive'},metrics:{completedUnits:0,completedBytes:0}},createdAtUnixMs:0,startedAtUnixMs:0}];
      if(method==='photolab.project.processingSet.list'||method==='photolab.project.captureGroup.list'||method==='photolab.project.calibrationGroup.list'||method==='photolab.project.alignmentMerge.candidates'||method==='photolab.project.alignmentMerge.list'||method==='photolab.gcp.optimization.list')return [];
      if(method==='photolab.gcp.list'||method==='photolab.gcp.optimization.latest'||method==='photolab.gcp.calibrationReport')return null;
      if(method==='photolab.project.autosave')return {autosaveGeneration:0,lastSavedGeneration:0,dirty:false};
      if(method==='photolab.project.snapshot')return opened;
      throw new Error('Visual mock has no response for '+method);
    };
    Object.defineProperty(window,'himmelcad',{value:{
      version:'visual',platform:'linux',
      window:{minimize:async()=>{},maximizeToggle:async()=>{},close:async()=>{},retryClose:async()=>{},cancelClose:async()=>{},forceQuit:async()=>{},isMaximized:async()=>false,onMaximizeChange:()=>()=>{},onCloseBlocked:()=>()=>{}},
      sidecar:{status:async()=>true,call,onStderr:(listener)=>{window.__photolabVisualStderr=listener;return ()=>{window.__photolabVisualStderr=undefined}}},
      agentHarness:{request:async()=>({kind:'unavailable',reason:'visual audit mock'}),subscribe:()=>()=>{},subscribeProductApprovals:()=>()=>{},respondProductApproval:async()=>{}},
      providerCredentials:{status:async()=>({ok:true,value:{provider:'codex',state:'missing',persistentSupported:false,sessionOverride:false}}),replace:async()=>({ok:false,error:{code:'unsupported',message:'Unavailable in visual audit'}}),clearSession:async()=>({ok:true,value:{provider:'codex',state:'missing',persistentSupported:false,sessionOverride:false}}),delete:async()=>({ok:true,value:{provider:'codex',state:'missing',persistentSupported:false,sessionOverride:false}})},
      automationViewHost:{register:()=>()=>{}},
      preferences:{gcpCsv:{get:async()=>defaults,save:async()=>{}}},
      project:{bootstrap:async()=>({project:opened,recentProjects:[],untitledCleanupCount:0}),create:async()=>opened,open:async()=>opened,openRecent:async()=>opened,recent:async()=>[],removeRecent:async()=>[],reopenWithoutRecovery:async()=>opened,cleanupUntitled:async()=>0,save:async()=>opened,saveAs:async()=>opened,cancelArchive:async()=>({})},
      images:{selectFiles:async()=>['/tmp/DJI_0001.JPG','/tmp/DJI_0002.JPG'],selectFolder:async()=>['/tmp']},
      himmelcap:{selectFile:async()=>null},
      externalImport:{projectRoot:async()=>'/tmp/visual-project',selectFiles:async()=>[],openTransform:async()=>null,saveTransform:async()=>null,materialize:async(sessionId)=>({schemaVersion:1,sessionId,datasets:[]}),revoke:async()=>true,residency:async()=>({schemaVersion:1,entries:[]})},
      grids:{select:async()=>null},
      reference:{selectGcpCsv:async()=>'/tmp/visual-gcps.csv'},
      workflows:{defaultDir:async()=>'/tmp/visual-workflows',list:async()=>[],loadPath:async(path)=>({path,workflow:{}}),open:async()=>null,save:async()=>null},
      alignmentPresets:{defaultDir:async()=>'/tmp/visual-presets',list:async()=>[],loadPath:async(path)=>({path,preset:{}}),open:async()=>null,save:async()=>null},
      batch:{load:async()=>null,save:async()=>true},reports:{save:async()=>true},products:{export:async()=>({confirmation:{token:'visual-export',displayName:'Sparse Point Cloud'}}),confirmExport:async()=>({job:{id:'visual-export-job',kind:'exportProduct',state:{kind:'queued'},stages:[],createdUnixMs:0,updatedUnixMs:0,progress:{completedWork:0,totalWork:1,completedBytes:0,totalBytes:0}}}),cancelExport:async()=>{}}
    },configurable:false});
  })();`;
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('error', rejectRun);
    child.on('exit', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with code ${String(code)}`));
    });
  });
}
