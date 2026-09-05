import { contextBridge, ipcRenderer } from 'electron';
import type { AgentHarnessHostTransport } from '@himmelcad/agent/src/transport.js';
import type { ProviderCredentialRendererTransport } from '@himmelcad/agent/src/providerCredentials.js';
import type { AppJob, JobEvent, RegisterJobInput } from '@himmelcad/app';

export interface BuilderResidencyBootstrap {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly entries: readonly {
    readonly providerId: string;
    readonly providerVersion: string;
    readonly admission: unknown;
    readonly dataset: {
      readonly datasetId: string;
      readonly formatId: string;
      readonly metadataUrl: string;
    } | null;
  }[];
}

export interface StagedResidencyMaterialization {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly datasets: readonly {
    readonly datasetId: string;
    readonly formatId: string;
    readonly entityId: string;
    readonly representationSlot: string;
    readonly metadataUrl: string;
    readonly artifacts: readonly {
      readonly relativePath: string;
      readonly resourceId: string;
      readonly url: string;
    }[];
  }[];
  readonly resourceSets: readonly {
    readonly resourceSetId: string;
    readonly resources: readonly {
      readonly relativePath: string;
      readonly resourceId: string;
      readonly url: string;
    }[];
  }[];
}

export interface HimmelCADApi {
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly window: {
    minimize: () => Promise<void>;
    maximizeToggle: () => Promise<boolean>;
    close: () => Promise<void>;
    closeReady: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (cb: (m: boolean) => void) => () => void;
  };
  readonly sidecar: {
    status: () => Promise<boolean>;
    call: <T = unknown>(method: string, params?: unknown) => Promise<T>;
    onStderr: (cb: (line: string) => void) => () => void;
  };
  readonly jobs: {
    list: () => Promise<readonly AppJob[]>;
    get: (id: string) => Promise<AppJob>;
    register: (input: RegisterJobInput) => Promise<AppJob>;
    update: (
      id: string,
      patch: Partial<Pick<AppJob, 'phase' | 'fraction' | 'progressKey' | 'cancellation'>>,
    ) => Promise<AppJob>;
    needsInput: (id: string, phase?: string) => Promise<AppJob>;
    complete: (id: string, resultLabel?: string) => Promise<AppJob>;
    fail: (id: string, error: string) => Promise<AppJob>;
    cancelled: (id: string) => Promise<AppJob>;
    cancel: (id: string) => Promise<AppJob>;
    respond: (id: string) => Promise<AppJob>;
    clearFinished: () => Promise<void>;
    onEvent: (listener: (event: JobEvent) => void) => () => void;
  };
  readonly agentHarness: AgentHarnessHostTransport;
  readonly providerCredentials: ProviderCredentialRendererTransport;
  readonly automationViewHost: {
    register: (
      handler: (method: string, params: unknown) => unknown | Promise<unknown>,
    ) => () => void;
  };
  readonly canonicalProject: {
    /** Stable Builder project root below Electron's per-user application-data directory. */
    defaultRoot: () => Promise<string>;
    startup: () => Promise<{
      readonly projectRoot: string;
      readonly recent: readonly RecentProjectEntry[];
      readonly fallbackNotice: string | null;
    }>;
    create: () => Promise<string | null>;
    open: () => Promise<string | null>;
    openArchive: () => Promise<string | null>;
    openPath: (path: string) => Promise<string | null>;
    opened: (projectRoot: string) => Promise<readonly RecentProjectEntry[]>;
    recent: () => Promise<readonly RecentProjectEntry[]>;
    openRecent: (projectRoot: string) => Promise<string>;
    saveAs: (projectRoot: string) => Promise<ArchiveSummary | null>;
    onCloseRequested: (listener: () => void) => () => void;
    /** Reconstructs path-free live viewer admissions from the durable store. */
    residencyBootstrap: () => Promise<BuilderResidencyBootstrap>;
  };
  readonly stagedRegistration: {
    materialize: (sessionId: string) => Promise<StagedResidencyMaterialization>;
    revoke: (sessionId: string) => Promise<boolean>;
  };
  readonly dev: {
    initialPointCloudPaths: () => Promise<string[]>;
    initialPreparedPointCloud: () => Promise<{
      entityId: string;
      datasetId: string;
      sourceName: string;
      pointCount: number;
      boundsMin: number[];
      boundsMax: number[];
      metadataUrl: string;
    } | null>;
    initialMixedScene: () => Promise<{
      ifcPath: string | null;
      orthophoto: {
        url: string;
        worldFile: number[];
        width: number;
        height: number;
        tiles: {
          x: number;
          y: number;
          width: number;
          height: number;
          imageUrl: string;
          demUrl: string | null;
        }[];
      } | null;
      demUrl: string | null;
    } | null>;
  };
  readonly dialog: {
    openImport: (extensions: readonly string[]) => Promise<string[]>;
    openTransform: () => Promise<string | null>;
    saveTransform: (transform: {
      readonly tx: number;
      readonly ty: number;
      readonly tz: number;
      readonly rxRadians: number;
      readonly ryRadians: number;
      readonly rzRadians: number;
      readonly scale: number;
    }) => Promise<string | null>;
  };
}

export interface RecentProjectEntry {
  readonly path: string;
  readonly name: string;
  readonly openedAtUnixMs: number;
}

export interface ArchiveSummary {
  readonly files: number;
  readonly bytes: number;
  readonly path: string;
}

const api: HimmelCADApi = {
  version: '0.0.0',
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
    close: () => ipcRenderer.invoke('window:close'),
    closeReady: () => ipcRenderer.invoke('window:close-ready'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizeChange: (cb) => {
      const listener = (_e: unknown, m: boolean): void => cb(m);
      ipcRenderer.on('window:maximize-changed', listener);
      return () => ipcRenderer.off('window:maximize-changed', listener);
    },
  },
  sidecar: {
    status: () => ipcRenderer.invoke('sidecar:status'),
    call: (method, params) => ipcRenderer.invoke('sidecar:call', method, params),
    onStderr: (cb) => {
      const listener = (_e: unknown, line: string): void => cb(line);
      ipcRenderer.on('sidecar:stderr', listener);
      return () => ipcRenderer.off('sidecar:stderr', listener);
    },
  },
  jobs: {
    list: () => ipcRenderer.invoke('jobs:list'),
    get: (id) => ipcRenderer.invoke('jobs:get', id),
    register: (input) => ipcRenderer.invoke('jobs:register', input),
    update: (id, patch) => ipcRenderer.invoke('jobs:update', id, patch),
    needsInput: (id, phase) => ipcRenderer.invoke('jobs:needs-input', id, phase),
    complete: (id, resultLabel) => ipcRenderer.invoke('jobs:complete', id, resultLabel),
    fail: (id, error) => ipcRenderer.invoke('jobs:fail', id, error),
    cancelled: (id) => ipcRenderer.invoke('jobs:cancelled', id),
    cancel: (id) => ipcRenderer.invoke('jobs:cancel', id),
    respond: (id) => ipcRenderer.invoke('jobs:respond', id),
    clearFinished: () => ipcRenderer.invoke('jobs:clear-finished'),
    onEvent: (listener) => {
      const ipcListener = (_event: unknown, jobEvent: JobEvent): void => listener(jobEvent);
      ipcRenderer.on('jobs:event', ipcListener);
      return () => ipcRenderer.off('jobs:event', ipcListener);
    },
  },
  agentHarness: {
    request: (request) => ipcRenderer.invoke('automation:agent:request', request),
    subscribe: (sessionId, onPayload) => {
      const listener = (
        _event: unknown,
        message: { readonly sessionId?: unknown; readonly payload?: unknown },
      ): void => {
        if (message?.sessionId === sessionId) onPayload(message.payload);
      };
      ipcRenderer.on('automation:agent:event', listener);
      void ipcRenderer.invoke('automation:agent:subscribe', sessionId);
      return () => {
        ipcRenderer.off('automation:agent:event', listener);
        void ipcRenderer.invoke('automation:agent:unsubscribe', sessionId);
      };
    },
    subscribeProductApprovals: (onRequest) => {
      const listener = (_event: unknown, request: Parameters<typeof onRequest>[0]): void =>
        onRequest(request);
      ipcRenderer.on('automation:confirmation-request', listener);
      return () => ipcRenderer.off('automation:confirmation-request', listener);
    },
    respondProductApproval: async (requestId, decision) => {
      ipcRenderer.send('automation:confirmation-response', { requestId, decision });
    },
  },
  providerCredentials: {
    status: (provider) => ipcRenderer.invoke('automation:provider-credentials:status', provider),
    replace: (request) => ipcRenderer.invoke('automation:provider-credentials:replace', request),
    clearSession: (provider) =>
      ipcRenderer.invoke('automation:provider-credentials:clear-session', provider),
    delete: (provider) => ipcRenderer.invoke('automation:provider-credentials:delete', provider),
  },
  automationViewHost: {
    register: (handler) => {
      const listener = (
        _event: unknown,
        message: {
          readonly requestId?: unknown;
          readonly method?: unknown;
          readonly params?: unknown;
        },
      ): void => {
        if (typeof message?.requestId !== 'string' || typeof message.method !== 'string') return;
        void Promise.resolve(handler(message.method, message.params)).then(
          (result) =>
            ipcRenderer.send('automation:view-response', { requestId: message.requestId, result }),
          (error: unknown) =>
            ipcRenderer.send('automation:view-response', {
              requestId: message.requestId,
              error: { message: error instanceof Error ? error.message : String(error) },
            }),
        );
      };
      ipcRenderer.on('automation:view-request', listener);
      return () => ipcRenderer.off('automation:view-request', listener);
    },
  },
  canonicalProject: {
    defaultRoot: () => ipcRenderer.invoke('canonical-project:default-root'),
    startup: () => ipcRenderer.invoke('canonical-project:startup'),
    create: () => ipcRenderer.invoke('canonical-project:new'),
    open: () => ipcRenderer.invoke('canonical-project:open'),
    openArchive: () => ipcRenderer.invoke('canonical-project:open-archive'),
    openPath: (path) => ipcRenderer.invoke('canonical-project:open-path', path),
    opened: (projectRoot) => ipcRenderer.invoke('canonical-project:opened', projectRoot),
    recent: () => ipcRenderer.invoke('canonical-project:recent'),
    openRecent: (projectRoot) => ipcRenderer.invoke('canonical-project:open-recent', projectRoot),
    saveAs: (projectRoot) => ipcRenderer.invoke('canonical-project:save-as', projectRoot),
    onCloseRequested: (listener) => {
      const ipcListener = (): void => listener();
      ipcRenderer.on('canonical-project:close-requested', ipcListener);
      return () => ipcRenderer.off('canonical-project:close-requested', ipcListener);
    },
    residencyBootstrap: () => ipcRenderer.invoke('canonical-residency:bootstrap'),
  },
  stagedRegistration: {
    materialize: (sessionId) => ipcRenderer.invoke('registration-staged:materialize', sessionId),
    revoke: (sessionId) => ipcRenderer.invoke('registration-staged:revoke', sessionId),
  },
  dev: {
    initialPointCloudPaths: () => ipcRenderer.invoke('dev:initial-point-cloud-paths'),
    initialPreparedPointCloud: () => ipcRenderer.invoke('dev:initial-prepared-point-cloud'),
    initialMixedScene: () => ipcRenderer.invoke('dev:initial-mixed-scene'),
  },
  dialog: {
    openImport: (extensions) => ipcRenderer.invoke('dialog:openImport', extensions),
    openTransform: () => ipcRenderer.invoke('dialog:openTransform'),
    saveTransform: (transform) => ipcRenderer.invoke('dialog:saveTransform', transform),
  },
};

contextBridge.exposeInMainWorld('himmelcad', api);
