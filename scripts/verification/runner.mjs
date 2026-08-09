import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

export function renderCommand(task) {
  return [task.command, ...task.args]
    .map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

export function runPlan(plan, { root, dryRun = false, capabilities = [] } = {}) {
  const availableCapabilities = new Set(capabilities);
  const results = [];
  process.stdout.write(
    `Verification tier=${plan.tier} risk=${plan.risk} files=${plan.paths.length} tasks=${plan.tasks.length}\n`,
  );
  for (const task of plan.tasks) {
    const rendered = renderCommand(task);
    if (task.requiredCapability && !availableCapabilities.has(task.requiredCapability)) {
      const message = `required capability missing for ${task.id}: ${task.requiredCapability}`;
      if (plan.tier === 'release') throw new Error(message);
      process.stdout.write(`SKIP ${message}\n`);
      continue;
    }
    if (dryRun) {
      process.stdout.write(`PLAN ${task.id}: ${rendered}\n`);
      continue;
    }
    const started = performance.now();
    process.stdout.write(`RUN  ${task.id}: ${rendered}\n`);
    const result = spawnSync(task.command, task.args, {
      cwd: task.cwd ?? root,
      stdio: 'inherit',
      env: process.env,
    });
    const durationMs = Math.round(performance.now() - started);
    results.push({ id: task.id, durationMs, exitCode: result.status ?? 1 });
    process.stdout.write(`${result.status === 0 ? 'PASS' : 'FAIL'} ${task.id} ${durationMs}ms\n`);
    if (result.status !== 0) {
      writeTimings(root, plan, results);
      return result.status ?? 1;
    }
  }
  if (!dryRun) writeTimings(root, plan, results);
  return 0;
}

function writeTimings(root, plan, results) {
  const path = join(root, '.build/verify/timings.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, tier: plan.tier, risk: plan.risk, recordedAt: new Date().toISOString(), results }, null, 2)}\n`,
  );
}
