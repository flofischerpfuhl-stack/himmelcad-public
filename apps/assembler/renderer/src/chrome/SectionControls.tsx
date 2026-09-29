/**
 * Section View controls, shown while Section is on: axis switch (X/Y/Z),
 * Flip, and the plane offset (expressions allowed). The plane itself has a
 * draggable handle and an offset chip in the viewport; switching the axis
 * re-centres the plane on the visible model.
 */
import { ArrowLeftRight, X } from 'lucide-react';

import { Tooltip } from '@himmelcad/ui';

import type { AssemblerState, SectionAxis } from '../model/store.js';
import { ExpressionField } from './ExpressionField.js';
import styles from './SectionControls.module.css';

const AXES: readonly SectionAxis[] = ['X', 'Y', 'Z'];

export function SectionControls({ state }: { state: AssemblerState }): JSX.Element {
  const view = state.viewState;
  return (
    <div className={styles.root} role="group" aria-label="Section view">
      <span className={styles.title}>Section</span>
      <span className={styles.segmented} role="radiogroup" aria-label="Section axis">
        {AXES.map((axis) => (
          <button
            key={axis}
            type="button"
            role="radio"
            aria-checked={view.sectionAxis === axis}
            className={`${styles.segment} ${view.sectionAxis === axis ? styles.segmentActive : ''}`}
            onClick={() => state.setSectionAxis(axis)}
          >
            {axis}
          </button>
        ))}
      </span>
      <Tooltip content="Flip: keep the other side">
        <button
          type="button"
          className={`${styles.iconButton} ${view.sectionFlipped ? styles.iconButtonActive : ''}`}
          aria-label="Flip section"
          aria-pressed={view.sectionFlipped}
          onClick={() => state.setSectionFlipped(!view.sectionFlipped)}
        >
          <ArrowLeftRight size={14} />
        </button>
      </Tooltip>
      <div className={styles.offset}>
        <ExpressionField
          label={`${view.sectionAxis} offset`}
          value={view.sectionOffset}
          unit="mm"
          precision={2}
          onCommit={(value) => state.setSectionOffset(value)}
        />
      </div>
      <Tooltip content="Turn Section View off">
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Turn Section View off"
          onClick={() => state.setSectionEnabled(false)}
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );
}
