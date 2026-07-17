import type {
  GcpCsvImportMapping,
  GcpCsvPreview,
  GcpRole,
  ProjectCameraImageRecord,
} from '@himmelcad/data';
import { Checkbox, CrsTransformPair, Radio, Select } from '@himmelcad/ui';
import {
  AlertTriangle,
  Check,
  FileSpreadsheet,
  Grid3X3,
  LoaderCircle,
  MapPinned,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import styles from './GcpImportPanel.module.css';
import {
  CrsPicker,
  HORIZONTAL_CRS_PRESETS,
  type CrsOperationCandidate,
  type CrsOperationDiscovery,
  type CrsOperationQuery,
  type ImageImportDecision,
  type ImageImportProgress,
  type LocalGridSelection,
} from './ImageImportPanel.js';

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
  onSelectGrid: (kind: 'horizontal') => Promise<LocalGridSelection | null>;
  onCommit: (
    path: string,
    mapping: GcpCsvImportMapping,
    decision: ImageImportDecision,
    coordinatesAlreadyInProjectCrs: boolean,
  ) => Promise<void>;
  onCancel: () => void;
  onError: (message: string) => void;
}

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
  const [step, setStep] = useState(1);
  const [delimiter, setDelimiter] = useState(';');
  const [decimalSeparator, setDecimalSeparator] = useState<'point' | 'comma'>('comma');
  const [hasHeader, setHasHeader] = useState(true);
  const [columns, setColumns] = useState({ name: '0', east: '1', north: '2', height: '3' });
  const [role, setRole] = useState<GcpRole>('controlXyz');
  const [horizontalStddev, setHorizontalStddev] = useState(0.02);
  const [heightStddev, setHeightStddev] = useState(0.03);
  const [preview, setPreview] = useState<GcpCsvPreview | null>(null);
  const [transformCoordinates, setTransformCoordinates] = useState(false);
  const [sourceCrsEpsg, setSourceCrsEpsg] = useState(25832);
  const targetCrsEpsg = parseEpsgCode(projectTargetCrs) ?? 25832;
  const sourceCrs = `EPSG:${sourceCrsEpsg}`;
  const targetCrs = `EPSG:${targetCrsEpsg}`;
  const defaultArea = useMemo(() => projectImageArea(projectImages), [projectImages]);
  const area = defaultArea;
  const [discovery, setDiscovery] = useState<CrsOperationDiscovery | null>(null);
  const [discoveryQueryKey, setDiscoveryQueryKey] = useState<string | null>(null);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [localGrid, setLocalGrid] = useState<LocalGridSelection | null>(null);
  const preferencesHydrated = useRef(false);

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
  const query = useMemo(
    () =>
      buildQuery(
        transformCoordinates ? sourceCrs : targetCrs,
        targetCrs,
        area,
        transformCoordinates ? localGrid : null,
      ),
    [area, localGrid, sourceCrs, targetCrs, transformCoordinates],
  );
  const selectedOperation =
    discovery?.candidates.find((item) => item.operationId === selectedOperationId) ?? null;
  const operationReady =
    discoveryQueryKey === JSON.stringify(query) &&
    selectedOperation != null &&
    !selectedOperation.ballpark &&
    selectedOperation.requiredGrids.every((grid) => grid.availability.state === 'presentVerified');

  const mappingInputKey = JSON.stringify({
    columns,
    decimalSeparator,
    delimiter,
    hasHeader,
    heightStddev,
    horizontalStddev,
    role,
  });

  useEffect(() => {
    setPreview(null);
  }, [mappingInputKey]);

  const refreshPreview = async () => {
    if (!path) return;
    setLocalBusy(true);
    setError(null);
    try {
      const nextPreview = await onPreview(path, mapping);
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
      setStep(3);
    } catch (reason) {
      const detail = message(reason);
      setError(detail);
      onError(detail);
    } finally {
      setLocalBusy(false);
    }
  };

  useEffect(() => {
    if (step !== 4) return;
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
          const preferred = result.candidates.find(
            (item) =>
              item.bestAvailable &&
              !item.ballpark &&
              item.requiredGrids.every((grid) => grid.availability.state === 'presentVerified'),
          );
          setSelectedOperationId(
            preferred?.operationId ?? result.candidates[0]?.operationId ?? null,
          );
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
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [onDiscoverCrs, onError, query, step]);

  const chooseGrid = async (): Promise<void> => {
    setLocalBusy(true);
    setError(null);
    try {
      const selected = await onSelectGrid('horizontal');
      if (!selected) return;
      if (selected.kind === 'geoid')
        throw new Error(`${selected.filename} is a vertical grid, not a horizontal datum grid.`);
      if (!containsArea(selected.coverage, area))
        throw new Error(
          `${selected.filename} does not cover the GCP/project area. Select a grid whose coverage contains the image positions.`,
        );
      setLocalGrid(selected);
      setDiscoveryQueryKey(null);
    } catch (reason) {
      const detail = message(reason);
      setError(detail);
      onError(detail);
    } finally {
      setLocalBusy(false);
    }
  };

  const commit = async () => {
    if (!path || !selectedOperation || !discovery) return;
    await onCommit(
      path,
      mapping,
      buildDecision(query, selectedOperation, discovery),
      !transformCoordinates,
    );
  };

  const previewReady = preview?.errors.length === 0;
  const canVisitStep = (candidate: number): boolean => {
    if (candidate === 1) return true;
    if (candidate === 2) return path != null;
    if (candidate === 3 || candidate === 4) return previewReady;
    return previewReady && operationReady;
  };
  const next = async (): Promise<void> => {
    if (step === 1 && path) setStep(2);
    else if (step === 2) await refreshPreview();
    else if (step === 3 && previewReady) setStep(4);
    else if (step === 4 && operationReady) setStep(5);
    else if (step === 5) await commit();
  };
  const nextDisabled =
    busy ||
    localBusy ||
    (step === 1 && !path) ||
    (step === 3 && !previewReady) ||
    (step === 4 && !operationReady) ||
    (step === 5 && (!previewReady || !operationReady));

  return (
    <section className={styles.root}>
      <header className={styles.header} data-task-drag-handle>
        <h2 className={styles.functionTitle}>GCP Import</h2>
        <button type="button" onClick={onCancel} aria-label="Close GCP import">
          <X size={16} />
        </button>
      </header>
      <ol className={styles.steps}>
        {['File', 'Columns', 'Preview', 'CRS', 'Import'].map((label, index) => {
          const number = index + 1;
          return (
            <li key={label} className={step === number ? styles.activeStep : ''}>
              <button
                type="button"
                disabled={!canVisitStep(number)}
                onClick={() => setStep(number)}
              >
                <span>{number < step ? <Check size={11} /> : number}</span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <div className={styles.page}>
          <FileSpreadsheet size={30} />
          <h3>GCP coordinate file</h3>
          <p>{path ?? 'No CSV or text file selected yet.'}</p>
          <button type="button" className={styles.secondary} onClick={onChooseFile} disabled={busy}>
            Select file
          </button>
        </div>
      )}

      {step === 2 && (
        <div className={styles.page}>
          <h3>CSV and columns</h3>
          <Field label="Delimiter">
            <input
              value={delimiter}
              maxLength={1}
              onChange={(event) => setDelimiter(event.currentTarget.value)}
            />
          </Field>
          <Field label="Decimal separator">
            <Select
              value={decimalSeparator}
              onChange={(event) =>
                setDecimalSeparator(event.currentTarget.value as 'point' | 'comma')
              }
            >
              <option value="comma">Comma</option>
              <option value="point">Point</option>
            </Select>
          </Field>
          <Toggle
            label="First row contains column names"
            checked={hasHeader}
            onChange={setHasHeader}
          />
          {(['name', 'east', 'north', 'height'] as const).map((key) => (
            <Field key={key} label={columnLabel(key)}>
              <input
                value={columns[key]}
                list={preview ? 'gcp-headers' : undefined}
                onChange={(event) => setColumns({ ...columns, [key]: event.currentTarget.value })}
              />
            </Field>
          ))}
          {preview && (
            <datalist id="gcp-headers">
              {preview.header.map((header) => (
                <option key={header} value={header} />
              ))}
            </datalist>
          )}
          <Field label="Default role">
            <Select
              value={role}
              onChange={(event) => setRole(event.currentTarget.value as GcpRole)}
            >
              <option value="controlXyz">Control · horizontal + height</option>
              <option value="controlXy">Control · horizontal only</option>
              <option value="controlZ">Control · height only</option>
              <option value="checkpointXyz">Checkpoint · horizontal + height</option>
              <option value="checkpointXy">Checkpoint · horizontal only</option>
              <option value="checkpointZ">Checkpoint · height only</option>
              <option value="disabled">Disabled</option>
            </Select>
          </Field>
          <NumberField
            label="σ horizontal [m]"
            value={horizontalStddev}
            onChange={setHorizontalStddev}
          />
          <NumberField label="σ height [m]" value={heightStddev} onChange={setHeightStddev} />
          {localBusy && (
            <div className={styles.validating} role="status">
              <LoaderCircle className={styles.spinner} size={14} /> Reading and validating preview…
            </div>
          )}
        </div>
      )}

      {step === 3 && (
        <div className={styles.page}>
          <h3>Preview</h3>
          {!preview ? (
            <div className={styles.notice}>
              <AlertTriangle size={14} /> Return to Columns and press Next to create the preview.
            </div>
          ) : (
            <>
              <div className={styles.metrics}>
                <Metric label="Data rows" value={preview.dataRowCount} />
                <Metric label="Valid" value={preview.validPointCount} />
                <Metric
                  label="Errors"
                  value={preview.errors.length}
                  warning={preview.errors.length > 0}
                />
              </div>
              <div className={styles.tableWrap}>
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
              {preview.errors.map((item) => (
                <div key={`${item.sourceLine}:${item.field}`} className={styles.error}>
                  Row {item.sourceLine} · {item.field}: {item.message}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {step === 4 && (
        <div className={styles.page}>
          <h3>
            <MapPinned size={15} /> Coordinate reference
          </h3>
          <div className={styles.crsSummary}>
            <span>Project reference</span>
            <strong>{targetCrs}</strong>
          </div>
          <CrsTransformPair
            title="Horizontal transform"
            hint="Left: CRS stored in the CSV. Right: project target CRS. Uncheck transform only when values are already in the project CRS."
            noTransform={!transformCoordinates}
            onNoTransformChange={(noTransform) => setTransformCoordinates(!noTransform)}
            noTransformLabel="No transform — CSV is already in project CRS"
            source={
              <CrsPicker
                label="CSV source CRS"
                value={sourceCrsEpsg}
                presets={HORIZONTAL_CRS_PRESETS}
                onChange={setSourceCrsEpsg}
              />
            }
            target={
              <div className={styles.crsSummary}>
                <span>Project target</span>
                <strong>{targetCrs}</strong>
              </div>
            }
          />
          {transformCoordinates && sourceCrs !== targetCrs && (
            <div className={styles.gridSelector}>
              <Grid3X3 size={16} />
              <span>
                <strong>Datum transformation grid</strong>
                <small>
                  {localGrid
                    ? `${localGrid.filename} · registered locally`
                    : 'Bundled official grids are used when they cover the project.'}
                </small>
                {gridProgress?.phase === 'grid' && <ProgressBar value={gridProgress.fraction} />}
              </span>
              <button
                type="button"
                className={styles.secondary}
                disabled={localBusy}
                onClick={() => void chooseGrid()}
              >
                {gridProgress?.phase === 'grid' && (
                  <LoaderCircle className={styles.spinner} size={13} />
                )}
                {localGrid ? 'Change file' : 'Choose grid file…'}
              </button>
            </div>
          )}
          {localBusy && (
            <div className={styles.validating}>
              <LoaderCircle className={styles.spinner} size={14} /> Validating coordinate operation…
            </div>
          )}
          {transformCoordinates &&
            discovery?.candidates.map((candidate) => (
              <label key={candidate.operationId} className={styles.operation}>
                <Radio
                  checked={selectedOperationId === candidate.operationId}
                  onChange={() => setSelectedOperationId(candidate.operationId)}
                />
                <span>
                  <strong>{candidate.name}</strong>
                  <small>
                    {candidate.expectedAccuracyMm == null
                      ? 'Accuracy not specified'
                      : `${candidate.expectedAccuracyMm.toFixed(1)} mm`}
                    {candidate.ballpark ? ' · ballpark blocked' : ''}
                  </small>
                </span>
              </label>
            ))}
        </div>
      )}

      {step === 5 && (
        <div className={styles.page}>
          <h3>Review import</h3>
          <div className={styles.crsSummary}>
            <span>Points</span>
            <strong>{preview?.validPointCount ?? 0}</strong>
          </div>
          <div className={styles.crsSummary}>
            <span>Coordinate handling</span>
            <strong>
              {transformCoordinates ? `${sourceCrs} → ${targetCrs}` : `Use values as ${targetCrs}`}
            </strong>
          </div>
          {busy && (
            <div className={styles.validating} role="status">
              <LoaderCircle className={styles.spinner} size={14} /> Importing ground control points…
            </div>
          )}
          {!localBusy && !operationReady && (
            <div className={styles.error}>
              {error ?? 'No valid coordinate operation is selected.'}
            </div>
          )}
        </div>
      )}

      {(error ?? externalError) && (
        <div className={styles.error} role="alert">
          <AlertTriangle size={14} /> {error ?? externalError}
        </div>
      )}
      <footer className={styles.footer}>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <div>
          <button
            type="button"
            disabled={step <= 1}
            onClick={() => setStep((value) => Math.max(1, value - 1))}
          >
            Back
          </button>
          <button
            type="button"
            className={step === 5 ? styles.primary : undefined}
            disabled={nextDisabled}
            onClick={() => void next()}
          >
            {localBusy
              ? 'Working…'
              : step === 5
                ? busy
                  ? 'Importing…'
                  : `Import ${preview?.validPointCount ?? 0} GCPs`
                : 'Next'}
          </button>
        </div>
      </footer>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function NumberField({
  label,
  value,
  min = 0,
  max,
  step = 0.001,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <Field label={label}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </Field>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <label className={styles.toggle}>
      <Checkbox
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span aria-hidden="true" />
      {label}
    </label>
  );
}

function Metric({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: number;
  warning?: boolean;
}): JSX.Element {
  return (
    <div className={warning ? styles.metricWarning : styles.metric}>
      <span>{label}</span>
      <strong>{value.toLocaleString('en-US')}</strong>
    </div>
  );
}

function selector(value: string, hasHeader: boolean, headers: readonly string[] | undefined) {
  if (hasHeader && (headers?.includes(value) || !/^\d+$/.test(value.trim())))
    return { kind: 'header' as const, value };
  const index = Number.parseInt(value, 10);
  return { kind: 'index' as const, value: Number.isSafeInteger(index) && index >= 0 ? index : 0 };
}

function buildQuery(
  source: string,
  target: string,
  areaOfInterest: CrsOperationQuery['areaOfInterest'],
  localGrid: LocalGridSelection | null,
): CrsOperationQuery {
  return {
    source: { crs: parseCrs(source) },
    target: { crs: parseCrs(target) },
    areaOfInterest,
    selectionPolicy: { allowBallpark: false, onlyBest: true },
    gridCatalog: localGrid
      ? [
          {
            kind: localGrid.kind,
            officialFilename: localGrid.filename,
            license: {
              licenseName: 'User-supplied local grid',
              source: localGrid.localPath,
              redistributionAllowed: false,
            },
            coverage: localGrid.coverage,
            localPath: localGrid.localPath,
          },
        ]
      : [
          {
            kind: 'gtg',
            officialFilename: 'de_adv_BETA2007.tif',
            officialSha256: '46e681fcc7d022dde1db1f9d0a3426a9bfb1d4a151af69a81b3c30104c9388e2',
            license: {
              licenseName: 'AdV free redistribution notice',
              source: 'https://cdn.proj.org/de_adv_README.txt',
              redistributionAllowed: true,
            },
            coverage: {
              westLongitude: 5.416666666666667,
              southLatitude: 46.95,
              eastLongitude: 15.75,
              northLatitude: 55.35,
            },
          },
          {
            kind: 'ntv2',
            officialFilename: 'de_lgvl_saarland_SeTa2016.tif',
            officialSha256: '529acdef6f5634669087de3dfc7923ab0100a9a7d94fa5e5b4aadb7ec4226c6c',
            license: {
              licenseName: 'Creative Commons Attribution 4.0',
              spdxExpression: 'CC-BY-4.0',
              source: 'https://cdn.proj.org/de_lgvl_saarland_README.txt',
              redistributionAllowed: true,
            },
            coverage: {
              westLongitude: 6.345,
              southLatitude: 49.1,
              eastLongitude: 7.455,
              northLatitude: 49.6466667,
            },
          },
        ],
  };
}

function ProgressBar({ value }: { value: number }): JSX.Element {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={styles.progress}>
      <span style={{ width: `${percent}%` }} />
      <code>{percent}%</code>
    </div>
  );
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

function parseCrs(value: string): { kind: 'epsg' | 'authority'; value: number | string } {
  const match = /^EPSG:\s*(\d+)(?:\+\d+)?$/i.exec(value.trim());
  return match
    ? { kind: 'epsg', value: Number(match[1]) }
    : { kind: 'authority', value: value.trim() };
}

function parseEpsgCode(value: string | null): number | null {
  if (!value) return null;
  const match = /^EPSG:\s*(\d+)(?:\+\d+)?$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function buildDecision(
  query: CrsOperationQuery,
  operation: CrsOperationCandidate,
  discovery: CrsOperationDiscovery,
): ImageImportDecision {
  return {
    schemaVersion: 1,
    containsGpsData: false,
    horizontal: { source: query.source, target: query.target },
    vertical: { source: { kind: 'unknown' }, target: { kind: 'unknown' }, mode: 'preserveValues' },
    areaOfInterest: query.areaOfInterest,
    operation,
    selectionPolicy: query.selectionPolicy,
    databaseVersions: discovery.audit.versions,
  };
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
