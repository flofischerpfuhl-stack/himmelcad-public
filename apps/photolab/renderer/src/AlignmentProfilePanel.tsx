import type {
  CaptureGroupRecord,
  EntityId,
  ProcessingSetRecord,
  ResolvedAlignmentConfig,
} from '@himmelcad/data';
import { Select } from '@himmelcad/ui';
import { useCallback, useEffect, useState } from 'react';

import {
  DEFAULT_FACTORY_ALIGNMENT_PRESET,
  FACTORY_ALIGNMENT_PRESETS,
  factoryAlignmentPresetByPath,
  parseAlignmentPreset,
  type AlignmentPresetFile,
} from './alignmentPreset.js';
import styles from './AlignmentProfilePanel.module.css';

export interface AlignmentPresetListItem {
  name: string;
  path: string;
  savedAt: string;
  profile?: string;
  description?: string;
}

export interface AlignmentProfilePanelProps {
  imageCount: number;
  totalImageCount: number;
  selectedImageCount: number;
  scopeCameraIds: readonly EntityId[];
  scope: 'all' | 'selection';
  processingSets: readonly ProcessingSetRecord[];
  captureGroups: readonly CaptureGroupRecord[];
  activeProcessingSetId: EntityId | null;
  selectedPreset: AlignmentPresetFile | null;
  selectedPresetPath: string | null;
  resolving: boolean;
  starting: boolean;
  confirmingGroups: boolean;
  canStart: boolean;
  error: string | null;
  onScopeChange: (scope: 'all' | 'selection') => void;
  onProcessingSetChange: (processingSetId: EntityId) => void;
  onPresetSelected: (preset: AlignmentPresetFile, path: string) => void;
  onPresetCleared: () => void;
  onStart: () => void;
  onConfirmPendingGroups: (captureGroupIds: EntityId[]) => void;
  onDefineAlignment: () => void;
}

export function AlignmentProfilePanel({
  imageCount,
  totalImageCount,
  selectedImageCount,
  scopeCameraIds,
  scope,
  processingSets,
  captureGroups,
  activeProcessingSetId,
  selectedPreset,
  selectedPresetPath,
  resolving,
  starting,
  confirmingGroups,
  canStart,
  error,
  onScopeChange,
  onProcessingSetChange,
  onPresetSelected,
  onPresetCleared,
  onStart,
  onConfirmPendingGroups,
  onDefineAlignment,
}: AlignmentProfilePanelProps): JSX.Element {
  const [userPresets, setUserPresets] = useState<AlignmentPresetListItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loadBusy, setLoadBusy] = useState(false);

  const refreshList = useCallback(async (): Promise<void> => {
    const api = window.himmelcad;
    if (!api?.alignmentPresets) return;
    try {
      setUserPresets(await api.alignmentPresets.list());
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setUserPresets([]);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (selectedPreset && selectedPresetPath) return;
    onPresetSelected(
      DEFAULT_FACTORY_ALIGNMENT_PRESET.preset,
      DEFAULT_FACTORY_ALIGNMENT_PRESET.path,
    );
  }, [onPresetSelected, selectedPreset, selectedPresetPath]);

  const applyRaw = (raw: unknown, path: string): void => {
    const parsed = parseAlignmentPreset(raw);
    if (!parsed.ok) {
      setListError(parsed.errors.join('\n'));
      onPresetCleared();
      return;
    }
    setListError(null);
    onPresetSelected(parsed.preset, path);
  };

  const selectFromList = async (path: string): Promise<void> => {
    if (!path) {
      onPresetCleared();
      return;
    }
    const factory = factoryAlignmentPresetByPath(path);
    if (factory) {
      setListError(null);
      onPresetSelected(factory.preset, factory.path);
      return;
    }
    const api = window.himmelcad;
    if (!api?.alignmentPresets) return;
    setLoadBusy(true);
    setListError(null);
    try {
      const result = await api.alignmentPresets.loadPath(path);
      applyRaw(result.preset, result.path);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      onPresetCleared();
    } finally {
      setLoadBusy(false);
    }
  };

  const openFile = async (): Promise<void> => {
    const api = window.himmelcad;
    if (!api?.alignmentPresets) return;
    setLoadBusy(true);
    setListError(null);
    try {
      const result = await api.alignmentPresets.open();
      if (!result) return;
      applyRaw(result.preset, result.path);
      await refreshList();
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadBusy(false);
    }
  };

  const scopeCameraSet = new Set(scopeCameraIds);
  const pendingGroups = captureGroups.filter(
    (group) =>
      group.reviewStatus === 'needsReview' &&
      group.cameraEntityIds.some((entityId) => scopeCameraSet.has(entityId)),
  );
  const hasPreset = selectedPreset != null && selectedPresetPath != null;
  const busy = loadBusy || confirmingGroups || resolving || starting;
  const selectedFactory = selectedPresetPath
    ? factoryAlignmentPresetByPath(selectedPresetPath)
    : undefined;
  const startDisabledReason = starting
    ? 'Alignment is being queued.'
    : resolving
      ? 'Alignment settings are being validated.'
      : loadBusy
        ? 'The alignment preset is loading.'
        : confirmingGroups
          ? 'Capture groups are being confirmed.'
          : !hasPreset
            ? 'Select an alignment preset before starting.'
            : pendingGroups.length > 0
              ? 'Confirm the detected camera groups before starting alignment.'
              : !canStart
                ? imageCount < 2
                  ? 'Import at least two images before starting alignment.'
                  : 'Wait until the project is ready before starting alignment.'
                : null;

  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Align Photos</div>

        <label className={styles.field}>
          <span>Scope</span>
          <Select
            className={styles.control}
            value={
              scope === 'selection' && activeProcessingSetId
                ? encodeProcessingSetValue(activeProcessingSetId)
                : scope
            }
            onChange={(event) => {
              const value = event.currentTarget.value;
              const processingSetId = decodeProcessingSetValue(value);
              if (processingSetId) onProcessingSetChange(processingSetId);
              else onScopeChange(value as 'all' | 'selection');
            }}
          >
            <option value="all">All images · {totalImageCount}</option>
            <option value="selection" disabled={selectedImageCount < 2}>
              Selection · {selectedImageCount}
            </option>
            {processingSets.length > 0 && (
              <optgroup label="Processing sets">
                {processingSets.map((processingSet) => (
                  <option
                    key={processingSet.entityId}
                    value={encodeProcessingSetValue(processingSet.entityId)}
                  >
                    {processingSet.name} · {processingSet.cameraEntityIds.length}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </label>

        <label className={styles.field}>
          <span>Preset</span>
          <Select
            className={styles.control}
            value={selectedPresetPath ?? ''}
            disabled={loadBusy}
            onChange={(event) => void selectFromList(event.currentTarget.value)}
          >
            <option value="" disabled>
              Select…
            </option>
            <optgroup label="Built-in presets">
              {FACTORY_ALIGNMENT_PRESETS.map((item) => (
                <option key={item.path} value={item.path}>
                  {item.preset.name} · Built-in
                </option>
              ))}
            </optgroup>
            {userPresets.length > 0 && (
              <optgroup label="User presets">
                {userPresets.map((item) => (
                  <option key={item.path} value={item.path}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </label>

        <div className={styles.links}>
          <button
            type="button"
            className={styles.link}
            disabled={loadBusy}
            onClick={() => void openFile()}
          >
            Open file…
          </button>
          <button
            type="button"
            className={styles.link}
            disabled={loadBusy}
            onClick={() => void refreshList()}
          >
            Refresh
          </button>
          <button type="button" className={styles.link} onClick={onDefineAlignment}>
            Define Alignment…
          </button>
        </div>

        {hasPreset && selectedPreset && (
          <div className={styles.meta}>
            <span>
              {profileLabel(selectedPreset.profile)} · {imageCount} images
            </span>
            {selectedFactory && <span className={styles.badge}>Built-in</span>}
          </div>
        )}
      </section>

      {pendingGroups.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionTitle}>Camera groups</div>
          <div className={styles.meta}>
            {pendingGroups.length === 1
              ? '1 detected mission not confirmed yet'
              : `${pendingGroups.length} detected missions not confirmed yet`}
          </div>
          <button
            type="button"
            className={styles.action}
            disabled={busy}
            onClick={() => onConfirmPendingGroups(pendingGroups.map((g) => g.entityId))}
          >
            {confirmingGroups ? 'Confirming…' : 'Confirm grouping'}
          </button>
        </section>
      )}

      {(error || listError) && (
        <div className={styles.error} role="alert">
          {error ?? listError}
        </div>
      )}

      {startDisabledReason && <div className={styles.disabledReason}>{startDisabledReason}</div>}

      <button
        type="button"
        className={styles.actionPrimary}
        disabled={
          !canStart ||
          !hasPreset ||
          pendingGroups.length > 0 ||
          confirmingGroups ||
          resolving ||
          starting ||
          loadBusy
        }
        onClick={onStart}
      >
        {starting ? 'Starting…' : resolving ? 'Validating…' : 'Start alignment'}
      </button>
    </div>
  );
}

const PROCESSING_SET_PREFIX = 'processing-set:';

function encodeProcessingSetValue(entityId: EntityId): string {
  return `${PROCESSING_SET_PREFIX}${entityId}`;
}

function decodeProcessingSetValue(value: string): EntityId | null {
  return value.startsWith(PROCESSING_SET_PREFIX)
    ? (value.slice(PROCESSING_SET_PREFIX.length) as EntityId)
    : null;
}

function profileLabel(profile: AlignmentPresetFile['profile']): string {
  if (profile === 'qualityHybrid') return 'Quality Hybrid';
  if (profile === 'maximumRobustness') return 'Maximum Robustness';
  return 'Fast';
}

// Keep type import used for props compatibility when parent still types resolved.
export type { ResolvedAlignmentConfig };
