/**
 * Kernel determinism across engines (`pnpm test:electron`, after `pnpm
 * build`): the production app (Chromium, the kernel Web Worker) and this
 * Node process (the same OCCT wasm in-process) must name every body, face
 * and edge of the same document identically — the agent API's descriptors
 * are compared as JSON, keys, aliases, rounded geometry and all. Also
 * reports how long an edit of the last feature takes in the app, through
 * the agent API (worker round trip, prefix cache, incremental tessellation).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _electron as electron } from 'playwright-core';

import { closeApp } from './closeApp.js';
import { dismissHome } from './home.js';

import { describeBody, describeEdge, describeFace } from '../../renderer/src/api/describe.js';
import { loadProjectFile, saveProjectFile } from '../../renderer/src/model/project/format.js';
import { BENCH_PARTS, sixtyPartBench } from '../bench/parts.js';
import { loadNodeKernel } from '../kernel/nodeKernel.js';

const APP_DIR = process.cwd();

interface Status {
  enabled: boolean;
  url: string | null;
  token: string | null;
}

async function rpc<T = Record<string, unknown>>(
  status: Status,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(status.url!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${status.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

void test('the app (browser worker) and Node name every body, face and edge identically', async (t) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'assembler-determinism-'));
  const app = await electron.launch({
    args: [APP_DIR, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ASSEMBLER_FORCE_PRODUCTION: '1' },
    timeout: 60_000,
  });
  t.after(async () => {
    await closeApp(app);
    rmSync(userDataDir, { recursive: true, force: true });
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await window.waitForFunction(() => !document.body.innerText.includes('No items yet'), {
    timeout: 60_000,
  });
  await dismissHome(window);

  // Agent access on, the way a user turns it on.
  await window.keyboard.press('Control+f');
  await window.getByPlaceholder('Search commands…').fill('agent access');
  await window.keyboard.press('Enter');
  await window.getByText('Agent access on').waitFor({ timeout: 10_000 });
  const status = await window.evaluate(() =>
    (
      globalThis as unknown as { assembler: { automation: { status(): Promise<Status> } } }
    ).assembler.automation.status(),
  );

  const { evaluator } = await loadNodeKernel();
  for (const part of BENCH_PARTS) {
    const text = saveProjectFile({
      projectName: part.name,
      features: part.document(),
      appVersion: 'determinism-test',
      createdAt: '2026-09-29T00:00:00.000Z',
    });
    const opened = await rpc<{ errors: Record<string, string> }>(status, 'project.open', { text });
    assert.deepEqual(opened.errors, {}, part.name);

    const features = loadProjectFile(text).features;
    const node = await evaluator.evaluate(features);
    const expected = node.bodies.map((body) => ({
      body: describeBody(body),
      faces: body.faces.map((face) => describeFace(body, face, features)),
      edges: body.edges.map((edge) => describeEdge(body, edge)),
    }));
    const bodies = await rpc<{ id: string }[]>(status, 'bodies.list');
    const actual = [];
    for (const b of bodies) {
      actual.push({
        body: await rpc(status, 'body.get', { bodyId: b.id }),
        faces: await rpc(status, 'faces.list', { bodyId: b.id }),
        edges: await rpc(status, 'edges.list', { bodyId: b.id }),
      });
    }
    assert.deepEqual(actual, JSON.parse(JSON.stringify(expected)), `${part.name}: app == Node`);
  }

  // The synthetic 60-feature plate is open now: time last-feature edits in the app.
  const last = sixtyPartBench.document().at(-1)!;
  const times: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    const edited = await rpc<{ errors: Record<string, string> }>(status, 'feature.edit', {
      featureId: last.id,
      params: { radius: 1 + 0.1 * (i + 1) },
    });
    times.push(performance.now() - t0);
    assert.deepEqual(edited.errors, {});
  }
  times.sort((a, b) => a - b);
  t.diagnostic(
    `app: last-feature edit of the 60-feature plate through the agent API (worker, validate + commit): median ${times[2]!.toFixed(0)} ms (${times.map((x) => x.toFixed(0)).join(', ')})`,
  );
});
