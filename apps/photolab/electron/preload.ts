import { contextBridge, ipcRenderer } from 'electron';
import type { AgentHarnessHostTransport } from '@himmelcad/agent/src/transport.js';
import type { ProviderCredentialRendererTransport } from '@himmelcad/agent/src/providerCredentials.js';

export interface GcpCsvImportDefaults {
  delimiter: string;
  decimalSeparator: 'point' | 'comma';
  hasHeader: boolean;
  columns: { name: string; east: string; north: string; height: string };
  role:
    | 'controlXyz'
    | 'controlXy'
    | 'controlZ'
    | 'checkpointXyz'
    | 'checkpointXy'
    | 'checkpointZ'
    | 'disabled';
  horizontalStddev: number;
  heightStddev: number;
}

export interface ProjectArchiveOperationRequest {
  archiveOperationId: string;
  progressKey: string;
}

export interface CloseBlockedReport {
  readonly reason: string;
  readonly timedOutJobs: readonly string[];
  readonly timedOutSideOperations: readonly string[];
  readonly durableDescription: string;
}

export interface RecentProjectAvailability {
  readonly name: string;
  readonly path: string;
  readonly lastOpenedUnixMs: number;
  readonly exists: boolean;
}

export interface ProjectBootstrapResult<T = unknown> {
  readonly project: T | null;
  readonly recentProjects: readonly RecentProjectAvailability[];
  readonly untitledCleanupCount: number;
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
}

export interface PhotolabDesktopApi {
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly window: {
    minimize: () => Promise<void>;
    maximizeToggle: () => Promise<boolean>;
    close: () => Promise<void>;
    retryClose: () => Promise<void>;
    cancelClose: () => Promise<void>;
    forceQuit: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (cb: (maximized: boolean) => void) => () => void;
    onCloseBlocked: (cb: (report: CloseBlockedReport) => void) => () => void;
  };
  readonly sidecar: {
    status: () => Promise<boolean>;
    call: <T = unknown>(method: string, params?: unknown) => Promise<T>;
    onStderr: (cb: (line: string) => void) => () => void;
  };
  readonly agentHarness: AgentHarnessHostTransport;
  readonly providerCredentials: ProviderCredentialRendererTransport;
  readonly automationViewHost: {
    register: (
      handler: (method: string, params: unknown) => unknown | Promise<unknown>,
    ) => () => void;
  };
  readonly externalImport: {
    projectRoot: () => Promise<string>;
    selectFiles: (extensions: readonly string[]) => Promise<string[]>;
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
    materialize: (sessionId: string) => Promise<StagedResidencyMaterialization>;
    revoke: (sessionId: string) => Promise<boolean>;
    residency: <T = unknown>() => Promise<T>;
  };
  readonly preferences: {
    readonly gcpCsv: {
      get: () => Promise<GcpCsvImportDefaults>;
      save: (value: GcpCsvImportDefaults) => Promise<void>;
    };
  };
  readonly project: {
    bootstrap: <T = unknown>() => Promise<ProjectBootstrapResult<T>>;
    create: <T = unknown>(operation: ProjectArchiveOperationRequest) => Promise<T | null>;
    open: <T = unknown>(operation: ProjectArchiveOperationRequest) => Promise<T | null>;
    openRecent: <T = unknown>(
      path: string,
      operation: ProjectArchiveOperationRequest,
    ) => Promise<T>;
    recent: () => Promise<readonly RecentProjectAvailability[]>;
    removeRecent: (path: string) => Promise<readonly RecentProjectAvailability[]>;
    reopenWithoutRecovery: <T = unknown>() => Promise<T>;
    cleanupUntitled: () => Promise<number>;
    save: <T = unknown>(operation: ProjectArchiveOperationRequest) => Promise<T>;
    saveAs: <T = unknown>(operation: ProjectArchiveOperationRequest) => Promise<T | null>;
    cancelArchive: <T = unknown>(archiveOperationId: string) => Promise<T>;
  };
  readonly images: {
    selectFiles: () => Promise<string[] | null>;
    selectFolder: () => Promise<string[] | null>;
  };
  readonly himmelcap: {
    selectFile: () => Promise<string | null>;
  };
  readonly capture: {
    selectVideo: () => Promise<string | null>;
  };
  readonly grids: {
    select: {
      (
        kind: 'vertical' | 'horizontal',
        progressKey?: string,
      ): Promise<{
        filename: string;
        localPath: string;
        kind: 'ntv2' | 'gtg' | 'geoid';
        driver: string;
        coverage: {
          westLongitude: number;
          southLatitude: number;
          eastLongitude: number;
          northLatitude: number;
        };
      } | null>;
      /** Compatibility overload while import callers migrate to an explicit grid role. */
      (progressKey?: string): Promise<{
        filename: string;
        localPath: string;
        kind: 'ntv2' | 'gtg' | 'geoid';
        driver: string;
        coverage: {
          westLongitude: number;
          southLatitude: number;
          eastLongitude: number;
          northLatitude: number;
        };
      } | null>;
    };
  };
  readonly reference: {
    selectGcpCsv: () => Promise<string | null>;
  };
  readonly batch: {
    load: <T = unknown>() => Promise<T | null>;
    save: (value: unknown) => Promise<boolean>;
  };
  readonly workflows: {
    defaultDir: () => Promise<string>;
    list: () => Promise<
      Array<{
        name: string;
        path: string;
        savedAt: string;
        kind?: string;
        description?: string;
      }>
    >;
    loadPath: (path: string) => Promise<{ path: string; workflow: unknown }>;
    open: () => Promise<{ path: string; workflow: unknown } | null>;
    save: (request: {
      suggestedName?: string;
      workflow: unknown;
      prompt?: boolean;
    }) => Promise<{ path: string; name: string } | null>;
  };
  readonly alignmentPresets: {
    defaultDir: () => Promise<string>;
    list: () => Promise<
      Array<{
        name: string;
        path: string;
        savedAt: string;
        profile?: string;
        description?: string;
      }>
    >;
    loadPath: (path: string) => Promise<{ path: string; preset: unknown }>;
    open: () => Promise<{ path: string; preset: unknown } | null>;
    save: (request: {
      suggestedName?: string;
      preset: unknown;
    }) => Promise<{ path: string; name: string } | null>;
  };
  readonly reports: {
    save: (request: {
      format: 'html' | 'pdf';
      suggestedName: string;
      html: string;
    }) => Promise<boolean>;
  };
  readonly products: {
    export: <T = unknown>(request: {
      entityId: string;
      kind: string;
      name: string;
      format?: 'ply' | 'las' | 'laz';
    }) => Promise<T | null>;
    confirmExport: <T = unknown>(token: string) => Promise<T>;
    cancelExport: (token: string) => Promise<void>;
  };
}

const api: PhotolabDesktopApi = {
  version: '0.0.0',
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
    close: () => ipcRenderer.invoke('window:close'),
    retryClose: () => ipcRenderer.invoke('window:close-retry'),
    cancelClose: () => ipcRenderer.invoke('window:close-cancel'),
    forceQuit: () => ipcRenderer.invoke('window:force-quit'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizeChange: (cb) => {
      const listener = (_event: unknown, maximized: boolean): void => cb(maximized);
      ipcRenderer.on('window:maximize-changed', listener);
      return () => ipcRenderer.off('window:maximize-changed', listener);
    },
    onCloseBlocked: (cb) => {
      const listener = (_event: unknown, report: CloseBlockedReport): void => cb(report);
      ipcRenderer.on('window:close-blocked', listener);
      return () => ipcRenderer.off('window:close-blocked', listener);
    },
  },
  sidecar: {
    status: () => ipcRenderer.invoke('sidecar:status'),
    call: (method, params) => ipcRenderer.invoke('sidecar:call', method, params),
    onStderr: (cb) => {
      const listener = (_event: unknown, line: string): void => cb(line);
      ipcRenderer.on('sidecar:stderr', listener);
      return () => ipcRenderer.off('sidecar:stderr', listener);
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
  externalImport: {
    projectRoot: () => ipcRenderer.invoke('external-import:project-root'),
    selectFiles: (extensions) => ipcRenderer.invoke('external-import:select', extensions),
    openTransform: () => ipcRenderer.invoke('external-import:open-transform'),
    saveTransform: (transform) => ipcRenderer.invoke('external-import:save-transform', transform),
    materialize: (sessionId) => ipcRenderer.invoke('registration-staged:materialize', sessionId),
    revoke: (sessionId) => ipcRenderer.invoke('registration-staged:revoke', sessionId),
    residency: () => ipcRenderer.invoke('external-import:residency'),
  },
  preferences: {
    gcpCsv: {
      get: () => ipcRenderer.invoke('preferences:gcp-csv:get'),
      save: (value) => ipcRenderer.invoke('preferences:gcp-csv:save', value),
    },
  },
  project: {
    bootstrap: () => ipcRenderer.invoke('project:bootstrap'),
    create: (operation) => ipcRenderer.invoke('project:create', operation),
    open: (operation) => ipcRenderer.invoke('project:open', operation),
    openRecent: (path, operation) => ipcRenderer.invoke('project:open-recent', path, operation),
    recent: () => ipcRenderer.invoke('project:recent-list'),
    removeRecent: (path) => ipcRenderer.invoke('project:recent-remove', path),
    reopenWithoutRecovery: () => ipcRenderer.invoke('project:reopen-without-recovery'),
    cleanupUntitled: () => ipcRenderer.invoke('project:untitled-cleanup'),
    save: (operation) => ipcRenderer.invoke('project:save', operation),
    saveAs: (operation) => ipcRenderer.invoke('project:save-as', operation),
    cancelArchive: (archiveOperationId) =>
      ipcRenderer.invoke('project:archive-cancel', archiveOperationId),
  },
  images: {
    selectFiles: () => ipcRenderer.invoke('images:select-files'),
    selectFolder: () => ipcRenderer.invoke('images:select-folder'),
  },
  himmelcap: {
    selectFile: () => ipcRenderer.invoke('himmelcap:select-file'),
  },
  capture: {
    selectVideo: () => ipcRenderer.invoke('capture:select-video'),
  },
  grids: {
    select: (kindOrProgressKey?: string, progressKey?: string) =>
      ipcRenderer.invoke('grids:select', kindOrProgressKey, progressKey),
  },
  reference: {
    selectGcpCsv: () => ipcRenderer.invoke('reference:select-gcp-csv'),
  },
  batch: {
    load: () => ipcRenderer.invoke('batch:load'),
    save: (value) => ipcRenderer.invoke('batch:save', value),
  },
  workflows: {
    defaultDir: () => ipcRenderer.invoke('workflows:default-dir'),
    list: () => ipcRenderer.invoke('workflows:list'),
    loadPath: (path) => ipcRenderer.invoke('workflows:load-path', path),
    open: () => ipcRenderer.invoke('workflows:open'),
    save: (request) => ipcRenderer.invoke('workflows:save', request),
  },
  alignmentPresets: {
    defaultDir: () => ipcRenderer.invoke('alignment-presets:default-dir'),
    list: () => ipcRenderer.invoke('alignment-presets:list'),
    loadPath: (path) => ipcRenderer.invoke('alignment-presets:load-path', path),
    open: () => ipcRenderer.invoke('alignment-presets:open'),
    save: (request) => ipcRenderer.invoke('alignment-presets:save', request),
  },
  reports: {
    save: (request) => ipcRenderer.invoke('reports:save', request),
  },
  products: {
    export: (request) => ipcRenderer.invoke('products:export', request),
    confirmExport: (token) => ipcRenderer.invoke('products:export-confirm', token),
    cancelExport: (token) => ipcRenderer.invoke('products:export-cancel', token),
  },
};

contextBridge.exposeInMainWorld('himmelcad', api);
