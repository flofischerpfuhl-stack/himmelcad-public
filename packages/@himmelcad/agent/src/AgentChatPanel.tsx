import {
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import type { HarnessProvider, NormalizedAgentEvent } from './events.js';
import {
  deriveAgentTimelineRows,
  emptyAgentTimelineState,
  type AgentTimelineRow,
} from './timeline.js';
import type { HarnessDiscovery } from './vendor/t3code/providerShape.js';
import { VirtualAgentTimeline } from './VirtualAgentTimeline.js';

import styles from './agent.module.css';

const MAX_AGENT_PROMPT_CHARS = 64 * 1024;

export interface AgentChatPanelProps {
  discoveries: readonly HarnessDiscovery[];
  activeProvider: HarnessProvider | null;
  events: readonly NormalizedAgentEvent[];
  permissions: {
    filesystem: 'readOnly' | 'readWrite';
    network: 'disabled' | 'providerOnly';
    workspaceScopeLabel: string;
  };
  busy: boolean;
  onSelectProvider(provider: HarnessProvider): void;
  onSend(prompt: string): void;
  onInterrupt(): void;
  onResume(): void;
  onApproval(requestId: string, decision: 'approved' | 'denied'): void;
  providerCredentialControl?: ReactNode;
}

export function AgentChatPanel(props: AgentChatPanelProps): JSX.Element {
  const headingId = useId();
  const [prompt, setPrompt] = useState('');
  const timelineRef = useRef(emptyAgentTimelineState());
  const rows = useMemo(() => {
    const next = deriveAgentTimelineRows(props.events, timelineRef.current);
    timelineRef.current = next;
    return next.result;
  }, [props.events]);
  const active = props.discoveries.find(
    (item) => item.state === 'available' && item.identity.provider === props.activeProvider,
  );
  const hasAvailableHarness = props.discoveries.some((item) => item.state === 'available');
  const pendingApproval = findLastRow(
    rows,
    (row): row is Extract<AgentTimelineRow, { kind: 'approval' }> =>
      row.kind === 'approval' && row.state === 'pending',
  );
  const recoverableError = findLastRow(
    rows,
    (row): row is Extract<AgentTimelineRow, { kind: 'error' }> =>
      row.kind === 'error' && row.recoverable,
  );

  const submitPrompt = (): void => {
    const value = prompt.trim();
    if (!value || props.busy || !active) return;
    props.onSend(value);
    setPrompt('');
  };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    submitPrompt();
  };

  const sendFromKeyboard = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.nativeEvent.isComposing ||
      event.key !== 'Enter' ||
      (!event.ctrlKey && !event.metaKey)
    )
      return;
    event.preventDefault();
    submitPrompt();
  };

  return (
    <section className={styles.chatPanel} aria-labelledby={headingId}>
      <header className={styles.chatHeader}>
        <div>
          <h2 id={headingId}>Agent</h2>
          <span>
            {active?.state === 'available'
              ? `${active.identity.provider} · ${active.identity.version}`
              : 'Choose an installed harness'}
          </span>
        </div>
        <div className={styles.harnessPicker} role="group" aria-label="Local agent harnesses">
          {props.discoveries.map((discovery) => {
            const provider =
              discovery.state === 'available' ? discovery.identity.provider : discovery.provider;
            const detail =
              discovery.state === 'available' ? discovery.identity.version : discovery.detail;
            const selected = discovery.state === 'available' && provider === props.activeProvider;
            return (
              <button
                key={provider}
                type="button"
                aria-disabled={discovery.state !== 'available'}
                aria-label={`${provider}, ${discovery.state}: ${detail}`}
                aria-pressed={selected}
                data-active={selected}
                onClick={() => {
                  if (discovery.state === 'available') props.onSelectProvider(provider);
                }}
                title={detail}
              >
                {provider}
                <i data-state={discovery.state} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </header>
      {props.providerCredentialControl}
      <div className={styles.scopeBar} role="group" aria-label="Agent permissions">
        <span>{props.permissions.workspaceScopeLabel}</span>
        <span>FS {props.permissions.filesystem}</span>
        <span>Network {props.permissions.network}</span>
        <span>Destructive · product approval</span>
      </div>
      <div className={styles.timelineHost}>
        {rows.length === 0 ? (
          <div className={styles.emptyChat} role="status">
            {active ? (
              'Ask the agent to use the HimmelCAD SDK.'
            ) : hasAvailableHarness ? (
              'Choose an available local harness to start.'
            ) : props.discoveries.length === 0 ? (
              'No local harness discovery result is available.'
            ) : (
              <div>
                <strong>No compatible local harness is available.</strong>
                <ul>
                  {props.discoveries.map((discovery) => {
                    const provider =
                      discovery.state === 'available'
                        ? discovery.identity.provider
                        : discovery.provider;
                    return discovery.state === 'available' ? null : (
                      <li key={provider}>
                        {provider} · {discovery.state}: {discovery.detail}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <VirtualAgentTimeline
            rows={rows}
            busy={props.busy}
            ariaLabel="Agent conversation"
            renderRow={(row) => <AgentRow row={row} onApproval={props.onApproval} />}
          />
        )}
      </div>
      {recoverableError ? (
        <div className={styles.recoveryBar} role="alert">
          <span>{recoverableError.message}</span>
          <button type="button" onClick={props.onResume}>
            Retry / resume
          </button>
        </div>
      ) : null}
      {pendingApproval ? (
        <div
          className={styles.approvalBar}
          role="region"
          aria-label="Pending agent approval"
          aria-live="polite"
        >
          <strong>
            {pendingApproval.destructive ? 'Destructive approval' : 'Approval required'}
          </strong>
          <span>{pendingApproval.title}</span>
          <button
            type="button"
            onClick={() => props.onApproval(pendingApproval.requestId, 'denied')}
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => props.onApproval(pendingApproval.requestId, 'approved')}
          >
            Approve
          </button>
        </div>
      ) : null}
      <form className={styles.composer} onSubmit={send}>
        <textarea
          value={prompt}
          maxLength={MAX_AGENT_PROMPT_CHARS}
          onChange={(event) =>
            setPrompt(event.currentTarget.value.slice(0, MAX_AGENT_PROMPT_CHARS))
          }
          onKeyDown={sendFromKeyboard}
          placeholder="Use the SDK to inspect or edit this project…"
          aria-label="Agent prompt"
        />
        {props.busy ? (
          <button type="button" onClick={props.onInterrupt}>
            Interrupt
          </button>
        ) : null}
        <button
          type="submit"
          disabled={!active || !prompt.trim() || props.busy}
          aria-keyshortcuts="Control+Enter Meta+Enter"
        >
          Send
        </button>
      </form>
    </section>
  );
}

function findLastRow<T extends AgentTimelineRow>(
  rows: readonly AgentTimelineRow[],
  predicate: (row: AgentTimelineRow) => row is T,
): T | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (predicate(row)) return row;
  }
  return undefined;
}

function AgentRow({
  row,
  onApproval,
}: {
  row: AgentTimelineRow;
  onApproval(requestId: string, decision: 'approved' | 'denied'): void;
}): JSX.Element {
  if (row.kind === 'message') {
    return (
      <article className={styles.message} data-role={row.role}>
        <header>
          {row.role}
          {row.streaming ? ' · streaming' : ''}
        </header>
        <p>{row.text}</p>
      </article>
    );
  }
  if (row.kind === 'approval') {
    return (
      <article className={styles.eventCard} data-tone="approval">
        <header>Approval · {row.state}</header>
        <strong>{row.title}</strong>
        {row.detail ? <p>{row.detail}</p> : null}
        {row.state === 'pending' ? (
          <footer>
            <button type="button" onClick={() => onApproval(row.requestId, 'denied')}>
              Deny
            </button>
            <button type="button" onClick={() => onApproval(row.requestId, 'approved')}>
              Approve
            </button>
          </footer>
        ) : null}
      </article>
    );
  }
  if (row.kind === 'error')
    return (
      <article className={styles.eventCard} data-tone="error">
        <header>Error · {row.code}</header>
        <p>{row.message}</p>
      </article>
    );
  if (row.kind === 'command')
    return (
      <article className={styles.eventCard} data-tone="command">
        <header>Command · {row.state}</header>
        <code>{row.command}</code>
        {row.detail ? <pre>{row.detail}</pre> : null}
      </article>
    );
  if (row.kind === 'fileChange')
    return (
      <article className={styles.eventCard} data-tone="file">
        <header>File change</header>
        <strong>{row.title}</strong>
        <p>{row.detail}</p>
      </article>
    );
  if (row.kind === 'reasoning')
    return (
      <article className={styles.eventCard} data-tone="reasoning">
        <header>Reasoning summary{row.streaming ? ' · streaming' : ''}</header>
        <p>{row.summary}</p>
      </article>
    );
  return (
    <article className={styles.eventCard}>
      <header>{row.kind === 'state' ? `State · ${row.state}` : 'Usage'}</header>
      <p>{row.detail}</p>
    </article>
  );
}
