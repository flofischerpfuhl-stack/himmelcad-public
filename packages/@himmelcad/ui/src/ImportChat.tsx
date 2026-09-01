import { Bot, RotateCcw, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

import styles from './ImportChat.module.css';

export type ChatTone = 'default' | 'ok' | 'warn' | 'error';

export interface ChatChoice {
  id: string;
  label: string;
  primary?: boolean;
  disabled?: boolean;
}

export function ImportChatRoot({
  title,
  onClose,
  closeLabel,
  children,
  footer,
  busy = false,
  layout = 'default',
}: {
  title: string;
  onClose: () => void;
  closeLabel: string;
  children: ReactNode;
  footer?: ReactNode | null | undefined;
  busy?: boolean;
  layout?: 'default' | 'wide';
}): JSX.Element {
  return (
    <section className={styles.root} data-layout={layout} aria-busy={busy}>
      <header className={styles.header} data-task-drag-handle>
        <h2 className={styles.title}>{title}</h2>
        <button
          className={styles.iconButton}
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
        >
          <X size={14} />
        </button>
      </header>
      {children}
      {footer ?? null}
    </section>
  );
}

export function ImportChatStream({
  children,
  scrollKey,
}: {
  children: ReactNode;
  scrollKey: string | number;
}): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [scrollKey]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end', behavior: 'auto' });
  }, [scrollKey]);

  return (
    <div className={styles.stream} ref={scroller}>
      <div className={styles.streamInner}>
        {children}
        <div ref={bottom} aria-hidden />
      </div>
    </div>
  );
}

function RevertButton({
  onRevert,
  disabled,
  label = 'Revert to this step',
}: {
  onRevert: () => void;
  disabled?: boolean;
  label?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={styles.revertBtn}
      onClick={onRevert}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      <RotateCcw size={11} strokeWidth={2.25} />
    </button>
  );
}

export function ChatBubble({
  role = 'system',
  tone = 'default',
  children,
  title,
  detail,
  onRevert,
  revertDisabled = false,
}: {
  role?: 'system' | 'user';
  tone?: ChatTone;
  children?: ReactNode;
  title?: string;
  detail?: string;
  onRevert?: (() => void) | undefined;
  revertDisabled?: boolean | undefined;
}): JSX.Element {
  if (role === 'user') {
    return (
      <div className={`${styles.row} ${styles.rowUser}`}>
        <div className={`${styles.bubble} ${styles.bubbleUser}`}>{children ?? title}</div>
        {onRevert ? <RevertButton onRevert={onRevert} disabled={revertDisabled} /> : null}
      </div>
    );
  }
  const toneClass =
    tone === 'ok'
      ? styles.bubbleOk
      : tone === 'warn'
        ? styles.bubbleWarn
        : tone === 'error'
          ? styles.bubbleError
          : '';
  return (
    <div className={`${styles.row} ${styles.rowSystem}`}>
      <div className={styles.messageLine}>
        <span className={styles.avatar} aria-hidden="true">
          <Bot size={13} strokeWidth={2} />
        </span>
        <div className={`${styles.bubble} ${styles.bubbleSystem} ${toneClass}`.trim()}>
          {title ? <strong>{title}</strong> : null}
          {children}
          {detail ? <small>{detail}</small> : null}
        </div>
      </div>
      {onRevert ? <RevertButton onRevert={onRevert} disabled={revertDisabled} /> : null}
    </div>
  );
}

export function ChatChoices({
  options,
  onSelect,
  resolvedId,
  disabled = false,
  onRevert,
  revertDisabled = false,
  lockResolved = true,
}: {
  options: readonly ChatChoice[];
  onSelect: (id: string) => void;
  resolvedId?: string | null | undefined;
  disabled?: boolean | undefined;
  onRevert?: (() => void) | undefined;
  revertDisabled?: boolean | undefined;
  lockResolved?: boolean | undefined;
}): JSX.Element {
  const locked = (lockResolved && resolvedId != null) || disabled;
  return (
    <div className={`${styles.row} ${styles.rowSystem}`}>
      <div className={styles.attachmentLine}>
        <span className={styles.avatarSpacer} aria-hidden="true" />
        <div className={styles.choices} role="group">
          {options.map((option) => {
            const active = resolvedId === option.id;
            return (
              <button
                key={option.id}
                type="button"
                className={[
                  styles.choice,
                  option.primary ? styles.choicePrimary : '',
                  active ? styles.choiceActive : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                disabled={locked || option.disabled}
                onClick={() => onSelect(option.id)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      {onRevert && resolvedId != null ? (
        <RevertButton onRevert={onRevert} disabled={revertDisabled} />
      ) : null}
    </div>
  );
}

export function ChatCard({
  title,
  children,
  actions,
  onRevert,
  revertDisabled = false,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode | undefined;
  onRevert?: (() => void) | undefined;
  revertDisabled?: boolean | undefined;
}): JSX.Element {
  return (
    <div className={`${styles.row} ${styles.rowFull}`}>
      <div className={styles.card}>
        {(title || actions) && (
          <div className={styles.cardHeader}>
            <div>{title ? <strong>{title}</strong> : null}</div>
            {actions ? <div className={styles.cardHeaderRight}>{actions}</div> : null}
          </div>
        )}
        {children}
      </div>
      {onRevert ? <RevertButton onRevert={onRevert} disabled={revertDisabled} /> : null}
    </div>
  );
}

export function ChatFooter({ children }: { children: ReactNode }): JSX.Element {
  return <footer className={styles.footer}>{children}</footer>;
}

export function ChatFooterSpacer(): JSX.Element {
  return <span className={styles.footerSpacer} />;
}

export function Metric({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: string;
  warning?: boolean;
}): JSX.Element {
  return (
    <div className={`${styles.metric} ${warning ? styles.metricWarn : ''}`.trim()}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Metrics({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.metrics}>{children}</div>;
}

export function ChipGroup({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label?: string;
  options: readonly { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className={styles.fieldRow}>
      {label ? <span className={styles.fieldLabel}>{label}</span> : null}
      <div className={styles.chipGroup} role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`${styles.chip} ${value === option.id ? styles.chipActive : ''}`.trim()}
            disabled={disabled}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ProgressBar({
  value,
  indeterminate = false,
  indeterminateLabel = 'Working…',
}: {
  value: number;
  indeterminate?: boolean;
  indeterminateLabel?: string;
}): JSX.Element {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className={styles.progressRow}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : percent}
    >
      <div
        className={`${styles.progressTrack} ${indeterminate ? styles.progressIndeterminate : ''}`}
      >
        <span style={indeterminate ? undefined : { width: `${percent}%` }} />
      </div>
      <code>{indeterminate ? indeterminateLabel : `${percent}%`}</code>
    </div>
  );
}

export function EmptyPick({
  icon,
  title,
  detail,
  children,
}: {
  icon?: ReactNode;
  title: string;
  detail?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.emptyPick}>
      {icon}
      <strong>{title}</strong>
      {detail ? <small>{detail}</small> : null}
      <div className={styles.toolbar}>{children}</div>
    </div>
  );
}

export { styles as importChatStyles };
