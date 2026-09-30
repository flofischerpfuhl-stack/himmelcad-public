/**
 * File › Export image… (Ctrl+Shift+E): the current view as a PNG at a
 * chosen resolution, optionally with a transparent background and without
 * the grid and axes. Rendered offscreen (multisampled) by the viewport's
 * renderer with the same display mode, section and materials; tool handles
 * and hover highlights are left out. Settings are remembered (preferences).
 */
import { useEffect, useState } from 'react';

import { Button, Checkbox, Dialog, NumberInput, Select } from '@himmelcad/ui';

import * as io from '../foundation/document/persistence.js';
import {
  DEFAULT_IMAGE_EXPORT,
  usePreferences,
  type ImageExportPreference,
} from '../model/preferences.js';
import { useAssemblerStore } from '../foundation/commands/store.js';
import { currentViewportSize, renderViewportImage, useViewportUi } from '../model/viewportUi.js';
import { useWorkspaceStore } from '../model/workspace.js';
import { imageExportSize, imageFileName } from '../viewport/imageExport.js';
import styles from './ExportImageDialog.module.css';

const SIZE_OPTIONS: { value: string; label: string }[] = [
  { value: 'view:1', label: 'View size' },
  { value: 'view:2', label: 'View size × 2' },
  { value: 'view:3', label: 'View size × 3' },
  { value: 'view:4', label: 'View size × 4' },
  { value: '1920x1080', label: 'Full HD (1920 × 1080)' },
  { value: '2560x1440', label: 'QHD (2560 × 1440)' },
  { value: '3840x2160', label: '4K (3840 × 2160)' },
  { value: 'custom', label: 'Custom…' },
];

function sizeValue(pref: ImageExportPreference): string {
  return pref.size === 'view' ? `view:${pref.scale}` : pref.size;
}

function withSizeValue(pref: ImageExportPreference, value: string): ImageExportPreference {
  if (value.startsWith('view:')) {
    return {
      ...pref,
      size: 'view',
      scale: Number(value.slice(5)) as ImageExportPreference['scale'],
    };
  }
  return { ...pref, size: value as ImageExportPreference['size'] };
}

export function ExportImageDialog(): JSX.Element | null {
  const open = useViewportUi((s) => s.exportImageOpen);
  const stored = usePreferences((p) => p.imageExport);
  const [draft, setDraft] = useState<ImageExportPreference>(stored ?? DEFAULT_IMAGE_EXPORT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(stored ?? DEFAULT_IMAGE_EXPORT);
      setError(null);
    }
  }, [open, stored]);

  if (!open) return null;
  const viewport = currentViewportSize() ?? { width: 1280, height: 720, dpr: 1 };
  const size = imageExportSize(draft, viewport);
  const close = () => {
    if (!busy) useViewportUi.getState().setExportImageOpen(false);
  };

  const exportNow = async () => {
    setBusy(true);
    setError(null);
    try {
      usePreferences.getState().setPreference('imageExport', draft);
      const image = await renderViewportImage({
        width: size.width,
        height: size.height,
        transparent: draft.transparent,
        grid: draft.grid,
      });
      const bytes = new Uint8Array(await image.png.arrayBuffer());
      const saved = await io.exportBinary(
        bytes,
        imageFileName(useAssemblerStore.getState().projectName),
        [{ name: 'PNG image', extensions: ['png'] }],
        'image/png',
      );
      if (saved) {
        useWorkspaceStore.getState().notify(`Image exported (${image.width} × ${image.height} px)`);
        useViewportUi.getState().setExportImageOpen(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Export image"
      actions={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            loadingLabel="Rendering"
            onClick={() => void exportNow()}
            disabled={busy}
          >
            Export PNG
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <label className={styles.field}>
          <span className={styles.label}>Size</span>
          <Select
            aria-label="Image size"
            value={sizeValue(draft)}
            options={SIZE_OPTIONS}
            onChange={(event) => setDraft((d) => withSizeValue(d, event.currentTarget.value))}
          />
        </label>
        {draft.size === 'custom' ? (
          <div className={styles.custom}>
            <NumberInput
              aria-label="Width in pixels"
              value={draft.width}
              min={16}
              max={8192}
              step={1}
              onCommit={(value) => setDraft((d) => ({ ...d, width: Math.round(value) }))}
            />
            <span className={styles.times}>×</span>
            <NumberInput
              aria-label="Height in pixels"
              value={draft.height}
              min={16}
              max={8192}
              step={1}
              onCommit={(value) => setDraft((d) => ({ ...d, height: Math.round(value) }))}
            />
            <span className={styles.unit}>px</span>
          </div>
        ) : null}
        <p className={styles.readout}>
          {size.width} × {size.height} px
          {Math.abs(size.width / size.height - viewport.width / Math.max(1, viewport.height)) > 0.01
            ? ' · the framing widens or narrows to this aspect'
            : ''}
        </p>
        <Checkbox
          label="Transparent background"
          checked={draft.transparent}
          onChange={(event) => {
            const transparent = event.currentTarget.checked;
            setDraft((d) => ({ ...d, transparent }));
          }}
        />
        <Checkbox
          label="Include grid and axes"
          checked={draft.grid}
          onChange={(event) => {
            const grid = event.currentTarget.checked;
            setDraft((d) => ({ ...d, grid }));
          }}
        />
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : (
          <p className={styles.note}>
            The current view with its display mode, section and materials.
          </p>
        )}
      </div>
    </Dialog>
  );
}
