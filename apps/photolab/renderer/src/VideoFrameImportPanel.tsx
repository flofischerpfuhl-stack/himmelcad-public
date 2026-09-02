import type { CaptureCapabilityInventory } from '@himmelcad/data';
import { AlertTriangle, Check, Film, LoaderCircle, X } from 'lucide-react';

import { validateVideoFramePlan, type VideoFramePlanDraft } from './videoFramePlan.js';
import styles from './VideoFrameImportPanel.module.css';

export interface VideoFrameImportProgress {
  fraction: number;
  message: string;
}

export function VideoFrameImportPanel({
  sourcePath,
  capabilities,
  capabilitiesBusy,
  draft,
  busy,
  cancelling,
  progress,
  error,
  onDraftChange,
  onChooseVideo,
  onPrepare,
  onCancel,
  onClose,
}: {
  sourcePath: string | null;
  capabilities: CaptureCapabilityInventory | null;
  capabilitiesBusy: boolean;
  draft: VideoFramePlanDraft;
  busy: boolean;
  cancelling: boolean;
  progress: VideoFrameImportProgress | null;
  error: string | null;
  onDraftChange: (draft: VideoFramePlanDraft) => void;
  onChooseVideo: () => void;
  onPrepare: () => void;
  onCancel: () => void;
  onClose: () => void;
}): JSX.Element {
  const validation = validateVideoFramePlan(draft);
  const ffmpegAvailable = capabilities?.ffmpeg.available === true;
  const ffprobeAvailable = capabilities?.ffprobe.available === true;
  const runtimeAvailable = ffmpegAvailable && ffprobeAvailable;
  const percentage = Math.round(Math.max(0, Math.min(1, progress?.fraction ?? 0)) * 100);

  return (
    <section
      className={styles.panel}
      role="dialog"
      aria-labelledby="video-frame-import-title"
      aria-busy={busy || capabilitiesBusy}
    >
      <header data-task-drag-handle>
        <div>
          <span>Video import</span>
          <h2 id="video-frame-import-title">Video frames</h2>
        </div>
        <button type="button" aria-label="Close video import" onClick={onClose}>
          <X size={15} />
        </button>
      </header>

      <div className={styles.content}>
        <div className={styles.sourceRow}>
          <Film size={18} />
          <div>
            <strong>{sourcePath ? fileName(sourcePath) : 'Choose a video capture'}</strong>
            <small title={sourcePath ?? undefined}>
              {sourcePath ?? 'MP4, MOV, M4V, MKV, AVI or WebM'}
            </small>
          </div>
          <button type="button" disabled={busy || capabilitiesBusy} onClick={onChooseVideo}>
            {sourcePath ? 'Choose another' : 'Choose video'}
          </button>
        </div>

        {capabilitiesBusy && (
          <div className={styles.status} role="status">
            <LoaderCircle className={styles.spinner} size={17} />
            <span>Checking the bundled video runtime…</span>
          </div>
        )}

        {sourcePath && capabilities && (
          <div className={styles.runtime}>
            <div className={ffmpegAvailable ? styles.available : styles.unavailable}>
              {ffmpegAvailable ? <Check size={15} /> : <AlertTriangle size={15} />}
              <span>
                <strong>FFmpeg</strong>
                <small>{toolDetail(capabilities.ffmpeg)}</small>
              </span>
            </div>
            <div className={ffprobeAvailable ? styles.available : styles.unavailable}>
              {ffprobeAvailable ? <Check size={15} /> : <AlertTriangle size={15} />}
              <span>
                <strong>FFprobe</strong>
                <small>{toolDetail(capabilities.ffprobe)}</small>
              </span>
            </div>
          </div>
        )}

        {sourcePath && capabilities && !ffmpegAvailable && (
          <div className={styles.emptyState} role="status">
            <AlertTriangle size={24} />
            <strong>
              Video import needs the bundled ffmpeg runtime — not available in this build
            </strong>
            <small>
              No video data was changed. Choose images instead or use a build with FFmpeg.
            </small>
          </div>
        )}

        {sourcePath && capabilities && ffmpegAvailable && !ffprobeAvailable && (
          <div className={styles.emptyState} role="status">
            <AlertTriangle size={24} />
            <strong>Video import needs FFprobe — not available in this build</strong>
            <small>The video cannot be inspected safely without its stream metadata.</small>
          </div>
        )}

        {sourcePath && capabilities && runtimeAvailable && (
          <div className={styles.parameters}>
            <h3>Frame selection</h3>
            <div className={styles.fields}>
              <ParameterField
                label="Frame interval"
                unit="seconds"
                value={draft.intervalSeconds}
                min="0.001"
                max="3600"
                step="0.05"
                disabled={busy}
                error={validation.valid ? undefined : validation.errors.intervalSeconds}
                onChange={(intervalSeconds) => onDraftChange({ ...draft, intervalSeconds })}
              />
              <ParameterField
                label="Maximum frames"
                value={draft.maximumFrames}
                min="1"
                max="10000"
                step="1"
                disabled={busy}
                error={validation.valid ? undefined : validation.errors.maximumFrames}
                onChange={(maximumFrames) => onDraftChange({ ...draft, maximumFrames })}
              />
              <ParameterField
                label="Sharpness gate"
                value={draft.minimumSharpness}
                min="0"
                max="1"
                step="0.01"
                disabled={busy}
                error={validation.valid ? undefined : validation.errors.minimumSharpness}
                onChange={(minimumSharpness) => onDraftChange({ ...draft, minimumSharpness })}
              />
            </div>
            <p className={styles.summary}>
              {validation.valid
                ? validation.value.summary
                : 'Correct the highlighted values to preview the frame plan.'}
            </p>
            <small className={styles.policyNote}>
              Frames smaller than 640 × 480 and frames outside the built-in motion and overlap gates
              are excluded.
            </small>
          </div>
        )}

        {busy && (
          <div className={styles.progressBlock} role="status">
            <div>
              <LoaderCircle className={styles.spinner} size={17} />
              <strong>{progress?.message ?? 'Preparing video frames…'}</strong>
              <b>{percentage}%</b>
            </div>
            <div
              className={styles.progress}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percentage}
            >
              <span style={{ width: `${percentage}%` }} />
            </div>
            <small>
              Extraction is staged. Cancelling does not import partial frames into the project.
            </small>
          </div>
        )}

        {error && (
          <div className={styles.error} role="alert">
            <AlertTriangle size={16} />
            <span>
              <strong>Video frames could not be prepared</strong>
              <small>{error}</small>
            </span>
          </div>
        )}
      </div>

      <footer>
        {busy ? (
          <button type="button" disabled={cancelling} onClick={onCancel}>
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : (
          <>
            <button type="button" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={!sourcePath || !runtimeAvailable || !validation.valid}
              onClick={onPrepare}
            >
              Extract frames
            </button>
          </>
        )}
      </footer>
    </section>
  );
}

function ParameterField({
  label,
  unit,
  value,
  min,
  max,
  step,
  disabled,
  error,
  onChange,
}: {
  label: string;
  unit?: string;
  value: string;
  min: string;
  max: string;
  step: string;
  disabled: boolean;
  error?: string | undefined;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className={styles.field}>
      <span>
        {label}
        {unit ? <small>{unit}</small> : null}
      </span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-invalid={error != null}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? <em>{error}</em> : null}
    </label>
  );
}

function toolDetail(tool: CaptureCapabilityInventory['ffmpeg']): string {
  if (!tool.available) return 'Not available';
  return tool.version?.trim() || tool.executable || 'Available';
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}
