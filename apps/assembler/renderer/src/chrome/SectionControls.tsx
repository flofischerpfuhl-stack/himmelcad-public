/**
 * Section View controls, shown while Section is on: plane X/Y/Z or Face
 * (a planar face picked in the view, or the selected one), Flip, the plane
 * offset (expressions allowed), Section only (2D: just the cut regions and
 * outlines) and Look at section (camera normal to the plane). The plane
 * itself has a draggable handle and an offset chip in the viewport;
 * switching the axis re-centres the plane on the visible model. Cut faces
 * are capped in each body's own colour.
 */
import { ArrowLeftRight, Eye, SquareDashed, X } from 'lucide-react';
import { useEffect } from 'react';

import { Tooltip, registerEscapeRung } from '@himmelcad/ui';

import { lookAtSection, sectionAtFace } from '../model/commands/displayCommands.js';
import {
  isPlanarFace,
  type AssemblerState,
  type SectionAxis,
} from '../foundation/commands/store.js';
import { useViewportUi } from '../model/viewportUi.js';
import { ExpressionField } from './ExpressionField.js';
import styles from './SectionControls.module.css';

const AXES: readonly SectionAxis[] = ['X', 'Y', 'Z'];

export function SectionControls({ state }: { state: AssemblerState }): JSX.Element {
  const view = state.viewState;
  const picking = useViewportUi((s) => s.sectionFacePick);
  const plane = view.sectionPlane;
  // Closing the controls (Section off by any path) ends a pending face pick.
  useEffect(() => () => useViewportUi.getState().setSectionFacePick(false), []);
  // Escape ends the face pick (before it would clear the selection).
  useEffect(() => {
    if (!picking) return;
    return registerEscapeRung('tool', () => {
      useViewportUi.getState().setSectionFacePick(false);
      return true;
    });
  }, [picking]);
  const chooseFace = () => {
    const only = state.selection.length === 1 ? state.selection[0] : undefined;
    if (only?.kind === 'face' && isPlanarFace(state.evaluation, only.bodyId, only.faceKey)) {
      sectionAtFace(state, only.bodyId, only.faceKey);
      useViewportUi.getState().setSectionFacePick(false);
      return;
    }
    useViewportUi.getState().setSectionFacePick(!picking);
  };
  return (
    <div className={styles.root} role="group" aria-label="Section view">
      <span className={styles.title}>Section</span>
      <span className={styles.segmented} role="radiogroup" aria-label="Section plane">
        {AXES.map((axis) => {
          const active = !plane && view.sectionAxis === axis;
          return (
            <button
              key={axis}
              type="button"
              role="radio"
              aria-checked={active}
              className={`${styles.segment} ${active ? styles.segmentActive : ''}`}
              onClick={() => {
                useViewportUi.getState().setSectionFacePick(false);
                state.setSectionAxis(axis);
              }}
            >
              {axis}
            </button>
          );
        })}
        <Tooltip content={plane ? plane.label : 'Section at a planar face'}>
          <button
            type="button"
            role="radio"
            aria-checked={!!plane}
            className={`${styles.segment} ${plane || picking ? styles.segmentActive : ''}`}
            onClick={chooseFace}
          >
            Face
          </button>
        </Tooltip>
      </span>
      {picking ? <span className={styles.prompt}>Click a planar face</span> : null}
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
          label={plane ? 'Offset from face' : `${view.sectionAxis} offset`}
          value={view.sectionOffset}
          unit="mm"
          precision={2}
          onCommit={(value) => state.setSectionOffset(value)}
        />
      </div>
      <Tooltip content="Section only (2D): just the cut regions">
        <button
          type="button"
          className={`${styles.iconButton} ${view.sectionOnly ? styles.iconButtonActive : ''}`}
          aria-label="Section only"
          aria-pressed={view.sectionOnly}
          onClick={() => {
            const next = !view.sectionOnly;
            state.setViewToggle('sectionOnly', next);
            if (next) lookAtSection(state);
          }}
        >
          <SquareDashed size={14} />
        </button>
      </Tooltip>
      <Tooltip content="Look at section">
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Look at section"
          onClick={() => lookAtSection(state)}
        >
          <Eye size={14} />
        </button>
      </Tooltip>
      <Tooltip content="Turn Section View off">
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Turn Section View off"
          onClick={() => {
            useViewportUi.getState().setSectionFacePick(false);
            state.setSectionEnabled(false);
          }}
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );
}
