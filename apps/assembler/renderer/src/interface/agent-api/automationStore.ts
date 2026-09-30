/**
 * Renderer state of "Agent access" — the opt-in local endpoint through which
 * agents and the Python SDK drive the open document (`electron/
 * automationServer.ts`). The UI shows a persistent indicator while it is on
 * (`chrome/AgentAccessIndicator.tsx`).
 */
import { create } from 'zustand';

import type { KernelAdapter } from '../../foundation/geometry-kernel/adapter.js';
import { projectPersistence } from '../../foundation/document/projectPersistence.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';
import { agentPrintability, usePrintStore } from '../../modules/print/printStore.js';
import { handleJsonRpcText } from './jsonRpc.js';
import { APP_CAPABILITIES, AgentSession, type SessionHost } from './session.js';

export interface AutomationState {
  /** `true` in the desktop app (the endpoint needs the Electron main process). */
  available: boolean;
  enabled: boolean;
  url: string | null;
  token: string | null;
  busy: boolean;
  requestCount: number;
  lastMethod: string | null;
  error: string | null;
  setEnabled: (enabled: boolean) => Promise<void>;
  /** Connection details to hand to an agent (JSON with `url` and `token`). */
  connectionText: () => string | null;
}

function api() {
  return typeof window !== 'undefined' ? window.assembler?.automation : undefined;
}

export const useAutomationStore = create<AutomationState>((set, get) => ({
  available: api() !== undefined,
  enabled: false,
  url: null,
  token: null,
  busy: false,
  requestCount: 0,
  lastMethod: null,
  error: null,
  setEnabled: async (enabled) => {
    const automation = api();
    if (!automation) return;
    set({ busy: true, error: null });
    try {
      const status = await automation.setEnabled(enabled);
      set({ enabled: status.enabled, url: status.url, token: status.token });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ busy: false });
    }
  },
  connectionText: () => {
    const { url, token, enabled } = get();
    return enabled && url && token ? JSON.stringify({ url, token }) : null;
  },
}));

function methodOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { method?: unknown };
    return typeof parsed.method === 'string' ? parsed.method : null;
  } catch {
    return null;
  }
}

/** The app's side of an agent session: unsaved-work guard and project open/new/save. */
export function appSessionHost(): SessionHost {
  // The shell's project lifecycle (`foundation/document/projectPersistence.ts`); without a
  // shell the session works on the bare document.
  const project = projectPersistence();
  return {
    server: 'app',
    capabilities: APP_CAPABILITIES,
    ...(project
      ? {
          // The project's dirty flag (features, Items, saved views, pins, reference meshes
          // since the last New/Open/Save; tracked from startup).
          hasUnsavedChanges: () => project.hasUnsavedChanges(),
          // Open/New/Save go through the app's project handling, like the File menu.
          project: {
            open: (text) => project.open(text),
            newProject: (name) => project.newProject(name),
            text: (projectName) => project.text(projectName),
          },
        }
      : {}),
    // Printability queries run in the print worker; defaults are the user's panel settings.
    printability: agentPrintability,
    printSettings: () => usePrintStore.getState().settings,
  };
}

/**
 * Connects forwarded endpoint requests to one {@link AgentSession} on the
 * app's store and kernel. Safe to call when not in Electron (no-op).
 */
export function installAutomationBridge(kernel: KernelAdapter): () => void {
  const automation = api();
  if (!automation) return () => undefined;
  const session = new AgentSession({
    store: useAssemblerStore,
    kernel,
    host: appSessionHost(),
  });
  void automation.status().then((status) =>
    useAutomationStore.setState({
      enabled: status.enabled,
      url: status.url,
      token: status.token,
    }),
  );
  const off = automation.onRequest((id, body) => {
    useAutomationStore.setState((s) => ({
      requestCount: s.requestCount + 1,
      lastMethod: methodOf(body),
    }));
    void handleJsonRpcText(session, body).then((response) =>
      automation.respond(id, response ? JSON.stringify(response) : ''),
    );
  });
  return () => {
    off();
    session.dispose();
  };
}
