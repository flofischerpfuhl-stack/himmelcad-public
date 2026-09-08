import type { InteractionState, InteractionTreePresentation } from '@himmelcad/app';
import type { KeyboardEvent, MouseEvent } from 'react';

import { Checkbox } from './Checkbox.js';
import styles from './InteractionStateCheckbox.module.css';

export interface InteractionStateCheckboxProps {
  readonly label: string;
  readonly state: InteractionTreePresentation;
  readonly onStateChange: (state: InteractionState, scope: 'node' | 'subtree' | 'all') => void;
}

const NEXT: Readonly<Record<InteractionTreePresentation, InteractionState>> = {
  hidden: 'reference',
  reference: 'editable',
  editable: 'inert',
  inert: 'hidden',
  mixed: 'editable',
};

export function InteractionStateCheckbox({
  label,
  state,
  onStateChange,
}: InteractionStateCheckboxProps): JSX.Element {
  const next = NEXT[state];
  const checkState = state === 'editable' || state === 'reference';
  return (
    <span
      className={styles.root}
      data-interaction-state={state}
      title={`${label}: ${stateLabel(state)}. Click for ${stateLabel(next)}.`}
    >
      <Checkbox
        checked={checkState}
        indeterminate={state === 'mixed'}
        aria-label={`${label} interaction state: ${stateLabel(state)}`}
        onClick={(event: MouseEvent<HTMLInputElement>) => {
          event.stopPropagation();
          onStateChange(next, event.ctrlKey || event.metaKey ? 'node' : 'subtree');
        }}
        onChange={() => undefined}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
          event.preventDefault();
          event.stopPropagation();
          onStateChange(next, 'all');
        }}
      />
      {state === 'reference' || state === 'inert' ? (
        <span className={styles.code} aria-hidden>
          {state === 'reference' ? 'R' : 'I'}
        </span>
      ) : null}
    </span>
  );
}

function stateLabel(state: InteractionTreePresentation): string {
  return state === 'mixed' ? 'Mixed' : state[0]!.toUpperCase() + state.slice(1);
}
