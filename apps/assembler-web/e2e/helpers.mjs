/**
 * Shared steps of the web e2e tests (playwright-core against the built site
 * served by `scripts/serve.mjs`). Like the desktop e2e tests, they use only
 * what a user or an agent has: the UI and the in-page agent API — no
 * dev-only hooks (the production build has none).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Chromium: `ASM_CHROME`, else a locally installed Playwright Chromium (no
 * download), else playwright-core's own. Revision 1234 (Chromium 151) first:
 * it is the newest one playwright-core 1.61 (built for 149) drives
 * reliably here; with revision 1243 (Chromium 153) the page object closes
 * when a file handle is stored in IndexedDB (assembler/WEB.md).
 */
export function chromiumPath() {
  if (process.env.ASM_CHROME) return process.env.ASM_CHROME;
  if (process.platform !== 'win32') return undefined;
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  for (const revision of ['1234', '1243', '1228']) {
    const candidate = join(root, `chromium-${revision}`, 'chrome-win64', 'chrome.exe');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export const SHOTS_DIR =
  process.env.ASSEMBLER_SHOTS_DIR ??
  (process.platform === 'win32'
    ? 'D:\\AgentWork\\HimmelCAD-Assembler\\shots\\block8-web'
    : join(tmpdir(), 'assembler-web-shots'));
mkdirSync(SHOTS_DIR, { recursive: true });

export const shot = (page, name) => page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) });

/** Collects page errors so a test can fail on them with context. */
export function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/**
 * Waits until the app is usable: the Home screen is up (started without a
 * file), and — after Escape — the start document's body is listed, which
 * needs the kernel loaded and the first evaluation done.
 */
export async function waitForModel(
  page,
  { dismissHome = true, items = true, timeout = 120_000 } = {},
) {
  if (dismissHome) {
    await page.locator('[data-home-screen]').waitFor({ timeout });
    await page.keyboard.press('Escape');
    await page.locator('[data-home-screen]').waitFor({ state: 'detached' });
  }
  // `items: false` where the Items panel starts closed (phone-sized windows).
  await page.waitForFunction(
    (withItems) =>
      document.querySelector('canvas') !== null &&
      (!withItems || document.body.innerText.includes('Items')) &&
      !document.body.innerText.includes('No items yet') &&
      !Array.from(document.querySelectorAll('[role="status"]')).some((el) =>
        /loading cad kernel|kernel failed/i.test(el.textContent ?? ''),
      ),
    items,
    { timeout },
  );
}

/** Turns Agent Access on through command search, as a user does; returns an RPC caller on the in-page API. */
export async function agentAccess(page) {
  await page.keyboard.press('Control+f');
  const search = page.getByPlaceholder(/Search commands/);
  await search.fill('agent access');
  await page
    .getByRole('option', { name: /Agent Access/ })
    .first()
    .waitFor();
  await search.press('Enter');
  await page.getByText('Agent access on').waitFor({ timeout: 15_000 });
  return async (method, params = {}) => {
    const response = await page.evaluate(
      ([m, p]) =>
        window.himmelcadAssembler.agent.request({ jsonrpc: '2.0', id: 1, method: m, params: p }),
      [method, params],
    );
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  };
}

/** Runs a command by its label through command search (Ctrl+F). */
export async function runCommand(page, label) {
  await page.keyboard.press('Control+f');
  const search = page.getByPlaceholder(/Search commands/);
  await search.fill(label);
  await page.getByRole('option', { name: label }).first().waitFor();
  await search.press('Enter');
}

export async function waitFor(read, ok, what, { tries = 120, delay = 250 } = {}) {
  let value = await read();
  for (let i = 0; i < tries && !ok(value); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    value = await read();
  }
  assert.ok(ok(value), `${what}: ${JSON.stringify(value)}`);
  return value;
}

/** Names of the view cube faces currently shown (front-facing), sorted. */
const visibleCubeFaces = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-face][data-visible="true"]'))
      .map((el) => el.getAttribute('data-face'))
      .sort(),
  );

async function waitForCubeFaces(page, count, what) {
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-face][data-visible="true"]').length === n,
    count,
    { timeout: 15_000 },
  );
  // The camera animation ends on the final pose; give it a moment to settle.
  await page.waitForTimeout(600);
  const faces = await visibleCubeFaces(page);
  assert.equal(faces.length, count, `${what}: ${faces.join(', ')}`);
  return faces;
}

/**
 * The view cube renders as a cube and orients the view in this engine: the
 * shown faces are drawn where they are hit-tested, form one solid outline
 * (not a single flattened face), and clicking a face, a corner and an edge
 * gives a face-on view (1 face), an isometric view (3) and an edge view (2).
 * Leaves the camera in an edge view.
 */
export async function checkViewCube(page, name) {
  const faces = await visibleCubeFaces(page);
  assert.ok(faces.length >= 1 && faces.length <= 3, `${name}: visible faces ${faces.join(', ')}`);
  const boxes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-face][data-visible="true"]')).map((face) => {
      const cell = face.querySelector('[data-cell$=":0:0"]');
      const r = cell.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      return {
        face: face.getAttribute('data-face'),
        x,
        y,
        width: r.width,
        height: r.height,
        hit: document.elementFromPoint(x, y)?.getAttribute('data-cell') ?? null,
      };
    }),
  );
  for (const box of boxes) {
    assert.ok(
      box.width > 8 && box.height > 8,
      `${name}: ${box.face} is drawn (${box.width}x${box.height})`,
    );
    assert.equal(box.hit, `${box.face}:0:0`, `${name}: the ${box.face} label is where it is hit`);
  }
  const scene = await page.locator('[aria-label^="View cube"]').boundingBox();
  await page.screenshot({
    path: join(SHOTS_DIR, `w6-${name}-viewcube.png`),
    clip: { x: scene.x - 40, y: scene.y - 40, width: scene.width + 80, height: scene.height + 80 },
  });

  const first = faces[0];
  await page.locator(`[data-cell="${first}:0:0"]`).click();
  assert.deepEqual(await waitForCubeFaces(page, 1, `${name}: face click`), [first]);
  await page.getByRole('button', { name: 'Rotate view 90° clockwise' }).waitFor();
  await page.locator(`[data-cell="${first}:1:1"]`).click();
  await waitForCubeFaces(page, 3, `${name}: corner click`);
  await page.screenshot({
    path: join(SHOTS_DIR, `w6-${name}-viewcube-corner.png`),
    clip: { x: scene.x - 40, y: scene.y - 40, width: scene.width + 80, height: scene.height + 80 },
  });
  await page.locator(`[data-cell="${first}:0:1"]`).click();
  await waitForCubeFaces(page, 2, `${name}: edge click`);
}

/** Centre of the viewport canvas in page pixels. */
export const canvasCentre = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

/**
 * Sketch → extrude through the UI: R (rectangle, two corners) on the plane
 * the new sketch opens on, Escape, Enter (Finish: the sketch stays
 * selected), E, type the distance, Enter (preview), Enter (Done).
 */
export async function sketchAndExtrude(page, distance) {
  const c = await canvasCentre(page);
  await page.keyboard.press('r');
  await page.waitForSelector('[data-sketch-status]');
  await page.waitForTimeout(400);
  await page.mouse.click(c.x - 80, c.y - 50);
  await page.waitForTimeout(250);
  await page.mouse.click(c.x - 80, c.y - 50);
  await page.waitForTimeout(250);
  await page.mouse.click(c.x + 80, c.y + 50);
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('[data-sketch-status]'));
  await page.waitForTimeout(400);
  await page.keyboard.press('e');
  await page.getByText(/Drag the arrow or type a distance/).waitFor();
  await page.keyboard.type(String(distance));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
}
