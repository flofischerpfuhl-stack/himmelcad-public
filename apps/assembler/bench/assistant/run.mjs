#!/usr/bin/env node
/**
 * Assistant benchmark: plain-language tasks (tasks.json) given to an agent
 * CLI that drives `assembler-headless --mcp`, then checked on the saved
 * project (validity, size, volume, faces, printability findings, named
 * parameters and a parameter edit) with renders of the result.
 *
 *   node apps/assembler/bench/assistant/run.mjs [--provider scripted|claude|codex]
 *        [--task <id>] [--out <dir>]
 *
 * `scripted` (default, CI) replays plans.json through scriptedHarness.mjs —
 * no AI provider is called. `claude` / `codex` run the user's installed CLI
 * with their own subscription: only by hand, never in automated tests.
 * Run `pnpm --filter @himmelcad/assembler build:headless` first.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..', '..');
const headless = join(appRoot, 'bin', 'assembler-headless.mjs');
const argv = process.argv.slice(2);
const option = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const provider = option('--provider', 'scripted');
const only = option('--task', null);
const outDir = resolve(option('--out', join(tmpdir(), 'assembler-assistant-bench')));
const TASK_TIMEOUT_MS = Number(
  process.env.HCASM_BENCH_TASK_TIMEOUT_MS ?? (provider === 'scripted' ? 240_000 : 900_000),
);

if (!['scripted', 'claude', 'codex'].includes(provider)) {
  console.error(`Unknown provider ${provider}`);
  process.exit(2);
}
if (!existsSync(join(appRoot, 'dist', 'headless'))) {
  console.error('Build the headless CLI first: pnpm --filter @himmelcad/assembler build:headless');
  process.exit(2);
}

const tasks = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8')).tasks.filter(
  (task) => !only || task.id === only,
);
mkdirSync(outDir, { recursive: true });

/** The agent CLI command for one task. */
function agentCommand(configPath) {
  if (provider === 'scripted') {
    return {
      command: process.execPath,
      args: [
        join(here, 'scriptedHarness.mjs'),
        '-p',
        '--output-format',
        'stream-json',
        '--mcp-config',
        configPath,
      ],
      shell: false,
    };
  }
  if (provider === 'claude') {
    return {
      command: 'claude',
      args: [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--input-format',
        'text',
        '--permission-mode',
        'dontAsk',
        '--tools',
        '""',
        '--allowedTools',
        'mcp__hcasm',
        '--strict-mcp-config',
        '--mcp-config',
        configPath,
      ],
      shell: process.platform === 'win32',
    };
  }
  const server = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.hcasm;
  const toml = (value) => JSON.stringify(value);
  return {
    command: 'codex',
    args: [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      `mcp_servers.hcasm.command=${toml(server.command)}`,
      '-c',
      `mcp_servers.hcasm.args=[${server.args.map(toml).join(',')}]`,
      ...Object.entries(server.env).flatMap(([k, v]) => [
        '-c',
        `mcp_servers.hcasm.env.${k}=${toml(v)}`,
      ]),
      '-',
    ],
    shell: process.platform === 'win32',
  };
}

function runAgent(task, workDir) {
  const projectPath = join(workDir, `${task.id}.hcasm`);
  rmSync(projectPath, { force: true });
  const configPath = join(workDir, 'mcp.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        hcasm: {
          type: 'stdio',
          command: process.execPath,
          args: [headless, '--mcp'],
          env: { HCASM_MCP_SAVE_ON_EXIT: projectPath },
        },
      },
    }),
  );
  const { command, args, shell } = agentCommand(configPath);
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd: workDir, shell, stdio: ['pipe', 'pipe', 'pipe'] });
    const stats = { toolCalls: 0, toolErrors: 0, finalText: '', usage: null, events: 0 };
    let stderr = '';
    createInterface({ input: child.stdout }).on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      stats.events += 1;
      const content = event.message?.content ?? [];
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === 'tool_use') stats.toolCalls += 1;
        if (block.type === 'tool_result' && block.is_error) stats.toolErrors += 1;
        if (block.type === 'text' && event.type === 'assistant') stats.finalText = block.text;
      }
      if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') {
        stats.toolCalls += 1;
        if (event.item.error) stats.toolErrors += 1;
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message')
        stats.finalText = event.item.text;
      if (event.type === 'result' || event.type === 'turn.completed')
        stats.usage = event.usage ?? stats.usage;
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const timer = setTimeout(() => child.kill(), TASK_TIMEOUT_MS);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        seconds: (Date.now() - started) / 1000,
        stats,
        stderr,
        projectPath,
      });
    });
    child.stdin.end(task.prompt);
  });
}

/** A JSON-RPC client on a fresh headless process (the checks never share the agent's session). */
function headlessClient() {
  const child = spawn(process.execPath, [headless], { stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  return {
    call: (method, params = {}) =>
      new Promise((resolvePromise) => {
        id += 1;
        waiting.set(id, resolvePromise);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      }),
    close: () =>
      new Promise((done) => {
        child.once('close', done);
        child.stdin.end();
      }),
  };
}

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

async function accept(task, projectPath) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  if (!existsSync(projectPath)) {
    check('project saved', false, 'no project file');
    return checks;
  }
  const client = headlessClient();
  try {
    const text = readFileSync(projectPath, 'utf8');
    const opened = await client.call('project.open', { text });
    check(
      'reopens',
      opened.result && Object.keys(opened.result.errors ?? {}).length === 0,
      JSON.stringify(opened.error ?? opened.result?.errors ?? {}),
    );
    const bodies = (await client.call('bodies.list')).result ?? [];
    const spec = task.accept;
    const tolerance = spec.tolerance ?? 0.01;
    check('bodies', bodies.length === spec.bodies, `${bodies.length} bodies`);
    check(
      'valid',
      bodies.every((b) => b.valid),
      bodies.map((b) => `${b.name}:${b.valid}`).join(', '),
    );
    const body = bodies[0];
    if (body && spec.bboxSize) {
      check(
        'bbox',
        spec.bboxSize.every((v, i) => near(body.bbox.size[i], v, tolerance)),
        body.bbox.size.join(' x '),
      );
    }
    if (body && spec.volumeRange) {
      check(
        'volume',
        body.volume >= spec.volumeRange[0] && body.volume <= spec.volumeRange[1],
        `${Math.round(body.volume)} mm³`,
      );
    }
    if (body && spec.minFaces)
      check('faces', body.faceCount >= spec.minFaces, `${body.faceCount} faces`);
    const report = (await client.call('print.analyze')).result;
    const errors = (report?.findings ?? []).filter((f) => f.severity === 'error');
    check(
      'printability',
      errors.length <= (spec.maxErrorFindings ?? 0),
      `${errors.length} error findings, ${(report?.findings ?? []).length} total`,
    );
    const parameters = (await client.call('parameters.list')).result ?? [];
    if (spec.parameters) {
      const names = parameters.map((p) => p.name);
      check(
        'parameters',
        spec.parameters.every((n) => names.includes(n)),
        names.join(', '),
      );
    }
    if (spec.parameterEdit) {
      const edit = spec.parameterEdit;
      const parameterId = parameters.find((p) => p.name === edit.name)?.id ?? edit.name;
      const edited = await client.call('parameter.edit', { parameterId, value: edit.value });
      const after = ((await client.call('bodies.list')).result ?? [])[0];
      check(
        'parameter edit',
        !edited.error &&
          after &&
          edit.bboxSize.every((v, i) => near(after.bbox.size[i], v, tolerance)),
        edited.error ? edited.error.message : after?.bbox.size.join(' x '),
      );
      await client.call('history.undo');
    }
    const inspect = (await client.call('view.inspect', { size: 320 })).result;
    for (const image of inspect?.images ?? []) {
      const name = image.view.name ?? `${image.view.azimuth}_${image.view.elevation}`;
      writeFileSync(join(outDir, `${task.id}-${name}.png`), Buffer.from(image.data, 'base64'));
    }
    check(
      'renders',
      (inspect?.images ?? []).length === 4,
      `${(inspect?.images ?? []).length} views`,
    );
  } finally {
    await client.close();
  }
  return checks;
}

const results = [];
for (const task of tasks) {
  const workDir = join(outDir, task.id);
  mkdirSync(workDir, { recursive: true });
  process.stdout.write(`${task.id} (${provider}) … `);
  const run = await runAgent(task, workDir);
  const checks = await accept(task, run.projectPath);
  const passed = run.exitCode === 0 && checks.every((c) => c.ok);
  results.push({
    task: task.id,
    provider,
    passed,
    exitCode: run.exitCode,
    seconds: run.seconds,
    ...run.stats,
    checks,
    stderr: passed ? undefined : run.stderr,
  });
  console.log(
    passed ? 'pass' : 'FAIL',
    `${run.seconds.toFixed(1)} s, ${run.stats.toolCalls} tool calls (${run.stats.toolErrors} errors)`,
  );
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail ?? ''}`);
}
writeFileSync(
  join(outDir, 'results.json'),
  `${JSON.stringify({ provider, date: new Date().toISOString(), results }, null, 2)}\n`,
);
console.log(`results: ${join(outDir, 'results.json')}`);
process.exit(results.every((r) => r.passed) ? 0 : 1);
