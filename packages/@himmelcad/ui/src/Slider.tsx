import type { InputHTMLAttributes } from 'react';

import styles from './BaseControls.module.css';
import { sliderValueForKey } from './controlInteractions.js';

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  valueText?: string;
  onValueChange?: (value: number) => void;
}

export function Slider({
  min = 0,
  max = 100,
  step = 1,
  value,
  defaultValue,
  valueText,
  onValueChange,
  onChange,
  onKeyDown,
  className,
  ...props
}: SliderProps): JSX.Element {
  const current = Number(value ?? defaultValue ?? min);
  const update = (next: number): void => onValueChange?.(clamp(next, Number(min), Number(max)));
  return (
    <input
      {...props}
      type="range"
      role="slider"
      min={min}
      max={max}
      step={step}
      value={value}
      defaultValue={defaultValue}
      aria-valuetext={valueText}
      className={`${styles.slider} ${className ?? ''}`.trim()}
      onChange={(event) => {
        onChange?.(event);
        onValueChange?.(event.currentTarget.valueAsNumber);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || value === undefined) return;
        const amount = Number(step) || 1;
        const next = sliderValueForKey(current, Number(min), Number(max), amount, event.key);
        if (next !== null) {
          event.preventDefault();
          update(next);
        }
      }}
    />
  );
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
