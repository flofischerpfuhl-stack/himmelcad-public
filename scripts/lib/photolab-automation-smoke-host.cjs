'use strict';

const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const { isAbsolute, relative, resolve, sep } = require('node:path');

const {
  AutomationRpcRouter,
  BrokeredFilesystemGrantStore,
} = require('../../packages/@himmelcad/automation-host/index.cjs');

const repositoryRoot = resolve(__dirname, '../..');
const scratchRoot = resolve(repositoryRoot, '.build/codex-scratch/pl-i2');
const sidecarPath = resolve(
  process.env.HIMMELCAD_PHOTOLAB_SIDECAR ??
    resolve(repositoryRoot, 'target/photolab/release/himmelcad-photolab-sidecar'),
);
const sidecar = spawn(sidecarPath, [], {
  cwd: repositoryRoot,
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let sidecarId = 1;
let sidecarStdout = '';
let stderrTail = '';
let maxRssBytes = 0;

function rssBytes(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

const memorySampler = setInterval(() => {
  maxRssBytes = Math.max(maxRssBytes, rssBytes(process.pid) + rssBytes(sidecar.pid));
}, 50);
memorySampler.unref();

sidecar.stdout.setEncoding('utf8');
sidecar.stdout.on('data', (chunk) => {
  sidecarStdout += chunk;
  for (;;) {
    const newline = sidecarStdout.indexOf('\n');
    if (newline < 0) break;
    const line = sidecarStdout.slice(0, newline).trim();
    sidecarStdout = sidecarStdout.slice(newline + 1);
    if (!line) continue;
    const response = JSON.parse(line);
    const callback = pending.get(response.id);
    if (!callback) continue;
    pending.delete(response.id);
    if (response.error) {
      callback.reject({
        code: response.error.code === -32602 ? 'invalidRequest' : 'internal',
        message: response.error.message,
        details: response.error.data ?? {},
      });
    } else callback.resolve(response.result);
  }
});
sidecar.stderr.setEncoding('utf8');
sidecar.stderr.on('data', (chunk) => {
  stderrTail = `${stderrTail}${chunk}`.slice(-16_384);
});
sidecar.on('exit', (code, signal) => {
  for (const callback of pending.values()) {
    callback.reject({
      code: 'internal',
      message: `PhotoLab sidecar exited (${String(code)}/${String(signal)}): ${stderrTail}`,
    });
  }
  pending.clear();
});

function sidecarCall(method, params) {
  return new Promise((resolvePromise, reject) => {
    const id = sidecarId++;
    pending.set(id, { resolve: resolvePromise, reject });
    sidecar.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const filesystemGrants = new BrokeredFilesystemGrantStore();
const router = new AutomationRpcRouter({ sidecarCall, filesystemGrants });
const connectionId = router.openConnection();

function withinScratch(path) {
  if (!isAbsolute(path)) return false;
  const difference = relative(scratchRoot, resolve(path));
  return difference !== '' && difference !== '..' && !difference.startsWith(`..${sep}`);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function bootstrap(message) {
  const paths = [message.syncProjectPath, message.asyncProjectPath, message.imagesPath];
  if (paths.some((path) => typeof path !== 'string' || !withinScratch(path))) {
    throw new Error('Smoke grants must stay under .build/codex-scratch/pl-i2.');
  }
  return {
    syncProject: await filesystemGrants.issue({
      connectionId,
      path: message.syncProjectPath,
      access: 'write',
    }),
    asyncProject: await filesystemGrants.issue({
      connectionId,
      path: message.asyncProjectPath,
      access: 'write',
    }),
    images: await filesystemGrants.issue({
      connectionId,
      path: message.imagesPath,
      access: 'read',
    }),
  };
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
input.on('line', (line) => {
  queue = queue
    .then(async () => {
      const message = JSON.parse(line);
      if (message.control === 'bootstrap') {
        write({ control: 'bootstrap', grants: await bootstrap(message) });
        return;
      }
      if (message.control === 'shutdown') {
        router.closeConnection(connectionId);
        maxRssBytes = Math.max(maxRssBytes, rssBytes(process.pid) + rssBytes(sidecar.pid));
        sidecar.stdin.end();
        await new Promise((resolvePromise) => sidecar.once('exit', resolvePromise));
        clearInterval(memorySampler);
        write({ control: 'shutdown', ok: true, maxRssBytes });
        input.close();
        process.stdin.pause();
        process.exitCode = 0;
        return;
      }
      write(await router.handle(message, connectionId));
    })
    .catch((error) => {
      write({
        id: null,
        error: {
          code: error?.code ?? 'internal',
          message: error instanceof Error ? error.message : String(error?.message ?? error),
        },
      });
      process.exitCode = 1;
    });
});
