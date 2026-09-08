import assert from 'node:assert/strict';

import { chromium } from 'playwright-core';

const cdpUrl = process.env.HCAD_BUILDER_CDP_URL ?? 'http://127.0.0.1:9223';
const browser = await chromium.connectOverCDP(cdpUrl);

try {
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) =>
    /(?:localhost|127\.0\.0\.1):5173/.test(candidate.url()),
  );
  if (!page) throw new Error(`Builder page is not attached at ${cdpUrl}`);
  const errors = [];
  page.on('pageerror', (error) => {
    const message = error.stack ?? error.message;
    if (message.trim()) errors.push(message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().trim()) errors.push(message.text());
  });

  await ready(page);
  const projectPath = await page.evaluate(() => globalThis.__hcadS08Debug.projectPath());
  assert.equal(typeof projectPath, 'string');
  await cameraHistoryEventually(page, 'clear');

  const before = await page.evaluate(() => globalThis.__hcadS08Debug.getState());
  await page.evaluate(async (state) => {
    let debug;
    let applied = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      debug = globalThis.__hcadS08Debug;
      try {
        await debug.setState({
          ...state,
          clipRefs: [],
          presentation: {
            ...state.presentation,
            background: 'white',
            pointSizeMultiplier: 1.37,
          },
        });
        applied = true;
        break;
      } catch (error) {
        if (!String(error).includes('disposed')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!debug || !applied) throw new Error('Builder view state did not become ready');
    debug.displayOverride('s08-persistence-probe', 'reference');
    await debug.displayFlush();
    debug.preset('perspective');
    debug.preset('top');
  }, before);
  await cameraHistoryEventually(page, 'get', (history) => history.entries.length > 0);
  const storedCamera = await page.evaluate(() => globalThis.__hcadS08Debug.getState().camera);

  const switched = await page.evaluate(async ({ projectPath }) => {
    const debug = globalThis.__hcadS08Debug;
    await debug.displayOpenProject('s08-temporary-project');
    const temporary = debug.displaySnapshot();
    await debug.displayOpenProject(projectPath);
    const restored = debug.displaySnapshot();
    return { temporary, restored };
  }, { projectPath });
  assert.equal(switched.temporary.state.presentation.pointSizeMultiplier, 1);
  assert.equal(switched.temporary.state.overrides['s08-persistence-probe'], undefined);
  assert.equal(switched.restored.state.presentation.pointSizeMultiplier, 1.37);
  assert.equal(switched.restored.state.overrides['s08-persistence-probe'], 'reference');
  const cameraStorageBeforeReload = await page.evaluate(() =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key.includes('camera'))
        .map((key) => [key, JSON.parse(localStorage.getItem(key))]),
    ),
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.waitForTimeout(3_000);
  await ready(page);
  const reloaded = await page.evaluate(() => ({
    state: globalThis.__hcadS08Debug.getState(),
    display: globalThis.__hcadS08Debug.displaySnapshot(),
  }));
  assert.equal(reloaded.state.presentation.pointSizeMultiplier, 1.37);
  assert.equal(reloaded.state.presentation.background, 'white');
  assert.equal(reloaded.display.state.overrides['s08-persistence-probe'], 'reference');
  assertCameraClose(reloaded.state.camera, storedCamera, cameraStorageBeforeReload);

  let quality = await page.evaluate(() => globalThis.__hcadS08Debug.quality());
  assert(quality && quality.class && quality.tier && quality.targets.motionFrameMs > 0);
  await measure(page, false, 2_000);
  const offWindows = [await measure(page, false, 5_000)];
  const onWindows = [await measure(page, true, 5_000)];
  const off = combine(offWindows);
  const on = combine(onWindows);
  const deltaMs = on.p95 - off.p95;
  console.log(JSON.stringify({ hudWindows: { off: offWindows, on: onWindows } }));
  await page.evaluate(() => globalThis.__hcadS08Debug.setHud(true));
  await page.waitForFunction(() => {
    const quality = globalThis.__hcadS08Debug.quality();
    const text = document.querySelector('output[aria-label="Viewport diagnostics"]')?.textContent ?? '';
    return Boolean(quality && text.includes(`quality ${quality.class}-${quality.tier}`));
  });
  const finalHud = await page.evaluate(() => ({
    quality: globalThis.__hcadS08Debug.quality(),
    text: document.querySelector('output[aria-label="Viewport diagnostics"]')?.textContent ?? '',
  }));
  quality = finalHud.quality;
  const hudText = finalHud.text;
  assert.match(hudText ?? '', new RegExp(`quality\\s+${quality.class}-${quality.tier}`));
  assert.deepEqual(errors, [], `Builder emitted browser errors:\n${errors.join('\n')}`);

  console.log(JSON.stringify({
    ok: true,
    harness: 'Electron CDP + real sidecar',
    projectSwitchPersistence: true,
    rendererReloadPersistence: true,
    cameraReloadPersistence: true,
    quality: `${quality.class}-${quality.tier}`,
    targetMs: quality.targets.motionFrameMs,
    hudOffPresentedP95Ms: off.p95,
    hudOnPresentedP95Ms: on.p95,
    hudDevelopmentHostDiagnosticP95DeltaMs: deltaMs,
    samples: { off: off.samples, on: on.samples },
  }, null, 2));
} finally {
  await browser.close();
}

async function ready(page) {
  await page.waitForFunction(
    () => {
      try {
        return Boolean(
          globalThis.__hcadS08Debug?.projectPath() &&
          globalThis.__hcadBuilderKernel?.session &&
          globalThis.__hcadS08Debug.getState().version === 2
        );
      } catch {
        return false;
      }
    },
    null,
    { timeout: 30_000 },
  );
  await cameraHistoryEventually(page, 'get');
}

async function cameraHistoryEventually(page, action, accept = () => true) {
  const deadline = Date.now() + 30_000;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    const result = await page.evaluate(async ({ action }) => {
      try {
        return { ok: true, value: await globalThis.__hcadS08Debug.cameraHistory(action) };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    }, { action });
    if (result.ok && accept(result.value)) return result.value;
    lastError = result.ok ? 'result was not accepted' : result.error;
    await page.waitForTimeout(100);
  }
  throw new Error(`Camera history ${action} did not become ready: ${lastError}`);
}

async function measure(page, hudVisible, durationMs = 1_500) {
  return await page.evaluate(async ({ hudVisible, durationMs }) => {
    const debug = globalThis.__hcadS08Debug;
    debug.setHud(hudVisible);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const samplePromise = debug.sampleDiagnostics(durationMs);
    const deadline = performance.now() + durationMs + 50;
    let frame = 0;
    while (performance.now() < deadline) {
      globalThis.__hcadBuilderKernel.session.setPointSize(1.37 + (frame++ % 2) * 1e-6);
      globalThis.__hcadBuilderKernel.requestFrame();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const sample = await samplePromise;
    return {
      p95: sample.presentedFrameIntervalMs.p95,
      samples: sample.presentedFrameIntervalMs.samples,
    };
  }, { hudVisible, durationMs });
}

function combine(windows) {
  const p95s = windows.map((window) => window.p95).sort((left, right) => left - right);
  return {
    p95: p95s[Math.floor(p95s.length / 2)],
    samples: windows.reduce((total, window) => total + window.samples, 0),
  };
}

function assertCameraClose(actual, expected, storage) {
  for (const key of ['position', 'target', 'up']) {
    for (const axis of ['x', 'y', 'z']) {
      assert(
        Math.abs(actual[key][axis] - expected[key][axis]) < 1e-6,
        `${key}.${axis} changed: ${expected[key][axis]} -> ${actual[key][axis]}; storage=${JSON.stringify(storage)}`,
      );
    }
  }
  assert.deepEqual(actual.projection, expected.projection);
}
