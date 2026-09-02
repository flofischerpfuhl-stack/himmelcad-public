#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

import { agisoftGoldenMvsConfiguration } from './lib/photolab-agisoft-products.mjs';
import {
  assertCancellationAcknowledged,
  assertCancellationLatencies,
  assertCompatibleResume,
  assertSidecarResumeIdentityRejection,
  assertNoPartialPublication,
  CancellationTracker,
  canonicalCancellationStage,
  capturePublicationState,
  immutableResumeIdentity,
} from './lib/photolab-e2e-contracts.mjs';

const workspace = resolve(import.meta.dirname, '..');
const cliArguments = process.argv.slice(2);
if (cliArguments.includes('--help') || cliArguments.includes('-h')) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
const options = parseArguments(cliArguments);
const source = resolve(options.source);
const outputRoot = resolve(options.output);
const projectPath = join(outputRoot, 'photolab-e2e.hcad');
const sidecarPath = resolve(options.sidecar);
const reportPath = join(outputRoot, 'result.json');
const previousReport =
  options.reuse && existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
const beta2007Grid = join(workspace, 'vendor/proj-data/de_adv_BETA2007.tif');
const startedAt = Date.now();

if (!existsSync(sidecarPath)) throw new Error(`Sidecar is missing: ${sidecarPath}`);
if (!existsSync(source)) throw new Error(`Image source is missing: ${source}`);
if (!options.reuse) rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

let rpc;
let cancellationTriggered = false;
let resumeIdentityVerified = false;
let incompatibleCheckpointRejected = false;
const cancellationTracker = new CancellationTracker({
  target: options.verifyResume ? '' : options.cancelStage,
  afterUnits: options.cancelAfterUnits,
});
const report = {
  schemaVersion: 1,
  source,
  projectPath,
  profile: options.profile,
  requestedProducts: options.products,
  maxImages: options.maxImages,
  goldenAgisoft: options.goldenAgisoft,
  cancellationPolicy: {
    targetStage: options.cancelStage || null,
    cancelAfterUnits: options.cancelAfterUnits,
    maximumAcknowledgementMs: options.maxCancelAcknowledgementMs,
    maximumTerminalMs: options.maxCancelTerminalMs,
    verifyResume: options.verifyResume,
    expectedIncompatibleField: options.expectIncompatibleCheckpoint || null,
  },
  startedAt: new Date(startedAt).toISOString(),
  stages: previousReport?.stages ?? [],
};

async function main() {
  rpc = new RpcClient(sidecarPath);
  try {
    await rpc.start();
    if (options.resumeAudit && previousReport?.cancellation?.resumeIdentity == null) {
      throw new Error('Resume verification requires a reused result with a cancelled job identity');
    }
    if (options.resumeAudit && previousReport?.cancellation?.historyJobId == null) {
      throw new Error('Resume verification requires a sidecar-owned history job id');
    }
    if (options.resumeAudit && previousReport?.cancellation?.terminalState !== 'cancelled') {
      throw new Error('Resume verification requires a prior terminal cancelled state');
    }
    if (
      options.verifyResume &&
      previousReport?.cancellation?.checkpointSequenceAtTerminal == null
    ) {
      throw new Error(
        '--verify-resume requires the cancelled run to have a committed terminal checkpoint',
      );
    }
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
      const paths = collectImages(source)
        .filter((_, index) => index % options.imageStride === 0)
        .slice(0, options.maxImages);
      if (paths.length < 2) throw new Error(`Need at least two images, found ${paths.length}`);
      const batch = await stage('inspectImages', () =>
        rpc.call('photolab.images.inspect', { paths }),
      );
      const areaOfInterest = imageArea(batch.photos);
      const transformHeight = Number.isSafeInteger(options.targetVerticalEpsg);
      const query = {
        source: { crs: { kind: 'epsg', value: transformHeight ? 4979 : 4326 } },
        target: {
          crs: transformHeight
            ? {
                kind: 'authority',
                value: `EPSG:${options.targetEpsg}+${options.targetVerticalEpsg}`,
              }
            : { kind: 'epsg', value: options.targetEpsg },
        },
        areaOfInterest,
        selectionPolicy: { allowBallpark: false, onlyBest: true },
        gridCatalog: await buildE2eGridCatalog(options),
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
            vertical: transformHeight
              ? {
                  source: { kind: 'ellipsoidal' },
                  target: {
                    kind: 'normalHeight',
                    verticalCrs: { kind: 'epsg', value: options.targetVerticalEpsg },
                  },
                  mode: 'transform',
                }
              : {
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
    if (options.importOnly) {
      const snapshot = await rpc.call('photolab.project.snapshot', {});
      Object.assign(report, {
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        imageCount: images.length,
        autosaveGeneration: snapshot.session.autosaveGeneration,
        success: true,
        importOnly: true,
      });
      return;
    }
    const existingAlignment = await alignmentAvailable();
    if (!existingAlignment) {
      const publicationBefore = await captureCurrentPublicationState();
      const alignment = await stage('startAlignment', () =>
        rpc.call('photolab.jobs.startAlignment', {
          operationId: `e2e-align-${Date.now()}`,
          profile: options.profile,
          cameraEntityIds: [],
        }),
      );
      const resumeAudit = await verifyQueuedResumeIdentity(alignment.job);
      if (resumeAudit === 'rejected') {
        await cancelRejectedResumeJob(alignment.job.id, publicationBefore);
        return;
      }
      const terminal = await stage('waitAlignment', () => waitForJob(alignment.job.id));
      if (terminal.state.kind === 'cancelled') {
        await verifyCancellationPublicationInvariant(publicationBefore);
        return;
      }
    }

    const gcpOptimization = options.agisoftGcp ? await runAgisoftGcp(images) : null;

    for (const product of options.products) {
      const publicationBefore = await captureCurrentPublicationState();
      const configuration = productConfiguration(product, options.smoke);
      const queued = await stage(`start:${product}`, () =>
        rpc.call('photolab.jobs.startProduct', {
          operationId: `e2e-${product}-${Date.now()}`,
          configuration,
          processingSetId: null,
        }),
      );
      const resumeAudit = await verifyQueuedResumeIdentity(queued.job);
      if (resumeAudit === 'rejected') {
        await cancelRejectedResumeJob(queued.job.id, publicationBefore);
        return;
      }
      const terminal = await stage(`wait:${product}`, () => waitForJob(queued.job.id));
      if (terminal.state.kind === 'cancelled') {
        await verifyCancellationPublicationInvariant(publicationBefore);
        return;
      }
    }

    if (options.cancelStage && !options.verifyResume && !cancellationTriggered) {
      throw new Error(`Cancellation stage was not observed: ${options.cancelStage}`);
    }
    if (options.verifyResume && !resumeIdentityVerified) {
      throw new Error('No queued job matched the cancelled job identity selected for resume');
    }
    if (options.expectIncompatibleCheckpoint && !incompatibleCheckpointRejected) {
      throw new Error('No queued job exposed the requested incompatible checkpoint identity');
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
      candidateMetrics: collectCandidateMetrics(
        products,
        cameras.length,
        gcpOptimization,
        jobs,
        previousReport?.candidateMetrics ?? null,
      ),
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
    const reportTarget = options.expectIncompatibleCheckpoint
      ? incompatibleAttemptReportPath(outputRoot, startedAt)
      : report.success === false && options.reuse && previousReport?.success === true
        ? failedAttemptReportPath(outputRoot, startedAt)
        : reportPath;
    mkdirSync(dirname(reportTarget), { recursive: true });
    writeFileSync(reportTarget, `${JSON.stringify(report, null, 2)}\n`);
    if (reportTarget !== reportPath) {
      process.stderr.write(
        `Resume audit attempt written to ${reportTarget}; the reusable cancellation result remains at ${reportPath}.\n`,
      );
    }
    await rpc.stop();
  }
}

function failedAttemptReportPath(root, timestamp) {
  const label = new Date(timestamp).toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return join(root, 'attempts', `failed-${label}.json`);
}

function incompatibleAttemptReportPath(root, timestamp) {
  const label = new Date(timestamp).toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return join(root, 'attempts', `incompatible-${label}.json`);
}

function collectCandidateMetrics(products, alignedImages, gcpOptimization, jobs, previousMetrics) {
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const latest = (kind) =>
    products
      .filter((product) => product.kind === kind)
      .map((product, index) => ({
        product,
        index,
        finishedAt: jobById.get(productJobId(product))?.finishedAtUnixMs ?? -1,
      }))
      .sort((left, right) => left.finishedAt - right.finishedAt || left.index - right.index)
      .at(-1)?.product;
  const sparse = latest('sparse');
  const dense = latest('dense');
  const depth = latest('depth');
  const orthomosaic = latest('orthomosaic');
  const dem = latest('dem');
  const selection = Object.fromEntries(
    ['sparse', 'depth', 'dense', 'dem', 'orthomosaic', 'mesh', 'gaussianSplat'].map((kind) => [
      kind,
      latest(kind)?.entityId ?? null,
    ]),
  );
  const gcpEvidence = gcpOptimization
    ? {
        operationId: gcpOptimization.operationId,
        artifactSha256: gcpOptimization.artifactSha256,
        snapshotSha256: gcpOptimization.snapshotSha256,
        sourceAlignmentEntityId: gcpOptimization.sourceAlignmentEntityId,
        processingSetId: gcpOptimization.processingSetId ?? null,
      }
    : (previousMetrics?.gcpOptimizationEvidence ?? null);
  const gcpObservationEvidence =
    gcpOptimization?.observationEvidence ?? previousMetrics?.gcpObservationEvidence ?? null;
  const metrics = {
    alignedImages,
    targetEpsg: options.targetEpsg,
    targetVerticalEpsg: options.targetVerticalEpsg,
    sourceAlignmentEntityId:
      sparse?.sourceAlignmentEntityId ?? previousMetrics?.sourceAlignmentEntityId ?? null,
    processingSetId: sparse?.processingSetId ?? previousMetrics?.processingSetId ?? null,
    selectedProductEntityIds: selection,
    gcpOptimizationEvidence: gcpEvidence,
    gcpObservationEvidence,
    reprojectionRmsPixels: null,
    depthImageCount: null,
    densePointCount: dense?.pointCount ?? null,
    denseFusionEvidence: previousMetrics?.denseFusionEvidence ?? null,
    orthomosaicResolutionMetersPerPixel: null,
    orthomosaicBounds: null,
    orthomosaicValidFraction: null,
    controlSpatial3dRmseMeters:
      gcpOptimization?.artifact?.result?.statistics?.control?.spatial3dRmsMeters ??
      previousMetrics?.controlSpatial3dRmseMeters ??
      null,
    checkpointSpatial3dRmseMeters:
      gcpOptimization?.artifact?.result?.statistics?.checkpoint?.spatial3dRmsMeters ??
      previousMetrics?.checkpointSpatial3dRmseMeters ??
      null,
    gcpStatistics:
      gcpOptimization?.artifact?.result?.statistics ?? previousMetrics?.gcpStatistics ?? null,
    rasterStatistics: previousMetrics?.rasterStatistics ?? null,
    runtimeSeconds: Object.fromEntries(
      [
        ['alignment', productJobId(sparse)],
        ['gcpOptimization', gcpEvidence?.operationId],
        ['depth', productJobId(depth)],
        ['denseCloud', productJobId(dense)],
        ['dem', productJobId(dem)],
        ['orthomosaic', productJobId(orthomosaic)],
        ['mesh', productJobId(latest('mesh'))],
        ['gaussianSplat', productJobId(latest('gaussianSplat'))],
      ].map(([label, jobId]) => {
        const job = jobId ? jobById.get(jobId) : null;
        const milliseconds =
          job?.finishedAtUnixMs != null && job?.startedAtUnixMs != null
            ? job.finishedAtUnixMs - job.startedAtUnixMs
            : null;
        return [
          label,
          milliseconds == null
            ? (previousMetrics?.runtimeSeconds?.[label] ?? null)
            : milliseconds / 1000,
        ];
      }),
    ),
  };
  if (sparse) {
    const parts = sparse.relativePath.split(/[\\/]/);
    const jobId = parts[0] === 'colmap' ? parts[1] : null;
    if (jobId) {
      const summary = readProjectJson(`datasets/colmap/${jobId}/output-summary.json`);
      const selected = summary.mappingCandidates?.find((candidate) => candidate.selected);
      metrics.reprojectionRmsPixels = selected?.meanReprojectionError ?? null;
      metrics.alignmentEvidence = selected
        ? {
            jobId,
            registeredImages: selected.registeredImages,
            sparsePoints: selected.points3d,
            observations: selected.observations,
            reprojectionRmsPixels: selected.meanReprojectionError,
          }
        : null;
      if (metrics.runtimeSeconds.alignment == null && Array.isArray(summary.commands)) {
        const commandMilliseconds = summary.commands.reduce(
          (total, command) => total + (Number(command.durationMs) || 0),
          0,
        );
        if (commandMilliseconds > 0) metrics.runtimeSeconds.alignment = commandMilliseconds / 1000;
      }
    }
  }
  if (depth) {
    const index = readProjectJson(`datasets/${depth.relativePath}`);
    metrics.depthImageCount = index.depthImages?.length ?? null;
  }
  if (dense) {
    const jobId = productJobId(dense);
    if (jobId) {
      const output = readProjectJson(`datasets/mvs/${jobId}/output/index.json`);
      metrics.denseFusionEvidence = output.densePointCloud?.fusion ?? null;
    }
  }
  const rasterStatistics = {};
  for (const [kind, product] of [
    ['dem', dem],
    ['orthomosaic', orthomosaic],
  ]) {
    if (!product) continue;
    const manifestPath = join(projectPath, 'datasets', product.relativePath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const cogPath = join(dirname(dirname(manifestPath)), 'product.cog.tif');
    const raster = JSON.parse(execText('gdalinfo', ['-json', '-approx_stats', cogPath]));
    const transform = raster.geoTransform;
    const bounds =
      Array.isArray(transform) && transform.length === 6 && Array.isArray(raster.size)
        ? {
            min: [transform[0], transform[3] + transform[5] * raster.size[1]],
            max: [transform[0] + transform[1] * raster.size[0], transform[3]],
          }
        : null;
    const alpha = raster.bands?.find((band) => band.colorInterpretation === 'Alpha');
    const alphaMean = Number(alpha?.mean ?? alpha?.metadata?.['']?.STATISTICS_MEAN);
    rasterStatistics[kind] = {
      widthPixels: raster.size?.[0] ?? null,
      heightPixels: raster.size?.[1] ?? null,
      resolutionMetersPerPixel: Math.abs(transform?.[1] ?? Number.NaN),
      bounds,
      bandCount: raster.bands?.length ?? null,
      canonicalWktSha256:
        typeof raster.coordinateSystem?.wkt === 'string'
          ? createHash('sha256').update(raster.coordinateSystem.wkt).digest('hex')
          : null,
      validFraction: Number.isFinite(alphaMean) ? alphaMean / 255 : null,
    };
    if (kind !== 'orthomosaic') continue;
    metrics.orthomosaicResolutionMetersPerPixel = manifest.grid?.gsd ?? null;
    metrics.orthomosaicBounds = manifest.grid?.bounds
      ? {
          min: [manifest.grid.bounds.minimumEast, manifest.grid.bounds.minimumNorth],
          max: [manifest.grid.bounds.maximumEast, manifest.grid.bounds.maximumNorth],
        }
      : null;
    metrics.orthomosaicValidFraction = Number.isFinite(alphaMean) ? alphaMean / 255 : null;
  }
  if (Object.keys(rasterStatistics).length > 0) metrics.rasterStatistics = rasterStatistics;
  return metrics;
}

function productJobId(product) {
  if (typeof product?.relativePath !== 'string') return null;
  const parts = product.relativePath.split(/[\\/]/);
  if (['colmap', 'mvs', 'raster', 'mesh', 'splats'].includes(parts[0])) return parts[1] ?? null;
  return null;
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
  const existingGcpState = await rpc.call('photolab.gcp.list', {});
  const existingCollection = existingGcpState?.[1] ?? null;
  if (existingCollection == null || existingCollection.points.length === 0) {
    await stage('commitGcp', () =>
      rpc.call('photolab.gcp.commit', {
        operationId: `e2e-gcp-import-${Date.now()}`,
        path: csv,
        mapping,
        transformation,
        coordinatesAlreadyInProjectCrs: options.targetEpsg === 31468,
      }),
    );
  } else {
    const expected = new Set([
      'gcp260706.001',
      'gcp260706.002',
      'gcp260706.003',
      'gcp260706.004',
      'gcp260706.005',
      'gcp260706.006',
    ]);
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
  const importedObservations = [];
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
      importedObservations.push([marker.label, label, location.x, location.y, 'manual']);
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
  const controlCount = eligiblePoints.filter(
    (point) => !agisoft.checkpointLabels.has(point.name),
  ).length;
  if (controlCount < 3) {
    throw new Error(
      `Agisoft GCP scope has only ${controlCount} measured controls; at least three are required`,
    );
  }
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
  const result = await rpc.call('photolab.gcp.optimization.latest', { processingSetId: null });
  const eligibleNames = eligiblePoints.map((point) => point.name).sort();
  const checkpointNames = eligibleNames.filter((name) => agisoft.checkpointLabels.has(name));
  const controlNames = eligibleNames.filter((name) => !agisoft.checkpointLabels.has(name));
  importedObservations.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  return {
    ...result,
    observationEvidence: {
      schemaVersion: 1,
      source: {
        gcpCsvSha256: createHash('sha256').update(readFileSync(csv)).digest('hex'),
        chunkDocumentSha256: agisoft.chunkDocumentSha256,
        frameDocumentSha256: agisoft.frameDocumentSha256,
      },
      manualObservationCount: importedObservations.length,
      observationSetSha256: createHash('sha256')
        .update(JSON.stringify(importedObservations))
        .digest('hex'),
      pointObservationCounts: Object.fromEntries(
        eligibleNames.map((name) => {
          const point = pointByName.get(name);
          return [name, point ? (observationCounts.get(point.id) ?? 0) : 0];
        }),
      ),
      controlPointNames: controlNames,
      checkpointPointNames: checkpointNames,
    },
  };
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
    [
      ...chunk.matchAll(
        /<marker\s+id="(\d+)"\s+label="([^"]+)">\s*<reference[^>]*enabled="false"/g,
      ),
    ].map((match) => decodeXml(match[2])),
  );
  const markers = [...frame.matchAll(/<marker\s+marker_id="(\d+)">([\s\S]*?)<\/marker>/g)]
    .map((match) => ({
      label: labelsById.get(Number(match[1])),
      locations: [
        ...match[2].matchAll(
          /<location\s+camera_id="(\d+)"\s+pinned="(true|false)"\s+x="([^"]+)"\s+y="([^"]+)"\s*\/>/g,
        ),
      ].map((location) => ({
        cameraId: Number(location[1]),
        pinned: location[2] === 'true',
        x: Number(location[3]),
        y: Number(location[4]),
      })),
    }))
    .filter((marker) => marker.label);
  return {
    cameraLabels,
    checkpointLabels,
    markers,
    chunkDocumentSha256: createHash('sha256').update(chunk).digest('hex'),
    frameDocumentSha256: createHash('sha256').update(frame).digest('hex'),
  };
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

function execText(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // Some confined Linux runners report EPERM while reaping a child whose
    // command completed. Accept only non-empty complete stdout from a zero
    // status child; actual process failures remain failures.
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
    if (!cancellationTriggered && cancellationTracker.shouldRequest(job)) {
      cancellationTriggered = true;
      await cancellationTracker.request(job, (id) =>
        rpc.call('photolab.jobs.cancel', { jobId: id }),
      );
      report.cancellation = {
        ...cancellationTracker.result,
        historyJobId: job.id,
        resumeIdentity: immutableResumeIdentity(job),
        checkpointSequenceAtRequest: job.lastCheckpointSequence ?? null,
      };
      continue;
    }
    if (job.state.kind === 'completed') return job;
    if (job.state.kind === 'failed') throw new Error(`${job.state.code}: ${job.state.message}`);
    if (job.state.kind === 'cancelled') {
      if (cancellationTriggered) {
        Object.assign(report.cancellation, cancellationTracker.recordTerminal(job));
        report.cancellation.checkpointSequenceAtTerminal = job.lastCheckpointSequence ?? null;
        return job;
      }
      throw new Error(`Job cancelled unexpectedly: ${jobId}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, options.pollMs));
  }
}

async function verifyCancellationPublicationInvariant(publicationBefore) {
  const publicationAfter = await captureCurrentPublicationState();
  assertNoPartialPublication(publicationBefore, publicationAfter);
  Object.assign(report, {
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    success: true,
    cancellationVerified: true,
    publishedProductIdsBefore: publicationBefore.catalog.map((product) => product.entityId),
    publishedProductIdsAfter: publicationAfter.catalog.map((product) => product.entityId),
    publishedManifestEntitiesBefore: publicationBefore.entities,
    publishedManifestEntitiesAfter: publicationAfter.entities,
    activeRunsBefore: publicationBefore.activeRuns,
    activeRunsAfter: publicationAfter.activeRuns,
  });
  if (report.cancellation) {
    assertCancellationLatencies(report.cancellation, {
      maximumAcknowledgementMs: options.maxCancelAcknowledgementMs,
      maximumTerminalMs: options.maxCancelTerminalMs,
      requireTerminal: true,
    });
  }
}

async function captureCurrentPublicationState() {
  const [snapshot, products] = await Promise.all([
    rpc.call('photolab.project.snapshot', {}),
    rpc.call('photolab.products.list', {}),
  ]);
  return capturePublicationState(snapshot, products);
}

async function verifyQueuedResumeIdentity(job) {
  if (!options.resumeAudit || resumeIdentityVerified || incompatibleCheckpointRejected)
    return 'none';
  const expected = previousReport.cancellation.resumeIdentity;
  const requested = immutableResumeIdentity(job);
  if (options.expectIncompatibleCheckpoint) {
    const field = options.expectIncompatibleCheckpoint;
    if (field !== 'kind' && job.kind !== expected.kind) return 'none';
    if (field === 'kind' && job.kind === expected.kind) return 'none';
    try {
      await rpc.call('photolab.jobs.resume', {
        historyJobId: previousReport.cancellation.historyJobId,
      });
    } catch (error) {
      const rejection = assertSidecarResumeIdentityRejection(error, field);
      incompatibleCheckpointRejected = true;
      report.incompatibleCheckpointVerification = {
        rejected: true,
        rejectedBy: 'photolab.jobs.resume',
        expected,
        requested,
        field: rejection.field,
        historyJobId: previousReport.cancellation.historyJobId,
      };
      return 'rejected';
    }
    throw new Error(`Sidecar accepted an incompatible ${field} resume checkpoint`);
  }
  if (job.kind !== expected.kind) return 'none';
  assertCompatibleResume(expected, requested);
  resumeIdentityVerified = true;
  report.resumeVerification = {
    compatible: true,
    expected,
    requested,
    checkpointSequenceAtQueue: job.lastCheckpointSequence ?? null,
  };
  return 'compatible';
}

async function cancelRejectedResumeJob(jobId, publicationBefore) {
  const requestedAt = Date.now();
  const acknowledgement = await rpc.call('photolab.jobs.cancel', { jobId });
  const acknowledgedAt = Date.now();
  assertCancellationAcknowledged({ id: jobId }, acknowledgement);
  let terminal;
  while (Date.now() - requestedAt <= options.maxCancelTerminalMs) {
    const jobs = await rpc.call('photolab.jobs.list', { includeTerminal: true });
    terminal = jobs.find((candidate) => candidate.id === jobId);
    if (terminal?.state?.kind === 'cancelled') break;
    if (terminal?.state?.kind === 'failed' || terminal?.state?.kind === 'completed') {
      throw new Error(
        `Incompatible checkpoint job terminated as ${terminal.state.kind}, expected cancelled`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, options.pollMs));
  }
  const terminalAt = Date.now();
  const cancellation = {
    acknowledgementLatencyMs: acknowledgedAt - requestedAt,
    terminalLatencyMs: terminalAt - requestedAt,
    terminalState: terminal?.state?.kind ?? null,
  };
  report.incompatibleCheckpointVerification.cancellation = cancellation;
  await verifyCancellationPublicationInvariant(publicationBefore);
  assertCancellationLatencies(cancellation, {
    maximumAcknowledgementMs: options.maxCancelAcknowledgementMs,
    maximumTerminalMs: options.maxCancelTerminalMs,
    requireTerminal: true,
  });
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

function beta2007CatalogEntry() {
  return {
    kind: 'gtg',
    officialFilename: 'de_adv_BETA2007.tif',
    officialSha256: '46e681fcc7d022dde1db1f9d0a3426a9bfb1d4a151af69a81b3c30104c9388e2',
    license: {
      licenseName: 'AdV free redistribution notice',
      source: 'https://cdn.proj.org/de_adv_README.txt',
      redistributionAllowed: true,
    },
    coverage: {
      westLongitude: 5.4166667,
      southLatitude: 46.95,
      eastLongitude: 15.75,
      northLatitude: 55.35,
    },
    localPath: beta2007Grid,
  };
}

function gcg2016CatalogEntry() {
  return {
    kind: 'geoid',
    officialFilename: 'de_bkg_gcg2016.tif',
    officialSha256: '598f18324dea7f8e72421d18add7ac6228259adf91eeb335cc9c27d98484f7ac',
    license: {
      licenseName: 'Creative Commons Attribution 4.0',
      spdxExpression: 'CC-BY-4.0',
      source: 'https://cdn.proj.org/de_bkg_README.txt',
      redistributionAllowed: true,
    },
    coverage: {
      westLongitude: 3.25625,
      southLatitude: 47.2208333,
      eastLongitude: 15.11875,
      northLatitude: 55.9791667,
    },
  };
}

async function buildE2eGridCatalog(runOptions) {
  const catalog = [];
  if (runOptions.horizontalGrid) {
    catalog.push(
      await localGridCatalogEntry(
        runOptions.horizontalGrid,
        extname(runOptions.horizontalGrid).toLowerCase() === '.gsb' ? 'ntv2' : 'gtg',
      ),
    );
  } else if (runOptions.targetEpsg >= 31466 && runOptions.targetEpsg <= 31469) {
    catalog.push(beta2007CatalogEntry());
  }
  if (runOptions.verticalGrid) {
    catalog.push(await localGridCatalogEntry(runOptions.verticalGrid, 'geoid'));
  } else if (runOptions.targetVerticalEpsg === 7837) {
    catalog.push(gcg2016CatalogEntry());
  }
  return catalog;
}

async function localGridCatalogEntry(path, kind) {
  return {
    kind,
    officialFilename: basename(path),
    license: {
      licenseName: 'User-supplied local grid',
      source: path,
      redistributionAllowed: false,
    },
    coverage: await inspectGridCoverage(path),
    localPath: path,
  };
}

async function inspectGridCoverage(path) {
  const executable =
    process.env.HIMMELCAD_GDALINFO ??
    (process.platform === 'win32' ? 'gdalinfo.exe' : '/usr/bin/gdalinfo');
  const output = await captureExecutable(executable, ['-json', path]);
  const info = JSON.parse(output);
  const points = coordinatePairs(info.wgs84Extent?.coordinates ?? info.cornerCoordinates);
  if (points.length < 2) throw new Error(`${path}: GDAL did not report WGS 84 grid coverage`);
  const longitudes = points.map(([longitude]) => longitude);
  const latitudes = points.map(([, latitude]) => latitude);
  return {
    westLongitude: Math.min(...longitudes),
    southLatitude: Math.min(...latitudes),
    eastLongitude: Math.max(...longitudes),
    northLatitude: Math.max(...latitudes),
  };
}

function captureExecutable(executable, args) {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', rejectCapture);
    child.once('close', (code) => {
      if (code === 0) resolveCapture(Buffer.concat(stdout).toString('utf8'));
      else
        rejectCapture(
          new Error(`${executable} failed: ${Buffer.concat(stderr).toString('utf8').trim()}`),
        );
    });
  });
}

function coordinatePairs(value) {
  if (!Array.isArray(value)) {
    if (value && typeof value === 'object') return Object.values(value).flatMap(coordinatePairs);
    return [];
  }
  if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
    return [[value[0], value[1]]];
  }
  return value.flatMap(coordinatePairs);
}

function isRtkFixed(photo) {
  return /fix/i.test(photo.metadata.djiXmp.rtk?.flag ?? '');
}

function productConfiguration(kind, smoke) {
  if (options.goldenAgisoft && (kind === 'depth' || kind === 'dense')) {
    return agisoftGoldenMvsConfiguration(kind);
  }
  if (kind === 'depth')
    return {
      kind,
      imageDownscale: smoke ? 8 : 2,
      filter: 'moderate',
      maximumNeighbors: 6,
      reuseCompatibleMaps: true,
    };
  if (kind === 'dense')
    return {
      kind,
      imageDownscale: smoke ? 8 : 2,
      filter: 'moderate',
      maximumNeighbors: 6,
      minimumViews: 3,
      retainConfidence: true,
      calculateColors: true,
    };
  if (kind === 'dem')
    return {
      kind,
      surface: 'dsm',
      resolutionMetersPerPixel: smoke ? 0.25 : options.demResolutionMetersPerPixel,
      interpolateNodata: true,
      tileSizePixels: 512,
    };
  if (kind === 'ortho')
    return {
      kind,
      resolutionMetersPerPixel: smoke ? 0.2 : options.orthoResolutionMetersPerPixel,
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
  const goldenAgisoft = args.includes('--golden-agisoft');
  const products = get('--products', goldenAgisoft ? 'depth,dense,dem,ortho,mesh,splat' : '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const profile = get('--profile', goldenAgisoft ? 'qualityHybrid' : 'fast');
  if (!['fast', 'qualityHybrid', 'maximumRobustness'].includes(profile))
    throw new Error(`Invalid profile: ${profile}`);
  const verifyResume = args.includes('--verify-resume');
  const expectIncompatibleCheckpoint = checkpointIdentityField(
    get('--expect-incompatible-checkpoint', ''),
  );
  if (verifyResume && expectIncompatibleCheckpoint) {
    throw new Error('--verify-resume and --expect-incompatible-checkpoint are mutually exclusive');
  }
  const reuse = args.includes('--reuse');
  if ((verifyResume || expectIncompatibleCheckpoint) && !reuse) {
    throw new Error('Resume verification requires --reuse');
  }
  const maxCancelAcknowledgementMs = positiveInteger(
    get('--max-cancel-ack-ms', '5000'),
    '--max-cancel-ack-ms',
  );
  const maxCancelTerminalMs = positiveInteger(
    get('--max-cancel-terminal-ms', '15000'),
    '--max-cancel-terminal-ms',
  );
  if (maxCancelTerminalMs < maxCancelAcknowledgementMs) {
    throw new Error('--max-cancel-terminal-ms must be at least --max-cancel-ack-ms');
  }
  const targetVertical = get('--target-vertical-epsg', goldenAgisoft ? '7837' : '');
  const result = {
    source,
    output,
    products,
    profile,
    maxImages: Number.parseInt(get('--max-images', '2147483647'), 10),
    imageStride: Math.max(1, Number.parseInt(get('--image-stride', '1'), 10)),
    targetEpsg: Number.parseInt(get('--target-epsg', goldenAgisoft ? '31468' : '25832'), 10),
    targetVerticalEpsg: targetVertical ? Number.parseInt(targetVertical, 10) : null,
    demResolutionMetersPerPixel: positiveNumber(
      get('--dem-resolution', goldenAgisoft ? '0.015' : '0.05'),
      '--dem-resolution',
    ),
    orthoResolutionMetersPerPixel: positiveNumber(
      get('--ortho-resolution', goldenAgisoft ? '0.0075199430321273' : '0.03'),
      '--ortho-resolution',
    ),
    horizontalGrid: get('--horizontal-grid', ''),
    verticalGrid: get('--vertical-grid', ''),
    pollMs: positiveInteger(get('--poll-ms', '1000'), '--poll-ms'),
    cancelStage: canonicalCancellationStage(get('--cancel-stage', '')),
    cancelAfterUnits: positiveInteger(get('--cancel-after-units', '1'), '--cancel-after-units'),
    maxCancelAcknowledgementMs,
    maxCancelTerminalMs,
    sidecar: get('--sidecar', 'target/debug/himmelcad-sidecar'),
    reuse,
    smoke: args.includes('--smoke'),
    agisoftGcp: goldenAgisoft || args.includes('--agisoft-gcp'),
    goldenAgisoft,
    importOnly: args.includes('--import-only'),
    verifyResume,
    expectIncompatibleCheckpoint,
    resumeAudit: verifyResume || Boolean(expectIncompatibleCheckpoint),
  };
  if (goldenAgisoft) {
    if (result.profile !== 'qualityHybrid')
      throw new Error('--golden-agisoft requires --profile qualityHybrid');
    if (result.smoke || result.maxImages !== 2_147_483_647)
      throw new Error('--golden-agisoft requires the complete, non-smoke image set');
    if (result.targetEpsg !== 31468 || result.targetVerticalEpsg !== 7837)
      throw new Error('--golden-agisoft requires EPSG:31468 with EPSG:7837 heights');
    if (
      result.demResolutionMetersPerPixel !== 0.015 ||
      result.orthoResolutionMetersPerPixel !== 0.0075199430321273
    )
      throw new Error('--golden-agisoft requires the frozen DEM and orthomosaic resolutions');
    const required = ['depth', 'dense', 'dem', 'ortho', 'mesh', 'splat'];
    if (!required.every((kind) => result.products.includes(kind)))
      throw new Error(`--golden-agisoft requires products: ${required.join(',')}`);
  }
  return result;
}

function positiveInteger(value, option) {
  const text = String(value);
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function positiveNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number`);
  }
  return parsed;
}

function checkpointIdentityField(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return '';
  if (normalized === 'kind') return 'kind';
  if (normalized === 'config' || normalized === 'confighash') return 'configHash';
  if (normalized === 'input' || normalized === 'inputhash') return 'inputHash';
  throw new Error('--expect-incompatible-checkpoint expects kind, config or input');
}

function usage() {
  return `HimmelCAD PhotoLab end-to-end runner

Usage:
  node scripts/photolab-e2e.mjs [options]

Options:
  --golden-agisoft                 Freeze the complete Quality Hybrid golden contract
  --source <directory>            Image source directory
  --output <directory>            Result and project directory
  --profile <profile>             fast | qualityHybrid | maximumRobustness
  --products <list>               depth,dense,dem,ortho,mesh,splat
  --dem-resolution <meters>       DEM pixel size (golden: 0.015)
  --ortho-resolution <meters>     Orthomosaic pixel size (golden: 0.0075199430321273)
  --max-images <count>            Limit imported images
  --image-stride <count>          Import every nth image
  --target-epsg <code>            Horizontal target CRS
  --target-vertical-epsg <code>   Vertical target CRS
  --horizontal-grid <path>        Explicit horizontal transformation grid
  --vertical-grid <path>          Explicit vertical transformation grid
  --sidecar <path>                Sidecar executable
  --poll-ms <milliseconds>        Job polling interval
  --cancel-stage <stage>          aliked | sift | dedode | mapper | mvs | raster | mesh | splat
  --cancel-after-units <count>    Completed units before cancellation
  --max-cancel-ack-ms <ms>        Maximum cancellation acknowledgement latency (default: 5000)
  --max-cancel-terminal-ms <ms>   Maximum time to terminal cancelled state (default: 15000)
  --verify-resume                 Reuse a cancelled run and require identical job identity
  --expect-incompatible-checkpoint <field>
                                  Reject a reused checkpoint differing in kind, config or input
  --reuse                         Reopen the existing output project
  --smoke                         Use bounded smoke-product settings
  --agisoft-gcp                   Import and optimize the Sulzberg GCP set
  --import-only                   Stop after atomic image import
  -h, --help                      Show this help without starting a sidecar`;
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
        ...(options.horizontalGrid || options.verticalGrid
          ? {
              HIMMELCAD_USER_PROJ_GRID_ROOT: commonDirectory(
                [options.horizontalGrid, options.verticalGrid].filter(Boolean),
              ),
            }
          : {}),
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
      if (response.error) {
        const error = new Error(response.error.message);
        error.rpcError = response.error;
        pending.reject(error);
      } else pending.resolve(response.result);
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

function commonDirectory(paths) {
  const directories = paths.map((path) => resolve(dirname(path)));
  let common = directories[0];
  if (!common) return workspace;
  while (
    directories.some(
      (directory) => directory !== common && !directory.startsWith(`${common}${sep}`),
    )
  ) {
    const parent = dirname(common);
    if (parent === common) return parent;
    common = parent;
  }
  return common;
}

await main();
