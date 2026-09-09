import { Button, NumberInput, ProgressBar, Select } from '@himmelcad/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  BuilderCanonicalProjectSession,
  SurfaceEditBakeResult,
  SurfaceEditPreview,
  SurfaceEditRegionResult,
  SurfaceSmoothFilter,
} from './project.js';
import styles from './SurfaceEditPanel.module.css';

export interface SurfaceBoundaryCandidate {
  readonly entityId: string;
  readonly name: string;
  readonly polygon: readonly (readonly [number, number])[];
  readonly worldPolygon: readonly (readonly [number, number, number])[] | null;
}

export function SurfaceEditPanel({
  session,
  target,
  fencePolygon,
  boundaries,
  onRegionSourceChange,
  onRegionWorldPolygonChange,
  onPreview,
  onPublished,
  onLog,
}: {
  readonly session: BuilderCanonicalProjectSession;
  readonly target: { readonly entityId: string; readonly name: string } | null;
  readonly fencePolygon: readonly (readonly [number, number])[] | null;
  readonly boundaries: readonly SurfaceBoundaryCandidate[];
  readonly onRegionSourceChange: (source: 'fence' | 'boundary_polyline') => void;
  readonly onRegionWorldPolygonChange: (
    polygon: readonly (readonly [number, number, number])[] | null,
  ) => void;
  readonly onPreview: (preview: SurfaceEditPreview | null) => void;
  readonly onPublished: (result: SurfaceEditBakeResult) => void;
  readonly onLog: (message: string) => void;
}): JSX.Element {
  const [regionSource, setRegionSource] = useState<'fence' | 'boundary_polyline'>('fence');
  const [boundaryId, setBoundaryId] = useState(boundaries[0]?.entityId ?? '');
  const [editId, setEditId] = useState(() => `surface-edit-${crypto.randomUUID()}`);
  const [region, setRegion] = useState<SurfaceEditRegionResult | null>(null);
  const [filter, setFilter] = useState<SurfaceSmoothFilter>('gaussian');
  const [radius, setRadius] = useState(1);
  const [targetError, setTargetError] = useState(0.02);
  const [preview, setPreview] = useState<SurfaceEditPreview | null>(null);
  const [result, setResult] = useState<SurfaceEditBakeResult | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const regionKeyRef = useRef('');
  const polygon = useMemo(() => {
    if (regionSource === 'fence') return fencePolygon;
    return boundaries.find((item) => item.entityId === boundaryId)?.polygon ?? null;
  }, [boundaries, boundaryId, fencePolygon, regionSource]);

  useEffect(() => {
    onRegionWorldPolygonChange(
      regionSource === 'boundary_polyline'
        ? (boundaries.find((item) => item.entityId === boundaryId)?.worldPolygon ?? null)
        : null,
    );
  }, [boundaries, boundaryId, onRegionWorldPolygonChange, regionSource]);

  useEffect(() => {
    if (!target || !polygon || polygon.length < 3) {
      setRegion(null);
      setPreview(null);
      onPreview(null);
      return;
    }
    const key = `${target.entityId}:${regionSource}:${polygon.map((point) => point.join(',')).join(';')}`;
    if (regionKeyRef.current === key) return;
    regionKeyRef.current = key;
    const nextEditId = `surface-edit-${crypto.randomUUID()}`;
    setEditId(nextEditId);
    setRegion(null);
    setPreview(null);
    onPreview(null);
    setError(null);
    void session
      .selectSurfaceEditRegion(nextEditId, target.entityId, {
        source: regionSource,
        polygon,
      })
      .then((selected) => {
        setRegion(selected);
        onLog(
          `mesh.edit.region.select · ${selected.summary.area.toFixed(2)} m² · ${selected.summary.vertices.toLocaleString()} vertices`,
        );
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [onLog, onPreview, polygon, regionSource, session, target]);

  const runJob = async <T,>(
    label: string,
    initialPhase: string,
    operation: (operationId: string) => Promise<T>,
  ): Promise<T | null> => {
    const id = `mesh-edit-${crypto.randomUUID()}`;
    setOperationId(id);
    setPhase(initialPhase);
    setError(null);
    const jobs = window.himmelcad?.jobs;
    let registered = false;
    try {
      if (jobs) {
        await jobs.register({
          id,
          label,
          owner: 'builder.mesh-edit',
          phase: initialPhase,
          expectedDurationMs: 60_000,
          progressKey: id,
          cancellable: true,
          context: { targetEntityId: target?.entityId ?? '', editId },
        });
        registered = true;
      }
      const value = await operation(id);
      if (registered) await jobs!.complete(id, 'Verified surface generation ready');
      return value;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const state = registered ? await jobs!.get(id).catch(() => null) : null;
      if (state?.state === 'cancelling' || /cancelled|canceled/i.test(message)) {
        if (registered) await jobs!.cancelled(id);
      } else if (registered) {
        await jobs!.fail(id, message);
      }
      setError(message);
      return null;
    } finally {
      setOperationId(null);
      setPhase('');
    }
  };

  const previewSmooth = async (): Promise<SurfaceEditPreview | null> => {
    if (!region) return null;
    const value = await runJob('Preview surface smoothing', 'Cut region · filter heights · refill',
      (id) => session.previewSurfaceSmooth(id, editId, filter, radius));
    if (value) {
      setPreview(value);
      onPreview(value);
      onLog(formatResult('mesh.edit.smooth preview', value.metrics));
    }
    return value;
  };

  const bake = async (kind: 'smooth' | 'downsample'): Promise<void> => {
    if (!region || !target) return;
    if (kind === 'smooth' && (!preview || preview.algorithmId !== 'hcad.mesh.smooth-region@1')) {
      if (!(await previewSmooth())) return;
    }
    if (kind === 'downsample') {
      const candidate = await runJob('Preview surface downsampling', 'Simplify · certify vertical error',
        (id) => session.previewSurfaceDownsample(id, editId, targetError));
      if (!candidate) return;
      setPreview(candidate);
      onPreview(candidate);
    }
    setPhase('Prepare · validate · publish generation');
    const baked = await runJob(
      kind === 'smooth' ? 'Smooth DGM region' : 'Downsample DGM region',
      'Prepare · validate · publish generation',
      (id) =>
        session.bakeSurfaceEdit({
          kind,
          operationId: id,
          editId,
          outputEntityId: `surface-${crypto.randomUUID()}`,
          outputName: `${target.name} · ${kind === 'smooth' ? 'smoothed' : 'downsampled'}`,
          ...(kind === 'smooth' ? { smooth: { filter, radius } } : {}),
          ...(kind === 'downsample'
            ? { downsample: { maximumVerticalError: targetError } }
            : {}),
        }),
    );
    if (baked) {
      setResult(baked);
      onPublished(baked);
      onLog(formatResult(`mesh.edit.${kind}`, baked.metrics));
    }
  };

  const setSource = (source: 'fence' | 'boundary_polyline'): void => {
    setRegionSource(source);
    regionKeyRef.current = '';
    onRegionSourceChange(source);
  };
  const busy = operationId !== null;

  return (
    <div className={styles.panel} aria-label="Edit surface panel" aria-busy={busy}>
      <p className={styles.target}>{target ? target.name : 'Select one visible, editable DGM.'}</p>
      <div className={styles.segmented} role="group" aria-label="Region source">
        <Button variant={regionSource === 'fence' ? 'primary' : 'secondary'} disabled={busy} onClick={() => setSource('fence')}>Fence</Button>
        <Button variant={regionSource === 'boundary_polyline' ? 'primary' : 'secondary'} disabled={busy || boundaries.length === 0} onClick={() => setSource('boundary_polyline')}>Boundary polyline</Button>
      </div>
      {regionSource === 'boundary_polyline' ? (
        <Select aria-label="Boundary polyline" value={boundaryId} disabled={busy} options={boundaries.map((item) => ({ value: item.entityId, label: item.name }))} onChange={(event) => { setBoundaryId(event.currentTarget.value); regionKeyRef.current = ''; }} />
      ) : (
        <p className={styles.hint}>{fencePolygon ? 'Projection-true fence captured.' : 'Draw a polygon or rectangle fence in the viewport.'}</p>
      )}
      <code className={styles.readout}>{region ? `Region ${formatArea(region.summary.area)} · ${region.summary.vertices.toLocaleString()} vertices` : 'Region —'}</code>

      <section className={styles.group}>
        <h3>Smooth</h3>
        <label><span>Filter</span><Select aria-label="Smoothing filter" value={filter} disabled={busy} options={[{ value: 'gaussian', label: 'Gaussian' }, { value: 'median', label: 'Median' }]} onChange={(event) => { setFilter(event.currentTarget.value as SurfaceSmoothFilter); setPreview(null); onPreview(null); }} /></label>
        <label><span>Radius</span><NumberInput aria-label="Smoothing radius" value={radius} min={0.001} max={100_000} step={0.1} precision={3} unit="m" disabled={busy} onValueChange={(value) => { if (value != null) { setRadius(value); setPreview(null); onPreview(null); } }} /></label>
        <div className={styles.actions}><Button variant="quiet" disabled={!region || busy} onClick={() => void previewSmooth()}>Preview</Button><Button variant="primary" disabled={!region || busy} onClick={() => void bake('smooth')}>Smooth</Button></div>
      </section>

      <section className={styles.group}>
        <h3>Downsample</h3>
        <label><span>Target error</span><NumberInput aria-label="Maximum vertical error" value={targetError} min={0} max={100_000} step={0.01} precision={3} unit="m" disabled={busy} onValueChange={(value) => value != null && setTargetError(value)} /></label>
        <Button variant="primary" disabled={!region || busy} onClick={() => void bake('downsample')}>Downsample</Button>
      </section>

      {(preview || result) ? <code className={styles.result}>{formatMetrics((result ?? preview)!.metrics)}</code> : null}
      {busy ? <div className={styles.running}><span>{phase}</span><ProgressBar value={0} indeterminate ariaLabel="Surface edit progress" /><Button variant="secondary" onClick={() => operationId && void session.cancelSurfaceEdit(operationId)}>Cancel</Button></div> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </div>
  );
}

function formatArea(area: number): string {
  return area >= 1_000 ? `${Math.round(area).toLocaleString()} m²` : `${area.toFixed(2)} m²`;
}

function formatMetrics(metrics: SurfaceEditPreview['metrics']): string {
  return `Vertices ${metrics.verticesBefore.toLocaleString()} → ${metrics.verticesAfter.toLocaleString()} · max error ${metrics.error.maximumVerticalError.toFixed(3)} m · RMS ${metrics.error.rmsVerticalError.toFixed(3)} m`;
}

function formatResult(prefix: string, metrics: SurfaceEditPreview['metrics']): string {
  return `${prefix} · ${formatMetrics(metrics)} · region ${formatArea(metrics.regionArea)} · ${metrics.error.certified ? 'certified' : 'measured'}`;
}
