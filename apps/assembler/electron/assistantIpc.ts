/**
 * Electron wiring of the embedded assistant: the harness host
 * (`assistantHost.ts`) behind IPC for the renderer's `@himmelcad/agent`
 * adapter, and the tool endpoint (`assistantTools.ts`) whose calls are
 * forwarded to the renderer and answered there. Only the main window's own
 * renderer may use these channels.
 */
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import { type BrowserWindow, type IpcMainInvokeEvent, app, ipcMain } from 'electron';

import { AssistantHarnessHost } from './assistantHost';
import { AssistantToolServer } from './assistantTools';

/** A tool call waits this long for the renderer (an approval may be pending). */
const TOOL_TIMEOUT_MS = 6 * 60_000;

let getWindow: () => BrowserWindow | null = () => null;
let host: AssistantHarnessHost | null = null;
let tools: AssistantToolServer | null = null;
const pendingTools = new Map<
  string,
  { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }
>();
const subscriptions = new Map<string, () => void>();
let registered = false;

function ownWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const win = getWindow();
  if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) {
    throw new Error('The assistant is only available to the Assembler window.');
  }
  return win;
}

/**
 * Test-only stand-in for the `claude` CLI: a scripted harness that never
 * calls a provider. Honoured only in unpackaged builds.
 */
function testHarness(): string | null {
  const path = process.env.ASSEMBLER_ASSISTANT_TEST_HARNESS;
  return path && !app.isPackaged ? resolve(path) : null;
}

export function registerAssistant(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;
  if (registered) return;
  registered = true;
  tools = new AssistantToolServer(
    (request) =>
      new Promise((resolvePromise, reject) => {
        const win = getWindow();
        if (!win || win.isDestroyed()) {
          reject(new Error('The Assembler window is not available.'));
          return;
        }
        const id = randomUUID();
        const timer = setTimeout(() => {
          pendingTools.delete(id);
          resolvePromise({
            content: [{ type: 'text', text: 'The app did not answer in time.' }],
            isError: true,
          });
        }, TOOL_TIMEOUT_MS);
        pendingTools.set(id, { resolve: resolvePromise, timer });
        win.webContents.send('assembler:assistant:tool', id, request);
      }),
  );
  const ready = tools.start();
  host = new AssistantHarnessHost({
    dataDir: join(app.getPath('userData'), 'assistant'),
    tools: {
      get url() {
        return tools!.url;
      },
      issue: (threadId) => tools!.issue(threadId),
      revoke: (token) => tools!.revoke(token),
    },
    nodeCommand: process.execPath,
    mcpServerScript: join(__dirname, 'assistantMcpServer.js'),
    testHarness: testHarness(),
  });

  ipcMain.handle('assembler:assistant:request', async (event, request: unknown) => {
    ownWindow(event);
    await ready;
    return host!.request(request);
  });
  ipcMain.handle('assembler:assistant:subscribe', (event, sessionId: unknown) => {
    const win = ownWindow(event);
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{48}$/u.test(sessionId)) {
      throw new Error('Invalid assistant session.');
    }
    subscriptions.get(sessionId)?.();
    const unsubscribe = host!.subscribe(sessionId, (payload) => {
      if (!win.isDestroyed()) win.webContents.send('assembler:assistant:event', sessionId, payload);
    });
    subscriptions.set(sessionId, unsubscribe);
    return true;
  });
  ipcMain.handle('assembler:assistant:unsubscribe', (event, sessionId: unknown) => {
    ownWindow(event);
    const unsubscribe = subscriptions.get(String(sessionId));
    unsubscribe?.();
    subscriptions.delete(String(sessionId));
    return Boolean(unsubscribe);
  });
  ipcMain.handle('assembler:assistant:toolResult', (event, id: unknown, result: unknown) => {
    ownWindow(event);
    if (typeof id !== 'string') return;
    const entry = pendingTools.get(id);
    if (!entry) return;
    pendingTools.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
  });
}

/** Window closed / app quit: stop every CLI and close the endpoint. */
export async function stopAssistant(): Promise<void> {
  for (const unsubscribe of subscriptions.values()) unsubscribe();
  subscriptions.clear();
  for (const [id, entry] of pendingTools) {
    clearTimeout(entry.timer);
    entry.resolve({ content: [{ type: 'text', text: 'The app window closed.' }], isError: true });
    pendingTools.delete(id);
  }
  await host?.close();
}
