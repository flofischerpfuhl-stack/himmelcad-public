/**
 * Printability panel (Print mode, `P`): analysis status with progress and
 * Cancel, per-body checks (B-rep validity, watertight mesh, size vs build
 * volume, volume/mass/cost), the findings list (click = select and frame),
 * the overlay legend, build-plate tools (Place on Plate, Auto Orient with
 * the top three candidates previewed as ghosts) and the thresholds.
 */
import {
  Check as CheckIcon,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  EyeOff,
  Info,
  ListX,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button, Checkbox, ProgressBar, Select, Tooltip } from '@himmelcad/ui';

import { ExpressionField } from '../../../platform/widgets/ExpressionField.js';
import { findCommand } from '../../../foundation/commands/registry.js';
import { useAssemblerStore } from '../../../foundation/commands/store.js';
import { usePreferences } from '../../../platform/input/preferences.js';
import {
  FINDING_KIND_LABELS,
  type FindingKind,
  type FindingSeverity,
  type PrintFinding,
} from '../analysis.js';
import {
  BUILD_VOLUME_COLOR,
  CLEARANCE_COLOR,
  OVERHANG_COLOR_HIGH,
  OVERHANG_COLOR_LOW,
  ORIENT_PREVIEW_COLOR,
  OVERLAP_COLOR,
  THIN_WALL_COLOR,
  rgbCss,
} from '../overlay.js';
import { reportStale, usePrintStore, visibleFindings } from '../printStore.js';
import {
  BUILD_VOLUME_PRESETS,
  MATERIAL_PRESETS,
  buildVolumeSize,
  type BuildVolumeId,
  type MaterialId,
} from '../settings.js';
import styles from './PrintPanel.module.css';

const MAX_LISTED = 60;

function fmt(value: number, digits = 1): string {
  return Number(value.toFixed(digits)).toLocaleString('en-US');
}

function SeverityIcon({ severity }: { severity: FindingSeverity }): JSX.Element {
  if (severity === 'error')
    return <CircleAlert size={13} className={`${styles.findingIcon} ${styles.bad}`} />;
  if (severity === 'warning') {
    return <TriangleAlert size={13} className={`${styles.findingIcon} ${styles.warn}`} />;
  }
  return <Info size={13} className={styles.findingIcon} />;
}

function Check({ ok, label, title }: { ok: boolean; label: string; title: string }): JSX.Element {
  return (
    <Tooltip content={title}>
      <span className={`${styles.check} ${ok ? styles.ok : styles.bad}`}>
        {ok ? '✓' : '✕'} {label}
      </span>
    </Tooltip>
  );
}

function FindingRow({
  finding,
  focused,
}: {
  finding: PrintFinding;
  focused: boolean;
}): JSX.Element {
  const print = usePrintStore.getState();
  // An overlap is often intended (bodies that will be combined): say so in the action.
  const ignoreLabel = finding.kind === 'overlap' ? 'Mark as intended' : 'Ignore here';
  const typeLabel = FINDING_KIND_LABELS[finding.kind];
  return (
    <div className={styles.findingRow}>
      <button
        type="button"
        className={`${styles.finding} ${focused ? styles.findingFocused : ''}`}
        aria-pressed={focused}
        onClick={() => print.focusFinding(finding)}
      >
        <SeverityIcon severity={finding.severity} />
        <span className={styles.findingText}>
          <span>{finding.message}</span>
          <span className={styles.findingBody}>
            {finding.otherBodyName
              ? `${finding.bodyName} ↔ ${finding.otherBodyName}`
              : finding.bodyName}
          </span>
        </span>
      </button>
      <span className={styles.findingActions}>
        <Tooltip content={`${ignoreLabel}: not listed in this document any more`}>
          <button
            type="button"
            className={styles.findingAction}
            aria-label={`${ignoreLabel}: ${finding.message}`}
            onClick={() => {
              print.ignoreFinding(finding.id);
              if (focused) print.focusFinding(null);
            }}
          >
            {finding.kind === 'overlap' ? <CheckIcon size={12} /> : <EyeOff size={12} />}
          </button>
        </Tooltip>
        <Tooltip content={`Don’t show “${typeLabel}” findings (undo in Settings or below)`}>
          <button
            type="button"
            className={styles.findingAction}
            aria-label={`Don’t show ${typeLabel} findings`}
            onClick={() => print.hideFindingKind(finding.kind)}
          >
            <ListX size={12} />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}

/** What the list leaves out: findings ignored here and finding types the user hid. */
function SuppressedFindings({
  findings,
  ignored,
  hidden,
}: {
  findings: readonly PrintFinding[];
  ignored: readonly string[];
  hidden: readonly string[];
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const print = usePrintStore.getState();
  const ignoredHere = findings.filter((f) => ignored.includes(f.id));
  if (ignored.length === 0 && hidden.length === 0) return null;
  return (
    <div className={styles.suppressed}>
      {ignored.length > 0 ? (
        <div className={styles.suppressedRow}>
          <span className={styles.suppressedText}>
            {ignored.length} ignored in this document
            {ignoredHere.length < ignored.length
              ? ` (${ignored.length - ignoredHere.length} not present now)`
              : ''}
          </span>
          <button type="button" className={styles.linkButton} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => print.restoreAllFindings()}
          >
            Restore all
          </button>
        </div>
      ) : null}
      {open
        ? ignoredHere.map((f) => (
            <div key={f.id} className={styles.suppressedRow}>
              <span className={styles.suppressedText} title={f.message}>
                {f.message}
              </span>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => print.restoreFinding(f.id)}
              >
                Restore
              </button>
            </div>
          ))
        : null}
      {hidden.map((kind) => (
        <div key={kind} className={styles.suppressedRow}>
          <span className={styles.suppressedText}>
            {FINDING_KIND_LABELS[kind as FindingKind] ?? kind} hidden (all documents)
          </span>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => print.showFindingKind(kind as FindingKind)}
          >
            Show again
          </button>
        </div>
      ))}
    </div>
  );
}

function OrientSection(): JSX.Element | null {
  const orient = usePrintStore((s) => s.orient);
  const bodies = useAssemblerStore((s) => s.evaluation.bodies);
  if (!orient) return null;
  const body = bodies.find((b) => b.id === orient.bodyId);
  const print = usePrintStore.getState();
  return (
    <section aria-label="Auto orient">
      <div className={styles.progressRow}>
        <span className={styles.sectionTitle}>Auto orient · {body?.name ?? orient.bodyId}</span>
        <span className={styles.spacer} />
        <Tooltip content="Close">
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Close auto orient"
            onClick={() => print.closeOrient()}
          >
            <X size={13} />
          </button>
        </Tooltip>
      </div>
      {orient.status === 'running' ? (
        <ProgressBar
          value={0}
          indeterminate
          ariaLabel="Ranking orientations"
          indeterminateLabel="Ranking…"
        />
      ) : orient.status === 'error' ? (
        <div className={`${styles.hint} ${styles.bad}`}>{orient.error}</div>
      ) : (
        <div className={styles.candidates} role="listbox" aria-label="Orientation candidates">
          {orient.candidates.map((c, i) => (
            <div key={c.label} className={styles.progressRow}>
              <button
                type="button"
                role="option"
                aria-selected={orient.preview === i}
                className={`${styles.candidate} ${orient.preview === i ? styles.candidateActive : ''}`}
                style={{ flex: 1, minWidth: 0 }}
                onClick={() => print.previewOrientation(orient.preview === i ? null : i)}
                onDoubleClick={() => print.applyOrientation(i)}
              >
                <span className={styles.rank}>{c.rank}</span>
                <span className={styles.candidateText}>
                  <span className={styles.candidateLabel}>{c.label}</span>
                  <span className={styles.candidateMetrics}>
                    overhang {fmt(c.overhangAreaMm2, 0)} mm² · height {fmt(c.heightMm)} mm
                  </span>
                </span>
              </button>
              <Button
                size="small"
                variant={i === 0 ? 'primary' : 'secondary'}
                onClick={() => print.applyOrientation(i)}
              >
                Apply
              </Button>
            </div>
          ))}
          <div className={styles.hint}>
            Ranked by overhang area, then height. The green ghost previews the selected candidate;
            Apply adds one “Orient for Print” step to History.
          </div>
        </div>
      )}
    </section>
  );
}

function SettingsSection(): JSX.Element {
  const settings = usePrintStore((s) => s.settings);
  const update = usePrintStore((s) => s.updateSettings);
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Print settings">
      <button
        type="button"
        className={styles.sectionToggle}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Thresholds, material and printer
      </button>
      {open ? (
        <div className={styles.settings}>
          <div className={styles.wide}>
            <div className={styles.volumeInputs} style={{ gridTemplateColumns: '1fr 1fr' }}>
              <ExpressionField
                label="Overhang angle"
                value={settings.overhangAngleDeg}
                unit="°"
                precision={1}
                onCommit={(v) => update({ overhangAngleDeg: v })}
              />
              <ExpressionField
                label="Min. wall"
                value={settings.minWallMm}
                unit="mm"
                precision={2}
                onCommit={(v) => update({ minWallMm: v })}
              />
              <ExpressionField
                label="Min. hole Ø"
                value={settings.minHoleMm}
                unit="mm"
                precision={2}
                onCommit={(v) => update({ minHoleMm: v })}
              />
              <ExpressionField
                label="Min. pin Ø"
                value={settings.minPinMm}
                unit="mm"
                precision={2}
                onCommit={(v) => update({ minPinMm: v })}
              />
              <ExpressionField
                label="Min. clearance"
                value={settings.minClearanceMm}
                unit="mm"
                precision={2}
                onCommit={(v) => update({ minClearanceMm: Math.max(0, v) })}
              />
            </div>
          </div>
          <span className={styles.settingLabel}>Material</span>
          <Select
            aria-label="Material"
            value={settings.material}
            options={[
              ...MATERIAL_PRESETS.map((m) => ({
                value: m.id,
                label: `${m.label} (${m.density} g/cm³)`,
              })),
              { value: 'custom', label: 'Custom' },
            ]}
            onChange={(e) =>
              usePrintStore.getState().setMaterial(e.currentTarget.value as MaterialId)
            }
          />
          <div className={styles.wide}>
            <div className={styles.volumeInputs}>
              <ExpressionField
                label="Density"
                value={settings.density}
                unit="g/cm³"
                precision={3}
                onCommit={(v) => update({ density: v, material: 'custom' })}
              />
              <ExpressionField
                label={`Price per kg`}
                value={settings.costPerKg}
                unit={settings.currency}
                precision={2}
                onCommit={(v) => update({ costPerKg: v })}
              />
              <label
                className={styles.settingLabel}
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                Currency
                <Select
                  aria-label="Currency"
                  value={settings.currency}
                  options={['EUR', 'USD', 'GBP', 'CHF'].map((c) => ({ value: c, label: c }))}
                  onChange={(e) => update({ currency: e.currentTarget.value })}
                />
              </label>
            </div>
          </div>
          <span className={styles.settingLabel}>Printer</span>
          <Select
            aria-label="Printer build volume"
            value={settings.buildVolume}
            options={[
              { value: 'none', label: 'None' },
              ...BUILD_VOLUME_PRESETS.map((p) => ({
                value: p.id,
                label: `${p.label} ${p.size.join('×')}`,
              })),
              { value: 'custom', label: 'Custom…' },
            ]}
            onChange={(e) => update({ buildVolume: e.currentTarget.value as BuildVolumeId })}
          />
          {settings.buildVolume === 'custom' ? (
            <div className={`${styles.wide} ${styles.volumeInputs}`}>
              {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                <ExpressionField
                  key={axis}
                  label={`Volume ${axis}`}
                  value={settings.customVolume[i]!}
                  unit="mm"
                  precision={1}
                  onCommit={(v) => {
                    const next = [...settings.customVolume] as [number, number, number];
                    next[i] = v;
                    update({ customVolume: next });
                  }}
                />
              ))}
            </div>
          ) : null}
          <div className={`${styles.wide} ${styles.checks}`}>
            <Checkbox
              label="Show overhangs"
              checked={settings.showOverhangs}
              onChange={(e) => update({ showOverhangs: e.currentTarget.checked })}
            />
            <Checkbox
              label="Show thin walls"
              checked={settings.showThinWalls}
              onChange={(e) => update({ showThinWalls: e.currentTarget.checked })}
            />
            <Checkbox
              label="Show build volume"
              checked={settings.showBuildVolume}
              onChange={(e) => update({ showBuildVolume: e.currentTarget.checked })}
            />
            <Checkbox
              label="Check clearance between bodies"
              checked={settings.checkClearance}
              onChange={(e) => update({ checkClearance: e.currentTarget.checked })}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function PrintPanel(): JSX.Element | null {
  const print = usePrintStore();
  const itemsOpen = useAssemblerStore((s) => s.panels.items);
  const doc = useAssemblerStore();
  const [showAll, setShowAll] = useState(false);
  const hiddenKinds = usePreferences((s) => s.hiddenPrintFindings);
  useEffect(() => setShowAll(false), [print.report]);
  if (!print.enabled) return null;
  const report = print.report;
  const stale = reportStale(print);
  const running = print.status === 'running' || print.status === 'scheduled';
  const statusText =
    print.status === 'running'
      ? 'Analysing…'
      : print.status === 'scheduled'
        ? 'Waiting for the model…'
        : print.status === 'error'
          ? 'Analysis failed'
          : print.status === 'cancelled'
            ? 'Cancelled'
            : stale
              ? 'Out of date'
              : report
                ? `Up to date · ${report.ms} ms`
                : '';
  const allFindings = report?.findings ?? [];
  const findings = visibleFindings(allFindings, print.ignored, hiddenKinds);
  const listed = showAll ? findings : findings.slice(0, MAX_LISTED);
  const settings = print.settings;
  const volume = buildVolumeSize(settings);
  const placeCmd = findCommand('print.placeOnPlate');
  const orientCmd = findCommand('print.autoOrient');
  const placeAvailability = placeCmd?.availability(doc);
  const orientAvailability = orientCmd?.availability(doc);

  return (
    <div
      className={`${styles.root} ${itemsOpen ? styles.besideItems : styles.besideDock}`}
      role="region"
      aria-label="Printability"
    >
      <div className={styles.header}>
        <span className={styles.title}>Printability</span>
        <span className={styles.status} aria-live="polite">
          {statusText}
        </span>
        <span className={styles.spacer} />
        <Tooltip content="Analyse again">
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Analyse again"
            disabled={running}
            onClick={() => print.analyzeNow()}
          >
            <RefreshCw size={13} />
          </button>
        </Tooltip>
        <Tooltip content="Close Printability (P)">
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Close Printability"
            onClick={() => print.setEnabled(false)}
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>
      <div className={styles.body}>
        {print.status === 'running' && print.progress ? (
          <div className={styles.progress}>
            <div className={styles.progressRow}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <ProgressBar value={print.progress.fraction} ariaLabel="Printability analysis" />
              </div>
              <Button size="small" variant="quiet" onClick={() => print.cancelAnalysis()}>
                Cancel
              </Button>
            </div>
            <span className={styles.progressLabel}>{print.progress.label}</span>
          </div>
        ) : null}
        {print.status === 'error' ? (
          <div className={`${styles.hint} ${styles.bad}`}>{print.error}</div>
        ) : null}

        {report ? (
          <section aria-label="Summary">
            <div className={styles.metrics}>
              <div className={styles.metric}>
                <span className={styles.metricValue}>
                  {fmt(report.totals.volumeMm3 / 1000, 2)} cm³
                </span>
                <span className={styles.metricLabel}>
                  {report.totals.bodies} {report.totals.bodies === 1 ? 'body' : 'bodies'}
                </span>
              </div>
              <div className={styles.metric}>
                <span className={styles.metricValue}>{fmt(report.totals.massG)} g</span>
                <span className={styles.metricLabel}>
                  {settings.material === 'custom' ? 'Custom' : settings.material}, solid
                </span>
              </div>
              <div className={styles.metric}>
                <span className={styles.metricValue}>
                  {report.totals.cost.toFixed(2)} {settings.currency}
                </span>
                <span className={styles.metricLabel}>at {settings.costPerKg.toFixed(2)}/kg</span>
              </div>
            </div>
            {report.bodies.map((b) => (
              <div key={b.bodyId} className={styles.bodyRow}>
                <span className={styles.bodyName} title={b.name}>
                  {b.name}
                </span>
                <Check
                  ok={b.brepValid}
                  label="B-rep"
                  title={b.brepValid ? 'B-rep valid (BRepCheck)' : 'B-rep check failed'}
                />
                <Check
                  ok={b.watertight}
                  label="Closed"
                  title={
                    b.watertight
                      ? 'Watertight, manifold mesh'
                      : `${b.boundaryEdges} open, ${b.nonManifoldEdges} non-manifold, ${b.inconsistentEdges} flipped edges`
                  }
                />
                {b.buildVolume ? (
                  <Check
                    ok={b.buildVolume.fits}
                    label="Fits"
                    title={`${b.size.map((v) => fmt(v)).join(' × ')} mm in ${b.buildVolume.size.join(' × ')} mm`}
                  />
                ) : null}
              </div>
            ))}
          </section>
        ) : null}

        <OrientSection />

        <section aria-label="Build plate">
          <div className={styles.sectionTitle}>Build plate</div>
          <div className={styles.actions}>
            <Tooltip
              content={placeAvailability?.reason ?? 'Lay the selected flat face on the plate'}
            >
              <Button
                size="small"
                disabled={!placeAvailability?.enabled}
                onClick={() => placeCmd?.run(useAssemblerStore.getState())}
              >
                Place on Plate
              </Button>
            </Tooltip>
            <Tooltip
              content={orientAvailability?.reason ?? 'Rank orientations of the selected body'}
            >
              <Button
                size="small"
                disabled={!orientAvailability?.enabled}
                onClick={() => orientCmd?.run(useAssemblerStore.getState())}
              >
                Auto Orient
              </Button>
            </Tooltip>
            <Button
              size="small"
              onClick={() => findCommand('file.openInSlicer')?.run(useAssemblerStore.getState())}
            >
              Open in Slicer
            </Button>
            <Button size="small" onClick={() => print.setStlDialogOpen(true)}>
              Export STL…
            </Button>
          </div>
        </section>

        <section aria-label="Findings">
          <div className={styles.sectionTitle}>Findings{report ? ` (${findings.length})` : ''}</div>
          {report && findings.length === 0 ? (
            <div className={styles.empty}>
              {allFindings.length === 0
                ? 'No issues found at the current thresholds.'
                : 'Nothing left to show: the remaining findings are ignored or hidden.'}
            </div>
          ) : null}
          <div className={styles.findings}>
            {listed.map((f) => (
              <FindingRow key={f.id} finding={f} focused={print.focusedFindingId === f.id} />
            ))}
            {findings.length > listed.length ? (
              <button type="button" className={styles.finding} onClick={() => setShowAll(true)}>
                <span className={styles.more}>Show {findings.length - listed.length} more</span>
              </button>
            ) : null}
          </div>
          <SuppressedFindings findings={allFindings} ignored={print.ignored} hidden={hiddenKinds} />
        </section>

        <section aria-label="Legend">
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span
                className={styles.swatch}
                style={{
                  background: `linear-gradient(90deg, ${rgbCss(OVERHANG_COLOR_LOW)}, ${rgbCss(OVERHANG_COLOR_HIGH)})`,
                }}
              />
              Overhang {fmt(settings.overhangAngleDeg, 0)}°→90°
            </span>
            <span className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: rgbCss(THIN_WALL_COLOR) }} />
              Wall &lt; {fmt(settings.minWallMm, 2)} mm
            </span>
            {settings.checkClearance ? (
              <>
                <span className={styles.legendItem}>
                  <span className={styles.swatch} style={{ background: rgbCss(CLEARANCE_COLOR) }} />
                  Gap &lt; {fmt(settings.minClearanceMm, 2)} mm
                </span>
                <span className={styles.legendItem}>
                  <span className={styles.swatch} style={{ background: rgbCss(OVERLAP_COLOR) }} />
                  Overlap
                </span>
              </>
            ) : null}
            {volume ? (
              <span className={styles.legendItem}>
                <span
                  className={styles.swatch}
                  style={{ background: rgbCss(BUILD_VOLUME_COLOR), opacity: 0.5 }}
                />
                Build volume {volume.join('×')}
              </span>
            ) : null}
            {print.orient ? (
              <span className={styles.legendItem}>
                <span
                  className={styles.swatch}
                  style={{ background: rgbCss(ORIENT_PREVIEW_COLOR), opacity: 0.6 }}
                />
                Orientation preview
              </span>
            ) : null}
          </div>
          <div className={styles.hint} style={{ marginTop: 6 }}>
            Build direction +Z. Walls are measured by rays from sample points along the inward
            normal (
            {report
              ? report.bodies.reduce((s, b) => s + b.thinWall.samples, 0).toLocaleString('en-US')
              : '—'}{' '}
            samples); thin features between samples can be missed. Mass assumes a solid part.
          </div>
        </section>

        <SettingsSection />
      </div>
    </div>
  );
}

/** Instruction chip while "Place on plate" waits for a face click. */
export function PlacePickHint(): JSX.Element | null {
  const picking = usePrintStore((s) => s.placePicking);
  const name = useAssemblerStore(
    (s) => s.evaluation.bodies.find((b) => b.id === picking)?.name ?? null,
  );
  if (!picking) return null;
  return (
    <div className={styles.pickHint} role="status">
      Click the flat face of {name ?? 'the body'} that should lie on the plate
      <Button
        size="small"
        variant="quiet"
        onClick={() => usePrintStore.getState().cancelPlacePicking()}
      >
        Cancel
      </Button>
    </div>
  );
}
