import type {
  ConstructionInputField,
  DisplayViewMode,
  ViewportBottomBarState,
} from '@himmelcad/app';
import { CircleDot, GripHorizontal, Split, Tag } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import styles from './InteractionBars.module.css';
import { Checkbox } from './Checkbox.js';
import { Menu } from './Menu.js';
import { NumberInput } from './NumberInput.js';
import { Tooltip } from './Tooltip.js';

export interface ViewportBottomBarProps {
  readonly state: ViewportBottomBarState;
  readonly onSupportGeometryChange: (value: boolean) => void;
  readonly onExplodePolylinesChange: (value: boolean) => void;
  readonly onViewModeChange: (value: DisplayViewMode) => void;
  readonly onSelectableKindChange: (kind: string, value: boolean) => void;
  readonly onLabelsChange: (value: boolean) => void;
}

export function ViewportBottomBar({
  state,
  onSupportGeometryChange,
  onExplodePolylinesChange,
  onViewModeChange,
  onSelectableKindChange,
  onLabelsChange,
}: ViewportBottomBarProps): JSX.Element {
  const [kindsOpen, setKindsOpen] = useState(false);
  const kindsMenuId = useId();
  return (
    <div className={styles.bottomBar} role="toolbar" aria-label="Viewport display and selection">
      <div className={styles.leftCluster}>
        <ToggleIconButton
          label="Support points and lines"
          pressed={state.supportGeometry}
          onPressedChange={onSupportGeometryChange}
          icon={<CircleDot size={14} />}
        />
        <ToggleIconButton
          label="Explode polylines"
          pressed={state.granularity === 'segments'}
          onPressedChange={(pressed) => onExplodePolylinesChange(pressed)}
          icon={<Split size={14} />}
        />
      </div>
      <div className={styles.segmented} role="radiogroup" aria-label="Viewport mode">
        {(['3d', '2.5d', '2d'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={state.viewMode === mode}
            className={styles.segment}
            data-active={state.viewMode === mode || undefined}
            onClick={() => onViewModeChange(mode)}
          >
            {mode === '3d' ? '3D' : mode === '2.5d' ? '2.5D' : '2D'}
          </button>
        ))}
      </div>
      <div className={styles.rightCluster}>
        <div className={styles.kindsHost}>
          <button
            type="button"
            className={styles.kindsButton}
            aria-haspopup="menu"
            aria-expanded={kindsOpen}
            aria-controls={kindsOpen ? kindsMenuId : undefined}
            onClick={() => setKindsOpen((open) => !open)}
          >
            Kinds <span aria-hidden>▾</span>
          </button>
          {kindsOpen ? (
            <Menu
              id={kindsMenuId}
              ariaLabel="Selectable element kinds"
              className={styles.kindsMenu!}
              onClose={() => setKindsOpen(false)}
              autoFocus={false}
            >
              {Object.entries(state.selectableKinds).map(([kind, checked]) => (
                <label
                  key={kind}
                  className={styles.kindRow}
                  role="menuitemcheckbox"
                  aria-checked={checked}
                >
                  <Checkbox
                    checked={checked}
                    aria-label={`Selectable ${kind}`}
                    onChange={(event) => onSelectableKindChange(kind, event.currentTarget.checked)}
                  />
                  <span>{sentenceCase(kind)}</span>
                </label>
              ))}
            </Menu>
          ) : null}
        </div>
        <ToggleIconButton
          label="Labels"
          pressed={state.labels}
          onPressedChange={onLabelsChange}
          icon={<Tag size={14} />}
        />
      </div>
    </div>
  );
}

interface ToggleIconButtonProps {
  readonly label: string;
  readonly pressed: boolean;
  readonly onPressedChange: (pressed: boolean) => void;
  readonly icon: JSX.Element;
}

function ToggleIconButton({
  label,
  pressed,
  onPressedChange,
  icon,
}: ToggleIconButtonProps): JSX.Element {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={label}
        aria-pressed={pressed}
        data-active={pressed || undefined}
        onClick={() => onPressedChange(!pressed)}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

export interface ConstructionBarProps {
  readonly prompt: string;
  readonly fields: readonly ConstructionInputField[];
  readonly activeField?: ConstructionInputField['id'] | null;
  readonly candidateIndex?: number;
  readonly candidateCount?: number;
  readonly detachable?: boolean;
  readonly detached?: boolean;
  readonly onDetachedChange?: (detached: boolean) => void;
  readonly onFieldFocus?: (field: ConstructionInputField['id']) => void;
  readonly onFieldChange?: (field: ConstructionInputField['id'], value: number) => void;
  readonly onFieldCommit?: (field: ConstructionInputField['id'], value: number) => void;
  readonly onCommit?: (field: ConstructionInputField['id']) => void;
  readonly onCycleCandidate?: (direction: 1 | -1) => void;
}

export function ConstructionBar({
  prompt,
  fields,
  activeField = null,
  candidateIndex,
  candidateCount,
  detachable = true,
  detached = false,
  onDetachedChange,
  onFieldFocus,
  onFieldChange,
  onFieldCommit,
  onCommit,
  onCycleCandidate,
}: ConstructionBarProps): JSX.Element {
  const hasCandidates =
    candidateCount !== undefined && candidateCount > 1 && candidateIndex !== undefined;
  return (
    <div
      className={`${styles.constructionBar} ${detached ? styles.constructionBarDetached : ''}`}
      role="toolbar"
      aria-label="Construction input"
      data-construction-input="armed"
      onKeyDownCapture={(event) => {
        if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && hasCandidates) {
          event.preventDefault();
          event.stopPropagation();
          onCycleCandidate?.(event.key === 'ArrowUp' ? -1 : 1);
        }
      }}
    >
      {detachable ? (
        <Tooltip content={detached ? 'Dock construction bar' : 'Detach construction bar'}>
          <button
            type="button"
            className={styles.detachButton}
            aria-label={detached ? 'Dock construction bar' : 'Detach construction bar'}
            aria-pressed={detached}
            onClick={() => onDetachedChange?.(!detached)}
          >
            <GripHorizontal size={13} />
          </button>
        </Tooltip>
      ) : null}
      <span className={styles.prompt} title={prompt}>
        {prompt}
      </span>
      <div className={styles.fields}>
        {fields.map((field) => (
          <label
            key={field.id}
            className={styles.field}
            data-active={activeField === field.id || undefined}
          >
            <span>{field.label}</span>
            <NumberInput
              aria-label={field.label}
              value={field.value}
              {...(field.unit ? { unit: field.unit } : {})}
              precision={field.id === 'direction' ? 4 : 3}
              commitOnBlur={false}
              data-construction-field-commit="enter"
              onFocus={() => onFieldFocus?.(field.id)}
              onValueChange={(value) => {
                if (value !== null) onFieldChange?.(field.id, value);
              }}
              onCommit={(value) => {
                onFieldCommit?.(field.id, value);
                onCommit?.(field.id);
              }}
            />
          </label>
        ))}
      </div>
      <span className={styles.polarReadout} aria-label="Live polar values">
        {polarReadout(fields)}
      </span>
      <span className={styles.candidateSlot} aria-live="polite">
        {hasCandidates ? `${candidateIndex! + 1} of ${candidateCount}` : '\u00a0'}
      </span>
    </div>
  );
}

export function ViewportInteractionChrome({
  children,
  constructionBar,
  bottomBar,
}: {
  readonly children: ReactNode;
  readonly constructionBar?: ReactNode;
  readonly bottomBar: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.viewportChrome}>
      <div className={styles.viewportContent}>{children}</div>
      {constructionBar}
      {bottomBar}
    </div>
  );
}

function sentenceCase(value: string): string {
  return value.length ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function polarReadout(fields: readonly ConstructionInputField[]): string {
  const value = new Map(fields.map((field) => [field.id, field.value]));
  const direction = value.get('direction');
  const distance = value.get('distance');
  const deltaZ = value.get('deltaZ');
  if (direction === undefined && distance === undefined && deltaZ === undefined) return '';
  return `Dir ${format(direction, '°')} · Dist ${format(distance, ' m')} · Δz ${format(deltaZ, ' m')}`;
}

function format(value: number | undefined, unit: string): string {
  return value === undefined ? '—' : `${value.toFixed(3)}${unit}`;
}
