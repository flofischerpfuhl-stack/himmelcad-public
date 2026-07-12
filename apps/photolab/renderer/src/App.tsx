import { consoleStore, logEvent } from '@himmelcad/console';
import type {
  AlignmentQualityProfile,
  AlignedGcpCameraRecord,
  EntityId,
  GcpCollectionRecord,
  GcpCsvImportMapping,
  GcpCsvPreview,
  GcpOptimizationPublicationRecord,
  GcpOptimizationSnapshotResult,
  GcpObservationEdit,
  HardwareCapabilities,
  ObjectHash,
  OpenPhotolabProjectResult,
  PhotolabJournalEntry,
  PhotolabJob,
  PhotoImportBatch,
  ProcessingSetRecord,
  ProjectCameraImageRecord,
  ProjectSnapshot,
  ResolvedAlignmentConfig,
  SnapResult,
} from '@himmelcad/data';
import {
  AppShell,
  EntityTree,
  FunctionPanel,
  PanelToggles,
  Ribbon,
  StatusBar,
  TitleBar,
  useLayoutStore,
  type WindowControls,
} from '@himmelcad/ui';
import {
  Viewport,
  type CameraImageRectangle,
  type GcpMarker,
  type ViewportHandle,
} from '@himmelcad/viewer';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AlignmentProfilePanel } from './AlignmentProfilePanel.js';
import styles from './App.module.css';
import { BatchConfiguratorPanel, type BatchPipelineStep } from './BatchConfiguratorPanel.js';
import type { GcpAccuracyReport } from './GcpAccuracyPanel.js';
import type { GcpImageMarker, GcpManualMeasurement } from './GcpImageMarkerOverlay.js';
import { GcpImportPanel } from './GcpImportPanel.js';
import { GcpOptimizationPanel, type GcpOptimizationSelection } from './GcpOptimizationPanel.js';
import { ImageImportPanel } from './ImageImportPanel.js';
import type {
  CrsOperationDiscovery,
  CrsOperationQuery,
  ImageImportDecision,
} from './ImageImportPanel.js';
import { ImageWorkspace } from './ImageWorkspace.js';
import { PhotolabBottomPanel } from './PhotolabBottomPanel.js';
import { ProjectDiagnosticsPanel, type ProjectDiagnosticsKind } from './ProjectDiagnosticsPanel.js';
import {
  ProductPanel,
  defaultProductConfiguration,
  type ProductOperation,
  type ProductRunConfiguration,
} from './ProductPanel.js';
import { createPhotolabProject } from './project.js';
import { createPhotolabRibbonTabs } from './ribbon.js';

const DEFAULT_IMAGE_COUNT = 0;
const SIDECAR_PROGRESS_PREFIX = '__HC_PROGRESS__';
type WorkspaceMode = 'scene3d' | 'map2d' | 'images';
interface ProjectProductDatasetRecord {
  entityId: EntityId;
  kind: 'gaussianSplat' | 'dem' | 'orthomosaic' | 'mesh' | 'depth' | 'dense' | 'sparse';
  relativePath: string;
  format:
    | 'brushPly'
    | 'prepared'
    | 'rasterPyramid'
    | 'tiledMesh'
    | 'mvsDepth'
    | 'binaryPly'
    | 'potreeV2';
  visible: boolean;
  boundsMin?: [number, number, number];
  boundsMax?: [number, number, number];
  renderOffset?: [number, number, number];
  pointCount?: number;
}

export function App(): JSX.Element {
  const [project, setProject] = useState<ProjectSnapshot>(createPhotolabProject);
  const [selected, setSelected] = useState<ReadonlySet<EntityId>>(new Set());
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [coreReady, setCoreReady] = useState(false);
  const [hardware, setHardware] = useState<HardwareCapabilities | null>(null);
  const [profile, setProfile] = useState<AlignmentQualityProfile>('qualityHybrid');
  const [alignmentScope, setAlignmentScope] = useState<'all' | 'selection'>('all');
  const [imageCount, setImageCount] = useState(DEFAULT_IMAGE_COUNT);
  const [resolved, setResolved] = useState<ResolvedAlignmentConfig | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [alignmentStarting, setAlignmentStarting] = useState(false);
  const [productStarting, setProductStarting] = useState(false);
  const [batchStarting, setBatchStarting] = useState(false);
  const [processingSetSaving, setProcessingSetSaving] = useState(false);
  const [projectReady, setProjectReady] = useState(false);
  const [autosaveGeneration, setAutosaveGeneration] = useState(0);
  const [lastSavedGeneration, setLastSavedGeneration] = useState(0);
  const [jobs, setJobs] = useState<readonly PhotolabJob[]>([]);
  const [imageImportBatch, setImageImportBatch] = useState<PhotoImportBatch | null>(null);
  const [projectImages, setProjectImages] = useState<readonly ProjectCameraImageRecord[]>([]);
  const [processingSets, setProcessingSets] = useState<readonly ProcessingSetRecord[]>([]);
  const [activeProcessingSetId, setActiveProcessingSetId] = useState<EntityId | null>(null);
  const [productDatasets, setProductDatasets] = useState<readonly ProjectProductDatasetRecord[]>(
    [],
  );
  const [gcpPath, setGcpPath] = useState<string | null>(null);
  const [gcpBusy, setGcpBusy] = useState(false);
  const [gcpCollection, setGcpCollection] = useState<
    readonly [ObjectHash, GcpCollectionRecord] | null
  >(null);
  const [gcpOptimization, setGcpOptimization] = useState<GcpOptimizationPublicationRecord | null>(
    null,
  );
  const [gcpOptimizationStarting, setGcpOptimizationStarting] = useState(false);
  const [alignedGcpCameras, setAlignedGcpCameras] = useState<readonly AlignedGcpCameraRecord[]>([]);
  const [focusedGcpId, setFocusedGcpId] = useState<string | null>(null);
  const [projectTargetCrs, setProjectTargetCrs] = useState<string | null>(null);
  const [imageImportBusy, setImageImportBusy] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('scene3d');
  const viewportRef = useRef<ViewportHandle | null>(null);
  const initialBootstrapRequested = useRef(false);
  const jobPollErrorLogged = useRef(false);
  const activeImageCommitId = useRef<string | null>(null);
  const activeGcpOperationId = useRef<string | null>(null);
  const lastLoadedGcpOptimizationJobId = useRef<string | null>(null);
  const loadedProductIds = useRef<Set<EntityId>>(new Set());
  const refreshedCompletedJobs = useRef<Set<string>>(new Set());
  const activeFunctionId = useLayoutStore((state) => state.activeFunctionId);
  const activate = useLayoutStore((state) => state.activateFunction);
  const toggleBottom = useLayoutStore((state) => state.toggleBottomPanel);
  const selectedCameraIds = useMemo(
    () =>
      projectImages.filter((image) => selected.has(image.entityId)).map((image) => image.entityId),
    [projectImages, selected],
  );
  const alignmentImageCount =
    alignmentScope === 'selection' ? selectedCameraIds.length : projectImages.length;

  const resolveProfile = useCallback(async () => {
    const api = window.himmelcad;
    if (!api) {
      setResolveError('Desktop bridge is missing. Start PhotoLab through Electron.');
      return;
    }
    setResolving(true);
    setResolveError(null);
    const started = performance.now();
    let commandId: string | null = null;
    logEvent('info', 'renderer', `Resolving alignment profile ${profile} in the core`);
    try {
      if (projectReady) {
        const journal = await api.sidecar.call<PhotolabJournalEntry>(
          'photolab.project.journal.start',
          {
            commandKind: 'ResolvePhotolabAlignmentProfile',
            payload: {
              profile,
              imageCount: alignmentImageCount,
              cameraEntityIds: alignmentScope === 'selection' ? selectedCameraIds : [],
            },
          },
        );
        commandId = journal.commandId;
        setAutosaveGeneration((generation) => generation + 1);
      }
      const config = await api.sidecar.call<ResolvedAlignmentConfig>('photolab.alignment.resolve', {
        profile,
        imageCount: alignmentImageCount,
      });
      setResolved(config);
      logEvent(
        'info',
        'sidecar',
        `Alignment configuration frozen · ${config.configHash.slice(0, 16)} · ${(performance.now() - started).toFixed(1)} ms`,
      );
      if (commandId) {
        await api.sidecar.call('photolab.project.journal.finish', {
          commandId,
          state: 'committed',
          afterRefs: [config.configHash],
          message: `Alignment configuration ${config.configHash}`,
        });
        setAutosaveGeneration((generation) => generation + 1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResolveError(message);
      logEvent('error', 'sidecar', `Alignment configuration rejected: ${message}`);
      if (commandId) {
        try {
          await api.sidecar.call('photolab.project.journal.finish', {
            commandId,
            state: 'failed',
            message,
          });
          setAutosaveGeneration((generation) => generation + 1);
        } catch (journalError) {
          logEvent(
            'error',
            'sidecar',
            `Failed to journal error state: ${errorMessage(journalError)}`,
          );
        }
      }
    } finally {
      setResolving(false);
    }
  }, [alignmentImageCount, alignmentScope, profile, projectReady, selectedCameraIds]);

  const acceptProject = useCallback(
    (
      opened: OpenPhotolabProjectResult,
      options?: { preserveSelection: boolean; processingSetId: EntityId | null },
    ) => {
      for (const entityId of loadedProductIds.current) viewportRef.current?.removeLayer(entityId);
      loadedProductIds.current.clear();
      setProject({
        formatVersion: opened.manifest.formatVersion,
        projectId: opened.manifest.projectId,
        name: opened.manifest.name,
        rootEntity: opened.manifest.rootEntity,
        entities: opened.manifest.entities,
        renderOffset: opened.manifest.renderOffset,
      });
      setAutosaveGeneration(opened.session.autosaveGeneration);
      setLastSavedGeneration(opened.session.lastSavedGeneration);
      setProjectReady(true);
      setProjectTargetCrs(referenceFrameLabel(opened.manifest.referenceFrame));
      if (!options?.preserveSelection) {
        setSelected(new Set());
        setActiveProcessingSetId(null);
        setFocusedGcpId(null);
      }
      const api = window.himmelcad;
      if (api) {
        void api.sidecar
          .call<ProjectCameraImageRecord[]>('photolab.images.list')
          .then((records) => {
            setProjectImages(records);
            setImageCount(records.length);
          })
          .catch((error: unknown) => {
            setProjectImages([]);
            logEvent(
              'error',
              'sidecar',
              `Image catalog could not be loaded: ${errorMessage(error)}`,
            );
          });
        if (
          Object.values(opened.manifest.entities).some((entity) => entity.kind === 'AlignmentRun')
        ) {
          void api.sidecar
            .call<AlignedGcpCameraRecord[]>('photolab.gcp.alignedCameras', {
              ...(options?.processingSetId ? { processingSetId: options.processingSetId } : {}),
            })
            .then(setAlignedGcpCameras)
            .catch((error: unknown) => {
              setAlignedGcpCameras([]);
              logEvent(
                'warn',
                'sidecar',
                `Aligned cameras are not available yet: ${errorMessage(error)}`,
              );
            });
        } else {
          setAlignedGcpCameras([]);
        }
        void api.sidecar
          .call<ProjectProductDatasetRecord[]>('photolab.products.list')
          .then(setProductDatasets)
          .catch((error: unknown) => {
            setProductDatasets([]);
            logEvent(
              'error',
              'sidecar',
              `Product catalog could not be loaded: ${errorMessage(error)}`,
            );
          });
        void api.sidecar
          .call<ProcessingSetRecord[]>('photolab.project.processingSet.list')
          .then(setProcessingSets)
          .catch((error: unknown) => {
            setProcessingSets([]);
            logEvent(
              'error',
              'sidecar',
              `Processing sets could not be loaded: ${errorMessage(error)}`,
            );
          });
        void api.sidecar
          .call<readonly [ObjectHash, GcpCollectionRecord] | null>('photolab.gcp.list')
          .then(setGcpCollection)
          .catch((error: unknown) => {
            setGcpCollection(null);
            logEvent('error', 'sidecar', `GCP catalog could not be loaded: ${errorMessage(error)}`);
          });
        void api.sidecar
          .call<GcpOptimizationPublicationRecord | null>('photolab.gcp.optimization.latest', {
            ...(options?.processingSetId ? { processingSetId: options.processingSetId } : {}),
          })
          .then(setGcpOptimization)
          .catch((error: unknown) => {
            setGcpOptimization(null);
            logEvent(
              'error',
              'sidecar',
              `GCP optimization result could not be loaded: ${errorMessage(error)}`,
            );
          });
      }
      logEvent(
        opened.session.recoveryAvailable ? 'warn' : 'info',
        'sidecar',
        opened.session.usesLocalWorkingCopy
          ? `Project opened in local working copy · ${opened.session.workingPath}`
          : `Project opened · ${opened.session.sourcePath}`,
      );
    },
    [],
  );

  const createProject = useCallback(async () => {
    const api = window.himmelcad;
    if (!api) return;
    try {
      const opened = await api.project.create<OpenPhotolabProjectResult>();
      if (opened) acceptProject(opened);
    } catch (error) {
      logEvent('error', 'electron', `Project could not be created: ${errorMessage(error)}`);
    }
  }, [acceptProject]);

  const openProject = useCallback(async () => {
    const api = window.himmelcad;
    if (!api) return;
    try {
      const opened = await api.project.open<OpenPhotolabProjectResult>();
      if (opened) acceptProject(opened);
    } catch (error) {
      logEvent('error', 'electron', `Project could not be opened: ${errorMessage(error)}`);
    }
  }, [acceptProject]);

  const saveProject = useCallback(async () => {
    const api = window.himmelcad;
    if (!api || !projectReady) return;
    const started = performance.now();
    try {
      const result = await api.project.save<{ savedGeneration: number; sourcePath: string }>();
      setLastSavedGeneration(result.savedGeneration);
      logEvent(
        'info',
        'sidecar',
        `Project saved · generation ${result.savedGeneration} · ${(performance.now() - started).toFixed(1)} ms`,
      );
    } catch (error) {
      logEvent('error', 'sidecar', `Save failed: ${errorMessage(error)}`);
    }
  }, [projectReady]);

  const saveProjectAs = useCallback(async () => {
    const api = window.himmelcad;
    if (!api || !projectReady) return;
    const started = performance.now();
    try {
      const result = await api.project.saveAs<{
        savedGeneration: number;
        sourcePath: string;
      }>();
      if (!result) return;
      setLastSavedGeneration(result.savedGeneration);
      logEvent(
        'info',
        'sidecar',
        `Project archive written · ${result.sourcePath} · ${(performance.now() - started).toFixed(1)} ms`,
      );
    } catch (error) {
      logEvent('error', 'sidecar', `Save As failed: ${errorMessage(error)}`);
    }
  }, [projectReady]);

  const inspectImages = useCallback(
    async (source: 'files' | 'folder') => {
      const api = window.himmelcad;
      if (!api || imageImportBusy) return;
      setImageImportBusy(true);
      const started = performance.now();
      logEvent(
        'info',
        'renderer',
        source === 'files' ? 'Image picker opened' : 'Folder picker opened',
      );
      try {
        const batch =
          source === 'files'
            ? await api.images.selectFiles<PhotoImportBatch>()
            : await api.images.selectFolder<PhotoImportBatch>();
        if (!batch) return;
        setImageImportBatch((previous) => mergePhotoBatches(previous, batch));
        activate('images.import.review');
        logEvent(
          batch.warnings.length > 0 ? 'warn' : 'info',
          'sidecar',
          `${batch.photos.length} images validated · ${batch.warnings.length} warnings · ${(performance.now() - started).toFixed(1)} ms`,
        );
      } catch (error) {
        logEvent('error', 'sidecar', `Image validation failed: ${errorMessage(error)}`);
      } finally {
        setImageImportBusy(false);
      }
    },
    [activate, imageImportBusy],
  );

  const discoverImageCrs = useCallback(async (query: CrsOperationQuery) => {
    const api = window.himmelcad;
    if (!api) throw new Error('Desktop bridge is missing');
    const operationId = `crs-discover-${crypto.randomUUID()}`;
    const started = performance.now();
    logEvent('info', 'sidecar', 'Checking CRS operations fully offline');
    const discovery = await api.sidecar.call<CrsOperationDiscovery>('photolab.crs.discover', {
      operationId,
      query,
    });
    logEvent(
      discovery.warnings.length > 0 ? 'warn' : 'info',
      'sidecar',
      `${discovery.candidates.length} CRS operations checked · ${(performance.now() - started).toFixed(1)} ms`,
    );
    return discovery;
  }, []);

  const commitImageImport = useCallback(
    async (decision: ImageImportDecision) => {
      const api = window.himmelcad;
      if (!api || !imageImportBatch || imageImportBusy || !projectReady) return;
      const operationId = `image-import-${crypto.randomUUID()}`;
      activeImageCommitId.current = operationId;
      setImageImportBusy(true);
      const started = performance.now();
      try {
        const transformation = await api.sidecar.call<unknown>('photolab.crs.freeze', {
          operationId: `${operationId}.freeze`,
          decision,
        });
        const warningPaths = new Set(
          imageImportBatch.warnings.map((warning) => warning.sourcePath),
        );
        const result = await api.sidecar.call<{
          importedEntityCount: number;
          duplicateCount: number;
          autosaveGeneration: number;
        }>('photolab.images.commit', {
          operationId,
          transformation,
          images: imageImportBatch.photos.map((photo) => ({
            photo,
            projectedReference: null,
            tags: [
              ...(warningPaths.has(photo.sourcePath) ? ['qualityWarning' as const] : []),
              ...(hasFixedDjiRtk(photo.metadata) ? ['rtkFixed' as const] : []),
            ],
          })),
        });
        const opened = await api.sidecar.call<OpenPhotolabProjectResult>(
          'photolab.project.snapshot',
        );
        acceptProject(opened);
        setImageCount(
          Object.values(opened.manifest.entities).filter((entity) => entity.kind === 'CameraImage')
            .length,
        );
        setAutosaveGeneration(result.autosaveGeneration);
        setWorkspaceMode('images');
        activate(null);
        logEvent(
          'info',
          'sidecar',
          `${result.importedEntityCount} images imported atomically · ${result.duplicateCount} duplicates · ${(performance.now() - started).toFixed(1)} ms`,
        );
      } catch (error) {
        logEvent('error', 'sidecar', `Image import failed: ${errorMessage(error)}`);
      } finally {
        activeImageCommitId.current = null;
        setImageImportBusy(false);
      }
    },
    [acceptProject, activate, imageImportBatch, imageImportBusy, projectReady],
  );

  const cancelImageImport = useCallback(async () => {
    const operationId = activeImageCommitId.current;
    const api = window.himmelcad;
    if (operationId && api) {
      await Promise.allSettled([
        api.sidecar.call('photolab.crs.cancel', { operationId: `${operationId}.freeze` }),
        api.sidecar.call('photolab.crs.cancel', { operationId: `${operationId}.coordinates` }),
        api.sidecar.call('photolab.images.commit.cancel', { operationId }),
      ]);
      logEvent('warn', 'sidecar', 'Image import cancellation requested');
      return;
    }
    setImageImportBatch(null);
    activate(null);
  }, [activate]);

  const chooseGcpCsv = useCallback(async () => {
    const api = window.himmelcad;
    if (!api || gcpBusy) return;
    const path = await api.reference.selectGcpCsv();
    if (!path) return;
    setGcpPath(path);
    activate('reference.gcp.import');
    logEvent('info', 'renderer', `GCP file selected · ${path}`);
  }, [activate, gcpBusy]);

  const previewGcpCsv = useCallback(async (path: string, mapping: GcpCsvImportMapping) => {
    const api = window.himmelcad;
    if (!api) throw new Error('Desktop bridge is missing');
    return api.sidecar.call<GcpCsvPreview>('photolab.gcp.preview', {
      path,
      mapping,
      maximumPreviewRows: 100,
    });
  }, []);

  const commitGcpCsv = useCallback(
    async (path: string, mapping: GcpCsvImportMapping, decision: ImageImportDecision) => {
      const api = window.himmelcad;
      if (!api || gcpBusy || !projectReady) return;
      const operationId = `gcp-import-${crypto.randomUUID()}`;
      activeGcpOperationId.current = operationId;
      setGcpBusy(true);
      const started = performance.now();
      try {
        const transformation = await api.sidecar.call('photolab.crs.freeze', {
          operationId: `${operationId}.freeze`,
          decision,
        });
        const result = await api.sidecar.call<{
          collectionSha256: ObjectHash;
          autosaveGeneration: number;
          points: unknown[];
        }>('photolab.gcp.commit', {
          operationId,
          path,
          mapping,
          transformation,
        });
        const opened = await api.sidecar.call<OpenPhotolabProjectResult>(
          'photolab.project.snapshot',
        );
        acceptProject(opened);
        setAutosaveGeneration(result.autosaveGeneration);
        setGcpPath(null);
        setWorkspaceMode('scene3d');
        activate(null);
        logEvent(
          'info',
          'sidecar',
          `${result.points.length} GCPs imported atomically · ${(performance.now() - started).toFixed(1)} ms`,
        );
      } catch (error) {
        logEvent('error', 'sidecar', `GCP import failed: ${errorMessage(error)}`);
      } finally {
        activeGcpOperationId.current = null;
        setGcpBusy(false);
      }
    },
    [acceptProject, activate, gcpBusy, projectReady],
  );

  const cancelGcpImport = useCallback(async () => {
    const operationId = activeGcpOperationId.current;
    const api = window.himmelcad;
    if (operationId && api) {
      await Promise.allSettled([
        api.sidecar.call('photolab.crs.cancel', { operationId: `${operationId}.freeze` }),
        api.sidecar.call('photolab.gcp.cancel', { operationId }),
      ]);
      logEvent('warn', 'sidecar', 'GCP import cancellation requested');
      return;
    }
    setGcpPath(null);
    activate(null);
  }, [activate]);

  useEffect(() => {
    activate('alignment.run');
    logEvent('info', 'renderer', 'PhotoLab renderer mounted · Quality Hybrid default');
    const api = window.himmelcad;
    if (!api) return;
    void api.sidecar.status().then(async (ready) => {
      setCoreReady(ready);
      logEvent(ready ? 'info' : 'warn', 'sidecar', ready ? 'PhotoLab core ready' : 'Core offline');
      if (ready && !initialBootstrapRequested.current) {
        initialBootstrapRequested.current = true;
        try {
          const opened = await api.project.bootstrap<OpenPhotolabProjectResult>();
          acceptProject(opened);
          void api.sidecar
            .call<HardwareCapabilities>('photolab.hardware.probe')
            .then((snapshot) => {
              setHardware(snapshot);
              logEvent('info', 'sidecar', `Hardware plan · ${hardwareLabel(snapshot)}`);
            })
            .catch((error: unknown) => {
              logEvent(
                'warn',
                'sidecar',
                `Hardware probe incomplete; safe CPU plan remains active: ${errorMessage(error)}`,
              );
            });
        } catch (error) {
          logEvent(
            'error',
            'sidecar',
            `Working project could not be initialized: ${errorMessage(error)}`,
          );
        }
      }
    });
    return api.sidecar.onStderr((line) => {
      const progress = parseSidecarProgress(line);
      if (progress) {
        consoleStore.push({
          level: 'info',
          source: 'sidecar',
          message: progress.message,
          timestamp: Date.now(),
          progress: progress.fraction,
          progressKey: progress.progressKey,
        });
        return;
      }
      const lower = line.toLowerCase();
      const level = lower.includes('error') ? 'error' : lower.includes('warn') ? 'warn' : 'debug';
      logEvent(level, 'sidecar', line);
    });
  }, [acceptProject, activate]);

  useEffect(() => {
    if (!projectReady) return;
    const api = window.himmelcad;
    if (!api) return;
    const autosave = window.setInterval(() => {
      void api.sidecar
        .call<{ autosaveGeneration: number; lastSavedGeneration: number; dirty: boolean }>(
          'photolab.project.autosave',
        )
        .then((result) => {
          setAutosaveGeneration(result.autosaveGeneration);
          setLastSavedGeneration(result.lastSavedGeneration);
        })
        .catch((error: unknown) => {
          logEvent('error', 'sidecar', `Autosave failed: ${errorMessage(error)}`);
        });
    }, 30_000);
    return () => window.clearInterval(autosave);
  }, [projectReady]);

  useEffect(() => {
    if (!coreReady) return;
    const api = window.himmelcad;
    if (!api) return;
    let active = true;
    const refresh = () => {
      void api.sidecar
        .call<PhotolabJob[]>('photolab.jobs.list', { includeTerminal: true })
        .then((next) => {
          if (active) {
            setJobs(next);
            jobPollErrorLogged.current = false;
          }
        })
        .catch((error: unknown) => {
          if (active && !jobPollErrorLogged.current) {
            jobPollErrorLogged.current = true;
            logEvent('error', 'sidecar', `Job status is unavailable: ${errorMessage(error)}`);
          }
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [coreReady]);

  useEffect(() => {
    const completed = [...jobs]
      .reverse()
      .find((job) => job.kind === 'optimizeAlignment' && job.state.kind === 'completed');
    if (!completed || completed.id === lastLoadedGcpOptimizationJobId.current) return;
    const api = window.himmelcad;
    if (!api) return;
    lastLoadedGcpOptimizationJobId.current = completed.id;
    void api.sidecar
      .call<GcpOptimizationPublicationRecord | null>('photolab.gcp.optimization.latest', {
        ...(activeProcessingSetId ? { processingSetId: activeProcessingSetId } : {}),
      })
      .then(setGcpOptimization)
      .catch((error: unknown) => {
        lastLoadedGcpOptimizationJobId.current = null;
        logEvent(
          'error',
          'sidecar',
          `Completed GCP optimization could not be loaded: ${errorMessage(error)}`,
        );
      });
  }, [activeProcessingSetId, jobs]);

  useEffect(() => {
    const api = window.himmelcad;
    if (!api || !projectReady) return;
    const newlyCompleted = jobs.filter(
      (job) => job.state.kind === 'completed' && !refreshedCompletedJobs.current.has(job.id),
    );
    if (newlyCompleted.length === 0) return;
    for (const job of newlyCompleted) refreshedCompletedJobs.current.add(job.id);
    void api.sidecar
      .call<OpenPhotolabProjectResult>('photolab.project.snapshot')
      .then((opened) =>
        acceptProject(opened, {
          preserveSelection: true,
          processingSetId: activeProcessingSetId,
        }),
      )
      .catch((error: unknown) => {
        logEvent(
          'error',
          'sidecar',
          `Product result could not be mirrored: ${errorMessage(error)}`,
        );
      });
  }, [acceptProject, activeProcessingSetId, jobs, projectReady]);

  const cancelJob = useCallback(async (jobId: string) => {
    const api = window.himmelcad;
    if (!api) return;
    const started = performance.now();
    try {
      const result = await api.sidecar.call<{ job: PhotolabJob }>('photolab.jobs.cancel', {
        jobId,
      });
      setJobs((previous) => previous.map((job) => (job.id === result.job.id ? result.job : job)));
      logEvent(
        'warn',
        'sidecar',
        `Cancellation confirmed for ${jobId} · ${(performance.now() - started).toFixed(1)} ms`,
      );
    } catch (error) {
      logEvent('error', 'sidecar', `Job could not be cancelled: ${errorMessage(error)}`);
    }
  }, []);

  const startAlignment = useCallback(async () => {
    const api = window.himmelcad;
    if (!api || !projectReady || alignmentStarting) return;
    if (alignmentImageCount < 2) {
      setResolveError('At least two imported images are required.');
      return;
    }
    const operationId = `alignment-${crypto.randomUUID()}`;
    setAlignmentStarting(true);
    setResolveError(null);
    const started = performance.now();
    try {
      const result = await api.sidecar.call<{ job: PhotolabJob }>('photolab.jobs.startAlignment', {
        operationId,
        profile,
        cameraEntityIds: alignmentScope === 'selection' ? selectedCameraIds : [],
      });
      setJobs((previous) => [...previous.filter((job) => job.id !== result.job.id), result.job]);
      logEvent(
        'info',
        'sidecar',
        `Photo alignment queued · ${profileLabel(profile)} · ${(performance.now() - started).toFixed(1)} ms`,
      );
    } catch (error) {
      const message = errorMessage(error);
      setResolveError(message);
      logEvent('error', 'sidecar', `Photo alignment could not start: ${message}`);
    } finally {
      setAlignmentStarting(false);
    }
  }, [
    alignmentImageCount,
    alignmentScope,
    alignmentStarting,
    profile,
    projectReady,
    selectedCameraIds,
  ]);

  const startProduct = useCallback(
    async (configuration: ProductRunConfiguration) => {
      const api = window.himmelcad;
      if (!api || !projectReady || productStarting) return;
      const operationId = `${configuration.kind}-${crypto.randomUUID()}`;
      setProductStarting(true);
      const started = performance.now();
      try {
        const result = await api.sidecar.call<{ job: PhotolabJob }>('photolab.jobs.startProduct', {
          operationId,
          configuration,
          processingSetId: activeProcessingSetId,
        });
        setJobs((previous) => [...previous.filter((job) => job.id !== result.job.id), result.job]);
        logEvent(
          'info',
          'sidecar',
          `${productLabel(configuration.kind)} queued · ${(performance.now() - started).toFixed(1)} ms`,
        );
      } catch (error) {
        logEvent(
          'error',
          'sidecar',
          `${productLabel(configuration.kind)} could not start: ${errorMessage(error)}`,
        );
      } finally {
        setProductStarting(false);
      }
    },
    [activeProcessingSetId, productStarting, projectReady],
  );

  const startBatch = useCallback(
    async (
      steps: BatchPipelineStep[],
      cameraEntityIds: readonly EntityId[],
      scopeLabel: string,
    ) => {
      const api = window.himmelcad;
      if (!api || !projectReady || batchStarting || steps.length === 0) return;
      setBatchStarting(true);
      try {
        const operationId = `batch-${crypto.randomUUID()}`;
        const result = await api.sidecar.call<{ job: PhotolabJob }>('photolab.jobs.startBatch', {
          operationId,
          steps,
          cameraEntityIds,
        });
        setJobs((previous) => [...previous.filter((job) => job.id !== result.job.id), result.job]);
        logEvent(
          'info',
          'sidecar',
          `Batch queued · ${steps.length} nodes · ${scopeLabel} · automatic recovery active`,
        );
        toggleBottom();
      } catch (error) {
        logEvent('error', 'sidecar', `Batch could not start: ${errorMessage(error)}`);
      } finally {
        setBatchStarting(false);
      }
    },
    [batchStarting, projectReady, toggleBottom],
  );

  const startGcpOptimization = useCallback(
    async (selection: GcpOptimizationSelection) => {
      const api = window.himmelcad;
      if (!api || !projectReady || !gcpCollection || gcpOptimizationStarting) return;
      const activePointIds = selection.pointIds.filter(
        (pointId) => selection.roleOverrides[pointId] !== 'disabled',
      );
      const snapshotOperationId = `gcp-snapshot-${crypto.randomUUID()}`;
      const operationId = `gcp-optimize-${crypto.randomUUID()}`;
      const processingSet = findMatchingProcessingSet(
        processingSets,
        alignedGcpCameras.map((camera) => camera.entityId),
      );
      setGcpOptimizationStarting(true);
      try {
        const snapshot = await api.sidecar.call<GcpOptimizationSnapshotResult>(
          'photolab.gcp.optimization.snapshot',
          {
            operationId: snapshotOperationId,
            expectedCollectionSha256: gcpCollection[0],
            scope: {
              label: processingSet
                ? `${processingSet.name} · ${alignedGcpCameras.length} cameras · ${activePointIds.length} points`
                : `Ad-hoc alignment · ${alignedGcpCameras.length} cameras · ${activePointIds.length} points`,
              pointIds: activePointIds,
              cameraReferenceImageIds: selection.cameraReferenceImageIds,
            },
            roleOverrides: selection.roleOverrides,
          },
        );
        setAutosaveGeneration(snapshot.autosaveGeneration);
        const result = await api.sidecar.call<{ job: PhotolabJob }>(
          'photolab.jobs.startGcpOptimization',
          {
            operationId,
            snapshotSha256: snapshot.snapshotSha256,
            ...(processingSet ? { processingSetId: processingSet.entityId } : {}),
          },
        );
        setJobs((previous) => [...previous.filter((job) => job.id !== result.job.id), result.job]);
        logEvent(
          'info',
          'sidecar',
          `GCP optimization queued · ${activePointIds.length} points · snapshot ${snapshot.snapshotSha256.slice(0, 12)}`,
        );
      } catch (error) {
        logEvent('error', 'sidecar', `GCP optimization could not start: ${errorMessage(error)}`);
      } finally {
        setGcpOptimizationStarting(false);
      }
    },
    [alignedGcpCameras, gcpCollection, gcpOptimizationStarting, processingSets, projectReady],
  );

  const commitGcpMeasurement = useCallback(
    async (measurement: GcpManualMeasurement) => {
      const api = window.himmelcad;
      if (!api || !gcpCollection) return;
      const operationId = `gcp-measure-${crypto.randomUUID()}`;
      try {
        const result = await api.sidecar.call<{
          collectionSha256: ObjectHash;
          autosaveGeneration: number;
          insertedCount: number;
          replacedCount: number;
        }>('photolab.gcp.observation.upsertAssisted', {
          operationId,
          expectedCollectionSha256: gcpCollection[0],
          observation: {
            pointId: measurement.pointId,
            imageId: measurement.imageId,
            state: { state: 'manual', coordinate: measurement.coordinate },
          },
          maximumSeedDistancePixels: 3,
        });
        setAutosaveGeneration(result.autosaveGeneration);
        const updated = await api.sidecar.call<readonly [ObjectHash, GcpCollectionRecord] | null>(
          'photolab.gcp.list',
        );
        setGcpCollection(updated);
        logEvent(
          'info',
          'sidecar',
          `GCP measurement saved · ${measurement.pointId} · ${result.insertedCount + result.replacedCount - 1} tie-point projections`,
        );
      } catch (error) {
        logEvent('error', 'sidecar', `GCP measurement failed: ${errorMessage(error)}`);
      }
    },
    [gcpCollection],
  );

  const editGcpObservation = useCallback(
    async (marker: GcpImageMarker, edit: GcpObservationEdit) => {
      const api = window.himmelcad;
      if (!api || !gcpCollection) return;
      const operationId = `gcp-observation-${crypto.randomUUID()}`;
      try {
        const result = await api.sidecar.call<{
          collectionSha256: ObjectHash;
          autosaveGeneration: number;
        }>('photolab.gcp.observation.edit', {
          operationId,
          expectedCollectionSha256: gcpCollection[0],
          pointId: marker.pointId,
          imageId: marker.imageId,
          edit,
        });
        setAutosaveGeneration(result.autosaveGeneration);
        const updated = await api.sidecar.call<readonly [ObjectHash, GcpCollectionRecord] | null>(
          'photolab.gcp.list',
        );
        setGcpCollection(updated);
        logEvent('info', 'sidecar', `GCP observation ${edit.action} completed · ${marker.pointId}`);
      } catch (error) {
        logEvent('error', 'sidecar', `GCP observation edit failed: ${errorMessage(error)}`);
      }
    },
    [gcpCollection],
  );

  const gcpAccuracyReport = useMemo<GcpAccuracyReport | null>(() => {
    if (!gcpOptimization || !gcpCollection) return null;
    const result = gcpOptimization.artifact.result;
    const names = new Map(gcpCollection[1].points.map(({ point }) => [point.id, point.name]));
    const counts = new Map(result.points.map((point) => [point.pointId, point.observationCount]));
    const processingSet = findMatchingProcessingSet(
      processingSets,
      alignedGcpCameras.map((camera) => camera.entityId),
    );
    return {
      label: result.converged
        ? `Optimization converged · ${result.iterations} iterations`
        : `Optimization completed · ${result.iterations} iterations`,
      processingSetLabel: processingSet
        ? `${processingSet.name} · gespeicherter Scope`
        : `Ad-hoc alignment · ${alignedGcpCameras.length} cameras`,
      alignmentRunLabel: gcpOptimization.operationId,
      optimizationSnapshotSha256: gcpOptimization.snapshotSha256,
      cameraCount: alignedGcpCameras.length,
      residuals: result.residuals.map((residual) => ({
        ...residual,
        pointName: names.get(residual.pointId) ?? residual.pointId,
        observationCount: counts.get(residual.pointId) ?? 0,
      })),
      ...(result.statistics.control ? { control: result.statistics.control } : {}),
      ...(result.statistics.checkpoint ? { checkpoint: result.statistics.checkpoint } : {}),
    };
  }, [alignedGcpCameras, gcpCollection, gcpOptimization, processingSets]);

  const gcpCameraReferences = useMemo(() => {
    const imagesByEntity = new Map(projectImages.map((image) => [image.entityId, image]));
    return alignedGcpCameras.map((camera) => {
      const image = imagesByEntity.get(camera.entityId);
      const reference = image?.metadata.projectedReference;
      const rtk = image?.metadata.inspectedPhoto.metadata.djiXmp.rtk;
      const horizontal = Math.max(
        rtk?.standardDeviationLongitudeMeters ?? 0,
        rtk?.standardDeviationLatitudeMeters ?? 0,
      );
      const height = rtk?.standardDeviationHeightMeters;
      const accuracyLabel =
        horizontal > 0 || (height != null && height > 0)
          ? `σ XY ${horizontal > 0 ? horizontal.toFixed(3) : '—'} m · Z ${height != null && height > 0 ? height.toFixed(3) : '—'} m`
          : image?.metadata.statusTags.includes('rtkFixed')
            ? 'RTK fixed · default σ 0.03 / 0.06 m'
            : 'GPS · default σ 5 / 10 m';
      return {
        imageId: camera.imageId,
        name: camera.imageName,
        referenceAvailable: reference?.transformedHeightMeters != null,
        accuracyLabel,
      };
    });
  }, [alignedGcpCameras, projectImages]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveProject();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveProject]);

  useEffect(() => {
    if (workspaceMode === 'images') return;
    viewportRef.current?.setNavigationMode(
      workspaceMode === 'map2d' ? 'lockedTopDown2d' : 'orbit3d',
    );
  }, [workspaceMode]);

  useEffect(() => {
    if (workspaceMode === 'images') return;
    const alignedByEntity = new Map(
      alignedGcpCameras.map((entry) => [entry.entityId, entry] as const),
    );
    const optimizedByImageId = new Map(
      (gcpOptimization?.artifact.result.cameras ?? []).map((camera) => [camera.imageId, camera]),
    );
    viewportRef.current?.setCameraImageRectangles(
      projectImages
        .filter((image) => project.entities[image.entityId]?.visibility.visible !== false)
        .flatMap((image) => {
          const aligned = alignedByEntity.get(image.entityId);
          const optimized = aligned ? optimizedByImageId.get(aligned.imageId) : undefined;
          return initialCameraRectangle(
            image,
            optimized
              ? {
                  widthPixels: optimized.widthPixels,
                  heightPixels: optimized.heightPixels,
                  focalXPixels: optimized.focalXPixels,
                  focalYPixels: optimized.focalYPixels,
                  cameraToWorldRotation: optimized.cameraToWorldRotation,
                  centerWorld: optimized.centerWorldMeters,
                }
              : aligned
                ? {
                    widthPixels: aligned.camera.widthPixels,
                    heightPixels: aligned.camera.heightPixels,
                    focalXPixels: aligned.camera.focalXPixels,
                    focalYPixels: aligned.camera.focalYPixels,
                    cameraToWorldRotation: aligned.camera.cameraToReconstructionRotation,
                    centerWorld: aligned.camera.centerReconstruction,
                  }
                : undefined,
          );
        }),
    );
  }, [alignedGcpCameras, gcpOptimization, project.entities, projectImages, workspaceMode]);

  useEffect(() => {
    if (workspaceMode === 'images') return;
    const records = gcpCollection?.[1].points ?? [];
    const entityByName = new Map(
      Object.values(project.entities)
        .filter((entity) => entity.kind === 'GroundControlPoint')
        .map((entity) => [entity.name, entity]),
    );
    const markers = records.flatMap<GcpMarker>((record) => {
      const entity = entityByName.get(record.point.name);
      if (!entity?.visibility.visible) return [];
      const coordinate = record.point.coordinate;
      return [
        {
          entityId: entity.id,
          name: record.point.name,
          position: [coordinate.eastMeters, coordinate.northMeters, coordinate.heightMeters],
          role: record.point.role,
        },
      ];
    });
    viewportRef.current?.setGcpMarkers(markers);
  }, [gcpCollection, project.entities, workspaceMode]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (workspaceMode === 'images') {
      for (const entityId of loadedProductIds.current) viewport?.removeLayer(entityId);
      loadedProductIds.current.clear();
      return;
    }
    if (!viewport) return;
    let active = true;
    const visibleIds = new Set(
      productDatasets.filter((dataset) => dataset.visible).map((dataset) => dataset.entityId),
    );
    for (const entityId of loadedProductIds.current) {
      if (visibleIds.has(entityId)) continue;
      viewport.removeLayer(entityId);
      loadedProductIds.current.delete(entityId);
    }
    const dem = productDatasets.find((dataset) => dataset.kind === 'dem' && dataset.visible);
    for (const dataset of productDatasets) {
      if (!dataset.visible) continue;
      if (loadedProductIds.current.has(dataset.entityId)) continue;
      const url = projectProductUrl(dataset.relativePath);
      const renderOffset: [number, number, number] = [
        project.renderOffset.x,
        project.renderOffset.y,
        project.renderOffset.z,
      ];
      const loading =
        (dataset.kind === 'dense' || dataset.kind === 'sparse') &&
        dataset.format === 'potreeV2' &&
        dataset.boundsMin &&
        dataset.boundsMax &&
        dataset.renderOffset &&
        dataset.pointCount != null
          ? viewport.loadPotreePointCloud(url, {
              entityId: dataset.entityId,
              sourceName: dataset.kind === 'sparse' ? 'Sparse Point Cloud' : 'Dense Point Cloud',
              renderOffset: dataset.renderOffset,
              bounds: { min: dataset.boundsMin, max: dataset.boundsMax },
              pointCount: dataset.pointCount,
            })
          : dataset.kind === 'gaussianSplat'
            ? viewport.loadGaussianSplats(url, {
                entityId: dataset.entityId,
                format: dataset.format === 'brushPly' ? 'brushPly' : 'prepared',
                renderOffset,
              })
            : dataset.kind === 'mesh'
              ? viewport.loadTiledMesh(url, {
                  entityId: dataset.entityId,
                  renderOffset,
                })
              : dataset.kind === 'dem' || dataset.kind === 'orthomosaic'
                ? viewport.loadRasterPyramid(url, {
                    entityId: dataset.entityId,
                    kind: dataset.kind,
                    renderOffset,
                    ...(dataset.kind === 'orthomosaic' && dem
                      ? { terrainManifestUrl: projectProductUrl(dem.relativePath) }
                      : {}),
                  })
                : null;
      if (!loading) continue;
      void loading
        .then(() => {
          if (!active) {
            viewport.removeLayer(dataset.entityId);
            return;
          }
          loadedProductIds.current.add(dataset.entityId);
          logEvent(
            'info',
            'renderer',
            `${productDatasetLabel(dataset.kind)} loaded · ${dataset.entityId}`,
          );
        })
        .catch((error: unknown) => {
          logEvent('error', 'renderer', `Product could not be loaded: ${errorMessage(error)}`);
        });
    }
    return () => {
      active = false;
    };
  }, [productDatasets, project.renderOffset, workspaceMode]);

  const switchWorkspace = useCallback(
    (mode: WorkspaceMode) => {
      setWorkspaceMode(mode);
      activate(null);
    },
    [activate],
  );

  const runEntityCommand = useCallback(
    async (method: string, params: Record<string, unknown>, successMessage: string) => {
      const api = window.himmelcad;
      if (!api || !projectReady) return;
      try {
        const opened = await api.sidecar.call<OpenPhotolabProjectResult>(method, params);
        acceptProject(opened);
        logEvent('info', 'sidecar', successMessage);
      } catch (error) {
        logEvent('error', 'sidecar', `Entity tree could not be changed: ${errorMessage(error)}`);
      }
    },
    [acceptProject, projectReady],
  );

  const saveProcessingSet = useCallback(async () => {
    const api = window.himmelcad;
    if (!api || processingSetSaving || selectedCameraIds.length < 2) return;
    const cameraEntityIds = [...selectedCameraIds];
    const sortedCameraEntityIds = [...cameraEntityIds].sort();
    const name = `Processing Set ${processingSets.length + 1}`;
    const previousIds = new Set(processingSets.map((processingSet) => processingSet.entityId));
    setProcessingSetSaving(true);
    try {
      const opened = await api.sidecar.call<OpenPhotolabProjectResult>(
        'photolab.project.processingSet.create',
        { name, cameraEntityIds },
      );
      acceptProject(opened);
      const refreshed = await api.sidecar.call<ProcessingSetRecord[]>(
        'photolab.project.processingSet.list',
      );
      setProcessingSets(refreshed);
      const created = refreshed.find(
        (processingSet) =>
          !previousIds.has(processingSet.entityId) &&
          processingSet.cameraEntityIds.length === cameraEntityIds.length &&
          [...processingSet.cameraEntityIds]
            .sort()
            .every((entityId, index) => entityId === sortedCameraEntityIds[index]),
      );
      setSelected(new Set(cameraEntityIds));
      setAlignmentScope('selection');
      setActiveProcessingSetId(created?.entityId ?? null);
      logEvent(
        'info',
        'sidecar',
        `${name} saved · ${cameraEntityIds.length} immutable camera references`,
      );
    } catch (error) {
      logEvent('error', 'sidecar', `Processing set could not be saved: ${errorMessage(error)}`);
    } finally {
      setProcessingSetSaving(false);
    }
  }, [acceptProject, processingSetSaving, processingSets, selectedCameraIds]);

  const activateProcessingSet = useCallback(
    (processingSetId: EntityId) => {
      const processingSet = processingSets.find(
        (candidate) => candidate.entityId === processingSetId,
      );
      if (!processingSet) {
        logEvent('error', 'renderer', `Processing set ${processingSetId} is unavailable.`);
        return;
      }
      setSelected(new Set(processingSet.cameraEntityIds));
      setAlignmentScope('selection');
      setActiveProcessingSetId(processingSet.entityId);
      setResolved(null);
      void window.himmelcad?.sidecar
        .call<AlignedGcpCameraRecord[]>('photolab.gcp.alignedCameras', {
          processingSetId: processingSet.entityId,
        })
        .then(setAlignedGcpCameras)
        .catch((error: unknown) => {
          setAlignedGcpCameras([]);
          logEvent(
            'error',
            'sidecar',
            `Aligned cameras for ${processingSet.name} could not be loaded: ${errorMessage(error)}`,
          );
        });
      void window.himmelcad?.sidecar
        .call<GcpOptimizationPublicationRecord | null>('photolab.gcp.optimization.latest', {
          processingSetId: processingSet.entityId,
        })
        .then(setGcpOptimization)
        .catch((error: unknown) => {
          setGcpOptimization(null);
          logEvent(
            'warn',
            'sidecar',
            `No compatible GCP optimization is available for ${processingSet.name}: ${errorMessage(error)}`,
          );
        });
      logEvent(
        'info',
        'renderer',
        `${processingSet.name} activated · ${processingSet.cameraEntityIds.length} cameras · immutable scope`,
      );
    },
    [processingSets],
  );

  const exportProduct = useCallback(
    async (id: EntityId) => {
      const api = window.himmelcad;
      const entity = project.entities[id];
      const dataset = productDatasets.find((candidate) => candidate.entityId === id);
      if (!api || !entity || !dataset) return;
      try {
        const result = await api.products.export<{ job: PhotolabJob }>({
          entityId: id,
          kind: dataset.kind,
          name: entity.name,
        });
        if (!result) return;
        setJobs((previous) => [...previous.filter((job) => job.id !== result.job.id), result.job]);
        logEvent('info', 'sidecar', `Export queued · ${entity.name}`);
        toggleBottom();
      } catch (error) {
        logEvent('error', 'sidecar', `Product could not be exported: ${errorMessage(error)}`);
      }
    },
    [productDatasets, project.entities, toggleBottom],
  );

  const handleTreeContextAction = useCallback(
    (id: EntityId, action: 'showGcpImages' | 'open' | 'properties' | 'export') => {
      const entity = project.entities[id];
      if (!entity) return;
      if (action === 'export') {
        void exportProduct(id);
      } else if (action === 'open' && entity.kind === 'ProcessingSet') {
        const processingSet = processingSets.find((candidate) => candidate.entityId === id);
        if (!processingSet) return;
        activateProcessingSet(processingSet.entityId);
        setWorkspaceMode('scene3d');
        activate('alignment.run');
      } else if (action === 'showGcpImages') {
        const pointId = gcpCollection?.[1].points.find(({ point }) => point.name === entity.name)
          ?.point.id;
        setFocusedGcpId(pointId ?? null);
        setWorkspaceMode('images');
        activate(null);
        logEvent('info', 'renderer', `Filtering images containing GCP “${entity.name}”`);
      } else if (action === 'open') {
        setFocusedGcpId(null);
        setWorkspaceMode(entity.kind === 'CameraImage' ? 'images' : 'scene3d');
        activate(null);
      } else {
        setSelected(new Set([id]));
        activate(null);
      }
    },
    [
      activate,
      activateProcessingSet,
      exportProduct,
      gcpCollection,
      processingSets,
      project.entities,
    ],
  );

  const ribbonTabs = useMemo(
    () =>
      createPhotolabRibbonTabs({
        onNewProject: () => void createProject(),
        onOpenProject: () => void openProject(),
        onSaveProject: () => void saveProject(),
        onSaveProjectAs: () => void saveProjectAs(),
        onImportFiles: () => void inspectImages('files'),
        onImportFolder: () => void inspectImages('folder'),
        onImportGcps: () => void chooseGcpCsv(),
        onViewScene: () => switchWorkspace('scene3d'),
        onViewMap: () => switchWorkspace('map2d'),
        onViewImages: () => switchWorkspace('images'),
        onActivateFunction: activate,
      }),
    [
      chooseGcpCsv,
      createProject,
      inspectImages,
      openProject,
      saveProject,
      saveProjectAs,
      switchWorkspace,
      activate,
    ],
  );

  const windowControls = useMemo<WindowControls | null>(() => {
    const api = window.himmelcad;
    if (!api) return null;
    return {
      minimize: () => void api.window.minimize(),
      maximizeToggle: () => void api.window.maximizeToggle(),
      close: () => void api.window.close(),
      isMaximized: () => api.window.isMaximized(),
      onMaximizeChange: (callback) => api.window.onMaximizeChange(callback),
    };
  }, []);

  const statusItems = useMemo(
    () => [
      {
        id: 'core',
        content: coreReady ? '● Core ready' : '○ Core offline',
        align: 'left' as const,
      },
      { id: 'profile', content: `Profile: ${profileLabel(profile)}`, align: 'left' as const },
      {
        id: 'hardware',
        content: hardware ? hardwareLabel(hardware) : 'Hardware: probing…',
        align: 'left' as const,
      },
      { id: 'view', content: `View: ${workspaceLabel(workspaceMode)}`, align: 'left' as const },
      {
        id: 'autosave',
        content: projectReady
          ? `Autosave: ${autosaveGeneration === lastSavedGeneration ? 'saved' : `local · ${autosaveGeneration}`}`
          : 'Autosave: initializing…',
        align: 'left' as const,
      },
      { id: 'images', content: `Images: ${imageCount}`, align: 'right' as const },
      {
        id: 'gcps',
        content: `GCPs: ${gcpCollection?.[1].points.length ?? 0}`,
        align: 'right' as const,
      },
      { id: 'snap', content: snap ? `Snap: ${snap.kind}` : 'Snap: —', align: 'right' as const },
      { id: 'units', content: 'Z-Up · m', align: 'right' as const },
      { id: 'panels', content: <PanelToggles />, align: 'right' as const },
    ],
    [
      autosaveGeneration,
      coreReady,
      gcpCollection,
      hardware,
      imageCount,
      lastSavedGeneration,
      profile,
      projectReady,
      snap,
      workspaceMode,
    ],
  );

  const onSelect = (id: EntityId, mode: 'replace' | 'add' | 'toggle') => {
    setActiveProcessingSetId(null);
    setSelected((previous) => {
      const next = new Set(previous);
      if (mode === 'replace') {
        next.clear();
        next.add(id);
      } else if (mode === 'add') next.add(id);
      else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onCommand = (raw: string) => {
    const [command, argument] = raw.trim().split(/\s+/, 2);
    if (command === 'alignment.resolve') {
      void resolveProfile();
    } else if (command === 'alignment.run') {
      void startAlignment();
    } else if (command === 'alignment.profile' && isProfile(argument)) {
      setProfile(argument);
      activate('alignment.run');
    } else if (command === 'product.run' && isProductOperation(argument)) {
      void startProduct(defaultProductConfiguration(argument));
    } else if (command === 'batch.run') {
      activate('batch.configure');
    } else if (command === 'project.save') {
      void saveProject();
    } else {
      logEvent(
        'warn',
        'renderer',
        'Commands: alignment.resolve · alignment.run · alignment.profile qualityHybrid|maximumRobustness|fast · product.run depth|dense|dem|ortho|mesh|splat · batch.run · project.save',
      );
    }
  };

  const productOperation = productOperationFromFunctionId(activeFunctionId);

  return (
    <AppShell
      titleBar={
        <TitleBar
          appName="HimmelCAD"
          productLabel="PhotoLab"
          projectLabel={project.name}
          controls={windowControls}
          rightSlot={<span className={styles.titleStatus}>OFFLINE PIPELINE</span>}
        />
      }
      ribbon={<Ribbon tabs={ribbonTabs} />}
      leftPanel={
        <EntityTree
          project={project}
          selectedIds={selected}
          onSelect={onSelect}
          onRename={(entityId, name) =>
            void runEntityCommand(
              'photolab.project.entity.rename',
              { entityId, name },
              `Entity renamed · ${name}`,
            )
          }
          onMove={(entityId, newParentId) =>
            void runEntityCommand(
              'photolab.project.entity.move',
              { entityId, newParentId },
              'Entity moved in the project tree',
            )
          }
          onVisibilityChange={(entityId, visible) =>
            void runEntityCommand(
              'photolab.project.entity.visibility',
              { entityId, visible },
              visible ? 'Entity shown' : 'Entity hidden',
            )
          }
          onContextAction={handleTreeContextAction}
        />
      }
      rightPanel={
        <FunctionPanel
          activeFunctionId={activeFunctionId}
          title={
            activeFunctionId === 'alignment.run'
              ? 'Align Photos'
              : activeFunctionId === 'alignment.optimize'
                ? 'Optimize Alignment'
                : activeFunctionId === 'images.import.review'
                  ? 'Import Images'
                  : activeFunctionId === 'reference.gcp.import'
                    ? 'Import GCPs'
                    : activeFunctionId === 'batch.configure' || activeFunctionId === 'batch.queue'
                      ? 'Batchprocessing'
                      : isProjectDiagnosticsKind(activeFunctionId)
                        ? diagnosticsTitle(activeFunctionId)
                        : productOperation
                          ? productLabel(productOperation)
                          : undefined
          }
        >
          {activeFunctionId === 'alignment.run' ? (
            <AlignmentProfilePanel
              profile={profile}
              imageCount={alignmentImageCount}
              totalImageCount={projectImages.length}
              selectedImageCount={selectedCameraIds.length}
              scope={alignmentScope}
              processingSets={processingSets}
              activeProcessingSetId={activeProcessingSetId}
              resolving={resolving}
              starting={alignmentStarting}
              savingProcessingSet={processingSetSaving}
              canStart={projectReady && alignmentImageCount >= 2}
              resolved={resolved}
              error={resolveError}
              onProfileChange={(next) => {
                setProfile(next);
                setResolved(null);
              }}
              onScopeChange={(next) => {
                setAlignmentScope(next);
                setActiveProcessingSetId(null);
                setResolved(null);
              }}
              onProcessingSetChange={activateProcessingSet}
              onResolve={() => void resolveProfile()}
              onStart={() => void startAlignment()}
              onSaveProcessingSet={() => void saveProcessingSet()}
            />
          ) : activeFunctionId === 'alignment.optimize' ? (
            <GcpOptimizationPanel
              collection={gcpCollection?.[1] ?? null}
              cameras={gcpCameraReferences}
              busy={gcpOptimizationStarting}
              onStart={(selection) => void startGcpOptimization(selection)}
            />
          ) : activeFunctionId === 'images.import.review' && imageImportBatch ? (
            <ImageImportPanel
              batch={imageImportBatch}
              busy={imageImportBusy}
              onChooseMoreFiles={() => void inspectImages('files')}
              onChooseFolder={() => void inspectImages('folder')}
              onDiscoverCrs={discoverImageCrs}
              onCommit={commitImageImport}
              onCancel={() => void cancelImageImport()}
            />
          ) : activeFunctionId === 'reference.gcp.import' ? (
            <GcpImportPanel
              path={gcpPath}
              projectTargetCrs={projectTargetCrs}
              projectImages={projectImages}
              busy={gcpBusy}
              onChooseFile={() => void chooseGcpCsv()}
              onPreview={previewGcpCsv}
              onDiscoverCrs={discoverImageCrs}
              onCommit={commitGcpCsv}
              onCancel={() => void cancelGcpImport()}
            />
          ) : activeFunctionId === 'batch.configure' || activeFunctionId === 'batch.queue' ? (
            <BatchConfiguratorPanel
              busy={batchStarting}
              canStart={projectReady && projectImages.length >= 2}
              allCameraIds={projectImages.map((image) => image.entityId)}
              selectedCameraIds={selectedCameraIds}
              processingSets={processingSets}
              activeProcessingSetId={activeProcessingSetId}
              onActivateProcessingSet={activateProcessingSet}
              onClearProcessingSet={() => setActiveProcessingSetId(null)}
              onStart={(steps, cameraEntityIds, scopeLabel) =>
                void startBatch(steps, cameraEntityIds, scopeLabel)
              }
            />
          ) : isProjectDiagnosticsKind(activeFunctionId) ? (
            <ProjectDiagnosticsPanel
              kind={activeFunctionId}
              images={projectImages}
              alignedCameras={alignedGcpCameras}
              jobs={jobs}
              projectTargetCrs={projectTargetCrs}
              gcpOptimization={gcpOptimization}
            />
          ) : productOperation ? (
            <ProductPanel
              operation={productOperation}
              busy={productStarting}
              inputLabel={
                processingSets.find((set) => set.entityId === activeProcessingSetId)?.name ??
                'latest published alignment'
              }
              onStart={(configuration) => void startProduct(configuration)}
            />
          ) : null}
        </FunctionPanel>
      }
      bottomPanel={
        <PhotolabBottomPanel
          jobs={jobs}
          onCommand={onCommand}
          onCancelJob={(jobId) => void cancelJob(jobId)}
          onCollapse={toggleBottom}
          accuracyReport={gcpAccuracyReport}
          hardware={hardware}
          products={productDatasets}
        />
      }
      viewport={
        workspaceMode === 'images' ? (
          <ImageWorkspace
            batch={imageImportBatch}
            projectImages={projectImages}
            alignedCameras={alignedGcpCameras}
            gcpCollection={gcpCollection?.[1] ?? null}
            gcpOptimization={gcpOptimization}
            focusedGcpId={focusedGcpId}
            onCommitGcpMeasurement={(measurement) => void commitGcpMeasurement(measurement)}
            onEditGcpObservation={(marker, edit) => void editGcpObservation(marker, edit)}
            depthDatasets={productDatasets.filter((dataset) => dataset.kind === 'depth')}
          />
        ) : (
          <Viewport
            ref={viewportRef}
            onCursorSnap={setSnap}
            onLog={(level, message) => logEvent(level, 'renderer', message)}
          />
        )
      }
      statusBar={<StatusBar items={statusItems} />}
    />
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasFixedDjiRtk(
  metadata: ProjectCameraImageRecord['metadata']['inspectedPhoto']['metadata'],
): boolean {
  const rtk = metadata.djiXmp.rtk;
  if (!rtk) return false;
  const flag = rtk.flag?.trim().toLowerCase();
  const fixedFlag = flag === '50' || flag === 'fixed';
  const horizontal =
    rtk.standardDeviationLongitudeMeters != null &&
    rtk.standardDeviationLatitudeMeters != null &&
    rtk.standardDeviationLongitudeMeters <= 0.1 &&
    rtk.standardDeviationLatitudeMeters <= 0.1;
  const vertical =
    rtk.standardDeviationHeightMeters == null || rtk.standardDeviationHeightMeters <= 0.2;
  return fixedFlag && horizontal && vertical;
}

function mergePhotoBatches(
  previous: PhotoImportBatch | null,
  incoming: PhotoImportBatch,
): PhotoImportBatch {
  if (!previous) return incoming;
  const firstPathByHash = new Map(previous.photos.map((photo) => [photo.sha256, photo.sourcePath]));
  const photos = [...previous.photos];
  const warnings = [...previous.warnings, ...incoming.warnings];
  for (const photo of incoming.photos) {
    const duplicateOf = photo.duplicateOf ?? firstPathByHash.get(photo.sha256);
    photos.push({ ...photo, ...(duplicateOf ? { duplicateOf } : {}) });
    if (!duplicateOf) firstPathByHash.set(photo.sha256, photo.sourcePath);
  }
  return { photos, warnings };
}

function profileLabel(profile: AlignmentQualityProfile): string {
  if (profile === 'qualityHybrid') return 'Quality Hybrid';
  if (profile === 'maximumRobustness') return 'Maximum Robustness';
  return 'Fast';
}

function isProfile(value: string | undefined): value is AlignmentQualityProfile {
  return value === 'qualityHybrid' || value === 'maximumRobustness' || value === 'fast';
}

function workspaceLabel(mode: WorkspaceMode): string {
  if (mode === 'scene3d') return '3D-Szene';
  if (mode === 'map2d') return '2D Map · locked';
  return 'Images / Depth';
}

function hardwareLabel(hardware: HardwareCapabilities): string {
  const backend = hardware.cuda
    ? `CUDA ${hardware.cuda.computeCapability.major}.${hardware.cuda.computeCapability.minor}`
    : hardware.vulkan
      ? `Vulkan ${hardware.vulkan.apiVersion}`
      : 'CPU';
  const ram = hardware.ramBytes / 1024 ** 3;
  const vram = hardware.dedicatedVramBytes
    ? ` · VRAM ${(hardware.dedicatedVramBytes / 1024 ** 3).toFixed(1)} GB`
    : '';
  return `${backend} · RAM ${ram.toFixed(1)} GB${vram}`;
}

function productOperationFromFunctionId(id: string | null): ProductOperation | null {
  if (id === 'products.depth') return 'depth';
  if (id === 'products.dense') return 'dense';
  if (id === 'products.dem') return 'dem';
  if (id === 'products.ortho') return 'ortho';
  if (id === 'products.mesh') return 'mesh';
  if (id === 'products.splat') return 'splat';
  return null;
}

function isProductOperation(value: string | undefined): value is ProductOperation {
  return (
    value === 'depth' ||
    value === 'dense' ||
    value === 'dem' ||
    value === 'ortho' ||
    value === 'mesh' ||
    value === 'splat'
  );
}

function productLabel(operation: ProductOperation): string {
  if (operation === 'depth') return 'Depth Maps';
  if (operation === 'dense') return 'Dense Point Cloud';
  if (operation === 'dem') return 'DEM';
  if (operation === 'ortho') return 'Orthomosaic';
  if (operation === 'mesh') return 'Textured Mesh';
  return 'Gaussian Splat';
}

function productDatasetLabel(kind: ProjectProductDatasetRecord['kind']): string {
  if (kind === 'gaussianSplat') return 'Gaussian Splat';
  if (kind === 'sparse') return 'Sparse Point Cloud';
  if (kind === 'dense') return 'Dense Point Cloud';
  if (kind === 'dem') return 'DEM Pyramid';
  if (kind === 'orthomosaic') return 'Orthomosaic Pyramid';
  return 'Mesh';
}

function isProjectDiagnosticsKind(value: string | null): value is ProjectDiagnosticsKind {
  return (
    value === 'images.metadata' ||
    value === 'images.quality' ||
    value === 'reference.transform' ||
    value === 'alignment.report'
  );
}

function diagnosticsTitle(kind: ProjectDiagnosticsKind): string {
  if (kind === 'images.metadata') return 'Image Metadata';
  if (kind === 'images.quality') return 'Image Status';
  if (kind === 'reference.transform') return 'Reference Frame';
  return 'Alignment Report';
}

function findMatchingProcessingSet(
  processingSets: readonly ProcessingSetRecord[],
  cameraEntityIds: readonly EntityId[],
): ProcessingSetRecord | undefined {
  const sortedCameraEntityIds = [...cameraEntityIds].sort();
  return processingSets.find(
    (candidate) =>
      candidate.cameraEntityIds.length === sortedCameraEntityIds.length &&
      [...candidate.cameraEntityIds]
        .sort()
        .every((entityId, index) => entityId === sortedCameraEntityIds[index]),
  );
}

function projectProductUrl(relativePath: string): string {
  const encoded = relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `hcad-product://project/${encoded}`;
}

interface AlignedCameraRectanglePose {
  widthPixels: number;
  heightPixels: number;
  focalXPixels: number;
  focalYPixels: number;
  cameraToWorldRotation: [number, number, number, number, number, number, number, number, number];
  centerWorld: [number, number, number];
}

function initialCameraRectangle(
  record: ProjectCameraImageRecord,
  aligned?: AlignedCameraRectanglePose,
): CameraImageRectangle[] {
  if (aligned) return alignedCameraRectangle(record, aligned);
  const reference = record.metadata.projectedReference;
  if (!reference) return [];
  const photo = record.metadata.inspectedPhoto;
  const attitude = photo.metadata.djiXmp.gimbalAttitude ?? photo.metadata.djiXmp.flightAttitude;
  const yaw = degreesToRadians(attitude?.yaw ?? 0);
  const pitch = degreesToRadians(attitude?.pitch ?? -90);
  const roll = degreesToRadians(attitude?.roll ?? 0);
  const center: [number, number, number] = [
    reference.easting,
    reference.northing,
    reference.transformedHeightMeters ?? reference.sourceHeightMeters ?? 0,
  ];
  const forward = normalize3([
    Math.sin(yaw) * Math.cos(pitch),
    Math.cos(yaw) * Math.cos(pitch),
    Math.sin(pitch),
  ]);
  const unrolledRight = normalize3([Math.cos(yaw), -Math.sin(yaw), 0]);
  const unrolledUp = normalize3(cross3(unrolledRight, forward));
  const right = add3(scale3(unrolledRight, Math.cos(roll)), scale3(unrolledUp, Math.sin(roll)));
  const up = add3(scale3(unrolledUp, Math.cos(roll)), scale3(unrolledRight, -Math.sin(roll)));
  const dimensions = photo.metadata.exif.dimensions;
  const aspect = dimensions ? dimensions.widthPixels / dimensions.heightPixels : 4 / 3;
  const distance = Math.max(
    1,
    Math.min(20, (photo.metadata.djiXmp.relativeAltitude?.meters ?? 20) * 0.08),
  );
  const halfHeight = distance * 0.32;
  const halfWidth = halfHeight * Math.max(0.5, Math.min(2.5, aspect));
  const planeCenter = add3(center, scale3(forward, distance));
  const corners = [
    add3(add3(planeCenter, scale3(right, -halfWidth)), scale3(up, halfHeight)),
    add3(add3(planeCenter, scale3(right, halfWidth)), scale3(up, halfHeight)),
    add3(add3(planeCenter, scale3(right, halfWidth)), scale3(up, -halfHeight)),
    add3(add3(planeCenter, scale3(right, -halfWidth)), scale3(up, -halfHeight)),
  ] as CameraImageRectangle['corners'];
  const tags = record.metadata.statusTags;
  return [
    {
      entityId: record.entityId,
      cameraCenter: center,
      corners,
      aligned: tags.includes('aligned') && !tags.includes('alignmentStale'),
      depthReady: tags.includes('depthReady') && !tags.includes('depthStale'),
    },
  ];
}

function alignedCameraRectangle(
  record: ProjectCameraImageRecord,
  camera: AlignedCameraRectanglePose,
): CameraImageRectangle[] {
  const rotation = camera.cameraToWorldRotation;
  const right = normalize3([rotation[0], rotation[3], rotation[6]]);
  const up = normalize3([-rotation[1], -rotation[4], -rotation[7]]);
  const forward = normalize3([rotation[2], rotation[5], rotation[8]]);
  const distance = Math.max(
    0.25,
    Math.min(
      20,
      (record.metadata.inspectedPhoto.metadata.djiXmp.relativeAltitude?.meters ?? 20) * 0.08,
    ),
  );
  const halfWidth =
    (distance * camera.widthPixels) / Math.max(2 * camera.focalXPixels, Number.EPSILON);
  const halfHeight =
    (distance * camera.heightPixels) / Math.max(2 * camera.focalYPixels, Number.EPSILON);
  const planeCenter = add3(camera.centerWorld, scale3(forward, distance));
  const corners = [
    add3(add3(planeCenter, scale3(right, -halfWidth)), scale3(up, halfHeight)),
    add3(add3(planeCenter, scale3(right, halfWidth)), scale3(up, halfHeight)),
    add3(add3(planeCenter, scale3(right, halfWidth)), scale3(up, -halfHeight)),
    add3(add3(planeCenter, scale3(right, -halfWidth)), scale3(up, -halfHeight)),
  ] as CameraImageRectangle['corners'];
  const tags = record.metadata.statusTags;
  return [
    {
      entityId: record.entityId,
      cameraCenter: camera.centerWorld,
      corners,
      aligned: tags.includes('aligned') && !tags.includes('alignmentStale'),
      depthReady: tags.includes('depthReady') && !tags.includes('depthStale'),
    },
  ];
}

type Vector3Tuple = [number, number, number];

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function add3(left: readonly number[], right: readonly number[]): Vector3Tuple {
  return [
    (left[0] ?? 0) + (right[0] ?? 0),
    (left[1] ?? 0) + (right[1] ?? 0),
    (left[2] ?? 0) + (right[2] ?? 0),
  ];
}

function scale3(vector: readonly number[], scalar: number): Vector3Tuple {
  return [(vector[0] ?? 0) * scalar, (vector[1] ?? 0) * scalar, (vector[2] ?? 0) * scalar];
}

function cross3(left: readonly number[], right: readonly number[]): Vector3Tuple {
  const [lx, ly, lz] = [left[0] ?? 0, left[1] ?? 0, left[2] ?? 0];
  const [rx, ry, rz] = [right[0] ?? 0, right[1] ?? 0, right[2] ?? 0];
  return [ly * rz - lz * ry, lz * rx - lx * rz, lx * ry - ly * rx];
}

function normalize3(vector: readonly number[]): Vector3Tuple {
  const length = Math.hypot(vector[0] ?? 0, vector[1] ?? 0, vector[2] ?? 0);
  return length > 1e-12 ? scale3(vector, 1 / length) : [1, 0, 0];
}

function parseSidecarProgress(
  line: string,
): { progressKey: string; fraction: number; message: string } | null {
  const index = line.indexOf(SIDECAR_PROGRESS_PREFIX);
  if (index < 0) return null;
  try {
    const parsed = JSON.parse(line.slice(index + SIDECAR_PROGRESS_PREFIX.length).trim()) as {
      progressKey?: unknown;
      fraction?: unknown;
      message?: unknown;
    };
    if (typeof parsed.progressKey !== 'string') return null;
    if (typeof parsed.fraction !== 'number' || !Number.isFinite(parsed.fraction)) return null;
    if (typeof parsed.message !== 'string') return null;
    return {
      progressKey: parsed.progressKey,
      fraction: Math.min(1, Math.max(0, parsed.fraction)),
      message: parsed.message,
    };
  } catch {
    return null;
  }
}

function referenceFrameLabel(
  frame: OpenPhotolabProjectResult['manifest']['referenceFrame'],
): string | null {
  if (!frame || typeof frame.target !== 'object' || frame.target == null) return null;
  const horizontal = (frame.target as { horizontal?: unknown }).horizontal;
  if (typeof horizontal !== 'object' || horizontal == null) return null;
  const crs = (horizontal as { crs?: unknown }).crs;
  if (typeof crs !== 'object' || crs == null) return null;
  const kind = (crs as { kind?: unknown }).kind;
  const value = (crs as { value?: unknown }).value;
  if (kind === 'epsg' && typeof value === 'number') return `EPSG:${value}`;
  if (kind === 'authority' && typeof value === 'string') return value;
  return null;
}
