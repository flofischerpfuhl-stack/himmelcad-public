import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceArgument = process.argv.slice(2).find((argument) => argument !== '--') ?? '';
const sourcePath = resolve(sourceArgument);
const sidecarPath = resolve(
  process.env.HIMMELCAD_SIDECAR_BINARY ?? join(repositoryRoot, 'target/debug/himmelcad-sidecar'),
);
const source = await stat(sourcePath).catch(() => null);
assert.ok(source?.isFile(), `point-cloud source is not a file: ${sourcePath}`);
const sidecar = await stat(sidecarPath).catch(() => null);
assert.ok(sidecar?.isFile(), `sidecar binary is absent: ${sidecarPath}`);

const projectRoot = await mkdtemp(join(tmpdir(), 'himmelcad-pointcloud-import-'));
const child = spawn(sidecarPath, [], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
const stderr = [];
let nextId = 1;

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  const response = JSON.parse(line);
  const request = pending.get(response.id);
  if (!request) return;
  pending.delete(response.id);
  if (response.error) request.reject(new Error(response.error.message));
  else request.resolve(response.result);
});
readline.createInterface({ input: child.stderr }).on('line', (line) => {
  stderr.push(line);
  if (stderr.length > 50) stderr.shift();
});
child.on('exit', (code, signal) => {
  const error = new Error(
    `sidecar exited before replying (code ${String(code)}, signal ${String(signal)}): ${stderr.join('\n')}`,
  );
  for (const request of pending.values()) request.reject(error);
  pending.clear();
});

function rpc(method, params = {}) {
  const id = nextId++;
  const result = new Promise((resolveRequest, rejectRequest) => {
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return result;
}

try {
  await rpc('canonical.project.open', { projectRoot });
  const selection = await rpc('io.probe', { sourcePath });
  assert.ok(
    selection.formatId.startsWith('las@') ||
      selection.formatId.startsWith('laz@') ||
      selection.formatId.startsWith('e57@'),
    `unexpected provider selection: ${JSON.stringify(selection)}`,
  );

  const sessionId = `pointcloud-smoke-${process.pid}`;
  const staged = await rpc('registration.import.stage', {
    sessionId,
    commandId: `pointcloud-import-${process.pid}`,
    sourcePath,
    selection,
    options: {},
    recipe: {
      schemaVersion: 1,
      recipeId: 'pointcloud-point-pairs-smoke',
      label: 'Point-cloud point pairs',
      method: {
        kind: 'pointPairs',
        model: 'similarity3D',
        robust: {
          maximumIterations: 20,
          huberDeltaMeters: 0.05,
          convergenceEpsilon: 1e-10,
        },
        offerIcpRefinement: true,
      },
    },
  });
  assert.equal(staged.phase, 'awaitingFreshInteraction');
  assert.ok(staged.sourceEntityCount >= 1);

  const resources = await rpc('registration.resources.describe', { sessionId });
  const potree = resources.datasets.find((dataset) => dataset.formatId === 'potree@2');
  assert.ok(potree, 'staged import did not expose a Potree 2 dataset');
  assert.ok(potree.artifacts.some((artifact) => artifact.relativePath.endsWith('metadata.json')));
  assert.ok(potree.artifacts.some((artifact) => artifact.relativePath.endsWith('octree.bin')));

  const sampled = await rpc('registration.samples.source', {
    sessionId,
    maximumSamples: 128,
  });
  assert.ok(sampled.points.length >= 3, 'point-cloud source sampling returned too few points');
  assert.equal(sampled.datasetId, potree.datasetId);
  const controls = chooseControlPoints(sampled.points);
  const translation = { x: 12.5, y: -7.25, z: 3.75 };
  const pairs = controls.map((point, index) => ({
    pairId: `smoke-pair-${index + 1}`,
    source: point,
    target: {
      x: point.x + translation.x,
      y: point.y + translation.y,
      z: point.z + translation.z,
    },
  }));
  const preview = await rpc('registration.preview.pointPairs', { sessionId, pairs });
  assert.equal(preview.phase, 'readyToCommit');
  assert.equal(preview.preview.accepted, true);
  assert.ok(preview.preview.residuals.rmsSpatialMeters < 1e-6);

  await rpc('registration.import.commit', { sessionId });
  const residency = await rpc('canonical.residency.bootstrap');
  const admitted = residency.entries.find(
    (entry) =>
      entry.dataset?.formatId === 'potree@2' && entry.dataset.datasetId === potree.datasetId,
  );
  assert.ok(admitted, 'committed project residency did not contain the imported point cloud');
  assert.ok(admitted.pointCloud, 'point-cloud residency metadata is absent');
  assert.ok(admitted.pointCloud.pointCount > 0, 'point-cloud residency has no exact point count');
  admitted.pointCloud.placementOffset.forEach((coordinate, index) => {
    const expected = [translation.x, translation.y, translation.z][index];
    assert.ok(Math.abs(coordinate - expected) < 1e-6, 'committed placement changed');
  });
  assert.equal(admitted.pointCloud.display.schemaId, 'hcad.resource.point-cloud-display@1');
  assert.equal(admitted.pointCloud.display.pointSizePixels, 2);
  assert.equal(admitted.pointCloud.display.colorMode, 'rgb');
  const targetSamples = await rpc('registration.samples.projectPointCloud', {
    datasetId: potree.datasetId,
    maximumSamples: 128,
  });
  assert.ok(
    targetSamples.points.length >= 3,
    'committed point cloud did not expose bounded ICP target samples',
  );
  assert.equal(targetSamples.datasetId, potree.datasetId);

  await rpc('project.flush');
  const durability = await rpc('canonical.project.durability');
  assert.equal(durability.state, 'stored');
  assert.equal(durability.pendingCount, 0);
  assert.equal(durability.durableGeneration, durability.visibleGeneration);
  await rpc('canonical.project.close');
  await rpc('canonical.project.open', { projectRoot });
  const reopenedResidency = await rpc('canonical.residency.bootstrap');
  const reopened = reopenedResidency.entries.find(
    (entry) => entry.dataset?.datasetId === potree.datasetId,
  );
  assert.ok(reopened, 'reopened project did not restore the imported point cloud');
  assert.deepEqual(reopened.pointCloud, admitted.pointCloud);

  process.stdout.write(
    `Point-cloud registration smoke passed and reopened: ${selection.formatId}, ${sampled.points.length} source samples, ${targetSamples.points.length} target samples, ${pairs.length} point pairs, RMS ${preview.preview.residuals.rmsSpatialMeters.toExponential(2)} m.\n`,
  );
} catch (error) {
  process.stderr.write(`${stderr.join('\n')}\n`);
  throw error;
} finally {
  child.stdin.end();
  child.kill('SIGTERM');
  if (child.exitCode === null) {
    await new Promise((resolveExit) => child.once('exit', resolveExit));
  }
  await rm(projectRoot, { recursive: true, force: true });
}

function chooseControlPoints(points) {
  const first = points[0];
  assert.ok(first);
  let second = points[1];
  let secondDistance = -1;
  for (const candidate of points) {
    const distance = squaredDistance(first, candidate);
    if (distance > secondDistance) {
      second = candidate;
      secondDistance = distance;
    }
  }
  assert.ok(second && secondDistance > 0, 'point-cloud samples have no spatial extent');
  let third = points[2];
  let thirdArea = -1;
  const ab = subtract(second, first);
  for (const candidate of points) {
    const area = squaredLength(cross(ab, subtract(candidate, first)));
    if (area > thirdArea) {
      third = candidate;
      thirdArea = area;
    }
  }
  assert.ok(third && thirdArea > 1e-18, 'point-cloud samples are collinear');
  return [first, second, third];
}

function squaredDistance(left, right) {
  return squaredLength(subtract(left, right));
}

function subtract(left, right) {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function cross(left, right) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function squaredLength(value) {
  return value.x * value.x + value.y * value.y + value.z * value.z;
}
