/**
 * The assistant island (assembler/AGENT-ASSISTANT.md): a floating panel
 * with two tabs — Chat (the shared `@himmelcad/agent` chat panel with this
 * project's sessions, reference chips and render thumbnails) and Skills
 * (built-in and project skills). Hiding it never stops a running turn; the
 * left-dock button shows that one is running.
 */
import { useMemo, useState } from 'react';
import { BookOpen, MessageSquare, Plus, RefreshCw, Trash2, X } from 'lucide-react';

import { AgentChatPanel, type AgentTimelineRow } from '@himmelcad/agent';

import { eventsFromStored, useAssistant } from '../controller.js';
import { useAssistantSessions } from '../sessions.js';
import { SkillsTab } from './SkillsTab.js';
import styles from './AssistantIsland.module.css';

const SCOPE = [
  'Open project · hcasm tools only',
  'No file or shell access',
  'Network: your CLI’s own provider',
  'Deleting your work asks first',
];

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
        <select
          className={styles.sessionSelect}
          aria-label="Session"
          value={activeId ?? ''}
          disabled={busy}
          onChange={(event) => {
            if (event.currentTarget.value)
              useAssistant.getState().selectSession(event.currentTarget.value);
            else useAssistant.getState().newSession();
          }}
          onDoubleClick={() => active && setRenaming(active.name)}
          title={active ? 'Double-click to rename' : undefined}
        >
          <option value="">New session</option>
          {[...sessions].reverse().map((session) => (
            <option key={session.id} value={session.id}>
              {session.name}
              {session.state === 'interrupted' ? ' · interrupted' : ''}
            </option>
          ))}
        </select>
      )}
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
        scopeItems={SCOPE}
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
        renderRowExtra={(row: AgentTimelineRow) => {
          const list = images[row.id];
          if (!list || list.length === 0) return null;
          return (
            <div className={styles.thumbs}>
              {list.map((image, index) => (
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
        }}
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
