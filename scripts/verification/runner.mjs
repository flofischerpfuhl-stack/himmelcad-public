import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const DEFAULT_SAMPLE_INTERVAL_MS = 100;
const DEFAULT_TERMINATION_GRACE_MS = 10_000;

export function renderCommand(task) {
  return [task.command, ...task.args]
    .map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

function validatePlan(tasks) {
  const ids = new Set(tasks.map(({ id }) => id));
  if (ids.size !== tasks.length) throw new Error('verification plan contains duplicate task ids');
  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new Error(`${task.id} depends on unknown task ${dependency}`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`verification plan contains a dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

function processGroupMetrics(processGroups) {
  if (process.platform !== 'linux' || processGroups.size === 0) return undefined;
  const snapshot = spawnSync('ps', ['-eo', 'pgid=,rss=,pcpu='], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  if (snapshot.status !== 0) return undefined;
  let rssKiB = 0;
  let cpuPercent = 0;
  for (const line of snapshot.stdout.split('\n')) {
    const [groupText, rssText, cpuText] = line.trim().split(/\s+/);
    if (!processGroups.has(Number(groupText))) continue;
    rssKiB += Number(rssText) || 0;
    cpuPercent += Number(cpuText) || 0;
  }
  return { rssBytes: rssKiB * 1024, cpuPercent };
}

function signalProcessGroup(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function criticalPath(tasks, results) {
  const resultById = new Map(results.map((result) => [result.id, result]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const planIndex = new Map(tasks.map((task, index) => [task.id, index]));
  const lastForResource = new Map();
  const distance = new Map();
  const predecessor = new Map();
  let endpoint;

  const executionOrder = results
    .map((result) => result.id)
    .sort(
      (a, b) =>
        resultById.get(a).startOffsetMs - resultById.get(b).startOffsetMs ||
        planIndex.get(a) - planIndex.get(b),
    );
  for (const id of executionOrder) {
    const task = taskById.get(id);
    const result = resultById.get(id);
    const candidates = [
      ...(task.dependsOn ?? []),
      ...(task.resourceKeys ?? []).map((key) => lastForResource.get(key)).filter(Boolean),
    ].filter((id) => resultById.has(id));
    const previous = candidates.sort((a, b) => (distance.get(b) ?? 0) - (distance.get(a) ?? 0))[0];
    distance.set(task.id, (distance.get(previous) ?? 0) + result.durationMs);
    if (previous) predecessor.set(task.id, previous);
    for (const key of task.resourceKeys ?? []) lastForResource.set(key, task.id);
    if (!endpoint || distance.get(task.id) > distance.get(endpoint)) endpoint = task.id;
  }

  const taskIds = [];
  for (let id = endpoint; id; id = predecessor.get(id)) taskIds.unshift(id);
  return { taskIds, durationMs: endpoint ? distance.get(endpoint) : 0 };
}

function writeTimings(root, plan, results, summary) {
  const path = join(root, '.build/verify/timings.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: 2,
        tier: plan.tier,
        risk: plan.risk,
        recordedAt: new Date().toISOString(),
        plannedTaskIds: plan.tasks.map(({ id }) => id),
        results,
        ...summary,
      },
      null,
      2,
    )}\n`,
  );
}

function previousSerialBaseline(root, plan, jobs) {
  if (jobs === 1) return undefined;
  try {
    const previous = JSON.parse(readFileSync(join(root, '.build/verify/timings.json'), 'utf8'));
    const plannedTaskIds = plan.tasks.map(({ id }) => id);
    if (
      previous.jobs === 1 &&
      previous.results?.every(({ exitCode }) => exitCode === 0) &&
      JSON.stringify(previous.plannedTaskIds) === JSON.stringify(plannedTaskIds)
    ) {
      return previous.wallTimeMs;
    }
  } catch {
    // A missing, stale, or concurrently replaced report is not a scheduling failure.
  }
  return undefined;
}

export async function runPlan(
  plan,
  {
    root,
    dryRun = false,
    capabilities = [],
    jobs = 1,
    sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  } = {},
) {
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error(`invalid verifier job cap: ${jobs}`);
  validatePlan(plan.tasks);
  const availableCapabilities = new Set(capabilities);
  process.stdout.write(
    `Verification tier=${plan.tier} risk=${plan.risk} files=${plan.paths.length} tasks=${plan.tasks.length}\n`,
  );

  const runnable = [];
  for (const task of plan.tasks) {
    const rendered = renderCommand(task);
    if (task.requiredCapability && !availableCapabilities.has(task.requiredCapability)) {
      const message = `required capability missing for ${task.id}: ${task.requiredCapability}`;
      if (plan.tier === 'release') throw new Error(message);
      process.stdout.write(`SKIP ${message}\n`);
    } else if (dryRun) {
      process.stdout.write(`PLAN ${task.id}: ${rendered}\n`);
    } else {
      runnable.push(task);
    }
  }
  if (dryRun) return 0;

  const serialBaselineMs = previousSerialBaseline(root, plan, jobs);
  const runStartedEpochMs = Date.now();
  const runStarted = performance.now();
  const taskIndex = new Map(plan.tasks.map((task, index) => [task.id, index]));
  const pending = [...runnable];
  const running = new Map();
  const completed = new Set();
  const heldResources = new Set();
  const results = [];
  let firstFailure;
  let peakRssBytes = 0;
  let peakCpuPercent = 0;
  let cancellationStarted;
  let killTimer;
  let settle;

  const sampler = setInterval(() => {
    const metrics = processGroupMetrics(
      new Set([...running.values()].map(({ child }) => child.pid)),
    );
    if (!metrics) return;
    peakRssBytes = Math.max(peakRssBytes, metrics.rssBytes);
    peakCpuPercent = Math.max(peakCpuPercent, metrics.cpuPercent);
  }, sampleIntervalMs);
  sampler.unref();

  const cancelRunning = () => {
    if (cancellationStarted !== undefined) return;
    cancellationStarted = performance.now();
    for (const { child } of running.values()) signalProcessGroup(child, 'SIGTERM');
    if (running.size) {
      killTimer = setTimeout(() => {
        for (const { child } of running.values()) signalProcessGroup(child, 'SIGKILL');
      }, terminationGraceMs);
      killTimer.unref();
    }
  };

  const finishTask = (id, exitCode, signal) => {
    const active = running.get(id);
    if (!active) return;
    running.delete(id);
    for (const key of active.task.resourceKeys ?? []) heldResources.delete(key);
    completed.add(id);
    const ended = performance.now();
    const result = {
      id,
      durationMs: Math.round(ended - active.started),
      exitCode,
      startedAt: active.startedAt,
      endedAt: new Date().toISOString(),
      startOffsetMs: Math.round(active.started - runStarted),
      endOffsetMs: Math.round(ended - runStarted),
      resourceKeys: [...(active.task.resourceKeys ?? [])],
    };
    if (signal) result.signal = signal;
    results.push(result);
    process.stdout.write(`${exitCode === 0 ? 'PASS' : 'FAIL'} ${id} ${result.durationMs}ms\n`);
    if (exitCode !== 0 && !firstFailure) {
      firstFailure = {
        taskId: id,
        exitCode,
        detectedAtOffsetMs: result.endOffsetMs,
        latencyMs: result.endOffsetMs,
      };
      cancelRunning();
    }
    schedule();
  };

  const startTask = (task) => {
    const rendered = renderCommand(task);
    const started = performance.now();
    const startedAt = new Date().toISOString();
    process.stdout.write(`RUN  ${task.id}: ${rendered}\n`);
    const child = spawn(task.command, task.args, {
      cwd: task.cwd ?? root,
      stdio: 'inherit',
      env: process.env,
      detached: process.platform !== 'win32',
    });
    for (const key of task.resourceKeys ?? []) heldResources.add(key);
    running.set(task.id, { child, task, started, startedAt });
    child.once('error', () => finishTask(task.id, 1));
    child.once('exit', (code, signal) => finishTask(task.id, code ?? 1, signal));
  };

  const dependenciesComplete = (task) =>
    (task.dependsOn ?? []).every((dependency) => completed.has(dependency));
  const resourcesAvailable = (task) =>
    (task.resourceKeys ?? []).every((key) => !heldResources.has(key));

  function schedule() {
    if (!firstFailure) {
      let launched = true;
      while (running.size < jobs && launched) {
        launched = false;
        const index = pending.findIndex(
          (task) => dependenciesComplete(task) && resourcesAvailable(task),
        );
        if (index >= 0) {
          const [task] = pending.splice(index, 1);
          startTask(task);
          launched = true;
        }
      }
    }
    if (running.size === 0 && (pending.length === 0 || firstFailure)) settle();
  }

  const done = new Promise((resolve) => {
    settle = resolve;
  });
  schedule();
  await done;
  clearInterval(sampler);
  if (killTimer) clearTimeout(killTimer);

  results.sort((a, b) => taskIndex.get(a.id) - taskIndex.get(b.id));
  const wallTimeMs = Math.round(performance.now() - runStarted);
  const serialEstimateMs = results.reduce((sum, result) => sum + result.durationMs, 0);
  const comparisonBaselineMs = serialBaselineMs ?? serialEstimateMs;
  const parallelDeltaMs = comparisonBaselineMs - wallTimeMs;
  const summary = {
    jobs,
    wallTimeMs,
    serialEstimateMs,
    serialVsParallel: {
      baselineMs: comparisonBaselineMs,
      deltaMs: parallelDeltaMs,
      percent: comparisonBaselineMs
        ? Number(((parallelDeltaMs / comparisonBaselineMs) * 100).toFixed(1))
        : 0,
      source: serialBaselineMs === undefined ? 'task-duration-estimate' : 'previous-jobs-1-report',
    },
    peakRssBytes,
    peakCpuPercent: Number(peakCpuPercent.toFixed(1)),
    criticalPath: criticalPath(plan.tasks, results),
    firstFailure: firstFailure
      ? {
          ...firstFailure,
          cancellationDrainMs: Math.round(performance.now() - cancellationStarted),
        }
      : null,
    runStartedAt: new Date(runStartedEpochMs).toISOString(),
    runEndedAt: new Date().toISOString(),
  };
  writeTimings(root, plan, results, summary);
  return firstFailure?.exitCode ?? 0;
}
