import process from 'node:process';

import { chromium } from 'playwright-core';

const cdpUrl = process.env.HCAD_BUILDER_CDP_URL ?? 'http://127.0.0.1:9223';
const enforceBudget = process.argv.includes('--assert');
const browser = await chromium.connectOverCDP(cdpUrl);

try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => /(?:localhost|127\.0\.0\.1):5173/.test(candidate.url()));
  if (!page) throw new Error(`Builder page is not attached at ${cdpUrl}`);

  await page.waitForFunction(() => {
    const target = globalThis;
    return typeof target.__hcadBuilderViewingBoxDebug?.placeAtCameraTarget === 'function';
  });
  await page.evaluate(() => globalThis.__hcadBuilderViewingBoxDebug.placeAtCameraTarget());
  await page.waitForFunction(() => globalThis.__hcadBuilderViewingBoxDebug.handles()?.faces.length);

  const handles = await page.evaluate(() => globalThis.__hcadBuilderViewingBoxDebug.handles());
  const face = [...handles.faces].sort(
    (left, right) => right.pixelsPerWorldUnit - left.pixelsPerWorldUnit,
  )[0];
  if (!face) throw new Error('Viewing Box did not expose a draggable face handle');
  const start = {
    x: handles.host.left + face.point.x,
    y: handles.host.top + face.point.y,
  };
  const travel = 70;

  await page.evaluate(() => {
    performance.clearMarks();
    performance.clearMeasures();
    globalThis.__hcadViewingBoxFrameSamples = [];
    globalThis.__hcadViewingBoxSampling = true;
    let previous = performance.now();
    const sample = (timestamp) => {
      globalThis.__hcadViewingBoxFrameSamples.push(timestamp - previous);
      previous = timestamp;
      if (globalThis.__hcadViewingBoxSampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  let interactivePreviewCap = null;
  for (let index = 0; index < 120; index += 1) {
    const phase = Math.sin((index / 119) * Math.PI * 2);
    await page.mouse.move(
      start.x + face.screenAxis.x * travel * phase,
      start.y + face.screenAxis.y * travel * phase,
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    if (index === 60) {
      interactivePreviewCap = await page.evaluate(
        () =>
          globalThis.__hcadBuilderKernel.session.viewerState.publishedClipVolumes[0]?.previewCap ??
          null,
      );
    }
  }
  await page.mouse.up();
  await page.waitForTimeout(250);

  const result = await page.evaluate(() => {
    globalThis.__hcadViewingBoxSampling = false;
    const measures = performance
      .getEntriesByType('measure')
      .filter(
        (entry) => entry.name.includes('AppShell') || entry.name.includes('BuilderKernelViewport'),
      );
    return {
      frameIntervals: globalThis.__hcadViewingBoxFrameSamples,
      react: {
        renders: measures.length,
        totalMs: measures.reduce((total, entry) => total + entry.duration, 0),
        maximumMs: Math.max(0, ...measures.map((entry) => entry.duration)),
      },
      targetFrameMs:
        globalThis.__hcadBuilderKernel.session.diagnostics().hardwarePolicy.frame.targetFrameMs,
    };
  });
  const frames = summarize(result.frameIntervals.slice(5));
  const report = {
    frames,
    react: result.react,
    interactivePreviewCap,
    targetFrameMs: result.targetFrameMs,
  };
  console.log(JSON.stringify(report, null, 2));

  if (enforceBudget) {
    const maximumP95 = Math.max(55, result.targetFrameMs * 3.5);
    const failures = [];
    if (interactivePreviewCap !== false)
      failures.push('interactive cap generation was not disabled');
    if (result.react.renders > 6)
      failures.push(`drag caused ${result.react.renders} React renders`);
    if (result.react.totalMs > 60) {
      failures.push(`drag spent ${result.react.totalMs.toFixed(1)} ms in React`);
    }
    if (frames.p95Ms > maximumP95) {
      failures.push(`frame p95 ${frames.p95Ms.toFixed(1)} ms exceeds ${maximumP95.toFixed(1)} ms`);
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
  }
} finally {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => /(?:localhost|127\.0\.0\.1):5173/.test(candidate.url()));
  await page?.evaluate(() => globalThis.__hcadBuilderViewingBoxDebug?.remove());
  await browser.close();
}

function summarize(values) {
  if (values.length === 0) throw new Error('Viewing Box frame sampler returned no values');
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return {
    samples: sorted.length,
    meanMs: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maximumMs: sorted.at(-1),
  };
}
