import type { AlignmentQualityProfile } from '@himmelcad/data';
import { Select } from '@himmelcad/ui';
import { X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import {
  buildAlignmentPreset,
  defaultOverridesForProfile,
  parseAlignmentPreset,
  type AlignmentPresetOverrides,
} from './alignmentPreset.js';
import styles from './DefineAlignmentDialog.module.css';

const PROFILE_DESCRIPTION: Record<AlignmentQualityProfile, string> = {
  qualityHybrid: 'Independent neural and classical matching with quality-driven rescue.',
  maximumRobustness: 'Maximum pair coverage and feature budget, including DeDoDe.',
  fast: 'Fast matching with rescue only on diagnosed weak connections.',
};

/**
 * Floating task-island form for creating/editing `.hcalign` presets.
 * Not a chat wizard — plain fields, same island chrome as import panels.
 */
export function DefineAlignmentDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved?: (meta: { name: string; path: string }) => void;
}): JSX.Element {
  const titleId = useId();
  const [profile, setProfile] = useState<AlignmentQualityProfile>('fast');
  const [overrides, setOverrides] = useState<AlignmentPresetOverrides>(() =>
    defaultOverridesForProfile('fast'),
  );
  const [name, setName] = useState('My alignment');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const defaults = useMemo(() => defaultOverridesForProfile(profile), [profile]);
  const effective = {
    maxImageEdge: overrides.maxImageEdge ?? defaults.maxImageEdge,
    keypointsPerMegapixel: overrides.keypointsPerMegapixel ?? defaults.keypointsPerMegapixel,
    sequentialOverlap: overrides.sequentialOverlap ?? defaults.sequentialOverlap,
    featureBudget: overrides.featureBudget ?? defaults.featureBudget,
  };

  const setOverride = <K extends keyof AlignmentPresetOverrides>(
    key: K,
    value: number | undefined,
  ): void => {
    setOverrides((current) => ({ ...current, [key]: value }));
  };

  const changeProfile = (next: AlignmentQualityProfile): void => {
    setProfile(next);
    setOverrides(defaultOverridesForProfile(next));
  };

  const save = async (): Promise<void> => {
    const api = window.himmelcad;
    if (!api?.alignmentPresets) {
      setError('Desktop API not available');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const preset = buildAlignmentPreset({
        name,
        description,
        profile,
        overrides: effective,
      });
      const check = parseAlignmentPreset(preset);
      if (!check.ok) {
        setError(check.errors.join('\n'));
        return;
      }
      const result = await api.alignmentPresets.save({
        suggestedName: preset.name,
        preset,
      });
      if (!result) return;
      setInfo(`Saved ${result.path}`);
      onSaved?.({ name: result.name, path: result.path });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openForEdit = async (): Promise<void> => {
    const api = window.himmelcad;
    if (!api?.alignmentPresets) {
      setError('Desktop API not available');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.alignmentPresets.open();
      if (!result) return;
      const parsed = parseAlignmentPreset(result.preset);
      if (!parsed.ok) {
        setError(parsed.errors.join('\n'));
        return;
      }
      setProfile(parsed.preset.profile);
      setOverrides(parsed.preset.overrides);
      setName(parsed.preset.name);
      setDescription(parsed.preset.description);
      setInfo(`Loaded “${parsed.preset.name}”`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.root} role="dialog" aria-labelledby={titleId}>
      <header className={styles.header} data-task-drag-handle>
        <h2 id={titleId} className={styles.title}>
          Define Alignment
        </h2>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </header>

      <div className={styles.body}>
        <p className={styles.lead}>
          Named preset file (<code>.hcalign</code>). Align Photos only selects presets — knobs live
          here.
        </p>

        <label className={styles.field}>
          <span>Name</span>
          <input
            className={styles.control}
            type="text"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label className={styles.field}>
          <span>Description</span>
          <input
            className={styles.control}
            type="text"
            value={description}
            disabled={busy}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
        </label>
        <label className={styles.field}>
          <span>Quality profile</span>
          <Select
            className={styles.control}
            value={profile}
            disabled={busy}
            onChange={(event) =>
              changeProfile(event.currentTarget.value as AlignmentQualityProfile)
            }
          >
            <option value="qualityHybrid">Quality Hybrid · recommended</option>
            <option value="maximumRobustness">Maximum Robustness</option>
            <option value="fast">Fast · adaptive rescue</option>
          </Select>
        </label>
        <div className={styles.hint}>{PROFILE_DESCRIPTION[profile]}</div>

        <div className={styles.sectionTitle}>Parameters</div>
        <label className={styles.field}>
          <span>Max image edge (px)</span>
          <input
            className={styles.control}
            type="number"
            min={1024}
            max={32768}
            step={100}
            disabled={busy}
            value={effective.maxImageEdge}
            onChange={(event) =>
              setOverride(
                'maxImageEdge',
                Number.parseInt(event.currentTarget.value, 10) || undefined,
              )
            }
          />
        </label>
        <label className={styles.field}>
          <span>Keypoints / Mpx</span>
          <input
            className={styles.control}
            type="number"
            min={500}
            max={50000}
            step={100}
            disabled={busy}
            value={effective.keypointsPerMegapixel}
            onChange={(event) =>
              setOverride(
                'keypointsPerMegapixel',
                Number.parseInt(event.currentTarget.value, 10) || undefined,
              )
            }
          />
        </label>
        <label className={styles.field}>
          <span>Feature budget</span>
          <input
            className={styles.control}
            type="number"
            min={1024}
            max={64000}
            step={256}
            disabled={busy}
            value={effective.featureBudget}
            onChange={(event) =>
              setOverride(
                'featureBudget',
                Number.parseInt(event.currentTarget.value, 10) || undefined,
              )
            }
          />
        </label>
        <label className={styles.field}>
          <span>Sequential overlap</span>
          <input
            className={styles.control}
            type="number"
            min={2}
            max={128}
            step={1}
            disabled={busy || profile === 'maximumRobustness'}
            value={effective.sequentialOverlap}
            onChange={(event) =>
              setOverride(
                'sequentialOverlap',
                Number.parseInt(event.currentTarget.value, 10) || undefined,
              )
            }
          />
        </label>
        {profile === 'maximumRobustness' && (
          <div className={styles.hint}>
            Maximum Robustness uses exhaustive pairing; sequential overlap is ignored.
          </div>
        )}
        <button
          type="button"
          className={`${styles.button} ${styles.buttonGhost}`}
          disabled={busy}
          onClick={() => setOverrides(defaultOverridesForProfile(profile))}
        >
          Reset knobs to profile defaults
        </button>

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        {info && <div className={styles.hint}>{info}</div>}
      </div>

      <footer className={styles.footer}>
        <button
          type="button"
          className={styles.button}
          onClick={() => void openForEdit()}
          disabled={busy}
        >
          Open…
        </button>
        <button type="button" className={styles.button} onClick={onClose} disabled={busy}>
          Close
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          onClick={() => void save()}
          disabled={busy}
        >
          {busy ? 'Working…' : 'Save as…'}
        </button>
      </footer>
    </div>
  );
}
