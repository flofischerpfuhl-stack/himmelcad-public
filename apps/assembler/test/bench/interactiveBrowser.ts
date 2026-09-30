/**
 * Browser half of the interactive-latency harness (`bench:interactive --
 * --browser`): starts the Vite dev server of the app on a free port,
 * replays scenarios (a) text + engrave and (b) M4 counterbore hole in
 * Chromium through the real UI (shortcuts, command search, tool panel,
 * clicks at world points via the DEV hook `window.__assembler`), with the
 * CAD kernel and the sketch solver in their Web Workers, and reports per
 * step: wall time until the kernel/solver are idle and the frame is drawn,
 * main-thread long-task time (the UI column: what blocks input), and the
 * kernel time the worker reports for the evaluation shown.
 *
 * Chromium: `ASM_CHROME` or the Playwright Chromium on this host.
 * `ASM_PROFILE=1` prints the top main-thread functions per step (CDP
 * sampling profiler).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type CDPSession, type Page } from 'playwright-core';

import { createDemoDocument } from '../../renderer/src/model/document.js';
import type { StepRow } from './interactiveBench.js';
import { sixtyEntitySketch } from './parts.js';

const DEFAULT_CHROME =
  'C:\\Users\\flori\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe';

/** apps/assembler (the compiled file lives in .build/tests/apps/assembler/test/bench). */
function appDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../../../..');
}

async function startVite(port: number): Promise<ChildProcess> {
  const require = createRequire(import.meta.url);
  const viteBin = resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  const child = spawn(
    process.execPath,
    [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: appDir(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite did not start within 120 s')), 120000);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (/ready in/i.test(chunk.toString())) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.on('exit', (code) => reject(new Error(`Vite exited (${code})`)));
  });
  return child;
}

function stopTree(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- page-side code talks to the untyped DEV hook (rest of the file) */
type Hook = any;
const hook = (): Hook => (window as any).__assembler;

/** Waits until solver and kernel are idle and the frame is drawn; returns that page time. */
async function idle(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const a = (window as any).__assembler;
    await a.waitForSketchIdle();
    await a.waitForKernelIdle();
    return performance.now();
  });
}

/** Marks a store action driven through the DEV hook as the step's input (no DOM event). */
function markInput(): void {
  (window as any).__lastInput = performance.now();
}

interface Profiled {
  cdp: CDPSession;
  print: boolean;
}

function summarizeProfile(profile: any): string {
  const nodes = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const total = new Map<string, number>();
  const dts: number[] = profile.timeDeltas;
  const name = (x: any) =>
    `${x.callFrame.functionName || '(anon)'} ${String(x.callFrame.url).split('/').pop()}:${x.callFrame.lineNumber + 1}`;
  profile.samples.forEach((id: number, i: number) => {
    const dt = (dts[i + 1] ?? 0) / 1000;
    const seen = new Set<string>();
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const k = name(nodes.get(cur));
      if (seen.has(k)) continue;
      seen.add(k);
      total.set(k, (total.get(k) ?? 0) + dt);
    }
  });
  return [...total.entries()]
    .filter(([k]) => !/^\((idle|program|root)\)/.test(k) && !/react-dom|react_jsx|^run :0/.test(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, v]) => `    ${v.toFixed(0).padStart(6)} ms  ${k}`)
    .join('\n');
}

async function measure(
  page: Page,
  profiled: Profiled,
  scenario: string,
  label: string,
  run: () => Promise<void>,
): Promise<StepRow> {
  // Evaluations already on screen: a step that shows one of them evaluated nothing.
  const stepStart = await page.evaluate(() => {
    const s = (window as any).__assembler.store.getState();
    (window as any).__longTasks = [];
    (window as any).__lastInput = null;
    (window as any).__frameAfterChange = null;
    (window as any).__benchSeen = new Set([s.evaluation, s.activeTool?.previewEvaluation]);
    return performance.now();
  });
  if (profiled.print) await profiled.cdp.send('Profiler.start');
  try {
    await run();
  } catch (error) {
    if (process.env.ASM_SHOT) await page.screenshot({ path: process.env.ASM_SHOT });
    throw error;
  }
  const settledAt = await idle(page);
  // Response latency: from the step's last input (key, pointer, or hook-driven action) to the
  // animation frame after the last store change it caused (the frame that shows the result) —
  // Playwright's own overhead and the idle-wait's extra frames excluded.
  const marks = await page.evaluate(() => ({
    input: (window as any).__lastInput as number | null,
    frame: (window as any).__frameAfterChange as number | null,
  }));
  const from = marks.input ?? stepStart;
  const wallMs = (marks.frame !== null && marks.frame >= from ? marks.frame : settledAt) - from;
  if (profiled.print) {
    const { profile } = (await profiled.cdp.send('Profiler.stop')) as any;
    console.log(
      `  ${scenario} / ${label}: main-thread functions (total)\n${summarizeProfile(profile)}`,
    );
  }
  const info = await page.evaluate(() => {
    const a = (window as any).__assembler;
    const s = a.store.getState();
    const shown = s.activeTool?.previewEvaluation ?? s.evaluation;
    const fresh = !(window as any).__benchSeen.has(shown);
    const long = (window as any).__longTasks as { ms: number }[];
    return {
      longMs: long.reduce((acc, t) => acc + t.ms, 0),
      stats: fresh ? shown.stats : null,
    };
  });
  const stats = info.stats as {
    modelMs: number;
    tessellateMs: number;
    reusedFeatures?: number;
    evaluatedFeatures?: number;
  } | null;
  return {
    scenario,
    step: label,
    wallMs,
    uiMs: info.longMs,
    solverMs: NaN,
    regionsMs: NaN,
    kernelMs: stats ? stats.modelMs + stats.tessellateMs : 0,
    featureMs: NaN,
    validityMs: NaN,
    namingMs: NaN,
    tessellateMs: stats ? stats.tessellateMs : 0,
    reused: stats?.reusedFeatures ?? 0,
    evaluated: stats?.evaluatedFeatures ?? 0,
    printMs: null,
  };
}

async function openApp(page: Page, url: string): Promise<void> {
  // The first load after a cold Vite start may re-optimise dependencies and reload.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => hook()?.store.getState().kernelStatus === 'ready', null, {
        timeout: 120000,
      });
      await page.waitForTimeout(1500);
      await page.waitForFunction(() => hook()?.store.getState().kernelStatus === 'ready', null, {
        timeout: 120000,
      });
      await page.evaluate(() => {
        hook().preferences.getState().setPreference('animateCamera', false);
        // The frame after the latest document/sketch store change: when a result is shown.
        const onChange = () => {
          requestAnimationFrame(() => {
            (window as any).__frameAfterChange = performance.now();
          });
        };
        hook().store.subscribe(onChange);
        hook().sketchStore.subscribe(onChange);
      });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

async function scenarioText(page: Page, p: Profiled): Promise<StepRow[]> {
  const s = 'a text + engrave';
  const rows: StepRow[] = [];
  await page.evaluate(() => hook().projectStore.getState().newFromTemplate('enclosure'));
  await idle(page);
  await page.evaluate(() => hook().store.getState().requestCamera('iso'));
  await idle(page);
  const lid = await page.evaluate(() => {
    const a = hook();
    const id = a.bodies().find((b: { name: string }) => b.name === 'Lid').id;
    const faces = a
      .faces(id)
      .filter((f: { normal: number[] | null }) => f.normal && f.normal[2]! > 0.99)
      .sort(
        (x: { centroid: number[] }, y: { centroid: number[] }) => y.centroid[2]! - x.centroid[2]!,
      );
    return { id: id as string, key: faces[0].faceKey as string, centroid: faces[0].centroid };
  });
  rows.push(
    await measure(page, p, s, 'select lid top face', async () => {
      await page.evaluate(({ id, key }) => {
        markInput();
        hook().store.getState().select({ kind: 'face', bodyId: id, faceKey: key });
      }, lid);
    }),
  );
  rows.push(
    await measure(page, p, s, 'Text tool on the face (K)', async () => {
      await page.mouse.move(700, 450);
      await page.keyboard.press('k');
    }),
  );
  rows.push(
    await measure(page, p, s, 'click the text anchor', async () => {
      const at = await page.evaluate((c) => hook().project(c), lid.centroid);
      await page.mouse.move(at.x, at.y, { steps: 4 });
      await page.mouse.click(at.x, at.y);
    }),
  );
  rows.push(
    await measure(page, p, s, 'type height 9 and "HC"', async () => {
      await page.getByLabel('Text height').fill('9');
      await page.getByLabel('Text height').press('Enter');
      await page.getByLabel('Text content').fill('HC');
    }),
  );
  // Timed from the Enter that places the text until it is solved and drawn.
  rows.push(
    await measure(page, p, s, 'place text "HC" (Enter → solved)', async () => {
      await page.keyboard.press('Enter');
    }),
  );
  rows.push(
    await measure(page, p, s, 'pointer moves over the text ×10', async () => {
      const at = await page.evaluate((c) => hook().project(c), lid.centroid);
      for (let i = 0; i < 10; i += 1) await page.mouse.move(at.x + i * 4, at.y + i * 2);
    }),
  );
  const sketchId = await page.evaluate(() => hook().sketchSession()?.featureId as string);
  rows.push(
    await measure(page, p, s, 'leave the sketch (Esc)', async () => {
      for (let i = 0; i < 5; i += 1) {
        if (!(await page.evaluate(() => !!hook().sketchStore.getState().session))) break;
        await page.keyboard.press('Escape');
        await idle(page);
      }
    }),
  );
  rows.push(
    await measure(page, p, s, 'select profile + face', async () => {
      await page.evaluate(
        ({ sketchId, id }) => {
          const a = hook();
          const faces = a
            .faces(id)
            .filter((f: { normal: number[] | null }) => f.normal && f.normal[2]! > 0.99)
            .sort(
              (x: { centroid: number[] }, y: { centroid: number[] }) =>
                y.centroid[2]! - x.centroid[2]!,
            );
          const st = a.store.getState();
          markInput();
          st.select({ kind: 'sketchProfile', featureId: sketchId });
          st.select({ kind: 'face', bodyId: id, faceKey: faces[0].faceKey }, { additive: true });
        },
        { sketchId, id: lid.id },
      );
    }),
  );
  rows.push(
    await measure(page, p, s, 'Emboss tool (preview +1 mm)', async () => {
      await page.keyboard.press('Control+f');
      await page.keyboard.type('Emboss');
      await page.keyboard.press('Enter');
    }),
  );
  rows.push(
    await measure(page, p, s, 'Engrave preview (-1 mm)', async () => {
      await page.getByRole('radio', { name: 'Engrave', exact: true }).first().click();
    }),
  );
  rows.push(
    await measure(page, p, s, 'Engrave commit (Done)', async () => {
      await page.getByRole('button', { name: 'Commit tool' }).click();
    }),
  );
  return rows;
}

async function scenarioHole(page: Page, p: Profiled): Promise<StepRow[]> {
  const s = 'b hole M4 cbore';
  const rows: StepRow[] = [];
  await page.evaluate(() => hook().projectStore.getState().newFromTemplate('enclosure'));
  await idle(page);
  const enclosure = await page.evaluate(() => {
    const a = hook();
    const id = a.bodies().find((b: { name: string }) => b.name === 'Enclosure').id as string;
    const floor = a
      .faces(id)
      .find((f: { normal: number[] | null }) => f.normal && f.normal[2]! < -0.99).faceKey as string;
    a.workspaceStore.getState().sendCamera({ kind: 'direction', direction: [0.3, -0.9, -1.4] });
    a.workspaceStore.getState().sendCamera({ kind: 'fitAll' });
    return { id, floor };
  });
  await idle(page);
  rows.push(
    await measure(page, p, s, 'select floor face', async () => {
      await page.evaluate(({ id, floor }) => {
        markInput();
        hook().store.getState().select({ kind: 'face', bodyId: id, faceKey: floor });
      }, enclosure);
    }),
  );
  rows.push(
    await measure(page, p, s, 'Hole tool (preview at the centre)', async () => {
      await page.mouse.move(700, 450);
      await page.keyboard.press('Control+f');
      await page.keyboard.type('Hole');
      await page.keyboard.press('Enter');
    }),
  );
  rows.push(
    await measure(page, p, s, 'click a position (preview)', async () => {
      const at = await page.evaluate(() => hook().project([40, 30, 0]));
      await page.mouse.move(at.x, at.y, { steps: 4 });
      await page.mouse.click(at.x, at.y);
    }),
  );
  rows.push(
    await measure(page, p, s, 'size M4 (preview)', async () => {
      // Right after a viewport click the first click on the menu button does not open it
      // (reported to the UI lane); click until it is expanded.
      const size = page.getByRole('button', { name: 'Hole size', exact: true }).first();
      for (let i = 0; i < 3 && (await size.getAttribute('aria-expanded')) !== 'true'; i += 1) {
        await size.click();
      }
      await page.getByRole('option', { name: 'M4', exact: true }).first().click();
    }),
  );
  rows.push(
    await measure(page, p, s, 'counterbore (preview)', async () => {
      await page.getByRole('radio', { name: 'Counterbore', exact: true }).first().click();
    }),
  );
  rows.push(
    await measure(page, p, s, 'Hole commit (Done)', async () => {
      await page.getByRole('button', { name: 'Commit tool' }).click();
    }),
  );
  return rows;
}

/** (c) fillet drag on the demo bracket, driven through the store (as the drag handle does). */
async function scenarioFillet(page: Page, p: Profiled, steps: number): Promise<StepRow[]> {
  const s = 'c fillet drag';
  const rows: StepRow[] = [];
  await page.evaluate((features) => {
    const st = hook().store.getState();
    st.cancel();
    st.loadDocument(features);
  }, createDemoDocument());
  await idle(page);
  const edge = await page.evaluate(() => {
    const a = hook();
    const id = a.bodies()[0].id as string;
    const e = a
      .edges(id)
      .find(
        (x: { curve: string; midpoint: number[] }) =>
          x.curve === 'line' &&
          Math.abs(x.midpoint[2]! - 6) < 1e-6 &&
          Math.abs(x.midpoint[1]!) < 1e-6,
      );
    a.store.getState().select({ kind: 'edge', bodyId: id, edgeKey: e.edgeKey });
    return true;
  });
  if (!edge) throw new Error('no plate edge on the demo bracket');
  rows.push(
    await measure(page, p, s, 'Fillet tool (first preview)', async () => {
      await page.evaluate(() => {
        markInput();
        hook().store.getState().beginEdgeBlend('fillet');
      });
    }),
  );
  for (let i = 0; i < steps; i += 1) {
    rows.push(
      await measure(page, p, s, 'drag step (preview)', async () => {
        await page.evaluate(
          (r) => {
            markInput();
            hook().store.getState().setBlendSize(r);
          },
          1 + i * 0.137,
        );
      }),
    );
  }
  await page.evaluate(() => hook().store.getState().cancel());
  await idle(page);
  return rows;
}

/** (d) dragging one point of a 60-entity sketch (solver in its worker). */
async function scenarioSketchDrag(page: Page, p: Profiled, steps: number): Promise<StepRow[]> {
  const s = 'd 60-entity drag';
  const rows: StepRow[] = [];
  const { feature, corner, start } = sixtyEntitySketch();
  await page.evaluate((f) => {
    const st = hook().store.getState();
    st.cancel();
    st.loadDocument([f]);
  }, feature);
  await idle(page);
  rows.push(
    await measure(page, p, s, 'open the sketch (analysis)', async () => {
      await page.evaluate((id) => {
        markInput();
        hook().sketchStore.getState().begin({ featureId: id });
      }, feature.id);
    }),
  );
  await page.evaluate((id) => hook().sketchStore.getState().beginDrag([id]), corner);
  for (let i = 1; i <= steps; i += 1) {
    rows.push(
      await measure(page, p, s, 'drag step (solve)', async () => {
        await page.evaluate(
          (target) => {
            markInput();
            hook().sketchStore.getState().drag([target]);
          },
          [start[0] + i * 0.31, start[1] + i * 0.17],
        );
      }),
    );
  }
  rows.push(
    await measure(page, p, s, 'drop (commit + analysis)', async () => {
      await page.evaluate(() => {
        markInput();
        return hook().sketchStore.getState().endDrag();
      });
    }),
  );
  await page.evaluate(() => hook().sketchStore.getState().discard());
  return rows;
}

function medianOf(values: number[]): number {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return NaN;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[mid]! : (finite[mid - 1]! + finite[mid]!) / 2;
}

export async function runBrowserBench(options: { runs: number }): Promise<StepRow[]> {
  const port = Number(process.env.ASM_BENCH_PORT ?? 5239);
  const vite = await startVite(port);
  const browser = await chromium.launch({
    executablePath: process.env.ASM_CHROME ?? DEFAULT_CHROME,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error) => console.error('page error:', error.message));
    await page.addInitScript(() => {
      const w = window as unknown as {
        __longTasks: { ms: number }[];
        __lastInput: number | null;
        hook: () => unknown;
        markInput: () => void;
      };
      // Page-side twins of `hook()` / `markInput()` (page functions are serialized: module
      // scope is not there).
      w.hook = () => (window as unknown as { __assembler: unknown }).__assembler;
      w.markInput = () => {
        w.__lastInput = performance.now();
      };
      for (const type of ['keydown', 'pointerdown', 'click']) {
        window.addEventListener(type, () => w.markInput(), { capture: true });
      }
      w.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push({ ms: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    });
    await openApp(page, `http://127.0.0.1:${port}/`);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    const profiled: Profiled = { cdp, print: !!process.env.ASM_PROFILE };
    // Warm-up run (JIT, lazy chunks, fonts), then measured runs.
    await scenarioText(page, { cdp, print: false });
    await scenarioHole(page, { cdp, print: false });
    const runs: StepRow[][] = [];
    for (let i = 0; i < options.runs; i += 1) {
      runs.push([
        ...(await scenarioText(page, i === 0 ? profiled : { cdp, print: false })),
        ...(await scenarioHole(page, i === 0 ? profiled : { cdp, print: false })),
      ]);
    }
    const perRun = runs[0]!.map((row, index) => {
      const same = runs.map((run) => run[index]!);
      const m = (pick: (r: StepRow) => number) => medianOf(same.map(pick));
      return {
        ...row,
        wallMs: m((r) => r.wallMs),
        uiMs: m((r) => r.uiMs),
        kernelMs: m((r) => r.kernelMs),
        tessellateMs: m((r) => r.tessellateMs),
        reused: m((r) => r.reused),
        evaluated: m((r) => r.evaluated),
      };
    });
    // Drags: the median over all steps (one row per step label).
    const drags = [
      ...(await scenarioFillet(page, profiled, 10)),
      ...(await scenarioSketchDrag(page, profiled, 30)),
    ];
    const byLabel = new Map<string, StepRow[]>();
    for (const row of drags) {
      const key = `${row.scenario}\u0000${row.step}`;
      byLabel.set(key, [...(byLabel.get(key) ?? []), row]);
    }
    const dragRows = [...byLabel.values()].map((same) => {
      const m = (pick: (r: StepRow) => number) => medianOf(same.map(pick));
      return {
        ...same[0]!,
        step: same.length > 1 ? `${same[0]!.step} ×${same.length}` : same[0]!.step,
        wallMs: m((r) => r.wallMs),
        uiMs: m((r) => r.uiMs),
        kernelMs: m((r) => r.kernelMs),
        tessellateMs: m((r) => r.tessellateMs),
        reused: m((r) => r.reused),
        evaluated: m((r) => r.evaluated),
      };
    });
    return [...perRun, ...dragRows];
  } finally {
    await browser.close();
    stopTree(vite);
  }
}
