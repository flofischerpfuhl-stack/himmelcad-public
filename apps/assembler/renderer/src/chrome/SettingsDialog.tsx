/**
 * Settings (View › Settings…, Ctrl+,): user preferences stored per user, not
 * in the document (`model/preferences.ts`). Every change applies at once.
 */
import { Button, Checkbox, Dialog, Select, Slider } from '@himmelcad/ui';

import {
  usePreferences,
  type LengthUnit,
  type Projection,
  type ThemeName,
  type ToolbarLabels,
} from '../model/preferences.js';
import { useWorkspaceStore } from '../model/workspace.js';
import {
  NAVIGATION_PRESETS,
  navigationPreset,
  type NavigationPresetId,
} from '../viewport/navigation.js';
import styles from './SettingsDialog.module.css';

const GRID_STEPS = [0.5, 1, 2, 5, 10, 20, 50];

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <span className={styles.label}>{label}</span>
        {hint ? <span className={styles.hint}>{hint}</span> : null}
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

export function SettingsDialog(): JSX.Element {
  const open = useWorkspaceStore((s) => s.settingsOpen);
  const prefs = usePreferences();
  const set = prefs.setPreference;
  const close = () => useWorkspaceStore.getState().setSettingsOpen(false);

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Settings"
      actions={
        <>
          <Button variant="quiet" onClick={() => prefs.resetPreferences()}>
            Reset to defaults
          </Button>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <h3 className={styles.section}>Appearance</h3>
        <Row label="Theme">
          <Select
            aria-label="Theme"
            value={prefs.theme}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
            onChange={(e) => set('theme', e.currentTarget.value as ThemeName)}
          />
        </Row>
        <Row label="Toolbar labels" hint="Icon names in the side toolbars">
          <Select
            aria-label="Toolbar labels"
            value={prefs.labels}
            options={[
              { value: 'icons', label: 'Icons only' },
              { value: 'hover', label: 'On hover' },
              { value: 'always', label: 'Always' },
            ]}
            onChange={(e) => set('labels', e.currentTarget.value as ToolbarLabels)}
          />
        </Row>
        <Row label="Home at start" hint="Recent projects and templates when the app opens">
          <Checkbox
            aria-label="Show Home at start"
            checked={prefs.showHomeOnStartup}
            onChange={(e) => set('showHomeOnStartup', e.currentTarget.checked)}
          />
        </Row>
        <Row label="Display units" hint="Read-outs only; models are stored in millimetres">
          <Select
            aria-label="Display units"
            value={prefs.units}
            options={[
              { value: 'mm', label: 'Millimetres (mm)' },
              { value: 'in', label: 'Inches (in)' },
            ]}
            onChange={(e) => set('units', e.currentTarget.value as LengthUnit)}
          />
        </Row>

        <h3 className={styles.section}>Grid</h3>
        <Row label="Show grid">
          <Checkbox
            aria-label="Show grid"
            checked={prefs.gridVisible}
            onChange={(e) => set('gridVisible', e.currentTarget.checked)}
          />
        </Row>
        <Row label="Grid step" hint="Default for new sessions">
          <Select
            aria-label="Grid step"
            value={String(prefs.gridStep)}
            options={GRID_STEPS.map((s) => ({ value: String(s), label: `${s} mm` }))}
            onChange={(e) => set('gridStep', Number(e.currentTarget.value))}
          />
        </Row>

        <h3 className={styles.section}>Rendering</h3>
        <Row
          label="High quality"
          hint="Ambient occlusion and contact shadow; turn off on slow GPUs"
        >
          <Checkbox
            aria-label="High quality rendering"
            checked={prefs.renderQuality === 'high'}
            onChange={(e) => set('renderQuality', e.currentTarget.checked ? 'high' : 'standard')}
          />
        </Row>

        <h3 className={styles.section}>Navigation</h3>
        <Row label="Mouse preset" hint={navigationPreset(prefs.navigationPreset).summary}>
          <Select
            aria-label="Navigation preset"
            value={prefs.navigationPreset}
            options={NAVIGATION_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            onChange={(e) => set('navigationPreset', e.currentTarget.value as NavigationPresetId)}
          />
        </Row>
        <Row label="Projection">
          <Select
            aria-label="Projection"
            value={prefs.projection}
            options={[
              { value: 'perspective', label: 'Perspective' },
              { value: 'orthographic', label: 'Orthographic' },
            ]}
            onChange={(e) => set('projection', e.currentTarget.value as Projection)}
          />
        </Row>
        <Row
          label="Field of view"
          hint={prefs.projection === 'orthographic' ? 'Perspective only' : `${prefs.fov}°`}
        >
          <Slider
            aria-label="Field of view"
            min={15}
            max={90}
            step={1}
            value={prefs.fov}
            valueText={`${prefs.fov} degrees`}
            disabled={prefs.projection === 'orthographic'}
            onValueChange={(v) => set('fov', Math.round(v))}
          />
        </Row>
        <Row label="Animate camera" hint="Smooth transitions between views">
          <Checkbox
            aria-label="Animate camera"
            checked={prefs.animateCamera}
            onChange={(e) => set('animateCamera', e.currentTarget.checked)}
          />
        </Row>

        <h3 className={styles.section}>Keyboard</h3>
        <Row
          label="Single-key hotkeys"
          hint={
            prefs.singleKeyHotkeys
              ? 'E extrudes, F fillets, … ; X or Ctrl+F searches'
              : 'Typing a letter starts the command search'
          }
        >
          <Checkbox
            aria-label="Single-key hotkeys"
            checked={prefs.singleKeyHotkeys}
            onChange={(e) => set('singleKeyHotkeys', e.currentTarget.checked)}
          />
        </Row>
      </div>
    </Dialog>
  );
}
