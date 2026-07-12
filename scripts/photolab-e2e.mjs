#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

const workspace = resolve(import.meta.dirname, '..');
const options = parseArguments(process.argv.slice(2));
const source = resolve(options.source);
const outputRoot = resolve(options.output);
const projectPath = join(outputRoot, 'photolab-e2e.hcad');
const sidecarPath = resolve(options.sidecar);
const reportPath = join(outputRoot, 'result.json');
const beta2007Grid = join(workspace, 'vendor/proj-data/de_adv_BETA2007.tif');
const startedAt = Date.now();

if (!existsSync(sidecarPath)) throw new Error(`Sidecar is missing: ${sidecarPath}`);
if (!existsSync(source)) throw new Error(`Image source is missing: ${source}`);
if (!options.reuse) rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

let rpc;
const report = {
  schemaVersion: 1,
  source,
  projectPath,
  profile: options.profile,
  requestedProducts: options.products,
  maxImages: options.maxImages,
  startedAt: new Date(startedAt).toISOString(),
  stages: [],
};

async function main() {
  rpc = new RpcClient(sidecarPath);
  try {
    await rpc.start();
    if (options.reuse && existsSync(projectPath)) {
      await stage('openProject', () =>
        rpc.call('photolab.project.open', {
          path: projectPath,
          workingRoot: join(outputRoot, '.working'),
          useLocalWorkingCopy: false,
          recoverExistingWorkingCopy: true,
        }),
      );
    } else {
      await stage('createProject', () =>
        rpc.call('photolab.project.create', {
          path: projectPath,
          name: `PhotoLab E2E · ${basename(source)}`,
        }),
      );
      const paths = collectImages(source).slice(0, options.maxImages);
      if (paths.length < 2) throw new Error(`Need at least two images, found ${paths.length}`);
      const batch = await stage('inspectImages', () =>
        rpc.call('photolab.images.inspect', { paths }),
      );
      const areaOfInterest = imageArea(batch.photos);
      const query = {
        source: { crs: { kind: 'epsg', value: 4326 } },
        target: { crs: { kind: 'epsg', value: options.targetEpsg } },
        areaOfInterest,
        selectionPolicy: { allowBallpark: false, onlyBest: true },
        gridCatalog: [],
      };
      const discovery = await stage('discoverCrs', () =>
        rpc.call('photolab.crs.discover', {
          operationId: `e2e-crs-discover-${Date.now()}`,
          query,
        }),
      );
      const operation = discovery.candidates.find(
        (candidate) =>
          candidate.bestAvailable &&
          !candidate.ballpark &&
          candidate.requiredGrids.every((grid) => grid.availability.state === 'presentVerified'),
      );
      if (!operation) throw new Error('No accurate offline CRS operation is available');
      const transformation = await stage('freezeCrs', () =>
        rpc.call('photolab.crs.freeze', {
          operationId: `e2e-crs-freeze-${Date.now()}`,
          decision: {
            schemaVersion: 1,
            containsGpsData: true,
            horizontal: { source: query.source, target: query.target },
            vertical: {
              source: { kind: 'unknown' },
              target: { kind: 'unknown' },
              mode: 'preserveValues',
            },
            areaOfInterest,
            operation,
            selectionPolicy: query.selectionPolicy,
            databaseVersions: discovery.audit.versions,
          },
        }),
      );
      await stage('commitImages', () =>
        rpc.call('photolab.images.commit', {
          operationId: `e2e-image-import-${Date.now()}`,
          transformation,
          images: batch.photos.map((photo) => ({
            photo,
            projectedReference: null,
            tags: isRtkFixed(photo) ? ['rtkFixed'] : [],
          })),
        }),
      );
    }

    const images = await rpc.call('photolab.images.list', {});
    if (images.length < 2) throw new Error(`Project has only ${images.length} images`);
    const existingAlignment = await alignmentAvailable();
    if (!existingAlignment) {
      const alignment = await stage('startAlignment', () =>
        rpc.call('photolab.jobs.startAlignment', {
          operationId: `e2e-align-${Date.now()}`,
          profile: options.profile,
          cameraEntityIds: [],
        }),
      );
      await stage('waitAlignment', () => waitForJob(alignment.job.id));
    }

    const gcpOptimization = options.agisoftGcp ? await runAgisoftGcp(images) : null;

    for (const product of options.products) {
      const configuration = productConfiguration(product, options.smoke);
      const queued = await stage(`start:${product}`, () =>
        rpc.call('photolab.jobs.startProduct', {
          operationId: `e2e-${product}-${Date.now()}`,
          configuration,
          processingSetId: null,
        }),
      );
      await stage(`wait:${product}`, () => waitForJob(queued.job.id));
    }

    const [snapshot, products, jobs, cameras] = await Promise.all([
      rpc.call('photolab.project.snapshot', {}),
      rpc.call('photolab.products.list', {}),
      rpc.call('photolab.jobs.list', { includeTerminal: true }),
      rpc.call('photolab.gcp.alignedCameras', {}),
    ]);
    Object.assign(report, {
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      imageCount: images.length,
      alignedCameraCount: cameras.length,
      alignedRatio: cameras.length / images.length,
      products,
      candidateMetrics: collectCandidateMetrics(products, cameras.length, gcpOptimization),
      jobs,
      autosaveGeneration: snapshot.session.autosaveGeneration,
      success: true,
    });
  } catch (error) {
    Object.assign(report, {
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      success: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    throw error;
  } finally {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await rpc.stop();
  }
}

function collectCandidateMetrics(products, alignedImages, gcpOptimization) {
  const latest = (kind) => products.filter((product) => product.kind === kind).at(-1);
  const sparse = latest('sparse');
  const dense = latest('dense');
  const depth = latest('depth');
  const orthomosaic = latest('orthomosaic');
  const metrics = {
    alignedImages,
    targetEpsg: options.targetEpsg,
    reprojectionRmsPixels: null,
    depthImageCount: null,
    densePointCount: dense?.pointCount ?? null,
    orthomosaicResolutionMetersPerPixel: null,
    orthomosaicBounds: null,
    controlSpatial3dRmseMeters:
      gcpOptimization?.artifact?.result?.statistics?.control?.spatial3dRmsMeters ?? null,
    checkpointSpatial3dRmseMeters:
      gcpOptimization?.artifact?.result?.statistics?.checkpoint?.spatial3dRmsMeters ?? null,
  };
  if (sparse) {
    const parts = sparse.relativePath.split(/[\\/]/);
    const jobId = parts[0] === 'colmap' ? parts[1] : null;
    if (jobId) {
      const summary = readProjectJson(`datasets/colmap/${jobId}/output-summary.json`);
      const selected = summary.mappingCandidates?.find((candidate) => candidate.selected);
      metrics.reprojectionRmsPixels = selected?.meanReprojectionError ?? null;
    }
  }
  if (depth) {
    const index = readProjectJson(`datasets/${depth.relativePath}`);
    metrics.depthImageCount = index.depthImages?.length ?? null;
  }
  if (orthomosaic) {
    const manifest = readProjectJson(`datasets/${orthomosaic.relativePath}`);
    metrics.orthomosaicResolutionMetersPerPixel = manifest.grid?.gsd ?? null;
    metrics.orthomosaicBounds = manifest.grid?.bounds
      ? {
          min: [manifest.grid.bounds.minimumEast, manifest.grid.bounds.minimumNorth],
          max: [manifest.grid.bounds.maximumEast, manifest.grid.bounds.maximumNorth],
        }
      : null;
  }
  return metrics;
}

async function runAgisoftGcp(images) {
  const projectRoot = resolve(source, '..');
  const gcpDirectory = join(projectRoot, '03_Bodenkontrollpunkte');
  const csv = readdirSync(gcpDirectory)
    .filter((name) => /\.csv$/i.test(name))
    .map((name) => join(gcpDirectory, name))[0];
  if (!csv) throw new Error(`Agisoft GCP CSV is missing below ${gcpDirectory}`);
  const mapping = {
    delimiter: ',',
    decimalSeparator: 'point',
    hasHeader: false,
    name: { kind: 'index', value: 0 },
    east: { kind: 'index', value: 1 },
    north: { kind: 'index', value: 2 },
    height: { kind: 'index', value: 3 },
    defaultRole: 'controlXyz',
    defaultUncertainty: { horizontalStddevMeters: 0.005, heightStddevMeters: 0.01 },
  };
  await stage('previewGcp', () =>
    rpc.call('photolab.gcp.preview', { path: csv, mapping, maximumPreviewRows: 100 }),
  );
  const query = {
    source: { crs: { kind: 'epsg', value: 31468 } },
    target: { crs: { kind: 'epsg', value: options.targetEpsg } },
    areaOfInterest: imageArea(images.map((image) => image.metadata.inspectedPhoto)),
    selectionPolicy: { allowBallpark: false, onlyBest: true },
    gridCatalog: [
      {
        kind: 'gtg',
        officialFilename: 'de_adv_BETA2007.tif',
        officialSha256: '46e681fcc7d022dde1db1f9d0a3426a9bfb1d4a151af69a81b3c30104c9388e2',
        license: {
          licenseName: 'AdV free redistribution notice',
          source: 'https://cdn.proj.org/de_adv_README.txt',
          redistributionAllowed: true,
        },
        coverage: {
          westLongitude: 5.416666666666667,
          southLatitude: 46.95,
          eastLongitude: 15.75,
          northLatitude: 55.35,
        },
        localPath: beta2007Grid,
      },
    ],
  };
  const discovery = await stage('discoverGcpCrs', () =>
    rpc.call('photolab.crs.discover', {
      operationId: `e2e-gcp-crs-discover-${Date.now()}`,
      query,
    }),
  );
  const operation = discovery.candidates.find(
    (candidate) =>
      candidate.bestAvailable &&
      !candidate.ballpark &&
      candidate.requiredGrids.every((grid) => grid.availability.state === 'presentVerified'),
  );
  if (!operation)
    throw new Error(
      `No accurate offline GCP CRS operation is available: ${JSON.stringify(discovery.candidates)}`,
    );
  const transformation = await stage('freezeGcpCrs', () =>
    rpc.call('photolab.crs.freeze', {
      operationId: `e2e-gcp-crs-freeze-${Date.now()}`,
      decision: {
        schemaVersion: 1,
        containsGpsData: false,
        horizontal: { source: query.source, target: query.target },
        vertical: {
          source: { kind: 'unknown' },
          target: { kind: 'unknown' },
          mode: 'preserveValues',
        },
        areaOfInterest: query.areaOfInterest,
        operation,
        selectionPolicy: query.selectionPolicy,
        databaseVersions: discovery.audit.versions,
      },
    }),
  );
  const [, existingCollection] = await rpc.call('photolab.gcp.list', {});
  if (existingCollection.points.length === 0) {
    await stage('commitGcp', () =>
      rpc.call('photolab.gcp.commit', {
        operationId: `e2e-gcp-import-${Date.now()}`,
        path: csv,
        mapping,
        transformation,
      }),
    );
  } else {
    const expected = new Set(['gcp260706.001', 'gcp260706.002', 'gcp260706.003', 'gcp260706.004', 'gcp260706.005', 'gcp260706.006']);
    if (!existingCollection.points.every(({ point }) => expected.has(point.name))) {
      throw new Error('Existing GCP collection does not match the Agisoft golden control set');
    }
  }
  let [collectionHash, collection] = await rpc.call('photolab.gcp.list', {});
  const aligned = await rpc.call('photolab.gcp.alignedCameras', {});
  const agisoft = readAgisoftMarkers(projectRoot);
  const pointByName = new Map(collection.points.map((record) => [record.point.name, record.point]));
  const imageByStem = new Map(
    aligned.map((camera) => [camera.imageName.replace(/\.[^.]+$/, ''), camera]),
  );
  let observationIndex = 0;
  const observationCounts = new Map();
  for (const marker of agisoft.markers) {
    const point = pointByName.get(marker.label);
    if (!point) throw new Error(`Imported GCP is missing: ${marker.label}`);
    for (const location of marker.locations.filter((candidate) => candidate.pinned)) {
      const label = agisoft.cameraLabels.get(location.cameraId);
      const camera = label ? imageByStem.get(label) : null;
      if (!camera) continue;
      const updated = await rpc.call('photolab.gcp.observation.upsert', {
        operationId: `e2e-gcp-observation-${observationIndex++}`,
        expectedCollectionSha256: collectionHash,
        observation: {
          pointId: point.id,
          imageId: camera.imageId,
          state: { state: 'manual', coordinate: { xPixels: location.x, yPixels: location.y } },
        },
      });
      collectionHash = updated.collectionSha256;
      observationCounts.set(point.id, (observationCounts.get(point.id) ?? 0) + 1);
    }
  }
  [collectionHash, collection] = await rpc.call('photolab.gcp.list', {});
  const eligiblePoints = collection.points
    .map(({ point }) => point)
    .filter((point) => (observationCounts.get(point.id) ?? 0) >= 2);
  if (eligiblePoints.length < 2) {
    throw new Error('Agisoft GCP smoke scope has fewer than two measured points');
  }
  const roleOverrides = Object.fromEntries(
    eligiblePoints.map((point) => [
      point.id,
      agisoft.checkpointLabels.has(point.name) ? 'checkpointXyz' : 'controlXyz',
    ]),
  );
  const snapshot = await stage('snapshotGcp', () =>
    rpc.call('photolab.gcp.optimization.snapshot', {
      operationId: `e2e-gcp-snapshot-${Date.now()}`,
      expectedCollectionSha256: collectionHash,
      scope: {
        label: 'Agisoft Sulzberg golden controls and checkpoints',
        pointIds: eligiblePoints.map((point) => point.id),
        cameraReferenceImageIds: [],
      },
      roleOverrides,
    }),
  );
  const optimization = await stage('startGcpOptimization', () =>
    rpc.call('photolab.jobs.startGcpOptimization', {
      operationId: `e2e-gcp-optimize-${Date.now()}`,
      snapshotSha256: snapshot.snapshotSha256,
    }),
  );
  await stage('waitGcpOptimization', () => waitForJob(optimization.job.id));
  return rpc.call('photolab.gcp.optimization.latest', { processingSetId: null });
}

function readAgisoftMarkers(projectRoot) {
  const projectName = basename(projectRoot);
  const projectFiles = join(projectRoot, `${projectName}.files`);
  const chunk = unzipText(join(projectFiles, '0/chunk.zip'), 'doc.xml');
  const frame = unzipText(join(projectFiles, '0/0/frame.zip'), 'doc.xml');
  const cameraLabels = new Map(
    [...chunk.matchAll(/<camera\s+id="(\d+)"[^>]*\blabel="([^"]+)"/g)].map((match) => [
      Number(match[1]),
      decodeXml(match[2]),
    ]),
  );
  const labelsById = new Map(
    [...chunk.matchAll(/<marker\s+id="(\d+)"\s+label="([^"]+)"/g)].map((match) => [
      Number(match[1]),
      decodeXml(match[2]),
    ]),
  );
  const checkpointLabels = new Set(
    [...chunk.matchAll(/<marker\s+id="(\d+)"\s+label="([^"]+)">\s*<reference[^>]*enabled="false"/g)].map(
      (match) => decodeXml(match[2]),
    ),
  );
  const markers = [...frame.matchAll(/<marker\s+marker_id="(\d+)">([\s\S]*?)<\/marker>/g)]
    .map((match) => ({
      label: labelsById.get(Number(match[1])),
      locations: [...match[2].matchAll(/<location\s+camera_id="(\d+)"\s+pinned="(true|false)"\s+x="([^"]+)"\s+y="([^"]+)"\s*\/>/g)].map(
        (location) => ({
          cameraId: Number(location[1]),
          pinned: location[2] === 'true',
          x: Number(location[3]),
          y: Number(location[4]),
        }),
      ),
    }))
    .filter((marker) => marker.label);
  return { cameraLabels, checkpointLabels, markers };
}

function unzipText(archive, entry) {
  try {
    return execFileSync('unzip', ['-p', archive, entry], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // Some confined Linux runners report EPERM while reaping an otherwise
    // successful unzip process. Accept its complete stdout only when the child
    // itself exited successfully; all real archive errors still propagate.
    if (error?.status === 0 && typeof error.stdout === 'string' && error.stdout.length > 0) {
      return error.stdout;
    }
    throw error;
  }
}

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function readProjectJson(relativePath) {
  return JSON.parse(readFileSync(join(projectPath, relativePath), 'utf8'));
}

async function stage(name, action) {
  const start = Date.now();
  process.stderr.write(`[PhotoLab E2E] ${name}\n`);
  try {
    const result = await action();
    report.stages.push({ name, state: 'completed', durationMs: Date.now() - start });
    return result;
  } catch (error) {
    report.stages.push({
      name,
      state: 'failed',
      durationMs: Date.now() - start,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function waitForJob(jobId) {
  let lastState = '';
  while (true) {
    const jobs = await rpc.call('photolab.jobs.list', { includeTerminal: true });
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Job disappeared: ${jobId}`);
    const state = `${job.state.kind}:${job.progress.stage.label}:${job.progress.metrics.completedUnits}`;
    if (state !== lastState) {
      process.stderr.write(`[PhotoLab E2E] ${jobId} · ${state}\n`);
      lastState = state;
    }
    if (job.state.kind === 'completed') return job;
    if (job.state.kind === 'failed') throw new Error(`${job.state.code}: ${job.state.message}`);
    if (job.state.kind === 'cancelled') throw new Error(`Job cancelled: ${jobId}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, options.pollMs));
  }
}

async function alignmentAvailable() {
  try {
    const cameras = await rpc.call('photolab.gcp.alignedCameras', {});
    return cameras.length >= 2;
  } catch {
    return false;
  }
}

function collectImages(root) {
  const supported = new Set([
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.png',
    '.dng',
    '.heic',
    '.heif',
    '.avif',
    '.cr3',
    '.raf',
    '.iiq',
  ]);
  const result = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && supported.has(extname(entry.name).toLowerCase()))
        result.push(child);
    }
  };
  visit(root);
  return result.sort();
}

function imageArea(photos) {
  const positions = photos.flatMap((photo) => {
    const dji = photo.metadata.djiXmp;
    if (Number.isFinite(dji.latitudeDegrees) && Number.isFinite(dji.longitudeDegrees)) {
      return [[dji.longitudeDegrees, dji.latitudeDegrees]];
    }
    const gps = photo.metadata.exif.gps;
    return gps ? [[gps.longitudeDegrees, gps.latitudeDegrees]] : [];
  });
  if (positions.length === 0)
    return { westLongitude: -180, southLatitude: -90, eastLongitude: 180, northLatitude: 90 };
  const longitudes = positions.map(([longitude]) => longitude);
  const latitudes = positions.map(([, latitude]) => latitude);
  return {
    westLongitude: Math.max(-180, Math.min(...longitudes) - 0.01),
    southLatitude: Math.max(-90, Math.min(...latitudes) - 0.01),
    eastLongitude: Math.min(180, Math.max(...longitudes) + 0.01),
    northLatitude: Math.min(90, Math.max(...latitudes) + 0.01),
  };
}

function isRtkFixed(photo) {
  return /fix/i.test(photo.metadata.djiXmp.rtk?.flag ?? '');
}

function productConfiguration(kind, smoke) {
  if (kind === 'depth')
    return { kind, imageDownscale: smoke ? 8 : 2, filter: 'moderate', reuseCompatibleMaps: true };
  if (kind === 'dense')
    return {
      kind,
      imageDownscale: smoke ? 8 : 2,
      minimumViews: 3,
      retainConfidence: true,
      calculateColors: true,
    };
  if (kind === 'dem')
    return {
      kind,
      surface: 'dsm',
      resolutionMetersPerPixel: smoke ? 0.25 : 0.05,
      interpolateNodata: true,
      tileSizePixels: 512,
    };
  if (kind === 'ortho')
    return {
      kind,
      resolutionMetersPerPixel: smoke ? 0.2 : 0.03,
      blendMode: 'mosaic',
      colorCorrection: true,
      fillHoles: true,
      tileSizePixels: 512,
    };
  if (kind === 'mesh')
    return {
      kind,
      targetFaceCount: smoke ? 100_000 : 5_000_000,
      interpolateHoles: true,
      buildTexture: true,
      textureSize: smoke ? 2048 : 8192,
    };
  if (kind === 'splat')
    return {
      kind,
      initialization: 'sparseTiePoints',
      iterations: smoke ? 100 : 30_000,
      sphericalHarmonicsDegree: 3,
      maximumSplats: smoke ? 100_000 : 10_000_000,
      maximumResolution: smoke ? 640 : 1_920,
      retainTrainingCheckpoints: true,
    };
  throw new Error(`Unknown product: ${kind}`);
}

function parseArguments(args) {
  const get = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const source = get(
    '--source',
    'photolab/Agisoft Exampleprojects/260706_Sulzberg_SUMA_UrGel/01_Photos',
  );
  const output = get('--output', '.build/photolab-e2e/agisoft-sulzberg');
  const products = get('--products', '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const profile = get('--profile', 'fast');
  if (!['fast', 'qualityHybrid', 'maximumRobustness'].includes(profile))
    throw new Error(`Invalid profile: ${profile}`);
  return {
    source,
    output,
    products,
    profile,
    maxImages: Number.parseInt(get('--max-images', '2147483647'), 10),
    targetEpsg: Number.parseInt(get('--target-epsg', '25832'), 10),
    pollMs: Number.parseInt(get('--poll-ms', '1000'), 10),
    sidecar: get('--sidecar', 'target/debug/himmelcad-sidecar'),
    reuse: args.includes('--reuse'),
    smoke: args.includes('--smoke'),
    agisoftGcp: args.includes('--agisoft-gcp'),
  };
}

class RpcClient {
  constructor(executable) {
    this.executable = executable;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    this.child = spawn(this.executable, [], {
      cwd: workspace,
      env: {
        ...process.env,
        HIMMELCAD_WORKSPACE_ROOT: workspace,
        PROJ_DATA: `${join(workspace, 'vendor/proj-data')}:/usr/share/proj`,
        PROJ_NETWORK: 'OFF',
        RUST_LOG: 'himmelcad_sidecar=info,parse_gps=warn,nom_exif=warn',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message));
      else pending.resolve(response.result);
    });
    readline.createInterface({ input: this.child.stderr }).on('line', (line) => {
      process.stderr.write(`[sidecar] ${line}\n`);
    });
    await new Promise((resolveStart, rejectStart) => {
      const timeout = setTimeout(resolveStart, 100);
      this.child.once('error', (error) => {
        clearTimeout(timeout);
        rejectStart(error);
      });
      this.child.once('exit', (code) => {
        clearTimeout(timeout);
        rejectStart(new Error(`Sidecar exited during startup with code ${code}`));
      });
    });
    await this.call('ping', {});
  }

  call(method, params) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error('Sidecar is not writable'));
    const id = this.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async stop() {
    if (!this.child) return;
    this.child.stdin.end();
    await new Promise((resolveStop) => {
      const timeout = setTimeout(() => {
        this.child.kill('SIGTERM');
        resolveStop();
      }, 5_000);
      this.child.once('exit', () => {
        clearTimeout(timeout);
        resolveStop();
      });
    });
  }
}

await main();
