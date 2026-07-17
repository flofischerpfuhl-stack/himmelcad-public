import type { ExifGpsPosition, PhotoImportBatch, PhotoMetadata } from '@himmelcad/data';
import { CrsTransformPair, Select, Radio } from '@himmelcad/ui';
import {
  AlertTriangle,
  Check,
  FileImage,
  FolderOpen,
  Grid3X3,
  LoaderCircle,
  MapPinned,
  MountainSnow,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import styles from './ImageImportPanel.module.css';

type HeightSource = 'unknown' | 'ellipsoidal' | 'orthometric' | 'deviceProfile';
type GridKind = 'ntv2' | 'gtg' | 'geoid';

interface CrsDefinition {
  kind: 'epsg' | 'authority';
  value: number | string;
}

interface CrsWithEpoch {
  crs: CrsDefinition;
}

interface GeographicArea {
  westLongitude: number;
  southLatitude: number;
  eastLongitude: number;
  northLatitude: number;
}

interface RequiredGrid {
  officialFilename: string;
  availability: { state: 'missing' | 'presentVerified' };
}

export interface CrsOperationCandidate {
  operationId: string;
  name: string;
  kind: 'general' | 'gaussKruegerDatumTransformation';
  projPipeline: string;
  areaOfUse: GeographicArea;
  expectedAccuracyMm?: number;
  ballpark: boolean;
  bestAvailable: boolean;
  requiredGrids: RequiredGrid[];
}

export interface CrsOperationDiscovery {
  candidates: CrsOperationCandidate[];
  audit: { versions: { projVersion: string; epsgDatabaseVersion: string } };
  warnings: string[];
}

export interface GridCatalogEntry {
  kind: GridKind;
  officialFilename: string;
  officialSha256?: string;
  license: {
    licenseName: string;
    spdxExpression?: string;
    source: string;
    redistributionAllowed: boolean;
  };
  coverage: GeographicArea;
  localPath?: string;
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

export interface LocalGridSelection {
  filename: string;
  localPath: string;
  kind: GridKind;
  driver: string;
  coverage: GeographicArea;
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
  onChooseMoreFiles: () => void;
  onChooseFolder: () => void;
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
  {
    code: 25832,
    name: 'ETRS89 / UTM zone 32N',
    region: 'Europe',
    hint: 'Germany west and central',
  },
  {
    code: 25833,
    name: 'ETRS89 / UTM zone 33N',
    region: 'Europe',
    hint: 'Germany east and central',
  },
  { code: 31466, name: 'DHDN / Gauss-Krueger zone 2', region: 'Germany', hint: '6° meridian' },
  { code: 31467, name: 'DHDN / Gauss-Krueger zone 3', region: 'Germany', hint: '9° meridian' },
  { code: 31468, name: 'DHDN / Gauss-Krueger zone 4', region: 'Germany', hint: '12° meridian' },
  {
    code: 3035,
    name: 'ETRS89-extended / LAEA Europe',
    region: 'Europe',
    hint: 'European analysis',
  },
  { code: 3857, name: 'WGS 84 / Pseudo-Mercator', region: 'Global', hint: 'Web mapping' },
  { code: 4326, name: 'WGS 84', region: 'Global', hint: 'Geographic longitude / latitude' },
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
  { code: 7837, name: 'DHHN2016 height', region: 'Germany', hint: 'Normal height, GCG2016' },
  { code: 5783, name: 'DHHN92 height', region: 'Germany', hint: 'Normal height' },
  { code: 3855, name: 'EGM2008 height', region: 'Global', hint: 'Gravity-related height' },
  { code: 5773, name: 'EGM96 height', region: 'Global', hint: 'Gravity-related height' },
  { code: 5728, name: 'LN02 height', region: 'Switzerland', hint: 'Swiss national height' },
  { code: 5621, name: 'EVRF2007 height', region: 'Europe', hint: 'European vertical reference' },
];

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

export function ImageImportPanel({
  batch,
  busy,
  progress,
  gridProgress,
  error,
  onChooseMoreFiles,
  onChooseFolder,
  onSelectGrid,
  onDiscoverCrs,
  onCommit,
  onCancel,
  onError,
}: ImageImportPanelProps): JSX.Element {
  const [step, setStep] = useState(1);
  const [heightSource, setHeightSource] = useState<HeightSource>('unknown');
  const [sourceVerticalEpsg, setSourceVerticalEpsg] = useState(7837);
  const [transformHeight, setTransformHeight] = useState(false);
  const [targetVerticalEpsg, setTargetVerticalEpsg] = useState(7837);
  const [sourceHorizontalEpsg, setSourceHorizontalEpsg] = useState(4326);
  const [targetHorizontalEpsg, setTargetHorizontalEpsg] = useState(25832);
  const [verticalGrid, setVerticalGrid] = useState<LocalGridSelection | null>(null);
  const [horizontalGrid, setHorizontalGrid] = useState<LocalGridSelection | null>(null);
  const [discovery, setDiscovery] = useState<CrsOperationDiscovery | null>(null);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [discoveryQueryKey, setDiscoveryQueryKey] = useState<string | null>(null);

  const area = useMemo(() => imageArea(batch), [batch]);
  const query = useMemo(
    () =>
      buildOperationQuery({
        area,
        heightSource,
        sourceVerticalEpsg,
        transformHeight,
        targetVerticalEpsg,
        sourceHorizontalEpsg,
        targetHorizontalEpsg,
        verticalGrid,
        horizontalGrid,
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
      verticalGrid,
    ],
  );
  const queryKey = JSON.stringify(query);
  const usablePhotos = batch?.photos.filter((photo) => photo.duplicateOf == null) ?? [];
  const gpsCount =
    batch?.photos.filter((photo) => preferredGps(photo.metadata) != null).length ?? 0;
  const rtkCount = batch?.photos.filter((photo) => photo.metadata.djiXmp.rtk != null).length ?? 0;
  const selectedOperation =
    discovery?.candidates.find((candidate) => candidate.operationId === selectedOperationId) ??
    null;
  const heightDecisionSupported =
    !transformHeight || heightSource === 'ellipsoidal' || heightSource === 'orthometric';
  const operationReady =
    discoveryQueryKey === queryKey &&
    heightDecisionSupported &&
    selectedOperation != null &&
    !selectedOperation.ballpark &&
    selectedOperation.requiredGrids.every((grid) => grid.availability.state === 'presentVerified');

  useEffect(() => {
    if (step !== 4 || !heightDecisionSupported) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setOperationBusy(true);
      setOperationError(null);
      void onDiscoverCrs(query)
        .then((result) => {
          if (cancelled) return;
          setDiscovery(result);
          setDiscoveryQueryKey(queryKey);
          const preferred = result.candidates.find(
            (candidate) =>
              candidate.bestAvailable &&
              !candidate.ballpark &&
              candidate.requiredGrids.every(
                (grid) => grid.availability.state === 'presentVerified',
              ),
          );
          setSelectedOperationId(
            preferred?.operationId ?? result.candidates[0]?.operationId ?? null,
          );
          if (result.candidates.length === 0) {
            const message = 'No accurate operation covers these images with the selected grids.';
            setOperationError(message);
            onError(message);
          }
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          setDiscovery(null);
          setDiscoveryQueryKey(null);
          setSelectedOperationId(null);
          const message = reason instanceof Error ? reason.message : String(reason);
          setOperationError(message);
          onError(message);
        })
        .finally(() => {
          if (!cancelled) setOperationBusy(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [heightDecisionSupported, onDiscoverCrs, onError, query, queryKey, step]);

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
      if (target === 'horizontal') setHorizontalGrid(selected);
      else setVerticalGrid(selected);
      setDiscoveryQueryKey(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setOperationError(message);
      onError(message);
    } finally {
      setOperationBusy(false);
    }
  };

  if (!batch || (busy && progress?.phase === 'inspect')) {
    return (
      <section className={styles.root} aria-busy={busy}>
        <header className={styles.header} data-task-drag-handle>
          <h2 className={styles.functionTitle}>
            {error ? 'Image Import' : 'Image Import'}
          </h2>
          <button
            className={styles.iconButton}
            type="button"
            onClick={onCancel}
            aria-label="Cancel image import"
          >
            <X size={16} />
          </button>
        </header>
        <div className={styles.loadingPage}>
          {error ? (
            <AlertTriangle className={styles.errorIcon} size={34} />
          ) : (
            <LoaderCircle className={styles.spinner} size={34} />
          )}
          <strong>{error ?? progress?.message ?? 'Preparing image inspection…'}</strong>
          {!error && (
            <ProgressBar
              value={progress?.fraction ?? 0}
              indeterminate={progress?.indeterminate === true}
              indeterminateLabel="Discovering…"
            />
          )}
          <small>
            {error
              ? 'No image or project data was changed. Choose the files again after resolving the message above.'
              : 'EXIF, XMP, DJI, GPS and RTK metadata are retained. Nothing is committed yet.'}
          </small>
          {error ? (
            <div className={styles.actionsInline}>
              <button type="button" onClick={onChooseMoreFiles}>
                <FileImage size={14} /> Choose images
              </button>
              <button type="button" onClick={onChooseFolder}>
                <FolderOpen size={14} /> Choose folder
              </button>
              <button className={styles.cancelButton} type="button" onClick={onCancel}>
                Close
              </button>
            </div>
          ) : (
            <button className={styles.cancelButton} type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className={styles.root} aria-busy={busy || operationBusy}>
      <header className={styles.header} data-task-drag-handle>
        <h2 className={styles.functionTitle}>Image Import</h2>
        <button
          className={styles.iconButton}
          type="button"
          onClick={onCancel}
          aria-label="Close image import"
        >
          <X size={16} />
        </button>
      </header>

      <ol className={styles.steps} aria-label="Image import steps">
        {['Files', 'Metadata', 'Height', 'Horizontal', 'Import'].map((label, index) => {
          const number = index + 1;
          return (
            <li key={label} className={number === step ? styles.stepActive : ''}>
              <button type="button" onClick={() => !busy && setStep(number)} disabled={busy}>
                <span>{number < step ? <Check size={12} /> : number}</span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      <div className={styles.body}>
        {error && (
          <div className={styles.inlineError} role="alert">
            <AlertTriangle size={16} />
            <span>
              <strong>Import could not continue</strong>
              <small>{error}</small>
            </span>
          </div>
        )}
        {step === 1 && (
          <div className={styles.page}>
            <h3>
              <FileImage size={16} /> Files
            </h3>
            <div className={styles.metrics}>
              <Metric label="Found" value={String(batch.photos.length)} />
              <Metric label="Importable" value={String(usablePhotos.length)} />
              <Metric
                label="Duplicates"
                value={String(batch.photos.length - usablePhotos.length)}
                warning={batch.photos.length !== usablePhotos.length}
              />
            </div>
            <div className={styles.actionsInline}>
              <button type="button" onClick={onChooseMoreFiles} disabled={busy}>
                <FileImage size={14} /> Add images
              </button>
              <button type="button" onClick={onChooseFolder} disabled={busy}>
                <FolderOpen size={14} /> Add folder
              </button>
            </div>
            <PhotoList batch={batch} />
          </div>
        )}

        {step === 2 && (
          <div className={styles.page}>
            <h3>Metadata validation</h3>
            <div className={styles.metrics}>
              <Metric label="EXIF / XMP GPS" value={`${gpsCount} / ${batch.photos.length}`} />
              <Metric label="DJI RTK metadata" value={`${rtkCount} / ${batch.photos.length}`} />
              <Metric
                label="File warnings"
                value={String(batch.warnings.length)}
                warning={batch.warnings.length > 0}
              />
            </div>
            <div className={styles.notice}>
              <AlertTriangle size={15} />
              <span>
                <strong>Height reference required.</strong> Choose how DJI “AbsoluteAltitude” is
                interpreted in the next step.
              </span>
            </div>
            <WarningList batch={batch} />
          </div>
        )}

        {step === 3 && (
          <div className={styles.page}>
            <h3>
              <MountainSnow size={16} /> Vertical reference
            </h3>
            <CrsTransformPair
              title="Height transform"
              hint="Left: how heights are stored on the photos. Right: project vertical target. Prefer No transform when values must stay byte-identical."
              noTransform={!transformHeight}
              onNoTransformChange={(noTransform) => setTransformHeight(!noTransform)}
              noTransformLabel="No transform — preserve height values"
              source={
                <div className={styles.fieldGroup}>
                  <label>Source height stored by the photos</label>
                  <Select
                    value={heightSource}
                    onChange={(event) => setHeightSource(event.target.value as HeightSource)}
                  >
                    <option value="unknown">Unknown · preserve without reinterpretation</option>
                    <option value="ellipsoidal">WGS 84 ellipsoidal height</option>
                    <option value="orthometric">Orthometric / normal height with EPSG code</option>
                    <option value="deviceProfile">Explicit DJI device profile</option>
                  </Select>
                  {heightSource === 'orthometric' && (
                    <CrsPicker
                      label="Source vertical CRS"
                      value={sourceVerticalEpsg}
                      presets={VERTICAL_PRESETS}
                      onChange={setSourceVerticalEpsg}
                    />
                  )}
                </div>
              }
              target={
                transformHeight ? (
                  <CrsPicker
                    label="Target vertical CRS"
                    value={targetVerticalEpsg}
                    presets={VERTICAL_PRESETS}
                    onChange={setTargetVerticalEpsg}
                  />
                ) : (
                  <div className={styles.preserveCard}>
                    Original height values will be preserved exactly.
                  </div>
                )
              }
            />
            {transformHeight && (
              <GridSelector
                title="Geoid / quasigeoid grid"
                description={
                  targetVerticalEpsg === 7837
                    ? 'GCG2016 is bundled and hash-verified. You may explicitly use another PROJ grid.'
                    : 'Choose the grid required by the selected vertical CRS operation.'
                }
                bundled={targetVerticalEpsg === 7837 ? GCG2016.officialFilename : null}
                selected={verticalGrid}
                progress={gridProgress}
                busy={operationBusy}
                onChoose={() => void chooseGrid('vertical')}
              />
            )}
            {transformHeight && !heightDecisionSupported && (
              <div className={styles.blockingNotice}>
                A metric height transformation requires a known ellipsoidal or EPSG-defined source
                height.
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className={styles.page}>
            <h3>
              <MapPinned size={16} /> Horizontal coordinate system
            </h3>
            <CrsTransformPair
              title="Horizontal transform"
              hint="Left: CRS of the photo positions. Right: project target CRS. Prefer No transform only when source already matches the project."
              noTransform={sourceHorizontalEpsg === targetHorizontalEpsg}
              onNoTransformChange={(noTransform) => {
                if (noTransform) setSourceHorizontalEpsg(targetHorizontalEpsg);
              }}
              noTransformLabel="No transform — source equals target CRS"
              source={
                <CrsPicker
                  label="Source horizontal CRS"
                  value={sourceHorizontalEpsg}
                  presets={HORIZONTAL_CRS_PRESETS}
                  onChange={setSourceHorizontalEpsg}
                />
              }
              target={
                <CrsPicker
                  label="Target horizontal CRS"
                  value={targetHorizontalEpsg}
                  presets={HORIZONTAL_CRS_PRESETS}
                  onChange={setTargetHorizontalEpsg}
                />
              }
            />
            <GridSelector
              title="Horizontal datum grid"
              description={
                targetHorizontalEpsg >= 31466 && targetHorizontalEpsg <= 31469
                  ? 'BETA2007 is bundled for DHDN / Gauss-Krueger transformations.'
                  : 'Only needed when PROJ reports a required local NTv2 / GTG grid.'
              }
              bundled={
                targetHorizontalEpsg >= 31466 && targetHorizontalEpsg <= 31469
                  ? BETA2007.officialFilename
                  : null
              }
              selected={horizontalGrid}
              progress={gridProgress}
              busy={operationBusy}
              onChoose={() => void chooseGrid('horizontal')}
            />
            <div className={styles.operationCard}>
              <div className={styles.operationHeader}>
                <strong>
                  {operationBusy
                    ? 'Validating coordinate operation…'
                    : discovery
                      ? `${discovery.candidates.length} operation(s)`
                      : 'Choose a target coordinate system'}
                </strong>
                {operationBusy && <LoaderCircle className={styles.spinner} size={14} />}
              </div>
              {operationBusy && (
                <ProgressBar value={0} indeterminate indeterminateLabel="Validating…" />
              )}
              {discovery?.candidates.map((candidate) => (
                <label key={candidate.operationId} className={styles.operationChoice}>
                  <Radio
                    name="crs-operation"
                    checked={candidate.operationId === selectedOperationId}
                    onChange={() => setSelectedOperationId(candidate.operationId)}
                  />
                  <span>
                    <strong>{candidate.name}</strong>
                    <small>
                      {candidate.expectedAccuracyMm == null
                        ? 'Accuracy not published'
                        : `Expected accuracy ±${candidate.expectedAccuracyMm.toFixed(1)} mm`}
                      {candidate.ballpark ? ' · BALLPARK BLOCKED' : ''}
                    </small>
                  </span>
                </label>
              ))}
              {discovery?.warnings.map((warning) => (
                <span className={styles.warningText} key={warning}>
                  {warning}
                </span>
              ))}
              {operationError && <span className={styles.warningText}>{operationError}</span>}
            </div>
          </div>
        )}

        {step === 5 && (
          <div className={styles.page}>
            <h3>Review and import</h3>
            <div className={styles.reviewGrid}>
              <Metric label="Images" value={String(usablePhotos.length)} />
              <Metric label="Source horizontal CRS" value={`EPSG:${sourceHorizontalEpsg}`} />
              <Metric label="Horizontal CRS" value={`EPSG:${targetHorizontalEpsg}`} />
              <Metric
                label="Source height"
                value={heightSourceLabel(heightSource, sourceVerticalEpsg)}
              />
              <Metric
                label="Target height"
                value={transformHeight ? `EPSG:${targetVerticalEpsg}` : 'Preserve values'}
              />
            </div>
            {operationBusy ? (
              <div className={styles.commitProgress}>
                <strong>Validating coordinate operation and grid coverage…</strong>
                <ProgressBar value={0} indeterminate indeterminateLabel="Validating…" />
              </div>
            ) : operationReady ? (
              <div className={styles.success}>
                <Check size={15} /> Coordinate operation and grid coverage validated.
              </div>
            ) : (
              <div className={styles.blockingNotice}>
                {operationError ??
                  'No accurate coordinate operation covers the current CRS and grid selection.'}
              </div>
            )}
            {busy && progress?.phase === 'commit' && (
              <div className={styles.commitProgress}>
                <strong>{progress.message}</strong>
                <ProgressBar
                  value={progress.fraction}
                  indeterminate={progress.indeterminate === true}
                  indeterminateLabel="Validating…"
                />
              </div>
            )}
          </div>
        )}
      </div>

      <footer className={styles.footer}>
        <button type="button" className={styles.secondary} onClick={onCancel}>
          {busy ? 'Cancel operation' : 'Cancel'}
        </button>
        <span className={styles.footerSpacer} />
        <button
          type="button"
          className={styles.secondary}
          onClick={() => setStep((current) => Math.max(1, current - 1))}
          disabled={step === 1 || busy}
        >
          Back
        </button>
        {step < 5 ? (
          <button
            type="button"
            className={styles.primary}
            onClick={() => setStep((current) => Math.min(5, current + 1))}
            disabled={busy}
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            className={styles.primary}
            disabled={!operationReady || busy || operationBusy || !selectedOperation}
            onClick={() =>
              selectedOperation &&
              void onCommit(
                buildDecision(
                  query,
                  selectedOperation,
                  discovery,
                  gpsCount > 0,
                  heightSource,
                  sourceVerticalEpsg,
                  transformHeight,
                  targetVerticalEpsg,
                ),
              )
            }
          >
            {busy ? <LoaderCircle className={styles.spinner} size={14} /> : <Check size={14} />}
            {busy ? 'Importing…' : `Import ${usablePhotos.length} images`}
          </button>
        )}
      </footer>
    </section>
  );
}

export function CrsPicker({
  label,
  value,
  presets,
  onChange,
}: {
  label: string;
  value: number;
  presets: readonly CrsPreset[];
  onChange: (value: number) => void;
}): JSX.Element {
  const selected = presets.find((preset) => preset.code === value);
  const [query, setQuery] = useState('');
  const normalized = query.trim().toLowerCase();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const matches = presets.filter((preset) =>
    tokens.every((token) =>
      `${preset.code} ${preset.name} ${preset.region} ${preset.hint}`.toLowerCase().includes(token),
    ),
  );
  const customMatch = /^(?:epsg:\s*)?(\d{3,7})$/i.exec(query.trim());
  const customCode = customMatch ? Number(customMatch[1]) : null;
  return (
    <div className={styles.crsPicker}>
      <label>{label}</label>
      <div className={styles.selectedCrs}>
        <MapPinned size={15} />
        <span>
          <strong>{selected?.name ?? `Custom EPSG:${value}`}</strong>
          <small>
            EPSG:{value}
            {selected ? ` · ${selected.hint}` : ' · validated locally by PROJ'}
          </small>
        </span>
      </div>
      <div className={styles.searchBox}>
        <Search size={14} />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search EPSG code, name, country or UTM zone"
        />
      </div>
      <div className={styles.crsResults} role="listbox">
        {matches.slice(0, 10).map((preset) => (
          <button
            type="button"
            key={preset.code}
            className={preset.code === value ? styles.crsResultActive : ''}
            onClick={() => {
              onChange(preset.code);
              setQuery('');
            }}
          >
            <span>
              <strong>{preset.name}</strong>
              <small>
                {preset.region} · {preset.hint}
              </small>
            </span>
            <code>EPSG:{preset.code}</code>
          </button>
        ))}
        {customCode != null && !presets.some((preset) => preset.code === customCode) && (
          <button
            type="button"
            onClick={() => {
              onChange(customCode);
              setQuery('');
            }}
          >
            <span>
              <strong>Use custom EPSG:{customCode}</strong>
              <small>Resolved exclusively through the bundled EPSG / PROJ database</small>
            </span>
            <code>EPSG:{customCode}</code>
          </button>
        )}
      </div>
    </div>
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
    <div className={styles.gridSelector}>
      <Grid3X3 size={18} />
      <div>
        <strong>{title}</strong>
        <span>{description}</span>
        {bundled && !selected && <code>{bundled} · bundled</code>}
        {selected && (
          <code title={selected.localPath}>
            {selected.filename} · {selected.driver} · registered locally
          </code>
        )}
        {progress?.phase === 'grid' && <ProgressBar value={progress.fraction} />}
      </div>
      <button type="button" onClick={onChoose} disabled={busy}>
        {progress?.phase === 'grid' ? <LoaderCircle className={styles.spinner} size={14} /> : null}
        {selected ? 'Change file' : 'Choose grid file…'}
      </button>
    </div>
  );
}

function ProgressBar({
  value,
  indeterminate = false,
  indeterminateLabel = 'Working…',
}: {
  value: number;
  indeterminate?: boolean;
  indeterminateLabel?: string;
}): JSX.Element {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className={styles.progressRow}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : percent}
    >
      <div
        className={`${styles.progressTrack} ${indeterminate ? styles.progressIndeterminate : ''}`}
      >
        <span style={indeterminate ? undefined : { width: `${percent}%` }} />
      </div>
      <code>{indeterminate ? indeterminateLabel : `${percent}%`}</code>
    </div>
  );
}

function Metric({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: string;
  warning?: boolean;
}): JSX.Element {
  return (
    <div className={styles.metric}>
      <span>{label}</span>
      <strong className={warning ? styles.warningText : ''}>{value}</strong>
    </div>
  );
}

function PhotoList({ batch }: { batch: PhotoImportBatch }): JSX.Element {
  return (
    <div className={styles.list}>
      {batch.photos.slice(0, 120).map((photo) => (
        <div className={styles.photoRow} key={`${photo.sha256}:${photo.sourcePath}`}>
          <FileImage size={13} />
          <span title={photo.sourcePath}>{fileName(photo.sourcePath)}</span>
          <small>{photo.metadata.exif.model ?? photo.format}</small>
          {preferredGps(photo.metadata) && <em>GPS</em>}
          {photo.metadata.djiXmp.rtk && <em>RTK</em>}
          {photo.duplicateOf && <em className={styles.warningText}>Duplicate</em>}
        </div>
      ))}
      {batch.photos.length > 120 && (
        <div className={styles.more}>+ {batch.photos.length - 120} more</div>
      )}
    </div>
  );
}

function WarningList({ batch }: { batch: PhotoImportBatch }): JSX.Element {
  if (batch.warnings.length === 0)
    return (
      <div className={styles.success}>
        <Check size={14} /> No file metadata warnings
      </div>
    );
  return (
    <div className={styles.list}>
      {batch.warnings.slice(0, 120).map((warning, index) => (
        <div className={styles.warningRow} key={`${warning.sourcePath}:${warning.code}:${index}`}>
          <AlertTriangle size={12} />
          <span>{fileName(warning.sourcePath)}</span>
          <small>{warning.message}</small>
        </div>
      ))}
    </div>
  );
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
}): CrsOperationQuery {
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
  else if (input.targetHorizontalEpsg >= 31466 && input.targetHorizontalEpsg <= 31469)
    catalog.push(BETA2007);
  if (input.transformHeight && input.verticalGrid) catalog.push(userGrid(input.verticalGrid));
  else if (input.transformHeight && input.targetVerticalEpsg === 7837) catalog.push(GCG2016);
  return {
    source: { crs: source },
    target: { crs: target },
    areaOfInterest: input.area,
    selectionPolicy: { allowBallpark: false, onlyBest: true },
    gridCatalog: deduplicateCatalog(catalog),
  };
}

function userGrid(selection: LocalGridSelection): GridCatalogEntry {
  return {
    kind: selection.kind,
    officialFilename: selection.filename,
    license: {
      licenseName: 'User-supplied local grid',
      source: selection.localPath,
      redistributionAllowed: false,
    },
    coverage: selection.coverage,
    localPath: selection.localPath,
  };
}

function containsArea(coverage: GeographicArea, area: GeographicArea): boolean {
  return (
    coverage.westLongitude <= area.westLongitude &&
    coverage.southLatitude <= area.southLatitude &&
    coverage.eastLongitude >= area.eastLongitude &&
    coverage.northLatitude >= area.northLatitude
  );
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
          target: {
            kind: 'normalHeight',
            verticalCrs: { kind: 'epsg', value: targetVerticalEpsg },
          },
          mode: 'transform',
        }
      : { source: sourceHeight, target: sourceHeight, mode: 'preserveValues' },
    areaOfInterest: query.areaOfInterest,
    operation,
    selectionPolicy: query.selectionPolicy,
    databaseVersions: discovery.audit.versions,
  };
}

function heightReference(source: HeightSource, verticalEpsg: number): Record<string, unknown> {
  if (source === 'ellipsoidal') return { kind: 'ellipsoidal' };
  if (source === 'deviceProfile') return { kind: 'deviceProfile', profileId: 'dji-explicit' };
  if (source === 'orthometric')
    return { kind: 'orthometric', verticalCrs: { kind: 'epsg', value: verticalEpsg } };
  return { kind: 'unknown' };
}

function heightSourceLabel(source: HeightSource, verticalEpsg: number): string {
  if (source === 'ellipsoidal') return 'WGS 84 ellipsoidal';
  if (source === 'orthometric') return `Orthometric / normal height · EPSG:${verticalEpsg}`;
  if (source === 'deviceProfile') return 'Explicit DJI device profile';
  return 'Unknown · values preserved';
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
