import styles from './SelectionBox.module.css';

export interface SelectionBoxProps {
  /** Rectangle in CSS pixels relative to the positioned parent. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** `window` (left → right, enclosed only): solid outline; `crossing` (right → left, touched): dashed. */
  mode: 'window' | 'crossing';
  /** Current filter label ("All items", "Faces only", …). */
  filterLabel: string;
  /** Filter choices with their keys, e.g. `[['All', 'A'], ['Bodies', 'B'] …]`; the active one is marked. */
  filters: readonly { label: string; key: string; active: boolean }[];
  /** Hint under the chips ("Tab cycles"), omitted when empty. */
  hint?: string;
}

/**
 * The rubber band of a box selection, shared by the 3D viewport and sketch
 * mode. Window boxes (drag right) are solid, crossing boxes (drag left)
 * dashed with a lighter fill, like most CAD programs; the filter strip on
 * the box shows the active filter and the keys that switch it.
 */
export function SelectionBox(props: SelectionBoxProps): JSX.Element {
  const left = Math.min(props.x0, props.x1);
  const top = Math.min(props.y0, props.y1);
  const width = Math.abs(props.x1 - props.x0);
  const height = Math.abs(props.y1 - props.y0);
  return (
    <div
      className={`${styles.box} ${props.mode === 'window' ? styles.window : styles.crossing}`}
      style={{ left, top, width, height }}
      role="status"
      aria-live="polite"
      aria-label={`${props.mode === 'window' ? 'Window selection: fully enclosed' : 'Crossing selection: touched'}, ${props.filterLabel}`}
      data-box-mode={props.mode}
    >
      <div className={styles.strip}>
        <span className={styles.mode}>{props.mode === 'window' ? 'Inside' : 'Touching'}</span>
        {props.filters.map((f) => (
          <span key={f.key} className={`${styles.chip} ${f.active ? styles.chipActive : ''}`}>
            {f.label}
            <kbd className={styles.key}>{f.key}</kbd>
          </span>
        ))}
        {props.hint ? <span className={styles.hint}>{props.hint}</span> : null}
      </div>
    </div>
  );
}
