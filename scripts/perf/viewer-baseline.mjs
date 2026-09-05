#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus } from 'node:os';
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
const outputStem = resolve(
  OUTPUT_DIRECTORY,
  `${args.frontierOnly ? 'viewer-frontier-orbit' : 'viewer-baseline'}-${date}`,
);
const report = {
  schemaVersion: 3,
  mode: args.frontierOnly ? 'frontier-only' : 'timed-baseline',
  generatedAt: new Date().toISOString(),
  status: 'running',
  measurement: {
    path: 'Builder Electron browser-gpu over Chrome DevTools Protocol',
    presentedInterval: 'VC-D1 rAF-render-complete presented-frame pairing',
    presentSource: 'raf-render-complete',
    gpuTiming: 'asynchronous WebGPU timestamp query correlated by submission sequence when supported',
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
    developmentProcess = launchBuilder();
    await waitForCdp(cdpUrl, developmentProcess);
  }

  browser = await chromium.connectOverCDP(cdpUrl);
  const page = await waitForBuilderPage(browser);
  await page.setViewportSize({ width: args.width, height: args.height }).catch(() => {});
  await page.waitForFunction(() => globalThis.__hcadBuilderKernel?.session !== undefined, null, {
    timeout: 120_000,
  });

  const metadataUrl = `/@fs/${prepared.metadataPath}`;
  report.browser = await loadDataset(page, metadataUrl, prepared);
  if (args.frontierOnly) {
    report.frontierOrbit = await page.evaluate(runFrontierOrbit, { frames: args.frames });
  } else {
    report.paths = await page.evaluate(runCameraPaths, {
      width: args.width,
      height: args.height,
      frames: args.frames,
    });
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
      : 'A hardware-backed Chromium/Electron WebGPU session exposing window.__hcadBuilderKernel, the staged viewer WASM, and readable prepared Potree files. Software adapters are rejected.',
  };
  process.exitCode = 1;
} finally {
  await writeOutputs(report, outputStem);
  if (browser !== null) await browser.close().catch(() => {});
  if (developmentProcess !== null && developmentProcess.exitCode === null) {
    developmentProcess.kill('SIGTERM');
  }
}

function parseArguments(values) {
  const parsed = {
    cdp: null,
    dataset: null,
    metadata: null,
    date: null,
    width: 1_440,
    height: 900,
    frames: 180,
    noLaunch: false,
    frontierOnly: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--no-launch') parsed.noLaunch = true;
    else if (value === '--frontier-only') parsed.frontierOnly = true;
    else if (value === '--cdp') parsed.cdp = requiredValue(values, ++index, value);
    else if (value === '--dataset') parsed.dataset = requiredValue(values, ++index, value);
    else if (value === '--metadata') parsed.metadata = requiredValue(values, ++index, value);
    else if (value === '--date') parsed.date = requiredValue(values, ++index, value);
    else if (value === '--width') parsed.width = positiveInteger(values, ++index, value);
    else if (value === '--height') parsed.height = positiveInteger(values, ++index, value);
    else if (value === '--frames') parsed.frames = positiveInteger(values, ++index, value);
    else if (value === '--help') {
      console.log(`Usage: node scripts/perf/viewer-baseline.mjs [options]

  --dataset <file.las|file.laz|metadata.json>  Source (default: largest real repo LAS)
  --metadata <metadata.json>                   Reuse an already converted Potree 2 dataset
  --cdp <url>                                  Builder CDP endpoint (default: http://127.0.0.1:9223)
  --no-launch                                  Require an already running Builder
  --frontier-only                              Record one orbit's frontier counters, not timings
  --width <px> --height <px>                   Viewport (default: 1440x900)
  --frames <count>                             Samples per motion path (default: 180)
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

function launchBuilder() {
  const child = spawn('pnpm', ['--filter', '@himmelcad/builder', 'dev'], {
    cwd: REPO,
    env: { ...process.env, HIMMELCAD_REMOTE_DEBUGGING_PORT: '9223' },
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Builder exited before CDP became ready (${child.exitCode}): ${child.outputTail}`,
      );
    }
    if (await cdpAvailable(url)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Builder did not expose ${url} within 240 seconds: ${child.outputTail}`);
}

async function waitForBuilderPage(connectedBrowser) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const page = connectedBrowser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => /(?:localhost|127\.0\.0\.1):5173/.test(candidate.url()));
    if (page) return page;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error('Builder renderer page was not attached to the CDP browser within 120 seconds');
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

async function runCameraPaths({ frames }) {
  const handle = globalThis.__hcadBuilderKernel;
  const session = handle.session;
  const camera = handle.camera;
  const center = camera.targetPoint();
  const paths = [];
  const summarizeValues = (values) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
    return { samples: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), maximum: sorted.at(-1) };
  };
  const summarizeFrames = (sampledFrames) => ({
    presentedFrameIntervalMs: summarizeValues(sampledFrames.flatMap((frame) => frame.presentIntervalMs === null ? [] : [frame.presentIntervalMs])),
    inputToPresentMs: summarizeValues(sampledFrames.flatMap((frame) => frame.inputToPresentMs === null ? [] : [frame.inputToPresentMs])),
    gpuMs: summarizeValues(sampledFrames.flatMap((frame) => frame.gpuMs === null ? [] : [frame.gpuMs])),
    cpuMs: summarizeValues(sampledFrames.map((frame) => frame.cpuMs)),
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
      protectedLanes1To3: summarizeValues(sampledFrames.map((frame) => frame.phases.protectedLanes1To3Ms)),
      cloudMeshRefinement: summarizeValues(sampledFrames.map((frame) => frame.phases.cloudMeshRefinementMs)),
      sharedEncode: summarizeValues(sampledFrames.map((frame) => frame.phases.sharedEncodeMs)),
    },
    decodeBacklog: summarizeValues(sampledFrames.map((frame) => frame.decodeBacklog)),
    frontier: {
      hardwareClass: sampledFrames.find((frame) => frame.frontier)?.frontier?.hardwareClass ?? null,
      pointBudget: sampledFrames.find((frame) => frame.frontier)?.frontier?.budgetPoints ?? null,
      byteBudget: sampledFrames.find((frame) => frame.frontier)?.frontier?.budgetBytes ?? null,
      drawBudget: sampledFrames.find((frame) => frame.frontier)?.frontier?.budgetDrawCalls ?? null,
      maximumSelectedPoints: Math.max(0, ...sampledFrames.map((frame) => frame.frontier?.selectedPoints ?? 0)),
      maximumSelectedBytes: Math.max(0, ...sampledFrames.map((frame) => frame.frontier?.selectedBytes ?? 0)),
      maximumSelectedDrawCalls: Math.max(0, ...sampledFrames.map((frame) => frame.frontier?.selectedDrawCalls ?? 0)),
      coarsenedTiles: sampledFrames.reduce((total, frame) => total + (frame.frontier?.coarsenedTiles ?? 0), 0),
      framesOverBudget: sampledFrames.filter((frame) => frame.frontier?.budgetSatisfied === false).length,
      framesOverPointBudget: sampledFrames.filter((frame) =>
        frame.frontier !== undefined && frame.frontier.selectedPoints > frame.frontier.budgetPoints
      ).length,
      framesMissingAccounting: sampledFrames.filter((frame) => frame.frontier === undefined).length,
      framesMissingReasonCodes: sampledFrames.filter((frame) => frame.deadlineReasonCodes.length === 0).length,
    },
    reasonCounts: sampledFrames.flatMap((frame) => frame.deadlineReasonCodes).reduce((counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }), {}),
  });

  const sample = async (name, update) => {
    const startFrameId = session.diagnosticsSnapshot(1).lastFrames.at(-1)?.frameId ?? 0;
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
    const sampledFrames = session.diagnosticsSnapshot(frames + 8).lastFrames
      .filter((frame) => frame.frameId > startFrameId)
      .slice(5);
    const frontierViolations = sampledFrames.filter(
      (frame) => frame.frontier === undefined || frame.frontier.budgetSatisfied === false,
    );
    if (frontierViolations.length > 0) {
      throw new Error(`${name} produced ${frontierViolations.length} frames without valid frontier budget accounting`);
    }
    if (sampledFrames.some((frame) => frame.deadlineReasonCodes.length === 0)) {
      throw new Error(`${name} produced frames without density reason codes`);
    }
    paths.push({
      name,
      presentSource: sampledFrames[0]?.presentSource ?? 'raf-render-complete',
      ...summarizeFrames(sampledFrames),
      budgetHits: {
        qualityReductions: qualityHits.reduced,
        qualityIncreases: qualityHits.increased,
        gpuTimingSaturatedFrames: diagnostics.gpuFrameTiming.saturatedFrames,
      },
      runtimeQuality: diagnostics.runtimeQuality,
      residency: diagnostics.streaming.residencyStageCounts,
    });
  };

  await session.setViewMode('3d', 0);
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
  session.recordInput('transition-3d-to-2d', transitionInputAt);
  await session.setViewMode('2d', 180);
  session.recordInput('transition-2d-to-3d', performance.now());
  await session.setViewMode('3d', 180);
  const transitionDiagnostics = session.diagnostics();
  const transitionFrames = session.diagnosticsSnapshot(120).lastFrames
    .filter((frame) => frame.frameId > transitionStartFrameId)
    .slice(5);
  paths.push({
    name: '3d-to-2d-to-3d',
    presentSource: transitionFrames[0]?.presentSource ?? 'raf-render-complete',
    ...summarizeFrames(transitionFrames),
    budgetHits: {
      qualityReductions: null,
      qualityIncreases: null,
      gpuTimingSaturatedFrames: transitionDiagnostics.gpuFrameTiming.saturatedFrames,
    },
    transitionElapsedMs: performance.now() - transitionInputAt,
    runtimeQuality: transitionDiagnostics.runtimeQuality,
    residency: transitionDiagnostics.streaming.residencyStageCounts,
  });
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
  const sampledFrames = session.diagnosticsSnapshot(frames + 4).lastFrames
    .filter((frame) => frame.frameId > startFrameId)
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
    coarsenedTiles: accounted.reduce(
      (total, frame) => total + frame.frontier.coarsenedTiles,
      0,
    ),
    reasonCounts: sampledFrames
      .flatMap((frame) => frame.deadlineReasonCodes)
      .reduce(
        (counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }),
        {},
      ),
    residency: session.diagnostics().streaming.residencyStageCounts,
  };
}

function aggregatePaths(paths) {
  const complete = paths.filter((path) => path.presentedFrameIntervalMs !== null);
  return {
    worstPresentedP95Ms: Math.max(...complete.map((path) => path.presentedFrameIntervalMs.p95)),
    worstPresentedP99Ms: Math.max(...complete.map((path) => path.presentedFrameIntervalMs.p99)),
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
      '| Path | Presented p50 | p95 | p99 | Exact points p95 | Input→present p95 | Decode backlog max |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...value.paths.map(
        (path) =>
          `| ${path.name} | ${formatMs(path.presentedFrameIntervalMs?.p50)} | ${formatMs(path.presentedFrameIntervalMs?.p95)} | ${formatMs(path.presentedFrameIntervalMs?.p99)} | ${path.exactPrimitivesPerFrame.points?.p95 ?? 'n/a'} | ${formatMs(path.inputToPresentMs?.p95)} | ${path.decodeBacklog?.maximum ?? 'n/a'} |`,
      ),
      '',
      '| Path | Class | Point budget | Selected points max | Selected bytes max | Selected draws max | Frames over budget |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
      ...value.paths.map(
        (path) =>
          `| ${path.name} | ${path.frontier.hardwareClass ?? 'n/a'} | ${path.frontier.pointBudget ?? 'n/a'} | ${path.frontier.maximumSelectedPoints} | ${path.frontier.maximumSelectedBytes} | ${path.frontier.maximumSelectedDrawCalls} | ${path.frontier.framesOverBudget} |`,
      ),
      '',
      `Worst path p95: **${formatMs(value.aggregate.worstPresentedP95Ms)}**.`,
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
