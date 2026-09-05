import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { it } from 'node:test';

import { runPlan } from './runner.mjs';

const basePlan = (tasks) => ({
  tier: 'changed',
  risk: 'high',
  paths: ['scripts/verification/runner.mjs'],
  tasks,
});

const nodeTask = (id, source, resourceKeys = [], dependsOn = []) => ({
  id,
  command: process.execPath,
  args: ['-e', source],
  resourceKeys,
  dependsOn,
});

it('preserves serial task order and returns the first nonzero exit status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'himmelcad-verifier-'));
  const plan = basePlan([
    nodeTask(
      'rust.test:example',
      "if (process.argv[1] !== 'exact-argument') process.exit(6); process.exit(7)",
    ),
    {
      ...nodeTask('must.not.run', 'process.exit(0)'),
      args: ['-e', 'process.exit(0)', 'exact-argument'],
    },
  ]);
  plan.tasks[0].args.push('exact-argument');

  try {
    assert.equal(await runPlan(plan, { root, jobs: 1 }), 7);
    const timings = JSON.parse(readFileSync(join(root, '.build/verify/timings.json'), 'utf8'));
    assert.deepEqual(timings.plannedTaskIds, ['rust.test:example', 'must.not.run']);
    assert.deepEqual(
      timings.results.map(({ id, exitCode }) => ({ id, exitCode })),
      [{ id: 'rust.test:example', exitCode: 7 }],
    );
    assert.equal(timings.version, 2);
    assert.equal(timings.firstFailure.taskId, 'rust.test:example');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('runs independent tasks concurrently but never overlaps a shared resource', async () => {
  const root = mkdtempSync(join(tmpdir(), 'himmelcad-verifier-conflict-'));
  const intervalSource = (name, delay) => `
    const fs = require('node:fs');
    const path = ${JSON.stringify(join(root, 'intervals.jsonl'))};
    fs.appendFileSync(path, JSON.stringify({name: ${JSON.stringify(name)}, event: 'start', at: Date.now()}) + '\\n');
    setTimeout(() => {
      fs.appendFileSync(path, JSON.stringify({name: ${JSON.stringify(name)}, event: 'end', at: Date.now()}) + '\\n');
    }, ${delay});
  `;
  const plan = basePlan([
    nodeTask('cargo.first', intervalSource('cargo.first', 180), ['cargo:target/builder']),
    nodeTask('cargo.second', intervalSource('cargo.second', 100), ['cargo:target/builder']),
    nodeTask('node.independent', intervalSource('node.independent', 180)),
  ]);

  try {
    assert.equal(await runPlan(plan, { root, jobs: 3, sampleIntervalMs: 20 }), 0);
    const events = readFileSync(join(root, 'intervals.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    const event = (name, type) =>
      events.find((entry) => entry.name === name && entry.event === type).at;
    assert.ok(event('cargo.second', 'start') >= event('cargo.first', 'end'));
    assert.ok(event('node.independent', 'start') < event('cargo.first', 'end'));
    const timings = JSON.parse(readFileSync(join(root, '.build/verify/timings.json'), 'utf8'));
    assert.deepEqual(timings.criticalPath.taskIds, ['cargo.first', 'cargo.second']);
    assert.ok(timings.peakRssBytes > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('honors dependencies while allowing other ready work to start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'himmelcad-verifier-dag-'));
  const plan = basePlan([
    nodeTask('dependent', 'process.exit(0)', [], ['prerequisite']),
    nodeTask('independent', 'setTimeout(() => {}, 30)'),
    nodeTask('prerequisite', 'setTimeout(() => {}, 60)'),
  ]);

  try {
    assert.equal(await runPlan(plan, { root, jobs: 2 }), 0);
    const timings = JSON.parse(readFileSync(join(root, '.build/verify/timings.json'), 'utf8'));
    const byId = new Map(timings.results.map((result) => [result.id, result]));
    assert.ok(byId.get('dependent').startOffsetMs >= byId.get('prerequisite').endOffsetMs);
    assert.ok(byId.get('independent').startOffsetMs < byId.get('prerequisite').endOffsetMs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('compares a parallel replay with the matching previous serial report', async () => {
  const root = mkdtempSync(join(tmpdir(), 'himmelcad-verifier-comparison-'));
  const plan = basePlan([
    nodeTask('one', 'setTimeout(() => {}, 25)'),
    nodeTask('two', 'setTimeout(() => {}, 25)'),
  ]);

  try {
    assert.equal(await runPlan(plan, { root, jobs: 1 }), 0);
    const serial = JSON.parse(readFileSync(join(root, '.build/verify/timings.json'), 'utf8'));
    assert.equal(await runPlan(plan, { root, jobs: 2 }), 0);
    const parallel = JSON.parse(readFileSync(join(root, '.build/verify/timings.json'), 'utf8'));
    assert.equal(parallel.serialVsParallel.source, 'previous-jobs-1-report');
    assert.equal(parallel.serialVsParallel.baselineMs, serial.wallTimeMs);
    assert.equal(parallel.serialVsParallel.deltaMs, serial.wallTimeMs - parallel.wallTimeMs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('stops launching, terminates the process group, and leaves no orphan after failure', async () => {
  if (process.platform === 'win32') return;
  const root = mkdtempSync(join(tmpdir(), 'himmelcad-verifier-cancel-'));
  const grandchildPidPath = join(root, 'grandchild.pid');
  const longRunning = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
    fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid));
    setInterval(() => {}, 1000);
  `;
  const plan = basePlan([
    nodeTask('long.running', longRunning),
    nodeTask('first.failure', 'setTimeout(() => process.exit(23), 150)'),
    nodeTask('must.not.launch', 'process.exit(0)'),
  ]);

  try {
    assert.equal(
      await runPlan(plan, {
        root,
        jobs: 2,
        sampleIntervalMs: 20,
        terminationGraceMs: 250,
      }),
      23,
    );
    assert.ok(existsSync(grandchildPidPath));
    const grandchildPid = Number(readFileSync(grandchildPidPath, 'utf8'));
    assert.throws(() => process.kill(grandchildPid, 0), { code: 'ESRCH' });
    const timings = JSON.parse(readFileSync(join(root, '.build/verify/timings.json'), 'utf8'));
    assert.equal(timings.firstFailure.taskId, 'first.failure');
    assert.ok(timings.firstFailure.latencyMs >= 100);
    assert.equal(
      timings.results.some(({ id }) => id === 'must.not.launch'),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('completes ten repeated bounded plans without failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'himmelcad-verifier-repeat-'));
  try {
    for (let run = 0; run < 10; run += 1) {
      const plan = basePlan([
        nodeTask(`a.${run}`, 'setTimeout(() => {}, 10)', ['lane:a']),
        nodeTask(`b.${run}`, 'setTimeout(() => {}, 10)', ['lane:b']),
        nodeTask(`c.${run}`, 'setTimeout(() => {}, 10)', ['lane:a']),
      ]);
      assert.equal(await runPlan(plan, { root, jobs: 3, sampleIntervalMs: 20 }), 0);
      const timings = JSON.parse(readFileSync(join(root, '.build/verify/timings.json'), 'utf8'));
      assert.equal(timings.results.length, 3);
      assert.ok(timings.results.every(({ exitCode }) => exitCode === 0));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
