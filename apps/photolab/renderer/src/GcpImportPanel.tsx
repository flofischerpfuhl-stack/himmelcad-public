import type {
  GcpCsvImportMapping,
  GcpCsvPreview,
  GcpRole,
  ProjectCameraImageRecord,
} from '@himmelcad/data';
import { AlertTriangle, Check, FileSpreadsheet, MapPinned } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import styles from './GcpImportPanel.module.css';
import type {
  CrsOperationCandidate,
  CrsOperationDiscovery,
  CrsOperationQuery,
  ImageImportDecision,
} from './ImageImportPanel.js';

export interface GcpImportPanelProps {
  path: string | null;
  projectTargetCrs: string | null;
  projectImages: readonly ProjectCameraImageRecord[];
  busy: boolean;
  onChooseFile: () => void;
  onPreview: (path: string, mapping: GcpCsvImportMapping) => Promise<GcpCsvPreview>;
  onDiscoverCrs: (query: CrsOperationQuery) => Promise<CrsOperationDiscovery>;
  onCommit: (
    path: string,
    mapping: GcpCsvImportMapping,
    decision: ImageImportDecision,
  ) => Promise<void>;
  onCancel: () => void;
}

export function GcpImportPanel({
  path,
  projectTargetCrs,
  projectImages,
  busy,
  onChooseFile,
  onPreview,
  onDiscoverCrs,
  onCommit,
  onCancel,
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
  const [sourceCrs, setSourceCrs] = useState(projectTargetCrs ?? 'EPSG:25832');
  const [targetCrs, setTargetCrs] = useState(projectTargetCrs ?? 'EPSG:25832');
  const defaultArea = useMemo(() => projectImageArea(projectImages), [projectImages]);
  const [area, setArea] = useState(defaultArea);
  const [discovery, setDiscovery] = useState<CrsOperationDiscovery | null>(null);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);

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
  const query = useMemo(() => buildQuery(sourceCrs, targetCrs, area), [area, sourceCrs, targetCrs]);
  const selectedOperation =
    discovery?.candidates.find((item) => item.operationId === selectedOperationId) ?? null;
  const operationReady =
    selectedOperation != null &&
    !selectedOperation.ballpark &&
    selectedOperation.requiredGrids.every((grid) => grid.availability.state === 'presentVerified');

  const refreshPreview = async () => {
    if (!path) return;
    setLocalBusy(true);
    setError(null);
    try {
      setPreview(await onPreview(path, mapping));
      setStep(3);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLocalBusy(false);
    }
  };

  const discover = async () => {
    setLocalBusy(true);
    setError(null);
    try {
      const result = await onDiscoverCrs(query);
      setDiscovery(result);
      const preferred = result.candidates.find(
        (item) =>
          item.bestAvailable &&
          !item.ballpark &&
          item.requiredGrids.every((grid) => grid.availability.state === 'presentVerified'),
      );
      setSelectedOperationId(preferred?.operationId ?? result.candidates[0]?.operationId ?? null);
    } catch (reason) {
      setDiscovery(null);
      setSelectedOperationId(null);
      setError(message(reason));
    } finally {
      setLocalBusy(false);
    }
  };

  const commit = async () => {
    if (!path || !selectedOperation || !discovery) return;
    await onCommit(path, mapping, buildDecision(query, selectedOperation, discovery));
  };

  return (
    <section className={styles.root}>
      <ol className={styles.steps}>
        {['File', 'Columns', 'Preview', 'CRS', 'Import'].map((label, index) => {
          const number = index + 1;
          return (
            <li key={label} className={step === number ? styles.activeStep : ''}>
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
            <select
              value={decimalSeparator}
              onChange={(event) =>
                setDecimalSeparator(event.currentTarget.value as 'point' | 'comma')
              }
            >
              <option value="comma">Comma</option>
              <option value="point">Point</option>
            </select>
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
            <select
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
            </select>
          </Field>
          <NumberField
            label="σ horizontal [m]"
            value={horizontalStddev}
            onChange={setHorizontalStddev}
          />
          <NumberField label="σ height [m]" value={heightStddev} onChange={setHeightStddev} />
          <button
            type="button"
            className={styles.primary}
            disabled={!path || localBusy}
            onClick={() => void refreshPreview()}
          >
            {localBusy ? 'Validating…' : 'Validate preview'}
          </button>
        </div>
      )}

      {step === 3 && (
        <div className={styles.page}>
          <h3>Validated preview</h3>
          {!preview ? (
            <div className={styles.notice}>
              <AlertTriangle size={14} /> Validate the column mapping first.
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
            <MapPinned size={15} /> Coordinate transformation
          </h3>
          <Field label="Source CRS">
            <input
              value={sourceCrs}
              onChange={(event) => setSourceCrs(event.currentTarget.value)}
            />
          </Field>
          <Field label="Project CRS">
            <input
              value={targetCrs}
              onChange={(event) => setTargetCrs(event.currentTarget.value)}
            />
          </Field>
          <div className={styles.notice}>
            Define the geographic area explicitly. It limits PROJ operation selection and is frozen
            with the import; PhotoLab never infers a datum transformation silently.
          </div>
          <NumberField
            label="Area west [°]"
            value={area.westLongitude}
            min={-180}
            max={180}
            step={0.0001}
            onChange={(value) => setArea({ ...area, westLongitude: value })}
          />
          <NumberField
            label="Area south [°]"
            value={area.southLatitude}
            min={-90}
            max={90}
            step={0.0001}
            onChange={(value) => setArea({ ...area, southLatitude: value })}
          />
          <NumberField
            label="Area east [°]"
            value={area.eastLongitude}
            min={-180}
            max={180}
            step={0.0001}
            onChange={(value) => setArea({ ...area, eastLongitude: value })}
          />
          <NumberField
            label="Area north [°]"
            value={area.northLatitude}
            min={-90}
            max={90}
            step={0.0001}
            onChange={(value) => setArea({ ...area, northLatitude: value })}
          />
          {projectTargetCrs && targetCrs !== projectTargetCrs && (
            <div className={styles.notice}>
              <AlertTriangle size={14} /> The target differs from the established project frame{' '}
              {projectTargetCrs} and will be rejected at commit time.
            </div>
          )}
          <button
            type="button"
            className={styles.secondary}
            disabled={localBusy}
            onClick={() => void discover()}
          >
            {localBusy ? 'PROJ is checking…' : 'Check offline operations'}
          </button>
          {discovery?.candidates.map((candidate) => (
            <label key={candidate.operationId} className={styles.operation}>
              <input
                type="radio"
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
          <h3>Approve import</h3>
          <div className={styles.notice}>
            The CSV is hashed and parsed again before commit. Transformation, point definitions, and
            roles are stored content-addressed.
          </div>
          <button
            type="button"
            className={styles.primary}
            disabled={busy || !preview || preview.errors.length > 0 || !operationReady}
            onClick={() => void commit()}
          >
            {busy ? 'Importing…' : `Import ${preview?.validPointCount ?? 0} GCPs`}
          </button>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}
      <footer>
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
            disabled={step >= 5}
            onClick={() => setStep((value) => Math.min(5, value + 1))}
          >
            Next
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
      <input
        type="checkbox"
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
  if (hasHeader && headers?.includes(value)) return { kind: 'header' as const, value };
  const index = Number.parseInt(value, 10);
  return { kind: 'index' as const, value: Number.isSafeInteger(index) && index >= 0 ? index : 0 };
}

function buildQuery(
  source: string,
  target: string,
  areaOfInterest: CrsOperationQuery['areaOfInterest'],
): CrsOperationQuery {
  return {
    source: { crs: parseCrs(source) },
    target: { crs: parseCrs(target) },
    areaOfInterest,
    selectionPolicy: { allowBallpark: false, onlyBest: true },
    gridCatalog: [
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
    ],
  };
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
  const match = /^EPSG:\s*(\d+)$/i.exec(value.trim());
  return match
    ? { kind: 'epsg', value: Number(match[1]) }
    : { kind: 'authority', value: value.trim() };
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
