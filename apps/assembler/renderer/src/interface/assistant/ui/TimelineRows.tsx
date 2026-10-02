/**
 * Compact timeline rows of the assistant island (`timelineRows.ts` decides
 * the wording and grouping): one line per tool call with an expand chevron
 * for its JSON, "N steps" groups for consecutive calls, render thumbnails
 * kept visible, errors always shown, approvals as a one-line reference to
 * the approval bar, notes and turn outcomes as muted lines.
 */
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Box,
  Braces,
  Check,
  ChevronRight,
  Eye,
  FileText,
  Loader2,
  Pencil,
  Printer,
  Search,
  ShieldAlert,
  Trash2,
  Undo2,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';

import type { AgentTimelineRow } from '@himmelcad/agent';

import type { AssistantImage } from '../controller.js';
import {
  groupSummary,
  toolLabel,
  type CommandRow,
  type ToolIcon,
  type ToolLabel,
} from '../timelineRows.js';
import styles from './AssistantIsland.module.css';

const ICONS: Record<ToolIcon, LucideIcon> = {
  add: Box,
  edit: Pencil,
  delete: Trash2,
  read: Search,
  render: Eye,
  print: Printer,
  skill: BookOpen,
  api: Braces,
  undo: Undo2,
  file: FileText,
  other: Wrench,
};

export interface RowContext {
  groups: ReadonlyMap<string, CommandRow[]>;
  images: Readonly<Record<string, readonly AssistantImage[]>>;
  expanded: ReadonlySet<string>;
  toggle(id: string): void;
}

/** A row of the island's timeline; `fallback` renders the shared default card. */
export function renderAssistantRow(
  row: AgentTimelineRow,
  fallback: () => ReactNode,
  context: RowContext,
): ReactNode {
  switch (row.kind) {
    case 'command': {
      const members = context.groups.get(row.id);
      return members ? (
        <ToolGroup members={members} context={context} />
      ) : (
        <ToolStep row={row} context={context} />
      );
    }
    case 'approval':
      return <ApprovalLine row={row} />;
    case 'message':
      return row.role === 'system' ? <NoteLine text={row.text} /> : fallback();
    case 'state':
      return <NoteLine text={stateText(row.state, row.detail)} tone="warning" />;
    default:
      return fallback();
  }
}

function StatusMark({ label }: { label: ToolLabel }): JSX.Element {
  if (label.state === 'running') {
    return <Loader2 size={13} className={styles.spin} aria-label="Running" />;
  }
  if (label.state === 'failed')
    return <X size={13} className={styles.failMark} aria-label="Failed" />;
  return <Check size={13} className={styles.doneMark} aria-label="Done" />;
}

function ToolStep({
  row,
  context,
  nested = false,
}: {
  row: CommandRow;
  context: RowContext;
  nested?: boolean;
}): JSX.Element {
  const label = toolLabel(row);
  const Icon = ICONS[label.icon];
  const open = context.expanded.has(row.id);
  const images = context.images[row.id] ?? [];
  return (
    <div className={nested ? styles.stepNested : styles.step} data-state={label.state}>
      <button
        type="button"
        className={styles.stepLine}
        aria-expanded={open}
        aria-label={`${label.text}${label.state === 'failed' ? ' (failed)' : ''}: show details`}
        onClick={() => context.toggle(row.id)}
        disabled={!row.detail}
      >
        <ChevronRight
          size={13}
          className={open ? styles.chevronOpen : styles.chevron}
          aria-hidden
        />
        <Icon size={13} className={styles.stepIcon} aria-hidden />
        <span className={styles.stepText}>{label.text}</span>
        <StatusMark label={label} />
      </button>
      {label.error ? <p className={styles.stepError}>{label.error}</p> : null}
      {images.length > 0 ? <Thumbnails images={images} /> : null}
      {open && row.detail ? <pre className={styles.stepDetail}>{row.detail}</pre> : null}
    </div>
  );
}

function ToolGroup({
  members,
  context,
}: {
  members: CommandRow[];
  context: RowContext;
}): JSX.Element {
  const anchor = members[0]!;
  const open = context.expanded.has(`group:${anchor.id}`);
  const summary = groupSummary(members);
  const status: ToolLabel = summary.running ?? summary.failed[0] ?? summary.last;
  const images = members.flatMap((m) => context.images[m.id] ?? []);
  return (
    <div className={styles.group}>
      <button
        type="button"
        className={styles.stepLine}
        aria-expanded={open}
        onClick={() => context.toggle(`group:${anchor.id}`)}
      >
        <ChevronRight
          size={13}
          className={open ? styles.chevronOpen : styles.chevron}
          aria-hidden
        />
        <Wrench size={13} className={styles.stepIcon} aria-hidden />
        <span className={styles.stepText}>
          {summary.count} steps
          <span className={styles.stepSummary}>
            {' · '}
            {summary.running ? summary.running.text : summary.last.text}
          </span>
        </span>
        <StatusMark
          label={status.state === 'failed' ? status : (summary.running ?? summary.last)}
        />
      </button>
      {open ? (
        <div className={styles.groupSteps}>
          {members.map((member) => (
            <ToolStep key={member.id} row={member} context={context} nested />
          ))}
        </div>
      ) : (
        <>
          {summary.failed.map((failed, index) => (
            <p key={index} className={styles.stepError}>
              {failed.text}: {failed.error}
            </p>
          ))}
          {images.length > 0 ? <Thumbnails images={images.slice(-4)} /> : null}
        </>
      )}
    </div>
  );
}

function Thumbnails({ images }: { images: readonly AssistantImage[] }): JSX.Element {
  return (
    <div className={styles.thumbs}>
      {images.map((image, index) => (
        <img
          key={index}
          src={image.data}
          alt={`${image.label} result`}
          className={styles.thumb}
          width={160}
          height={120}
        />
      ))}
    </div>
  );
}

function ApprovalLine({
  row,
}: {
  row: Extract<AgentTimelineRow, { kind: 'approval' }>;
}): JSX.Element {
  const pending = row.state === 'pending';
  const prefix = pending
    ? 'Waiting for your answer below'
    : row.state === 'approved'
      ? 'Approved'
      : row.state === 'denied'
        ? 'Denied'
        : 'No answer, not done';
  return (
    <div className={styles.approvalLine} data-state={row.state}>
      <ShieldAlert size={14} aria-hidden />
      <span>
        <strong>{prefix}:</strong> {row.title}
      </span>
    </div>
  );
}

function NoteLine({ text, tone }: { text: string; tone?: 'warning' }): JSX.Element {
  return (
    <div className={styles.noteLine} data-tone={tone}>
      {tone === 'warning' ? (
        <AlertTriangle size={13} aria-hidden />
      ) : (
        <Undo2 size={13} aria-hidden />
      )}
      <span>{text}</span>
    </div>
  );
}

function stateText(state: string, detail: string | undefined): string {
  const head =
    state === 'interrupted'
      ? 'Stopped'
      : state === 'failed'
        ? 'The agent CLI stopped with an error'
        : state === 'stopped'
          ? 'Session closed'
          : state === 'trimmed'
            ? 'Earlier messages removed'
            : `Turn ${state}`;
  return detail ? `${head}: ${detail.split('\n').slice(-2).join(' ')}` : `${head}.`;
}
