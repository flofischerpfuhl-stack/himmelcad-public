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

declare global {
  interface Window {
    himmelcad?: PhotolabDesktopApi;
  }
}

export {};
