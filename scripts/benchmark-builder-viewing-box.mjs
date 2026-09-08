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
  const hadBox = await page.evaluate(() =>
    Boolean(globalThis.__hcadBuilderViewingBoxDebug.handles()?.faces.length),
  );
  if (!hadBox) {
    await page.evaluate(() => globalThis.__hcadBuilderViewingBoxDebug.placeAtCameraTarget());
  }
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

  const revisionBefore = await page.evaluate(
    () => globalThis.__hcadS08Debug?.viewingBoxes?.()[0]?.[1] ?? null,
  );
  await page.evaluate(() => {
    performance.clearMarks();
    performance.clearMeasures();
    globalThis.__hcadViewingBoxFrameSample = globalThis.__hcadS08Debug.sampleDiagnostics(1_000);
  });

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  let interactivePreviewCap = null;
  let revisionDuring = revisionBefore;
  let maximumGripCursorErrorPx = 0;
  for (let index = 0; index < 120; index += 1) {
    const phase = Math.sin((index / 119) * Math.PI * 2);
    await page.mouse.move(
      start.x + face.screenAxis.x * travel * phase,
      start.y + face.screenAxis.y * travel * phase,
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    if (index % 10 === 0) {
      const current = await page.evaluate(
        ({ axis, side }) => {
          const next = globalThis.__hcadBuilderViewingBoxDebug.handles();
          const face = next.faces.find(
            (candidate) => candidate.axis === axis && candidate.face === side,
          );
          return face
            ? { x: next.host.left + face.point.x, y: next.host.top + face.point.y }
            : null;
        },
        { axis: face.axis, side: face.face },
      );
      if (!current) throw new Error('active Viewing Box grip disappeared during drag');
      maximumGripCursorErrorPx = Math.max(
        maximumGripCursorErrorPx,
        Math.hypot(
          current.x - (start.x + face.screenAxis.x * travel * phase),
          current.y - (start.y + face.screenAxis.y * travel * phase),
        ),
      );
    }
    if (index === 60) {
      const midpoint = await page.evaluate(() => ({
        previewCap:
          globalThis.__hcadBuilderKernel.session.viewerState.publishedClipVolumes[0]?.previewCap ??
          null,
        revision: globalThis.__hcadS08Debug?.viewingBoxes?.()[0]?.[1] ?? null,
      }));
      interactivePreviewCap = midpoint.previewCap;
      revisionDuring = midpoint.revision;
    }
  }
  await page.mouse.up();
  await page.waitForTimeout(250);

  const result = await page.evaluate(async () => {
    const diagnosticsSample = await globalThis.__hcadViewingBoxFrameSample;
    const measures = performance
      .getEntriesByType('measure')
      .filter(
        (entry) => entry.name.includes('AppShell') || entry.name.includes('BuilderKernelViewport'),
      );
    return {
      diagnosticsSample,
      react: {
        renders: measures.length,
        totalMs: measures.reduce((total, entry) => total + entry.duration, 0),
        maximumMs: Math.max(0, ...measures.map((entry) => entry.duration)),
      },
      targetFrameMs: globalThis.__hcadS08Debug.quality().targets.motionFrameMs,
      revisionAfter: globalThis.__hcadS08Debug?.viewingBoxes?.()[0]?.[1] ?? null,
    };
  });
  const frames = {
    samples: result.diagnosticsSample.presentedFrameIntervalMs.samples,
    p50Ms: result.diagnosticsSample.presentedFrameIntervalMs.p50,
    p95Ms: result.diagnosticsSample.presentedFrameIntervalMs.p95,
    p99Ms: result.diagnosticsSample.presentedFrameIntervalMs.p99,
    maximumMs: result.diagnosticsSample.presentedFrameIntervalMs.maximum,
  };
  const report = {
    frames,
    react: result.react,
    interactivePreviewCap,
    targetFrameMs: result.targetFrameMs,
    presentSource: result.diagnosticsSample.presentSource,
    maximumGripCursorErrorPx,
    journal: {
      revisionBefore,
      revisionDuring,
      revisionAfter: result.revisionAfter,
      writesDuringDrag:
        revisionBefore === null || revisionDuring === null ? null : revisionDuring - revisionBefore,
      writesAtCompletion:
        revisionBefore === null || result.revisionAfter === null
          ? null
          : result.revisionAfter - revisionBefore,
    },
  };
  console.log(JSON.stringify(report, null, 2));

  if (enforceBudget) {
    const maximumP95 = result.targetFrameMs * 2;
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
    if (maximumGripCursorErrorPx > 1) {
      failures.push(`grip drift ${maximumGripCursorErrorPx.toFixed(2)} px exceeds 1 px`);
    }
    if (revisionBefore !== null && revisionDuring !== revisionBefore) {
      failures.push('grip drag journal advanced before pointer-up');
    }
    if (
      revisionBefore !== null &&
      result.revisionAfter !== null &&
      result.revisionAfter !== revisionBefore + 1
    ) {
      failures.push('grip drag did not produce exactly one journal revision');
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
  }
} finally {
  await browser.close();
}
