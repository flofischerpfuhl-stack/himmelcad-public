/**
 * The assistant island (assembler/AGENT-ASSISTANT.md): a floating panel
 * with two tabs — Chat (the shared `@himmelcad/agent` chat panel with this
 * project's sessions, reference chips and render thumbnails) and Skills
 * (built-in and project skills). Hiding it never stops a running turn; the
 * left-dock button shows that one is running.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Info,
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';

import { AgentChatPanel, type AgentTimelineRow } from '@himmelcad/agent';
import { Select } from '@himmelcad/ui';

import { eventsFromStored, useAssistant } from '../controller.js';
import { useAssistantSessions } from '../sessions.js';
import { foldToolRows, type CommandRow } from '../timelineRows.js';
import { SkillsTab } from './SkillsTab.js';
import { renderAssistantRow } from './TimelineRows.js';
import styles from './AssistantIsland.module.css';

/** What the agent may do, in full (the scope line's details). */
const SCOPE_DETAILS = [
  'Works only on the open project, through the app’s modeling tools.',
  'No access to your files or a command shell.',
  'Network: only your agent CLI’s own connection to its provider.',
  'Asks you before deleting your steps, undoing your changes or replacing the project.',
];

/** The permission line: one sentence, the details behind an info button (tap or click). */
function ScopeLine(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.scopeLine}>
      <div className={styles.scopeSummary}>
        <Lock size={12} aria-hidden />
        <p>This project only · asks before deleting your work</p>
        <button
          type="button"
          className={styles.scopeInfo}
          aria-expanded={open}
          aria-label="What the assistant may do"
          title="What the assistant may do"
          onClick={() => setOpen(!open)}
        >
          <Info size={13} />
        </button>
      </div>
      {open ? (
        <ul className={styles.scopeDetails}>
          {SCOPE_DETAILS.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AssistantIsland(): JSX.Element | null {
  const open = useAssistant((s) => s.open);
  const tab = useAssistant((s) => s.tab);
  const available = useAssistant((s) => s.available);
  const reason = useAssistant((s) => s.unavailableReason);
  if (!open) return null;
  return (
    <section className={styles.island} aria-label="Assistant" data-testid="assistant-island">
      <header className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label="Assistant views">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'chat'}
            className={tab === 'chat' ? styles.tabActive : styles.tab}
            onClick={() => useAssistant.getState().setTab('chat')}
          >
            <MessageSquare size={13} /> Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'skills'}
            className={tab === 'skills' ? styles.tabActive : styles.tab}
            onClick={() => useAssistant.getState().setTab('skills')}
          >
            <BookOpen size={13} /> Skills
          </button>
        </div>
        {tab === 'chat' && available ? <SessionBar /> : <span className={styles.spacer} />}
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Hide assistant"
          title="Hide (a running turn continues)"
          onClick={() => useAssistant.getState().setOpen(false)}
        >
          <X size={14} />
        </button>
      </header>
      {tab === 'skills' ? (
        <SkillsTab />
      ) : available ? (
        <ChatTab />
      ) : (
        <div className={styles.unavailable} role="status">
          <strong>The assistant is not available here.</strong>
          <p>{reason}</p>
        </div>
      )}
    </section>
  );
}

function SessionBar(): JSX.Element {
  const sessions = useAssistantSessions((s) => s.sessions);
  const activeId = useAssistantSessions((s) => s.activeId);
  const busy = useAssistant((s) => s.busy);
  const active = sessions.find((s) => s.id === activeId) ?? null;
  const [renaming, setRenaming] = useState<string | null>(null);
  // The shared dropdown (never the platform's native select): names are cut with an ellipsis
  // in the trigger and shown in full in the list, also in the narrow tablet island.
  const sessionOptions = useMemo(
    () => [
      { value: '', label: 'New session' },
      ...[...sessions].reverse().map((session) => ({
        value: session.id,
        label: `${session.name}${session.state === 'interrupted' ? ' · interrupted' : ''}`,
      })),
    ],
    [sessions],
  );
  return (
    <div className={styles.sessionBar}>
      {renaming !== null && active ? (
        <input
          className={styles.sessionName}
          aria-label="Session name"
          value={renaming}
          maxLength={80}
          autoFocus
          onChange={(event) => setRenaming(event.currentTarget.value)}
          onBlur={() => {
            useAssistant.getState().renameSession(active.id, renaming);
            setRenaming(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') setRenaming(null);
          }}
        />
      ) : (
        <Select
          wrapClassName={styles.sessionSelectWrap}
          className={styles.sessionSelect}
          aria-label="Session"
          value={activeId ?? ''}
          disabled={busy}
          options={sessionOptions}
          onChange={(event) => {
            if (event.currentTarget.value)
              useAssistant.getState().selectSession(event.currentTarget.value);
            else useAssistant.getState().newSession();
          }}
        />
      )}
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Rename session"
        title="Rename this session"
        disabled={busy || !active || renaming !== null}
        onClick={() => active && setRenaming(active.name)}
      >
        <Pencil size={13} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label="New session"
        title="New session"
        disabled={busy}
        onClick={() => useAssistant.getState().newSession()}
      >
        <Plus size={14} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        aria-label="Delete session"
        title="Delete this session from the project"
        disabled={busy || !active}
        onClick={() => active && useAssistant.getState().deleteSession(active.id)}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function ChatTab(): JSX.Element {
  const discoveries = useAssistant((s) => s.discoveries);
  const discovering = useAssistant((s) => s.discovering);
  const provider = useAssistant((s) => s.provider);
  const live = useAssistant((s) => s.live);
  const busy = useAssistant((s) => s.busy);
  const references = useAssistant((s) => s.references);
  const images = useAssistant((s) => s.images);
  const sessions = useAssistantSessions((s) => s.sessions);
  const activeId = useAssistantSessions((s) => s.activeId);
  const active = sessions.find((s) => s.id === activeId) ?? null;
  const stored = useMemo(() => (active ? eventsFromStored(active) : []), [active]);
  const events = useMemo(() => [...stored, ...live], [stored, live]);
  const interrupted = !busy && active?.state === 'interrupted' && live.length === 0;
  const assistant = useAssistant.getState();
  // Tool calls fold into compact lines and "N steps" groups (`timelineRows.ts`).
  const groupsRef = useRef(new Map<string, CommandRow[]>());
  const prepareRows = useCallback(
    (rows: readonly AgentTimelineRow[]) => foldToolRows(rows, groupsRef.current),
    [],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (id: string) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  return (
    <div className={styles.chatHost}>
      <AgentChatPanel
        className={styles.chat ?? ''}
        title={active?.name ?? 'New session'}
        discoveries={discoveries}
        activeProvider={provider}
        events={events}
        busy={busy}
        permissions={{
          filesystem: 'readOnly',
          network: 'providerOnly',
          workspaceScopeLabel: 'Open project',
        }}
        scopeBar={<ScopeLine />}
        emptyMessage="Describe the part you need — for example “an enclosure for a Raspberry Pi 5 with ventilation slots”. The assistant builds it as normal History steps you can edit."
        placeholder="Describe a part or a change… (Ctrl+Enter sends)"
        notConfiguredMessage="No agent CLI found. Install Claude Code, Codex or OpenCode and sign in with your own account, then refresh."
        headerAccessory={
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Look for agent CLIs again"
            title="Look for installed agent CLIs again"
            disabled={discovering || busy}
            onClick={() => void assistant.refresh()}
          >
            <RefreshCw size={13} />
          </button>
        }
        beforeTimeline={
          interrupted ? (
            <div className={styles.notice} role="status">
              The last turn did not finish.
              <button type="button" onClick={() => void assistant.continueTurn()}>
                Continue
              </button>
            </div>
          ) : null
        }
        composerAccessory={
          <div className={styles.references}>
            <button
              type="button"
              className={styles.addReference}
              onClick={() => assistant.addSelection()}
              title="Add the selected bodies, faces, edges or steps as references"
            >
              @ Add selection
            </button>
            {references.map((reference) => (
              <span key={reference.key} className={styles.chip} title={reference.label}>
                <span className={styles.chipLabel}>{reference.label}</span>
                <button
                  type="button"
                  aria-label={`Remove ${reference.label}`}
                  onClick={() => assistant.removeReference(reference.key)}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        }
        prepareRows={prepareRows}
        renderRow={(row, fallback) =>
          renderAssistantRow(row, fallback, {
            groups: groupsRef.current,
            images,
            expanded,
            toggle,
          })
        }
        onSelectProvider={(next) => assistant.selectProvider(next)}
        onSend={(prompt) => void assistant.send(prompt)}
        onInterrupt={() => void assistant.interrupt()}
        onResume={() => void assistant.continueTurn()}
        onApproval={(requestId, decision) => {
          assistant.respondApproval(requestId, decision);
        }}
      />
    </div>
  );
}
