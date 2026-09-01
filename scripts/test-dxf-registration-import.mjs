import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceArgument = process.argv.slice(2).find((argument) => argument !== '--') ?? '';
const sourcePath = resolve(sourceArgument);
const sidecarPath = resolve(
  process.env.HIMMELCAD_SIDECAR_BINARY ?? join(repositoryRoot, 'target/debug/himmelcad-sidecar'),
);
assert.ok(
  (await stat(sourcePath).catch(() => null))?.isFile(),
  `DXF source is absent: ${sourcePath}`,
);
assert.ok(
  (await stat(sidecarPath).catch(() => null))?.isFile(),
  `sidecar is absent: ${sidecarPath}`,
);

const projectRoot = await mkdtemp(join(tmpdir(), 'himmelcad-dxf-import-'));
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
    selection.formatId.startsWith('dxf@'),
    `unexpected selection: ${JSON.stringify(selection)}`,
  );

  const recipe = {
    schemaVersion: 1,
    recipeId: 'dxf-source-coordinates-smoke',
    label: 'DXF source coordinates',
    method: { kind: 'sourceCoordinates' },
  };
  let acceptedLossCodes = [];
  let staged;
  try {
    staged = await stage('first', acceptedLossCodes);
  } catch (error) {
    acceptedLossCodes = [
      ...new Set(String(error.message).match(/hcad\.loss\.[A-Za-z0-9_.:@-]+/g) ?? []),
    ];
    assert.ok(
      acceptedLossCodes.length > 0,
      `DXF staging failed without reviewable losses: ${error.message}`,
    );
    staged = await stage('accepted', acceptedLossCodes);
  }
  assert.equal(staged.phase, 'readyToCommit');
  assert.ok(staged.sourceEntityCount > 0, 'DXF staging produced no canonical entities');
  assert.ok(Array.isArray(staged.sourcePreview.admissions));
  assert.equal(staged.sourcePreview.admissions.length, staged.sourceEntityCount);
  await rpc('registration.import.commit', { sessionId: staged.sessionId });
  const residency = await rpc('canonical.residency.bootstrap');
  assert.ok(residency.entries.length > 0, 'DXF commit produced no live residency entries');
  console.log(
    `DXF registration smoke passed: ${staged.sourceEntityCount} entities, ${acceptedLossCodes.length} explicitly accepted loss codes.`,
  );

  function stage(suffix, losses) {
    return rpc('registration.import.stage', {
      sessionId: `dxf-smoke-${process.pid}-${suffix}`,
      commandId: `dxf-import-${process.pid}`,
      sourcePath,
      selection,
      options: losses.length > 0 ? { acceptedLossCodes: losses } : {},
      recipe,
    });
  }
} catch (error) {
  process.stderr.write(`${stderr.join('\n')}\n`);
  throw error;
} finally {
  child.stdin.end();
  child.kill('SIGTERM');
  await rm(projectRoot, { recursive: true, force: true });
}
