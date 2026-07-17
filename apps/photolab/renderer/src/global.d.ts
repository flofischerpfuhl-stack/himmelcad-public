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

interface PhotolabDesktopApi {
  readonly version: string;
  readonly platform: string;
  readonly window: {
    minimize: () => Promise<void>;
    maximizeToggle: () => Promise<boolean>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (cb: (maximized: boolean) => void) => () => void;
  };
  readonly sidecar: {
    status: () => Promise<boolean>;
    call: <T = unknown>(method: string, params?: unknown) => Promise<T>;
    onStderr: (cb: (line: string) => void) => () => void;
  };
  readonly preferences: {
    readonly gcpCsv: {
      get: () => Promise<GcpCsvImportDefaults>;
      save: (value: GcpCsvImportDefaults) => Promise<void>;
    };
  };
  readonly project: {
    bootstrap: <T = unknown>() => Promise<T>;
    create: <T = unknown>(operation: ProjectArchiveOperationRequest) => Promise<T | null>;
    open: <T = unknown>(operation: ProjectArchiveOperationRequest) => Promise<T | null>;
    save: <T = unknown>(operation: ProjectArchiveOperationRequest) => Promise<T>;
    saveAs: <T = unknown>(operation: ProjectArchiveOperationRequest) => Promise<T | null>;
    cancelArchive: <T = unknown>(archiveOperationId: string) => Promise<T>;
  };
  readonly images: {
    selectFiles: () => Promise<string[] | null>;
    selectFolder: () => Promise<string[] | null>;
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
