/**
 * Body colour (Items row menu, context menu, command search "Colour…").
 * A colour is a `setAppearance` History step (see `model/items.ts`): one
 * undo step, kept through later edits, written to STEP/3MF. Picking
 * another swatch right after updates that same step instead of stacking
 * new ones.
 */
import { useEffect, useState } from 'react';

import { Button, Dialog } from '@himmelcad/ui';

import {
  BODY_PALETTE,
  applyBodyColour,
  applyBodyMaterial,
  normalizeHexColour,
} from '../model/appearance.js';
import { MATERIALS, bodyMaterials, type MaterialId } from '../viewport/displayModes.js';
import { useAssemblerStore } from '../foundation/commands/store.js';
import { displayBodyName, useItemsStore } from '../model/items.js';
import { useWorkspaceStore } from '../model/workspace.js';
import styles from './ColourDialog.module.css';

export { applyBodyColour, applyBodyMaterial };

export function ColourDialog(): JSX.Element | null {
  const bodyIds = useWorkspaceStore((s) => s.colourDialogBodyIds);
  const bodies = useAssemblerStore((s) => s.evaluation.bodies);
  const features = useAssemblerStore((s) => s.features);
  const rollbackBefore = useAssemblerStore((s) => s.rollbackBefore);
  const meta = useItemsStore();
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const targets = bodies.filter((b) => bodyIds?.includes(b.id));
  const current =
    targets.length > 0 && targets.every((b) => b.color === targets[0]!.color)
      ? targets[0]!.color.toUpperCase()
      : null;

  // The field follows the bodies' colour (on open and after each applied colour).
  useEffect(() => {
    setCustom(current ?? '');
  }, [bodyIds, current]);

  const close = () => {
    setError(null);
    useWorkspaceStore.getState().setColourDialog(null);
  };
  if (!bodyIds) return null;

  const apply = (color: string) => {
    if (!applyBodyColour(bodyIds, color)) {
      setError('Finish the running tool first.');
      return;
    }
    setError(null);
    setCustom(color);
  };

  const title =
    targets.length === 1
      ? `Appearance of ${displayBodyName(targets[0]!, meta)}`
      : `Appearance of ${targets.length} bodies`;
  const markerIndex = rollbackBefore ? features.findIndex((f) => f.id === rollbackBefore) : -1;
  const materials = bodyMaterials(features, markerIndex >= 0 ? markerIndex : features.length);
  const targetMaterials = new Set(targets.map((b) => materials.get(b.id) ?? null));
  const currentMaterial = targetMaterials.size === 1 ? [...targetMaterials][0]! : undefined;
  const chooseMaterial = (material: MaterialId | null) => {
    if (!applyBodyMaterial(bodyIds, material)) {
      setError('Finish the running tool first.');
      return;
    }
    setError(null);
  };

  return (
    <Dialog
      open
      onClose={close}
      title={title}
      actions={
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      }
    >
      <div className={styles.body}>
        <div className={styles.palette} role="listbox" aria-label="Palette">
          {BODY_PALETTE.map((swatch) => {
            const active = current === swatch.color.toUpperCase();
            return (
              <button
                key={swatch.color}
                type="button"
                role="option"
                aria-selected={active}
                aria-label={swatch.name}
                title={swatch.name}
                className={`${styles.swatch} ${active ? styles.swatchActive : ''}`}
                style={{ background: swatch.color }}
                onClick={() => apply(swatch.color)}
              />
            );
          })}
        </div>
        <form
          className={styles.custom}
          onSubmit={(event) => {
            event.preventDefault();
            const color = normalizeHexColour(custom);
            if (!color) {
              setError('Enter a colour as #RRGGBB.');
              return;
            }
            apply(color);
          }}
        >
          <label className={styles.customLabel} htmlFor="hc-colour-hex">
            Custom
          </label>
          <span
            className={styles.preview}
            style={{ background: normalizeHexColour(custom) ?? 'transparent' }}
            aria-hidden
          />
          <input
            id="hc-colour-hex"
            className={styles.hex}
            value={custom}
            placeholder="#RRGGBB"
            spellCheck={false}
            onChange={(event) => setCustom(event.currentTarget.value)}
          />
          <input
            type="color"
            className={styles.picker}
            aria-label="Pick a colour"
            value={normalizeHexColour(custom)?.toLowerCase() ?? '#c9cdd3'}
            onChange={(event) => apply(event.currentTarget.value.toUpperCase())}
          />
          <Button type="submit" size="small">
            Apply
          </Button>
        </form>
        <div className={styles.materialRow}>
          <span className={styles.customLabel} id="hc-material-label">
            Material
          </span>
          <div className={styles.materials} role="radiogroup" aria-labelledby="hc-material-label">
            {[{ id: null, label: 'None' }, ...MATERIALS].map((m) => {
              const active = currentMaterial === m.id;
              return (
                <button
                  key={m.id ?? 'none'}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`${styles.material} ${active ? styles.materialActive : ''}`}
                  onClick={() => chooseMaterial(m.id)}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : (
          <p className={styles.note}>
            Saved as a History step. Colour is exported to STEP and 3MF; the material shows in the
            Visualized display mode and sets the density for mass in Measure.
          </p>
        )}
      </div>
    </Dialog>
  );
}
