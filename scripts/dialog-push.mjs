#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [queueArgument, responseArgument] = process.argv.slice(2);
if (!queueArgument || !responseArgument) {
  console.error("Usage: scripts/ui-test-display.sh dialog-push <queue.json> '<response-json>'");
  process.exit(2);
}

const queuePath = resolve(queueArgument);
const response = parseResponse(JSON.parse(responseArgument));
await fs.mkdir(dirname(queuePath), { recursive: true });
await withQueueLock(queuePath, async () => {
  let queue = [];
  try {
    const parsed = JSON.parse(await fs.readFile(queuePath, 'utf8'));
    if (!Array.isArray(parsed)) throw new TypeError('Dialog queue must be a JSON array.');
    queue = parsed.map(parseResponse);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
  queue.push(response);
  await fs.mkdir(dirname(queuePath), { recursive: true });
  const pending = `${queuePath}.pending-${process.pid}`;
  await fs.writeFile(pending, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(pending, queuePath);
});
console.log(`Queued ${response.kind} dialog response in ${queuePath}`);

function parseResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Dialog response must be an object.');
  }
  if (value.kind === 'open') {
    if (typeof value.canceled !== 'boolean' || !Array.isArray(value.filePaths)) {
      throw new TypeError('Open response requires canceled and filePaths.');
    }
    if (!value.filePaths.every((item) => typeof item === 'string' && item.trim())) {
      throw new TypeError('Open response filePaths must be non-empty strings.');
    }
    return {
      kind: 'open',
      canceled: value.canceled,
      filePaths: value.filePaths.map((item) => resolve(item)),
    };
  }
  if (value.kind === 'save') {
    if (typeof value.canceled !== 'boolean') throw new TypeError('Save response requires canceled.');
    if (value.filePath !== undefined && (typeof value.filePath !== 'string' || !value.filePath.trim())) {
      throw new TypeError('Save response filePath must be a non-empty string.');
    }
    return value.filePath === undefined
      ? { kind: 'save', canceled: value.canceled }
      : { kind: 'save', canceled: value.canceled, filePath: resolve(value.filePath) };
  }
  throw new TypeError('Dialog response kind must be open or save.');
}

async function withQueueLock(path, operation) {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST' || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  try {
    await operation();
  } finally {
    await fs.rmdir(lockPath).catch(() => undefined);
  }
}
