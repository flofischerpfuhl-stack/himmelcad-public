/** The "Assistant" toggle in the left dock's mode group; a pulsing dot while a turn runs. */
import { Sparkles } from 'lucide-react';

import { Tooltip } from '@himmelcad/ui';

import { host } from '../../../foundation/host/index.js';
import { useAssistant } from '../controller.js';
import styles from './AssistantIsland.module.css';

export function AssistantButton({
  className,
  activeClassName,
  stateClassName,
}: {
  className: string | undefined;
  activeClassName: string | undefined;
  stateClassName: string | undefined;
}): JSX.Element | null {
  const open = useAssistant((s) => s.open);
  const busy = useAssistant((s) => s.busy);
  // Hidden where no local agent CLI can run (the browser); the command explains why.
  if (!host().assistant) return null;
  return (
    <Tooltip content="Assistant: describe a part, get an editable model">
      <button
        type="button"
        className={`${className ?? ''} ${open ? (activeClassName ?? '') : ''}`}
        aria-pressed={open}
        aria-label={busy ? 'Assistant (working)' : 'Assistant'}
        onClick={() => useAssistant.getState().setOpen(!open)}
      >
        <Sparkles size={14} />
        Assistant
        {busy ? (
          <span className={styles.running} aria-hidden="true" />
        ) : (
          <span className={stateClassName}>{open ? 'On' : 'Off'}</span>
        )}
      </button>
    </Tooltip>
  );
}
