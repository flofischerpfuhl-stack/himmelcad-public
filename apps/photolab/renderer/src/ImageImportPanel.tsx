import type {
  ExifGpsPosition,
  HcapImportPreview,
  PhotoImportBatch,
  PhotoMetadata,
} from '@himmelcad/data';
import {
  AlertTriangle,
  Check,
  FileImage,
  Film,
  FolderOpen,
  Grid3X3,
  LoaderCircle,
  MapPinned,
  PackageOpen,
  Search,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  ChatBubble,
  ChatCard,
  ChatChoices,
  EmptyPick,
  ImportChatRoot,
  ImportChatStream,
  Metric,
  Metrics,
  ProgressBar,
  importChatStyles as chat,
} from './ImportChat.js';
import {
  toStoredGrid,
  enrichGridPaths,
  resolveStoredGrid,
  warningsForOperation,
  type GridPolicy,
  type ImageImportWorkflow,
} from './importWorkflow.js';
import {
  attachLocalGridsToOperation,
  containsArea,
  gridLocalPath,
  heightReference,
  isVerticalGridFilename,
  normalizeGridKind,
  type CrsOperationCandidate,
  type GeographicArea,
  type GridCatalogEntry,
  type HeightSource,
  type LocalGridSelection,
  type RequiredGrid,
} from './importFreeze.js';

export type {
  CrsOperationCandidate,
  GridCatalogEntry,
  LocalGridSelection,
} from './importFreeze.js';

/** Top-level transform strategy. */
type TransformMode = 'none' | 'separate' | 'combined';
type YesNo = 'yes' | 'no';

type Phase =
  | 'pick'
  | 'preview'
  | 'mode'
  | 'vertical_ask' // height?
  | 'vertical_setup' // height CRS
  | 'vertical_grid' // geoid — known as soon as height transform is chosen
  | 'horizontal_ask' // horizontal?
  | 'horizontal_setup' // horizontal CRS
  | 'operations' // PROJ candidates (after both CRS)
  | 'op_horizontal_grid' // NTv2 only if selected op requires it
  | 'combined_method'
  | 'combined_cal'
  | 'combined_helmert'
  | 'review';

interface CrsDefinition {
  kind: 'epsg' | 'authority';
  value: number | string;
}

interface CrsWithEpoch {
  crs: CrsDefinition;
}

export interface CrsOperationDiscovery {
  candidates: CrsOperationCandidate[];
  audit: { versions: { projVersion: string; epsgDatabaseVersion: string } };
  warnings: string[];
}

export interface CrsOperationQuery {
  source: CrsWithEpoch;
  target: CrsWithEpoch;
  areaOfInterest: GeographicArea;
  selectionPolicy: { allowBallpark: boolean; onlyBest: boolean };
  gridCatalog: GridCatalogEntry[];
}

export interface ImageImportDecision {
  schemaVersion: number;
  containsGpsData: boolean;
  horizontal: { source: CrsWithEpoch; target: CrsWithEpoch };
  vertical: {
    source: Record<string, unknown>;
    target: Record<string, unknown>;
    mode: 'preserveValues' | 'transform';
  };
  areaOfInterest: GeographicArea;
  operation: CrsOperationCandidate;
  selectionPolicy: { allowBallpark: boolean; onlyBest: boolean };
  databaseVersions: { projVersion: string; epsgDatabaseVersion: string };
}

export interface ImageImportProgress {
  fraction: number;
  message: string;
  phase: 'inspect' | 'grid' | 'commit';
  indeterminate?: boolean;
}

export interface ImageImportPanelProps {
  batch: PhotoImportBatch | null;
  busy: boolean;
  progress: ImageImportProgress | null;
  gridProgress: ImageImportProgress | null;
  error: string | null;
  videoImportHint: string | null;
  himmelcapImports: readonly HcapImportPreview[];
  onChooseMoreFiles: () => void;
  onChooseFolder: () => void;
  onChooseHimmelcap: () => void;
  onChooseVideo: () => void;
  onSelectGrid: (kind: 'horizontal' | 'vertical') => Promise<LocalGridSelection | null>;
  onDiscoverCrs: (query: CrsOperationQuery) => Promise<CrsOperationDiscovery>;
  onCommit: (decision: ImageImportDecision) => Promise<void>;
  onCancel: () => void;
  onError: (message: string) => void;
}

export interface CrsPreset {
  code: number;
  name: string;
  region: string;
  hint: string;
}

export const HORIZONTAL_CRS_PRESETS: readonly CrsPreset[] = [
  { code: 4326, name: 'WGS 84', region: 'Global', hint: 'Geographic longitude / latitude' },
  { code: 3857, name: 'WGS 84 / Pseudo-Mercator', region: 'Global', hint: 'Web mapping' },
  { code: 25828, name: 'ETRS89 / UTM zone 28N', region: 'Europe', hint: 'UTM 28N' },
  { code: 25829, name: 'ETRS89 / UTM zone 29N', region: 'Europe', hint: 'UTM 29N' },
  { code: 25830, name: 'ETRS89 / UTM zone 30N', region: 'Europe', hint: 'UTM 30N' },
  { code: 25831, name: 'ETRS89 / UTM zone 31N', region: 'Europe', hint: 'UTM 31N' },
  { code: 25832, name: 'ETRS89 / UTM zone 32N', region: 'Europe', hint: 'UTM 32N' },
  { code: 25833, name: 'ETRS89 / UTM zone 33N', region: 'Europe', hint: 'UTM 33N' },
  { code: 25834, name: 'ETRS89 / UTM zone 34N', region: 'Europe', hint: 'UTM 34N' },
  { code: 25835, name: 'ETRS89 / UTM zone 35N', region: 'Europe', hint: 'UTM 35N' },
  { code: 25836, name: 'ETRS89 / UTM zone 36N', region: 'Europe', hint: 'UTM 36N' },
  { code: 25837, name: 'ETRS89 / UTM zone 37N', region: 'Europe', hint: 'UTM 37N' },
  { code: 25838, name: 'ETRS89 / UTM zone 38N', region: 'Europe', hint: 'UTM 38N' },
  { code: 32628, name: 'WGS 84 / UTM zone 28N', region: 'Global', hint: 'UTM 28N' },
  { code: 32629, name: 'WGS 84 / UTM zone 29N', region: 'Global', hint: 'UTM 29N' },
  { code: 32630, name: 'WGS 84 / UTM zone 30N', region: 'Global', hint: 'UTM 30N' },
  { code: 32631, name: 'WGS 84 / UTM zone 31N', region: 'Global', hint: 'UTM 31N' },
  { code: 32632, name: 'WGS 84 / UTM zone 32N', region: 'Global', hint: 'UTM 32N' },
  { code: 32633, name: 'WGS 84 / UTM zone 33N', region: 'Global', hint: 'UTM 33N' },
  { code: 32634, name: 'WGS 84 / UTM zone 34N', region: 'Global', hint: 'UTM 34N' },
  { code: 32635, name: 'WGS 84 / UTM zone 35N', region: 'Global', hint: 'UTM 35N' },
  { code: 32636, name: 'WGS 84 / UTM zone 36N', region: 'Global', hint: 'UTM 36N' },
  { code: 32637, name: 'WGS 84 / UTM zone 37N', region: 'Global', hint: 'UTM 37N' },
  { code: 32638, name: 'WGS 84 / UTM zone 38N', region: 'Global', hint: 'UTM 38N' },
  { code: 32728, name: 'WGS 84 / UTM zone 28S', region: 'Global', hint: 'UTM 28S' },
  { code: 32729, name: 'WGS 84 / UTM zone 29S', region: 'Global', hint: 'UTM 29S' },
  { code: 32730, name: 'WGS 84 / UTM zone 30S', region: 'Global', hint: 'UTM 30S' },
  { code: 32731, name: 'WGS 84 / UTM zone 31S', region: 'Global', hint: 'UTM 31S' },
  { code: 32732, name: 'WGS 84 / UTM zone 32S', region: 'Global', hint: 'UTM 32S' },
  { code: 32733, name: 'WGS 84 / UTM zone 33S', region: 'Global', hint: 'UTM 33S' },
  { code: 32734, name: 'WGS 84 / UTM zone 34S', region: 'Global', hint: 'UTM 34S' },
  { code: 32735, name: 'WGS 84 / UTM zone 35S', region: 'Global', hint: 'UTM 35S' },
  { code: 32736, name: 'WGS 84 / UTM zone 36S', region: 'Global', hint: 'UTM 36S' },
  { code: 32737, name: 'WGS 84 / UTM zone 37S', region: 'Global', hint: 'UTM 37S' },
  { code: 32738, name: 'WGS 84 / UTM zone 38S', region: 'Global', hint: 'UTM 38S' },
  { code: 31466, name: 'DHDN / Gauss-Krueger zone 2', region: 'Germany', hint: '6° meridian' },
  { code: 31467, name: 'DHDN / Gauss-Krueger zone 3', region: 'Germany', hint: '9° meridian' },
  { code: 31468, name: 'DHDN / Gauss-Krueger zone 4', region: 'Germany', hint: '12° meridian' },
  { code: 31469, name: 'DHDN / Gauss-Krueger zone 5', region: 'Germany', hint: '15° meridian' },
  {
    code: 3035,
    name: 'ETRS89-extended / LAEA Europe',
    region: 'Europe',
    hint: 'European analysis',
  },
  { code: 4258, name: 'ETRS89', region: 'Europe', hint: 'Geographic' },
  { code: 2056, name: 'CH1903+ / LV95', region: 'Switzerland', hint: 'Modern Swiss grid' },
  { code: 31287, name: 'MGI / Austria Lambert', region: 'Austria', hint: 'National projected CRS' },
  { code: 2154, name: 'RGF93 v1 / Lambert-93', region: 'France', hint: 'France mainland' },
  { code: 28992, name: 'Amersfoort / RD New', region: 'Netherlands', hint: 'Dutch national grid' },
  {
    code: 27700,
    name: 'OSGB36 / British National Grid',
    region: 'United Kingdom',
    hint: 'Great Britain',
  },
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

const BETA2007: GridCatalogEntry = {
  kind: 'gtg',
  officialFilename: 'de_adv_BETA2007.tif',
  officialSha256: '46e681fcc7d022dde1db1f9d0a3426a9bfb1d4a151af69a81b3c30104c9388e2',
  license: {
    licenseName: 'AdV free redistribution notice',
    source: 'https://cdn.proj.org/de_adv_README.txt',
    redistributionAllowed: true,
  },
  coverage: {
    westLongitude: 5.4166667,
    southLatitude: 46.95,
    eastLongitude: 15.75,
    northLatitude: 55.35,
  },
};

const GCG2016: GridCatalogEntry = {
  kind: 'geoid',
  officialFilename: 'de_bkg_gcg2016.tif',
  officialSha256: '598f18324dea7f8e72421d18add7ac6228259adf91eeb335cc9c27d98484f7ac',
  license: {
    licenseName: 'Creative Commons Attribution 4.0',
    spdxExpression: 'CC-BY-4.0',
    source: 'https://cdn.proj.org/de_bkg_README.txt',
    redistributionAllowed: true,
  },
  coverage: {
    westLongitude: 3.25625,
    southLatitude: 47.2208333,
    eastLongitude: 15.11875,
    northLatitude: 55.9791667,
  },
};

const MODE_LABEL: Record<TransformMode, string> = {
  none: 'None — keep values',
  separate: 'Separate — height then horizontal',
  combined: 'Combined — site cal / joint 3D',
};

export function ImageImportPanel({
  batch,
  busy,
  progress,
  gridProgress,
  error,
  videoImportHint,
  himmelcapImports,
  onChooseMoreFiles,
  onChooseFolder,
  onChooseHimmelcap,
  onChooseVideo,
  onSelectGrid,
  onDiscoverCrs,
  onCommit,
  onCancel,
  onError,
}: ImageImportPanelProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>('pick');
  const [mode, setMode] = useState<TransformMode | null>(null);
  const [doVertical, setDoVertical] = useState<YesNo | null>(null);
  const [doHorizontal, setDoHorizontal] = useState<YesNo | null>(null);
  const [sourceVerticalEpsg, setSourceVerticalEpsg] = useState(4979);
  const [targetVerticalEpsg, setTargetVerticalEpsg] = useState(7837);
  const [sourceHorizontalEpsg, setSourceHorizontalEpsg] = useState(4326);
  const [targetHorizontalEpsg, setTargetHorizontalEpsg] = useState(25832);
  const [verticalGrid, setVerticalGrid] = useState<LocalGridSelection | null>(null);
  const [horizontalGrid, setHorizontalGrid] = useState<LocalGridSelection | null>(null);
  const [siteCalPath, setSiteCalPath] = useState<string | null>(null);
  const [helmert, setHelmert] = useState({
    tx: '',
    ty: '',
    tz: '',
    rx: '',
    ry: '',
    rz: '',
    scale: '1',
  });
  const [gridPolicy, setGridPolicy] = useState<GridPolicy | null>(null);
  const [discovery, setDiscovery] = useState<CrsOperationDiscovery | null>(null);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  /** Pinned at click time — survives rediscovery when NTv2 is attached after the pick. */
  const [pinnedOperation, setPinnedOperation] = useState<CrsOperationCandidate | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  const [workflowSavedName, setWorkflowSavedName] = useState<string | null>(null);
  const [gridStepCompleted, setGridStepCompleted] = useState(false);
  const [saveFormOpen, setSaveFormOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDescription, setSaveDescription] = useState('');
  const [saveFormError, setSaveFormError] = useState<string | null>(null);
  const [workflowQuery, setWorkflowQuery] = useState('');
  const [fileWorkflows, setFileWorkflows] = useState<
    Array<{ name: string; path: string; savedAt: string; kind?: string; description?: string }>
  >([]);

  const transformHorizontal =
    mode === 'combined' || (mode === 'separate' && doHorizontal === 'yes');
  const heightSource = heightSourceFromVerticalEpsg(sourceVerticalEpsg);
  /** Local / relative (99999) is labeled only — no metric geoid transform. */
  const transformHeight =
    (mode === 'combined' || (mode === 'separate' && doVertical === 'yes')) &&
    heightSource !== 'deviceProfile';

  useEffect(() => {
    if (batch && phase === 'pick') setPhase('preview');
  }, [batch, phase]);

  useEffect(() => {
    if (!batch) {
      setPhase('pick');
      setMode(null);
      setDoVertical(null);
      setDoHorizontal(null);
      setDiscovery(null);
      setSelectedOperationId(null);
      setPinnedOperation(null);
      setSiteCalPath(null);
      setGridPolicy(null);
    }
  }, [batch]);

  const area = useMemo(() => imageArea(batch), [batch]);
  const query = useMemo(
    () =>
      buildOperationQuery({
        area,
        heightSource,
        sourceVerticalEpsg,
        transformHeight,
        targetVerticalEpsg,
        sourceHorizontalEpsg: transformHorizontal ? sourceHorizontalEpsg : targetHorizontalEpsg,
        targetHorizontalEpsg,
        verticalGrid,
        horizontalGrid,
        allowBundledGrids: true,
      }),
    [
      area,
      heightSource,
      horizontalGrid,
      sourceHorizontalEpsg,
      sourceVerticalEpsg,
      targetHorizontalEpsg,
      targetVerticalEpsg,
      transformHeight,
      transformHorizontal,
      verticalGrid,
    ],
  );
  const queryKey = JSON.stringify(query);
  const usablePhotos = batch?.photos.filter((photo) => photo.duplicateOf == null) ?? [];
  const gpsCount =
    batch?.photos.filter((photo) => preferredGps(photo.metadata) != null).length ?? 0;
  const rtkCount = batch?.photos.filter((photo) => photo.metadata.djiXmp.rtk != null).length ?? 0;
  const selectedFromDiscovery =
    discovery?.candidates.find((candidate) => candidate.operationId === selectedOperationId) ??
    null;
  // Prefer pinned op so choosing NTv2 after the pick cannot wipe the selection.
  const selectedOperation = pinnedOperation ?? selectedFromDiscovery;
  const heightDecisionSupported =
    !transformHeight || heightSource === 'ellipsoidal' || heightSource === 'orthometric';
  // Discover only while choosing ops for Separate — never for None, not on review.
  const needsDiscovery = phase === 'operations' && mode === 'separate';
  // None = keep coordinates as-is; no operation pick, no discovery UI.
  const operationReady =
    mode === 'none'
      ? true
      : heightDecisionSupported &&
        selectedOperation != null &&
        !selectedOperation.ballpark &&
        // Separate: CRS done + optional post-op NTv2 step finished.
        (mode !== 'separate' || gridStepCompleted) &&
        // Discovery must have completed at least once for this CRS pair.
        discovery != null;

  // Site-cal file path is UI-only until a .cal/.dc parser exists.
  const siteCalBlocked = mode === 'combined' && siteCalPath != null;
  // Combined without file still uses compound PROJ CRS operation.

  useEffect(() => {
    if (!needsDiscovery || !heightDecisionSupported || mode == null) return;
    if (siteCalBlocked) return; // cannot discover until parser lands
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setOperationBusy(true);
      setOperationError(null);
      void onDiscoverCrs(query)
        .then((result) => {
          if (cancelled) return;
          setDiscovery(result);
          // Rematch pin by id or name; never drop a user pick silently.
          setPinnedOperation((prev) => {
            if (!prev) return null;
            const match =
              result.candidates.find((c) => c.operationId === prev.operationId) ??
              result.candidates.find((c) => c.name === prev.name);
            return match ?? prev;
          });
          setSelectedOperationId((prev) => {
            if (!prev) return null;
            if (result.candidates.some((c) => c.operationId === prev)) return prev;
            // Keep prev id even if rediscovery rewrote hashes — pin holds the real op.
            return prev;
          });
          if (result.candidates.length === 0) {
            const message =
              'No accurate PROJ operation found for this CRS pair (missing grids may drop candidates).';
            setOperationError(message);
            onError(message);
          }
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setDiscovery(null);
          setSelectedOperationId(null);
          setPinnedOperation(null);
          const message = reason instanceof Error ? reason.message : String(reason);
          setOperationError(message);
          onError(message);
        })
        .finally(() => {
          if (!cancelled) setOperationBusy(false);
        });
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    heightDecisionSupported,
    mode,
    needsDiscovery,
    onDiscoverCrs,
    onError,
    query,
    queryKey,
    siteCalBlocked,
  ]);

  const chooseGrid = async (target: 'horizontal' | 'vertical') => {
    setOperationBusy(true);
    setOperationError(null);
    try {
      const selected = await onSelectGrid(target);
      if (!selected) return;
      if (target === 'vertical' && selected.kind !== 'geoid')
        throw new Error(`${selected.filename} is a horizontal grid, not a geoid or quasigeoid.`);
      if (target === 'horizontal' && selected.kind === 'geoid')
        throw new Error(
          `${selected.filename} is a vertical grid, not an NTv2 / horizontal GTG grid.`,
        );
      if (!containsArea(selected.coverage, area))
        throw new Error(
          `${selected.filename} does not cover the photo area (${formatArea(area)}). Grid coverage is ${formatArea(selected.coverage)}.`,
        );
      const enriched = enrichGridPaths(selected, null);
      if (target === 'horizontal') {
        setHorizontalGrid(enriched);
        rememberGrid('horizontal', enriched);
      } else {
        setVerticalGrid(enriched);
        rememberGrid('vertical', enriched);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setOperationError(message);
      onError(message);
    } finally {
      setOperationBusy(false);
    }
  };

  const clearFrom = (step: Phase) => {
    setOperationError(null);
    // Keep discovery when only rewinding post-op grid steps.
    // Keep discovery when only rewinding the post-op NTv2 step.
    if (step !== 'operations' && step !== 'op_horizontal_grid') {
      setDiscovery(null);
      setSelectedOperationId(null);
      setPinnedOperation(null);
    }
    if (step === 'operations' || step === 'mode' || step === 'preview') {
      setGridStepCompleted(false);
    }
    if (step === 'operations') {
      setSelectedOperationId(null);
      setPinnedOperation(null);
    }
    if (step === 'preview' || step === 'mode') {
      setMode(null);
      setDoVertical(null);
      setDoHorizontal(null);
      setSiteCalPath(null);
      setVerticalGrid(null);
      setHorizontalGrid(null);
      setGridPolicy(null);
      setGridStepCompleted(false);
    }
    if (step === 'vertical_ask') {
      setDoVertical(null);
      setDoHorizontal(null);
      setVerticalGrid(null);
      setHorizontalGrid(null);
    }
    if (step === 'vertical_setup') {
      setDoHorizontal(null);
      setHorizontalGrid(null);
    }
    if (step === 'horizontal_ask') {
      setDoHorizontal(null);
      setHorizontalGrid(null);
    }
    if (step === 'combined_method' || step === 'combined_cal' || step === 'combined_helmert') {
      setSiteCalPath(null);
    }
    if (step === 'operations') {
      // Back to operation list: drop only NTv2 choice (geoid stays from height step).
      setHorizontalGrid(null);
      setGridStepCompleted(false);
    }
    setPhase(step);
  };

  const onMode = (id: string) => {
    const next = id as TransformMode;
    setMode(next);
    setDoVertical(null);
    setDoHorizontal(null);
    setSiteCalPath(null);
    if (next === 'none') {
      setSourceHorizontalEpsg(targetHorizontalEpsg);
      setDoVertical('no');
      setDoHorizontal('no');
      setVerticalGrid(null);
      setHorizontalGrid(null);
      setGridPolicy(null);
      setGridStepCompleted(true);
      setDiscovery(null);
      setSelectedOperationId(null);
      setPinnedOperation(null);
      setOperationError(null);
      // No transform → skip operation discovery entirely.
      setPhase('review');
      return;
    }
    if (next === 'separate') {
      setPhase('vertical_ask');
      return;
    }
    setPhase('combined_method');
  };

  const onVerticalAsk = (id: string) => {
    const answer = id as YesNo;
    setDoVertical(answer);
    if (answer === 'yes') setPhase('vertical_setup');
    else setPhase('horizontal_ask');
  };

  const confirmVerticalSetup = () => {
    rememberCrs('vertical', sourceVerticalEpsg);
    rememberCrs('vertical', targetVerticalEpsg);
    // Height transform ⇒ we already know a geoid is relevant (except local/relative).
    if (heightSourceFromVerticalEpsg(sourceVerticalEpsg) === 'deviceProfile') {
      setPhase('horizontal_ask');
      return;
    }
    const remembered = loadRememberedGrid('vertical');
    if (remembered) setVerticalGrid(remembered);
    setPhase('vertical_grid');
  };

  const confirmVerticalGrid = (useLocal: boolean) => {
    if (!useLocal) setVerticalGrid(null);
    else if (verticalGrid) rememberGrid('vertical', verticalGrid);
    setPhase('horizontal_ask');
  };

  const onHorizontalAsk = (id: string) => {
    const answer = id as YesNo;
    setDoHorizontal(answer);
    if (answer === 'yes') setPhase('horizontal_setup');
    else {
      setSourceHorizontalEpsg(targetHorizontalEpsg);
      advanceToOperations();
    }
  };

  const confirmHorizontalSetup = () => {
    rememberCrs('horizontal', sourceHorizontalEpsg);
    rememberCrs('horizontal', targetHorizontalEpsg);
    // Do NOT pick NTv2 yet — only after PROJ says this operation needs one.
    advanceToOperations();
  };

  /** After height(+geoid) and horizontal CRS: discover PROJ ops (keep geoid choice). */
  const advanceToOperations = () => {
    setHorizontalGrid(null); // NTv2 not chosen yet
    setGridStepCompleted(false);
    setGridPolicy(verticalGrid ? 'ntv2' : null);
    setPhase('operations');
  };

  const opNeedsHorizontalGrid = (op: CrsOperationCandidate | null): boolean =>
    !!op?.requiredGrids.some((g) => !isVerticalGridFilename(g.officialFilename));

  /**
   * After PROJ operation pick: only if THIS pipeline lists an NTv2/GTG, ask for it.
   * Geoid was already decided after height.
   */
  const confirmOperation = () => {
    if (!selectedOperation || selectedOperation.ballpark) return;
    if (opNeedsHorizontalGrid(selectedOperation)) {
      const remembered = loadRememberedGrid('horizontal');
      if (remembered) setHorizontalGrid(remembered);
      setPhase('op_horizontal_grid');
      return;
    }
    setGridStepCompleted(true);
    setGridPolicy(verticalGrid || horizontalGrid ? 'ntv2' : 'projOnly');
    setPhase('review');
  };

  const confirmOpHorizontalGrid = (useLocal: boolean) => {
    if (!useLocal) setHorizontalGrid(null);
    else if (horizontalGrid) rememberGrid('horizontal', horizontalGrid);
    setGridStepCompleted(true);
    setGridPolicy(verticalGrid || horizontalGrid ? 'ntv2' : 'projOnly');
    setPhase('review');
  };

  const onCombinedMethod = (id: string) => {
    if (id === 'cal') {
      setPhase('combined_cal');
      return;
    }
    if (id === 'helmert') {
      setPhase('combined_helmert');
      return;
    }
  };

  const confirmCombinedCal = () => {
    if (!siteCalPath) {
      setOperationError('Choose a site-calibration file or go back.');
      return;
    }
    setOperationError(
      'Site-calibration (.cal / .dc) reader is not implemented yet. Use Separate for CRS/grid imports, or 7-parameter once wired.',
    );
    onError('Site-calibration (.cal / .dc) reader is not implemented yet.');
  };

  const confirmCombinedHelmert = () => {
    if (!helmertParamsComplete(helmert)) {
      setOperationError('Enter all seven parameters (tx ty tz rx ry rz scale).');
      return;
    }
    setOperationError(
      '7-parameter combined transform is in the transform module but not yet connected to image import commit. Use Separate for CRS imports for now.',
    );
    onError('7-parameter combined transform is not yet connected to image import commit.');
  };

  const refreshFileWorkflows = async () => {
    try {
      const api = window.himmelcad;
      if (!api?.workflows?.list) return;
      const items = await api.workflows.list();
      setFileWorkflows(items.filter((item) => !item.kind || item.kind === 'image'));
    } catch {
      setFileWorkflows([]);
    }
  };

  useEffect(() => {
    if (mode == null && batch) void refreshFileWorkflows();
  }, [batch, mode]);

  const openSaveWorkflowForm = () => {
    setSaveName(workflowSavedName ?? `Image-EPSG${targetHorizontalEpsg}`);
    setSaveDescription('');
    setSaveFormError(null);
    setSaveFormOpen(true);
  };

  const buildWorkflowPayload = (name: string, description: string): ImageImportWorkflow => {
    const op = selectedOperation;
    // Strip catalog SHA pins from stored ops — user grids must not re-import CDN hashes.
    const requiredGrids = op
      ? op.requiredGrids.map((grid) => {
          const path = gridLocalPath(grid);
          return {
            ...(grid.kind === undefined ? {} : { kind: grid.kind }),
            officialFilename: grid.officialFilename,
            ...(grid.license === undefined ? {} : { license: grid.license }),
            ...(grid.coverage === undefined ? {} : { coverage: grid.coverage }),
            availability: path
              ? { state: 'presentVerified' as const, local_path: path }
              : { state: 'missing' as const },
          };
        })
      : [];
    return {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      name: name.trim(),
      description: description.trim(),
      kind: 'image',
      savedAt: new Date().toISOString(),
      mode: mode ?? 'none',
      doVertical,
      doHorizontal,
      sourceHorizontalEpsg,
      targetHorizontalEpsg,
      sourceVerticalEpsg,
      targetVerticalEpsg,
      gridPolicy,
      verticalGrid: verticalGrid ? toStoredGrid(verticalGrid) : null,
      horizontalGrid: horizontalGrid ? toStoredGrid(horizontalGrid) : null,
      operation: op
        ? {
            operationId: op.operationId,
            name: op.name,
            kind: op.kind,
            projPipeline: op.projPipeline,
            areaOfUse: op.areaOfUse,
            ...(op.expectedAccuracyMm != null ? { expectedAccuracyMm: op.expectedAccuracyMm } : {}),
            ballpark: op.ballpark,
            bestAvailable: true as const,
            requiredGrids,
          }
        : null,
      gridStepCompleted: gridStepCompleted || mode === 'none',
      discoveryAudit: discovery?.audit.versions ?? {
        projVersion: 'unknown',
        epsgDatabaseVersion: 'unknown',
      },
      discoveryWarnings: discovery?.warnings ?? [],
    };
  };

  const submitSaveWorkflow = async () => {
    const suggested = saveName.trim() || `Image-EPSG${targetHorizontalEpsg}`;
    const workflow = buildWorkflowPayload(suggested, saveDescription);
    try {
      const api = window.himmelcad;
      if (!api?.workflows?.save) {
        setSaveFormError('Desktop save dialog is unavailable.');
        return;
      }
      // Name becomes the suggested filename; OS dialog allows overwrite.
      const result = await api.workflows.save({
        suggestedName: suggested,
        workflow: { ...workflow, name: suggested },
      });
      if (!result) return; // canceled
      setWorkflowSavedName(result.name);
      setSaveFormOpen(false);
      void refreshFileWorkflows();
    } catch (reason) {
      setSaveFormError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const applyLoadedWorkflowFile = async (path: string, raw: unknown) => {
    const wf = raw as ImageImportWorkflow;
    if (!wf || wf.kind !== 'image') {
      setOperationError('Not an image import workflow.');
      return;
    }
    const stem = path.replace(/^.*[/\\]/, '').replace(/\.json$/i, '');
    await loadWorkflow({ ...wf, name: wf.name?.trim() || stem });
    void refreshFileWorkflows();
  };

  const openWorkflowFile = async () => {
    try {
      const api = window.himmelcad;
      if (!api?.workflows?.open) {
        setOperationError(
          'Workflow file dialog is unavailable. Restart PhotoLab so the desktop bridge reloads (electron main/preload).',
        );
        return;
      }
      const result = await api.workflows.open();
      if (!result) return;
      await applyLoadedWorkflowFile(result.path, result.workflow);
    } catch (reason) {
      setOperationError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const loadWorkflowFromPath = async (path: string) => {
    try {
      const api = window.himmelcad;
      if (!api?.workflows?.loadPath) return;
      const result = await api.workflows.loadPath(path);
      await applyLoadedWorkflowFile(result.path, result.workflow);
    } catch (reason) {
      setOperationError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const pathExistsProbe = async (path: string): Promise<boolean> => {
    try {
      const api = window.himmelcad as { pathExists?: (p: string) => Promise<boolean> } | undefined;
      if (api?.pathExists) return api.pathExists(path);
      return true; // keep stored absolute path if no FS probe
    } catch {
      return true;
    }
  };

  const loadWorkflow = async (workflow: ImageImportWorkflow) => {
    setOperationError(null);
    if (workflow.mode === 'combined') {
      setOperationError('Not available yet — the site-calibration reader is not implemented');
      setMode(null);
      setPhase('mode');
      return;
    }
    setWorkflowSavedName(workflow.name);
    setMode(workflow.mode);
    setDoVertical(workflow.doVertical);
    setDoHorizontal(workflow.doHorizontal);
    setSourceHorizontalEpsg(workflow.sourceHorizontalEpsg);
    setTargetHorizontalEpsg(workflow.targetHorizontalEpsg);
    setSourceVerticalEpsg(workflow.sourceVerticalEpsg);
    setTargetVerticalEpsg(workflow.targetVerticalEpsg);
    setGridPolicy(workflow.gridPolicy);
    setSiteCalPath(null);

    // Restore grids (absolute path first, then relative fallback in resolveStoredGrid).
    if (workflow.verticalGrid) {
      const resolved = await resolveStoredGrid(workflow.verticalGrid, null, pathExistsProbe);
      setVerticalGrid(
        resolved ?? {
          filename: workflow.verticalGrid.filename,
          localPath: workflow.verticalGrid.absolutePath || workflow.verticalGrid.localPath,
          absolutePath: workflow.verticalGrid.absolutePath,
          relativePath: workflow.verticalGrid.relativePath,
          kind: workflow.verticalGrid.kind,
          driver: workflow.verticalGrid.driver,
          coverage: workflow.verticalGrid.coverage,
        },
      );
    } else setVerticalGrid(null);

    if (workflow.horizontalGrid) {
      const resolved = await resolveStoredGrid(workflow.horizontalGrid, null, pathExistsProbe);
      setHorizontalGrid(
        resolved ?? {
          filename: workflow.horizontalGrid.filename,
          localPath: workflow.horizontalGrid.absolutePath || workflow.horizontalGrid.localPath,
          absolutePath: workflow.horizontalGrid.absolutePath,
          relativePath: workflow.horizontalGrid.relativePath,
          kind: workflow.horizontalGrid.kind,
          driver: workflow.horizontalGrid.driver,
          coverage: workflow.horizontalGrid.coverage,
        },
      );
    } else setHorizontalGrid(null);

    const storedOp = workflow.operation ?? null;
    if (workflow.mode === 'none') {
      setPinnedOperation(null);
      setSelectedOperationId(null);
      setDiscovery(null);
      setGridStepCompleted(true);
      setPhase('review');
      return;
    }
    if (storedOp && !storedOp.ballpark) {
      // Full restore: pin op + synthetic discovery so import works without re-discover.
      const restored: CrsOperationCandidate = {
        operationId: storedOp.operationId,
        name: storedOp.name,
        kind: storedOp.kind,
        projPipeline: storedOp.projPipeline,
        areaOfUse: storedOp.areaOfUse,
        ...(storedOp.expectedAccuracyMm != null
          ? { expectedAccuracyMm: storedOp.expectedAccuracyMm }
          : {}),
        ballpark: storedOp.ballpark,
        bestAvailable: true,
        requiredGrids: storedOp.requiredGrids as RequiredGrid[],
      };
      setPinnedOperation(restored);
      setSelectedOperationId(restored.operationId);
      setDiscovery({
        candidates: [restored],
        audit: {
          versions: workflow.discoveryAudit ?? {
            projVersion: 'restored',
            epsgDatabaseVersion: 'restored',
          },
        },
        warnings: workflow.discoveryWarnings ?? [],
      });
      // Older saves without the flag: treat as complete when an op was stored.
      const gridsDone = workflow.gridStepCompleted ?? true;
      if (gridsDone) {
        setGridStepCompleted(true);
        setPhase('review');
        return;
      }
      // Op restored but NTv2 step not finished yet.
      if (opNeedsHorizontalGrid(restored)) {
        setGridStepCompleted(false);
        setPhase('op_horizontal_grid');
        return;
      }
      setGridStepCompleted(true);
      setPhase('review');
      return;
    }

    // Incomplete / legacy workflows: restore CRS+grids, re-run discovery for op pick.
    setPinnedOperation(null);
    setSelectedOperationId(null);
    setDiscovery(null);
    setGridStepCompleted(false);
    setPhase('operations');
  };

  const scrollKey = [
    phase,
    batch?.photos.length ?? 0,
    mode ?? '',
    doVertical ?? '',
    doHorizontal ?? '',
    siteCalPath ?? '',
    discovery?.candidates.length ?? 0,
    operationBusy,
    busy,
    error ?? '',
    saveFormOpen ? '1' : '0',
    workflowSavedName ?? '',
  ].join('|');

  const locked = busy || operationBusy;

  if (!batch || (busy && progress?.phase === 'inspect')) {
    return (
      <ImportChatRoot
        title="Image Import"
        onClose={onCancel}
        closeLabel="Close image import"
        busy={busy}
      >
        <EmptyPick
          icon={
            error ? (
              <AlertTriangle size={34} className={chat.warningText} />
            ) : busy ? (
              <LoaderCircle className={chat.spinner} size={34} />
            ) : (
              <FileImage size={34} />
            )
          }
          title={
            error ??
            videoImportHint ??
            progress?.message ??
            'Choose images, a folder or a Cap project'
          }
          detail={
            error
              ? 'No image or project data was changed.'
              : videoImportHint
                ? 'Video extraction is a separate flow so the original capture and frame-selection policy stay traceable.'
                : busy
                  ? 'EXIF, XMP, DJI, GPS and RTK metadata are retained. Nothing is committed yet.'
                  : 'Select a .hcap project, folder or image files to inspect metadata before import.'
          }
        >
          {error || !busy ? (
            <>
              <button type="button" className={chat.choice} onClick={onChooseMoreFiles}>
                <FileImage size={14} /> Choose images
              </button>
              <button
                type="button"
                className={`${chat.choice} ${chat.choicePrimary}`}
                onClick={onChooseFolder}
              >
                <FolderOpen size={14} /> Choose folder
              </button>
              <button type="button" className={chat.choice} onClick={onChooseHimmelcap}>
                <PackageOpen size={14} /> Import .hcap
              </button>
              <button type="button" className={chat.choice} onClick={onChooseVideo}>
                <Film size={14} /> Video frames…
              </button>
            </>
          ) : (
            <div style={{ width: 'min(420px, 100%)' }}>
              <ProgressBar
                value={progress?.fraction ?? 0}
                indeterminate={progress?.indeterminate === true}
                indeterminateLabel="Discovering…"
              />
            </div>
          )}
        </EmptyPick>
      </ImportChatRoot>
    );
  }

  const pastMode = mode != null;
  const showVerticalSetup =
    mode === 'separate' &&
    doVertical === 'yes' &&
    phaseOrder(phase) >= phaseOrder('vertical_setup');
  const showHorizontalSetup =
    mode === 'separate' &&
    doHorizontal === 'yes' &&
    phaseOrder(phase) >= phaseOrder('horizontal_setup');
  const showOps = mode === 'separate' && phaseOrder(phase) >= phaseOrder('operations');
  const showReview = phase === 'review';

  return (
    <ImportChatRoot
      title="Image Import"
      onClose={onCancel}
      closeLabel="Close image import"
      busy={busy || operationBusy}
    >
      <ImportChatStream scrollKey={scrollKey}>
        {error && (
          <ChatBubble role="system" tone="error" title="Import could not continue" detail={error} />
        )}

        {videoImportHint && (
          <ChatBubble
            role="system"
            tone="warn"
            title="Use Video frames…"
            detail={videoImportHint}
          />
        )}

        <ChatBubble
          role="system"
          tone="ok"
          title={`${usablePhotos.length} images ready`}
          detail={`${batch.photos.length} found · ${batch.photos.length - usablePhotos.length} duplicates · ${gpsCount} GPS · ${rtkCount} RTK`}
        />

        {himmelcapImports.map((himmelcap) => (
          <ChatBubble
            key={himmelcap.sessionId}
            role="system"
            tone={himmelcap.warnings.length > 0 ? 'warn' : 'ok'}
            title={`${himmelcap.displayName} · verified Cap project`}
            detail={`${himmelcap.frameCount} frames · ${himmelcap.poseCount} position priors · schema v${himmelcap.schemaVersion}${himmelcap.packageProfile ? ` · ${himmelcap.packageProfile}` : ''}${himmelcap.warnings.length > 0 ? ` · ${himmelcap.warnings.join(' · ')}` : ''}`}
          />
        ))}

        <ChatCard
          title="Preview"
          onRevert={phase !== 'preview' ? () => clearFrom('preview') : undefined}
          revertDisabled={locked}
          actions={
            <div className={chat.toolbar}>
              <button
                type="button"
                className={chat.ghostBtn}
                onClick={onChooseMoreFiles}
                disabled={locked || himmelcapImports.length > 0}
              >
                <FileImage size={13} /> Add
              </button>
              <button
                type="button"
                className={chat.ghostBtn}
                onClick={onChooseFolder}
                disabled={locked || himmelcapImports.length > 0}
              >
                <FolderOpen size={13} /> Folder
              </button>
              {himmelcapImports.length === 0 && (
                <button
                  type="button"
                  className={chat.ghostBtn}
                  onClick={onChooseHimmelcap}
                  disabled={locked}
                >
                  <PackageOpen size={13} /> .hcap
                </button>
              )}
            </div>
          }
        >
          <Metrics>
            <Metric label="Found" value={String(batch.photos.length)} />
            <Metric label="Importable" value={String(usablePhotos.length)} />
            <Metric
              label="Warnings"
              value={String(batch.warnings.length)}
              warning={batch.warnings.length > 0}
            />
          </Metrics>
          <div className={chat.scrollList}>
            {batch.photos.slice(0, 120).map((photo) => (
              <div className={chat.listRow} key={`${photo.sha256}:${photo.sourcePath}`}>
                <FileImage size={13} />
                <span title={photo.sourcePath}>{fileName(photo.sourcePath)}</span>
                <small>{photo.metadata.exif.model ?? photo.format}</small>
                {preferredGps(photo.metadata) && <em>GPS</em>}
                {photo.metadata.djiXmp.rtk && <em>RTK</em>}
              </div>
            ))}
            {batch.photos.length > 120 && (
              <div className={chat.listMore}>+ {batch.photos.length - 120} more</div>
            )}
          </div>
        </ChatCard>

        {/* Transform mode */}
        <ChatBubble role="system" title="Coordinate transform" />
        {!pastMode && (
          <ChatCard
            title="Load transform workflow"
            actions={
              <button
                type="button"
                className={chat.ghostBtn}
                disabled={locked}
                onClick={() => void openWorkflowFile()}
                title="Open a workflow JSON file"
              >
                <FolderOpen size={13} /> Open file…
              </button>
            }
          >
            <div className={chat.crsSearch} style={{ marginBottom: 6 }}>
              <Search size={13} />
              <input
                type="search"
                value={workflowQuery}
                disabled={locked}
                placeholder="Search saved workflows…"
                onChange={(event) => setWorkflowQuery(event.target.value)}
              />
            </div>
            <div className={chat.crsSuggest} style={{ position: 'relative', maxHeight: 160 }}>
              {fileWorkflows
                .filter((workflow) => {
                  const q = workflowQuery.trim().toLowerCase();
                  if (!q) return true;
                  return `${workflow.name} ${workflow.description ?? ''}`.toLowerCase().includes(q);
                })
                .slice(0, 12)
                .map((workflow) => (
                  <button
                    key={workflow.path}
                    type="button"
                    disabled={locked}
                    onClick={() => void loadWorkflowFromPath(workflow.path)}
                  >
                    <strong>{workflow.name}</strong>
                    <small>
                      {(workflow.description?.trim() || 'No description') +
                        ` · ${new Date(workflow.savedAt).toLocaleString('en-US')}`}
                    </small>
                  </button>
                ))}
              {fileWorkflows.length === 0 && (
                <small style={{ color: 'var(--hc-fg-muted)', padding: 8, display: 'block' }}>
                  No workflows in the default folder yet. Use “Open file…” or save one after import
                  setup.
                </small>
              )}
            </div>
          </ChatCard>
        )}
        <ChatChoices
          resolvedId={mode}
          disabled={locked || pastMode}
          onSelect={onMode}
          onRevert={pastMode ? () => clearFrom('mode') : undefined}
          revertDisabled={locked}
          options={[
            { id: 'none', label: 'None', primary: true },
            { id: 'separate', label: 'Separate' },
            { id: 'combined', label: 'Combined' },
          ]}
        />
        {!pastMode && (
          <div className={chat.warnInline}>
            <AlertTriangle size={14} />
            <span>Not available yet — the site-calibration reader is not implemented</span>
          </div>
        )}
        {mode != null && <ChatBubble role="user">{MODE_LABEL[mode]}</ChatBubble>}

        {/* Separate: vertical ask */}
        {mode === 'separate' && phaseOrder(phase) >= phaseOrder('vertical_ask') && (
          <>
            <ChatBubble role="system" title="Transform height?" />
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
              <ChatBubble role="user">
                {doVertical === 'yes' ? 'Transform height' : 'Preserve heights'}
              </ChatBubble>
            )}
          </>
        )}

        {showVerticalSetup && (
          <ChatCard
            title="Height transform"
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
              disabled={locked || phaseOrder(phase) > phaseOrder('vertical_setup')}
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
          phaseOrder(phase) >= phaseOrder('vertical_grid') &&
          heightSourceFromVerticalEpsg(sourceVerticalEpsg) !== 'deviceProfile' && (
            <ChatCard
              title="Geoid / height grid"
              onRevert={() => clearFrom('vertical_setup')}
              revertDisabled={locked}
            >
              <p
                style={{
                  margin: '0 0 8px',
                  color: 'var(--hc-fg-muted)',
                  fontSize: 11,
                  lineHeight: 1.45,
                }}
              >
                Height transform needs a geoid. Choose a local file or keep the bundled default.
              </p>
              <GridSelector
                title="Geoid file"
                description={
                  verticalGrid
                    ? `${verticalGrid.filename} · ${verticalGrid.localPath}`
                    : targetVerticalEpsg === 7837
                      ? `${GCG2016.officialFilename} · bundled default if no file chosen`
                      : 'No local file — bundled/PROJ default'
                }
                bundled={targetVerticalEpsg === 7837 ? GCG2016.officialFilename : null}
                selected={verticalGrid}
                progress={gridProgress}
                busy={locked}
                onChoose={() => void chooseGrid('vertical')}
              />
              {phase === 'vertical_grid' && (
                <div className={chat.toolbar}>
                  <button
                    type="button"
                    className={`${chat.choice} ${chat.choicePrimary}`}
                    disabled={locked}
                    onClick={() => confirmVerticalGrid(Boolean(verticalGrid))}
                  >
                    {verticalGrid ? 'Continue with this file' : 'Continue with default / bundled'}
                  </button>
                  {verticalGrid && (
                    <button
                      type="button"
                      className={chat.choice}
                      disabled={locked}
                      onClick={() => confirmVerticalGrid(false)}
                    >
                      Clear · use default
                    </button>
                  )}
                </div>
              )}
              {!verticalGrid && phase === 'vertical_grid' && (
                <div className={chat.warnInline}>
                  <AlertTriangle size={14} />
                  <span>
                    Without a local survey-grade geoid the height transform may be less accurate.
                  </span>
                </div>
              )}
            </ChatCard>
          )}

        {mode === 'separate' && phaseOrder(phase) >= phaseOrder('horizontal_ask') && (
          <>
            <ChatBubble role="system" title="Transform horizontal coordinates?" />
            <ChatChoices
              resolvedId={doHorizontal}
              disabled={locked || doHorizontal != null}
              onSelect={onHorizontalAsk}
              onRevert={doHorizontal != null ? () => clearFrom('horizontal_ask') : undefined}
              revertDisabled={locked}
              options={[
                { id: 'no', label: 'No — keep horizontal', primary: true },
                { id: 'yes', label: 'Yes — transform horizontal' },
              ]}
            />
            {doHorizontal != null && (
              <ChatBubble role="user">
                {doHorizontal === 'yes' ? 'Transform horizontal' : 'Keep horizontal'}
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
            <CrsSearchPair
              sourceLabel="Source"
              targetLabel="Target"
              sourceValue={sourceHorizontalEpsg}
              targetValue={targetHorizontalEpsg}
              presets={HORIZONTAL_CRS_PRESETS}
              popular={POPULAR_HORIZONTAL}
              recentKey="horizontal"
              disabled={locked || phaseOrder(phase) > phaseOrder('horizontal_setup')}
              onSourceChange={setSourceHorizontalEpsg}
              onTargetChange={setTargetHorizontalEpsg}
            />
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

        {/* Combined: first choose method */}
        {mode === 'combined' && phaseOrder(phase) >= phaseOrder('combined_method') && (
          <>
            <ChatBubble role="system" title="Combined transform method" />
            <ChatChoices
              resolvedId={
                phase === 'combined_cal' || phase === 'combined_helmert'
                  ? phase === 'combined_cal'
                    ? 'cal'
                    : 'helmert'
                  : null
              }
              disabled={locked || phase !== 'combined_method'}
              onSelect={onCombinedMethod}
              onRevert={
                phase !== 'combined_method' ? () => clearFrom('combined_method') : undefined
              }
              revertDisabled={locked}
              options={[
                {
                  id: 'cal',
                  label: 'Site calibration file (.cal / .dc)',
                  primary: true,
                  disabled: true,
                },
                { id: 'helmert', label: 'Manual 7-parameter Helmert', disabled: true },
              ]}
            />
            <div className={chat.warnInline}>
              <AlertTriangle size={14} />
              <span>Not available yet — the site-calibration reader is not implemented</span>
            </div>
            {(phase === 'combined_cal' || phase === 'combined_helmert') && (
              <ChatBubble role="user">
                {phase === 'combined_cal' ? 'Site calibration file' : 'Manual 7-parameter Helmert'}
              </ChatBubble>
            )}
          </>
        )}

        {mode === 'combined' && phase === 'combined_cal' && (
          <ChatCard
            title="Site calibration file"
            onRevert={() => clearFrom('combined_method')}
            revertDisabled={locked}
          >
            <p style={{ margin: '0 0 10px', color: 'var(--hc-fg-muted)', fontSize: 11 }}>
              One joint transform from a Trimble .cal / .dc (or JobXML). Not a dual EPSG CRS setup —
              use Separate for that.
            </p>
            <div className={chat.gridRow}>
              <Grid3X3 size={16} />
              <div>
                <strong>Calibration file</strong>
                <span>Reader not implemented yet — UI only.</span>
                {siteCalPath && <code title={siteCalPath}>{fileName(siteCalPath)}</code>}
              </div>
              <button type="button" className={chat.ghostBtn} disabled>
                Choose file…
              </button>
            </div>
            <div className={chat.toolbar}>
              <button
                type="button"
                className={`${chat.choice} ${chat.choicePrimary}`}
                disabled={locked}
                onClick={confirmCombinedCal}
              >
                Continue
              </button>
            </div>
          </ChatCard>
        )}

        {mode === 'combined' && phase === 'combined_helmert' && (
          <ChatCard
            title="7-parameter Helmert"
            onRevert={() => clearFrom('combined_method')}
            revertDisabled={locked}
          >
            <p style={{ margin: '0 0 10px', color: 'var(--hc-fg-muted)', fontSize: 11 }}>
              Single joint 3D similarity (tx ty tz, rx ry rz, scale). Applied as one transform — not
              separate height + horizontal CRS steps.
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gap: 6,
              }}
            >
              {(
                [
                  ['tx', 'tx (m)'],
                  ['ty', 'ty (m)'],
                  ['tz', 'tz (m)'],
                  ['rx', 'rx (rad)'],
                  ['ry', 'ry (rad)'],
                  ['rz', 'rz (rad)'],
                  ['scale', 'scale'],
                ] as const
              ).map(([key, label]) => (
                <label
                  key={key}
                  style={{ display: 'grid', gap: 2, fontSize: 10, color: 'var(--hc-fg-muted)' }}
                >
                  {label}
                  <input
                    value={helmert[key]}
                    disabled={locked}
                    onChange={(e) => setHelmert({ ...helmert, [key]: e.target.value })}
                    style={{
                      height: 30,
                      padding: '0 6px',
                      border: '1px solid var(--hc-border-default)',
                      borderRadius: 'var(--hc-radius-sm)',
                      background: 'var(--hc-bg-input, var(--hc-bg-void))',
                      color: 'var(--hc-fg-default)',
                      font: '11px var(--hc-font-mono)',
                    }}
                  />
                </label>
              ))}
            </div>
            <div className={chat.toolbar}>
              <button
                type="button"
                className={`${chat.choice} ${chat.choicePrimary}`}
                disabled={locked}
                onClick={confirmCombinedHelmert}
              >
                Continue
              </button>
            </div>
          </ChatCard>
        )}

        {showOps && (
          <ChatCard
            title="Coordinate operation"
            onRevert={() =>
              clearFrom(
                mode === 'separate'
                  ? doHorizontal === 'yes'
                    ? 'horizontal_setup'
                    : doVertical === 'yes'
                      ? 'vertical_setup'
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
            ) : operationBusy ? (
              <>
                <strong style={{ fontSize: 11 }}>Validating with PROJ…</strong>
                <ProgressBar value={0} indeterminate indeterminateLabel="Validating…" />
              </>
            ) : discovery ? (
              <>
                <Metrics>
                  <Metric label="Candidates" value={String(discovery.candidates.length)} />
                  <Metric label="PROJ" value={discovery.audit.versions.projVersion} />
                  <Metric label="EPSG DB" value={discovery.audit.versions.epsgDatabaseVersion} />
                </Metrics>
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
                      onClick={() => {
                        setSelectedOperationId(candidate.operationId);
                        setPinnedOperation(candidate);
                      }}
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
                            ? 'Accuracy not published'
                            : `±${candidate.expectedAccuracyMm.toFixed(1)} mm`}
                          {candidate.ballpark ? ' · BALLPARK' : ''}
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
                {selectedOperation?.ballpark && (
                  <div className={chat.warnInline}>
                    <AlertTriangle size={14} />
                    <span>
                      This operation is marked ballpark (low accuracy). Prefer an NTv2 / geoid path
                      when centimetre accuracy is required.
                    </span>
                  </div>
                )}
                {phase === 'operations' && selectedOperationId && (
                  <div className={chat.toolbar}>
                    <button
                      type="button"
                      className={`${chat.choice} ${chat.choicePrimary}`}
                      disabled={locked || !selectedOperation || selectedOperation.ballpark}
                      onClick={confirmOperation}
                    >
                      Continue with this operation
                    </button>
                  </div>
                )}
              </>
            ) : operationError ? (
              <div className={chat.errorInline}>
                <AlertTriangle size={14} /> {operationError}
              </div>
            ) : (
              <small style={{ color: 'var(--hc-fg-muted)' }}>Waiting…</small>
            )}
          </ChatCard>
        )}

        {/* NTv2 only after PROJ op pick, and only if that op lists a horizontal grid */}
        {selectedOperation &&
          opNeedsHorizontalGrid(selectedOperation) &&
          phaseOrder(phase) >= phaseOrder('op_horizontal_grid') && (
            <ChatCard
              title="Horizontal datum grid (NTv2 / GTG)"
              onRevert={() => clearFrom('operations')}
              revertDisabled={locked}
            >
              <p
                style={{
                  margin: '0 0 8px',
                  color: 'var(--hc-fg-muted)',
                  fontSize: 11,
                  lineHeight: 1.45,
                }}
              >
                This PROJ operation lists a horizontal shift grid. Choose a local NTv2/GTG file, or
                keep the bundled/default.
              </p>
              <div className={chat.warnInline} style={{ marginBottom: 8 }}>
                <AlertTriangle size={14} />
                <span>
                  Pipeline expects:{' '}
                  {selectedOperation.requiredGrids
                    .filter((g) => !isVerticalGridFilename(g.officialFilename))
                    .map((g) => g.officialFilename)
                    .join(', ')}
                </span>
              </div>
              <GridSelector
                title="NTv2 / GTG file (optional override)"
                description={
                  horizontalGrid
                    ? `${horizontalGrid.filename} · ${horizontalGrid.localPath}`
                    : 'Using bundled/default if available'
                }
                bundled={
                  selectedOperation.requiredGrids.find(
                    (g) => !isVerticalGridFilename(g.officialFilename),
                  )?.officialFilename ?? null
                }
                selected={horizontalGrid}
                progress={gridProgress}
                busy={locked || phase !== 'op_horizontal_grid'}
                onChoose={() => void chooseGrid('horizontal')}
              />
              {phase === 'op_horizontal_grid' && (
                <>
                  <div className={chat.toolbar}>
                    <button
                      type="button"
                      className={`${chat.choice} ${chat.choicePrimary}`}
                      disabled={locked}
                      onClick={() => confirmOpHorizontalGrid(Boolean(horizontalGrid))}
                    >
                      {horizontalGrid
                        ? 'Continue with this file'
                        : 'Continue with default / bundled'}
                    </button>
                    {horizontalGrid && (
                      <button
                        type="button"
                        className={chat.choice}
                        disabled={locked}
                        onClick={() => confirmOpHorizontalGrid(false)}
                      >
                        Clear · use default
                      </button>
                    )}
                  </div>
                  {!horizontalGrid && (
                    <div className={chat.warnInline}>
                      <AlertTriangle size={14} />
                      <span>
                        Without a local NTv2 the horizontal datum shift can be coarse (often
                        decimetres for DHDN ↔ ETRS). Prefer a regional grid when available.
                      </span>
                    </div>
                  )}
                </>
              )}
            </ChatCard>
          )}

        {showReview && (
          <>
            <ChatBubble
              role="system"
              tone={operationReady ? 'ok' : 'warn'}
              title={operationReady ? 'Ready to import' : 'Cannot import yet'}
              detail={
                operationReady
                  ? mode === 'none'
                    ? 'No coordinate transform — values kept as stored / project CRS.'
                    : 'Coordinate operation validated.'
                  : (operationError ?? 'Complete the steps above first.')
              }
              onRevert={() => clearFrom(mode === 'none' ? 'mode' : 'operations')}
              revertDisabled={locked}
            />
            {operationReady &&
              mode !== 'none' &&
              (selectedOperation?.requiredGrids.length ?? 0) > 0 &&
              !verticalGrid &&
              !horizontalGrid && (
                <div className={chat.warnInline}>
                  <AlertTriangle size={14} />
                  <span>
                    No project-specific local grid was selected (bundled/default only). Accuracy may
                    be reduced for historic datums such as DHDN / Gauss-Krueger.
                    {selectedOperation?.expectedAccuracyMm != null
                      ? ` Published figure ≈ ±${selectedOperation.expectedAccuracyMm.toFixed(0)} mm.`
                      : ''}
                  </span>
                </div>
              )}
            <ChatCard title="Summary" onRevert={() => clearFrom('preview')} revertDisabled={locked}>
              <div className={chat.reviewGrid}>
                <Metric label="Images" value={String(usablePhotos.length)} />
                <Metric label="Mode" value={mode ? MODE_LABEL[mode] : '—'} />
                <Metric
                  label="Horizontal"
                  value={
                    transformHorizontal
                      ? `EPSG:${sourceHorizontalEpsg} → ${targetHorizontalEpsg}`
                      : `EPSG:${targetHorizontalEpsg}`
                  }
                />
                <Metric
                  label="Height"
                  value={
                    transformHeight
                      ? `${heightSourceLabel(heightSource, sourceVerticalEpsg)} → EPSG:${targetVerticalEpsg}`
                      : 'Preserve values'
                  }
                />
                <Metric
                  label="Operation"
                  value={mode === 'none' ? 'None (identity)' : (selectedOperation?.name ?? '—')}
                />
                <Metric
                  label="Grids"
                  value={
                    mode === 'none'
                      ? '—'
                      : [verticalGrid?.filename, horizontalGrid?.filename]
                          .filter(Boolean)
                          .join(', ') || 'None (PROJ default)'
                  }
                />
              </div>
              {busy && progress?.phase === 'commit' && (
                <div style={{ marginTop: 10 }}>
                  <strong style={{ fontSize: 11 }}>{progress.message}</strong>
                  <ProgressBar
                    value={progress.fraction}
                    indeterminate={progress.indeterminate === true}
                    indeterminateLabel="Importing…"
                  />
                </div>
              )}
            </ChatCard>

            <ChatBubble
              role="system"
              title="Finish import"
              detail="Save this setup as a reusable workflow, or commit the images now."
            />
            <div className={`${chat.row} ${chat.rowSystem}`}>
              <div className={chat.choices} role="group">
                <button
                  type="button"
                  className={chat.choice}
                  disabled={locked}
                  onClick={openSaveWorkflowForm}
                >
                  {workflowSavedName ? 'Workflow saved ✓' : 'Save import workflow'}
                </button>
                <button
                  type="button"
                  className={`${chat.choice} ${chat.choicePrimary}`}
                  disabled={
                    !operationReady ||
                    busy ||
                    operationBusy ||
                    (mode !== 'none' && !selectedOperation) ||
                    siteCalBlocked
                  }
                  onClick={() => {
                    void (async () => {
                      try {
                        if (mode === 'none') {
                          // Silently freeze an identity CRS op (same source/target). No UI pick.
                          setOperationBusy(true);
                          setOperationError(null);
                          const result = await onDiscoverCrs(query);
                          const identity =
                            result.candidates.find(
                              (c) =>
                                !c.ballpark &&
                                c.requiredGrids.length === 0 &&
                                (c.expectedAccuracyMm == null || c.expectedAccuracyMm <= 1),
                            ) ??
                            result.candidates.find(
                              (c) => !c.ballpark && c.requiredGrids.length === 0,
                            ) ??
                            result.candidates.find((c) => !c.ballpark);
                          if (!identity) {
                            throw new Error(
                              'Could not freeze an identity CRS operation for import without transform.',
                            );
                          }
                          setDiscovery(result);
                          setPinnedOperation(identity);
                          setSelectedOperationId(identity.operationId);
                          await onCommit(
                            buildDecision(
                              query,
                              identity,
                              result,
                              gpsCount > 0,
                              heightSource,
                              sourceVerticalEpsg,
                              false,
                              targetVerticalEpsg,
                              null,
                              null,
                            ),
                          );
                          return;
                        }
                        if (!selectedOperation || !discovery) return;
                        await onCommit(
                          buildDecision(
                            query,
                            selectedOperation,
                            discovery,
                            gpsCount > 0,
                            heightSource,
                            sourceVerticalEpsg,
                            transformHeight,
                            targetVerticalEpsg,
                            verticalGrid,
                            horizontalGrid,
                          ),
                        );
                      } catch (reason: unknown) {
                        const message = reason instanceof Error ? reason.message : String(reason);
                        setOperationError(message);
                        onError(message);
                      } finally {
                        setOperationBusy(false);
                      }
                    })();
                  }}
                >
                  {busy ? (
                    <>
                      <LoaderCircle className={chat.spinner} size={14} /> Importing…
                    </>
                  ) : (
                    <>
                      <Check size={14} /> Import {usablePhotos.length} images
                    </>
                  )}
                </button>
              </div>
            </div>
          </>
        )}

        {saveFormOpen && (
          <ChatCard title="Save import workflow">
            <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--hc-fg-muted)' }}>
              Name becomes the JSON filename. Save dialog opens in the transform-workflow folder
              (overwrite allowed).
            </p>
            <label className={chat.fieldRow} style={{ display: 'grid', gap: 4 }}>
              <span className={chat.fieldLabel}>Name → filename</span>
              <input
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                style={{
                  height: 32,
                  padding: '0 8px',
                  border: '1px solid var(--hc-border-default)',
                  borderRadius: 'var(--hc-radius-sm)',
                  background: 'var(--hc-bg-input, var(--hc-bg-void))',
                  color: 'var(--hc-fg-default)',
                  fontSize: 12,
                }}
                placeholder="e.g. Schwaben-ETRS"
              />
            </label>
            <label className={chat.fieldRow} style={{ display: 'grid', gap: 4, marginTop: 8 }}>
              <span className={chat.fieldLabel}>Description</span>
              <textarea
                value={saveDescription}
                onChange={(e) => setSaveDescription(e.target.value)}
                rows={3}
                style={{
                  padding: 8,
                  border: '1px solid var(--hc-border-default)',
                  borderRadius: 'var(--hc-radius-sm)',
                  background: 'var(--hc-bg-input, var(--hc-bg-void))',
                  color: 'var(--hc-fg-default)',
                  fontSize: 12,
                  resize: 'vertical',
                }}
                placeholder="Optional notes (CRS, project, grids…)"
              />
            </label>
            {saveFormError && (
              <div className={chat.errorInline} style={{ marginTop: 8 }}>
                <AlertTriangle size={14} />
                <span>{saveFormError}</span>
              </div>
            )}
            <div className={chat.toolbar}>
              <button
                type="button"
                className={`${chat.choice} ${chat.choicePrimary}`}
                onClick={() => void submitSaveWorkflow()}
              >
                Save as JSON…
              </button>
              <button type="button" className={chat.choice} onClick={() => setSaveFormOpen(false)}>
                Cancel
              </button>
            </div>
          </ChatCard>
        )}
      </ImportChatStream>
    </ImportChatRoot>
  );
}

// ── CRS search pair (source | target) ─────────────────────────────────

const RECENT_PREFIX = 'himmelcad.photolab.recentCrs.';

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
    return list.slice(0, 48);
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
            maxHeight: 280,
            overflow: 'auto',
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
          {matches.length === 0 && <div className={chat.crsSuggestMeta}>No matches</div>}
        </div>
      )}
    </div>
  );
}

/** Exported for GCP panel compatibility. */
export function CrsPicker({
  label,
  value,
  presets,
  onChange,
  disabled = false,
}: {
  label: string;
  value: number;
  presets: readonly CrsPreset[];
  onChange: (value: number) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <CrsSearchColumn
      label={label}
      value={value}
      presets={presets}
      popular={POPULAR_HORIZONTAL}
      recentKey="horizontal"
      disabled={disabled}
      onChange={onChange}
    />
  );
}

function GridSelector({
  title,
  description,
  bundled,
  selected,
  progress,
  busy,
  onChoose,
}: {
  title: string;
  description: string;
  bundled: string | null;
  selected: LocalGridSelection | null;
  progress: ImageImportProgress | null;
  busy: boolean;
  onChoose: () => void;
}): JSX.Element {
  return (
    <div className={chat.gridRow}>
      <Grid3X3 size={16} />
      <div>
        <strong>{title}</strong>
        <span>{description}</span>
        {bundled && !selected && <code>{bundled} · bundled</code>}
        {selected && (
          <code title={selected.localPath}>
            {selected.filename} · {selected.driver}
          </code>
        )}
        {progress?.phase === 'grid' && <ProgressBar value={progress.fraction} />}
      </div>
      <button type="button" className={chat.ghostBtn} onClick={onChoose} disabled={busy}>
        {progress?.phase === 'grid' ? <LoaderCircle className={chat.spinner} size={14} /> : null}
        {selected ? 'Change…' : 'Choose grid…'}
      </button>
    </div>
  );
}

function phaseOrder(phase: Phase): number {
  // height? → height CRS → geoid → horizontal? → horizontal CRS → PROJ op → NTv2 if needed
  const order: Phase[] = [
    'pick',
    'preview',
    'mode',
    'vertical_ask',
    'vertical_setup',
    'vertical_grid',
    'horizontal_ask',
    'horizontal_setup',
    'operations',
    'op_horizontal_grid',
    'combined_method',
    'combined_cal',
    'combined_helmert',
    'review',
  ];
  return order.indexOf(phase);
}

function helmertParamsComplete(h: {
  tx: string;
  ty: string;
  tz: string;
  rx: string;
  ry: string;
  rz: string;
  scale: string;
}): boolean {
  const nums = [h.tx, h.ty, h.tz, h.rx, h.ry, h.rz, h.scale].map((v) => Number(v));
  return nums.every((n) => Number.isFinite(n));
}

function heightSourceFromVerticalEpsg(code: number): HeightSource {
  if (code === 4979 || code === 4326) return 'ellipsoidal';
  if (code === 99999) return 'deviceProfile';
  return 'orthometric';
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

function buildOperationQuery(input: {
  area: GeographicArea;
  heightSource: HeightSource;
  sourceVerticalEpsg: number;
  transformHeight: boolean;
  targetVerticalEpsg: number;
  sourceHorizontalEpsg: number;
  targetHorizontalEpsg: number;
  verticalGrid: LocalGridSelection | null;
  horizontalGrid: LocalGridSelection | null;
  allowBundledGrids?: boolean;
}): CrsOperationQuery {
  const allowBundled = input.allowBundledGrids !== false;
  const source = input.transformHeight
    ? input.heightSource === 'orthometric'
      ? {
          kind: 'authority' as const,
          value: `EPSG:${input.sourceHorizontalEpsg}+${input.sourceVerticalEpsg}`,
        }
      : {
          kind: 'epsg' as const,
          value: input.sourceHorizontalEpsg === 4326 ? 4979 : input.sourceHorizontalEpsg,
        }
    : { kind: 'epsg' as const, value: input.sourceHorizontalEpsg };
  const target = input.transformHeight
    ? {
        kind: 'authority' as const,
        value: `EPSG:${input.targetHorizontalEpsg}+${input.targetVerticalEpsg}`,
      }
    : { kind: 'epsg' as const, value: input.targetHorizontalEpsg };
  const catalog: GridCatalogEntry[] = [];
  if (input.horizontalGrid) catalog.push(userGrid(input.horizontalGrid));
  else if (
    allowBundled &&
    input.targetHorizontalEpsg >= 31466 &&
    input.targetHorizontalEpsg <= 31469
  )
    catalog.push(BETA2007);
  if (input.transformHeight && input.verticalGrid) catalog.push(userGrid(input.verticalGrid));
  else if (allowBundled && input.transformHeight && input.targetVerticalEpsg === 7837)
    catalog.push(GCG2016);
  return {
    source: { crs: source },
    target: { crs: target },
    areaOfInterest: input.area,
    // PROJ-only path may include lower-accuracy (ballpark) ops; user must still pick.
    selectionPolicy: {
      allowBallpark: !allowBundled && !input.horizontalGrid && !input.verticalGrid,
      // UI lets the user pick any non-ballpark candidate; freeze validates against this flag.
      onlyBest: false,
    },
    gridCatalog: deduplicateCatalog(catalog),
  };
}

function userGrid(selection: LocalGridSelection): GridCatalogEntry {
  const kind = normalizeGridKind(selection.kind, selection.filename, selection.kind === 'geoid');
  return {
    kind,
    officialFilename: selection.filename,
    // Never pin a CDN hash on user files — content may be regional NTv2 / custom GTG.
    license: {
      licenseName: 'User-supplied local grid',
      source: selection.localPath,
      redistributionAllowed: false,
    },
    coverage: selection.coverage,
    localPath: selection.localPath,
  };
}

function formatArea(area: GeographicArea): string {
  return `${area.westLongitude.toFixed(4)}°, ${area.southLatitude.toFixed(4)}° – ${area.eastLongitude.toFixed(4)}°, ${area.northLatitude.toFixed(4)}°`;
}

function deduplicateCatalog(entries: GridCatalogEntry[]): GridCatalogEntry[] {
  return [...new Map(entries.map((entry) => [entry.officialFilename, entry])).values()];
}

function buildDecision(
  query: CrsOperationQuery,
  operation: CrsOperationCandidate,
  discovery: CrsOperationDiscovery | null,
  containsGpsData: boolean,
  heightSource: HeightSource,
  sourceVerticalEpsg: number,
  transformHeight: boolean,
  targetVerticalEpsg: number,
  verticalGrid: LocalGridSelection | null,
  horizontalGrid: LocalGridSelection | null,
): ImageImportDecision {
  if (!discovery) throw new Error('PROJ operation has not been validated yet');
  const sourceHeight = heightReference(heightSource, sourceVerticalEpsg);
  return {
    schemaVersion: 1,
    containsGpsData,
    horizontal: { source: query.source, target: query.target },
    vertical: transformHeight
      ? {
          source: sourceHeight,
          // Internally-tagged HeightReference: only ONE key — dual keys → "duplicate field".
          // snake_case works on older sidecars; with rename+alias also on newer ones.
          target: {
            kind: 'normalHeight' as const,
            vertical_crs: { kind: 'epsg' as const, value: targetVerticalEpsg },
          },
          mode: 'transform',
        }
      : { source: sourceHeight, target: sourceHeight, mode: 'preserveValues' },
    areaOfInterest: query.areaOfInterest,
    operation: {
      ...attachLocalGridsToOperation(
        operation,
        verticalGrid,
        horizontalGrid,
        query.gridCatalog,
        query.areaOfInterest,
      ),
      // Explicit UI selection is allowed even when PROJ ranked another op as "best".
      bestAvailable: true,
    },
    selectionPolicy: {
      allowBallpark: false,
      onlyBest: false,
    },
    databaseVersions: discovery.audit.versions,
  };
}

function heightSourceLabel(source: HeightSource, verticalEpsg: number): string {
  if (source === 'ellipsoidal') return 'WGS 84 ellipsoidal';
  if (source === 'orthometric') return `Orthometric · EPSG:${verticalEpsg}`;
  if (source === 'deviceProfile') return 'DJI device profile';
  return 'Unknown · preserved';
}

function imageArea(batch: PhotoImportBatch | null): GeographicArea {
  const positions =
    batch?.photos.flatMap((photo) => {
      const position = preferredGps(photo.metadata);
      return position ? [position] : [];
    }) ?? [];
  if (positions.length === 0)
    return { westLongitude: -180, southLatitude: -90, eastLongitude: 180, northLatitude: 90 };
  const longitudes = positions.map((position) => position.longitudeDegrees);
  const latitudes = positions.map((position) => position.latitudeDegrees);
  return {
    westLongitude: Math.max(-180, Math.min(...longitudes) - 0.01),
    southLatitude: Math.max(-90, Math.min(...latitudes) - 0.01),
    eastLongitude: Math.min(180, Math.max(...longitudes) + 0.01),
    northLatitude: Math.min(90, Math.max(...latitudes) + 0.01),
  };
}

function preferredGps(metadata: PhotoMetadata): ExifGpsPosition | null {
  const latitudeDegrees = metadata.djiXmp.latitudeDegrees;
  const longitudeDegrees = metadata.djiXmp.longitudeDegrees;
  if (
    latitudeDegrees != null &&
    longitudeDegrees != null &&
    Number.isFinite(latitudeDegrees) &&
    Number.isFinite(longitudeDegrees) &&
    Math.abs(latitudeDegrees) <= 90 &&
    Math.abs(longitudeDegrees) <= 180
  ) {
    return {
      latitudeDegrees,
      longitudeDegrees,
      ...(metadata.djiXmp.absoluteAltitude
        ? { altitude: metadata.djiXmp.absoluteAltitude }
        : metadata.exif.gps?.altitude
          ? { altitude: metadata.exif.gps.altitude }
          : {}),
    };
  }
  return metadata.exif.gps ?? null;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}
