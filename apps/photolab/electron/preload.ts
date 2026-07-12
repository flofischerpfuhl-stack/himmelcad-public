import { contextBridge, ipcRenderer } from 'electron';

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
  readonly project: {
    bootstrap: <T = unknown>() => Promise<T>;
    create: <T = unknown>() => Promise<T | null>;
    open: <T = unknown>() => Promise<T | null>;
    save: <T = unknown>() => Promise<T>;
    saveAs: <T = unknown>() => Promise<T | null>;
    cancelArchive: <T = unknown>(archiveOperationId: string) => Promise<T>;
  };
  readonly images: {
    selectFiles: <T = unknown>() => Promise<T | null>;
    selectFolder: <T = unknown>() => Promise<T | null>;
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
  project: {
    bootstrap: () => ipcRenderer.invoke('project:bootstrap'),
    create: () => ipcRenderer.invoke('project:create'),
    open: () => ipcRenderer.invoke('project:open'),
    save: () => ipcRenderer.invoke('project:save'),
    saveAs: () => ipcRenderer.invoke('project:save-as'),
    cancelArchive: (archiveOperationId) =>
      ipcRenderer.invoke('project:archive-cancel', archiveOperationId),
  },
  images: {
    selectFiles: () => ipcRenderer.invoke('images:select-files'),
    selectFolder: () => ipcRenderer.invoke('images:select-folder'),
  },
  reference: {
    selectGcpCsv: () => ipcRenderer.invoke('reference:select-gcp-csv'),
  },
  batch: {
    load: () => ipcRenderer.invoke('batch:load'),
    save: (value) => ipcRenderer.invoke('batch:save', value),
  },
  reports: {
    save: (request) => ipcRenderer.invoke('reports:save', request),
  },
  products: {
    export: (request) => ipcRenderer.invoke('products:export', request),
  },
};

contextBridge.exposeInMainWorld('himmelcad', api);
