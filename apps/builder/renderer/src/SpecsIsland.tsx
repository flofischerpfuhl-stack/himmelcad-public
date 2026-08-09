import {
  createEmptyLibrary,
  loadLibraryFromLocalStorage,
  saveLibraryToLocalStorage,
  serializeLibrary,
  upsertSpecification,
  type AreaPresentation,
  type ColorRef,
  type CurvePresentation,
  type SpecEntityKind,
  type SpecLibrary,
  type Specification,
  SPEC_ENTITY_KINDS,
} from '@himmelcad/specs';
import { Checkbox, Select } from '@himmelcad/ui';
import { X } from 'lucide-react';
import { useMemo, useState } from 'react';

import styles from './SpecsIsland.module.css';

function newId(): string {
  return `spec_${Math.random().toString(36).slice(2, 11)}`;
}

function blankSpec(): Specification {
  return {
    id: newId(),
    code: 1,
    name: 'New specification',
    drawFolder: ['General'],
    presentations: {},
    attributes: {},
    updatedAt: new Date().toISOString(),
  };
}

export function SpecsIsland({ onClose }: { onClose: () => void }): JSX.Element {
  const [library, setLibrary] = useState<SpecLibrary>(() => {
    try {
      return loadLibraryFromLocalStorage();
    } catch {
      return createEmptyLibrary();
    }
  });
  const [selectedId, setSelectedId] = useState<string | null>(
    () => library.specifications[0]?.id ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => library.specifications.find((s) => s.id === selectedId) ?? null,
    [library, selectedId],
  );

  const sorted = useMemo(
    () => [...library.specifications].sort((a, b) => a.code - b.code),
    [library.specifications],
  );

  const persist = (next: SpecLibrary): void => {
    setLibrary(next);
    try {
      saveLibraryToLocalStorage(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const updateSelected = (patch: Partial<Specification>): void => {
    if (!selected) return;
    try {
      const next = upsertSpecification(library, {
        ...selected,
        ...patch,
        presentations: patch.presentations ?? selected.presentations,
      });
      persist(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const addSpec = (): void => {
    const maxCode = library.specifications.reduce((m, s) => Math.max(m, s.code), 0);
    const draft = { ...blankSpec(), code: Math.min(maxCode + 1, 9_999_999_999) };
    try {
      const next = upsertSpecification(library, draft);
      persist(next);
      setSelectedId(draft.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeSelected = (): void => {
    if (!selected) return;
    persist({
      ...library,
      specifications: library.specifications.filter((s) => s.id !== selected.id),
      updatedAt: new Date().toISOString(),
    });
    setSelectedId(null);
  };

  const exportJson = (): void => {
    const blob = new Blob([serializeLibrary(library)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${library.name.replace(/\s+/g, '-').toLowerCase()}.hcspecpack.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleKind = (kind: SpecEntityKind, enabled: boolean): void => {
    if (!selected) return;
    const presentations = { ...selected.presentations };
    if (!enabled) {
      delete presentations[kind];
      updateSelected({ presentations });
      return;
    }
    if (kind === 'curve') {
      const curve: CurvePresentation = {
        color: { kind: 'rgb', rgb: { r: 0, g: 0, b: 0 } },
        lineWeightPx: 1,
      };
      const lt = library.linetypes[0]?.id;
      if (lt) curve.linetypeId = lt;
      presentations.curve = { kind: 'curve', curve };
    } else if (kind === 'area') {
      const area: AreaPresentation = {
        fill: { kind: 'rgb', rgb: { r: 180, g: 180, b: 180 } },
      };
      const hatch = library.hatches[0]?.id;
      if (hatch) area.hatchId = hatch;
      presentations.area = { kind: 'area', area };
    } else if (kind === 'point') {
      presentations.point = {
        kind: 'point',
        point: {
          symbol: 'cross',
          sizePx: 6,
          color: { kind: 'rgb', rgb: { r: 0, g: 0, b: 0 } },
        },
      };
    } else if (kind === 'text') {
      presentations.text = {
        kind: 'text',
        text: {
          color: { kind: 'rgb', rgb: { r: 0, g: 0, b: 0 } },
          fontFamily: 'Inter',
          fontSizePx: 12,
        },
      };
    } else {
      presentations[kind] = {
        kind: 'generic',
        generic: { color: { kind: 'rgb', rgb: { r: 128, g: 128, b: 128 } } },
      } as never;
    }
    updateSelected({ presentations });
  };

  return (
    <div className={styles.root} role="dialog" aria-label="Specifications">
      <header className={styles.header} data-task-drag-handle>
        <h2>Specifications</h2>
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </header>

      <div className={styles.body}>
        <div className={styles.list}>
          {sorted.map((spec) => (
            <button
              key={spec.id}
              type="button"
              className={`${styles.listItem} ${spec.id === selectedId ? styles.listItemActive : ''}`}
              onClick={() => setSelectedId(spec.id)}
            >
              <span className={styles.listCode}>{spec.code}</span>
              {spec.name}
            </button>
          ))}
          <div className={styles.row} style={{ marginTop: 8 }}>
            <button type="button" className={styles.button} onClick={addSpec}>
              Add
            </button>
          </div>
        </div>

        <div className={styles.detail}>
          {!selected ? (
            <div style={{ fontSize: 11, color: 'var(--hc-fg-muted)' }}>
              Select or add a specification.
            </div>
          ) : (
            <>
              <label className={styles.field}>
                <span>Code</span>
                <input
                  className={styles.control}
                  type="number"
                  min={1}
                  max={9_999_999_999}
                  value={selected.code}
                  onChange={(e) => {
                    const code = Number.parseInt(e.currentTarget.value, 10);
                    if (Number.isFinite(code)) updateSelected({ code });
                  }}
                />
              </label>
              <label className={styles.field}>
                <span>Name</span>
                <input
                  className={styles.control}
                  type="text"
                  value={selected.name}
                  onChange={(e) => updateSelected({ name: e.currentTarget.value })}
                />
              </label>
              <label className={styles.field}>
                <span>Draw folder</span>
                <input
                  className={styles.control}
                  type="text"
                  value={selected.drawFolder.join(' / ')}
                  onChange={(e) =>
                    updateSelected({
                      drawFolder: e.currentTarget.value
                        .split('/')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <label className={styles.field}>
                <span>Material</span>
                <Select
                  className={styles.control}
                  value={selected.defaultMaterialId ?? ''}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    if (v) updateSelected({ defaultMaterialId: v });
                    else {
                      const { defaultMaterialId: _drop, ...rest } = selected;
                      void _drop;
                      try {
                        const next = upsertSpecification(library, {
                          ...rest,
                          updatedAt: new Date().toISOString(),
                        });
                        persist(next);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                      }
                    }
                  }}
                >
                  <option value="">None</option>
                  {library.materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </label>

              <div className={styles.sectionTitle}>Entity presentations</div>
              {SPEC_ENTITY_KINDS.map((kind) => {
                const on = selected.presentations[kind] != null;
                return (
                  <div key={kind} className={styles.kindCard}>
                    <div className={styles.kindHead}>
                      <strong>{kind}</strong>
                      <Checkbox
                        label="Enabled"
                        checked={on}
                        onChange={(e) => toggleKind(kind, e.currentTarget.checked)}
                      />
                    </div>
                    {on && kind === 'curve' && selected.presentations.curve?.kind === 'curve' && (
                      <CurveFields
                        library={library}
                        value={selected.presentations.curve.curve}
                        onChange={(curve) =>
                          updateSelected({
                            presentations: {
                              ...selected.presentations,
                              curve: { kind: 'curve', curve },
                            },
                          })
                        }
                      />
                    )}
                    {on && kind === 'area' && selected.presentations.area?.kind === 'area' && (
                      <AreaFields
                        library={library}
                        value={selected.presentations.area.area}
                        onChange={(area) =>
                          updateSelected({
                            presentations: {
                              ...selected.presentations,
                              area: { kind: 'area', area },
                            },
                          })
                        }
                      />
                    )}
                  </div>
                );
              })}

              <div className={styles.row}>
                <button type="button" className={styles.button} onClick={removeSelected}>
                  Delete
                </button>
              </div>
            </>
          )}
          {error && <div className={styles.error}>{error}</div>}
        </div>
      </div>

      <footer className={styles.footer}>
        <button type="button" className={styles.button} onClick={exportJson}>
          Export JSON
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          onClick={onClose}
        >
          Close
        </button>
      </footer>
    </div>
  );
}

function CurveFields({
  library,
  value,
  onChange,
}: {
  library: SpecLibrary;
  value: CurvePresentation;
  onChange: (v: CurvePresentation) => void;
}): JSX.Element {
  const rgb = value.color.kind === 'rgb' ? value.color.rgb : { r: 0, g: 0, b: 0 };
  const hex = `#${[rgb.r, rgb.g, rgb.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  return (
    <>
      <label className={styles.field}>
        <span>Color</span>
        <input
          className={styles.control}
          type="color"
          value={hex}
          onChange={(e) => {
            const h = e.currentTarget.value;
            const color: ColorRef = {
              kind: 'rgb',
              rgb: {
                r: Number.parseInt(h.slice(1, 3), 16),
                g: Number.parseInt(h.slice(3, 5), 16),
                b: Number.parseInt(h.slice(5, 7), 16),
              },
            };
            onChange({ ...value, color });
          }}
        />
      </label>
      <label className={styles.field}>
        <span>Weight px</span>
        <input
          className={styles.control}
          type="number"
          min={0.25}
          max={20}
          step={0.25}
          value={value.lineWeightPx}
          onChange={(e) => onChange({ ...value, lineWeightPx: Number(e.currentTarget.value) || 1 })}
        />
      </label>
      <label className={styles.field}>
        <span>Linetype</span>
        <Select
          className={styles.control}
          value={value.linetypeId ?? ''}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v) onChange({ ...value, linetypeId: v });
            else {
              const { linetypeId: _l, ...rest } = value;
              void _l;
              onChange(rest);
            }
          }}
        >
          <option value="">Continuous</option>
          {library.linetypes.map((lt) => (
            <option key={lt.id} value={lt.id}>
              {lt.name}
            </option>
          ))}
        </Select>
      </label>
    </>
  );
}

function AreaFields({
  library,
  value,
  onChange,
}: {
  library: SpecLibrary;
  value: AreaPresentation;
  onChange: (v: AreaPresentation) => void;
}): JSX.Element {
  const rgb = value.fill.kind === 'rgb' ? value.fill.rgb : { r: 180, g: 180, b: 180 };
  const hex = `#${[rgb.r, rgb.g, rgb.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  return (
    <>
      <label className={styles.field}>
        <span>Fill</span>
        <input
          className={styles.control}
          type="color"
          value={hex}
          onChange={(e) => {
            const h = e.currentTarget.value;
            const fill: ColorRef = {
              kind: 'rgb',
              rgb: {
                r: Number.parseInt(h.slice(1, 3), 16),
                g: Number.parseInt(h.slice(3, 5), 16),
                b: Number.parseInt(h.slice(5, 7), 16),
              },
            };
            onChange({ ...value, fill });
          }}
        />
      </label>
      <label className={styles.field}>
        <span>Hatch</span>
        <Select
          className={styles.control}
          value={value.hatchId ?? ''}
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v) onChange({ ...value, hatchId: v });
            else {
              const { hatchId: _h, ...rest } = value;
              void _h;
              onChange(rest);
            }
          }}
        >
          <option value="">None</option>
          {library.hatches.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </Select>
      </label>
    </>
  );
}
