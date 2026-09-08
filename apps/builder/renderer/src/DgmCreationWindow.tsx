import { Button, Checkbox, Menu, MenuItem, NumberInput, ProgressBar, Select } from '@himmelcad/ui';
import { useMemo, useState } from 'react';

import type {
  BuilderCanonicalProjectSession,
  SurfaceCheckResult,
  SurfacePublishResult,
  SurfaceRules,
  SurfaceSourceRole,
} from './project.js';
import styles from './DgmCreationWindow.module.css';

export interface DgmSourceCandidate {
  readonly entityId: string;
  readonly name: string;
  readonly kind: 'PointCloud' | 'SinglePoint' | 'Polyline3D' | 'Surface';
  readonly count: number | null;
  readonly role: SurfaceSourceRole;
  readonly visibleClasses?: readonly number[];
}

const ROLE_OPTIONS = [
  { value: 'points', label: 'Points' },
  { value: 'breakline', label: 'Breakline' },
  { value: 'outer_boundary', label: 'Boundary' },
  { value: 'form_line', label: 'Form line' },
  { value: 'hole', label: 'Exclusion' },
] as const;

const DEFAULT_RULES: SurfaceRules = {
  maximumEdgeLength: 25,
  thinCloudSpacing: 0.25,
  xyTolerance: 0.001,
  zTolerance: 0.001,
  excludeOutsideBoundary: true,
  breaklineExclusionDistance: null,
  autoBoundary: true,
  cropPolyline: [],
};

export function DgmCreationWindow({
  session,
  candidates,
  onClose,
  onPublished,
}: {
  readonly session: BuilderCanonicalProjectSession;
  readonly candidates: readonly DgmSourceCandidate[];
  readonly onClose: () => void;
  readonly onPublished: (result: SurfacePublishResult) => void;
}): JSX.Element {
  const [sources, setSources] = useState(candidates);
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [check, setCheck] = useState<SurfaceCheckResult | null>(null);
  const [busy, setBusy] = useState<'check' | 'create' | null>(null);
  const [phase, setPhase] = useState('');
  const [operationId, setOperationId] = useState<string | null>(null);
  const [openFix, setOpenFix] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SurfacePublishResult | null>(null);
  const canCreate = Boolean(draftId && check && check.blocking === 0 && !busy);
  const summary = useMemo(
    () => `${check?.errors.length ?? 0} errors · ${check?.fixable ?? 0} fixable`,
    [check],
  );

  const changeRole = (entityId: string, role: SurfaceSourceRole): void => {
    setSources((current) =>
      current.map((source) => (source.entityId === entityId ? { ...source, role } : source)),
    );
    setDraftId(null);
    setCheck(null);
  };

  const runCheck = async (): Promise<void> => {
    if (sources.length === 0) return;
    const nextDraft = `surface-draft-${crypto.randomUUID()}`;
    const nextOperation = `surface-check-${crypto.randomUUID()}`;
    setBusy('check');
    setPhase('Capturing sources');
    setOperationId(nextOperation);
    setError(null);
    try {
      await session.createSurfaceDraft({
        operationId: nextOperation,
        progressKey: nextOperation,
        draftId: nextDraft,
        name: 'DGM surface',
        sources: sources.map((source) => ({
          entityId: source.entityId,
          role: source.role,
          ...(source.visibleClasses ? { visibleClasses: source.visibleClasses } : {}),
        })),
        rules,
      });
      setPhase('Checking draft');
      const checked = await session.checkSurface(nextDraft);
      setDraftId(nextDraft);
      setCheck(checked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      setOperationId(null);
    }
  };

  const applyFix = async (
    errorId: string,
    fix: 'drop' | 'snap' | 'split' | 'exclude',
  ): Promise<void> => {
    if (!draftId) return;
    setOpenFix(null);
    setBusy('check');
    setPhase(`Applying ${fix}`);
    try {
      const fixed = await session.fixSurface(draftId, errorId, fix);
      setCheck(fixed.check);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const create = async (): Promise<void> => {
    if (!draftId || !canCreate) return;
    const nextOperation = `surface-create-${crypto.randomUUID()}`;
    setOperationId(nextOperation);
    setBusy('create');
    setPhase('Triangulate · constrain · validate · bake');
    setError(null);
    try {
      const published = await session.publishSurface({
        operationId: nextOperation,
        progressKey: nextOperation,
        draftId,
        outputEntityId: `surface-${crypto.randomUUID()}`,
      });
      setResult(published);
      onPublished(published);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      setOperationId(null);
    }
  };

  const cancel = (): void => {
    if (operationId) void session.cancelSurface(operationId);
    else onClose();
  };

  return (
    <section className={styles.window} aria-label="DGM creation window" aria-busy={Boolean(busy)}>
      <header className={styles.header} data-task-drag-handle>
        <div><strong>Create surface</strong><span>DGM · checked TIN</span></div>
        <Button variant="quiet" aria-label="Close DGM window" onClick={onClose}>×</Button>
      </header>

      <div className={styles.columns}>
        <section className={styles.column}>
          <h2>Sources</h2>
          <div className={styles.sourceList}>
            {sources.length === 0 ? <p className={styles.muted}>Select points, clouds, grids, or polylines.</p> : null}
            {sources.map((source) => (
              <div className={styles.source} key={source.entityId}>
                <span className={styles.glyph} data-kind={source.kind} aria-hidden />
                <span className={styles.sourceName}>{source.name}<small>{source.count == null ? source.kind : `${source.count.toLocaleString()} items`}</small></span>
                <Select
                  aria-label={`Role for ${source.name}`}
                  value={source.role}
                  disabled={Boolean(busy)}
                  options={ROLE_OPTIONS.filter((option) => source.kind === 'Polyline3D' ? option.value !== 'points' : option.value === 'points')}
                  onChange={(event) => changeRole(source.entityId, event.currentTarget.value as SurfaceSourceRole)}
                />
              </div>
            ))}
          </div>
          <p className={styles.hint}>Source coordinates and visible cloud classes are captured when Check starts.</p>
        </section>

        <section className={styles.column}>
          <h2>Rules</h2>
          <Rule label="Maximum edge" unit="m" value={rules.maximumEdgeLength} disabled={Boolean(busy)} onChange={(value) => value != null && (setRules({ ...rules, maximumEdgeLength: value }), setCheck(null))} />
          <Rule label="Thin cloud" unit="m" value={rules.thinCloudSpacing} disabled={Boolean(busy)} onChange={(value) => value != null && (setRules({ ...rules, thinCloudSpacing: value }), setCheck(null))} />
          <Checkbox label="Automatic boundary" checked={rules.autoBoundary} disabled={Boolean(busy)} onChange={(event) => { setRules({ ...rules, autoBoundary: event.currentTarget.checked }); setCheck(null); }} />
          <Checkbox label="Exclude outside boundary" checked={rules.excludeOutsideBoundary} disabled={Boolean(busy)} onChange={(event) => { setRules({ ...rules, excludeOutsideBoundary: event.currentTarget.checked }); setCheck(null); }} />
          <Checkbox label="Boundary role is 2D crop" checked={sources.some((source) => source.role === 'outer_boundary')} disabled />
          <p className={styles.hint}>Boundary and exclusion polylines are draped over the evaluated surface. They never supply Z.</p>
        </section>

        <section className={styles.column}>
          <h2>Check results</h2>
          <code className={styles.summary}>{summary}</code>
          <div className={styles.errors}>
            {!check ? <p className={styles.muted}>Run Check before publishing.</p> : null}
            {check?.errors.map((item) => (
              <div className={styles.errorRow} key={item.errorId}>
                <span className={styles.severity} data-severity={item.severity} aria-label={item.severity}>!</span>
                <span>{item.message}</span>
                {item.fixes.length > 0 ? (
                  <div className={styles.fix}>
                    <Button variant="quiet" onClick={() => setOpenFix(openFix === item.errorId ? null : item.errorId)}>Fix ▾</Button>
                    {openFix === item.errorId ? (
                      <Menu ariaLabel={`Fix ${item.message}`} onClose={() => setOpenFix(null)} className={styles.fixMenu!}>
                        {item.fixes.map((fix) => <MenuItem key={fix} onSelect={() => void applyFix(item.errorId, fix)}>{fixLabel(fix)}</MenuItem>)}
                      </Menu>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
            {check && check.errors.length === 0 ? <div className={styles.pass}>✓ Check passed</div> : null}
          </div>
          {result ? <div className={styles.result}>TIN {result.triangles.toLocaleString()} triangles · {result.area.toFixed(2)} m²<br />Z {result.zRange[0].toFixed(2)}–{result.zRange[1].toFixed(2)} m · residual {result.residual.maximumAbsolute.toFixed(3)} m</div> : null}
        </section>
      </div>

      {busy ? <div className={styles.progress}><span>{phase}</span><ProgressBar value={0} indeterminate ariaLabel="Surface creation progress" /></div> : null}
      {error ? <div className={styles.alert} role="alert">{error}</div> : null}
      <footer className={styles.footer}>
        <Button variant="secondary" disabled={Boolean(busy) || sources.length === 0} onClick={() => void runCheck()}>Check</Button>
        <Button variant="primary" disabled={!canCreate} onClick={() => void create()}>Create surface</Button>
        <Button variant="quiet" onClick={cancel}>{busy ? 'Cancel creation' : 'Cancel'}</Button>
      </footer>
    </section>
  );
}

function Rule({ label, unit, value, disabled, onChange }: { label: string; unit: string; value: number; disabled: boolean; onChange: (value: number | null) => void }): JSX.Element {
  return <label className={styles.rule}><span>{label}</span><NumberInput aria-label={label} value={value} min={0.001} max={100_000} step={0.1} precision={3} unit={unit} disabled={disabled} onValueChange={onChange} /></label>;
}

function fixLabel(value: 'drop' | 'snap' | 'split' | 'exclude'): string {
  return ({ drop: 'Drop item', snap: 'Snap to source', split: 'Split lines', exclude: 'Exclude source' })[value];
}
