import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { TestDialogResponder } from '../src/testDialogResponder.js';

async function fixture(
  responses: readonly Record<string, unknown>[],
): Promise<{ readonly root: string; readonly queue: string }> {
  const root = await fs.mkdtemp(resolve(tmpdir(), 'hcad-dialog-responder-'));
  const queue = resolve(root, 'queue.json');
  await fs.writeFile(queue, `${JSON.stringify(responses)}\n`);
  return { root, queue };
}

void test('development responder consumes open and save responses in FIFO order', async (t) => {
  const { root, queue } = await fixture([
    { kind: 'open', filePaths: [resolve('./scan.las')], canceled: false },
    { kind: 'save', filePath: resolve('./terrain.xml'), canceled: false },
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events: string[] = [];
  const responder = new TestDialogResponder({
    isPackaged: false,
    queuePath: queue,
    log: (event, response) => events.push(`${event}:${response.kind}`),
  });

  assert.deepEqual(await responder.open(), {
    canceled: false,
    filePaths: [resolve('./scan.las')],
  });
  assert.deepEqual(await responder.save(), {
    canceled: false,
    filePath: resolve('./terrain.xml'),
  });
  assert.deepEqual(JSON.parse(await fs.readFile(queue, 'utf8')), []);
  assert.deepEqual(events, ['dialog.responded:open', 'dialog.responded:save']);
});

void test('packaged builds ignore the queue without reading or consuming it', async (t) => {
  const { root, queue } = await fixture([
    { kind: 'open', filePaths: ['./scan.las'], canceled: false },
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = await fs.readFile(queue, 'utf8');
  const responder = new TestDialogResponder({ isPackaged: true, queuePath: queue });

  assert.equal(responder.enabled(), false);
  assert.equal(await responder.open(), null);
  assert.equal(await fs.readFile(queue, 'utf8'), before);
});

void test('kind mismatch fails without consuming the next response', async (t) => {
  const { root, queue } = await fixture([
    { kind: 'save', filePath: './terrain.xml', canceled: false },
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const responder = new TestDialogResponder({ isPackaged: false, queuePath: queue });

  await assert.rejects(() => responder.open(), /expected open, but next response is save/u);
  assert.equal((JSON.parse(await fs.readFile(queue, 'utf8')) as unknown[]).length, 1);
});
