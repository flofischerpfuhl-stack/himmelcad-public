import { contextBridge, ipcRenderer } from 'electron';

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

export interface PhotolabDesktopApi {
  readonly version: string;
  readonly platform: NodeJS.Platform;
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
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizeChange: (cb) => {
      const listener = (_event: unknown, maximized: boolean): void => cb(maximized);
      ipcRenderer.on('window:maximize-changed', listener);
      return () => ipcRenderer.off('window:maximize-changed', listener);
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
