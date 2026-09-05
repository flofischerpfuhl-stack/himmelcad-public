import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import styles from './BaseControls.module.css';

interface TooltipChildProps {
  disabled?: boolean;
  'aria-describedby'?: string;
  onMouseEnter?: (event: MouseEvent) => void;
  onMouseLeave?: (event: MouseEvent) => void;
  onFocus?: (event: FocusEvent) => void;
  onBlur?: (event: FocusEvent) => void;
}

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement<TooltipChildProps>;
  delay?: number;
  open?: boolean;
}

export function Tooltip({
  content,
  children,
  delay = 500,
  open: controlledOpen,
}: TooltipProps): JSX.Element {
  const id = useId();
  const timer = useRef<number | null>(null);
  const [internalOpen, setOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  useEffect(() => () => clear(), []);

  if (!isValidElement(children) || children.props.disabled) return children;

  const show = (): void => {
    clear();
    timer.current = window.setTimeout(() => setOpen(true), Math.max(0, delay));
  };
  const hide = (): void => {
    clear();
    setOpen(false);
  };
  const describedBy = [children.props['aria-describedby'], id].filter(Boolean).join(' ');
  const trigger = cloneElement(children, {
    'aria-describedby': describedBy,
    onMouseEnter: (event: MouseEvent) => {
      children.props.onMouseEnter?.(event);
      show();
    },
    onMouseLeave: (event: MouseEvent) => {
      children.props.onMouseLeave?.(event);
      hide();
    },
    onFocus: (event: FocusEvent) => {
      children.props.onFocus?.(event);
      show();
    },
    onBlur: (event: FocusEvent) => {
      children.props.onBlur?.(event);
      hide();
    },
  });

  function clear(): void {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }

  return (
    <span className={styles.tooltipAnchor}>
      {trigger}
      <span id={id} role="tooltip" className={styles.tooltip} hidden={!open}>
        {content}
      </span>
    </span>
  );
}
