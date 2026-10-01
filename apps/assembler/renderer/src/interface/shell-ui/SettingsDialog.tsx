/**
 * Settings (View › Settings…, Ctrl+,): user preferences stored per user, not
 * in the document (`model/preferences.ts`). Every change applies at once.
 */
import { Button, Checkbox, Dialog, Select, Slider } from '@himmelcad/ui';

import {
  usePreferences,
  type Handedness,
  type LengthUnit,
  type Projection,
  type TabletLayoutSetting,
  type ThemeName,
  type ToolbarLabels,
} from '../../platform/input/preferences.js';
import type { FingerDrawing } from '../../platform/input/pointer.js';
import { useTabletLayout } from '../../platform/input/tabletLayout.js';
import { useWorkspaceStore } from './workspace.js';
import {
  NAVIGATION_PRESETS,
  navigationPreset,
  type NavigationPresetId,
} from '../../platform/input/navigation.js';
import { ShortcutSettings } from './ShortcutSettings.js';
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
  const device = useTabletLayout((s) => s.environment.touch);
  const tablet = useTabletLayout((s) => s.tablet);
  const deviceText =
    device === 'primary'
      ? 'This device: touch screen'
      : device === 'secondary'
        ? 'This device: touch screen and mouse'
        : 'This device: mouse and keyboard';

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

        <h3 className={styles.section}>Touch and pen</h3>
        <Row
          label="Tablet layout"
          hint={`${deviceText} · larger targets, labels, number keypad${tablet ? ' (on)' : ''}`}
        >
          <Select
            aria-label="Tablet layout"
            value={prefs.tabletLayout}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(e) => set('tabletLayout', e.currentTarget.value as TabletLayoutSetting)}
          />
        </Row>
        <Row label="Tools" hint="The hand without the pen taps the tools">
          <Select
            aria-label="Tool side"
            value={prefs.handedness}
            options={[
              { value: 'right', label: 'Left (right-handed)' },
              { value: 'left', label: 'Right (left-handed)' },
            ]}
            onChange={(e) => set('handedness', e.currentTarget.value as Handedness)}
          />
        </Row>
        <Row
          label="Finger in sketches"
          hint={
            prefs.fingerDrawing === 'auto'
              ? prefs.penSeen
                ? 'A pen was used here: the pen draws, fingers navigate'
                : 'Fingers draw until a pen is used'
              : prefs.fingerDrawing === 'pen'
                ? 'Only the pen draws; fingers navigate and select'
                : 'Fingers draw too; two fingers navigate'
          }
        >
          <Select
            aria-label="Finger in sketches"
            value={prefs.fingerDrawing}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'pen', label: 'Pen only draws' },
              { value: 'touch', label: 'Touch draws too' },
            ]}
            onChange={(e) => set('fingerDrawing', e.currentTarget.value as FingerDrawing)}
          />
        </Row>
        <Row label="Pen shapes" hint="A stroke becomes a line, arc, circle or rectangle">
          <Checkbox
            aria-label="Pen strokes become shapes"
            checked={prefs.penShapes}
            onChange={(e) => set('penShapes', e.currentTarget.checked)}
          />
        </Row>
        <Row label="Scribble to erase" hint="Scribbling over sketch curves deletes them">
          <Checkbox
            aria-label="Scribble to erase"
            checked={prefs.scribbleErase}
            onChange={(e) => set('scribbleErase', e.currentTarget.checked)}
          />
        </Row>
        <Row
          label="Palm rejection"
          hint="Ignore a hand resting on the screen while the pen is used"
        >
          <Checkbox
            aria-label="Palm rejection"
            checked={prefs.palmRejection}
            onChange={(e) => set('palmRejection', e.currentTarget.checked)}
          />
        </Row>
        <Row
          label="Number keypad"
          hint="On-screen keypad for values; automatic: with the tablet layout"
        >
          <Select
            aria-label="Number keypad"
            value={prefs.numericKeypad}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'on', label: 'Always' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(e) => set('numericKeypad', e.currentTarget.value as TabletLayoutSetting)}
          />
        </Row>
        <Row
          label="Undo/Redo gestures"
          hint="Two-finger tap undoes, three-finger tap redoes; or swipe three fingers"
        >
          <Checkbox
            aria-label="Undo and redo gestures"
            checked={prefs.touchUndoGestures}
            onChange={(e) => set('touchUndoGestures', e.currentTarget.checked)}
          />
        </Row>
        <Row label="Twist to roll" hint="Turning two fingers rolls the view">
          <Checkbox
            aria-label="Twist to roll"
            checked={prefs.twistRoll}
            onChange={(e) => set('twistRoll', e.currentTarget.checked)}
          />
        </Row>
        <Row label="Inertia" hint="The view keeps gliding after a flick">
          <Checkbox
            aria-label="Inertia"
            checked={prefs.touchInertia}
            onChange={(e) => set('touchInertia', e.currentTarget.checked)}
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
        <ShortcutSettings />

        <h3 className={styles.section}>Selection</h3>
        <Row
          label="Selection extension"
          hint={
            prefs.selectionExtension
              ? 'Every click adds to the selection; Esc or empty space clears it'
              : 'Shift+click adds to the selection'
          }
        >
          <Checkbox
            aria-label="Selection extension"
            checked={prefs.selectionExtension}
            onChange={(e) => set('selectionExtension', e.currentTarget.checked)}
          />
        </Row>
      </div>
    </Dialog>
  );
}
