import { contextBridge, ipcRenderer } from 'electron';

/**
 * Sidecar import-summary contract (Phase 2 / ADR 0003).
 *
 * The importer no longer ships per-point payloads; PotreeConverter writes a
 * Potree 2.0 octree directory into the cache, and the renderer streams it
 * via the vendored three-loader.
 */
export interface LasImportSummary {
  source_path: string;
  source_name: string;
  point_count_total: number;
  /**
   * Same as `point_count_total` post-Phase-2 (no decimation). Kept for the
   * "loaded / total" log line in the import progress.
   */
  point_count_loaded: number;
  has_color: boolean;
  has_intensity: boolean;
  bounds_min: [number, number, number];
  bounds_max: [number, number, number];
  render_offset: [number, number, number];
  /**
   * Sidecar-side absolute filesystem path to the entity's Potree directory
   * (`<cache>/<entityId>/`). Renderer doesn't read it directly; use
   * `metadata_url` instead.
   */
  potree_dir: string;
  /** Stable semantic identity of this imported entity. */
  entity_id: string;
  /** Content-addressed identity of the immutable prepared dataset. */
  dataset_id: string;
  /**
   * Renderer-reachable URL for the Potree 2.0 metadata file. The
   * three-loader fetches this and discovers `hierarchy.bin` / `octree.bin`
   * relative to it. Built by the Electron host from `dataset_id`.
   */
  metadata_url: string;
}

export interface HimmelCADApi {
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly window: {
    minimize: () => Promise<void>;
    maximizeToggle: () => Promise<boolean>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (cb: (m: boolean) => void) => () => void;
  };
  readonly sidecar: {
    status: () => Promise<boolean>;
    call: <T = unknown>(method: string, params?: unknown) => Promise<T>;
    onStderr: (cb: (line: string) => void) => () => void;
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
        tiles: Array<{
          x: number;
          y: number;
          width: number;
          height: number;
          imageUrl: string;
          demUrl: string | null;
        }>;
      } | null;
      demUrl: string | null;
    } | null>;
  };
  readonly dialog: {
    openLas: () => Promise<string[]>;
  };
  readonly importLas: (
    paths: string[],
    progressKey?: string,
  ) => Promise<{ imports: LasImportSummary[] }>;
  readonly cancelLasImport: (
    operationId: string,
  ) => Promise<{ operationId: string; cancellationRequested: boolean }>;
}

const api: HimmelCADApi = {
  version: '0.0.0',
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximize-toggle'),
    close: () => ipcRenderer.invoke('window:close'),
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
  dev: {
    initialPointCloudPaths: () => ipcRenderer.invoke('dev:initial-point-cloud-paths'),
    initialPreparedPointCloud: () => ipcRenderer.invoke('dev:initial-prepared-point-cloud'),
    initialMixedScene: () => ipcRenderer.invoke('dev:initial-mixed-scene'),
  },
  dialog: {
    openLas: () => ipcRenderer.invoke('dialog:openLas'),
  },
  importLas: (paths, progressKey) =>
    ipcRenderer.invoke('import:las', { paths, progressKey }) as Promise<{
      imports: LasImportSummary[];
    }>,
  cancelLasImport: (operationId) =>
    ipcRenderer.invoke('sidecar:call', 'import.las.cancel', {
      operation_id: operationId,
    }) as Promise<{ operationId: string; cancellationRequested: boolean }>,
};

contextBridge.exposeInMainWorld('himmelcad', api);
