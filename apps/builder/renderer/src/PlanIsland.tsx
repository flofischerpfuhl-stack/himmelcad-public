import {
  loadPlanLibrary,
  paperCssPixels,
  resolvePaperMm,
  savePlanLibrary,
  STANDARD_PAPERS,
  upsertLibraryItem,
  type PaperConfig,
  type PlanLibrary,
} from '@himmelcad/plan';
import { Select } from '@himmelcad/ui';
import { X } from 'lucide-react';
import { lazy, Suspense, useMemo, useRef, useState } from 'react';

import styles from './PlanIsland.module.css';

// Excalidraw CSS — loaded with the lazy component bundle via dynamic import side effect.
const Excalidraw = lazy(async () => {
  await import('@excalidraw/excalidraw/index.css');
  const mod = await import('@excalidraw/excalidraw');
  return { default: mod.Excalidraw };
});

type ExcalidrawApi = {
  getSceneElements: () => readonly unknown[];
  getAppState: () => { width?: number; height?: number };
  updateScene: (scene: { elements?: unknown[] }) => void;
  addFiles?: (files: unknown[]) => void;
};

export function PlanIsland({ onClose }: { onClose: () => void }): JSX.Element {
  const [paper, setPaper] = useState<PaperConfig>({
    sizeId: 'a3',
    orientation: 'landscape',
    marginMm: 10,
    customWidthMm: 400,
    customHeightMm: 300,
  });
  const [library, setLibrary] = useState<PlanLibrary>(() => loadPlanLibrary());
  const [groupName, setGroupName] = useState('Group');
  const apiRef = useRef<ExcalidrawApi | null>(null);

  const layout = useMemo(() => paperCssPixels(paper, 900, 620), [paper]);
  const mm = useMemo(() => resolvePaperMm(paper), [paper]);

  const saveGroup = (): void => {
    const api = apiRef.current;
    if (!api) return;
    const elements = api.getSceneElements();
    if (!elements.length) return;
    const item = {
      id: `grp_${Date.now().toString(36)}`,
      name: groupName.trim() || 'Group',
      elementsJson: JSON.stringify(elements),
      updatedAt: new Date().toISOString(),
    };
    const next = upsertLibraryItem(library, item);
    setLibrary(next);
    savePlanLibrary(next);
  };

  const insertGroup = (id: string): void => {
    const item = library.items.find((i) => i.id === id);
    const api = apiRef.current;
    if (!item || !api) return;
    try {
      const elements = JSON.parse(item.elementsJson) as unknown[];
      // Re-id so paste does not collide.
      const stamped = elements.map((el) => {
        if (el && typeof el === 'object' && 'id' in el) {
          return {
            ...el,
            id: `${String((el as { id: string }).id)}_${Math.random().toString(36).slice(2, 6)}`,
          };
        }
        return el;
      });
      const current = api.getSceneElements() as unknown[];
      api.updateScene({ elements: [...current, ...stamped] });
    } catch {
      /* ignore bad library item */
    }
  };

  return (
    <div className={styles.root} role="dialog" aria-label="Plan">
      <header className={styles.header} data-task-drag-handle>
        <h2>Plan</h2>
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </header>

      <div className={styles.toolbar}>
        <label>
          Paper
          <Select
            className={styles.control}
            value={paper.sizeId}
            onChange={(e) => setPaper((p) => ({ ...p, sizeId: e.currentTarget.value }))}
          >
            {STANDARD_PAPERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="custom">Custom</option>
          </Select>
        </label>
        <label>
          Orientation
          <Select
            className={styles.control}
            value={paper.orientation}
            onChange={(e) =>
              setPaper((p) => ({
                ...p,
                orientation: e.currentTarget.value as 'portrait' | 'landscape',
              }))
            }
          >
            <option value="landscape">Landscape</option>
            <option value="portrait">Portrait</option>
          </Select>
        </label>
        {paper.sizeId === 'custom' && (
          <>
            <label>
              W mm
              <input
                className={styles.control}
                type="number"
                min={50}
                value={paper.customWidthMm ?? 210}
                onChange={(e) =>
                  setPaper((p) => ({ ...p, customWidthMm: Number(e.currentTarget.value) || 210 }))
                }
              />
            </label>
            <label>
              H mm
              <input
                className={styles.control}
                type="number"
                min={50}
                value={paper.customHeightMm ?? 297}
                onChange={(e) =>
                  setPaper((p) => ({ ...p, customHeightMm: Number(e.currentTarget.value) || 297 }))
                }
              />
            </label>
          </>
        )}
        <span style={{ color: 'var(--hc-fg-muted)' }}>
          {mm.widthMm} × {mm.heightMm} mm
        </span>
        <input
          className={styles.control}
          style={{ width: 120 }}
          value={groupName}
          onChange={(e) => setGroupName(e.currentTarget.value)}
          placeholder="Group name"
        />
        <button type="button" className={styles.button} onClick={saveGroup}>
          Save selection to library
        </button>
      </div>

      <div className={styles.mainRow}>
        <div className={styles.stage}>
          <div
            className={styles.paper}
            style={{ width: layout.widthPx, height: layout.heightPx }}
          >
            <div className={styles.canvasHost}>
              <Suspense fallback={<div className={styles.hint}>Loading canvas…</div>}>
                <Excalidraw
                  theme="light"
                  UIOptions={{
                    canvasActions: {
                      loadScene: false,
                      export: false,
                      saveAsImage: true,
                      toggleTheme: false,
                    },
                  }}
                  excalidrawAPI={(api) => {
                    apiRef.current = api as unknown as ExcalidrawApi;
                  }}
                />
              </Suspense>
            </div>
          </div>
        </div>
        <aside className={styles.sidebar}>
          <div className={styles.hint}>Library</div>
          {library.items.length === 0 && (
            <div className={styles.hint}>Save a group from the sheet.</div>
          )}
          {library.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.libraryItem}
              onClick={() => insertGroup(item.id)}
              title="Insert into sheet"
            >
              {item.name}
            </button>
          ))}
        </aside>
      </div>
    </div>
  );
}
