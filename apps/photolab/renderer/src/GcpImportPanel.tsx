import type {
  GcpCsvImportMapping,
  GcpCsvPreview,
  GcpRole,
  ProjectCameraImageRecord,
} from '@himmelcad/data';
import {
  AlertTriangle,
  Check,
  FileSpreadsheet,
  Grid3X3,
  LoaderCircle,
  MapPinned,
  Search,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  ChatBubble,
  ChatCard,
  ChatChoices,
  ChatFooter,
  ChatFooterSpacer,
  ChipGroup,
  EmptyPick,
  ImportChatRoot,
  ImportChatStream,
  Metric,
  Metrics,
  ProgressBar,
  importChatStyles as chat,
} from './ImportChat.js';
import {
  listWorkflows,
  saveWorkflow,
  toStoredGrid,
  enrichGridPaths,
  warningsForOperation,
  type GcpImportWorkflow,
} from './importWorkflow.js';
import {
  HORIZONTAL_CRS_PRESETS,
  type CrsOperationDiscovery,
  type CrsOperationQuery,
  type CrsPreset,
  type ImageImportDecision,
  type ImageImportProgress,
  type LocalGridSelection,
} from './ImageImportPanel.js';
import {
  buildGcpImportDecision,
  buildGcpOperationQuery,
  isGcpOperationReady,
} from './gcpImportDecision.js';

export interface GcpImportPanelProps {
  path: string | null;
  projectTargetCrs: string | null;
  projectImages: readonly ProjectCameraImageRecord[];
  busy: boolean;
  externalError: string | null;
  gridProgress: ImageImportProgress | null;
  onChooseFile: () => void;
  onPreview: (path: string, mapping: GcpCsvImportMapping) => Promise<GcpCsvPreview>;
  onDiscoverCrs: (query: CrsOperationQuery) => Promise<CrsOperationDiscovery>;
  onSelectGrid: (kind: 'horizontal' | 'vertical') => Promise<LocalGridSelection | null>;
  onCommit: (
    path: string,
    mapping: GcpCsvImportMapping,
    decision: ImageImportDecision,
    coordinatesAlreadyInProjectCrs: boolean,
  ) => Promise<void>;
  onCancel: () => void;
  onError: (message: string) => void;
}

type TransformMode = 'none' | 'separate' | 'combined';
type YesNo = 'yes' | 'no';
type Phase =
  | 'pick'
  | 'preview'
  | 'mode'
  | 'vertical_ask'
  | 'vertical_setup'
  | 'vertical_grid'
  | 'horizontal_ask'
  | 'horizontal_setup'
  | 'horizontal_grid'
  | 'combined_setup'
  | 'combined_grid'
  | 'operations'
  | 'review';

const DELIMITER_OPTIONS = [
  { id: ';', label: 'Semicolon ;' },
  { id: ',', label: 'Comma ,' },
  { id: '\t', label: 'Tab' },
  { id: ' ', label: 'Space' },
  { id: '|', label: 'Pipe |' },
];

const DECIMAL_OPTIONS = [
  { id: 'comma', label: 'Comma 1,23' },
  { id: 'point', label: 'Point 1.23' },
];

const HEADER_OPTIONS = [
  { id: 'yes', label: 'Has header row' },
  { id: 'no', label: 'No header' },
];

const ROLE_OPTIONS: { id: GcpRole; label: string }[] = [
  { id: 'controlXyz', label: 'Control XYZ' },
  { id: 'controlXy', label: 'Control XY' },
  { id: 'controlZ', label: 'Control Z' },
  { id: 'checkpointXyz', label: 'Checkpoint XYZ' },
  { id: 'checkpointXy', label: 'Checkpoint XY' },
  { id: 'checkpointZ', label: 'Checkpoint Z' },
  { id: 'disabled', label: 'Disabled' },
];

const STDDEV_H_OPTIONS = [
  { id: '0.01', label: '1 cm' },
  { id: '0.02', label: '2 cm' },
  { id: '0.05', label: '5 cm' },
  { id: '0.1', label: '10 cm' },
  { id: '0.5', label: '50 cm' },
];

const STDDEV_Z_OPTIONS = [
  { id: '0.02', label: '2 cm' },
  { id: '0.03', label: '3 cm' },
  { id: '0.05', label: '5 cm' },
  { id: '0.1', label: '10 cm' },
  { id: '0.5', label: '50 cm' },
];

const VERTICAL_PRESETS: readonly CrsPreset[] = [
  {
    code: 4979,
    name: 'WGS 84 ellipsoidal height',
    region: 'Global',
    hint: 'Ellipsoidal height (GPS / RTK)',
  },
  { code: 7837, name: 'DHHN2016 height', region: 'Germany', hint: 'Normal height, GCG2016' },
  { code: 5783, name: 'DHHN92 height', region: 'Germany', hint: 'Normal height' },
  { code: 3855, name: 'EGM2008 height', region: 'Global', hint: 'Gravity-related height' },
  { code: 5773, name: 'EGM96 height', region: 'Global', hint: 'Gravity-related height' },
  { code: 5728, name: 'LN02 height', region: 'Switzerland', hint: 'Swiss national height' },
  { code: 5621, name: 'EVRF2007 height', region: 'Europe', hint: 'European vertical reference' },
  {
    code: 99999,
    name: 'Local / relative height',
    region: 'Local',
    hint: 'Relative / device frame · no geoid',
  },
];

const POPULAR_HORIZONTAL = [25832, 25833, 31468, 4326, 31467] as const;
const POPULAR_VERTICAL = [4979, 7837, 5783, 3855, 99999] as const;

const MODE_LABEL: Record<TransformMode, string> = {
  none: 'None — already project CRS',
  separate: 'Separate — height then horizontal',
  combined: 'Combined — site cal / joint 3D',
};

const RECENT_PREFIX = 'himmelcad.photolab.recentCrs.';

export function GcpImportPanel({
  path,
  projectTargetCrs,
  projectImages,
  busy,
  externalError,
  gridProgress,
  onChooseFile,
  onPreview,
  onDiscoverCrs,
  onSelectGrid,
  onCommit,
  onCancel,
  onError,
}: GcpImportPanelProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('pick');
  const [delimiter, setDelimiter] = useState(';');
  const [decimalSeparator, setDecimalSeparator] = useState<'point' | 'comma'>('comma');
  const [hasHeader, setHasHeader] = useState(true);
  const [columns, setColumns] = useState({ name: '0', east: '1', north: '2', height: '3' });
  const [role, setRole] = useState<GcpRole>('controlXyz');
  const [horizontalStddev, setHorizontalStddev] = useState(0.02);
  const [heightStddev, setHeightStddev] = useState(0.03);
  const [preview, setPreview] = useState<GcpCsvPreview | null>(null);
  const [mode, setMode] = useState<TransformMode | null>(null);
  const [doVertical, setDoVertical] = useState<YesNo | null>(null);
  const [doHorizontal, setDoHorizontal] = useState<YesNo | null>(null);
  const [sourceCrsEpsg, setSourceCrsEpsg] = useState(25832);
  const [sourceVerticalEpsg, setSourceVerticalEpsg] = useState(4979);
  const [targetVerticalEpsg, setTargetVerticalEpsg] = useState(7837);
  const [siteCalPath, setSiteCalPath] = useState<string | null>(null);
  const targetCrsEpsg = parseEpsgCode(projectTargetCrs) ?? 25832;
  const sourceCrs = `EPSG:${sourceCrsEpsg}`;
  const targetCrs = `EPSG:${targetCrsEpsg}`;
  const area = useMemo(() => projectImageArea(projectImages), [projectImages]);
  const [discovery, setDiscovery] = useState<CrsOperationDiscovery | null>(null);
  const [discoveryQueryKey, setDiscoveryQueryKey] = useState<string | null>(null);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [localGrid, setLocalGrid] = useState<LocalGridSelection | null>(null);
  const [verticalGrid, setVerticalGrid] = useState<LocalGridSelection | null>(null);
  const preferencesHydrated = useRef(false);
  const lastPreviewKey = useRef<string | null>(null);

  /** True only when a real horizontal CRS change is requested. */
  const transformCoordinates =
    mode === 'combined' || (mode === 'separate' && doHorizontal === 'yes');
  const transformHeight = mode === 'separate' && doVertical === 'yes';
  /** No convert / already project CRS — skip operation picker entirely. */
  const identityImport = !transformCoordinates && !transformHeight;

  useEffect(() => {
    if (preferencesHydrated.current) return;
    preferencesHydrated.current = true;
    void window.himmelcad?.preferences.gcpCsv
      .get()
      .then((defaults) => {
        setDelimiter(defaults.delimiter);
        setDecimalSeparator(defaults.decimalSeparator);
        setHasHeader(defaults.hasHeader);
        setColumns(defaults.columns);
        setRole(defaults.role);
        setHorizontalStddev(defaults.horizontalStddev);
        setHeightStddev(defaults.heightStddev);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (path && phase === 'pick') setPhase('preview');
    if (!path) {
      setPhase('pick');
      setPreview(null);
      setMode(null);
      setDoVertical(null);
      setDoHorizontal(null);
      setDiscovery(null);
      setSiteCalPath(null);
      setVerticalGrid(null);
    }
  }, [path, phase]);

  const mapping = useMemo<GcpCsvImportMapping>(
    () => ({
      delimiter: delimiter.slice(0, 1) || ';',
      decimalSeparator,
      hasHeader,
      name: selector(columns.name, hasHeader, preview?.header),
      east: selector(columns.east, hasHeader, preview?.header),
      north: selector(columns.north, hasHeader, preview?.header),
      height: selector(columns.height, hasHeader, preview?.header),
      defaultRole: role,
      defaultUncertainty: {
        horizontalStddevMeters: horizontalStddev,
        heightStddevMeters: heightStddev,
      },
    }),
    [
      columns,
      decimalSeparator,
      delimiter,
      hasHeader,
      heightStddev,
      horizontalStddev,
      preview?.header,
      role,
    ],
  );

  const mappingKey = JSON.stringify({
    path,
    delimiter,
    decimalSeparator,
    hasHeader,
    columns,
    role,
    horizontalStddev,
    heightStddev,
  });

  useEffect(() => {
    if (!path || phase === 'pick') return;
    if (lastPreviewKey.current === mappingKey) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLocalBusy(true);
      setError(null);
      void onPreview(path, mapping)
        .then((nextPreview) => {
          if (cancelled) return;
          lastPreviewKey.current = mappingKey;
          setPreview(nextPreview);
          if (nextPreview.errors.length === 0) {
            void window.himmelcad?.preferences.gcpCsv
              .save({
                delimiter: delimiter.slice(0, 1) || ';',
                decimalSeparator,
                hasHeader,
                columns,
                role,
                horizontalStddev,
                heightStddev,
              })
              .catch(() => undefined);
          }
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          const detail = message(reason);
          setError(detail);
          onError(detail);
          setPreview(null);
        })
        .finally(() => {
          if (!cancelled) setLocalBusy(false);
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappingKey, path, phase]);

  const query = useMemo(
    () =>
      buildGcpOperationQuery({
        sourceHorizontalEpsg: sourceCrsEpsg,
        targetHorizontalEpsg: targetCrsEpsg,
        sourceVerticalEpsg,
        targetVerticalEpsg,
        transformHorizontal: transformCoordinates,
        transformHeight,
        areaOfInterest: area,
        verticalGrid,
        horizontalGrid: localGrid,
      }),
    [
      area,
      localGrid,
      sourceCrsEpsg,
      sourceVerticalEpsg,
      targetCrsEpsg,
      targetVerticalEpsg,
      transformCoordinates,
      transformHeight,
      verticalGrid,
    ],
  );
  const selectedOperation =
    discovery?.candidates.find((item) => item.operationId === selectedOperationId) ?? null;
  const missingSelectedGrid = selectedOperation?.requiredGrids.find(
    (grid) => grid.availability.state !== 'presentVerified',
  );
  const operationReady = isGcpOperationReady(
    identityImport,
    transformHeight,
    discoveryQueryKey === JSON.stringify(query),
    selectedOperation,
    query.areaOfInterest,
  );
  const selectedCoverageFailure =
    selectedOperation != null &&
    (!containsArea(selectedOperation.areaOfUse, query.areaOfInterest) ||
      selectedOperation.requiredGrids.some(
        (grid) => grid.coverage == null || !containsArea(grid.coverage, query.areaOfInterest),
      ));
  const selectedHeightOperationMissing =
    transformHeight &&
    selectedOperation != null &&
    !selectedOperation.projPipeline.includes('+proj=vgridshift');

  const siteCalBlocked = mode === 'combined' && siteCalPath != null;
  // Only discover PROJ ops when a real transform is needed and we're on the ops/review path.
  const needsDiscovery =
    (transformCoordinates || transformHeight) &&
    !siteCalBlocked &&
    (phase === 'operations' || phase === 'review');

  useEffect(() => {
    if (!needsDiscovery || siteCalBlocked) return;
    let cancelled = false;
    const queryKey = JSON.stringify(query);
    const timer = window.setTimeout(() => {
      setLocalBusy(true);
      setError(null);
      void onDiscoverCrs(query)
        .then((result) => {
          if (cancelled) return;
          setDiscovery(result);
          setDiscoveryQueryKey(queryKey);
          setSelectedOperationId(null);
          if (result.candidates.length === 0) {
            const detail = 'No accurate coordinate operation covers the GCP and project area.';
            setError(detail);
            onError(detail);
          }
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setDiscovery(null);
          setDiscoveryQueryKey(null);
          setSelectedOperationId(null);
          const detail = message(reason);
          setError(detail);
          onError(detail);
        })
        .finally(() => {
          if (!cancelled) setLocalBusy(false);
        });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [needsDiscovery, onDiscoverCrs, onError, query, siteCalBlocked]);

  const chooseGrid = async (target: 'horizontal' | 'vertical'): Promise<void> => {
    setLocalBusy(true);
    setError(null);
    try {
      const selected = await onSelectGrid(target);
      if (!selected) return;
      if (target === 'vertical' && selected.kind !== 'geoid')
        throw new Error(`${selected.filename} is a horizontal grid, not a geoid or quasigeoid.`);
      if (target === 'horizontal' && selected.kind === 'geoid')
        throw new Error(`${selected.filename} is a vertical grid, not a horizontal datum grid.`);
      if (!containsArea(selected.coverage, area))
        throw new Error(
          `${selected.filename} does not cover the GCP/project area. Select a grid whose coverage contains the image positions.`,
        );
      const enriched = enrichGridPaths(selected, null);
      if (target === 'vertical') {
        setVerticalGrid(enriched);
        rememberGrid('vertical', enriched);
      } else {
        setLocalGrid(enriched);
        rememberGrid('horizontal', enriched);
      }
      setDiscoveryQueryKey(null);
    } catch (reason) {
      const detail = message(reason);
      setError(detail);
      onError(detail);
    } finally {
      setLocalBusy(false);
    }
  };

  const clearFrom = (step: Phase) => {
    setError(null);
    setDiscovery(null);
    setDiscoveryQueryKey(null);
    setSelectedOperationId(null);
    if (step === 'preview' || step === 'mode') {
      setMode(null);
      setDoVertical(null);
      setDoHorizontal(null);
      setSiteCalPath(null);
      setLocalGrid(null);
      setVerticalGrid(null);
    }
    if (step === 'vertical_ask') {
      setDoVertical(null);
      setDoHorizontal(null);
      setLocalGrid(null);
      setVerticalGrid(null);
    }
    if (step === 'vertical_setup') {
      setDoHorizontal(null);
      setLocalGrid(null);
      setVerticalGrid(null);
    }
    if (step === 'horizontal_ask') {
      setDoHorizontal(null);
      setLocalGrid(null);
    }
    if (step === 'combined_setup') {
      setSiteCalPath(null);
      setLocalGrid(null);
    }
    setPhase(step);
  };

  const onMode = (id: string) => {
    const next = id as TransformMode;
    setMode(next);
    setDoVertical(null);
    setDoHorizontal(null);
    setSiteCalPath(null);
    setLocalGrid(null);
    setVerticalGrid(null);
    setDiscovery(null);
    setDiscoveryQueryKey(null);
    setSelectedOperationId(null);
    if (next === 'none') {
      // Already project CRS — import values as-is, no operation pick.
      setSourceCrsEpsg(targetCrsEpsg);
      const projectVerticalEpsg = parseVerticalEpsgCode(projectTargetCrs);
      if (projectVerticalEpsg != null) {
        setSourceVerticalEpsg(projectVerticalEpsg);
        setTargetVerticalEpsg(projectVerticalEpsg);
      }
      setDoVertical('no');
      setDoHorizontal('no');
      setPhase('review');
      return;
    }
    if (next === 'separate') {
      setPhase('vertical_ask');
      return;
    }
    setPhase('combined_setup');
  };

  const onVerticalAsk = (id: string) => {
    const answer = id as YesNo;
    setDoVertical(answer);
    if (answer === 'yes') setPhase('vertical_setup');
    else setPhase('horizontal_ask');
  };

  const confirmVerticalSetup = () => {
    if (sourceVerticalEpsg === targetVerticalEpsg) {
      setError('Source and target height CRS are identical. Choose different references.');
      return;
    }
    if (sourceVerticalEpsg === 99999 || targetVerticalEpsg === 99999) {
      setError('Local or relative heights cannot be transformed without a defined vertical CRS.');
      return;
    }
    rememberCrs('vertical', sourceVerticalEpsg);
    rememberCrs('vertical', targetVerticalEpsg);
    const remembered = loadRememberedGrid('vertical');
    if (remembered) setVerticalGrid(remembered);
    setPhase('vertical_grid');
  };

  const confirmVerticalGrid = () => {
    if (verticalGrid) rememberGrid('vertical', verticalGrid);
    setPhase('horizontal_ask');
  };

  const onHorizontalAsk = (id: string) => {
    const answer = id as YesNo;
    setDoHorizontal(answer);
    if (answer === 'yes') setPhase('horizontal_setup');
    else {
      // Horizontal already project CRS — no PROJ operation needed.
      setSourceCrsEpsg(targetCrsEpsg);
      setLocalGrid(null);
      setDiscovery(null);
      setDiscoveryQueryKey(null);
      setSelectedOperationId(null);
      setPhase(transformHeight ? 'operations' : 'review');
    }
  };

  const confirmHorizontalSetup = () => {
    rememberCrs('horizontal', sourceCrsEpsg);
    rememberCrs('horizontal', targetCrsEpsg);
    const remembered = loadRememberedGrid('horizontal');
    if (remembered) setLocalGrid(remembered);
    setPhase('horizontal_grid');
  };

  const confirmHorizontalGrid = () => {
    if (localGrid) rememberGrid('horizontal', localGrid);
    setPhase('operations');
  };

  const skipHorizontalGrid = () => setPhase('operations');

  const confirmCombined = () => {
    if (siteCalPath) {
      setError(
        'Trimble .cal / .dc site-calibration import is not implemented yet. Clear the file to continue with a CRS operation.',
      );
      return;
    }
    rememberCrs('horizontal', sourceCrsEpsg);
    const remembered = loadRememberedGrid('horizontal');
    if (remembered) setLocalGrid(remembered);
    setPhase('combined_grid');
  };

  const confirmCombinedGrid = () => {
    if (localGrid) rememberGrid('horizontal', localGrid);
    setPhase('operations');
  };

  const pickSiteCal = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.cal,.dc,.jxl,.xml,text/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const pathLike =
        'path' in file && typeof (file as { path?: string }).path === 'string'
          ? (file as { path: string }).path
          : file.name;
      setSiteCalPath(pathLike);
    };
    input.click();
  };

  const commit = async () => {
    if (!path) return;
    if (identityImport) {
      // Silently freeze an identity CRS op (same source/target). No UI pick.
      setLocalBusy(true);
      setError(null);
      try {
        const result = await onDiscoverCrs(query);
        const identity =
          result.candidates.find(
            (c) =>
              !c.ballpark &&
              c.requiredGrids.length === 0 &&
              (c.expectedAccuracyMm == null || c.expectedAccuracyMm <= 1),
          ) ??
          result.candidates.find((c) => !c.ballpark && c.requiredGrids.length === 0) ??
          result.candidates.find((c) => !c.ballpark);
        if (!identity) {
          throw new Error(
            'Could not freeze an identity CRS operation for import without transform.',
          );
        }
        setDiscovery(result);
        setDiscoveryQueryKey(JSON.stringify(query));
        setSelectedOperationId(identity.operationId);
        await onCommit(
          path,
          mapping,
          buildGcpImportDecision(
            query,
            identity,
            result,
            sourceVerticalEpsg,
            targetVerticalEpsg,
            false,
          ),
          true,
        );
      } catch (reason: unknown) {
        const detail = message(reason);
        setError(detail);
        onError(detail);
      } finally {
        setLocalBusy(false);
      }
      return;
    }
    if (!selectedOperation || !discovery) return;
    await onCommit(
      path,
      mapping,
      buildGcpImportDecision(
        query,
        selectedOperation,
        discovery,
        sourceVerticalEpsg,
        targetVerticalEpsg,
        transformHeight,
      ),
      identityImport,
    );
  };

  const previewReady = preview != null && preview.errors.length === 0;
  const fileLabel = path ? fileName(path) : null;
  const locked = busy || localBusy;

  const columnOptions = useMemo(() => {
    if (preview?.header.length) {
      return preview.header.map((header, index) => ({
        id: hasHeader ? header : String(index),
        label: hasHeader ? header : `Col ${index}`,
      }));
    }
    return [0, 1, 2, 3, 4, 5, 6, 7].map((index) => ({
      id: String(index),
      label: `Col ${index}`,
    }));
  }, [hasHeader, preview?.header]);

  const scrollKey = [
    phase,
    path ?? '',
    preview?.validPointCount ?? 0,
    mode ?? '',
    doVertical ?? '',
    doHorizontal ?? '',
    localBusy,
    busy,
    discovery?.candidates.length ?? 0,
    error ?? '',
  ].join('|');

  if (!path) {
    return (
      <ImportChatRoot
        title="GCP Import"
        onClose={onCancel}
        closeLabel="Close GCP import"
        busy={busy}
      >
        <EmptyPick
          icon={
            externalError ? (
              <AlertTriangle size={34} className={chat.warningText} />
            ) : (
              <FileSpreadsheet size={34} />
            )
          }
          title={externalError ?? 'GCP coordinate file'}
          detail="Select a CSV or text file with ground control points."
        >
          <button
            type="button"
            className={`${chat.choice} ${chat.choicePrimary}`}
            onClick={onChooseFile}
            disabled={busy}
          >
            <FileSpreadsheet size={14} /> Select file
          </button>
        </EmptyPick>
      </ImportChatRoot>
    );
  }

  const showVerticalSetup =
    mode === 'separate' &&
    doVertical === 'yes' &&
    phaseOrder(phase) >= phaseOrder('vertical_setup');
  const showHorizontalSetup =
    mode === 'separate' &&
    doHorizontal === 'yes' &&
    phaseOrder(phase) >= phaseOrder('horizontal_setup');
  const showCombined = mode === 'combined' && phaseOrder(phase) >= phaseOrder('combined_setup');
  const showOps =
    (transformCoordinates || transformHeight) && phaseOrder(phase) >= phaseOrder('operations');
  const showReview = phase === 'review';

  return (
    <ImportChatRoot
      title="GCP Import"
      onClose={onCancel}
      closeLabel="Close GCP import"
      busy={busy || localBusy}
      footer={
        phase === 'review' ? (
          <ChatFooter>
            <button
              type="button"
              className={chat.ghostBtn}
              disabled={busy || localBusy}
              onClick={() => {
                const workflow: GcpImportWorkflow = {
                  schemaVersion: 1,
                  id: crypto.randomUUID(),
                  name: `GCP · ${mode ?? 'none'} · ${new Date().toLocaleString()}`,
                  description: '',
                  kind: 'gcp',
                  savedAt: new Date().toISOString(),
                  mode: mode ?? 'none',
                  doVertical,
                  doHorizontal,
                  sourceCrsEpsg,
                  sourceVerticalEpsg,
                  targetVerticalEpsg,
                  gridPolicy: transformCoordinates || transformHeight ? 'ntv2' : null,
                  verticalGrid: verticalGrid ? toStoredGrid(verticalGrid) : null,
                  horizontalGrid: localGrid ? toStoredGrid(localGrid) : null,
                  delimiter,
                  decimalSeparator,
                  hasHeader,
                  columns,
                  role,
                  horizontalStddev,
                  heightStddev,
                };
                const result = saveWorkflow(workflow);
                if (!result.ok) onError(result.error);
              }}
            >
              Save import workflow
            </button>
            <ChatFooterSpacer />
            <button
              type="button"
              className={chat.primaryBtn}
              disabled={!previewReady || !operationReady || busy || localBusy || siteCalBlocked}
              onClick={() => void commit()}
            >
              {busy ? <LoaderCircle className={chat.spinner} size={14} /> : <Check size={14} />}
              {busy ? 'Importing…' : `Import ${preview?.validPointCount ?? 0} GCPs`}
            </button>
          </ChatFooter>
        ) : null
      }
    >
      <ImportChatStream scrollKey={scrollKey}>
        {(error ?? externalError) && (
          <ChatBubble role="system" tone="error" title="Import problem">
            {error ?? externalError}
          </ChatBubble>
        )}

        <ChatBubble role="system" tone="ok" title="File selected" detail={fileLabel ?? path} />

        <ChatCard
          title="CSV mapping & preview"
          onRevert={phase !== 'preview' ? () => clearFrom('preview') : undefined}
          revertDisabled={locked}
          actions={
            localBusy ? (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 10,
                  color: 'var(--hc-fg-muted)',
                }}
              >
                <LoaderCircle className={chat.spinner} size={13} /> Reading…
              </span>
            ) : null
          }
        >
          <ChipGroup
            label="Delimiter"
            value={delimiter}
            disabled={locked}
            onChange={setDelimiter}
            options={DELIMITER_OPTIONS}
          />
          <ChipGroup
            label="Decimals"
            value={decimalSeparator}
            disabled={locked}
            onChange={(id) => setDecimalSeparator(id as 'point' | 'comma')}
            options={DECIMAL_OPTIONS}
          />
          <ChipGroup
            label="Header"
            value={hasHeader ? 'yes' : 'no'}
            disabled={locked}
            onChange={(id) => {
              setHasHeader(id === 'yes');
              if (id === 'no') setColumns({ name: '0', east: '1', north: '2', height: '3' });
            }}
            options={HEADER_OPTIONS}
          />
          {(['name', 'east', 'north', 'height'] as const).map((key) => (
            <ChipGroup
              key={key}
              label={columnLabel(key)}
              value={columns[key]}
              disabled={locked}
              onChange={(id) => setColumns({ ...columns, [key]: id })}
              options={columnOptions}
            />
          ))}
          <ChipGroup
            label="Default role"
            value={role}
            disabled={locked}
            onChange={(id) => setRole(id as GcpRole)}
            options={ROLE_OPTIONS}
          />
          <ChipGroup
            label="σ horizontal"
            value={String(horizontalStddev)}
            disabled={locked}
            onChange={(id) => setHorizontalStddev(Number(id))}
            options={ensureOption(STDDEV_H_OPTIONS, horizontalStddev)}
          />
          <ChipGroup
            label="σ height"
            value={String(heightStddev)}
            disabled={locked}
            onChange={(id) => setHeightStddev(Number(id))}
            options={ensureOption(STDDEV_Z_OPTIONS, heightStddev)}
          />

          {preview ? (
            <>
              <Metrics>
                <Metric label="Data rows" value={String(preview.dataRowCount)} />
                <Metric label="Valid" value={String(preview.validPointCount)} />
                <Metric
                  label="Errors"
                  value={String(preview.errors.length)}
                  warning={preview.errors.length > 0}
                />
              </Metrics>
              <div className={chat.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Easting</th>
                      <th>Northing</th>
                      <th>Height</th>
                      <th>Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.previewRows.map((row) => (
                      <tr key={row.sourceLine}>
                        <td>{row.point.name}</td>
                        <td>{row.point.coordinate.eastMeters.toFixed(3)}</td>
                        <td>{row.point.coordinate.northMeters.toFixed(3)}</td>
                        <td>{row.point.coordinate.heightMeters.toFixed(3)}</td>
                        <td>{roleLabel(row.point.role)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.errors.slice(0, 12).map((item) => (
                <div key={`${item.sourceLine}:${item.field}`} className={chat.errorInline}>
                  Row {item.sourceLine} · {item.field}: {item.message}
                </div>
              ))}
              {preview.errors.length === 0 && (
                <div className={chat.successInline}>
                  <Check size={14} /> Preview valid · {preview.validPointCount} points
                </div>
              )}
            </>
          ) : (
            <div style={{ color: 'var(--hc-fg-muted)', fontSize: 10, marginTop: 8 }}>
              {localBusy ? 'Building preview…' : 'Adjust mapping to load preview.'}
            </div>
          )}
        </ChatCard>

        {previewReady && (
          <>
            <ChatBubble
              role="system"
              title="Coordinate transform"
              onRevert={mode != null ? () => clearFrom('mode') : undefined}
              revertDisabled={locked || mode == null}
            />
            {mode == null && listWorkflows('gcp').length > 0 && (
              <ChatCard title="Saved workflows">
                <div className={chat.chipGroup}>
                  {listWorkflows('gcp')
                    .slice(0, 5)
                    .map((workflow) => (
                      <button
                        key={workflow.id}
                        type="button"
                        className={chat.chip}
                        disabled={locked}
                        title={workflow.name}
                        onClick={() => {
                          if (workflow.kind !== 'gcp') return;
                          setMode(workflow.mode);
                          setDoVertical(workflow.doVertical);
                          setDoHorizontal(workflow.doHorizontal);
                          setSourceCrsEpsg(workflow.sourceCrsEpsg);
                          setSourceVerticalEpsg(workflow.sourceVerticalEpsg);
                          setTargetVerticalEpsg(workflow.targetVerticalEpsg);
                          setDelimiter(workflow.delimiter);
                          setDecimalSeparator(workflow.decimalSeparator);
                          setHasHeader(workflow.hasHeader);
                          setColumns(workflow.columns);
                          setRole(workflow.role as typeof role);
                          setHorizontalStddev(workflow.horizontalStddev);
                          setHeightStddev(workflow.heightStddev);
                          if (workflow.horizontalGrid) {
                            setLocalGrid({
                              filename: workflow.horizontalGrid.filename,
                              localPath:
                                workflow.horizontalGrid.absolutePath ||
                                workflow.horizontalGrid.localPath,
                              absolutePath: workflow.horizontalGrid.absolutePath,
                              relativePath: workflow.horizontalGrid.relativePath,
                              kind: workflow.horizontalGrid.kind,
                              driver: workflow.horizontalGrid.driver,
                              coverage: workflow.horizontalGrid.coverage,
                            });
                          }
                          if (workflow.verticalGrid) {
                            setVerticalGrid({
                              filename: workflow.verticalGrid.filename,
                              localPath:
                                workflow.verticalGrid.absolutePath ||
                                workflow.verticalGrid.localPath,
                              absolutePath: workflow.verticalGrid.absolutePath,
                              relativePath: workflow.verticalGrid.relativePath,
                              kind: workflow.verticalGrid.kind,
                              driver: workflow.verticalGrid.driver,
                              coverage: workflow.verticalGrid.coverage,
                            });
                          }
                          setPhase(
                            workflow.mode === 'none' ||
                              (workflow.mode === 'separate' &&
                                workflow.doVertical !== 'yes' &&
                                workflow.doHorizontal !== 'yes')
                              ? 'review'
                              : 'operations',
                          );
                        }}
                      >
                        {workflow.name.length > 42
                          ? `${workflow.name.slice(0, 40)}…`
                          : workflow.name}
                      </button>
                    ))}
                </div>
              </ChatCard>
            )}
            <ChatChoices
              resolvedId={mode}
              disabled={locked || mode != null}
              onSelect={onMode}
              onRevert={mode != null ? () => clearFrom('mode') : undefined}
              revertDisabled={locked}
              options={[
                { id: 'none', label: 'None', primary: true },
                { id: 'separate', label: 'Separate' },
                { id: 'combined', label: 'Combined' },
              ]}
            />
            {mode != null && (
              <ChatBubble role="user" onRevert={() => clearFrom('mode')} revertDisabled={locked}>
                {MODE_LABEL[mode]}
              </ChatBubble>
            )}
          </>
        )}

        {mode === 'separate' && phaseOrder(phase) >= phaseOrder('vertical_ask') && (
          <>
            <ChatBubble
              role="system"
              title="Transform height?"
              onRevert={() => clearFrom('vertical_ask')}
              revertDisabled={locked}
            />
            <ChatChoices
              resolvedId={doVertical}
              disabled={locked || doVertical != null}
              onSelect={onVerticalAsk}
              onRevert={doVertical != null ? () => clearFrom('vertical_ask') : undefined}
              revertDisabled={locked}
              options={[
                { id: 'no', label: 'No — preserve heights', primary: true },
                { id: 'yes', label: 'Yes — transform height' },
              ]}
            />
            {doVertical != null && (
              <ChatBubble
                role="user"
                onRevert={() => clearFrom('vertical_ask')}
                revertDisabled={locked}
              >
                {doVertical === 'yes' ? 'Transform height' : 'Preserve declared heights'}
              </ChatBubble>
            )}
          </>
        )}

        {showVerticalSetup && (
          <ChatCard
            title="Height CRS"
            onRevert={() => clearFrom('vertical_setup')}
            revertDisabled={locked}
          >
            <CrsSearchPair
              sourceLabel="Source"
              targetLabel="Target"
              sourceValue={sourceVerticalEpsg}
              targetValue={targetVerticalEpsg}
              presets={VERTICAL_PRESETS}
              popular={POPULAR_VERTICAL}
              recentKey="vertical"
              disabled={locked || phase !== 'vertical_setup'}
              onSourceChange={setSourceVerticalEpsg}
              onTargetChange={setTargetVerticalEpsg}
            />
            {phase === 'vertical_setup' && (
              <div className={chat.toolbar}>
                <button
                  type="button"
                  className={`${chat.choice} ${chat.choicePrimary}`}
                  disabled={locked}
                  onClick={confirmVerticalSetup}
                >
                  Continue
                </button>
              </div>
            )}
          </ChatCard>
        )}

        {mode === 'separate' &&
          doVertical === 'yes' &&
          phaseOrder(phase) >= phaseOrder('vertical_grid') && (
            <ChatCard
              title="Vertical grid"
              onRevert={() => clearFrom('vertical_setup')}
              revertDisabled={locked}
            >
              <div className={chat.gridRow}>
                <Grid3X3 size={16} />
                <div>
                  <strong>Geoid or quasigeoid</strong>
                  <span>
                    {verticalGrid
                      ? `${verticalGrid.filename} · selected`
                      : sourceVerticalEpsg === 7837 || targetVerticalEpsg === 7837
                        ? 'Bundled GCG2016 is used when it covers the project.'
                        : 'Select the survey grid required by this height pair.'}
                  </span>
                  {gridProgress?.phase === 'grid' && <ProgressBar value={gridProgress.fraction} />}
                  {verticalGrid && (
                    <code title={verticalGrid.localPath}>{verticalGrid.localPath}</code>
                  )}
                </div>
                <button
                  type="button"
                  className={chat.ghostBtn}
                  disabled={locked || phase !== 'vertical_grid'}
                  onClick={() => void chooseGrid('vertical')}
                >
                  {verticalGrid ? 'Change…' : 'Choose grid…'}
                </button>
              </div>
              {phase === 'vertical_grid' && (
                <div className={chat.toolbar}>
                  <button
                    type="button"
                    className={`${chat.choice} ${chat.choicePrimary}`}
                    disabled={locked}
                    onClick={confirmVerticalGrid}
                  >
                    {verticalGrid ? 'Continue with this grid' : 'Continue to validation'}
                  </button>
                </div>
              )}
            </ChatCard>
          )}

        {mode === 'separate' && phaseOrder(phase) >= phaseOrder('horizontal_ask') && (
          <>
            <ChatBubble
              role="system"
              title="Transform horizontal coordinates?"
              onRevert={() => clearFrom('horizontal_ask')}
              revertDisabled={locked}
            />
            <ChatChoices
              resolvedId={doHorizontal}
              disabled={locked || doHorizontal != null}
              onSelect={onHorizontalAsk}
              onRevert={doHorizontal != null ? () => clearFrom('horizontal_ask') : undefined}
              revertDisabled={locked}
              options={[
                { id: 'no', label: 'No — already project CRS', primary: true },
                { id: 'yes', label: 'Yes — transform horizontal' },
              ]}
            />
            {doHorizontal != null && (
              <ChatBubble
                role="user"
                onRevert={() => clearFrom('horizontal_ask')}
                revertDisabled={locked}
              >
                {doHorizontal === 'yes' ? 'Transform horizontal' : 'Already project CRS'}
              </ChatBubble>
            )}
          </>
        )}

        {showHorizontalSetup && (
          <ChatCard
            title="Horizontal transform"
            onRevert={() => clearFrom('horizontal_setup')}
            revertDisabled={locked}
          >
            <div className={chat.crsPair}>
              <CrsSearchColumn
                label="Source"
                value={sourceCrsEpsg}
                presets={HORIZONTAL_CRS_PRESETS}
                popular={POPULAR_HORIZONTAL}
                recentKey="horizontal"
                disabled={locked || phaseOrder(phase) > phaseOrder('horizontal_setup')}
                onChange={setSourceCrsEpsg}
              />
              <div className={chat.crsColumn}>
                <div className={chat.crsColumnLabel}>Project target</div>
                <div className={chat.crsSelected}>
                  <strong>{targetCrs}</strong>
                  <small>Locked to project reference</small>
                </div>
              </div>
            </div>
            {phase === 'horizontal_setup' && (
              <div className={chat.toolbar}>
                <button
                  type="button"
                  className={`${chat.choice} ${chat.choicePrimary}`}
                  disabled={locked}
                  onClick={confirmHorizontalSetup}
                >
                  Continue
                </button>
              </div>
            )}
          </ChatCard>
        )}

        {mode === 'separate' &&
          doHorizontal === 'yes' &&
          phaseOrder(phase) >= phaseOrder('horizontal_grid') && (
            <>
              <ChatBubble
                role="system"
                title="Horizontal datum grid"
                onRevert={() => clearFrom('horizontal_grid')}
                revertDisabled={locked}
              />
              <ChatCard
                title="Horizontal grid file"
                onRevert={() => clearFrom('horizontal_grid')}
                revertDisabled={locked}
              >
                <div className={chat.gridRow}>
                  <Grid3X3 size={16} />
                  <div>
                    <strong>NTv2 / GTG grid</strong>
                    <span>
                      {localGrid
                        ? `${localGrid.filename} · previously selected`
                        : 'Bundled grids used when they cover the project.'}
                    </span>
                    {gridProgress?.phase === 'grid' && (
                      <ProgressBar value={gridProgress.fraction} />
                    )}
                    {localGrid && <code title={localGrid.localPath}>{localGrid.localPath}</code>}
                  </div>
                  <button
                    type="button"
                    className={chat.ghostBtn}
                    disabled={locked || phase !== 'horizontal_grid'}
                    onClick={() => void chooseGrid('horizontal')}
                  >
                    {localGrid ? 'Change…' : 'Choose grid…'}
                  </button>
                </div>
                {phase === 'horizontal_grid' && (
                  <div className={chat.toolbar}>
                    <button
                      type="button"
                      className={`${chat.choice} ${chat.choicePrimary}`}
                      disabled={locked}
                      onClick={confirmHorizontalGrid}
                    >
                      Continue
                    </button>
                    <button
                      type="button"
                      className={chat.choice}
                      disabled={locked}
                      onClick={skipHorizontalGrid}
                    >
                      Use bundled / none
                    </button>
                  </div>
                )}
              </ChatCard>
            </>
          )}

        {showCombined && (
          <ChatCard
            title="Combined transform"
            onRevert={() => clearFrom('combined_setup')}
            revertDisabled={locked}
          >
            <div className={chat.gridRow}>
              <Grid3X3 size={16} />
              <div>
                <strong>Site calibration file</strong>
                <span>
                  .cal / .dc parser is not implemented. Leave empty to use PROJ source → {targetCrs}
                  .
                </span>
                {siteCalPath && <code>{fileName(siteCalPath)}</code>}
              </div>
              <button
                type="button"
                className={chat.ghostBtn}
                disabled={locked || phase !== 'combined_setup'}
                onClick={pickSiteCal}
              >
                {siteCalPath ? 'Change…' : 'Choose .cal / .dc…'}
              </button>
            </div>
            {siteCalPath && (
              <div className={chat.errorInline}>
                <AlertTriangle size={14} /> .cal / .dc reading is not implemented. Core has 7-param
                Similarity3D, but no Trimble site-cal importer yet.
              </div>
            )}
            {siteCalPath && (
              <div className={chat.toolbar}>
                <button type="button" className={chat.choice} onClick={() => setSiteCalPath(null)}>
                  Clear file · use CRS operation
                </button>
              </div>
            )}
            <div className={chat.crsPair}>
              <CrsSearchColumn
                label="Source CRS"
                value={sourceCrsEpsg}
                presets={HORIZONTAL_CRS_PRESETS}
                popular={POPULAR_HORIZONTAL}
                recentKey="horizontal"
                disabled={locked || phase !== 'combined_setup'}
                onChange={setSourceCrsEpsg}
              />
              <div className={chat.crsColumn}>
                <div className={chat.crsColumnLabel}>Target</div>
                <div className={chat.crsSelected}>
                  <strong>{targetCrs}</strong>
                  <small>Project reference</small>
                </div>
              </div>
            </div>
            {phase === 'combined_setup' && (
              <div className={chat.toolbar}>
                <button
                  type="button"
                  className={`${chat.choice} ${chat.choicePrimary}`}
                  disabled={locked || !!siteCalPath}
                  onClick={confirmCombined}
                >
                  Continue with CRS operation
                </button>
              </div>
            )}
          </ChatCard>
        )}

        {mode === 'combined' && phaseOrder(phase) >= phaseOrder('combined_grid') && (
          <>
            <ChatBubble
              role="system"
              title="Horizontal datum grid"
              onRevert={() => clearFrom('combined_grid')}
              revertDisabled={locked}
            />
            <ChatCard
              title="Grid file"
              onRevert={() => clearFrom('combined_grid')}
              revertDisabled={locked}
            >
              <div className={chat.gridRow}>
                <Grid3X3 size={16} />
                <div>
                  <strong>NTv2 / GTG grid</strong>
                  <span>
                    {localGrid
                      ? `${localGrid.filename} · previously selected`
                      : 'Optional when PROJ needs a local grid.'}
                  </span>
                  {localGrid && <code title={localGrid.localPath}>{localGrid.localPath}</code>}
                </div>
                <button
                  type="button"
                  className={chat.ghostBtn}
                  disabled={locked || phase !== 'combined_grid'}
                  onClick={() => void chooseGrid('horizontal')}
                >
                  {localGrid ? 'Change…' : 'Choose grid…'}
                </button>
              </div>
              {phase === 'combined_grid' && (
                <div className={chat.toolbar}>
                  <button
                    type="button"
                    className={`${chat.choice} ${chat.choicePrimary}`}
                    disabled={locked}
                    onClick={confirmCombinedGrid}
                  >
                    Continue
                  </button>
                </div>
              )}
            </ChatCard>
          </>
        )}

        {showOps && (
          <ChatCard
            title="Coordinate operation"
            onRevert={() =>
              clearFrom(
                mode === 'combined'
                  ? 'combined_setup'
                  : mode === 'separate'
                    ? doHorizontal === 'yes'
                      ? 'horizontal_setup'
                      : 'mode'
                    : 'mode',
              )
            }
            revertDisabled={locked}
          >
            {siteCalBlocked ? (
              <div className={chat.errorInline}>
                <AlertTriangle size={14} /> Site-cal file selected but parser is missing.
              </div>
            ) : localBusy && !discovery ? (
              <>
                <strong style={{ fontSize: 11 }}>Validating with PROJ…</strong>
                <ProgressBar value={0} indeterminate indeterminateLabel="Validating…" />
              </>
            ) : discovery ? (
              <>
                <p style={{ margin: '0 0 8px', color: 'var(--hc-fg-muted)', fontSize: 11 }}>
                  Choose one operation. Notes appear only after you select.
                </p>
                <div className={chat.operationList}>
                  {discovery.candidates.map((candidate) => (
                    <button
                      key={candidate.operationId}
                      type="button"
                      className={`${chat.operation} ${
                        candidate.operationId === selectedOperationId ? chat.operationActive : ''
                      }`}
                      disabled={busy}
                      onClick={() => setSelectedOperationId(candidate.operationId)}
                    >
                      <MapPinned size={14} />
                      <span>
                        <strong>{candidate.name}</strong>
                        <small>
                          {candidate.requiredGrids.length > 0
                            ? `Grids: ${candidate.requiredGrids.map((g) => g.officialFilename).join(', ')}`
                            : 'No local grid required'}
                          {' · '}
                          {candidate.expectedAccuracyMm == null
                            ? 'Accuracy not specified'
                            : `${candidate.expectedAccuracyMm.toFixed(1)} mm`}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
                {selectedOperation &&
                  warningsForOperation(discovery.warnings, selectedOperation.name).map(
                    (warning) => (
                      <div key={warning} className={chat.warnInline}>
                        <AlertTriangle size={14} />
                        <span>{warning}</span>
                      </div>
                    ),
                  )}
                {missingSelectedGrid && (
                  <div className={chat.errorInline}>
                    <AlertTriangle size={14} /> Required grid {missingSelectedGrid.officialFilename}{' '}
                    is missing or unverified. Select a covering grid before import.
                  </div>
                )}
                {selectedCoverageFailure && (
                  <div className={chat.errorInline}>
                    <AlertTriangle size={14} /> The selected operation or grid does not cover the
                    GCP/project area. Select a covering geoid or coordinate operation.
                  </div>
                )}
                {selectedHeightOperationMissing && (
                  <div className={chat.errorInline}>
                    <AlertTriangle size={14} /> This operation does not transform height values.
                    Select an operation with a verified vertical grid.
                  </div>
                )}
                {phase === 'operations' && selectedOperationId && (
                  <div className={chat.toolbar}>
                    <button
                      type="button"
                      className={`${chat.choice} ${chat.choicePrimary}`}
                      disabled={
                        busy ||
                        localBusy ||
                        !selectedOperation ||
                        selectedOperation.ballpark ||
                        !operationReady
                      }
                      onClick={() => setPhase('review')}
                    >
                      Continue with this operation
                    </button>
                  </div>
                )}
              </>
            ) : error ? (
              <div className={chat.errorInline}>
                <AlertTriangle size={14} /> {error}
              </div>
            ) : (
              <small style={{ color: 'var(--hc-fg-muted)' }}>Waiting…</small>
            )}
          </ChatCard>
        )}

        {showReview && (
          <ChatCard title="Summary" onRevert={() => clearFrom('preview')} revertDisabled={locked}>
            <div className={chat.reviewGrid}>
              <Metric label="Points" value={String(preview?.validPointCount ?? 0)} />
              <Metric
                label="Coordinates"
                value={transformCoordinates ? `${sourceCrs} → ${targetCrs}` : `As ${targetCrs}`}
              />
              <Metric
                label="Height"
                value={
                  transformHeight
                    ? `EPSG:${sourceVerticalEpsg} → EPSG:${targetVerticalEpsg}`
                    : `Preserved · EPSG:${sourceVerticalEpsg}`
                }
              />
              <Metric label="Mode" value={mode ? MODE_LABEL[mode] : '—'} />
              <Metric label="Decimals" value={decimalSeparator === 'comma' ? 'Comma' : 'Point'} />
            </div>
            {busy && (
              <div className={chat.successInline} style={{ color: 'var(--hc-fg-muted)' }}>
                <LoaderCircle className={chat.spinner} size={14} /> Importing…
              </div>
            )}
          </ChatCard>
        )}
      </ImportChatStream>
    </ImportChatRoot>
  );
}

function CrsSearchPair({
  sourceLabel,
  targetLabel,
  sourceValue,
  targetValue,
  presets,
  popular,
  recentKey,
  disabled,
  onSourceChange,
  onTargetChange,
}: {
  sourceLabel: string;
  targetLabel: string;
  sourceValue: number;
  targetValue: number;
  presets: readonly CrsPreset[];
  popular: readonly number[];
  recentKey: string;
  disabled?: boolean | undefined;
  onSourceChange: (code: number) => void;
  onTargetChange: (code: number) => void;
}): JSX.Element {
  return (
    <div className={chat.crsPair}>
      <CrsSearchColumn
        label={sourceLabel}
        value={sourceValue}
        presets={presets}
        popular={popular}
        recentKey={recentKey}
        disabled={disabled === true}
        onChange={onSourceChange}
      />
      <CrsSearchColumn
        label={targetLabel}
        value={targetValue}
        presets={presets}
        popular={popular}
        recentKey={recentKey}
        disabled={disabled === true}
        onChange={onTargetChange}
      />
    </div>
  );
}

function CrsSearchColumn({
  label,
  value,
  presets,
  popular,
  recentKey,
  disabled = false,
  onChange,
}: {
  label: string;
  value: number;
  presets: readonly CrsPreset[];
  popular: readonly number[];
  recentKey: string;
  disabled?: boolean | undefined;
  onChange: (code: number) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLDivElement | null>(null);

  const openSuggest = () => {
    const el = searchRef.current;
    if (!el) {
      setOpen(true);
      return;
    }
    const rect = el.getBoundingClientRect();
    setDropdownRect({
      top: rect.bottom + 2,
      left: rect.left,
      width: rect.width,
    });
    setOpen(true);
  };
  const selected = presets.find((p) => p.code === value);
  const recent = loadRecent(recentKey);
  const focusCodes = (recent.length > 0 ? recent : [...popular]).slice(0, 5);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return focusCodes.map(
        (code) =>
          presets.find((p) => p.code === code) ?? {
            code,
            name: `EPSG:${code}`,
            region: 'Custom',
            hint: 'Recent or popular',
          },
      );
    }
    const tokens = q.split(/\s+/).filter(Boolean);
    const fromPresets = presets.filter((p) =>
      tokens.every((t) => `${p.code} ${p.name} ${p.region} ${p.hint}`.toLowerCase().includes(t)),
    );
    const custom = /^(?:epsg:\s*)?(\d{3,7})$/i.exec(query.trim());
    const customCode = custom ? Number(custom[1]) : null;
    const list = [...fromPresets];
    if (
      customCode != null &&
      !list.some((p) => p.code === customCode) &&
      Number.isFinite(customCode)
    ) {
      list.unshift({
        code: customCode,
        name: `Custom EPSG:${customCode}`,
        region: 'Custom',
        hint: 'Resolved by PROJ',
      });
    }
    return list.slice(0, 12);
  }, [focusCodes, presets, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className={chat.crsColumn} ref={root}>
      <div className={chat.crsColumnLabel}>{label}</div>
      <div className={chat.crsSelected}>
        <strong>{selected?.name ?? `EPSG:${value}`}</strong>
        <small>
          EPSG:{value}
          {selected ? ` · ${selected.hint}` : ''}
        </small>
      </div>
      <div className={chat.crsSearch} ref={searchRef}>
        <Search size={13} />
        <input
          type="search"
          value={query}
          disabled={disabled}
          placeholder="Search name or EPSG…"
          onFocus={openSuggest}
          onChange={(event) => {
            setQuery(event.target.value);
            openSuggest();
          }}
        />
      </div>
      {open && !disabled && dropdownRect && (
        <div
          className={chat.crsSuggest}
          role="listbox"
          style={{
            position: 'fixed',
            top: dropdownRect.top,
            left: dropdownRect.left,
            width: dropdownRect.width,
            right: 'auto',
          }}
        >
          <div className={chat.crsSuggestMeta}>
            {query.trim() ? 'Search results' : recent.length > 0 ? 'Recent' : 'Popular'}
          </div>
          {matches.map((preset) => (
            <button
              type="button"
              key={preset.code}
              className={preset.code === value ? chat.crsSuggestActive : ''}
              onClick={() => {
                onChange(preset.code);
                rememberCrs(recentKey, preset.code);
                setQuery('');
                setOpen(false);
              }}
            >
              <strong>{preset.name}</strong>
              <small>
                EPSG:{preset.code} · {preset.region}
              </small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function loadRecent(key: string): number[] {
  try {
    const raw = localStorage.getItem(RECENT_PREFIX + key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === 'number').slice(0, 5);
  } catch {
    return [];
  }
}

function rememberCrs(key: string, code: number): void {
  try {
    const next = [code, ...loadRecent(key).filter((c) => c !== code)].slice(0, 5);
    localStorage.setItem(RECENT_PREFIX + key, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function phaseOrder(phase: Phase): number {
  const order: Phase[] = [
    'pick',
    'preview',
    'mode',
    'vertical_ask',
    'vertical_setup',
    'vertical_grid',
    'horizontal_ask',
    'horizontal_setup',
    'horizontal_grid',
    'combined_setup',
    'combined_grid',
    'operations',
    'review',
  ];
  return order.indexOf(phase);
}

const GRID_MEMORY_PREFIX = 'himmelcad.photolab.lastGrid.';

function loadRememberedGrid(kind: 'horizontal' | 'vertical'): LocalGridSelection | null {
  try {
    const raw = localStorage.getItem(GRID_MEMORY_PREFIX + kind);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalGridSelection;
    if (!parsed?.localPath || !parsed?.filename) return null;
    return parsed;
  } catch {
    return null;
  }
}

function rememberGrid(kind: 'horizontal' | 'vertical', selection: LocalGridSelection): void {
  try {
    localStorage.setItem(GRID_MEMORY_PREFIX + kind, JSON.stringify(selection));
  } catch {
    /* ignore */
  }
}

function ensureOption(
  options: { id: string; label: string }[],
  value: number,
): { id: string; label: string }[] {
  const id = String(value);
  if (options.some((option) => option.id === id)) return options;
  return [...options, { id, label: `${value} m` }];
}

function selector(value: string, hasHeader: boolean, headers: readonly string[] | undefined) {
  if (hasHeader && (headers?.includes(value) || !/^\d+$/.test(value.trim())))
    return { kind: 'header' as const, value };
  const index = Number.parseInt(value, 10);
  return { kind: 'index' as const, value: Number.isSafeInteger(index) && index >= 0 ? index : 0 };
}

function containsArea(
  coverage: CrsOperationQuery['areaOfInterest'],
  area: CrsOperationQuery['areaOfInterest'],
): boolean {
  return (
    coverage.westLongitude <= area.westLongitude &&
    coverage.southLatitude <= area.southLatitude &&
    coverage.eastLongitude >= area.eastLongitude &&
    coverage.northLatitude >= area.northLatitude
  );
}

function projectImageArea(
  images: readonly ProjectCameraImageRecord[],
): CrsOperationQuery['areaOfInterest'] {
  const positions = images.flatMap(({ metadata }) => {
    const photo = metadata.inspectedPhoto.metadata;
    const latitude = photo.djiXmp.latitudeDegrees ?? photo.exif.gps?.latitudeDegrees;
    const longitude = photo.djiXmp.longitudeDegrees ?? photo.exif.gps?.longitudeDegrees;
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      ? [[Number(longitude), Number(latitude)] as const]
      : [];
  });
  if (positions.length === 0) {
    return { westLongitude: 5, southLatitude: 47, eastLongitude: 16, northLatitude: 56 };
  }
  const longitudes = positions.map(([longitude]) => longitude);
  const latitudes = positions.map(([, latitude]) => latitude);
  return {
    westLongitude: Math.max(-180, Math.min(...longitudes) - 0.01),
    southLatitude: Math.max(-90, Math.min(...latitudes) - 0.01),
    eastLongitude: Math.min(180, Math.max(...longitudes) + 0.01),
    northLatitude: Math.min(90, Math.max(...latitudes) + 0.01),
  };
}

function parseEpsgCode(value: string | null): number | null {
  if (!value) return null;
  const match = /^EPSG:\s*(\d+)(?:\+\d+)?$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function parseVerticalEpsgCode(value: string | null): number | null {
  if (!value) return null;
  const match = /^EPSG:\s*\d+\+(\d+)$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function columnLabel(key: 'name' | 'east' | 'north' | 'height'): string {
  if (key === 'name') return 'Name';
  if (key === 'east') return 'Easting';
  if (key === 'north') return 'Northing';
  return 'Height';
}

function roleLabel(role: GcpRole): string {
  return role.replace('control', 'Control ').replace('checkpoint', 'Checkpoint ').toUpperCase();
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}
