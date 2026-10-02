/**
 * The desktop assistant host without Electron: discovery, sessions, turns
 * and interrupts with the scripted stand-in harness (no provider is ever
 * called), the per-turn tool token of the loopback endpoint, the MCP server
 * script, npm shim resolution and the per-CLI arguments.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  AssistantHarnessHost,
  harnessArguments,
  launchFromCmdShim,
  type Identity,
} from '../../electron/assistantHost.js';
import { AssistantToolServer } from '../../electron/assistantTools.js';
import { callAssistantTool } from '../../renderer/src/interface/assistant/tools.js';
import { ASSISTANT_TOOLS } from '../../renderer/src/interface/assistant/tools.js';

const APP_DIR = process.cwd();
const HARNESS = join(APP_DIR, 'bench', 'assistant', 'scriptedHarness.mjs');
// The MCP server script as the test build compiled it.
const MCP_SCRIPT = resolve(
  APP_DIR,
  '.build',
  'tests',
  'apps',
  'assembler',
  'electron',
  'assistantMcpServer.js',
);

type Json = Record<string, unknown>;

function waitFor(events: Json[], type: string, timeoutMs = 60_000): Promise<Json> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const poll = () => {
      const found = events.find((event) => event.type === type);
      if (found) resolvePromise(found);
      else if (Date.now() - started > timeoutMs)
        reject(new Error(`no ${type} event in ${timeoutMs} ms`));
      else setTimeout(poll, 20);
    };
    poll();
  });
}

void test('a scripted turn: discovery, MCP tool calls through the token endpoint, resume binding, interrupt', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'assembler-assistant-host-'));
  const plan = join(dir, 'plan.json');
  writeFileSync(
    plan,
    JSON.stringify({
      tasks: [
        {
          id: 'hello',
          match: 'hello',
          steps: [
            { say: 'Checking.' },
            { tool: 'skills_list', args: {} },
            { tool: 'hcasm_call', args: { method: 'document.get', params: {} } },
          ],
          final: 'All good.',
        },
        {
          id: 'slow',
          match: 'slow',
          steps: [{ say: 'one' }, { say: 'two' }, { say: 'three' }, { say: 'four' }],
        },
      ],
    }),
  );
  const calls: string[] = [];
  const tools = new AssistantToolServer(async (request) => {
    if (request.name === 'tools/list') return { tools: ASSISTANT_TOOLS };
    calls.push(request.name);
    return callAssistantTool(
      {
        session: {
          handle: async (method) =>
            method === 'skills.list'
              ? { skills: [], total: 0, nextCursor: null }
              : { projectName: 'Fake', revision: 0 },
        },
      },
      request.name,
      request.arguments,
    );
  });
  await tools.start();
  const host = new AssistantHarnessHost({
    dataDir: join(dir, 'data'),
    tools,
    nodeCommand: process.execPath,
    mcpServerScript: MCP_SCRIPT,
    testHarness: HARNESS,
    env: { ...process.env, HCASM_SCRIPTED_PLAN: plan },
  });
  t.after(async () => {
    await host.close();
    await tools.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const discover = (provider: string) =>
    host.request({
      kind: 'discover',
      provider,
      executableNames: [provider],
      versionArgs: ['--version'],
      timeoutMs: 2000,
    }) as Promise<Json>;
  const claude = await discover('claude');
  assert.equal(claude.kind, 'discovered');
  const identity = claude.identity as Identity;
  assert.deepEqual(identity.capabilities, ['claudeJson']);
  assert.equal((await discover('codex')).kind, 'missing');

  const open = (resumeThreadId?: string) =>
    host.request({
      kind: 'openSession',
      identity,
      mode: 'claudeJson',
      scope: {},
      systemPrompt: 'Tools only.',
      experimentalApi: false,
      ...(resumeThreadId ? { resumeThreadId } : {}),
    }) as Promise<Json>;
  const opened = await open();
  assert.equal(opened.kind, 'sessionOpened');
  const sessionId = String(opened.hostSessionId);
  const threadId = String(opened.providerThreadId);
  const events: Json[] = [];
  host.subscribe(sessionId, (payload) => events.push(payload as Json));
  await host.request({ kind: 'sendTurn', sessionId, turnId: 'turn-1', prompt: 'hello there' });
  const done = await waitFor(events, 'turn.completed');
  assert.equal(done.exit_code, 0);
  assert.deepEqual(calls, ['skills_list', 'hcasm_call']);
  const types = events.map((event) => event.type);
  for (const type of ['turn.started', 'system', 'assistant', 'user', 'result']) {
    assert.ok(types.includes(type), `${type} in ${types.join(',')}`);
  }
  const results = events.filter((e) => e.type === 'user');
  assert.ok(
    results.every((e) => !JSON.stringify(e).includes('"is_error":true')),
    'tool calls succeeded',
  );

  // The CLI's own session id is kept locally (never in the project) for the next turn.
  const bindings = JSON.parse(readFileSync(join(dir, 'data', 'threads.json'), 'utf8')) as Record<
    string,
    Json
  >;
  assert.ok(typeof bindings[threadId]?.nativeId === 'string');
  await host.request({ kind: 'closeSession', sessionId });
  const resumed = await open(threadId);
  assert.equal(resumed.providerThreadId, threadId, 'a stored thread is continued');

  // The endpoint refuses a token after its turn ended, and browser-style requests.
  const stale = await fetch(tools.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' },
    body: '{"op":"list"}',
  });
  assert.equal(stale.status, 401);
  const token = tools.issue(threadId);
  const browser = await fetch(tools.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.com' },
    body: '{"op":"list"}',
  });
  assert.equal(browser.status, 403);
  tools.revoke(token);

  // Interrupt stops the CLI and its MCP server; the turn reports `turn.interrupted`.
  const slowHost = new AssistantHarnessHost({
    dataDir: join(dir, 'data2'),
    tools,
    nodeCommand: process.execPath,
    mcpServerScript: MCP_SCRIPT,
    testHarness: HARNESS,
    env: { ...process.env, HCASM_SCRIPTED_PLAN: plan, HCASM_SCRIPTED_DELAY_MS: '800' },
  });
  t.after(() => slowHost.close());
  const slowIdentity = (
    (await slowHost.request({
      kind: 'discover',
      provider: 'claude',
      executableNames: ['claude'],
      versionArgs: ['--version'],
      timeoutMs: 2000,
    })) as Json
  ).identity;
  const slow = (await slowHost.request({
    kind: 'openSession',
    identity: slowIdentity,
    mode: 'claudeJson',
    scope: {},
    systemPrompt: 'x',
    experimentalApi: false,
  })) as Json;
  const slowEvents: Json[] = [];
  slowHost.subscribe(String(slow.hostSessionId), (payload) => slowEvents.push(payload as Json));
  await slowHost.request({
    kind: 'sendTurn',
    sessionId: slow.hostSessionId,
    turnId: 'turn-2',
    prompt: 'slow please',
  });
  await waitFor(slowEvents, 'turn.started');
  await slowHost.request({ kind: 'interrupt', sessionId: slow.hostSessionId });
  await waitFor(slowEvents, 'turn.interrupted');
  assert.equal(
    slowEvents.some((e) => e.type === 'turn.completed'),
    false,
  );
});

void test('npm .cmd shims resolve to the executable or Node script they start (no shell)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assembler-shim-'));
  try {
    mkdirSync(join(dir, 'node_modules', 'cli', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'cli', 'bin', 'tool.exe'), 'binary');
    writeFileSync(join(dir, 'node_modules', 'cli', 'bin', 'tool.js'), '// script');
    writeFileSync(join(dir, 'node.exe'), 'node');
    writeFileSync(
      join(dir, 'exe.cmd'),
      '@ECHO off\r\n"%dp0%\\node_modules\\cli\\bin\\tool.exe"   %*\r\n',
    );
    writeFileSync(
      join(dir, 'js.cmd'),
      '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\cli\\bin\\tool.js" %*\r\n',
    );
    const exe = await launchFromCmdShim(join(dir, 'exe.cmd'), {}, 'win32');
    assert.equal(exe?.command, resolve(dir, 'node_modules/cli/bin/tool.exe'));
    assert.deepEqual(exe?.prefixArgs, []);
    const js = await launchFromCmdShim(join(dir, 'js.cmd'), {}, 'win32');
    assert.equal(js?.command, join(dir, 'node.exe'));
    assert.deepEqual(js?.prefixArgs, [resolve(dir, 'node_modules/cli/bin/tool.js')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('per-CLI arguments: only the hcasm tools, the prompt on stdin, resume ids', () => {
  const mcp = {
    command: 'node',
    script: 'mcp.js',
    env: { HCASM_TOOL_URL: 'http://127.0.0.1:1/tool', HCASM_TOOL_TOKEN: 't' },
  };
  const session = (provider: Identity['provider'], nativeId: string | null) => ({
    identity: { provider } as Identity,
    nativeId,
    systemPrompt: 'Rules.',
    workspace: '/w',
  });
  const claudeNew = harnessArguments(session('claude', null), 'cfg.json', mcp, 'uuid-1').args;
  assert.deepEqual(
    claudeNew.slice(claudeNew.indexOf('--tools'), claudeNew.indexOf('--tools') + 4),
    ['--tools', '', '--allowedTools', 'mcp__hcasm'],
  );
  assert.ok(claudeNew.includes('--strict-mcp-config'));
  assert.deepEqual(claudeNew.slice(-2), ['--session-id', 'uuid-1']);
  const claudeNext = harnessArguments(session('claude', 'uuid-1'), 'cfg.json', mcp).args;
  assert.deepEqual(claudeNext.slice(-2), ['--resume', 'uuid-1']);
  const codex = harnessArguments(session('codex', 'th-9'), 'cfg.json', mcp).args;
  assert.deepEqual(codex.slice(0, 2), ['exec', '--json']);
  assert.ok(codex.includes('read-only') && codex.includes('--ignore-user-config'));
  assert.ok(codex.some((a) => a.startsWith('mcp_servers.hcasm.env.HCASM_TOOL_TOKEN=')));
  assert.deepEqual(codex.slice(-3), ['resume', 'th-9', '-']);
  const opencode = harnessArguments(session('opencode', null), 'cfg.json', mcp);
  const config = JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT!) as Json;
  const permission = ((config.agent as Json).himmelcad as Json).permission as Json;
  assert.equal(permission.bash, 'deny');
  assert.equal(permission['hcasm_*'], 'allow');
});
