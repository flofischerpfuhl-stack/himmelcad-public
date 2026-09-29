/**
 * Tool-session chrome: a top-centre pill (tool name, shortcut, one-line
 * prompt, and — for Extrude — the New body/Join operation badge) plus
 * floating Done/Cancel buttons near the bottom centre. Rendered whenever
 * `activeTool` is set; the viewport owns the in-canvas handles and
 * editable dimension labels this refers to.
 */
import { Check, X } from 'lucide-react';

import { Button, Tooltip } from '@himmelcad/ui';

import type { AssemblerState, ToolSession as ToolSessionState } from '../model/store.js';
import styles from './ToolSession.module.css';

const TOOL_META: Record<
  ToolSessionState['kind'],
  { label: string; shortcut: string; prompt: string }
> = {
  sketchRectangle: {
    label: 'Rectangle',
    shortcut: 'R',
    prompt: 'Click two corners on the grid.',
  },
  extrude: {
    label: 'Extrude',
    shortcut: 'E',
    prompt: 'Drag the arrow or type a distance.',
  },
  move: {
    label: 'Move',
    shortcut: 'M',
    prompt: 'Drag the arrow or type an offset.',
  },
};

export function ToolSession({ state }: { state: AssemblerState }): JSX.Element | null {
  const tool = state.activeTool;
  if (!tool) return null;
  const meta = TOOL_META[tool.kind];

  return (
    <>
      <div className={styles.pill} role="status" aria-label={`${meta.label} tool active`}>
        <span className={styles.name}>{meta.label}</span>
        <span className={styles.shortcut}>{meta.shortcut}</span>
        <span className={styles.divider} aria-hidden />
        <span className={styles.prompt}>{meta.prompt}</span>
        {tool.kind === 'extrude' && tool.profile.kind === 'sketch' ? (
          <span className={styles.badge} role="radiogroup" aria-label="Extrude operation">
            <button
              type="button"
              role="radio"
              aria-checked={tool.operation === 'new'}
              className={`${styles.badgeOption} ${tool.operation === 'new' ? styles.badgeOptionActive : ''}`}
              onClick={() => state.setExtrudeOperation('new')}
            >
              New body
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={tool.operation === 'join'}
              className={`${styles.badgeOption} ${tool.operation === 'join' ? styles.badgeOptionActive : ''}`}
              onClick={() => state.setExtrudeOperation('join')}
            >
              Join
            </button>
          </span>
        ) : null}
      </div>
      <div className={styles.actions}>
        <Tooltip content="Cancel (Esc)">
          <Button
            variant="secondary"
            size="small"
            icon={<X size={14} />}
            aria-label="Cancel tool"
            onClick={() => state.cancel()}
          >
            Cancel
          </Button>
        </Tooltip>
        <Tooltip content="Done (Enter)">
          <Button
            variant="primary"
            size="small"
            icon={<Check size={14} />}
            aria-label="Commit tool"
            onClick={() => state.commit()}
          >
            Done
          </Button>
        </Tooltip>
      </div>
    </>
  );
}
