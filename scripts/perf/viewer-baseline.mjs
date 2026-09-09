#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright-core';

const REPO = resolve(import.meta.dirname, '../..');
const OUTPUT_DIRECTORY = resolve(REPO, '.build/perf');
const DEFAULT_DATASET = resolve(
  REPO,
  'libs/polyshapev01/dist/PW_GHT_251215_Orscholz_Deponie-1-1.las',
);
const POTREE_CONVERTER = resolve(REPO, 'vendor/potreeconverter/linux-x64/PotreeConverter');
const args = parseArguments(process.argv.slice(2));
const date = args.date ?? new Intl.DateTimeFormat('en-CA').format(new Date());
const builderGpuPreference = process.env.HIMMELCAD_GPU?.trim() || 'nvidia';
const outputStem = resolve(
  OUTPUT_DIRECTORY,
  `${args.frontierOnly ? 'viewer-frontier-orbit' : 'viewer-baseline'}-${date}`,
);
const report = {
  schemaVersion: 4,
  mode: args.frontierOnly ? 'frontier-only' : 'timed-baseline',
  generatedAt: new Date().toISOString(),
  status: 'running',
  measurement: {
    path: 'Builder Electron browser-gpu over Chrome DevTools Protocol',
    presentedInterval: 'VC-D1 rAF-render-complete presented-frame pairing',
    presentSource: 'raf-render-complete',
    gpuTiming:
      'asynchronous WebGPU timestamp query correlated by submission sequence when supported',
    caveat:
      'The present source proves a successful kernel surface present paired to its scheduling rAF; it does not claim OS compositor/display timing.',
  },
  host: hostInventory(),
  dataset: null,
  browser: null,
  paths: [],
  frontierOrbit: null,
  aggregate: null,
  blocker: null,
  tracePath: null,
};

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
let developmentProcess = null;
let browser = null;

try {
  const prepared = await prepareDataset(resolve(args.dataset ?? DEFAULT_DATASET), args.metadata);
  report.dataset = prepared;
  const cdpUrl = args.cdp ?? 'http://127.0.0.1:9223';
  if (!(await cdpAvailable(cdpUrl))) {
    if (args.noLaunch) {
      throw new Error(
        `Builder CDP endpoint ${cdpUrl} is not available; start \`pnpm --filter @himmelcad/builder dev\` or omit --no-launch`,
      );
    }
    developmentProcess = await launchBuilder();
    await waitForCdp(cdpUrl, developmentProcess);
  }

  browser = await chromium.connectOverCDP(cdpUrl);
  const page = await waitForBuilderPage(browser, developmentProcess);
  await page.setViewportSize({ width: args.width, height: args.height }).catch(() => {});
  await page.waitForFunction(
    () => {
      try {
        return globalThis.__hcadBuilderKernel?.session.diagnostics().capabilities !== undefined;
      } catch {
        // React StrictMode can briefly leave the first, disposed development
        // session on the diagnostic global while its replacement mounts.
        return false;
      }
    },
    null,
    { timeout: 120_000 },
  );

  const metadataUrl = args.metadataUrl ?? `/@fs/${prepared.metadataPath}`;
  report.browser = await loadDataset(page, metadataUrl, prepared);
  if (args.frontierOnly) {
    report.frontierOrbit = await page.evaluate(runFrontierOrbit, { frames: args.frames });
  } else {
    const traceSession = args.trace ? await page.context().newCDPSession(page) : null;
    if (traceSession !== null) {
      await traceSession.send('Tracing.start', {
        categories: 'devtools.timeline,v8,disabled-by-default-v8.gc,gpu,cc',
        transferMode: 'ReturnAsStream',
      });
    }
    report.paths = await page.evaluate(runCameraPaths, {
      width: args.width,
      height: args.height,
      frames: args.frames,
      repetitions: args.repetitions,
    });
    if (traceSession !== null) {
      const completed = new Promise((resolvePromise) =>
        traceSession.once('Tracing.tracingComplete', resolvePromise),
      );
      await traceSession.send('Tracing.end');
      const { stream } = await completed;
      let trace = '';
      for (;;) {
        const chunk = await traceSession.send('IO.read', { handle: stream });
        trace += chunk.data;
        if (chunk.eof) break;
      }
      await traceSession.send('IO.close', { handle: stream });
      const tracePath = `${outputStem}.trace.json`;
      await writeFile(tracePath, trace);
      report.tracePath = tracePath;
    }
    report.aggregate = aggregatePaths(report.paths);
  }
  report.status = 'complete';
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  report.status = 'blocked';
  report.blocker = {
    message,
    stack: error instanceof Error ? (error.stack ?? null) : null,
    needed: message.includes('GeometryObject::Measurement')
      ? 'Make the GeometryObject match in crates/himmelcad-wasm/src/lib.rs exhaustive for Measurement (or use a known-good core/WASM schema pair), stage the viewer WASM, then rerun this command. The subsequent session must expose window.__hcadBuilderKernel on a hardware WebGPU adapter.'
      : 'A hardware-backed Chromium/Electron WebGPU or WebGL2 session exposing window.__hcadBuilderKernel, the staged viewer WASM, and readable prepared Potree files. Software adapters are rejected.',
  };
  process.exitCode = 1;
} finally {
  await writeOutputs(report, outputStem);
  if (developmentProcess !== null) await stopBuilder(developmentProcess);
  if (browser !== null) {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
    ]);
  }
}

function parseArguments(values) {
  const parsed = {
    cdp: null,
    dataset: null,
    metadata: null,
    metadataUrl: null,
    date: null,
    width: 1_440,
    height: 900,
    frames: 180,
    repetitions: 5,
    noLaunch: false,
    frontierOnly: false,
    trace: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--no-launch') parsed.noLaunch = true;
    else if (value === '--trace') parsed.trace = true;
    else if (value === '--frontier-only') parsed.frontierOnly = true;
    else if (value === '--cdp') parsed.cdp = requiredValue(values, ++index, value);
    else if (value === '--dataset') parsed.dataset = requiredValue(values, ++index, value);
    else if (value === '--metadata') parsed.metadata = requiredValue(values, ++index, value);
    else if (value === '--metadata-url') parsed.metadataUrl = requiredValue(values, ++index, value);
    else if (value === '--date') parsed.date = requiredValue(values, ++index, value);
    else if (value === '--width') parsed.width = positiveInteger(values, ++index, value);
    else if (value === '--height') parsed.height = positiveInteger(values, ++index, value);
    else if (value === '--frames') parsed.frames = positiveInteger(values, ++index, value);
    else if (value === '--repetitions')
      parsed.repetitions = positiveInteger(values, ++index, value);
    else if (value === '--help') {
      console.log(`Usage: node scripts/perf/viewer-baseline.mjs [options]

  --dataset <file.las|file.laz|metadata.json>  Source (default: largest real repo LAS)
  --metadata <metadata.json>                   Reuse an already converted Potree 2 dataset
  --metadata-url <url>                         Override the browser URL for staged metadata
  --cdp <url>                                  Builder CDP endpoint (default: http://127.0.0.1:9223)
  --no-launch                                  Require an already running Builder
  --frontier-only                              Record one orbit's frontier counters, not timings
  --trace                                      Capture Chromium timeline/V8/GPU trace
  --width <px> --height <px>                   Viewport (default: 1440x900)
  --frames <count>                             Samples per motion path (default: 180)
  --repetitions <count>                        Recorded runs per path (default: 5)
  --date <YYYY-MM-DD>                          Output suffix (default: local date)`);
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

function positiveInteger(values, index, option) {
  const value = Number(requiredValue(values, index, option));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${option} must be positive`);
  return value;
}

async function prepareDataset(datasetPath, explicitMetadata) {
  const source = await lasIdentity(datasetPath);
  const metadataPath = explicitMetadata
    ? resolve(explicitMetadata)
    : extname(datasetPath).toLowerCase() === '.json'
      ? datasetPath
      : resolve(
          OUTPUT_DIRECTORY,
          'viewer-baseline-datasets',
          `${basename(datasetPath, extname(datasetPath))}-${source.identity.slice(0, 12)}`,
          'metadata.json',
        );
  try {
    await stat(metadataPath);
  } catch {
    if (!['.las', '.laz'].includes(extname(datasetPath).toLowerCase())) {
      throw new Error(`No Potree metadata at ${metadataPath}`);
    }
    const conversion = spawnSync(
      POTREE_CONVERTER,
      [
        datasetPath,
        '-o',
        resolve(metadataPath, '..'),
        '--encoding',
        'UNCOMPRESSED',
        '-m',
        'poisson',
      ],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (conversion.status !== 0) {
      throw new Error(
        `PotreeConverter failed (${String(conversion.status)}): ${(conversion.stderr || conversion.stdout).slice(-4_000)}`,
      );
    }
  }
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  return {
    sourcePath: datasetPath,
    metadataPath,
    sourceBytes: source.bytes,
    sourcePointCount: source.points,
    sourceLasVersion: source.version,
    sourcePointFormat: source.pointFormat,
    preparedPointCount: metadata.points,
    bounds: metadata.boundingBox,
    projection: metadata.projection ?? null,
    identity: source.identity,
    sourceContentHash: source.contentHash,
  };
}

async function lasIdentity(path) {
  const sourceStat = await stat(path);
  const bytes = Buffer.alloc(Math.min(sourceStat.size, 1_048_576));
  const file = await open(path, 'r');
  try {
    await file.read(bytes, 0, bytes.length, 0);
  } finally {
    await file.close();
  }
  const hash = createHash('sha256');
  hash.update(bytes);
  hash.update(String(sourceStat.size));
  const contentHash = createHash('sha256');
  const contentBuffer = Buffer.alloc(16 * 1024 * 1024);
  let contentOffset = 0;
  const contentFile = await open(path, 'r');
  try {
    while (contentOffset < sourceStat.size) {
      const { bytesRead } = await contentFile.read(
        contentBuffer,
        0,
        Math.min(contentBuffer.length, sourceStat.size - contentOffset),
        contentOffset,
      );
      if (bytesRead === 0) break;
      contentHash.update(contentBuffer.subarray(0, bytesRead));
      contentOffset += bytesRead;
    }
  } finally {
    await contentFile.close();
  }
  if (bytes.subarray(0, 4).toString('ascii') !== 'LASF') {
    return {
      bytes: sourceStat.size,
      points: null,
      version: null,
      pointFormat: null,
      identity: hash.digest('hex'),
      contentHash: contentHash.digest('hex'),
    };
  }
  const major = bytes.readUInt8(24);
  const minor = bytes.readUInt8(25);
  const legacyPoints = bytes.readUInt32LE(107);
  const extendedPoints = major > 1 || minor >= 4 ? Number(bytes.readBigUInt64LE(247)) : 0;
  return {
    bytes: sourceStat.size,
    points: extendedPoints || legacyPoints,
    version: `${major}.${minor}`,
    pointFormat: bytes.readUInt8(104) & 0x3f,
    identity: hash.digest('hex'),
    contentHash: contentHash.digest('hex'),
  };
}

async function launchBuilder() {
  const userDataDirectory = await mkdtemp(resolve(tmpdir(), 'hcad-viewer-baseline-'));
  const child = spawn('pnpm', ['--filter', '@himmelcad/builder', 'dev'], {
    cwd: REPO,
    env: {
      ...process.env,
      HIMMELCAD_GPU: builderGpuPreference,
      HIMMELCAD_VITE_HMR: '0',
      HIMMELCAD_REMOTE_DEBUGGING_PORT: '9223',
      HIMMELCAD_ELECTRON_USER_DATA_DIR: userDataDirectory,
    },
    // Give the dev server, Electron launcher, and Electron children one process
    // group so a failed attachment cannot strand a headless CDP endpoint.
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
  // Dev startup includes the serialized Rust/WASM staging build. On a shared
  // workstation it can legitimately wait behind another target/builder Cargo
  // owner for several minutes; renderer attachment has its own 120 s bound.
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
        `Builder exited before its renderer page was attached (code ${child.exitCode}, signal ${child.signalCode}): ${child.outputTail}`,
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
    `Builder renderer page was not attached to the CDP browser within 120 seconds (pages: ${JSON.stringify(urls)}).${output}`,
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

async function loadDataset(page, metadataUrl, prepared) {
  return await page.evaluate(
    async ({ uri, expectedPoints, bounds, sourceName, rawSourceContentHash }) => {
      const handle = globalThis.__hcadBuilderKernel;
      const session = handle.session;
      const viewer = session.viewerState;
      const capabilities = session.diagnostics().capabilities;
      const identity =
        `${capabilities.adapterName} ${capabilities.driver} ${capabilities.driverInfo}`.toLowerCase();
      if (
        capabilities.deviceKind === 'cpu' ||
        /swiftshader|llvmpipe|software rasterizer/.test(identity)
      ) {
        throw new Error(`hardware baseline rejected software adapter: ${identity}`);
      }
      const metadataResponse = await fetch(uri);
      if (!metadataResponse.ok)
        throw new Error(`metadata fetch ${metadataResponse.status}: ${uri}`);
      const metadataBytes = new Uint8Array(await metadataResponse.arrayBuffer());
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', metadataBytes.slice().buffer),
      );
      const metadataHash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const geometry = {
        kind: 'pointCloud',
        dataset: {
          formatId: 'potree@2',
          metadata: {
            objectHash: metadataHash,
            mediaType: 'application/json',
            byteLength: metadataBytes.byteLength,
          },
          elementCount: expectedPoints,
        },
      };
      const selected = {
        role: 'canonical',
        geometryRef: viewer.geometryObjectContentHash(geometry),
        authority: 'authoritative',
        dependencyHash: null,
      };
      const entityWithoutVersion = {
        id: 'viewer-baseline-point-cloud',
        revision: 1,
        typeId: 'hcad.point-cloud@1',
        name: sourceName,
        owner: null,
        layerIds: [],
        placement: null,
        representations: [selected],
        componentsRef: 'c1'.repeat(32),
        attributesRef: 'a1'.repeat(32),
        relationsRef: 'e1'.repeat(32),
        styleRef: null,
        schemaVersion: 1,
      };
      const entity = {
        ...entityWithoutVersion,
        versionHash: viewer.canonicalEntityVersionHash({
          ...entityWithoutVersion,
          versionHash: '00'.repeat(32),
        }),
      };
      await session.loadPotree(
        {
          datasetId: 'viewer-baseline-dataset',
          metadataUri: new URL(uri, location.href).toString(),
          admission: {
            entity,
            selected,
            representationSlot: 'primary',
            expectedGeneration: null,
            resolvedGeometry: geometry,
          },
          preparedMetadata: {
            schemaVersion: 1,
            rawSourceContentHash,
            nodes: {},
          },
          style: {
            baseColor: [0.82, 0.88, 0.95, 1],
            opacity: 1,
            verticalExaggeration: 1,
            colorMode: { kind: 'source' },
            fill: { kind: 'color' },
            stroke: {
              mode: { kind: 'color' },
              color: { kind: 'inherit' },
              width: { kind: 'source' },
              cap: 'butt',
              join: 'miter',
              miterLimit: 4,
            },
          },
        },
        { operationId: 'viewer-baseline/load' },
      );
      handle.camera.frame(
        { x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] },
        { x: bounds.max[0], y: bounds.max[1], z: bounds.max[2] },
      );
      session.setWorldCamera(
        handle.camera.worldCamera(),
        handle.camera.recommendedFloatingOrigin(),
      );
      handle.requestFrame();
      for (let index = 0; index < 600; index += 1) {
        await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
        const diagnostics = session.diagnostics();
        const stages = diagnostics.streaming.residencyStageCounts;
        if (
          stages.resident > 0 &&
          stages.fetching +
            stages.queuedDecode +
            stages.decoding +
            stages.queuedUpload +
            stages.uploading ===
            0
        ) {
          break;
        }
      }
      return {
        userAgent: navigator.userAgent,
        devicePixelRatio,
        capabilities,
        hardwarePolicy: session.diagnostics().hardwarePolicy,
        runtimeQuality: session.diagnostics().runtimeQuality,
      };
    },
    {
      uri: metadataUrl,
      expectedPoints: prepared.preparedPointCount,
      bounds: prepared.bounds,
      sourceName: basename(prepared.sourcePath),
      rawSourceContentHash: prepared.sourceContentHash,
    },
  );
}

async function runCameraPaths({ frames, repetitions }) {
  const handle = globalThis.__hcadBuilderKernel;
  const session = handle.session;
  const camera = handle.camera;
  const center = camera.targetPoint();
  const repetitionStart = camera.worldCamera();
  const paths = [];
  const longTasks = [];
  const longTaskSupported = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
  const longTaskObserver = longTaskSupported
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      })
    : null;
  longTaskObserver?.observe({ type: 'longtask', buffered: true });
  const measureMemory = async () => {
    const measure = performance.measureUserAgentSpecificMemory;
    if (typeof measure !== 'function') return { supported: false, bytes: null, breakdown: null };
    try {
      const result = await measure.call(performance);
      return { supported: true, bytes: result.bytes, breakdown: result.breakdown?.length ?? 0 };
    } catch (error) {
      return { supported: true, bytes: null, error: String(error) };
    }
  };
  const summarizeValues = (values) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const at = (fraction) =>
      sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
    return {
      samples: sorted.length,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      maximum: sorted.at(-1),
    };
  };
  const decorateFrames = (sampledFrames) =>
    sampledFrames.map((frame) => {
      const intervalStart =
        frame.presentIntervalMs === null
          ? frame.presentTimestampMs
          : frame.presentTimestampMs - frame.presentIntervalMs;
      const longTaskMs = longTasks.reduce((total, task) => {
        const overlap =
          Math.min(frame.presentTimestampMs, task.startTime + task.duration) -
          Math.max(intervalStart, task.startTime);
        return total + Math.max(0, overlap);
      }, 0);
      return { ...frame, longTaskMs };
    });
  const dominantCause = (frame) => {
    const activity = frame.streamingActivity;
    const candidates = [
      ['main-thread hierarchy apply', activity?.hierarchyApplyMs ?? 0],
      ['main-thread decode ingest', activity?.mainThreadDecodeIngestMs ?? 0],
      ['buffer upload', activity?.uploadMs ?? 0],
      ['JS long task / GC proxy', frame.longTaskMs ?? 0],
      ['CPU submit', frame.phases.cpuEncodeMs],
      ['GPU timestamp', frame.gpuMs ?? 0],
      ['unattributed browser/GPU present wait', frame.unattributedPresentWaitMs ?? 0],
    ];
    return candidates.sort((left, right) => right[1] - left[1])[0][0];
  };
  const frameHistogram = (sampledFrames) => {
    const buckets = [
      ['0–16.7', 0, 16.7],
      ['16.7–33.4', 16.7, 33.4],
      ['33.4–50', 33.4, 50],
      ['50–100', 50, 100],
      ['100–150', 100, 150],
      ['150–200', 150, 200],
      ['>200', 200, Number.POSITIVE_INFINITY],
    ];
    return Object.fromEntries(
      buckets.map(([label, lower, upper]) => [
        label,
        sampledFrames.filter(
          (frame) =>
            frame.presentIntervalMs !== null &&
            frame.presentIntervalMs > lower &&
            frame.presentIntervalMs <= upper,
        ).length,
      ]),
    );
  };
  const summarizeFrames = (sampledFrames) => ({
    presentedFrameIntervalMs: summarizeValues(
      sampledFrames.flatMap((frame) =>
        frame.presentIntervalMs === null ? [] : [frame.presentIntervalMs],
      ),
    ),
    inputToPresentMs: summarizeValues(
      sampledFrames.flatMap((frame) =>
        frame.inputToPresentMs === null ? [] : [frame.inputToPresentMs],
      ),
    ),
    gpuMs: summarizeValues(
      sampledFrames.flatMap((frame) => (frame.gpuMs === null ? [] : [frame.gpuMs])),
    ),
    cpuMs: summarizeValues(sampledFrames.map((frame) => frame.cpuMs)),
    unattributedPresentWaitMs: summarizeValues(
      sampledFrames.map((frame) => frame.unattributedPresentWaitMs ?? 0),
    ),
    exactPrimitivesPerFrame: {
      status: 'exact-submitted-batch-counts',
      points: summarizeValues(sampledFrames.map((frame) => frame.primitives.points)),
      triangles: summarizeValues(sampledFrames.map((frame) => frame.primitives.triangles)),
      lines: summarizeValues(sampledFrames.map((frame) => frame.primitives.lines)),
      textQuads: summarizeValues(sampledFrames.map((frame) => frame.primitives.textQuads)),
      splats: summarizeValues(sampledFrames.map((frame) => frame.primitives.splats)),
      drawCalls: summarizeValues(sampledFrames.map((frame) => frame.primitives.drawCalls)),
    },
    phaseMs: {
      protectedLanes1To3: summarizeValues(
        sampledFrames.map((frame) => frame.phases.protectedLanes1To3Ms),
      ),
      cloudMeshRefinement: summarizeValues(
        sampledFrames.map((frame) => frame.phases.cloudMeshRefinementMs),
      ),
      sharedEncode: summarizeValues(sampledFrames.map((frame) => frame.phases.sharedEncodeMs)),
    },
    decodeBacklog: summarizeValues(sampledFrames.map((frame) => frame.decodeBacklog)),
    streamingActivity: {
      workerDecodeMs: summarizeValues(
        sampledFrames.map((frame) => frame.streamingActivity?.workerDecodeMs ?? 0),
      ),
      mainThreadDecodeIngestMs: summarizeValues(
        sampledFrames.map((frame) => frame.streamingActivity?.mainThreadDecodeIngestMs ?? 0),
      ),
      hierarchyApplyMs: summarizeValues(
        sampledFrames.map((frame) => frame.streamingActivity?.hierarchyApplyMs ?? 0),
      ),
      uploadMs: summarizeValues(
        sampledFrames.map((frame) => frame.streamingActivity?.uploadMs ?? 0),
      ),
      maximumUploadedBytes: Math.max(
        0,
        ...sampledFrames.map((frame) => frame.streamingActivity?.uploadedBytes ?? 0),
      ),
      lodSwaps: sampledFrames.reduce(
        (total, frame) => total + (frame.streamingActivity?.lodSwapCount ?? 0),
        0,
      ),
      hierarchyPages: sampledFrames.reduce(
        (total, frame) => total + (frame.streamingActivity?.hierarchyPages ?? 0),
        0,
      ),
    },
    memory: {
      maximumWasmGrowthBytes: Math.max(
        0,
        ...sampledFrames.map((frame) => frame.memory?.wasmGrowthBytes ?? 0),
      ),
      jsHeapMinimumBytes: Math.min(
        ...sampledFrames.flatMap((frame) =>
          frame.memory?.jsHeapBytes === null || frame.memory?.jsHeapBytes === undefined
            ? []
            : [frame.memory.jsHeapBytes],
        ),
      ),
      jsHeapMaximumBytes: Math.max(
        0,
        ...sampledFrames.map((frame) => frame.memory?.jsHeapBytes ?? 0),
      ),
    },
    longTaskMs: summarizeValues(sampledFrames.map((frame) => frame.longTaskMs ?? 0)),
    histogram: frameHistogram(sampledFrames),
    worstFrames: [...sampledFrames]
      .filter((frame) => frame.presentIntervalMs !== null)
      .sort((left, right) => right.presentIntervalMs - left.presentIntervalMs)
      .slice(0, 20)
      .map((frame) => ({
        frameId: frame.frameId,
        presentedMs: frame.presentIntervalMs,
        cpuSubmitMs: frame.phases.cpuEncodeMs,
        cpuTotalMs: frame.cpuMs,
        gpuMs: frame.gpuMs,
        unattributedPresentWaitMs: frame.unattributedPresentWaitMs ?? null,
        longTaskMs: frame.longTaskMs ?? 0,
        streamingActivity: frame.streamingActivity ?? null,
        wasmGrowthBytes: frame.memory?.wasmGrowthBytes ?? null,
        jsHeapBytes: frame.memory?.jsHeapBytes ?? null,
        qualityTier: frame.qualityTier ?? null,
        qualityAdjustment: frame.qualityAdjustment ?? null,
        governorReasons: frame.deadlineReasonCodes,
        dominantCause: dominantCause(frame),
      })),
    frontier: {
      hardwareClass: sampledFrames.find((frame) => frame.frontier)?.frontier?.hardwareClass ?? null,
      pointBudget: sampledFrames.find((frame) => frame.frontier)?.frontier?.budgetPoints ?? null,
      byteBudget: sampledFrames.find((frame) => frame.frontier)?.frontier?.budgetBytes ?? null,
      drawBudget: sampledFrames.find((frame) => frame.frontier)?.frontier?.budgetDrawCalls ?? null,
      maximumSelectedPoints: Math.max(
        0,
        ...sampledFrames.map((frame) => frame.frontier?.selectedPoints ?? 0),
      ),
      maximumSelectedBytes: Math.max(
        0,
        ...sampledFrames.map((frame) => frame.frontier?.selectedBytes ?? 0),
      ),
      maximumSelectedDrawCalls: Math.max(
        0,
        ...sampledFrames.map((frame) => frame.frontier?.selectedDrawCalls ?? 0),
      ),
      coarsenedTiles: sampledFrames.reduce(
        (total, frame) => total + (frame.frontier?.coarsenedTiles ?? 0),
        0,
      ),
      framesOverBudget: sampledFrames.filter((frame) => frame.frontier?.budgetSatisfied === false)
        .length,
      framesOverPointBudget: sampledFrames.filter(
        (frame) =>
          frame.frontier !== undefined &&
          frame.frontier.selectedPoints > frame.frontier.budgetPoints,
      ).length,
      framesMissingAccounting: sampledFrames.filter((frame) => frame.frontier === undefined).length,
      framesMissingReasonCodes: sampledFrames.filter(
        (frame) => frame.deadlineReasonCodes.length === 0,
      ).length,
    },
    reasonCounts: sampledFrames
      .flatMap((frame) => frame.deadlineReasonCodes)
      .reduce((counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }), {}),
  });

  let activeRepetition = 0;
  const sample = async (name, update) => {
    const startFrameId = session.diagnosticsSnapshot(1).lastFrames.at(-1)?.frameId ?? 0;
    const memoryBefore = await measureMemory();
    const qualityHits = { reduced: 0, increased: 0 };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'runtimeQuality') qualityHits[event.adjustment] += 1;
    });
    handle.setInteracting(true);
    for (let index = 0; index < frames; index += 1) {
      session.recordInput(`${name}-${index}`, performance.now());
      update(index, frames);
      session.setWorldCamera(camera.worldCamera(), camera.recommendedFloatingOrigin());
      await session.waitForNextPresentedFrame();
    }
    handle.setInteracting(false);
    await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
    unsubscribe();
    const diagnostics = session.diagnostics();
    const sampledFrames = decorateFrames(session
      .diagnosticsSnapshot(frames + 8)
      .lastFrames.filter((frame) => frame.frameId > startFrameId)
      .slice(5));
    const memoryAfter = await measureMemory();
    const frontierViolations = sampledFrames.filter(
      (frame) => frame.frontier === undefined || frame.frontier.budgetSatisfied === false,
    );
    if (frontierViolations.length > 0) {
      throw new Error(
        `${name} produced ${frontierViolations.length} frames without valid frontier budget accounting`,
      );
    }
    if (sampledFrames.some((frame) => frame.deadlineReasonCodes.length === 0)) {
      throw new Error(`${name} produced frames without density reason codes`);
    }
    paths.push({
      name,
      run: activeRepetition,
      presentSource: sampledFrames[0]?.presentSource ?? 'raf-render-complete',
      ...summarizeFrames(sampledFrames),
      budgetHits: {
        qualityReductions: qualityHits.reduced,
        qualityIncreases: qualityHits.increased,
        gpuTimingSaturatedFrames: diagnostics.gpuFrameTiming.saturatedFrames,
      },
      runtimeQuality: diagnostics.runtimeQuality,
      residency: diagnostics.streaming.residencyStageCounts,
      memoryBoundary: { before: memoryBefore, after: memoryAfter },
      longTaskObserverSupported: longTaskSupported,
    });
  };

  for (activeRepetition = 1; activeRepetition <= repetitions; activeRepetition += 1) {
    camera.adoptWorldCamera(repetitionStart);
    session.setWorldCamera(camera.worldCamera(), camera.recommendedFloatingOrigin());
    await handle.setViewMode('3d', { durationMilliseconds: 0 });
    await sample('orbit', (index, count) => {
    camera.orbit((Math.PI * 2) / count, Math.sin((index / count) * Math.PI * 2) * 0.0015);
  });
    await sample('pan', (index, count) => {
    camera.panPixels(
      Math.sin((index / count) * Math.PI * 2) * 5,
      Math.cos((index / count) * Math.PI * 2) * 2,
    );
  });
    await sample('zoom', (index, count) => {
    camera.zoom(index < count / 2 ? 0.992 : 1 / 0.992);
  });
    const initial = camera.worldCamera();
    await sample('fly-through', (index, count) => {
    const phase = (index / Math.max(1, count - 1)) * Math.PI * 2;
    const radius = Math.hypot(
      initial.eye.x - initial.target.x,
      initial.eye.y - initial.target.y,
      initial.eye.z - initial.target.z,
    );
    const target = {
      x: center.x + Math.cos(phase) * radius * 0.12,
      y: center.y + Math.sin(phase * 0.7) * radius * 0.12,
      z: center.z + Math.sin(phase * 0.5) * radius * 0.025,
    };
    camera.adoptWorldCamera({
      ...initial,
      eye: {
        x: target.x + Math.cos(phase) * radius * 0.55,
        y: target.y + Math.sin(phase) * radius * 0.55,
        z: target.z + radius * 0.18,
      },
      target,
    });
    });

    const transitionStartFrameId = session.diagnosticsSnapshot(1).lastFrames.at(-1)?.frameId ?? 0;
    const transitionInputAt = performance.now();
    const transitionMemoryBefore = await measureMemory();
    const historyBefore = await handle.cameraHistory('clear');
    session.recordInput(`transition-3d-to-2d-${activeRepetition}`, transitionInputAt);
    const to2d = handle.setViewMode('2d');
    await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
    const firstMidBlend = {
    semanticMode: session.currentViewMode(),
    history: await handle.cameraHistory('get'),
  };
    await to2d;
    const after2d = {
    semanticMode: session.currentViewMode(),
    history: await handle.cameraHistory('get'),
  };
    session.recordInput(`transition-2d-to-3d-${activeRepetition}`, performance.now());
    const to3d = handle.setViewMode('3d');
    await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
    const secondMidBlend = {
    semanticMode: session.currentViewMode(),
    history: await handle.cameraHistory('get'),
  };
    await to3d;
    const after3d = {
    semanticMode: session.currentViewMode(),
    history: await handle.cameraHistory('get'),
  };
    const transitionDiagnostics = session.diagnostics();
    const transitionFrames = decorateFrames(session
    .diagnosticsSnapshot(120)
    .lastFrames.filter((frame) => frame.frameId > transitionStartFrameId));
    const transitionMemoryAfter = await measureMemory();
    paths.push({
      name: '3d-to-2d-to-3d',
      run: activeRepetition,
    presentSource: transitionFrames[0]?.presentSource ?? 'raf-render-complete',
    ...summarizeFrames(transitionFrames),
    budgetHits: {
      qualityReductions: null,
      qualityIncreases: null,
      gpuTimingSaturatedFrames: transitionDiagnostics.gpuFrameTiming.saturatedFrames,
    },
    transitionElapsedMs: performance.now() - transitionInputAt,
    transitionStateMachine: {
      historyBefore,
      firstMidBlend,
      after2d,
      secondMidBlend,
      after3d,
    },
    runtimeQuality: transitionDiagnostics.runtimeQuality,
      residency: transitionDiagnostics.streaming.residencyStageCounts,
      memoryBoundary: { before: transitionMemoryBefore, after: transitionMemoryAfter },
      longTaskObserverSupported: longTaskSupported,
    });
  }
  longTaskObserver?.disconnect();
  return paths;
}

async function runFrontierOrbit({ frames }) {
  const handle = globalThis.__hcadBuilderKernel;
  const session = handle.session;
  const camera = handle.camera;
  await session.setViewMode('3d', 0);
  const startFrameId = session.diagnosticsSnapshot(1).lastFrames.at(-1)?.frameId ?? 0;
  handle.setInteracting(true);
  for (let index = 0; index < frames; index += 1) {
    camera.orbit((Math.PI * 2) / frames, Math.sin((index / frames) * Math.PI * 2) * 0.0015);
    session.setWorldCamera(camera.worldCamera(), camera.recommendedFloatingOrigin());
    await session.waitForNextPresentedFrame();
  }
  handle.setInteracting(false);
  await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
  const sampledFrames = session
    .diagnosticsSnapshot(frames + 4)
    .lastFrames.filter((frame) => frame.frameId > startFrameId)
    .slice(2);
  const accounted = sampledFrames.filter((frame) => frame.frontier !== undefined);
  const violations = accounted.filter(
    (frame) =>
      frame.frontier.budgetSatisfied === false ||
      frame.frontier.selectedPoints > frame.frontier.budgetPoints ||
      frame.frontier.selectedBytes > frame.frontier.budgetBytes ||
      frame.frontier.selectedDrawCalls > frame.frontier.budgetDrawCalls,
  );
  if (accounted.length !== sampledFrames.length || violations.length > 0) {
    throw new Error(
      `orbit frontier accounting failed: ${sampledFrames.length - accounted.length} missing, ${violations.length} over budget`,
    );
  }
  const first = accounted[0]?.frontier;
  return {
    status: 'non-timed-functional-orbit',
    sampledFrames: sampledFrames.length,
    hardwareClass: first?.hardwareClass ?? null,
    budget: {
      points: first?.budgetPoints ?? null,
      bytes: first?.budgetBytes ?? null,
      drawCalls: first?.budgetDrawCalls ?? null,
    },
    maximumSelected: {
      points: Math.max(0, ...accounted.map((frame) => frame.frontier.selectedPoints)),
      bytes: Math.max(0, ...accounted.map((frame) => frame.frontier.selectedBytes)),
      drawCalls: Math.max(0, ...accounted.map((frame) => frame.frontier.selectedDrawCalls)),
    },
    framesOverPointBudget: accounted.filter(
      (frame) => frame.frontier.selectedPoints > frame.frontier.budgetPoints,
    ).length,
    framesOverAnyBudget: violations.length,
    blankTileFrames: accounted.filter((frame) => frame.frontier.selectedPoints === 0).length,
    coarsenedTiles: accounted.reduce((total, frame) => total + frame.frontier.coarsenedTiles, 0),
    reasonCounts: sampledFrames
      .flatMap((frame) => frame.deadlineReasonCodes)
      .reduce((counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }), {}),
    residency: session.diagnostics().streaming.residencyStageCounts,
  };
}

function aggregatePaths(paths) {
  const complete = paths.filter((path) => path.presentedFrameIntervalMs !== null);
  const grouped = Map.groupBy(complete, (path) => path.name);
  const medianByPath = [...grouped].map(([name, runs]) => {
    const ordered = [...runs].sort(
      (left, right) => left.presentedFrameIntervalMs.p95 - right.presentedFrameIntervalMs.p95,
    );
    const medianRun = ordered[Math.floor(ordered.length / 2)];
    return {
      name,
      repetitions: runs.length,
      runP95Ms: runs.map((run) => ({ run: run.run, p95: run.presentedFrameIntervalMs.p95 })),
      medianRun: medianRun.run,
      medianP50Ms: medianRun.presentedFrameIntervalMs.p50,
      medianP95Ms: medianRun.presentedFrameIntervalMs.p95,
      medianP99Ms: medianRun.presentedFrameIntervalMs.p99,
      medianMaximumMs: medianRun.presentedFrameIntervalMs.maximum,
    };
  });
  return {
    worstPresentedP95Ms: Math.max(...complete.map((path) => path.presentedFrameIntervalMs.p95)),
    worstPresentedP99Ms: Math.max(...complete.map((path) => path.presentedFrameIntervalMs.p99)),
    worstMedianPresentedP95Ms: Math.max(...medianByPath.map((path) => path.medianP95Ms)),
    medianByPath,
    maximumDecodeBacklog: Math.max(0, ...complete.map((path) => path.decodeBacklog?.maximum ?? 0)),
    qualityReductionBudgetHits: complete.reduce(
      (total, path) => total + (path.budgetHits.qualityReductions ?? 0),
      0,
    ),
  };
}

function hostInventory() {
  const nvidia = spawnSync(
    'nvidia-smi',
    ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'],
    { encoding: 'utf8' },
  );
  return {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    cpu: cpus()[0]?.model ?? null,
    logicalCores: availableParallelism(),
    builderGpuPreference,
    nvidiaSmi: nvidia.status === 0 ? nvidia.stdout.trim() : null,
  };
}

async function writeOutputs(value, stem) {
  const jsonPath = `${stem}.json`;
  const markdownPath = `${stem}.md`;
  await writeFile(jsonPath, `${JSON.stringify(value, null, 2)}\n`);
  const lines = [
    `# Viewer baseline — ${date}`,
    '',
    `Status: **${value.status}**`,
    '',
    `Dataset: ${value.dataset ? `${value.dataset.preparedPointCount.toLocaleString('en-US')} points (${value.dataset.sourcePath})` : 'not prepared'}`,
    '',
  ];
  if (value.status === 'complete' && value.mode === 'frontier-only') {
    const orbit = value.frontierOrbit;
    lines.push(
      'This is a non-timed functional orbit. It makes no frame-latency claim.',
      '',
      '| Frames | Class | Point budget | Selected points max | Selected bytes max | Selected draws max | Point overruns | Any overruns | Blank-tile frames |',
      '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      `| ${orbit.sampledFrames} | ${orbit.hardwareClass ?? 'n/a'} | ${orbit.budget.points ?? 'n/a'} | ${orbit.maximumSelected.points} | ${orbit.maximumSelected.bytes} | ${orbit.maximumSelected.drawCalls} | ${orbit.framesOverPointBudget} | ${orbit.framesOverAnyBudget} | ${orbit.blankTileFrames} |`,
      '',
      `Reason codes: \`${JSON.stringify(orbit.reasonCounts)}\`.`,
    );
  } else if (value.status === 'complete') {
    lines.push(
      '| Path | Run | Presented p50 | p95 | p99 | Exact points p95 | Input→present p95 | Decode backlog max |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...value.paths.map(
        (path) =>
          `| ${path.name} | ${path.run} | ${formatMs(path.presentedFrameIntervalMs?.p50)} | ${formatMs(path.presentedFrameIntervalMs?.p95)} | ${formatMs(path.presentedFrameIntervalMs?.p99)} | ${path.exactPrimitivesPerFrame.points?.p95 ?? 'n/a'} | ${formatMs(path.inputToPresentMs?.p95)} | ${path.decodeBacklog?.maximum ?? 'n/a'} |`,
      ),
      '',
      '| Path | Median run | Median p50 | Median p95 | Median p99 | Max | Run p95 values |',
      '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
      ...value.aggregate.medianByPath.map(
        (path) =>
          `| ${path.name} | ${path.medianRun} | ${formatMs(path.medianP50Ms)} | ${formatMs(path.medianP95Ms)} | ${formatMs(path.medianP99Ms)} | ${formatMs(path.medianMaximumMs)} | ${path.runP95Ms.map((run) => `${run.run}: ${formatMs(run.p95)}`).join('; ')} |`,
      ),
      '',
      `Worst median-of-five path p95: **${formatMs(value.aggregate.worstMedianPresentedP95Ms)}**.`,
    );
  } else {
    lines.push(
      `Blocker: ${value.blocker?.message ?? 'unknown'}`,
      '',
      `Needed: ${value.blocker?.needed ?? 'see JSON'}`,
    );
  }
  if (value.mode !== 'frontier-only') {
    lines.push(
      '',
      '_Present source: `raf-render-complete` (successful kernel surface present paired to its scheduling rAF; not OS display timing). GPU durations are correlated asynchronous timestamp-query samples when supported._',
      '',
    );
  }
  await writeFile(markdownPath, lines.join('\n'));
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
}

function formatMs(value) {
  return value === undefined || value === null ? 'n/a' : `${value.toFixed(2)} ms`;
}
