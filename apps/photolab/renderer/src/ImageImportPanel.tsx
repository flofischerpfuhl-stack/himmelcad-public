import type { ExifGpsPosition, PhotoImportBatch, PhotoMetadata } from '@himmelcad/data';
import { AlertTriangle, Check, FileImage, MapPinned, MountainSnow } from 'lucide-react';
import { useMemo, useState } from 'react';

import styles from './ImageImportPanel.module.css';

type HeightSource = 'unknown' | 'ellipsoidal' | 'orthometric' | 'deviceProfile';

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

export interface CrsOperationQuery {
  source: CrsWithEpoch;
  target: CrsWithEpoch;
  areaOfInterest: GeographicArea;
  selectionPolicy: { allowBallpark: boolean; onlyBest: boolean };
  gridCatalog: {
    kind: 'ntv2' | 'gtg' | 'geoid';
    officialFilename: string;
    officialSha256: string;
    license: {
      licenseName: string;
      spdxExpression?: string;
      source: string;
      redistributionAllowed: boolean;
    };
    coverage: GeographicArea;
    localPath?: string;
  }[];
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

export interface ImageImportPanelProps {
  batch: PhotoImportBatch;
  busy: boolean;
  onChooseMoreFiles: () => void;
  onChooseFolder: () => void;
  onDiscoverCrs: (query: CrsOperationQuery) => Promise<CrsOperationDiscovery>;
  onCommit: (decision: ImageImportDecision) => Promise<void>;
  onCancel: () => void;
}

export function ImageImportPanel({
  batch,
  busy,
  onChooseMoreFiles,
  onChooseFolder,
  onDiscoverCrs,
  onCommit,
  onCancel,
}: ImageImportPanelProps): JSX.Element {
  const [step, setStep] = useState(1);
  const [heightSource, setHeightSource] = useState<HeightSource>('unknown');
  const [targetHeight, setTargetHeight] = useState('Preserve values');
  const [geoidGrid, setGeoidGrid] = useState('GCG2016 · not installed');
  const [targetCrs, setTargetCrs] = useState('EPSG:25832 · ETRS89 / UTM 32N');
  const [discovery, setDiscovery] = useState<CrsOperationDiscovery | null>(null);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [discoveryQueryKey, setDiscoveryQueryKey] = useState<string | null>(null);
  const usablePhotos = useMemo(
    () => batch.photos.filter((photo) => photo.duplicateOf == null),
    [batch.photos],
  );
  const gpsCount = batch.photos.filter((photo) => preferredGps(photo.metadata) != null).length;
  const rtkMetadataCount = batch.photos.filter((photo) => photo.metadata.djiXmp.rtk != null).length;
  const query = useMemo(
    () => buildOperationQuery(batch, heightSource, targetHeight, targetCrs),
    [batch, heightSource, targetCrs, targetHeight],
  );
  const selectedOperation =
    discovery?.candidates.find((candidate) => candidate.operationId === selectedOperationId) ??
    null;
  const queryKey = JSON.stringify(query);
  const heightDecisionSupported =
    !targetHeight.startsWith('DHHN2016') || heightSource === 'ellipsoidal';
  const operationReady =
    discoveryQueryKey === queryKey &&
    heightDecisionSupported &&
    selectedOperation != null &&
    !selectedOperation.ballpark &&
    selectedOperation.requiredGrids.every((grid) => grid.availability.state === 'presentVerified');

  const discover = async () => {
    setOperationBusy(true);
    setOperationError(null);
    try {
      const result = await onDiscoverCrs(query);
      setDiscovery(result);
      setDiscoveryQueryKey(queryKey);
      const preferred = result.candidates.find(
        (candidate) =>
          candidate.bestAvailable &&
          !candidate.ballpark &&
          candidate.requiredGrids.every((grid) => grid.availability.state === 'presentVerified'),
      );
      setSelectedOperationId(preferred?.operationId ?? result.candidates[0]?.operationId ?? null);
    } catch (error) {
      setDiscovery(null);
      setDiscoveryQueryKey(null);
      setSelectedOperationId(null);
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationBusy(false);
    }
  };

  return (
    <section className={styles.root}>
      <ol className={styles.steps} aria-label="Image import steps">
        {['Files', 'Metadata', 'Height', 'Horizontal', 'Import'].map((label, index) => {
          const number = index + 1;
          return (
            <li key={label} className={number === step ? styles.stepActive : ''}>
              <button type="button" onClick={() => setStep(number)}>
                <span>{number < step ? <Check size={11} /> : number}</span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <div className={styles.page}>
          <h3>Files</h3>
          <Metric label="Found" value={String(batch.photos.length)} />
          <Metric label="Importable" value={String(usablePhotos.length)} />
          <Metric
            label="Duplicates"
            value={String(batch.photos.length - usablePhotos.length)}
            warning={batch.photos.length !== usablePhotos.length}
          />
          <div className={styles.actionsInline}>
            <button type="button" onClick={onChooseMoreFiles} disabled={busy}>
              <FileImage size={14} /> Add images
            </button>
            <button type="button" onClick={onChooseFolder} disabled={busy}>
              Add folder
            </button>
          </div>
          <PhotoList batch={batch} />
        </div>
      )}

      {step === 2 && (
        <div className={styles.page}>
          <h3>Metadata validation</h3>
          <Metric label="EXIF GPS" value={`${gpsCount} / ${batch.photos.length}`} />
          <Metric label="DJI metadata" value={`${rtkMetadataCount} / ${batch.photos.length}`} />
          <Metric label="Warnings" value={String(batch.warnings.length)} warning />
          <div className={styles.notice}>
            <AlertTriangle size={15} />
            DJI “AbsoluteAltitude” is not assumed to be ellipsoidal or orthometric height. Confirm
            the vertical reference explicitly in the next step.
          </div>
          <WarningList batch={batch} />
        </div>
      )}

      {step === 3 && (
        <div className={styles.page}>
          <h3>
            <MountainSnow size={15} /> Vertical reference
          </h3>
          <label className={styles.field}>
            <span>Source height of photos</span>
            <select
              value={heightSource}
              onChange={(event) => setHeightSource(event.target.value as HeightSource)}
            >
              <option value="unknown">Unknown · safe default</option>
              <option value="ellipsoidal">WGS84 ellipsoidal height</option>
              <option value="orthometric">Orthometric / normal height</option>
              <option value="deviceProfile">Use DJI device profile</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>Target vertical reference</span>
            <select value={targetHeight} onChange={(event) => setTargetHeight(event.target.value)}>
              <option value="Preserve values">Preserve values</option>
              <option value="DHHN2016 · Normal height">DHHN2016 · Normal height</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>Geoid / Quasigeoid</span>
            <input value={geoidGrid} onChange={(event) => setGeoidGrid(event.target.value)} />
          </label>
          {heightSource === 'unknown' && (
            <div className={styles.blockingNotice}>
              Metric height transformation remains blocked until the source reference is known.
              Original values can still be imported unchanged.
            </div>
          )}
        </div>
      )}

      {step === 4 && (
        <div className={styles.page}>
          <h3>
            <MapPinned size={15} /> Transform horizontal coordinates
          </h3>
          <label className={styles.field}>
            <span>Source</span>
            <input value="EPSG:4326 · WGS 84" readOnly />
          </label>
          <label className={styles.field}>
            <span>Target CRS</span>
            <input value={targetCrs} onChange={(event) => setTargetCrs(event.target.value)} />
          </label>
          <div className={styles.operationCard}>
            <strong>
              {discovery
                ? `${discovery.candidates.length} operations checked`
                : 'Operation not validated yet'}
            </strong>
            {discovery?.candidates.map((candidate) => (
              <label key={candidate.operationId} className={styles.operationChoice}>
                <input
                  type="radio"
                  name="crs-operation"
                  checked={candidate.operationId === selectedOperationId}
                  onChange={() => setSelectedOperationId(candidate.operationId)}
                />
                <span>
                  {candidate.name}
                  <small>
                    {candidate.expectedAccuracyMm == null
                      ? 'Accuracy unknown'
                      : `expected ± ${candidate.expectedAccuracyMm.toFixed(1)} mm`}
                    {candidate.ballpark ? ' · BALLPARK BLOCKED' : ''}
                  </small>
                </span>
              </label>
            ))}
            {discovery?.warnings.map((warning) => (
              <span key={warning}>{warning}</span>
            ))}
            {operationError && <span className={styles.warningText}>{operationError}</span>}
            {!heightDecisionSupported && (
              <span className={styles.warningText}>
                DHHN2016 can only be selected after confirming the source as WGS84 ellipsoidal
                height.
              </span>
            )}
            <button type="button" onClick={() => void discover()} disabled={busy || operationBusy}>
              {operationBusy ? 'PROJ is checking…' : 'Check operations offline'}
            </button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className={styles.page}>
          <h3>Import summary</h3>
          <Metric label="Images" value={String(usablePhotos.length)} />
          <Metric label="Source height" value={heightSourceLabel(heightSource)} />
          <Metric label="Target height" value={targetHeight} />
          <Metric label="Target CRS" value={targetCrs} />
          {operationReady ? (
            <div className={styles.success}>
              PROJ operation and all grid bindings are validated locally.
            </div>
          ) : (
            <div className={styles.blockingNotice}>
              Final commit remains blocked until a non-ballpark PROJ operation and every required
              grid file have been validated locally.
            </div>
          )}
        </div>
      )}

      <footer className={styles.footer}>
        <button type="button" className={styles.secondary} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => setStep((current) => Math.max(1, current - 1))}
          disabled={step === 1}
        >
          Back
        </button>
        {step < 5 ? (
          <button
            type="button"
            className={styles.primary}
            onClick={() => setStep((current) => Math.min(5, current + 1))}
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            className={styles.primary}
            disabled={!operationReady || busy || operationBusy || !selectedOperation}
            onClick={() => {
              if (selectedOperation) {
                void onCommit(
                  buildDecision(
                    query,
                    selectedOperation,
                    discovery,
                    gpsCount > 0,
                    heightSource,
                    targetHeight,
                  ),
                );
              }
            }}
          >
            {busy ? 'Committing import…' : `Import ${usablePhotos.length} images`}
          </button>
        )}
      </footer>
    </section>
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
      {batch.photos.slice(0, 80).map((photo) => (
        <div className={styles.photoRow} key={`${photo.sha256}:${photo.sourcePath}`}>
          <FileImage size={13} />
          <span title={photo.sourcePath}>{fileName(photo.sourcePath)}</span>
          <small>{photo.metadata.exif.model ?? photo.format}</small>
          {preferredGps(photo.metadata) && <em>GPS</em>}
          {photo.metadata.djiXmp.rtk && <em>RTK</em>}
          {photo.duplicateOf && <em className={styles.warningText}>Duplicate</em>}
        </div>
      ))}
      {batch.photos.length > 80 && (
        <div className={styles.more}>+ {batch.photos.length - 80} more</div>
      )}
    </div>
  );
}

function WarningList({ batch }: { batch: PhotoImportBatch }): JSX.Element {
  if (batch.warnings.length === 0)
    return <div className={styles.success}>No metadata warnings</div>;
  return (
    <div className={styles.list}>
      {batch.warnings.slice(0, 80).map((warning, index) => (
        <div className={styles.warningRow} key={`${warning.sourcePath}:${warning.code}:${index}`}>
          <AlertTriangle size={12} />
          <span>{fileName(warning.sourcePath)}</span>
          <small>{warning.message}</small>
        </div>
      ))}
    </div>
  );
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function heightSourceLabel(source: HeightSource): string {
  if (source === 'ellipsoidal') return 'WGS84 ellipsoidal';
  if (source === 'orthometric') return 'Orthometric / normal height';
  if (source === 'deviceProfile') return 'DJI device profile';
  return 'Unknown · no reinterpretation';
}

const GCG2016_SHA256 = '598f18324dea7f8e72421d18add7ac6228259adf91eeb335cc9c27d98484f7ac';

function buildOperationQuery(
  batch: PhotoImportBatch,
  heightSource: HeightSource,
  targetHeight: string,
  targetCrs: string,
): CrsOperationQuery {
  const targetCode = Number.parseInt(/EPSG:\s*(\d+)/i.exec(targetCrs)?.[1] ?? '25832', 10);
  const transformHeight = heightSource === 'ellipsoidal' && targetHeight.startsWith('DHHN2016');
  return {
    source: {
      crs: transformHeight ? { kind: 'epsg', value: 4979 } : { kind: 'epsg', value: 4326 },
    },
    target: {
      crs: transformHeight
        ? { kind: 'authority', value: `EPSG:${targetCode}+7837` }
        : { kind: 'epsg', value: targetCode },
    },
    areaOfInterest: imageArea(batch),
    selectionPolicy: { allowBallpark: false, onlyBest: true },
    gridCatalog: transformHeight
      ? [
          {
            kind: 'geoid',
            officialFilename: 'de_bkg_gcg2016.tif',
            officialSha256: GCG2016_SHA256,
            license: {
              licenseName: 'Creative Commons Attribution 4.0',
              spdxExpression: 'CC-BY-4.0',
              source: 'https://cdn.proj.org/de_bkg_README.txt',
              redistributionAllowed: true,
            },
            coverage: {
              westLongitude: 5.0,
              southLatitude: 47.0,
              eastLongitude: 16.0,
              northLatitude: 56.0,
            },
          },
        ]
      : [],
  };
}

function imageArea(batch: PhotoImportBatch): GeographicArea {
  const positions = batch.photos.flatMap((photo) => {
    const position = preferredGps(photo.metadata);
    return position ? [position] : [];
  });
  if (positions.length === 0) {
    return { westLongitude: -180, southLatitude: -90, eastLongitude: 180, northLatitude: 90 };
  }
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

function buildDecision(
  query: CrsOperationQuery,
  operation: CrsOperationCandidate,
  discovery: CrsOperationDiscovery | null,
  containsGpsData: boolean,
  heightSource: HeightSource,
  targetHeight: string,
): ImageImportDecision {
  if (!discovery) throw new Error('PROJ operation has not been validated yet');
  const transformHeight = heightSource === 'ellipsoidal' && targetHeight.startsWith('DHHN2016');
  return {
    schemaVersion: 1,
    containsGpsData,
    horizontal: { source: query.source, target: query.target },
    vertical: transformHeight
      ? {
          source: { kind: 'ellipsoidal' },
          target: { kind: 'normalHeight', verticalCrs: { kind: 'epsg', value: 7837 } },
          mode: 'transform',
        }
      : {
          source: heightReference(heightSource),
          target: heightReference(heightSource),
          mode: 'preserveValues',
        },
    areaOfInterest: query.areaOfInterest,
    operation,
    selectionPolicy: query.selectionPolicy,
    databaseVersions: discovery.audit.versions,
  };
}

function heightReference(source: HeightSource): Record<string, unknown> {
  if (source === 'ellipsoidal') return { kind: 'ellipsoidal' };
  if (source === 'deviceProfile') return { kind: 'deviceProfile', profileId: 'dji-explicit' };
  if (source === 'orthometric') {
    return { kind: 'orthometric', verticalCrs: { kind: 'epsg', value: 7837 } };
  }
  return { kind: 'unknown' };
}
