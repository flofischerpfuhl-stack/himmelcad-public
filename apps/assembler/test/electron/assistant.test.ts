/**
 * The embedded assistant in the real production app (`pnpm test:electron`),
 * end to end with the scripted stand-in for the `claude` CLI
 * (`bench/assistant/scriptedHarness.mjs`; no AI provider is called):
 * the island finds the harness, a prompt makes the agent call the API
 * through the MCP server, bodies appear, the agent renders and checks the
 * part, the whole turn undoes with one Ctrl+Z, deleting the user's work
 * waits for Approve/Deny, the session is saved with the project, and the
 * Skills tab lists the built-in skills. Screenshots go to
 * `ASSEMBLER_SHOTS_DIR` (default: a temp directory).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _electron as electron, type Page } from 'playwright-core';

import { closeApp } from './closeApp.js';
import { dismissHome } from './home.js';

const APP_DIR = process.cwd();
const SHOTS_DIR = process.env.ASSEMBLER_SHOTS_DIR ?? join(tmpdir(), 'assembler-assistant-shots');
const HARNESS = join(APP_DIR, 'bench', 'assistant', 'scriptedHarness.mjs');

interface Status {
  url: string;
  token: string;
}
type Json = Record<string, unknown>;

async function rpc(status: Status, method: string, params: Json = {}): Promise<Json> {
  const response = await fetch(status.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${status.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: Json; error?: unknown };
  if (!body.result) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function featureCount(status: Status): Promise<number> {
  return Number((await rpc(status, 'document.get')).featureCount);
}

async function send(window: Page, prompt: string): Promise<void> {
  const field = window.getByLabel('Agent prompt');
  await field.fill(prompt);
  await field.press('Control+Enter');
}

void test('assistant: scripted harness builds a part through the API, one undo step, approvals, skills', async (t) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'assembler-assistant-'));
  mkdirSync(SHOTS_DIR, { recursive: true });
  const app = await electron.launch({
    args: [APP_DIR, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ASSEMBLER_FORCE_PRODUCTION: '1',
      ASSEMBLER_ASSISTANT_TEST_HARNESS: HARNESS,
    },
    timeout: 60_000,
  });
  t.after(async () => {
    await closeApp(app);
    rmSync(userDataDir, { recursive: true, force: true });
  });
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1600, height: 1000 }).catch(() => undefined);
  await window.waitForLoadState('domcontentloaded');
  await window.waitForFunction(() => !document.body.innerText.includes('No items yet'), {
    timeout: 60_000,
  });
  await dismissHome(window);

  // Agent Access only to observe the document from the test (the assistant does not need it).
  const status = (await window.evaluate(() =>
    (
      globalThis as unknown as {
        assembler: { automation: { setEnabled(on: boolean): Promise<Status> } };
      }
    ).assembler.automation.setEnabled(true),
  )) as Status;
  const initialFeatures = await featureCount(status);

  // Open the island from the left dock; the scripted harness is found as "claude".
  await window.getByRole('button', { name: 'Assistant', exact: true }).click();
  const island = window.getByTestId('assistant-island');
  await island.waitFor();
  await island.getByRole('button', { name: /^claude, available/ }).waitFor({ timeout: 30_000 });
  await island.getByText(/Describe the part you need/).waitFor();
  await window.screenshot({ path: join(SHOTS_DIR, 'island-empty.png') });

  // A turn: skills, sketch, extrude, fillet, render, printability — bodies appear.
  await send(window, 'Please build the scripted test plate.');
  await island.getByText(/Built Plate: 60 x 40 x 6 mm/).waitFor({ timeout: 120_000 });
  await island.getByText(/one undo step/).waitFor({ timeout: 30_000 });
  assert.equal(await featureCount(status), initialFeatures + 3);
  const bodies = (await rpc(status, 'bodies.list')) as unknown as {
    name: string;
    bbox: { size: number[] };
  }[];
  const plate = bodies.find((b) => b.name === 'Plate');
  assert.ok(plate, 'the agent created the Plate body');
  assert.deepEqual(plate.bbox.size, [60, 40, 6]);
  await island.locator('img[alt="view.render result"]').first().waitFor({ timeout: 30_000 });
  await window.screenshot({ path: join(SHOTS_DIR, 'island-session.png') });

  // The whole turn is one undo step (the app's own Ctrl+Z, focus on the model).
  await window.getByRole('button', { name: 'Hide assistant' }).click();
  await window.mouse.click(800, 600);
  await window.keyboard.press('Control+z');
  for (let i = 0; i < 50 && (await featureCount(status)) !== initialFeatures; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await featureCount(status), initialFeatures, 'one Ctrl+Z removed the whole turn');
  await window.keyboard.press('Control+Shift+z');
  for (let i = 0; i < 50 && (await featureCount(status)) !== initialFeatures + 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Deleting a step the user had: the app asks; Deny leaves the document as it was.
  await window.getByRole('button', { name: 'Assistant', exact: true }).click();
  const before = await featureCount(status);
  await send(window, 'Run the scripted delete test.');
  const approval = window.getByRole('region', { name: 'Pending agent approval' });
  await approval.waitFor({ timeout: 60_000 });
  await window.screenshot({ path: join(SHOTS_DIR, 'island-approval.png') });
  await approval.getByRole('button', { name: 'Deny' }).click();
  await island.getByText(/Asked to delete the first step/).waitFor({ timeout: 60_000 });
  assert.equal(await featureCount(status), before, 'denied: nothing deleted');

  // The conversation is part of the project file.
  const saved = await rpc(status, 'project.save', {});
  const text = typeof saved.text === 'string' ? saved.text : JSON.stringify(saved);
  assert.match(text, /assistantSessions/);

  // Skills tab: built-in workflows, read-only.
  await island.getByRole('tab', { name: 'Skills' }).click();
  await island.getByRole('button', { name: /Design a printable part/ }).click();
  await island
    .getByText(/acceptance rules/)
    .first()
    .waitFor();
  await window.screenshot({ path: join(SHOTS_DIR, 'island-skills.png') });

  // view.render in the app: the GPU renderer of the mounted viewport.
  const gpu = await rpc(status, 'view.render', {
    view: 'iso',
    overlay: ['printFindings'],
    width: 800,
    height: 600,
  });
  assert.equal(gpu.renderer, 'gpu');
  writeFileSync(join(SHOTS_DIR, 'render-gpu.png'), Buffer.from(String(gpu.data), 'base64'));
  const software = await rpc(status, 'view.render', {
    view: 'iso',
    renderer: 'software',
    width: 800,
    height: 600,
  });
  writeFileSync(
    join(SHOTS_DIR, 'render-software.png'),
    Buffer.from(String(software.data), 'base64'),
  );
  assert.equal(software.renderer, 'software');
});
