import { useEffect, useState, type JSX } from 'react';

import styles from './agent.module.css';
import type { AgentHarnessHostTransport, ProductAutomationApprovalRequest } from './transport.js';

export function ManagedAutomationApproval(props: {
  readonly transport: AgentHarnessHostTransport;
}): JSX.Element | null {
  const [queue, setQueue] = useState<readonly ProductAutomationApprovalRequest[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      props.transport.subscribeProductApprovals?.((request) =>
        setQueue((current) =>
          current.some((candidate) => candidate.requestId === request.requestId)
            ? current
            : [...current, request],
        ),
      ),
    [props.transport],
  );
  const pending = queue[0] ?? null;
  if (!pending) return null;

  const respond = (decision: 'approved' | 'denied'): void => {
    if (busy || !props.transport.respondProductApproval) return;
    setBusy(true);
    void props.transport.respondProductApproval(pending.requestId, decision).finally(() => {
      setQueue((current) => current.filter((request) => request.requestId !== pending.requestId));
      setBusy(false);
    });
  };
  return (
    <div className={styles.productApprovalBackdrop} role="presentation">
      <section
        className={styles.productApprovalDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="automation-approval-title"
      >
        <h2 id="automation-approval-title">Confirm automation</h2>
        <p>
          The local agent wants to commit the validated command <code>{pending.commandId}</code> to
          this project.
        </p>
        {pending.losses.length > 0 ? (
          <p className={styles.productApprovalWarning}>
            Validation reports {pending.losses.length} potential data-loss item(s).
          </p>
        ) : null}
        {pending.conflicts.length > 0 ? (
          <p className={styles.productApprovalWarning}>
            Validation reports {pending.conflicts.length} conflict(s). The server will still reject
            the command if its plan is no longer current.
          </p>
        ) : null}
        <div className={styles.productApprovalActions}>
          <button type="button" disabled={busy} onClick={() => respond('denied')}>
            Deny
          </button>
          <button type="button" disabled={busy} onClick={() => respond('approved')}>
            Confirm
          </button>
        </div>
      </section>
    </div>
  );
}
