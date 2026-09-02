interface GcpCsvImportDefaults {
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

interface ProjectArchiveOperationRequest {
  archiveOperationId: string;
  progressKey: string;
}

interface RecentProjectAvailability {
  readonly name: string;
  readonly path: string;
  readonly lastOpenedUnixMs: number;
  readonly exists: boolean;
}

interface ProjectBootstrapResult<T = unknown> {
  readonly project: T | null;
  readonly recentProjects: readonly RecentProjectAvailability[];
  readonly untitledCleanupCount: number;
}

interface PhotolabDesktopApi {
  readonly version: string;
  readonly platform: string;
  readonly window: {
    minimize: () => Promise<void>;
    maximizeToggle: () => Promise<boolean>;
    close: () => Promise<void>;
    onCloseGuardRequested: (
      cb: (request: { autosaveGeneration: number; lastSavedGeneration: number }) => void,
    ) => () => void;
    respondToCloseGuard: (response: 'save' | 'discard' | 'cancel') => Promise<boolean>;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (cb: (maximized: boolean) => void) => () => void;
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
    materialize: (sessionId: string) => Promise<{
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
    }>;
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

declare global {
  interface Window {
    himmelcad?: PhotolabDesktopApi;
  }
}

export {};
import type { AgentHarnessHostTransport } from '@himmelcad/agent';
import type { ProviderCredentialRendererTransport } from '@himmelcad/agent';
