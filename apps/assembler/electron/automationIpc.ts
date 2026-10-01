/**
 * Main-process side of the in-app agent endpoint: the UI toggles the
 * loopback server (`automationServer.ts`) through IPC, and every accepted
 * request body is forwarded to the renderer, whose canonical command layer
 * (`renderer/src/interface/agent-api/`) executes it on the live document. The main process
 * never interprets commands itself, so the endpoint cannot bypass the
 * renderer's validation, undo stack or the "UI tool active" rule.
 */
import { randomUUID } from 'node:crypto';

import { type BrowserWindow, ipcMain } from 'electron';

import { AutomationServer } from './automationServer';

/** Upper bound for one command (kernel operations are bounded; this guards a hung renderer). */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface AutomationStatus {
  enabled: boolean;
  url: string | null;
  port: number | null;
  token: string | null;
}

interface Pending {
  resolve: (body: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

let getWindow: () => BrowserWindow | null = () => null;
const pending = new Map<string, Pending>();

const server = new AutomationServer(
  (body) =>
    new Promise<string | null>((resolve, reject) => {
      const win = getWindow();
      if (!win || win.isDestroyed()) {
        reject(new Error('The Assembler window is not available'));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The command did not complete in time'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      win.webContents.send('assembler:automation:request', id, body);
    }),
);

function status(): AutomationStatus {
  const info = server.endpoint;
  return {
    enabled: info !== null,
    url: info?.url ?? null,
    port: info?.port ?? null,
    token: info?.token ?? null,
  };
}

let registered = false;

/** Registers the IPC handlers once; `windowGetter` names the window that executes commands. */
export function registerAutomation(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;
  if (registered) return;
  registered = true;
  ipcMain.handle('assembler:automation:status', () => status());
  ipcMain.handle('assembler:automation:setEnabled', async (_event, enabled: unknown) => {
    if (enabled === true) await server.start();
    else await stopAutomation();
    return status();
  });
  ipcMain.handle('assembler:automation:respond', (_event, id: unknown, body: unknown) => {
    if (typeof id !== 'string') return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(typeof body === 'string' && body !== '' ? body : null);
  });
}

/** Closes the endpoint (window closed or the user turned agent access off). */
export async function stopAutomation(): Promise<void> {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.resolve(null);
    pending.delete(id);
  }
  await server.stop();
}
