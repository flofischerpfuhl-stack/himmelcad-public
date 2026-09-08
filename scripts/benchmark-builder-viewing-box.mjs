import process from 'node:process';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, freemem, loadavg, tmpdir, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';

import { chromium } from 'playwright-core';

const args = parseArguments(process.argv.slice(2));
const cdpUrl = args.cdp ?? process.env.HCAD_BUILDER_CDP_URL ?? 'http://127.0.0.1:9223';
const enforceBudget = process.argv.includes('--assert');
const metadataPath = args.metadata ?? process.env.HCAD_VIEWING_BOX_METADATA
  ? resolve(args.metadata ?? process.env.HCAD_VIEWING_BOX_METADATA)
  : null;
const machineAtStart = machineSnapshot();
const datasetServer = metadataPath ? await servePreparedDataset(dirname(metadataPath)) : null;
let developmentProcess = null;
let browser = null;

try {
  if (!(await cdpAvailable(cdpUrl))) {
    if (args.noLaunch) {
      throw new Error(
        `Builder CDP endpoint ${cdpUrl} is not available; omit --no-launch to start it`,
      );
    }
    developmentProcess = await launchBuilder();
    await waitForCdp(cdpUrl, developmentProcess);
  }
  browser = await chromium.connectOverCDP(cdpUrl);
  const page = await waitForBuilderPage(browser, developmentProcess);

  await page.waitForFunction(() => {
    const target = globalThis;
    return typeof target.__hcadBuilderViewingBoxDebug?.placeAtCameraTarget === 'function';
  });
  let dataset = null;
  if (metadataPath) {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const metadataUrl = `${datasetServer.origin}/metadata.json`;
    const position = metadata.attributes?.find(
      (attribute) => String(attribute.name).toLowerCase() === 'position',
    );
    const framingBounds =
      Array.isArray(position?.min) && Array.isArray(position?.max)
        ? { min: position.min, max: position.max }
        : metadata.boundingBox;
    dataset = {
      metadataPath,
      pointCount: metadata.points,
      bounds: metadata.boundingBox,
      framingBounds,
    };
    await page.evaluate(
      async ({ metadataUrl, bounds, pointCount, rawSourceContentHash }) => {
        await globalThis.__hcadBuilderViewingBoxDebug.loadPrepared(
          metadataUrl,
          bounds,
          pointCount,
          rawSourceContentHash,
        );
      },
      {
        metadataUrl,
        bounds: framingBounds,
        pointCount: metadata.points,
        rawSourceContentHash:
          process.env.HCAD_VIEWING_BOX_SOURCE_HASH ??
          '40ab61b68759d936553c5050f9be3ad84793e349828dfd5504472c0caec859f7',
      },
    );
    await page.waitForFunction(
      () => {
        const stages =
          globalThis.__hcadBuilderKernel.session.diagnostics().streaming.residencyStageCounts;
        return (
          stages.resident > 0 &&
          stages.fetching +
            stages.queuedDecode +
            stages.decoding +
            stages.queuedUpload +
            stages.uploading ===
            0
        );
      },
      null,
      { timeout: 120_000 },
    );
  }
  const hadBox = await page.evaluate(() =>
    Boolean(globalThis.__hcadBuilderViewingBoxDebug?.handles?.()?.faces.length),
  );
  if (!hadBox) {
    await page.evaluate(() => globalThis.__hcadBuilderViewingBoxDebug.placeAtCameraTarget());
  }
  await page.waitForFunction(
    () => globalThis.__hcadBuilderViewingBoxDebug?.handles?.()?.faces.length,
  );
  await page.evaluate(() => globalThis.__hcadS08Debug.viewingBoxFlush());
  const closedChip = page.getByRole('button', { name: /^Open viewing box /i });
  if ((await closedChip.count()) > 0) await closedChip.first().click();
  await page.waitForFunction(() => {
    const chip = document.querySelector('[aria-label^="Open viewing box "]');
    return chip === null;
  });

  const handles = await page.evaluate(() => globalThis.__hcadBuilderViewingBoxDebug.handles());
  const face = [...handles.faces].sort(
    (left, right) => right.pixelsPerWorldUnit - left.pixelsPerWorldUnit,
  )[0];
  if (!face) throw new Error('Viewing Box did not expose a draggable face handle');
  const start = {
    x: handles.host.left + face.point.x,
    y: handles.host.top + face.point.y,
  };
  const oppositeFace = handles.faces.find(
    (candidate) => candidate.axis === face.axis && candidate.face === -face.face,
  );
  if (!oppositeFace) throw new Error('Viewing Box did not expose the anchored opposite face');
  const oppositeStart = {
    x: handles.host.left + oppositeFace.point.x,
    y: handles.host.top + oppositeFace.point.y,
  };
  const travel = 70;

  const revisionBefore = await page.evaluate(
    () => globalThis.__hcadS08Debug?.viewingBoxes?.()[0]?.[1] ?? null,
  );
  await page.evaluate(() => {
    performance.clearMarks();
    performance.clearMeasures();
    globalThis.__hcadViewingBoxFrameSample = globalThis.__hcadS08Debug.sampleDiagnostics(2_500);
  });

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  let interactivePreviewCap = null;
  let revisionDuring = revisionBefore;
  let maximumGripCursorErrorPx = 0;
  let maximumOppositeFaceDriftPx = 0;
  let maximumGripStepExcessPx = 0;
  let previousGripSample = start;
  let previousCursorSample = start;
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
          const opposite = next.faces.find(
            (candidate) => candidate.axis === axis && candidate.face === -side,
          );
          return face && opposite
            ? {
                face: { x: next.host.left + face.point.x, y: next.host.top + face.point.y },
                opposite: {
                  x: next.host.left + opposite.point.x,
                  y: next.host.top + opposite.point.y,
                },
              }
            : null;
        },
        { axis: face.axis, side: face.face },
      );
      if (!current) throw new Error('active Viewing Box grip disappeared during drag');
      maximumGripCursorErrorPx = Math.max(
        maximumGripCursorErrorPx,
        Math.hypot(
          current.face.x - (start.x + face.screenAxis.x * travel * phase),
          current.face.y - (start.y + face.screenAxis.y * travel * phase),
        ),
      );
      maximumOppositeFaceDriftPx = Math.max(
        maximumOppositeFaceDriftPx,
        Math.hypot(current.opposite.x - oppositeStart.x, current.opposite.y - oppositeStart.y),
      );
      const cursorSample = {
        x: start.x + face.screenAxis.x * travel * phase,
        y: start.y + face.screenAxis.y * travel * phase,
      };
      maximumGripStepExcessPx = Math.max(
        maximumGripStepExcessPx,
        Math.hypot(
          current.face.x - previousGripSample.x,
          current.face.y - previousGripSample.y,
        ) -
          Math.hypot(
            cursorSample.x - previousCursorSample.x,
            cursorSample.y - previousCursorSample.y,
          ),
      );
      previousGripSample = current.face;
      previousCursorSample = cursorSample;
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
  const faceSamples = [result.diagnosticsSample];
  for (let run = 1; run < 5; run += 1) {
    faceSamples.push(await measureFaceDrag(page, 2_500));
  }
  const faceFrames = summarizeFrameRuns(faceSamples);

  await page.getByRole('button', { name: 'Rotate', exact: true }).first().click();
  await page.evaluate(() => globalThis.__hcadS08Debug.viewingBoxFlush());
  await page.waitForFunction(
    () => (globalThis.__hcadBuilderViewingBoxDebug?.handles?.()?.rings.length ?? 0) > 0,
  );
  const ringSamples = [];
  const orbitSamples = [];
  for (let run = 0; run < 5; run += 1) {
    ringSamples.push(await measureRingDrag(page, 2_500));
    orbitSamples.push(await measureOrbit(page, 2_500));
  }
  const frames = {
    faceDrag: faceFrames,
    ringDrag: summarizeFrameRuns(ringSamples),
    unlockedOrbit: summarizeFrameRuns(orbitSamples),
  };
  let lockParity = null;
  if (metadataPath) {
    // Keep the bake resident and genuinely small while still filtering every
    // node of the 104 M-point source. The embedded CAD line crosses the box.
    await page.evaluate(() => globalThis.__hcadBuilderViewingBoxDebug.scaleForBake(0.35));
    await page.evaluate(() => globalThis.__hcadS08Debug.viewingBoxFlush());
    const startedAt = performance.now();
    await page.evaluate(() => globalThis.__hcadS08Debug.lockViewingBox(true));
    await page.evaluate(() => globalThis.__hcadS08Debug.viewingBoxFlush());
    const bakeDurationMs = performance.now() - startedAt;
    const lockedRuns = [];
    const nativeSmallRuns = [];
    for (let run = 0; run < 5; run += 1) {
      lockedRuns.push(await measureOrbit(page, 2_500, true));
      nativeSmallRuns.push(await measureOrbit(page, 2_500, false));
    }
    await page.evaluate(() => globalThis.__hcadBuilderViewingBoxDebug.setClipActive(true));
    const lockedSurface = await page.evaluate(() => {
      const state = globalThis.__hcadS08Debug.viewingBox();
      const volume = globalThis.__hcadBuilderKernel.session.viewerState.publishedClipVolumes.find(
        (candidate) => candidate.id === state?.id,
      );
      return {
        state,
        clip: volume
          ? { enabled: volume.enabled, planeCount: volume.planes.length, operation: volume.operation }
          : null,
      };
    });
    const lockedP95Ms = median(
      lockedRuns.map((sample) => sample.presentedFrameIntervalMs.p95),
    );
    const nativeSmallP95Ms = median(
      nativeSmallRuns.map((sample) => sample.presentedFrameIntervalMs.p95),
    );
    lockParity = {
      bakeExtentScale: 0.35,
      pointCount:
        lockedSurface.state?.bakedSources?.reduce((sum, source) => sum + source.pointCount, 0) ??
        null,
      bakeDurationMs,
      lockedP95Ms,
      nativeSmallP95Ms,
      ratio: lockedP95Ms / Math.max(0.000_001, nativeSmallP95Ms),
      lockedP95RunsMs: lockedRuns.map((sample) => sample.presentedFrameIntervalMs.p95),
      nativeSmallP95RunsMs: nativeSmallRuns.map(
        (sample) => sample.presentedFrameIntervalMs.p95,
      ),
      presentSource: lockedRuns.at(-1)?.presentSource ?? null,
      lockedPrimitives: lockedRuns.at(-1)?.lastFrames.at(-1)?.primitives ?? null,
      nativeSmallPrimitives: nativeSmallRuns.at(-1)?.lastFrames.at(-1)?.primitives ?? null,
      nonPointClip: lockedSurface.clip,
      comparison:
        'same baked frontier dataset plus canonical CAD curve, with box clip active versus inactive',
    };
  }

  const report = {
    measuredAt: new Date().toISOString(),
    machine: {
      state:
        process.env.HCAD_VIEWING_BOX_MACHINE_STATE ??
        'not declared; load snapshots are authoritative and asserted runs require an idle host',
      logicalCpus: cpus().length,
      start: machineAtStart,
      end: machineSnapshot(),
    },
    dataset,
    frames,
    react: result.react,
    interactivePreviewCap,
    targetFrameMs: result.targetFrameMs,
    presentSource: result.diagnosticsSample.presentSource,
    maximumGripCursorErrorPx,
    maximumOppositeFaceDriftPx,
    maximumGripStepExcessPx,
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
    lockParity,
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
    for (const [scenario, sample] of Object.entries(frames)) {
      if (sample.p95Ms > maximumP95) {
        failures.push(
          `${scenario} frame p95 ${sample.p95Ms.toFixed(1)} ms exceeds ${maximumP95.toFixed(1)} ms`,
        );
      }
    }
    if (maximumGripCursorErrorPx > 1) {
      failures.push(`grip drift ${maximumGripCursorErrorPx.toFixed(2)} px exceeds 1 px`);
    }
    if (maximumOppositeFaceDriftPx > 1) {
      failures.push(
        `opposite-face drift ${maximumOppositeFaceDriftPx.toFixed(2)} px exceeds 1 px`,
      );
    }
    if (maximumGripStepExcessPx > 1) {
      failures.push(
        `grip step exceeded cursor travel by ${maximumGripStepExcessPx.toFixed(2)} px`,
      );
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
    if (metadataPath && (lockParity?.pointCount ?? 0) <= 0) {
      failures.push('lock did not produce a resident reduced point dataset');
    }
    if (
      metadataPath &&
      ((lockParity?.lockedPrimitives?.lines ?? 0) <= 0 ||
        (lockParity?.nativeSmallPrimitives?.lines ?? 0) <= 0)
    ) {
      failures.push('VB-D8 comparison did not retain mixed canonical CAD content');
    }
    if (
      metadataPath &&
      (lockParity?.nonPointClip?.enabled !== true || lockParity.nonPointClip.planeCount !== 6)
    ) {
      failures.push('VB-D8 mixed scene did not retain the six-plane non-point clip');
    }
    if (metadataPath && (lockParity?.ratio ?? Number.POSITIVE_INFINITY) > 1.1) {
      failures.push(`locked/native-small ratio ${lockParity.ratio.toFixed(3)} exceeds 1.1`);
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
  }
} finally {
  await datasetServer?.close();
  if (developmentProcess !== null) await stopBuilder(developmentProcess);
  // connectOverCDP() owns only its transport. Auto-launched Builder is stopped
  // above; --no-launch deliberately leaves the caller-owned app running.
  await browser?.close().catch(() => undefined);
}

function parseArguments(values) {
  const parsed = { cdp: null, metadata: null, noLaunch: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--assert') continue;
    if (value === '--no-launch') parsed.noLaunch = true;
    else if (value === '--cdp') parsed.cdp = requiredValue(values, ++index, value);
    else if (value === '--metadata') parsed.metadata = requiredValue(values, ++index, value);
    else if (value === '--help') {
      console.log(`Usage: node scripts/benchmark-builder-viewing-box.mjs [options]

  --metadata <metadata.json>  Prepared Potree 2 dataset; enables VB-D8
  --cdp <url>                 Builder CDP endpoint (default: http://127.0.0.1:9223)
  --no-launch                 Require an already running Builder
  --assert                    Enforce VB-D7, VB-D8, grip-stability, and P5 gates`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

function requiredValue(values, index, option) {
  const value = values[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} needs a value`);
  return value;
}

async function launchBuilder() {
  const userDataDirectory = await mkdtemp(resolve(tmpdir(), 'hcad-viewing-box-'));
  const child = spawn('pnpm', ['--filter', '@himmelcad/builder', 'dev'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      HIMMELCAD_GPU: process.env.HIMMELCAD_GPU?.trim() || 'nvidia',
      HIMMELCAD_VITE_HMR: '0',
      HIMMELCAD_REMOTE_DEBUGGING_PORT: '9223',
      HIMMELCAD_ELECTRON_USER_DATA_DIR: userDataDirectory,
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.userDataDirectory = userDataDirectory;
  child.outputTail = '';
  const remember = (chunk) => {
    child.outputTail = `${child.outputTail}${String(chunk)}`.slice(-12_000);
  };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  return child;
}

async function cdpAvailable(url) {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(url, child) {
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Builder exited before CDP became ready (code ${child.exitCode}, signal ${child.signalCode}): ${child.outputTail}`,
      );
    }
    if (await cdpAvailable(url)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Builder did not expose ${url} within 900 seconds: ${child.outputTail}`);
}

async function waitForBuilderPage(connectedBrowser, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child !== null && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(
        `Builder exited before its renderer page attached (code ${child.exitCode}, signal ${child.signalCode}): ${child.outputTail}`,
      );
    }
    const page = connectedBrowser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => /(?:localhost|127\.0\.0\.1):5173/.test(candidate.url()));
    if (page) return page;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  const urls = connectedBrowser
    .contexts()
    .flatMap((context) => context.pages())
    .map((candidate) => candidate.url());
  const output = child?.outputTail ? ` Builder output: ${child.outputTail}` : '';
  throw new Error(
    `Builder renderer page was not attached within 120 seconds (pages: ${JSON.stringify(urls)}).${output}`,
  );
}

async function stopBuilder(child) {
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null) child.kill('SIGTERM');
    } else if (child.pid !== undefined) {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolvePromise) => child.once('exit', resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
    ]);
  }
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 0);
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  if (child.userDataDirectory) {
    await rm(child.userDataDirectory, { recursive: true, force: true });
  }
}

async function servePreparedDataset(root) {
  const files = new Map([
    ['/metadata.json', resolve(root, 'metadata.json')],
    ['/hierarchy.bin', resolve(root, 'hierarchy.bin')],
    ['/octree.bin', resolve(root, 'octree.bin')],
  ]);
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Headers': 'Range',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Origin': '*',
        });
        response.end();
        return;
      }
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const file = files.get(pathname);
      if (!file || !['GET', 'HEAD'].includes(request.method ?? '')) {
        response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        response.end();
        return;
      }
      const details = await stat(file);
      const range = parseRange(request.headers.range, details.size);
      const start = range?.start ?? 0;
      const end = range?.end ?? details.size - 1;
      response.writeHead(range ? 206 : 200, {
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
        'Content-Length': String(Math.max(0, end - start + 1)),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${details.size}` } : {}),
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      createReadStream(file, { start, end }).pipe(response);
    } catch (error) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('prepared dataset server has no port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) throw new Error(`unsupported byte range: ${header}`);
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size) {
    throw new Error(`invalid byte range: ${header}`);
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function summarizeFrames(sample) {
  return {
    samples: sample.presentedFrameIntervalMs.samples,
    p50Ms: sample.presentedFrameIntervalMs.p50,
    p95Ms: sample.presentedFrameIntervalMs.p95,
    p99Ms: sample.presentedFrameIntervalMs.p99,
    maximumMs: sample.presentedFrameIntervalMs.maximum,
  };
}

function summarizeFrameRuns(samples) {
  const p95RunsMs = samples.map((sample) => sample.presentedFrameIntervalMs.p95);
  const p95Ms = median(p95RunsMs);
  const representative = [...samples].sort(
    (left, right) =>
      Math.abs(left.presentedFrameIntervalMs.p95 - p95Ms) -
      Math.abs(right.presentedFrameIntervalMs.p95 - p95Ms),
  )[0];
  return { ...summarizeFrames(representative), p95Ms, p95RunsMs };
}

function median(values) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function machineSnapshot() {
  return {
    loadAverage: loadavg(),
    memoryGiB: {
      total: totalmem() / 2 ** 30,
      free: freemem() / 2 ** 30,
    },
  };
}

async function measureOrbit(page, durationMs, clipActive) {
  return await page.evaluate(
    async ({ durationMs, clipActive }) => {
      if (typeof clipActive === 'boolean') {
        globalThis.__hcadBuilderViewingBoxDebug.setClipActive(clipActive);
      }
      const handle = globalThis.__hcadBuilderKernel;
      const sample = handle.session.sampleDiagnostics(durationMs);
      const initial = handle.camera.worldCamera();
      const dx = initial.eye.x - initial.target.x;
      const dy = initial.eye.y - initial.target.y;
      for (let index = 0; index < 150; index += 1) {
        const angle = ((index + 1) / 150) * Math.PI * 0.35;
        handle.session.adoptWorldCamera({
          ...initial,
          eye: {
            x: initial.target.x + dx * Math.cos(angle) - dy * Math.sin(angle),
            y: initial.target.y + dx * Math.sin(angle) + dy * Math.cos(angle),
            z: initial.eye.z,
          },
        });
        handle.requestFrame();
        await handle.session.waitForNextPresentedFrame();
      }
      const result = await sample;
      handle.session.adoptWorldCamera(initial);
      handle.requestFrame();
      await handle.session.waitForNextPresentedFrame();
      return result;
    },
    { durationMs, clipActive },
  );
}

async function measureFaceDrag(page, durationMs) {
  const handles = await page.evaluate(() => globalThis.__hcadBuilderViewingBoxDebug.handles());
  const face = [...handles.faces].sort(
    (left, right) => right.pixelsPerWorldUnit - left.pixelsPerWorldUnit,
  )[0];
  if (!face) throw new Error('Viewing Box face handle disappeared between cadence runs');
  const start = { x: handles.host.left + face.point.x, y: handles.host.top + face.point.y };
  await page.evaluate((duration) => {
    globalThis.__hcadViewingBoxRepeatFrameSample =
      globalThis.__hcadS08Debug.sampleDiagnostics(duration);
  }, durationMs);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let index = 0; index < 120; index += 1) {
    const phase = Math.sin((index / 119) * Math.PI * 2);
    await page.mouse.move(
      start.x + face.screenAxis.x * 70 * phase,
      start.y + face.screenAxis.y * 70 * phase,
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  await page.mouse.up();
  await page.evaluate(() => globalThis.__hcadS08Debug.viewingBoxFlush());
  return await page.evaluate(() => globalThis.__hcadViewingBoxRepeatFrameSample);
}

async function measureRingDrag(page, durationMs) {
  const handles = await page.evaluate(() => globalThis.__hcadBuilderViewingBoxDebug.handles());
  const ring = handles.rings
    .map((candidate) => ({
      ...candidate,
      point: [...candidate.points].sort(
        (left, right) =>
          Math.hypot(right.x - candidate.center.x, right.y - candidate.center.y) -
          Math.hypot(left.x - candidate.center.x, left.y - candidate.center.y),
      )[0],
    }))
    .sort(
      (left, right) =>
        Math.hypot(right.point.x - right.center.x, right.point.y - right.center.y) -
        Math.hypot(left.point.x - left.center.x, left.point.y - left.center.y),
    )[0];
  if (!ring?.point) throw new Error('Viewing Box did not expose a draggable rotation ring');
  const start = { x: handles.host.left + ring.point.x, y: handles.host.top + ring.point.y };
  const vector = { x: ring.point.x - ring.center.x, y: ring.point.y - ring.center.y };
  await page.evaluate((duration) => {
    globalThis.__hcadViewingBoxRepeatFrameSample =
      globalThis.__hcadS08Debug.sampleDiagnostics(duration);
  }, durationMs);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let index = 0; index < 120; index += 1) {
    const angle = Math.sin((index / 119) * Math.PI * 2) * 0.55;
    await page.mouse.move(
      handles.host.left +
        ring.center.x +
        vector.x * Math.cos(angle) -
        vector.y * Math.sin(angle),
      handles.host.top +
        ring.center.y +
        vector.x * Math.sin(angle) +
        vector.y * Math.cos(angle),
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  await page.mouse.up();
  await page.evaluate(() => globalThis.__hcadS08Debug.viewingBoxFlush());
  return await page.evaluate(() => globalThis.__hcadViewingBoxRepeatFrameSample);
}
