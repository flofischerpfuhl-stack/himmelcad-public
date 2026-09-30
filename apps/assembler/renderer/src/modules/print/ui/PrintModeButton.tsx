/** The "Print" mode toggle in the left dock's mode group (next to Section / Isolate / Measure). */
import { Printer } from 'lucide-react';

import { Tooltip } from '@himmelcad/ui';

import { usePrintStore } from '../printStore.js';

export function PrintModeButton({
  className,
  activeClassName,
  stateClassName,
}: {
  className: string | undefined;
  activeClassName: string | undefined;
  stateClassName: string | undefined;
}): JSX.Element {
  const enabled = usePrintStore((s) => s.enabled);
  return (
    <Tooltip content="Printability: overhangs, walls, build plate (P)">
      <button
        type="button"
        className={`${className ?? ''} ${enabled ? (activeClassName ?? '') : ''}`}
        aria-pressed={enabled}
        onClick={() => usePrintStore.getState().setEnabled(!enabled)}
      >
        <Printer size={14} />
        Print
        <span className={stateClassName}>{enabled ? 'On' : 'Off'}</span>
      </button>
    </Tooltip>
  );
}
