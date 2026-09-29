/**
 * `assembler-headless` end to end: a real child process speaking JSON-RPC
 * 2.0 over stdio (one object per line) with the in-process OCCT kernel.
 * Requires `pnpm build:headless` (the `test` script runs it first).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Compiled to `.build/tests/apps/assembler/test/api/`.
const BIN = fileURLToPath(new URL('../../../../../../bin/assembler-headless.mjs', import.meta.url));

void test('JSON-RPC round trip over stdio: model, error, notification, export to a path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hcasm-headless-'));
  const child = spawn(process.execPath, [BIN], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const responses: unknown[] = [];
  const waiters: ((value: unknown) => void)[] = [];
  lines.on('line', (line) => {
    const parsed: unknown = JSON.parse(line); // every stdout line must be JSON
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else responses.push(parsed);
  });
  const send = (message: unknown): Promise<Record<string, unknown>> => {
    child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
    return new Promise((resolve) => {
      const queued = responses.shift();
      if (queued) resolve(queued as Record<string, unknown>);
      else waiters.push((v) => resolve(v as Record<string, unknown>));
    });
  };

  try {
    const hello = await send({ jsonrpc: '2.0', id: 1, method: 'api.hello', params: {} });
    assert.equal((hello.result as { server: string }).server, 'headless');

    const sketch = await send({
      jsonrpc: '2.0',
      id: 'a',
      method: 'feature.create',
      params: {
        kind: 'sketch',
        params: { plane: 'XY', profiles: [{ kind: 'circle', cx: 0, cy: 0, radius: 5 }] },
      },
    });
    assert.equal(sketch.id, 'a');
    const sketchId = (sketch.result as { featureId: string }).featureId;

    // A notification (no id) is executed but answered with nothing; the next reply is id 3's.
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'feature.rename', params: { featureId: sketchId, name: 'Disc' } })}\n`,
    );
    const extrude = await send({
      jsonrpc: '2.0',
      id: 3,
      method: 'feature.create',
      params: {
        kind: 'extrude',
        params: { profile: { kind: 'sketch', featureId: sketchId }, distance: 2 },
      },
    });
    assert.equal(extrude.id, 3);
    const body = (extrude.result as { bodies: { volume: number }[] }).bodies[0]!;
    assert.ok(Math.abs(body.volume - Math.PI * 25 * 2) < 1e-6);

    const features = await send({ jsonrpc: '2.0', id: 4, method: 'features.list', params: {} });
    assert.equal((features.result as { name: string }[])[0]!.name, 'Disc');

    const error = await send({
      jsonrpc: '2.0',
      id: 5,
      method: 'feature.edit',
      params: { featureId: 'nope', params: {} },
    });
    const data = error.error as { code: number; data: { code: string; details: unknown } };
    assert.equal(data.code, -32004);
    assert.equal(data.data.code, 'notFound');

    const parse = await send('{not json');
    assert.equal((parse.error as { code: number }).code, -32700);

    const exported = await send({
      jsonrpc: '2.0',
      id: 6,
      method: 'export.stl',
      params: { path: 'out/disc.stl' },
    });
    const path = (exported.result as { path: string }).path;
    assert.equal(
      readFileSync(path).byteLength,
      (exported.result as { byteLength: number }).byteLength,
    );
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(child.exitCode, 0);
});
