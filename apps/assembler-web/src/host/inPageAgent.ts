/**
 * The web's agent transport: an in-page JavaScript API instead of the
 * desktop's loopback HTTP endpoint (a web page cannot listen on a socket).
 * While "Agent Access" is on, `window.himmelcadAssembler.agent.request(body)`
 * takes one `hcasm.agent-api@1` JSON-RPC request (text or object) and
 * resolves with the response object (`null` for a notification). It is the
 * same canonical command layer the desktop endpoint and the Python SDK use
 * (`interface/agent-api/automationStore.ts`), so browser automation
 * (Playwright, a browser extension the user installs, the devtools console)
 * drives the document exactly like the UI.
 *
 * Off on every start, like the desktop endpoint. No token: only code
 * running inside this page can reach the global, and the page's CSP admits
 * no script that is not part of the app. Documented in assembler/WEB.md.
 */
import type {
  HostAutomation,
  HostAutomationStatus,
} from '../../../assembler/renderer/src/foundation/host/index.js';

export const AGENT_GLOBAL = 'himmelcadAssembler';

export interface InPageAgentApi {
  readonly protocol: 'hcasm.agent-api@1';
  /** Sends one JSON-RPC request; resolves with the response (`null` for a notification). */
  request(body: string | object): Promise<unknown>;
}

interface AgentGlobal {
  readonly agent: InPageAgentApi;
}

type Listener = (id: string, body: string) => void;

export function createInPageAgent(): HostAutomation {
  let enabled = false;
  let counter = 0;
  const listeners = new Set<Listener>();
  const pending = new Map<string, (body: string) => void>();

  const status = (): HostAutomationStatus => ({
    enabled,
    url: enabled ? `window.${AGENT_GLOBAL}.agent` : null,
    port: null,
    token: null,
  });

  const api: InPageAgentApi = Object.freeze({
    protocol: 'hcasm.agent-api@1' as const,
    request: (body: string | object): Promise<unknown> => {
      if (!enabled) return Promise.reject(new Error('Agent access is off'));
      if (listeners.size === 0) return Promise.reject(new Error('The app is still starting'));
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      counter += 1;
      const id = `page-${counter}`;
      return new Promise<string>((resolve) => {
        pending.set(id, resolve);
        for (const listener of listeners) listener(id, text);
      }).then((response) => (response === '' ? null : (JSON.parse(response) as unknown)));
    },
  });

  const target = window as unknown as Record<string, AgentGlobal | undefined>;
  return {
    status: async () => status(),
    setEnabled: async (next) => {
      enabled = next;
      if (enabled) {
        Object.defineProperty(window, AGENT_GLOBAL, {
          value: Object.freeze({ agent: api }),
          configurable: true,
          enumerable: false,
          writable: false,
        });
      } else {
        delete target[AGENT_GLOBAL];
        // Requests still in flight are answered; new ones are refused.
      }
      return status();
    },
    onRequest: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    respond: async (id, body) => {
      const resolve = pending.get(id);
      pending.delete(id);
      resolve?.(body);
    },
  };
}
