/**
 * Agent access in the real production app (`pnpm test:electron`, after
 * `pnpm build`): the endpoint is off at start, the UI command turns it on
 * and shows the indicator, requests without the token are refused, and an
 * agent can open the benchmark `.hcasm` files in the running app, where they
 * evaluate, render in the History panel and stay editable — an agent edit is
 * undone with the app's own Ctrl+Z (one shared undo stack).
 *
 * The projects are the agent benchmark's results (`apps/assembler/bench/
 * run_bench.py`), checked in under `test/fixtures/` (schema-1 files, so the
 * 1 → 2 migration runs in the real app too); `ASSEMBLER_BENCH_DIR` points
 * the test at a fresh benchmark run instead. Screenshots go to
 * `ASSEMBLER_SHOTS_DIR` (default: a temp directory).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _electron as electron } from 'playwright-core';

import { closeApp } from './closeApp.js';
import { dismissHome } from './home.js';

const APP_DIR = process.cwd();
const BENCH_DIR = process.env.ASSEMBLER_BENCH_DIR ?? join(APP_DIR, 'test', 'fixtures');
const SHOTS_DIR = process.env.ASSEMBLER_SHOTS_DIR ?? join(tmpdir(), 'assembler-agent-shots');

interface Status {
  enabled: boolean;
  url: string | null;
  token: string | null;
}

async function rpc(
  status: Status,
  method: string,
  params: Record<string, unknown> = {},
  token = status.token,
): Promise<{
  status: number;
  body: { result?: Record<string, unknown>; error?: { data: { code: string } } };
}> {
  const response = await fetch(status.url!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: (await response.json()) as never };
}

void test('agent access: off by default, UI toggle + indicator, bench projects open and stay editable', async (t) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'assembler-agent-'));
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
  // Home → Escape (a blank project) → the demo bracket opened (`home.ts`).
  await dismissHome(window);

  const getStatus = () =>
    window.evaluate(() =>
      (
        globalThis as unknown as { assembler: { automation: { status(): Promise<Status> } } }
      ).assembler.automation.status(),
    );
  const initial = await getStatus();
  assert.equal(initial.enabled, false, 'agent access is off by default');
  assert.equal(initial.url, null);
  assert.equal(await window.getByText('Agent access on').count(), 0);

  // Turn it on the way a user does: command search (Ctrl+F) -> "Agent Access (Local)".
  await window.keyboard.press('Control+f');
  await window.getByPlaceholder('Search commands…').fill('agent access');
  await window.keyboard.press('Enter');
  await window.getByText('Agent access on').waitFor({ timeout: 10_000 });
  const status = await getStatus();
  assert.equal(status.enabled, true);
  assert.match(status.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/rpc$/);

  const refused = await rpc(status, 'document.get', {}, 'wrong-token');
  assert.equal(refused.status, 401);
  const hello = await rpc(status, 'api.hello');
  assert.equal(hello.body.result?.server, 'app');

  mkdirSync(SHOTS_DIR, { recursive: true });
  await window.screenshot({ path: join(SHOTS_DIR, 'agent-access-on.png') });

  const files = existsSync(BENCH_DIR)
    ? readdirSync(BENCH_DIR).filter((f) => f.endsWith('.hcasm'))
    : [];
  t.diagnostic(`bench projects: ${files.join(', ')}`);
  assert.ok(files.length > 0, `no .hcasm projects in ${BENCH_DIR}`);
  for (const file of files) {
    const text = readFileSync(join(BENCH_DIR, file), 'utf8');
    const opened = await rpc(status, 'project.open', { text });
    assert.ok(opened.body.result, `${file}: ${JSON.stringify(opened.body.error)}`);
    assert.deepEqual(opened.body.result.errors, {}, file);
    const bodies = opened.body.result.bodies as { valid: boolean; name: string }[];
    assert.ok(bodies.length > 0 && bodies.every((b) => b.valid), file);
    // The History panel lists the loaded features (it is the user-visible history).
    const features = (await rpc(status, 'features.list')).body.result as unknown as {
      id: string;
      name: string;
      kind: string;
      params: Record<string, unknown>;
    }[];
    await window.getByText(features.at(-1)!.name, { exact: true }).first().waitFor();

    // Editable: grow a size dimension of the first sketch (as the History panel would), then undo with Ctrl+Z.
    const sketch = features.find((f) => f.kind === 'sketch')!;
    const dimensions = sketch.params.dimensions as { name: string; kind: string; value: number }[];
    const size = dimensions.find((d) => d.kind === 'distance' || d.kind === 'diameter')!;
    const edited = await rpc(status, 'sketch.setDimension', {
      featureId: sketch.id,
      dimension: size.name,
      value: size.value + (size.kind === 'diameter' ? 1 : 2),
    });
    assert.deepEqual(edited.body.result?.errors, {}, `${file}: edit re-evaluates cleanly`);
    await window.screenshot({ path: join(SHOTS_DIR, `agent-${file.replace('.hcasm', '')}.png`) });
    await window.keyboard.press('Control+z');
    let after = (await rpc(status, 'document.get')).body.result!;
    for (let i = 0; i < 50 && after.canUndo; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = (await rpc(status, 'document.get')).body.result!;
    }
    assert.equal(after.canUndo, false, `${file}: the UI undo reverted the agent edit`);
    assert.equal(after.canRedo, true);
  }

  // Turning it off closes the socket.
  await window.getByRole('button', { name: 'Turn off' }).click();
  await window.getByText('Agent access on').waitFor({ state: 'detached' });
  await assert.rejects(rpc(status, 'document.get'));
});
