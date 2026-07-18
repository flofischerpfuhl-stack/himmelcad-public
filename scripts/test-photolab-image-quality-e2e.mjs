#!/usr/bin/env node

/* global clearTimeout, document, setTimeout */
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Sidecar RPC and Playwright values cross untyped process boundaries in this standalone E2E gate. */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

import { _electron as electron } from 'playwright-core';

const workspace = resolve(import.meta.dirname, '..');
if (process.platform === 'linux' && process.env.HIMMELCAD_IMAGE_QUALITY_XVFB !== '1') {
  const child = spawnSync('xvfb-run', ['-a', process.execPath, ...process.argv.slice(1)], {
    cwd: workspace,
    env: { ...process.env, HIMMELCAD_IMAGE_QUALITY_XVFB: '1' },
    stdio: 'inherit',
  });
  process.exit(child.status ?? 1);
}
const options = parseArguments(process.argv.slice(2));
const sourceProject = resolve(options.project);
const output = resolve(options.output);
const isolatedProject = join(output, 'quality-e2e.hcad');
const sidecarPath = resolve(options.sidecar);
const resultPath = join(output, 'result.json');

if (!existsSync(sourceProject)) throw new Error(`Project is missing: ${sourceProject}`);
if (!existsSync(sidecarPath)) throw new Error(`Sidecar is missing: ${sidecarPath}`);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cloneProject(sourceProject, isolatedProject);

const startedAt = Date.now();

async function main() {
  const rpc = new RpcClient(sidecarPath, output);
  try {
    await rpc.start();
  await openProject(rpc, isolatedProject, output);
  const images = await rpc.call('photolab.images.list', {});
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('The test project contains no imported images');
  }

  const before = await rpc.call('photolab.project.snapshot', {});
  const measuredJobId = `quality-e2e-measure-${Date.now()}`;
  const queued = await rpc.call('photolab.jobs.startImageQuality', {
    operationId: measuredJobId,
    cameraEntityIds: [images[0].entityId],
  });
  if (queued.job.id !== measuredJobId) throw new Error('The queued quality job changed identity');
  const measuredJob = await waitForJob(rpc, measuredJobId, 'completed');
  const catalog = await rpc.call('photolab.images.quality.list', {});
  const measured = catalog.find((record) => record.jobId === measuredJobId);
  assertMeasuredRecord(measured, images[0]);
  const published = await rpc.call('photolab.project.snapshot', {});
  if (!published.manifest.imageQualityCatalogHash) {
    throw new Error('Completed quality analysis did not publish a catalog');
  }
  if (
    before.manifest.imageQualityCatalogHash &&
    before.manifest.imageQualityCatalogHash === published.manifest.imageQualityCatalogHash
  ) {
    throw new Error('Completed quality analysis did not replace the catalog reference');
  }

  await rpc.call('photolab.project.close', {});
  await openProject(rpc, isolatedProject, output);
  const reopenedCatalog = await rpc.call('photolab.images.quality.list', {});
  if (!reopenedCatalog.some((record) => record.jobId === measuredJobId)) {
    throw new Error('Published quality provenance did not survive project reopen');
  }

  const processingSetName = 'Quality E2E Scope';
  await rpc.call('photolab.project.processingSet.create', {
    name: processingSetName,
    cameraEntityIds: images.slice(0, 2).map((image) => image.entityId),
  });
  const processingSets = await rpc.call('photolab.project.processingSet.list', {});
  const processingSet = processingSets.find((record) => record.name === processingSetName);
  if (!processingSet) throw new Error('The image-quality processing set was not created');
  const scopedJobId = `quality-e2e-scope-${Date.now()}`;
  await rpc.call('photolab.jobs.startImageQuality', {
    operationId: scopedJobId,
    processingSetId: processingSet.entityId,
  });
  const scopedJob = await waitForJob(rpc, scopedJobId, 'completed');
  const scopedCatalog = await rpc.call('photolab.images.quality.list', {});
  const scopedRecords = scopedCatalog.filter((record) => record.jobId === scopedJobId);
  if (
    scopedRecords.length !== 2 ||
    scopedRecords.some(
      (record) =>
        record.processingSetId !== processingSet.entityId ||
        record.processingSetMembershipSha256 !== processingSet.membershipSha256,
    )
  ) {
    throw new Error('Processing-set analysis did not preserve its exact two-image scope');
  }

  const catalogHashBeforeCancellation = (
    await rpc.call('photolab.project.snapshot', {})
  ).manifest.imageQualityCatalogHash;
  const cancelledJobId = `quality-e2e-cancel-${Date.now()}`;
  await rpc.call('photolab.jobs.startImageQuality', {
    operationId: cancelledJobId,
  });
  const acknowledgement = await rpc.call('photolab.jobs.cancel', { jobId: cancelledJobId });
  const cancelledJob = await waitForJob(rpc, cancelledJobId, 'cancelled');
  const afterCancellation = await rpc.call('photolab.project.snapshot', {});
  const catalogAfterCancellation = await rpc.call('photolab.images.quality.list', {});
  if (afterCancellation.manifest.imageQualityCatalogHash !== catalogHashBeforeCancellation) {
    throw new Error('Cancelled quality analysis changed the published catalog');
  }
  if (catalogAfterCancellation.some((record) => record.jobId === cancelledJobId)) {
    throw new Error('Cancelled quality analysis exposed partial records');
  }

  await rpc.call('photolab.project.close', {});
  await rpc.stop();
  const ui = await auditUi(isolatedProject, output, images[0].name, processingSetName);
  const result = {
    schemaVersion: 1,
    sourceProject,
    imageCount: images.length,
    measuredImage: { entityId: images[0].entityId, name: images[0].name },
    measuredJob,
    measuredRecord: measured,
    processingSet: {
      entityId: processingSet.entityId,
      membershipSha256: processingSet.membershipSha256,
      job: scopedJob,
      recordCount: scopedRecords.length,
    },
    cancellation: {
      firstRequest: acknowledgement.firstRequest,
      terminalState: cancelledJob.state.kind,
    },
    catalogHash: published.manifest.imageQualityCatalogHash,
    reopenVerified: true,
    partialPublicationRejected: true,
    ui,
    durationMs: Date.now() - startedAt,
  };
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.stdout.write(`PhotoLab image-quality E2E passed · ${resultPath}\n`);
  } finally {
    await rpc.call('photolab.project.close', {}).catch(() => undefined);
    await rpc.stop();
    rmSync(isolatedProject, { recursive: true, force: true });
    rmSync(join(output, '.working'), { recursive: true, force: true });
  }
}

async function auditUi(project, outputRoot, imageName, processingSetName) {
  const require = createRequire(import.meta.url);
  const executablePath = require('../apps/photolab/node_modules/electron');
  const pageErrors = [];
  const electronErrors = [];
  let application;
  let page;
  try {
    application = await electron.launch({
      executablePath,
      args: [
        '--ignore-gpu-blocklist',
        '--enable-webgl',
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
        resolve(workspace, 'apps/photolab'),
      ],
      cwd: workspace,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(outputRoot, 'config'),
        HIMMELCAD_WORKSPACE_ROOT: workspace,
        HIMMELCAD_COMPUTE_LEASE_PATH: join(outputRoot, 'ui-compute.lock'),
        HIMMELCAD_UI_PROJECT_PATH: project,
        HIMMELCAD_UI_CAPTURE_PATH: join(outputRoot, 'automatic.png'),
        HIMMELCAD_UI_CAPTURE_BUILT: '1',
        HIMMELCAD_UI_CAPTURE_DELAY_MS: '60000',
      },
      timeout: 30_000,
    });
    application.on('console', (message) => {
      if (message.type() === 'error') electronErrors.push(message.text());
    });
    page = await application.firstWindow({ timeout: 30_000 });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForFunction(
      () => document.body.innerText.includes('Core ready'),
      undefined,
      { timeout: 60_000 },
    );
    await page.getByRole('tab', { name: 'Images', exact: true }).first().click({ force: true });
    await page.getByRole('button', { name: 'Image Status', exact: true }).click({ force: true });
    await page.getByText('Image status and measured quality', { exact: true }).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    await page
      .locator('select')
      .filter({ hasText: processingSetName })
      .selectOption({ label: `${processingSetName} · 2` });
    await page.getByText('2 / 2', { exact: true }).waitFor({ state: 'visible' });
    await page.getByText(/Analyzed/).first().waitFor({ state: 'visible' });
    const statusScreenshot = join(outputRoot, 'image-quality-status.png');
    await page.screenshot({ path: statusScreenshot });

    await page.getByText(imageName, { exact: true }).first().click({ force: true });
    await page.getByRole('tab', { name: 'Properties', exact: true }).click({ force: true });
    await page.getByText('Measured image quality', { exact: true }).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    await page.getByText('himmelcad-image-quality-v1', { exact: false }).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    const propertiesScreenshot = join(outputRoot, 'image-quality-properties.png');
    await page.screenshot({ path: propertiesScreenshot });
    if (pageErrors.length > 0) throw new Error(`Renderer errors: ${pageErrors.join(' | ')}`);
    return {
      statusScreenshot,
      propertiesScreenshot,
      pageErrors,
      electronErrors: electronErrors.filter((line) => !line.includes('DevTools listening')),
    };
  } catch (error) {
    const body = await page?.locator('body').innerText().catch(() => 'Window body unavailable');
    await page
      ?.screenshot({ path: join(outputRoot, 'image-quality-ui-failure.png') })
      .catch(() => undefined);
    writeFileSync(
      join(outputRoot, 'image-quality-ui-failure.json'),
      `${JSON.stringify({ message: String(error), body, pageErrors, electronErrors }, null, 2)}\n`,
      'utf8',
    );
    throw error;
  } finally {
    await application?.close().catch(() => undefined);
  }
}

function cloneProject(source, destination) {
  if (process.platform !== 'win32') {
    const result = spawnSync('cp', ['-a', '--reflink=auto', source, destination], {
      cwd: workspace,
      encoding: 'utf8',
    });
    if (result.status === 0) return;
    throw new Error(`Project clone failed: ${result.stderr || result.stdout}`);
  }
  throw new Error('This development E2E currently requires a reflink-capable Unix cp command');
}

async function openProject(rpcClient, project, outputRoot) {
  await rpcClient.call('photolab.project.open', {
    path: project,
    workingRoot: join(outputRoot, '.working'),
    useLocalWorkingCopy: false,
    recoverExistingWorkingCopy: false,
  });
}

async function waitForJob(rpcClient, jobId, expectedTerminalState) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const jobs = await rpcClient.call('photolab.jobs.list', { includeTerminal: true });
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Job disappeared: ${jobId}`);
    if (job.state.kind === expectedTerminalState) return job;
    if (['completed', 'failed', 'cancelled'].includes(job.state.kind)) {
      throw new Error(
        `Job ${jobId} reached ${job.state.kind}, expected ${expectedTerminalState}: ${JSON.stringify(job.state)}`,
      );
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${jobId}`);
}

function assertMeasuredRecord(record, image) {
  if (!record) throw new Error('The completed job has no catalog record');
  if (record.imageEntityId !== image.entityId) throw new Error('Quality record changed image identity');
  if (record.sourceObjectHash !== image.metadata.sourceObjectHash) {
    throw new Error('Quality provenance does not reference the analyzed pixels');
  }
  if (record.sourceMetadataObjectHash !== image.metadataObjectHash) {
    throw new Error('Quality provenance does not reference the analyzed metadata');
  }
  if (record.outcome?.status !== 'measured') {
    throw new Error(`Real project pixels were not measured: ${JSON.stringify(record.outcome)}`);
  }
  const metrics = record.outcome.metrics;
  for (const [name, value] of Object.entries(metrics)) {
    if (!Number.isFinite(value)) throw new Error(`Quality metric ${name} is not finite`);
  }
  for (const name of [
    'directionalGradientCoherence',
    'meanLuminance',
    'shadowClippedFraction',
    'highlightClippedFraction',
    'texturedPixelFraction',
  ]) {
    if (metrics[name] < 0 || metrics[name] > 1) {
      throw new Error(`Quality fraction ${name} is outside [0,1]`);
    }
  }
  if (record.sampledPixelCount <= 0 || record.originalWidthPixels <= 0) {
    throw new Error('Quality provenance has no decoded sample dimensions');
  }
  if (!record.algorithmVersion || !record.configurationSha256 || !record.jobId) {
    throw new Error('Quality provenance is incomplete');
  }
}

class RpcClient {
  constructor(executable, outputRoot) {
    this.executable = executable;
    this.outputRoot = outputRoot;
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
        HIMMELCAD_COMPUTE_LEASE_PATH: join(this.outputRoot, 'compute.lock'),
        RUST_LOG: 'himmelcad_sidecar=warn',
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
      process.stderr.write(`[quality-sidecar] ${line}\n`);
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

function parseArguments(values) {
  const options = {
    project: '.build/photolab-e2e/smoke-8-final/photolab-e2e.hcad',
    output: '.build/image-quality-e2e',
    sidecar: 'target/debug/himmelcad-sidecar',
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--') continue;
    if (value === '--project') options.project = values[++index];
    else if (value === '--output') options.output = values[++index];
    else if (value === '--sidecar') options.sidecar = values[++index];
    else if (value === '--help' || value === '-h') {
      process.stdout.write(
        `Usage: node ${basename(process.argv[1])} [--project <path>] [--output <path>] [--sidecar <path>]\n`,
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

await main();
