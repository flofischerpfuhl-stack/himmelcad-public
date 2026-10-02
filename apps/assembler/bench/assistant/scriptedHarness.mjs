#!/usr/bin/env node
/**
 * A scripted stand-in for the `claude` CLI — no AI provider is ever called.
 * It accepts the arguments the Assembler host passes to Claude Code
 * (`-p --output-format stream-json … --mcp-config <file>`), starts the MCP
 * server named there, reads the prompt from stdin, picks the first plan task
 * whose `match` regex fits it, runs its steps as MCP tool calls and prints
 * Claude-style `stream-json` events. Used by the Electron end-to-end test and
 * by the assistant benchmark's `--provider scripted` (CI); real CLIs are only
 * run by hand (assembler/AGENT-ASSISTANT.md "Benchmark").
 *
 * Plan file: `HCASM_SCRIPTED_PLAN` (default `plans.json` next to this file):
 *   {"tasks": [{"id", "match", "steps": [{"say": "…"} |
 *     {"tool": "hcasm_call", "args": {…}, "save": "name", "allowError": true}],
 *     "final": "…"}]}
 * String values of `args` may contain `{{name.path}}`: a value from the JSON
 * result of an earlier step saved under `name` (e.g. `{{base.featureId}}`).
 * `HCASM_SCRIPTED_DELAY_MS` waits between steps (tests of Interrupt).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('scripted-harness 1.0 (test stand-in, no provider)\n');
  process.exit(0);
}

const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const delay = Number(process.env.HCASM_SCRIPTED_DELAY_MS ?? 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sessionId = value('--session-id') ?? value('--resume') ?? randomUUID();
const planPath =
  process.env.HCASM_SCRIPTED_PLAN ?? join(dirname(fileURLToPath(import.meta.url)), 'plans.json');
const plan = JSON.parse(readFileSync(planPath, 'utf8'));

const configPath = value('--mcp-config');
if (!configPath) {
  process.stderr.write('scripted-harness: --mcp-config is required\n');
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const server = config.mcpServers?.hcasm;
if (!server) {
  process.stderr.write('scripted-harness: no "hcasm" MCP server in the config\n');
  process.exit(2);
}

const mcp = spawn(server.command, server.args ?? [], {
  env: { ...process.env, ...(server.env ?? {}) },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const waiting = new Map();
let nextId = 0;
createInterface({ input: mcp.stdout }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = waiting.get(message.id);
  if (resolve) {
    waiting.delete(message.id);
    resolve(message);
  }
});
const request = (method, params = {}) =>
  new Promise((resolve) => {
    nextId += 1;
    waiting.set(nextId, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params })}\n`);
  });

async function readPrompt() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function lookup(saved, path) {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), saved);
}

function substitute(value, saved) {
  if (typeof value === 'string') {
    const whole = /^\{\{([^}]+)\}\}$/u.exec(value);
    if (whole) return lookup(saved, whole[1]);
    return value.replace(/\{\{([^}]+)\}\}/gu, (_, path) => String(lookup(saved, path)));
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, saved));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, saved)]));
  }
  return value;
}

async function main() {
  const prompt = await readPrompt();
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    tools: [],
    mcp_servers: [{ name: 'hcasm', status: 'connected' }],
  });
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'scripted-harness', version: '1.0' },
  });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = (await request('tools/list')).result?.tools ?? [];
  const task = plan.tasks.find((t) => new RegExp(t.match, 'iu').test(prompt));
  let message = 0;
  const say = (text) => {
    message += 1;
    emit({
      type: 'assistant',
      message: { id: `msg_${message}`, role: 'assistant', content: [{ type: 'text', text }] },
      session_id: sessionId,
    });
  };
  if (!task) {
    say(
      `This scripted test harness only runs its planned tasks (${plan.tasks.map((t) => t.id).join(', ')}). Tools available: ${tools.map((t) => t.name).join(', ')}.`,
    );
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return 0;
  }
  const saved = {};
  let failures = 0;
  let calls = 0;
  for (const step of task.steps) {
    if (delay > 0) await sleep(delay);
    if (step.say) {
      say(step.say);
      continue;
    }
    calls += 1;
    const toolUseId = `toolu_${calls}`;
    const input = substitute(step.args ?? {}, saved);
    message += 1;
    emit({
      type: 'assistant',
      message: {
        id: `msg_${message}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: `mcp__hcasm__${step.tool}`, input }],
      },
      session_id: sessionId,
    });
    const response = await request('tools/call', { name: step.tool, arguments: input });
    const result = response.result ?? {
      content: [{ type: 'text', text: JSON.stringify(response.error) }],
      isError: true,
    };
    const textBlock = (result.content ?? []).find((block) => block.type === 'text');
    if (step.save && textBlock) {
      try {
        saved[step.save] = JSON.parse(textBlock.text);
      } catch {
        saved[step.save] = textBlock.text;
      }
    }
    if (result.isError && !step.allowError) failures += 1;
    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            is_error: Boolean(result.isError),
            content: (result.content ?? []).map((block) =>
              block.type === 'image'
                ? {
                    type: 'image',
                    source: { type: 'base64', media_type: block.mimeType, data: '' },
                  }
                : block,
            ),
          },
        ],
      },
      session_id: sessionId,
    });
    if (result.isError && !step.allowError && step.stopOnError !== false) break;
  }
  say(failures === 0 ? (task.final ?? 'Done.') : `Stopped: ${failures} tool call(s) failed.`);
  emit({
    type: 'result',
    subtype: failures === 0 ? 'success' : 'error_during_execution',
    is_error: failures > 0,
    result: failures === 0 ? (task.final ?? 'Done.') : 'A scripted tool call failed.',
    session_id: sessionId,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    mcp.stdin.end();
    mcp.once('close', () => process.exit(code));
    setTimeout(() => process.exit(code), 30_000).unref();
  },
  (error) => {
    process.stderr.write(`scripted-harness: ${error?.stack ?? error}\n`);
    mcp.kill();
    process.exit(1);
  },
);
