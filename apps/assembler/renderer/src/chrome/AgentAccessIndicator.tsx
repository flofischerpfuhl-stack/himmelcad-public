/**
 * Persistent indicator while "Agent access" (the local automation endpoint)
 * is on: it names the loopback address, offers the connection details for
 * an agent, and turns access off. Absent while access is off — which is the
 * default on every start. Toggled from the `file.agentAccess` command.
 */
import { useState } from 'react';

import { useAutomationStore } from '../api/app/automationStore.js';
import styles from './AgentAccessIndicator.module.css';

export function AgentAccessIndicator(): JSX.Element | null {
  const enabled = useAutomationStore((s) => s.enabled);
  const url = useAutomationStore((s) => s.url);
  const busy = useAutomationStore((s) => s.busy);
  const requestCount = useAutomationStore((s) => s.requestCount);
  const lastMethod = useAutomationStore((s) => s.lastMethod);
  const [copied, setCopied] = useState(false);

  if (!enabled || !url) return null;
  const host = url.replace(/^https?:\/\//, '').replace(/\/rpc$/, '');

  const copy = () => {
    const text = useAutomationStore.getState().connectionText();
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className={styles.root} role="status" aria-live="polite" aria-label="Agent access is on">
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.label}>Agent access on</span>
      <span className={styles.meta}>
        {host}
        {requestCount > 0 ? ` · ${requestCount} request${requestCount === 1 ? '' : 's'}` : ''}
        {lastMethod ? ` · ${lastMethod}` : ''}
      </span>
      <button type="button" className={styles.button} onClick={copy}>
        {copied ? 'Copied' : 'Copy connection'}
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={busy}
        onClick={() => void useAutomationStore.getState().setEnabled(false)}
      >
        Turn off
      </button>
    </div>
  );
}
